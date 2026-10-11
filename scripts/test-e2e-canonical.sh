#!/usr/bin/env bash
# Run against the CI's pinned browser, libraries and fonts. Never update baselines.
set -Eeuo pipefail

IMAGE="mcr.microsoft.com/playwright:v1.55.1-noble@sha256:2f29369043d81d6d69a815ceb80760f55e85f5020371ad06a4d996f18503ad1c"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME="${CVG_E2E_CONTAINER_RUNTIME:-docker}"
if [[ "$RUNTIME" != docker && "$RUNTIME" != podman ]]; then
  echo "CVG_E2E_CONTAINER_RUNTIME must be docker or podman." >&2
  exit 2
fi
if ! command -v "$RUNTIME" >/dev/null 2>&1; then
  echo "Canonical E2E needs Docker or Podman and the pinned CI image; install a container runtime or run this command on the CI runner." >&2
  exit 2
fi
if ! rg -qF "$IMAGE" "$REPO_ROOT/.github/workflows/ci.yml"; then
  echo "The CI browser image changed; update IMAGE in this script before running." >&2
  exit 2
fi
for argument in "$@"; do
  case "$argument" in
    -u|--update-snapshots|--update-snapshots=*)
      echo "Canonical E2E preserves existing baselines. Use the reviewed visual-update procedure separately." >&2
      exit 2
      ;;
  esac
done

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cvg-e2e-canonical.XXXXXX")"
ARTIFACT_DIR="$REPO_ROOT/test-results/canonical-$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir -p "$ARTIFACT_DIR"
cleanup() {
  local status=$?
  trap - EXIT
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

# Isolate ports, browser shared memory and resources. Env overrides keep the
# disposable app in synthetic memory mode, regardless of the host environment.
"$RUNTIME" run --rm --init --shm-size=1g --memory=4g --memory-swap=4g \
  --cpus=4 --pids-limit=1024 --user "$(id -u):$(id -g)" \
  -e npm_config_cache=/tmp/cvg-e2e-npm-cache -e XDG_CACHE_HOME=/tmp/cvg-e2e-cache \
  -e CI=1 -e NEXT_TELEMETRY_DISABLED=1 \
  -e DATABASE_URL= -e APP_DATA_MODE=memory -e REALTIME_NOTIFICATION_ADAPTER=process-local \
  -e STORAGE_MODE=local -e STORAGE_ROOT=/tmp/cvg-e2e-uploads \
  -v "$WORK_DIR:/work" -w /work "$IMAGE" \
  bash -c '
    set -Eeuo pipefail
    mkdir -p "$npm_config_cache" "$XDG_CACHE_HOME" canonical-artifacts
    node --version > canonical-artifacts/node-version.txt
    [[ "$(node -p "process.versions.node.split(\".\")[0]")" == 22 ]] || {
      echo "The pinned image must run Node 22, matching the CI setup-node major." >&2; exit 2;
    }
    find tests/e2e/visual.spec.ts-snapshots -type f -name "*.png" -exec sha256sum {} + | sort > canonical-artifacts/baselines-before.sha256
    preserve() {
      local status=$?
      trap - EXIT
      mkdir -p canonical-artifacts/main
      for path in playwright-report test-results; do
        [[ ! -d "$path" ]] || mv "$path" canonical-artifacts/main/
      done
      find tests/e2e/visual.spec.ts-snapshots -type f -name "*.png" -exec sha256sum {} + | sort > canonical-artifacts/baselines-after.sha256
      cmp -s canonical-artifacts/baselines-before.sha256 canonical-artifacts/baselines-after.sha256 || {
        echo "Baseline files changed during verification." >&2; status=1;
      }
      exit "$status"
    }
    trap preserve EXIT
    npm ci --no-audit --no-fund
    npm run test:e2e -- tests/e2e/core-flows.spec.ts --grep "Plane-style home" --retries=0 --fail-on-flaky-tests --trace=retain-on-failure
    mkdir -p canonical-artifacts/home
    for path in playwright-report test-results; do
      [[ ! -d "$path" ]] || mv "$path" canonical-artifacts/home/
    done
    npm run test:e2e -- "$@" --retries=0 --fail-on-flaky-tests --trace=retain-on-failure
  ' canonical-e2e "$@" 2>&1 | tee "$ARTIFACT_DIR/run.log"
