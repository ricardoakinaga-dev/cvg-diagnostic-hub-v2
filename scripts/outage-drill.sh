#!/usr/bin/env bash
# Unavailability rehearsal of PROD-513/PROD-515 on a DISPOSABLE Compose project: the whole production stack
# (prod + onprem + secrets overlays: postgres, migrate, backup, storage, storage-init, storage-iam, clamav, scanner,
# app, worker, proxy, offsite) plus a Prometheus evaluating deploy/observability/alerts.yml against the real
# /api/v1/metrics. Each outage is provoked, the signal the runbook names is observed, the rule that owns it is seen
# FIRING in Prometheus, the component comes back and the signal clears:
#   1. worker stopped: a notification delivery is queued through the application's outbox (scripts/drill-seed-outbox.ts);
#      cvg_outbox_oldest_age_seconds grows past 300 s and CvgOutboxStalled fires; the worker restarts, delivers it
#      (cvg_outbox_pending back to 0) and the alert resolves. Runs in the background of the next two scenarios.
#   2. ClamAV stopped: the scanner adapter turns unhealthy (Docker healthcheck), readiness stays ready (an attachment
#      upload would be refused, never released unscanned); ClamAV restarts and the scanner recovers.
#   3. MinIO stopped: /api/v1/readyz answers 503, cvg_readiness_failures grows, CvgHubReadinessFailing fires; MinIO
#      restarts and readiness recovers.
#   4. PostgreSQL stopped: same signals as 3 (after the outbox scenario, so its `for` window is not broken).
#   5. app stopped: Prometheus target `up` drops to 0 and CvgHubScrapeDown fires after 2 minutes; the app restarts
#      and the target recovers.
#   Prints a JSON summary with the seconds to detect, to alert and to recover for each scenario, then tears down.
#
#   npm run outage:drill            # or: bash scripts/outage-drill.sh [--keep]
#
# Environment: DRILL_PROJECT (default cvg-outage-drill), DRILL_PROXY_PORT (loopback HTTP edge, default 58080),
# DRILL_PROMETHEUS_PORT (loopback, default 59090), DRILL_IMAGE_PREFIX (default = project), DOCKER_HUB_MIRROR (optional
# registry mirror for the Prometheus image, as in CI). The edge is plain HTTP on loopback: TLS is rehearsed elsewhere.
# Never point it at a production Compose project: it runs `down -v` on DRILL_PROJECT.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="${DRILL_PROJECT:-cvg-outage-drill}"
PROXY_PORT="${DRILL_PROXY_PORT:-58080}"
PROM_PORT="${DRILL_PROMETHEUS_PORT:-59090}"
KEEP="false"
[[ "${1:-}" == "--keep" ]] && KEEP="true"
[[ "${1:-}" == "--help" || "${1:-}" == "-h" ]] && { sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0; }
[[ "$PROJECT" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || { echo "DRILL_PROJECT inválido" >&2; exit 2; }
for forbidden in cvg-hub cvg-diagnostic-hub-v2 cvg-diagnostic-local cvg-prod cvg-hml; do
  [[ "$PROJECT" != "$forbidden" ]] || { echo "recusando usar o projeto $PROJECT: use um projeto descartável" >&2; exit 2; }
done
[[ "$PROXY_PORT" =~ ^[0-9]+$ && "$PROM_PORT" =~ ^[0-9]+$ ]] || { echo "DRILL_PROXY_PORT e DRILL_PROMETHEUS_PORT devem ser inteiros" >&2; exit 2; }
command -v python3 >/dev/null || { echo "python3 é necessário para ler as respostas do Prometheus" >&2; exit 2; }

work_dir="$(mktemp -d)"
env_file="$work_dir/drill.env"
onprem_dir="$work_dir/onprem"
secrets_dir="$work_dir/secrets"
DC=(docker compose -p "$PROJECT" -f "$ROOT_DIR/docker-compose.prod.yml" -f "$ROOT_DIR/docker-compose.onprem.yml" -f "$ROOT_DIR/docker-compose.secrets.yml" -f "$ROOT_DIR/docker-compose.outage-drill.yml" --env-file "$env_file")
drill_started="$(date +%s)"

cleanup() {
  status=$?
  if [[ "$KEEP" != "true" ]]; then
    "${DC[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
    rm -rf "$work_dir"
  else
    echo "--keep: projeto $PROJECT e $work_dir mantidos" >&2
  fi
  exit "$status"
}
trap cleanup EXIT

step() { printf '[%ss] %s\n' "$(( $(date +%s) - drill_started ))" "$1" >&2; }
# wait_until <description> <timeout-seconds> <command...>: prints the seconds it took; fails the drill on timeout.
wait_until() {
  local description="$1" limit="$2"; shift 2
  local started; started="$(date +%s)"
  until "$@" >/dev/null 2>&1; do
    (( $(date +%s) - started < limit )) || { echo "tempo esgotado esperando: $description" >&2; "${DC[@]}" ps >&2 || true; exit 1; }
    sleep 3
  done
  echo $(( $(date +%s) - started ))
}
exited_ok() { local id; id="$("${DC[@]}" ps -aq "$1")"; [[ -n "$id" && "$(docker inspect -f '{{.State.Status}}' "$id" 2>/dev/null)" == "exited" && "$(docker inspect -f '{{.State.ExitCode}}' "$id")" == "0" ]]; }
health_of() { docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$("${DC[@]}" ps -q "$1")" 2>/dev/null || echo missing; }
health_is() { [[ "$(health_of "$1")" == "$2" ]]; }
readyz() { curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${PROXY_PORT}/api/v1/readyz" || echo 000; }
readyz_is() { [[ "$(readyz)" == "$1" ]]; }
prom_query() { # expression → scalar of the first sample, or empty
  curl -s -G --max-time 5 "http://127.0.0.1:${PROM_PORT}/api/v1/query" --data-urlencode "query=$1" \
    | python3 -c 'import json,sys
try:
  r=json.load(sys.stdin)["data"]["result"]
  print(r[0]["value"][1] if r else "")
except Exception:
  print("")'
}
prom_query_is() { [[ "$(prom_query "$1")" == "$2" ]]; }
prom_query_gt() { python3 -c 'import sys; v=sys.argv[1]; sys.exit(0 if v not in ("", "NaN") and float(v) > float(sys.argv[2]) else 1)' "$(prom_query "$1")" "$2"; }
alert_state() { # alertname → firing|pending|inactive
  curl -s --max-time 5 "http://127.0.0.1:${PROM_PORT}/api/v1/alerts" | python3 -c 'import json,sys
name=sys.argv[1]
try:
  alerts=[a for a in json.load(sys.stdin)["data"]["alerts"] if a["labels"].get("alertname")==name]
except Exception:
  alerts=[]
print("firing" if any(a["state"]=="firing" for a in alerts) else "pending" if alerts else "inactive")' "$1"
}
alert_is() { [[ "$(alert_state "$1")" == "$2" ]]; }

# Secrets and certificates (files only); env file without any secret value.
bash "$ROOT_DIR/scripts/onprem-init.sh" "$onprem_dir" >/dev/null 2>&1
bash "$ROOT_DIR/scripts/secrets-init.sh" "$secrets_dir" >/dev/null
bucket="drill-attachments"
sed -e "s|^APP_DOMAIN=.*|APP_DOMAIN=localhost|" \
    -e "s|^IMAGE_PREFIX=.*|IMAGE_PREFIX=${DRILL_IMAGE_PREFIX:-$PROJECT}|" \
    -e "s|^STORAGE_ENDPOINT=.*|STORAGE_ENDPOINT=http://storage:9000|" \
    -e "s|^STORAGE_BUCKET=.*|STORAGE_BUCKET=$bucket|" \
    -e "s|^STORAGE_ACCESS_KEY=.*|STORAGE_ACCESS_KEY=cvg-app|" \
    -e "s|^STORAGE_FORCE_PATH_STYLE=.*|STORAGE_FORCE_PATH_STYLE=true|" \
    -e "s|^MALWARE_SCANNER_ENDPOINT=.*|MALWARE_SCANNER_ENDPOINT=https://scanner:9443/scan|" \
    -e "s|^MALWARE_SCANNER_ALLOWED_HOSTS=.*|MALWARE_SCANNER_ALLOWED_HOSTS=scanner|" \
    -e "s|^ONPREM_DIR=.*|ONPREM_DIR=$onprem_dir|" \
    -e "s|^SECRETS_DIR=.*|SECRETS_DIR=$secrets_dir|" \
    -e "s|^OFFSITE_RCLONE_REMOTE=.*|OFFSITE_RCLONE_REMOTE=offsitecrypt:|" \
    -e "s|^OFFSITE_CRYPT_REMOTE=.*|OFFSITE_CRYPT_REMOTE=/offsite-destination|" \
    -e "s|^OFFSITE_RCLONE_CONFIG=.*|OFFSITE_RCLONE_CONFIG=$ROOT_DIR/deploy/backup/rclone.conf.example|" \
    "$ROOT_DIR/.env.production.example" > "$env_file"
if grep -E '^(POSTGRES_PASSWORD|POSTGRES_MIGRATION_PASSWORD|POSTGRES_RUNTIME_PASSWORD|POSTGRES_BACKUP_PASSWORD|SESSION_SECRET|TRUST_PROXY_SHARED_SECRET|STORAGE_SECRET_KEY|MALWARE_SCANNER_API_KEY|METRICS_SCRAPE_TOKEN|OFFSITE_CRYPT_PASSWORD|OFFSITE_CRYPT_SALT)=.+' "$env_file"; then
  echo "o arquivo de ambiente do ensaio contém um segredo" >&2; exit 1
fi
cat > "$work_dir/Caddyfile" <<'CADDY'
# Plain-HTTP edge of the outage rehearsal (loopback only). It still proves the request crossed the edge and carries
# the client address, exactly as deploy/Caddyfile does over TLS.
:8080 {
	reverse_proxy app:3000 {
		header_up X-Cvg-Proxy-Secret {$TRUST_PROXY_SHARED_SECRET}
		header_up X-Real-IP {remote_host}
	}
}
CADDY
cat > "$work_dir/prometheus.yml" <<'PROM'
global:
  scrape_interval: 15s
  evaluation_interval: 15s
rule_files:
  - /etc/prometheus/alerts.yml
scrape_configs:
  - job_name: cvg-hub
    scheme: http
    metrics_path: /api/v1/metrics
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/secrets/metrics-scrape-token
    static_configs:
      - targets: ["proxy:8080"]
        labels:
          environment: drill
PROM
chmod a+r "$work_dir/Caddyfile" "$work_dir/prometheus.yml" "$secrets_dir/metrics_scrape_token"
{
  printf 'DRILL_PROXY_PORT=%s\nDRILL_PROMETHEUS_PORT=%s\nDRILL_CADDYFILE=%s\nDRILL_PROMETHEUS_CONFIG=%s\n' "$PROXY_PORT" "$PROM_PORT" "$work_dir/Caddyfile" "$work_dir/prometheus.yml"
  [[ -n "${DOCKER_HUB_MIRROR:-}" ]] && printf 'PROMETHEUS_IMAGE=%s/prom/prometheus:v3.15.0@sha256:efd719c99d83b060d9daefdcf00360461adf279f45ef5391f8d111892118753e\n' "$DOCKER_HUB_MIRROR"
} >> "$env_file"
chmod 600 "$env_file"

step "construindo as imagens ops e app do ensaio"
"${DC[@]}" build migrate app >&2
step "subindo banco, storage, antivírus e cópia externa (projeto $PROJECT)"
"${DC[@]}" up -d postgres migrate backup storage storage-init storage-iam clamav scanner offsite >&2
wait_until "migrate concluído" 600 exited_ok migrate >/dev/null
# A freshly migrated database has no runtime state until the first administrator is created, exactly as on the first
# production deploy: /readyz answers 503 and the app healthcheck never passes before `bootstrap` runs. The password is
# throwaway; the service has no log driver.
step "criando o primeiro administrador (bootstrap)"
"${DC[@]}" --profile bootstrap run --rm --no-deps -T -e BOOTSTRAP_ADMIN_EMAIL=admin@drill.invalid -e BOOTSTRAP_ADMIN_PASSWORD="Drill-$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)" bootstrap > "$work_dir/bootstrap.log" 2>&1 \
  || { echo "bootstrap falhou" >&2; tail -20 "$work_dir/bootstrap.log" >&2; exit 1; }
grep -qF '"event":"bootstrap.completed"' "$work_dir/bootstrap.log" || { echo "bootstrap não concluiu" >&2; tail -20 "$work_dir/bootstrap.log" >&2; exit 1; }
step "subindo app, worker, borda e Prometheus"
"${DC[@]}" up -d app worker proxy prometheus >&2
wait_until "readiness pronta pela borda" 600 readyz_is 200 >/dev/null
wait_until "worker saudável" 180 health_is worker healthy >/dev/null
wait_until "Prometheus lendo /metrics" 180 prom_query_is 'up{job="cvg-hub"}' 1 >/dev/null
[[ "$(alert_state CvgHubReadinessFailing)" == "inactive" && "$(alert_state CvgOutboxStalled)" == "inactive" ]] || { echo "alertas já ativos antes do ensaio" >&2; exit 1; }
step "pilha pronta: readyz 200, worker $(health_of worker), alvo do Prometheus up"

# 1. worker stopped, one delivery queued through the application's outbox.
"${DC[@]}" stop worker >&2
seed_json="$("${DC[@]}" run --rm --no-deps -T -e DRILL_BATCH="$(date -u +%Y%m%d%H%M%S)" worker node_modules/.bin/tsx scripts/drill-seed-outbox.ts 2>"$work_dir/seed.log" | grep -F '"event":"drill.outbox_seeded"' | tail -1)"
[[ -n "$seed_json" ]] || { echo "a semeadura do outbox falhou" >&2; tail -20 "$work_dir/seed.log" >&2; exit 1; }
outbox_seeded="$(date +%s)"
wait_until "outbox pendente visível na métrica" 120 prom_query_gt 'cvg_outbox_pending{job="cvg-hub"}' 0 >/dev/null
step "worker parado e uma entrega pendente no outbox: aguardando CvgOutboxStalled em segundo plano"

# 2. ClamAV stopped while the outbox ages.
"${DC[@]}" stop clamav >&2
scanner_unhealthy_seconds="$(wait_until "scanner não saudável sem o ClamAV" 180 health_is scanner unhealthy)"
readiness_during_clamav="$(readyz)"
"${DC[@]}" start clamav >&2
scanner_recovery_seconds="$(wait_until "scanner saudável de novo" 300 health_is scanner healthy)"
step "ClamAV: scanner unhealthy em ${scanner_unhealthy_seconds}s (readyz $readiness_during_clamav), recuperado em ${scanner_recovery_seconds}s"

# 3. MinIO stopped.
"${DC[@]}" stop storage >&2
storage_detect_seconds="$(wait_until "readyz 503 sem o MinIO" 120 readyz_is 503)"
storage_alert_seconds="$(wait_until "CvgHubReadinessFailing disparando" 180 alert_is CvgHubReadinessFailing firing)"
"${DC[@]}" start storage >&2
storage_recovery_seconds="$(wait_until "readyz 200 com o MinIO de volta" 180 readyz_is 200)"
step "MinIO: readyz 503 em ${storage_detect_seconds}s, alerta em ${storage_alert_seconds}s, recuperado em ${storage_recovery_seconds}s"

# 1 (continued). The outbox message is older than 300 s and the rule held for 5 more minutes.
wait_until "CvgOutboxStalled disparando" 900 alert_is CvgOutboxStalled firing >/dev/null
stalled_total_seconds=$(( $(date +%s) - outbox_seeded ))
oldest_age="$(prom_query 'cvg_outbox_oldest_age_seconds{job="cvg-hub"}')"
"${DC[@]}" start worker >&2
outbox_recovery_seconds="$(wait_until "outbox esvaziado pelo worker" 240 prom_query_is 'cvg_outbox_pending{job="cvg-hub"}' 0)"
stalled_resolve_seconds="$(wait_until "CvgOutboxStalled resolvido" 240 alert_is CvgOutboxStalled inactive)"
step "worker: CvgOutboxStalled ${stalled_total_seconds}s depois da fila (idade ${oldest_age}s), entrega ${outbox_recovery_seconds}s após voltar, alerta resolvido em ${stalled_resolve_seconds}s"

# 4. PostgreSQL stopped. CvgHubReadinessFailing looks back 10 minutes, so it may still be firing from scenario 3:
# the readiness 503 and the recovery are the signals that belong to this scenario alone.
"${DC[@]}" stop postgres >&2
pg_detect_seconds="$(wait_until "readyz 503 sem o PostgreSQL" 120 readyz_is 503)"
pg_alert_seconds="$(wait_until "CvgHubReadinessFailing disparando" 180 alert_is CvgHubReadinessFailing firing)"
"${DC[@]}" start postgres >&2
pg_recovery_seconds="$(wait_until "readyz 200 com o PostgreSQL de volta" 300 readyz_is 200)"
step "PostgreSQL: readyz 503 em ${pg_detect_seconds}s, alerta em ${pg_alert_seconds}s, recuperado em ${pg_recovery_seconds}s"

# 5. app stopped.
"${DC[@]}" stop app >&2
app_down_seconds="$(wait_until "alvo do Prometheus caído" 120 prom_query_is 'up{job="cvg-hub"}' 0)"
app_alert_seconds="$(wait_until "CvgHubScrapeDown disparando" 300 alert_is CvgHubScrapeDown firing)"
"${DC[@]}" start app >&2
app_recovery_seconds="$(wait_until "alvo do Prometheus de volta" 300 prom_query_is 'up{job="cvg-hub"}' 1)"
step "app: alvo caído em ${app_down_seconds}s, alerta em ${app_alert_seconds}s, recuperado em ${app_recovery_seconds}s"

printf '{"event":"outage_drill.completed","date":"%s","project":"%s","scenarios":{"worker":{"signal":"cvg_outbox_oldest_age_seconds","alert":"CvgOutboxStalled","secondsToAlertSinceQueued":%s,"oldestAgeSecondsAtAlert":%s,"secondsToDeliverAfterRestart":%s,"secondsToResolve":%s},"clamav":{"signal":"scanner healthcheck","secondsToUnhealthy":%s,"readinessDuringOutage":%s,"secondsToRecover":%s},"storage":{"signal":"readyz 503 + cvg_readiness_failures","alert":"CvgHubReadinessFailing","secondsToDetect":%s,"secondsToAlert":%s,"secondsToRecover":%s},"postgres":{"signal":"readyz 503 + cvg_readiness_failures","alert":"CvgHubReadinessFailing","secondsToDetect":%s,"secondsToAlert":%s,"secondsToRecover":%s},"app":{"signal":"up == 0","alert":"CvgHubScrapeDown","secondsToDetect":%s,"secondsToAlert":%s,"secondsToRecover":%s}},"edge":"plain HTTP on loopback","drillWallClockSeconds":%s}\n' \
  "$(date -u +%Y-%m-%d)" "$PROJECT" "$stalled_total_seconds" "${oldest_age:-0}" "$outbox_recovery_seconds" "$stalled_resolve_seconds" \
  "$scanner_unhealthy_seconds" "$readiness_during_clamav" "$scanner_recovery_seconds" \
  "$storage_detect_seconds" "$storage_alert_seconds" "$storage_recovery_seconds" \
  "$pg_detect_seconds" "$pg_alert_seconds" "$pg_recovery_seconds" \
  "$app_down_seconds" "$app_alert_seconds" "$app_recovery_seconds" "$(( $(date +%s) - drill_started ))"
