#!/usr/bin/env bash
# PROD-303: run on the hospital server by a timer. Follows a release channel of the registry and deploys
# what the channel points to; the server only makes outbound calls (PROD-309: no inbound administration).
#
#   deploy/release/pull-release.sh --channel staging --project cvg-hml --env-file .env.homologacao \
#     --prefix ghcr.io/<owner>/cvg-hub [--compose-file docker-compose.prod.yml ...]
#
# The release workflow moves the "staging" tag after every green main, and the "production" tag only after the
# approval of the production environment. A channel whose app and ops images disagree is refused; a release
# that failed here is not retried until an operator removes <state-dir>/<project>.failed or deploys by hand.
set -Eeuo pipefail

DOCKER="${DOCKER:-docker}"
DEPLOY="${RELEASE_DEPLOY_SCRIPT:-$(dirname "${BASH_SOURCE[0]}")/deploy.sh}"
channel=""
project=""
prefix="${RELEASE_IMAGE_PREFIX:-}"
state_dir="${RELEASE_STATE_DIR:-.data/releases}"
passthrough=()

usage() {
  cat <<'EOF'
Usage: deploy/release/pull-release.sh --channel staging|production --project NAME --env-file FILE
                                      --prefix REGISTRY/OWNER/cvg-hub [--compose-file FILE]... [--state-dir DIR]

Pulls <prefix>:<channel> and <prefix>-ops:<channel>, reads the commit they were built from and, when it differs
from the release recorded in <state-dir>/<project>.current, runs deploy.sh with --tag sha-<commit>.
EOF
}

while (($# > 0)); do
  case "$1" in
    --channel) channel="${2:-}"; shift 2 ;;
    --project) project="${2:-}"; passthrough+=(--project "${2:-}"); shift 2 ;;
    --prefix) prefix="${2:-}"; shift 2 ;;
    --state-dir) state_dir="${2:-}"; shift 2 ;;
    --env-file|--compose-file|--health-timeout) passthrough+=("$1" "${2:-}"); shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

[[ "$channel" == staging || "$channel" == production ]] || { echo "--channel: staging or production" >&2; exit 2; }
[[ "$project" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]] || { echo "--project: lowercase letters, digits, - and _" >&2; exit 2; }
[[ "$prefix" =~ ^[a-z0-9][a-z0-9._/:-]*[a-z0-9]$ ]] || { echo "--prefix: image name without tag" >&2; exit 2; }

note() { printf '{"event":"%s","project":"%s","channel":"%s"%s}\n' "$1" "$project" "$channel" "${2:-}"; }

revisions=()
for image in "$prefix:$channel" "$prefix-ops:$channel"; do
  "$DOCKER" pull --quiet "$image" >/dev/null || { note release.channel_unavailable >&2; exit 1; }
  revisions+=("$("$DOCKER" image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")")
done
if [[ ! "${revisions[0]}" =~ ^[0-9a-f]{40}$ || "${revisions[0]}" != "${revisions[1]}" ]]; then
  note release.channel_inconsistent >&2
  exit 1
fi
tag="sha-${revisions[0]:0:12}"

mkdir -p "$state_dir"
[[ "$(cat "$state_dir/$project.current" 2>/dev/null || true)" == "$tag" ]] && exit 0
if [[ "$(cat "$state_dir/$project.failed" 2>/dev/null || true)" == "$tag" ]]; then
  note release.skipped_failed ",\"tag\":\"$tag\""
  exit 0
fi

if ! "$DEPLOY" "${passthrough[@]}" --prefix "$prefix" --tag "$tag" --state-dir "$state_dir"; then
  printf '%s\n' "$tag" > "$state_dir/$project.failed"
  note release.failed ",\"tag\":\"$tag\"" >&2
  exit 1
fi
