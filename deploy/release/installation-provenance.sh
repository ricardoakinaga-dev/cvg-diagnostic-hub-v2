#!/usr/bin/env bash
# Proves which commit an installation runs (audit of 2026-10-10: the local install ran images tagged 20261003 with
# no commit, so nobody could tell whether it matched the reviewed code). For every running container of the Compose
# project built from this repository (app, worker and the ops one-shots), prints one JSON line with the service, the
# image and the commit of its OCI label, and fails when the app or the worker is missing, unstamped, built from
# different commits, or (with --expect) built from another commit than the one given.
#
#   deploy/release/installation-provenance.sh --project cvg-prod [--expect <commit>]
set -Eeuo pipefail

DOCKER="${DOCKER:-docker}"
project=""
expect=""

usage() {
  cat <<'USAGE'
Usage: deploy/release/installation-provenance.sh --project NAME [--expect COMMIT]

Lists the commit (org.opencontainers.image.revision) of every running app, worker and ops container of the Compose
project NAME. Exit 0 only when the app and the worker run, carry a commit, agree, and match COMMIT when given.
Environment: DOCKER (docker binary).
USAGE
}

while (($# > 0)); do
  case "$1" in
    --project) project="${2:-}"; shift 2 ;;
    --expect) expect="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
[[ "$project" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]] || { echo "--project: lowercase letters, digits, - and _" >&2; exit 2; }
[[ -z "$expect" || "$expect" =~ ^[0-9a-f]{7,40}$ ]] || { echo "--expect: 7 to 40 hex characters of the commit" >&2; exit 2; }

fail() {
  printf '{"event":"installation.provenance_failed","project":"%s","reason":"%s"}\n' "$project" "$1" >&2
  exit 1
}

declare -A revisions=()
while read -r container service image; do
  [[ -n "$container" ]] || continue
  case "$service" in app|worker|migrate|bootstrap) ;; *) continue ;; esac
  revision="$("$DOCKER" inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$container" 2>/dev/null || true)"
  # A full commit id only: a date tag such as 20261003 is hexadecimal too.
  [[ "$revision" =~ ^[0-9a-f]{40}$ ]] || revision="unknown"
  printf '{"event":"installation.provenance","project":"%s","service":"%s","image":"%s","revision":"%s"}\n' "$project" "$service" "$image" "$revision"
  revisions[$service]="$revision"
done < <("$DOCKER" ps --filter "label=com.docker.compose.project=$project" --format '{{.ID}} {{.Label "com.docker.compose.service"}} {{.Image}}')

for service in app worker; do
  [[ -n "${revisions[$service]:-}" ]] || fail "$service is not running"
  [[ "${revisions[$service]}" != unknown ]] || fail "$service runs an image without a commit; rebuild with SOURCE_REVISION or deploy a release"
done
[[ "${revisions[app]}" == "${revisions[worker]}" ]] || fail "app and worker run different commits"
if [[ -n "$expect" && "${revisions[app]}" != "$expect"* && "$expect" != "${revisions[app]}"* ]]; then
  fail "the installation runs ${revisions[app]}, not $expect"
fi
printf '{"event":"installation.provenance_ok","project":"%s","revision":"%s"}\n' "$project" "${revisions[app]}"
