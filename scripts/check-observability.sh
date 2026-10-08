#!/usr/bin/env bash
# PROD-511: validates the Prometheus scrape configuration and the alert rules,
# and proves with promtool unit tests that each alert fires on its signal.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROMETHEUS_IMAGE="prom/prometheus:v3.15.0@sha256:efd719c99d83b060d9daefdcf00360461adf279f45ef5391f8d111892118753e"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

cp "$ROOT_DIR"/deploy/observability/prometheus.yml "$ROOT_DIR"/deploy/observability/alerts.yml "$ROOT_DIR"/deploy/observability/alerts.test.yml "$work_dir"/
mkdir -p "$work_dir/secrets"
# The real token is mounted at deploy time; the check only needs the file to exist.
printf 'placeholder-token-for-config-check-0000\n' > "$work_dir/secrets/metrics-scrape-token"
chmod -R a+rX "$work_dir"

promtool() {
  docker run --rm -v "$work_dir:/etc/prometheus:ro" -w /etc/prometheus --entrypoint /bin/promtool "$PROMETHEUS_IMAGE" "$@"
}

promtool check config prometheus.yml
promtool check rules alerts.yml
promtool test rules alerts.test.yml
