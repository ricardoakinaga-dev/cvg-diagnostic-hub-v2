#!/usr/bin/env bash
# PROD-512: proves the log stack (docker-compose.observability.yml) end to end with the pinned images. The Loki and
# Alloy configurations must load; a container of a selected Compose project that prints an application JSON line is
# found in Loki by its correlationId, labelled with project, service and level; a container of another project is
# never collected; Grafana comes up with the provisioned Loki datasource healthy. Everything runs in a throwaway
# Compose project and is removed at the end.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.observability.yml"
# DOCKER_HUB_MIRROR (CI: mirror.gcr.io) pulls the same pinned digests through a Docker Hub mirror instead of the
# rate-limited anonymous Docker Hub endpoint; the compose services get the mirrored names from an override file.
MIRROR="${DOCKER_HUB_MIRROR:+$DOCKER_HUB_MIRROR/}"
BUSYBOX_IMAGE="${DOCKER_HUB_MIRROR:+$DOCKER_HUB_MIRROR/library/}busybox:1.36@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662"
image_of() { sed -n "s|^ *image: \\($1:[^ ]*\\)$|\\1|p" "$COMPOSE_FILE"; }
LOKI_IMAGE="$(image_of grafana/loki)"
ALLOY_IMAGE="$(image_of grafana/alloy)"
GRAFANA_IMAGE="$(image_of grafana/grafana)"
PROXY_IMAGE="$(image_of tecnativa/docker-socket-proxy)"
[[ -n "$LOKI_IMAGE" && -n "$ALLOY_IMAGE" && -n "$GRAFANA_IMAGE" && -n "$PROXY_IMAGE" ]] || { echo "images not found in $COMPOSE_FILE" >&2; exit 1; }
compose_files=(-f "$COMPOSE_FILE")
if [[ -n "$MIRROR" ]]; then
  override="$(mktemp --suffix=.yml)"
  printf 'services:\n  docker-proxy: { image: "%s" }\n  loki: { image: "%s" }\n  alloy: { image: "%s" }\n  grafana: { image: "%s" }\n' \
    "$MIRROR$PROXY_IMAGE" "$MIRROR$LOKI_IMAGE" "$MIRROR$ALLOY_IMAGE" "$MIRROR$GRAFANA_IMAGE" > "$override"
  compose_files+=(-f "$override")
fi
LOKI_IMAGE="$MIRROR$LOKI_IMAGE"
ALLOY_IMAGE="$MIRROR$ALLOY_IMAGE"

project="cvglogcheck$$"
app_project="${project}app"
other_project="${project}other"
correlation="corr_$(cat /proc/sys/kernel/random/uuid)"

compose() {
  GRAFANA_ADMIN_PASSWORD=check-only-not-a-secret CVG_LOG_PROJECT_REGEX="$app_project" docker compose -p "$project" "${compose_files[@]}" "$@"
}
cleanup() {
  docker rm -f "$project-app" "$project-other" >/dev/null 2>&1 || true
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  [[ -n "${override:-}" ]] && rm -f "$override"
}
trap cleanup EXIT
fail() { printf '{"event":"logs.check","result":"fail","reason":"%s"}\n' "$1" >&2; exit 1; }

compose config --quiet
docker run --rm -v "$ROOT_DIR/deploy/observability/alloy.alloy:/etc/alloy/config.alloy:ro" "$ALLOY_IMAGE" fmt /etc/alloy/config.alloy >/dev/null \
  || fail "alloy configuration does not parse"
docker run --rm -e LOKI_RETENTION_PERIOD=720h -v "$ROOT_DIR/deploy/observability/loki.yml:/etc/loki/loki.yml:ro" "$LOKI_IMAGE" \
  -config.file=/etc/loki/loki.yml -config.expand-env=true -verify-config >/dev/null 2>&1 || fail "loki configuration does not verify"

compose up -d --quiet-pull docker-proxy loki alloy >/dev/null 2>&1
emit() {
  # $1 container, $2 compose project label, $3 line printed every second
  docker run -d --name "$1" --label "com.docker.compose.project=$2" --label com.docker.compose.service=app \
    -e LINE="$3" "$BUSYBOX_IMAGE" sh -c 'while true; do echo "$LINE"; sleep 1; done' >/dev/null
}
emit "$project-app" "$app_project" "{\"level\":\"info\",\"event\":\"http.request\",\"route\":\"/api/v1/search\",\"status\":200,\"correlationId\":\"$correlation\"}"
emit "$project-other" "$other_project" "{\"level\":\"info\",\"event\":\"http.request\",\"correlationId\":\"$correlation\"}"

query() {
  local encoded
  encoded="$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$1")"
  docker run --rm --network "${project}_query" "$BUSYBOX_IMAGE" wget -qO- "http://loki:3100/loki/api/v1/query_range?query=${encoded}&since=15m&limit=50"
}

found=""
for _ in $(seq 1 60); do
  found="$(query "{project=\"$app_project\"} | json | correlationId=\"$correlation\"" 2>/dev/null || true)"
  grep -q "$correlation" <<<"$found" && break
  sleep 2
done
grep -q "$correlation" <<<"$found" || fail "line with the correlationId not found in Loki"
for label in "\"service\":\"app\"" "\"level\":\"info\"" "\"project\":\"$app_project\""; do
  grep -q "$label" <<<"$found" || fail "label $label missing"
done
other="$(query "{project=\"$other_project\"}" 2>/dev/null || true)"
grep -q '"result":\[\]' <<<"$other" || fail "a container outside CVG_LOG_PROJECT_REGEX was collected"
# Grafana starts with the provisioned Loki datasource and reaches Loki through the query network.
compose up -d --quiet-pull grafana >/dev/null 2>&1
health=""
for _ in $(seq 1 60); do
  health="$(docker run --rm --network "${project}_query" "$BUSYBOX_IMAGE" wget -qO- "http://admin:check-only-not-a-secret@grafana:3000/api/datasources/uid/cvg-loki/health" 2>/dev/null || true)"
  grep -q '"status":"OK"' <<<"$health" && break
  sleep 2
done
grep -q '"status":"OK"' <<<"$health" || fail "grafana does not reach loki through the provisioned datasource"
printf '{"event":"logs.check","result":"ok","correlationId":"%s"}\n' "$correlation"
