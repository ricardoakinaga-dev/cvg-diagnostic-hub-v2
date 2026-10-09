#!/usr/bin/env bash
# End-to-end rehearsal of the attachments bucket backup + restore (PROD-514, S3 half; PROD-307 hardening) on a
# DISPOSABLE Compose project with the on-prem overlay:
#   (a) generates CA, scanner certificate and MinIO KMS key in a temp dir (scripts/onprem-init.sh);
#   (b) starts postgres + migrate + backup + storage + storage-init + offsite (prod + onprem + storage-drill overlays);
#   (c) checks the bucket hardening report (versioning, SSE, private, lifecycle) and an anonymous read from the host (403);
#   (d) uploads DRILL_OBJECT_COUNT objects (DRILL_OBJECT_KB each) to the bucket and waits for the off-site copy;
#   (e) destroys the storage volume (simulated loss), recreates an empty hardened bucket, restores from the OFF-SITE copy;
#   (f) verifies every object by checksum, re-verifies the hardening, prints a JSON summary with timings, tears down.
#
#   npm run storage:backup:drill            # or: bash scripts/storage-backup-drill.sh [--keep]
#
# Environment: DRILL_PROJECT (default cvg-storage-drill), DRILL_SHIP_INTERVAL_SECONDS (default 15), DRILL_OBJECT_COUNT
# (default 200), DRILL_OBJECT_KB (default 64), DRILL_STORAGE_PORT (loopback port for the anonymous probe, default 59000).
# Never point it at a production Compose project: it runs `down -v` on DRILL_PROJECT.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="${DRILL_PROJECT:-cvg-storage-drill}"
SHIP_INTERVAL="${DRILL_SHIP_INTERVAL_SECONDS:-15}"
OBJECT_COUNT="${DRILL_OBJECT_COUNT:-200}"
OBJECT_KB="${DRILL_OBJECT_KB:-64}"
STORAGE_PORT="${DRILL_STORAGE_PORT:-59000}"
KEEP="false"
[[ "${1:-}" == "--keep" ]] && KEEP="true"
[[ "${1:-}" == "--help" || "${1:-}" == "-h" ]] && { sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0; }
[[ "$PROJECT" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || { echo "DRILL_PROJECT inválido" >&2; exit 2; }
[[ "$PROJECT" != "cvg-hub" && "$PROJECT" != "cvg-diagnostic-hub-v2" && "$PROJECT" != "cvg-diagnostic-local" ]] || { echo "recusando usar o projeto $PROJECT: use um projeto descartável" >&2; exit 2; }
[[ "$OBJECT_COUNT" =~ ^[0-9]+$ && "$OBJECT_KB" =~ ^[0-9]+$ && "$STORAGE_PORT" =~ ^[0-9]+$ ]] || { echo "DRILL_OBJECT_COUNT, DRILL_OBJECT_KB e DRILL_STORAGE_PORT devem ser inteiros" >&2; exit 2; }

work_dir="$(mktemp -d)"
env_file="$work_dir/drill.env"
onprem_dir="$work_dir/onprem"
seed_dir="$work_dir/seed"
DC=(docker compose -p "$PROJECT" -f "$ROOT_DIR/docker-compose.prod.yml" -f "$ROOT_DIR/docker-compose.onprem.yml" -f "$ROOT_DIR/docker-compose.storage-drill.yml" --env-file "$env_file")
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

secret() { head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32; }
step() { printf '[%ss] %s\n' "$(( $(date +%s) - drill_started ))" "$1" >&2; }
wait_for() { # description, timeout, command...
  local description="$1" limit="$2"; shift 2
  local until=$(( $(date +%s) + limit ))
  until "$@" >/dev/null 2>&1; do
    (( $(date +%s) < until )) || { echo "tempo esgotado esperando: $description" >&2; "${DC[@]}" logs --tail 40 >&2 || true; exit 1; }
    sleep 2
  done
}
exited_ok() { # service
  local id; id="$("${DC[@]}" ps -aq "$1")"
  [[ -n "$id" && "$(docker inspect -f '{{.State.Status}}' "$id" 2>/dev/null)" == "exited" && "$(docker inspect -f '{{.State.ExitCode}}' "$id")" == "0" ]]
}
status_field() { docker exec "$offsite_container" sed -n "s/.*\"$1\":\([^,}]*\).*/\1/p" /backups/offsite-status.json 2>/dev/null | head -1; }

# (a) secrets and certificates, never from the repository.
bash "$ROOT_DIR/scripts/onprem-init.sh" "$onprem_dir" >/dev/null 2>&1
bucket="drill-attachments"
sed -e "s|^APP_DOMAIN=.*|APP_DOMAIN=localhost|" \
    -e "s|^IMAGE_PREFIX=.*|IMAGE_PREFIX=${DRILL_IMAGE_PREFIX:-$PROJECT}|" \
    -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(secret)|" \
    -e "s|^SESSION_SECRET=.*|SESSION_SECRET=$(secret)$(secret)|" \
    -e "s|^TRUST_PROXY_SHARED_SECRET=.*|TRUST_PROXY_SHARED_SECRET=$(secret)|" \
    -e "s|^STORAGE_ENDPOINT=.*|STORAGE_ENDPOINT=http://storage:9000|" \
    -e "s|^STORAGE_BUCKET=.*|STORAGE_BUCKET=$bucket|" \
    -e "s|^STORAGE_ACCESS_KEY=.*|STORAGE_ACCESS_KEY=drill$(secret | head -c 12)|" \
    -e "s|^STORAGE_SECRET_KEY=.*|STORAGE_SECRET_KEY=$(secret)|" \
    -e "s|^STORAGE_FORCE_PATH_STYLE=.*|STORAGE_FORCE_PATH_STYLE=true|" \
    -e "s|^MALWARE_SCANNER_ENDPOINT=.*|MALWARE_SCANNER_ENDPOINT=https://scanner:9443/scan|" \
    -e "s|^MALWARE_SCANNER_API_KEY=.*|MALWARE_SCANNER_API_KEY=$(secret)|" \
    -e "s|^MALWARE_SCANNER_ALLOWED_HOSTS=.*|MALWARE_SCANNER_ALLOWED_HOSTS=scanner|" \
    -e "s|^ONPREM_DIR=.*|ONPREM_DIR=$onprem_dir|" \
    -e "s|^POSTGRES_MIGRATION_PASSWORD=.*|POSTGRES_MIGRATION_PASSWORD=$(secret)|" \
    -e "s|^POSTGRES_RUNTIME_PASSWORD=.*|POSTGRES_RUNTIME_PASSWORD=$(secret)|" \
    -e "s|^POSTGRES_BACKUP_PASSWORD=.*|POSTGRES_BACKUP_PASSWORD=$(secret)|" \
    -e "s|^OFFSITE_RCLONE_REMOTE=.*|OFFSITE_RCLONE_REMOTE=:local:/offsite-destination|" \
    -e "s|^OFFSITE_RCLONE_CONFIG=.*|OFFSITE_RCLONE_CONFIG=$ROOT_DIR/deploy/backup/rclone.conf.example|" \
    -e "s|^OFFSITE_SHIP_INTERVAL_SECONDS=.*|OFFSITE_SHIP_INTERVAL_SECONDS=$SHIP_INTERVAL|" \
    "$ROOT_DIR/.env.production.example" > "$env_file"
printf 'DRILL_STORAGE_PORT=%s\n' "$STORAGE_PORT" >> "$env_file"
chmod 600 "$env_file"
# Published only for the anonymous probe from the host; the production overlay publishes nothing.
cat > "$work_dir/probe.yml" <<EOF
services:
  storage:
    ports:
      - "127.0.0.1:${STORAGE_PORT}:9000"
EOF
DC+=(-f "$work_dir/probe.yml")

# (b) stack.
step "subindo postgres, migrate, backup, storage, storage-init e offsite (projeto $PROJECT)"
"${DC[@]}" up -d postgres migrate backup storage storage-init offsite >&2
offsite_container="$("${DC[@]}" ps -q offsite)"
wait_for "migrate concluído" 600 exited_ok migrate
wait_for "storage-init concluído (hardening)" 180 exited_ok storage-init
hardening_json="$("${DC[@]}" logs --no-log-prefix storage-init 2>/dev/null | grep -F '"event":"storage.hardened"' | tail -1)"
[[ -n "$hardening_json" ]] || { echo "storage-init não reportou storage.hardened" >&2; "${DC[@]}" logs storage-init >&2; exit 1; }
step "bucket $bucket endurecido: $hardening_json"

# (c) anonymous read from the host (no credentials): must be refused.
anonymous_status="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${STORAGE_PORT}/${bucket}/attachments/anything" || echo 000)"
[[ "$anonymous_status" == "403" ]] || { echo "leitura anônima respondeu $anonymous_status, esperado 403" >&2; exit 1; }
listing_status="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${STORAGE_PORT}/${bucket}/" || echo 000)"
[[ "$listing_status" == "403" ]] || { echo "listagem anônima respondeu $listing_status, esperado 403" >&2; exit 1; }
wait_for "primeiro dump do PostgreSQL" 180 "${DC[@]}" exec -T backup sh -c 'ls /backups/cvg-*.dump'

# (d) objects: written through the S3 API, like the app does, then shipped off-site.
mkdir -p "$seed_dir/attachments"
for i in $(seq 1 "$OBJECT_COUNT"); do head -c "$(( OBJECT_KB * 1024 ))" /dev/urandom > "$seed_dir/attachments/result-$i.bin"; done
seed_bytes="$(du -sb "$seed_dir" | cut -f1)"
rclone_in_offsite() { docker exec "$offsite_container" rclone "$@"; }
docker cp "$seed_dir/." "$offsite_container:/tmp/seed" >/dev/null
upload_started="$(date +%s)"
rclone_in_offsite copy /tmp/seed "minio:$bucket" --log-level ERROR
upload_seconds=$(( $(date +%s) - upload_started ))
object_count="$(rclone_in_offsite size "minio:$bucket" --json | sed -n 's/.*"count":\([0-9]*\).*/\1/p')"
[[ "$object_count" == "$OBJECT_COUNT" ]] || { echo "bucket tem $object_count objetos, esperado $OBJECT_COUNT" >&2; exit 1; }
step "$OBJECT_COUNT objetos ($seed_bytes bytes) gravados no bucket em ${upload_seconds}s"
shipped() { [[ "$(status_field lastResult)" == '"ok"' && "$(status_field objects)" == "$OBJECT_COUNT" ]]; }
wait_for "cópia externa dos objetos" $(( SHIP_INTERVAL * 6 + 60 )) shipped
backup_seconds=$(( $(date +%s) - upload_started ))
offsite_count="$(rclone_in_offsite size ":local:/offsite-destination/objects" --json | sed -n 's/.*"count":\([0-9]*\).*/\1/p')"
[[ "$offsite_count" == "$OBJECT_COUNT" ]] || { echo "destino externo tem $offsite_count objetos, esperado $OBJECT_COUNT" >&2; exit 1; }
docker exec "$offsite_container" sh /opt/backup/check-offsite.sh >&2
step "cópia externa completa: $offsite_count objetos, ${backup_seconds}s desde o início do upload"

# (e) loss of the storage volume, then restore from the off-site copy only.
step "destruindo o volume de storage (perda simulada)"
"${DC[@]}" rm -sf storage storage-init >/dev/null 2>&1
docker volume rm "${PROJECT}_cvg-storage" >/dev/null
"${DC[@]}" up -d storage storage-init >&2
wait_for "bucket novo endurecido" 180 exited_ok storage-init
[[ "$(rclone_in_offsite size "minio:$bucket" --json | sed -n 's/.*"count":\([0-9]*\).*/\1/p')" == "0" ]] || { echo "o bucket novo não está vazio" >&2; exit 1; }
restore_started="$(date +%s)"
rclone_in_offsite copy ":local:/offsite-destination/objects" "minio:$bucket" --log-level ERROR
restore_seconds=$(( $(date +%s) - restore_started ))
step "restore do bucket concluído em ${restore_seconds}s"

# (f) verification: every object, byte for byte, from the original seed; hardening still in place; copy still refuses nothing.
check_output="$(rclone_in_offsite check /tmp/seed "minio:$bucket" --one-way 2>&1)" || { echo "$check_output" >&2; echo "objetos restaurados divergem do original" >&2; exit 1; }
restored_count="$(rclone_in_offsite size "minio:$bucket" --json | sed -n 's/.*"count":\([0-9]*\).*/\1/p')"
[[ "$restored_count" == "$OBJECT_COUNT" ]] || { echo "restaurados $restored_count objetos, esperado $OBJECT_COUNT" >&2; exit 1; }
verify_json="$("${DC[@]}" run --rm --no-deps -T storage-init node_modules/.bin/tsx scripts/init-storage.ts --verify 2>/dev/null | grep -F '"event":"storage.verified"' | tail -1)"
[[ -n "$verify_json" ]] || { echo "a verificação do bucket restaurado falhou" >&2; exit 1; }
restored_anonymous="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${STORAGE_PORT}/${bucket}/attachments/result-1.bin" || echo 000)"
[[ "$restored_anonymous" == "403" ]] || { echo "objeto restaurado legível anonimamente ($restored_anonymous)" >&2; exit 1; }
minio_version="$(docker exec "$("${DC[@]}" ps -q storage)" minio --version 2>/dev/null | head -1 | tr -d '\n' || echo unknown)"

printf '{"event":"storage_drill.completed","project":"%s","objects":%s,"bytes":%s,"uploadSeconds":%s,"backupSeconds":%s,"restoreSeconds":%s,"anonymousReadStatus":%s,"restoredAnonymousReadStatus":%s,"hardening":%s,"restoredBucketVerification":%s,"minio":"%s","totalSeconds":%s}\n' \
  "$PROJECT" "$OBJECT_COUNT" "$seed_bytes" "$upload_seconds" "$backup_seconds" "$restore_seconds" "$anonymous_status" "$restored_anonymous" "$hardening_json" "$verify_json" "$minio_version" "$(( $(date +%s) - drill_started ))"
