#!/usr/bin/env bash
# PROD-511: validates the Prometheus scrape configuration and the alert rules,
# and proves with promtool unit tests that each alert fires on its signal.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# DOCKER_HUB_MIRROR (CI: mirror.gcr.io) pulls the same pinned digest through a Docker Hub mirror instead of the
# rate-limited anonymous Docker Hub endpoint.
PROMETHEUS_IMAGE="${DOCKER_HUB_MIRROR:+$DOCKER_HUB_MIRROR/}prom/prometheus:v3.15.0@sha256:efd719c99d83b060d9daefdcf00360461adf279f45ef5391f8d111892118753e"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

cp "$ROOT_DIR"/deploy/observability/prometheus.yml "$ROOT_DIR"/deploy/observability/alerts.yml "$ROOT_DIR"/deploy/observability/alerts.test.yml \
  "$ROOT_DIR"/deploy/observability/infrastructure-alerts.yml "$ROOT_DIR"/deploy/observability/infrastructure-alerts.test.yml "$work_dir"/
mkdir -p "$work_dir/secrets"
# The real token is mounted at deploy time; the check only needs the file to exist.
printf 'placeholder-token-for-config-check-0000\n' > "$work_dir/secrets/metrics-scrape-token"
chmod -R a+rX "$work_dir"

promtool() {
  if [[ -n "${PROMTOOL:-}" ]]; then
    ( cd "$work_dir" && "$PROMTOOL" "$@" )
  else
    docker run --rm -v "$work_dir:/etc/prometheus:ro" -w /etc/prometheus --entrypoint /bin/promtool "$PROMETHEUS_IMAGE" "$@"
  fi
}

if [[ -n "${PROMTOOL:-}" ]]; then
  # Native/rootless validation uses the same files with mount paths rewritten to its disposable directory.
  sed -i "s|/etc/prometheus/|$work_dir/|g" "$work_dir/prometheus.yml"
fi

promtool check config prometheus.yml
promtool check rules alerts.yml
promtool test rules alerts.test.yml
promtool check rules infrastructure-alerts.yml
promtool test rules infrastructure-alerts.test.yml
