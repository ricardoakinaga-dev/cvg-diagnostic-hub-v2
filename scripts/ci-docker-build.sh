#!/usr/bin/env bash
# `docker build` for CI and release runners: with DOCKER_HUB_MIRROR set (mirror.gcr.io), every Docker Hub base image of
# the Dockerfile is resolved from the mirror through a BuildKit named context (and the `# syntax=` frontend through
# BUILDKIT_SYNTAX), so the build never reaches Docker Hub,
# which rate-limits and refuses anonymous pulls from shared runner IPs. The Dockerfile itself is unchanged; without the
# variable this is a plain `docker build`.
#
#   bash scripts/ci-docker-build.sh [-f <Dockerfile>] [any docker build argument]... <context>
set -Eeuo pipefail

dockerfile="Dockerfile"
args=("$@")
for ((index = 0; index < ${#args[@]}; index++)); do
  case "${args[index]}" in
    -f|--file) dockerfile="${args[index + 1]:-}" ;;
    --file=*) dockerfile="${args[index]#--file=}" ;;
  esac
done
[[ -f "$dockerfile" ]] || { echo "ci-docker-build: Dockerfile not found: $dockerfile" >&2; exit 2; }

contexts=()
if [[ -n "${DOCKER_HUB_MIRROR:-}" ]]; then
  # A `# syntax=` directive makes BuildKit pull the Dockerfile frontend image; BUILDKIT_SYNTAX points it at the mirror.
  syntax="$(sed -nE '1s/^#[[:space:]]*syntax=([^[:space:]]+).*/\1/p' "$dockerfile")"
  if [[ -n "$syntax" && "$syntax" != *.*/* ]]; then
    contexts+=(--build-arg "BUILDKIT_SYNTAX=$DOCKER_HUB_MIRROR/$syntax")
  fi
  stages=" $(sed -nE 's/^FROM[[:space:]]+[^[:space:]]+[[:space:]]+AS[[:space:]]+([^[:space:]]+).*/\1/Ip' "$dockerfile" | tr '\n' ' ') "
  while read -r image; do
    [[ -n "$image" && "$stages" != *" $image "* && "$image" == *:* ]] || continue
    case "$image" in
      *.*/*) continue ;;                              # another registry (ghcr.io/..., mcr.microsoft.com/...)
      */*) path="$image" ;;                           # namespaced Docker Hub image
      *) path="library/$image" ;;                     # official Docker Hub image
    esac
    contexts+=(--build-context "$image=docker-image://$DOCKER_HUB_MIRROR/$path")
  done < <(sed -nE 's/^FROM[[:space:]]+(--platform=[^[:space:]]+[[:space:]]+)?([^[:space:]]+).*/\2/Ip' "$dockerfile" | sort -u)
fi

exec docker build "${contexts[@]}" "$@"
