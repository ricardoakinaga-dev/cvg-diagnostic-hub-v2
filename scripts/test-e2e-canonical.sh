#!/usr/bin/env bash
# Run against the CI's pinned browser, libraries and fonts. Never update baselines.
set -Eeuo pipefail

IMAGE="mcr.microsoft.com/playwright:v1.55.1-noble@sha256:2f29369043d81d6d69a815ceb80760f55e85f5020371ad06a4d996f18503ad1c"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME="${CVG_E2E_CONTAINER_RUNTIME:-docker}"
MEMORY_LIMIT="${CVG_E2E_MEMORY_LIMIT:-4g}"
case "$MEMORY_LIMIT" in
  4g|6g|8g) ;;
  *) echo "CVG_E2E_MEMORY_LIMIT must be 4g, 6g or 8g." >&2; exit 2 ;;
esac
if [[ "$RUNTIME" != docker && "$RUNTIME" != podman ]]; then
  echo "CVG_E2E_CONTAINER_RUNTIME must be docker or podman." >&2
  exit 2
fi
if ! command -v "$RUNTIME" >/dev/null 2>&1; then
  echo "Canonical E2E needs Docker or Podman and the pinned CI image; install a container runtime or run this command on the CI runner." >&2
  exit 2
fi
if ! grep -qF -- "$IMAGE" "$REPO_ROOT/.github/workflows/ci.yml"; then
  echo "The CI browser image changed; update IMAGE in this script before running." >&2
  exit 2
fi
PROJECTS=(chromium tablet mobile)
SELECTED_PROJECTS=()
TEST_ARGUMENTS=()
while (( $# )); do
  argument="$1"; shift
  case "$argument" in
    -u|--update-snapshots|--update-snapshots=*)
      echo "Canonical E2E preserves existing baselines. Use the reviewed visual-update procedure separately." >&2
      exit 2
      ;;
    --project=*) SELECTED_PROJECTS+=("${argument#--project=}") ;;
    --project)
      if (( ! $# )); then echo "--project requires chromium, tablet or mobile." >&2; exit 2; fi
      SELECTED_PROJECTS+=("$1"); shift
      ;;
    *) TEST_ARGUMENTS+=("$argument") ;;
  esac
done
if (( ${#SELECTED_PROJECTS[@]} )); then
  PROJECTS=()
  for selected in "${SELECTED_PROJECTS[@]}"; do
    case "$selected" in chromium|tablet|mobile) ;; *) echo "Canonical --project must be chromium, tablet or mobile." >&2; exit 2 ;; esac
    if [[ " ${PROJECTS[*]} " != *" $selected "* ]]; then PROJECTS+=("$selected"); fi
  done
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cvg-e2e-canonical.XXXXXX")"
ARTIFACT_DIR="$REPO_ROOT/test-results/canonical-$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir -p "$ARTIFACT_DIR/containers"
finalize_container() {
  local project="$1" identifier=""
  [[ ! -f "$ARTIFACT_DIR/containers/$project.id" ]] || read -r identifier < "$ARTIFACT_DIR/containers/$project.id" || true
  [[ -n "$identifier" ]] || return 0
  if [[ ! "$identifier" =~ ^[a-f0-9]{12,64}$ ]]; then
    printf '%s\n' "Refusing cleanup of an invalid harness CID." >> "$ARTIFACT_DIR/containers/$project.cleanup.log"
    return 1
  fi
  if [[ ! -f "$ARTIFACT_DIR/containers/$project.state.json" ]]; then
    # Inspect only this harness's CID and State; never Config.Env or other projects.
    if ! "$RUNTIME" inspect --format '{{json .State}}' "$identifier" > "$ARTIFACT_DIR/containers/$project.state.json" 2> "$ARTIFACT_DIR/containers/$project.inspect.log"; then
      printf '%s\n' '{"status":"UNKNOWN","reason":"STATE_INSPECTION_FAILED"}' > "$ARTIFACT_DIR/containers/$project.state.json"
    fi
  fi
  [[ ! -f "$ARTIFACT_DIR/containers/$project.removed" ]] || return 0
  if "$RUNTIME" rm -f "$identifier" >> "$ARTIFACT_DIR/containers/$project.cleanup.log" 2>&1; then
    printf '%s\n' "removed" > "$ARTIFACT_DIR/containers/$project.removed"
    return 0
  fi
  return 1
}
cleanup() {
  local status=$?
  trap - EXIT
  for project in "${PROJECTS[@]}"; do
    if ! finalize_container "$project"; then status=1; fi
  done
  if [[ -d "$WORK_DIR/canonical-artifacts" ]]; then
    cp -a "$WORK_DIR/canonical-artifacts/." "$ARTIFACT_DIR/"
  fi
  printf '%s\n' "$status" > "$ARTIFACT_DIR/exit-code.txt"
  rm -rf "$WORK_DIR"
  printf 'Canonical E2E artifacts: %s\n' "$ARTIFACT_DIR"
  exit "$status"
}
trap cleanup EXIT

# Include authorized worktree changes while keeping local caches and secrets out.
(cd "$REPO_ROOT" && git ls-files -z --cached --others --exclude-standard \
  | tar --null --ignore-failed-read -T - -cf - 2>/dev/null) | tar -x -C "$WORK_DIR"
printf '%s\n' "$IMAGE" > "$ARTIFACT_DIR/image.txt"
git -C "$REPO_ROOT" rev-parse HEAD > "$ARTIFACT_DIR/base-commit.txt"
git -C "$REPO_ROOT" diff --binary > "$ARTIFACT_DIR/worktree.patch"
printf '%s\n' "memory=$MEMORY_LIMIT" "cpus=4" "shared-memory=1g" "isolation=one-project-per-container" > "$ARTIFACT_DIR/resources.txt"
printf '%s\n' "${PROJECTS[@]}" > "$ARTIFACT_DIR/projects.txt"

# Isolate ports, browser shared memory and resources. Env overrides keep the
# disposable app in synthetic memory mode, regardless of the host environment.
overall_status=0
for project in "${PROJECTS[@]}"; do
  mkdir -p "$ARTIFACT_DIR/main/$project"
  set +e
"$RUNTIME" run --cidfile "$ARTIFACT_DIR/containers/$project.id" --init --shm-size=1g --memory="$MEMORY_LIMIT" --memory-swap="$MEMORY_LIMIT" \
  --cpus=4 --pids-limit=1024 --user "$(id -u):$(id -g)" \
  -e npm_config_cache=/tmp/cvg-e2e-npm-cache -e XDG_CACHE_HOME=/tmp/cvg-e2e-cache \
  -e CI=1 -e NEXT_TELEMETRY_DISABLED=1 \
  -e "CVG_E2E_PROJECT=$project" -e CVG_E2E_RUNTIME_TELEMETRY=true \
  -e DATABASE_URL= -e APP_DATA_MODE=memory -e REALTIME_NOTIFICATION_ADAPTER=process-local \
  -e STORAGE_MODE=local -e STORAGE_ROOT=/tmp/cvg-e2e-uploads \
  -v "$WORK_DIR:/work" -w /work "$IMAGE" \
  bash -c '
    set -Eeuo pipefail
    artifact="canonical-artifacts/main/$CVG_E2E_PROJECT"
    mkdir -p "$npm_config_cache" "$XDG_CACHE_HOME" "$artifact"
    node --version > "$artifact/node-version.txt"
    [[ "$(node -p "process.versions.node.split(\".\")[0]")" == 22 ]] || {
      echo "The pinned image must run Node 22, matching the CI setup-node major." >&2; exit 2;
    }
    # The private container PID namespace includes reparented/orphaned children,
    # which must remain visible if a server launcher exits before its workers.
    node scripts/e2e-runtime-telemetry.mjs --output "$artifact/runtime-telemetry.jsonl" --root-pid 1 &
    telemetry_pid=$!
    find tests/e2e/visual.spec.ts-snapshots -type f -name "*.png" -exec sha256sum {} + | sort > "$artifact/baselines-before.sha256"
    preserve() {
      local status=$?
      trap - EXIT
      kill -TERM "$telemetry_pid" 2>/dev/null || true
      if wait "$telemetry_pid"; then telemetry_status=0; else telemetry_status=$?; fi
      printf "%s\n" "$telemetry_status" > "$artifact/collector-exit-code.txt"
      for path in playwright-report test-results; do
        [[ ! -d "$path" ]] || mv "$path" "$artifact/"
      done
      find tests/e2e/visual.spec.ts-snapshots -type f -name "*.png" -exec sha256sum {} + | sort > "$artifact/baselines-after.sha256"
      cmp -s "$artifact/baselines-before.sha256" "$artifact/baselines-after.sha256" || {
        echo "Baseline files changed during verification." >&2; status=1;
      }
      printf "%s\n" "$status" > "$artifact/exit-code.txt"
      exit "$status"
    }
    trap preserve EXIT
    npm ci --no-audit --no-fund
    set +e
    DEBUG=pw:browser npm run test:e2e -- tests/e2e/core-flows.spec.ts --grep "Plane-style home" --project="$CVG_E2E_PROJECT" --retries=0 --fail-on-flaky-tests --trace=retain-on-failure
    home_status=$?
    set -e
    printf "%s\n" "$home_status" > "$artifact/home-exit-code.txt"
    mkdir -p "canonical-artifacts/home/$CVG_E2E_PROJECT"
    for path in playwright-report test-results; do
      [[ ! -d "$path" ]] || mv "$path" "canonical-artifacts/home/$CVG_E2E_PROJECT/"
    done
    set +e
    DEBUG=pw:browser npm run test:e2e -- "$@" --project="$CVG_E2E_PROJECT" --retries=0 --fail-on-flaky-tests --trace=retain-on-failure
    main_status=$?
    set -e
    printf "%s\n" "$main_status" > "$artifact/main-exit-code.txt"
    (( main_status == 0 )) || exit "$main_status"
    exit "$home_status"
  ' canonical-e2e "${TEST_ARGUMENTS[@]}" 2>&1 | tee "$ARTIFACT_DIR/main/$project/run.log"
  pipeline_status=("${PIPESTATUS[@]}")
  set -e
  cat "$ARTIFACT_DIR/main/$project/run.log" >> "$ARTIFACT_DIR/run.log"
  project_status="${pipeline_status[0]}"
  if (( project_status == 0 && pipeline_status[1] != 0 )); then project_status="${pipeline_status[1]}"; fi
  printf '%s\n' "$project_status" > "$ARTIFACT_DIR/main/$project/runner-exit-code.txt"
  if (( overall_status == 0 && project_status != 0 )); then overall_status="$project_status"; fi
  if ! finalize_container "$project"; then
    (( overall_status != 0 )) || overall_status=1
  fi
done
exit "$overall_status"
