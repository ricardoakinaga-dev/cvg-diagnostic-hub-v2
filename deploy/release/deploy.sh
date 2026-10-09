#!/usr/bin/env bash
# PROD-303: deploys one released image pair (app + ops) on the hospital server, without building.
#
#   deploy/release/deploy.sh --project cvg-prod --env-file .env.production --tag sha-<commit> \
#     --prefix ghcr.io/<owner>/cvg-hub [--compose-file docker-compose.prod.yml ...] [--maintenance]
#
# Order: pull both images -> check that they carry the commit of the tag -> backup -> migrate + up -> wait until
# the app is healthy -> record the release. --maintenance stops proxy, app, worker and backup first and runs the
# migrate alone (coordinated cutover migrations, DEPLOYMENT §4.1). Nothing is rolled back automatically: a release
# that migrated the database is undone by the restore of the backup taken here (DEPLOYMENT §8).
set -Eeuo pipefail

DOCKER="${DOCKER:-docker}"
project=""
env_file=""
tag=""
prefix="${RELEASE_IMAGE_PREFIX:-}"
maintenance=false
state_dir="${RELEASE_STATE_DIR:-.data/releases}"
health_timeout="${RELEASE_HEALTH_TIMEOUT_SECONDS:-300}"
health_poll="${RELEASE_HEALTH_POLL_SECONDS:-5}"
compose_files=()

usage() {
  cat <<'EOF'
Usage: deploy/release/deploy.sh --project NAME --env-file FILE --tag sha-<commit> --prefix REGISTRY/OWNER/cvg-hub
                                [--compose-file FILE]... [--maintenance] [--state-dir DIR] [--health-timeout SECONDS]

Deploys the released images <prefix>:<tag> (app) and <prefix>-ops:<tag> (migrate, worker, bootstrap) with
Docker Compose, without building. --compose-file defaults to docker-compose.prod.yml and may be repeated for
overlays. --maintenance stops the runtime before the backup and the migrations (coordinated cutover).
Environment: DOCKER (docker binary), RELEASE_IMAGE_PREFIX, RELEASE_STATE_DIR (.data/releases),
RELEASE_HEALTH_TIMEOUT_SECONDS (300), RELEASE_HEALTH_POLL_SECONDS (5).
EOF
}

event() {
  # One JSON line per step; values here are identifiers, never secrets.
  local name="$1"; shift
  local fields=""
  while (($# >= 2)); do fields="${fields},\"$1\":\"$2\""; shift 2; done
  printf '{"event":"%s","project":"%s","tag":"%s"%s}\n' "$name" "$project" "$tag" "$fields"
}

fail() {
  event "$1" reason "$2" >&2
  exit 1
}

while (($# > 0)); do
  case "$1" in
    --project) project="${2:-}"; shift 2 ;;
    --env-file) env_file="${2:-}"; shift 2 ;;
    --tag) tag="${2:-}"; shift 2 ;;
    --prefix) prefix="${2:-}"; shift 2 ;;
    --compose-file) compose_files+=("${2:-}"); shift 2 ;;
    --maintenance) maintenance=true; shift ;;
    --state-dir) state_dir="${2:-}"; shift 2 ;;
    --health-timeout) health_timeout="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

((${#compose_files[@]} > 0)) || compose_files=(docker-compose.prod.yml)
[[ "$project" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]] || { echo "--project: lowercase letters, digits, - and _" >&2; exit 2; }
# Only immutable commit tags: "latest", "staging" or "production" would make the release unreproducible.
[[ "$tag" =~ ^sha-[0-9a-f]{12,40}$ ]] || { echo "--tag: sha-<12 to 40 hex characters of the commit>" >&2; exit 2; }
[[ "$prefix" =~ ^[a-z0-9][a-z0-9._/:-]*[a-z0-9]$ ]] || { echo "--prefix: image name without tag, e.g. ghcr.io/<owner>/cvg-hub" >&2; exit 2; }
[[ -f "$env_file" ]] || { echo "--env-file: file not found" >&2; exit 2; }
[[ "$health_timeout" =~ ^[1-9][0-9]*$ ]] || { echo "--health-timeout: positive number of seconds" >&2; exit 2; }
for file in "${compose_files[@]}"; do [[ -f "$file" ]] || { echo "--compose-file: $file not found" >&2; exit 2; }; done

# Compose reads IMAGE_PREFIX and IMAGE_TAG from the shell before the env file, so the release wins over any
# value left in .env.
# MINIO_IMAGE_TAG: the on-prem overlay's object storage image is released with the same commit tag (D-045, D-050).
export IMAGE_PREFIX="$prefix" IMAGE_TAG="$tag" MINIO_IMAGE_TAG="$tag"
compose_args=(compose -p "$project")
for file in "${compose_files[@]}"; do compose_args+=(-f "$file"); done
compose_args+=(--env-file "$env_file")
compose() { "$DOCKER" "${compose_args[@]}" "$@"; }

event release.started maintenance "$maintenance"
# Every image of the selected compose files: the release images (app, ops and, with the on-prem overlay, minio) and
# the pinned public ones, so `up -d --no-build` never needs to build or to reach a registry by itself.
compose pull || fail release.pull_failed "the registry did not serve every image of the release"

commit="${tag#sha-}"
for image in "$prefix:$tag" "$prefix-ops:$tag"; do
  revision="$("$DOCKER" image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image" 2>/dev/null || true)"
  [[ -n "$revision" && "$revision" == "$commit"* ]] || fail release.revision_mismatch "$image is not built from commit $commit"
done

if [[ "$maintenance" == true ]]; then
  compose stop proxy app worker backup || fail release.stop_failed "could not stop the runtime"
fi
# --no-deps: the backup must not start the new migrate before the copy (DEPLOYMENT §4).
compose run --rm --no-deps backup --once || fail release.backup_failed "no backup, no deploy"
if [[ "$maintenance" == true ]]; then
  compose run --rm migrate || fail release.migrate_failed "migrations refused or failed; the runtime is stopped"
fi
# Without --maintenance the migrate service runs first and app/worker are only recreated after it succeeds.
compose up -d --no-build || fail release.up_failed "migrate or a service failed to start"

deadline=$((SECONDS + health_timeout))
while :; do
  app_container="$(compose ps -q app || true)"
  health="$([[ -n "$app_container" ]] && "$DOCKER" inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$app_container" 2>/dev/null || true)"
  [[ "$health" == healthy ]] && break
  ((SECONDS < deadline)) || fail release.unhealthy "app did not become healthy within ${health_timeout}s (last: ${health:-missing})"
  sleep "$health_poll"
done
worker_container="$(compose ps -q worker || true)"
[[ -n "$worker_container" && "$("$DOCKER" inspect --format '{{.State.Running}}' "$worker_container" 2>/dev/null || true)" == true ]] \
  || fail release.worker_down "worker is not running"

mkdir -p "$state_dir"
previous="$(cat "$state_dir/$project.current" 2>/dev/null || true)"
printf '%s\n' "$tag" > "$state_dir/$project.current"
printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$tag" >> "$state_dir/$project.history"
rm -f "$state_dir/$project.failed"
event release.deployed previous "${previous:-none}"
