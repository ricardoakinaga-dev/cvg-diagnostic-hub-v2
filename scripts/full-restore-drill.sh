#!/usr/bin/env bash
# Full disaster rehearsal of PROD-514 (D2: RPO 15 min, RTO 4 h; D-057): the DATABASE AND THE ATTACHMENTS BUCKET are
# lost together and both come back from the OFF-SITE copy only, then the two halves are reconciled:
#   (a) secrets and certificates in a temp dir (scripts/onprem-init.sh, scripts/secrets-init.sh), never in the env file;
#   (b) starts postgres + migrate + backup + storage + storage-init + storage-iam + offsite on a DISPOSABLE Compose project
#       (prod + onprem + secrets + storage-drill overlays); the off-site destination is an rclone crypt remote (D-051);
#   (c) seeds DRILL_ATTACHMENT_COUNT finalized attachments through the application's own store and file store
#       (scripts/drill-seed-attachments.ts, run with the worker's environment), then reconciles rows and objects (baseline);
#   (d) forces a WAL switch and waits until the WAL, the dump and the objects reached the off-site copy;
#   (e) destroys the PostgreSQL, backup, WAL-archive and storage volumes (simulated loss of the server);
#   (f) fetches the off-site copy through the crypt remote, restores the database to the latest point
#       (scripts/restore-pitr.sh --latest) and the bucket into a new hardened bucket (storage-restore, app user);
#   (g) reconciles the restored database against the restored bucket (scripts/attachments-reconcile.ts): every finalized
#       attachment has its object, no orphan object; then proves the reconciliation detects a missing and a stray object;
#   (h) prints a JSON summary with RPO (last write → off-site) and RTO (fetch + database + bucket + reconciliation).
#
#   npm run restore:drill            # or: bash scripts/full-restore-drill.sh [--keep]
#
# Environment: DRILL_PROJECT (default cvg-restore-drill), DRILL_PORT (loopback port of the restored PostgreSQL, default
# 55514), DRILL_STORAGE_PORT (loopback port of MinIO for the host-side reconciliation, default 59014),
# DRILL_SHIP_INTERVAL_SECONDS (default 15), DRILL_ATTACHMENT_COUNT (default 50), DRILL_ATTACHMENT_KB (default 64),
# DRILL_IMAGE_PREFIX (default = project). Needs the repository's node_modules (host-side reconciliation).
# Never point it at a production Compose project: DRILL_PROJECT must contain "drill" and the script runs `down -v` on it.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="${DRILL_PROJECT:-cvg-restore-drill}"
PORT="${DRILL_PORT:-55514}"
STORAGE_PORT="${DRILL_STORAGE_PORT:-59014}"
SHIP_INTERVAL="${DRILL_SHIP_INTERVAL_SECONDS:-15}"
ATTACHMENT_COUNT="${DRILL_ATTACHMENT_COUNT:-50}"
ATTACHMENT_KB="${DRILL_ATTACHMENT_KB:-64}"
KEEP="false"
[[ "${1:-}" == "--keep" ]] && KEEP="true"
[[ "${1:-}" == "--help" || "${1:-}" == "-h" ]] && { sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0; }
# Allowlist by shape, not denylist by name: the project runs `down -v`, so only a name that says "drill" is accepted.
[[ "$PROJECT" =~ ^[a-z0-9][a-z0-9_-]*drill[a-z0-9_-]*$ ]] || { echo "DRILL_PROJECT inválido: use um projeto descartável cujo nome contenha 'drill' (recebido: $PROJECT)" >&2; exit 2; }
[[ "$PORT" =~ ^[0-9]+$ && "$STORAGE_PORT" =~ ^[0-9]+$ && "$ATTACHMENT_COUNT" =~ ^[0-9]+$ && "$ATTACHMENT_KB" =~ ^[0-9]+$ && "$SHIP_INTERVAL" =~ ^[0-9]+$ ]] \
  || { echo "DRILL_PORT, DRILL_STORAGE_PORT, DRILL_ATTACHMENT_COUNT, DRILL_ATTACHMENT_KB e DRILL_SHIP_INTERVAL_SECONDS devem ser inteiros" >&2; exit 2; }
[[ -d "$ROOT_DIR/node_modules/.bin" ]] || { echo "node_modules ausente: rode npm ci antes (a reconciliação roda no host)" >&2; exit 2; }

work_dir="$(mktemp -d)"
env_file="$work_dir/drill.env"
onprem_dir="$work_dir/onprem"
secrets_dir="$work_dir/secrets"
offsite_dir="$work_dir/offsite"
DC=(docker compose -p "$PROJECT" -f "$ROOT_DIR/docker-compose.prod.yml" -f "$ROOT_DIR/docker-compose.onprem.yml" -f "$ROOT_DIR/docker-compose.secrets.yml" -f "$ROOT_DIR/docker-compose.storage-drill.yml" --env-file "$env_file")
restore_name="$PROJECT-restore-latest"
drill_started="$(date +%s)"

cleanup() {
  status=$?
  docker rm -f "$restore_name" >/dev/null 2>&1 || true
  if [[ "$KEEP" != "true" ]]; then
    "${DC[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
    # Restored data directories and the fetched copy belong to container users.
    [[ -d "$work_dir" ]] && docker run --rm -v "$work_dir:/w" --entrypoint sh postgres:16-alpine -c 'rm -rf /w/*' >/dev/null 2>&1 || true
    rm -rf "$work_dir"
  else
    echo "--keep: projeto $PROJECT, container $restore_name e $work_dir mantidos" >&2
  fi
  exit "$status"
}
trap cleanup EXIT

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
json_field() { sed -n "s/.*\"$2\":\([^,}]*\).*/\1/p" <<<"$1" | head -1 | tr -d '"'; }

# (a) secrets and certificates.
bash "$ROOT_DIR/scripts/onprem-init.sh" "$onprem_dir" >/dev/null 2>&1
bash "$ROOT_DIR/scripts/secrets-init.sh" "$secrets_dir" --allow-empty metrics_scrape_token >/dev/null
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
    -e "s|^OFFSITE_SHIP_INTERVAL_SECONDS=.*|OFFSITE_SHIP_INTERVAL_SECONDS=$SHIP_INTERVAL|" \
    "$ROOT_DIR/.env.production.example" > "$env_file"
if grep -E '^(POSTGRES_PASSWORD|POSTGRES_MIGRATION_PASSWORD|POSTGRES_RUNTIME_PASSWORD|POSTGRES_BACKUP_PASSWORD|SESSION_SECRET|TRUST_PROXY_SHARED_SECRET|STORAGE_SECRET_KEY|MALWARE_SCANNER_API_KEY|METRICS_SCRAPE_TOKEN|OFFSITE_CRYPT_PASSWORD|OFFSITE_CRYPT_SALT)=.+' "$env_file"; then
  echo "o arquivo de ambiente do ensaio contém um segredo" >&2; exit 1
fi
printf 'DRILL_STORAGE_PORT=%s\n' "$STORAGE_PORT" >> "$env_file"
chmod 600 "$env_file"
pg_user="$(sed -n 's/^POSTGRES_USER=//p' "$env_file")"; pg_db="$(sed -n 's/^POSTGRES_DB=//p' "$env_file")"
runtime_user="$(sed -n 's/^POSTGRES_RUNTIME_USER=//p' "$env_file")"; runtime_user="${runtime_user:-cvg_runtime}"
archive_timeout="$(sed -n 's/^WAL_ARCHIVE_TIMEOUT_SECONDS=//p' "$env_file")"
cat > "$work_dir/probe.yml" <<YAML
services:
  storage:
    ports:
      - "127.0.0.1:${STORAGE_PORT}:9000"
YAML
DC+=(-f "$work_dir/probe.yml")

# (b) stack.
# The seed and the reconciliation run inside the ops image: build it from the working tree, never reuse a stale tag.
step "construindo a imagem ops do ensaio"
"${DC[@]}" build migrate >&2
step "subindo postgres, migrate, backup, storage, storage-init, storage-iam e offsite (projeto $PROJECT)"
"${DC[@]}" up -d postgres migrate backup storage storage-init storage-iam offsite >&2
postgres_container="$("${DC[@]}" ps -q postgres)"
offsite_container="$("${DC[@]}" ps -q offsite)"
psql_main() { docker exec "$postgres_container" psql -U "$pg_user" -d "$pg_db" -v ON_ERROR_STOP=1 -Atq "$@"; }
wait_for "migrate concluído" 600 exited_ok migrate
wait_for "storage-init concluído" 180 exited_ok storage-init
wait_for "storage-iam concluído" 120 exited_ok storage-iam
wait_for "primeiro backup base" 180 "${DC[@]}" exec -T backup sh -c 'ls /backups/base/*Z/base.tar.gz'
wait_for "primeiro dump" 180 "${DC[@]}" exec -T backup sh -c 'ls /backups/cvg-*.dump'
step "pilha pronta: bucket $bucket endurecido, backup base e dump presentes"

# A freshly migrated database has no runtime state until the first administrator is created, exactly as on the first
# production deploy (`docker compose run --rm bootstrap`). The password is throwaway; the service has no log driver.
step "criando o primeiro administrador (bootstrap)"
"${DC[@]}" --profile bootstrap run --rm --no-deps -T -e BOOTSTRAP_ADMIN_EMAIL=admin@drill.invalid -e BOOTSTRAP_ADMIN_PASSWORD="Drill-$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)" bootstrap > "$work_dir/bootstrap.log" 2>&1 \
  || { echo "bootstrap falhou" >&2; tail -20 "$work_dir/bootstrap.log" >&2; exit 1; }
grep -qF '"event":"bootstrap.completed"' "$work_dir/bootstrap.log" || { echo "bootstrap não concluiu" >&2; tail -20 "$work_dir/bootstrap.log" >&2; exit 1; }
# (c) seed through the application's store and file store, with the worker's environment (secrets as files, CA).
# A one-off container with the worker's service definition (secrets as files, CA, storage env); its output is kept
# in the work dir so a failure shows the cause instead of an empty line.
worker_run() { # log-name, docker compose run args...
  local log="$work_dir/$1.log"; shift
  "${DC[@]}" --profile never run --rm --no-deps -T "$@" > "$log" 2>&1 || true
  grep -F '"event":"' "$log" | grep -vF '"event":"secrets.loaded"' | tail -1
}
show_log() { echo "--- $1 ---" >&2; tail -40 "$work_dir/$1.log" >&2 || true; }
batch="$(date -u +%Y%m%d%H%M%S)"
seed_json="$(worker_run seed -e DRILL_ATTACHMENT_COUNT="$ATTACHMENT_COUNT" -e DRILL_ATTACHMENT_KB="$ATTACHMENT_KB" -e DRILL_BATCH="$batch" worker node_modules/.bin/tsx scripts/drill-seed-attachments.ts)"
[[ "$(json_field "$seed_json" event)" == "drill.attachments_seeded" ]] || { echo "a semeadura dos anexos falhou: $seed_json" >&2; show_log seed; exit 1; }
last_write_at="$(json_field "$seed_json" lastWriteAt)"
last_write_epoch="$(date -u -d "$last_write_at" +%s)"
step "$ATTACHMENT_COUNT anexos gravados (linhas + objetos) até $last_write_at"
baseline_json="$(worker_run reconcile-baseline worker node_modules/.bin/tsx scripts/attachments-reconcile.ts)"
[[ "$(json_field "$baseline_json" event)" == "attachments.reconciled" ]] || { echo "reconciliação inicial divergente: $baseline_json" >&2; show_log reconcile-baseline; exit 1; }
step "reconciliação inicial ok: $baseline_json"

# (d) WAL switch, archive, off-site copy of WAL + dump + objects.
switched="$(psql_main -c "SELECT pg_walfile_name(pg_switch_wal())")"
archived() { [[ "$(psql_main -c "SELECT COALESCE(last_archived_wal >= '$switched', false) FROM pg_stat_archiver")" == "t" ]]; }
wait_for "segmento $switched arquivado" 120 archived
status_field() { docker exec "$offsite_container" sed -n "s/.*\"$1\":\([^,}]*\).*/\1/p" /backups/offsite-status.json 2>/dev/null | head -1; }
rclone_in_offsite() { docker exec "$offsite_container" sh /opt/backup/rclone-with-secrets.sh "$@"; }
shipped() {
  local epoch; epoch="$(status_field lastShippedEpoch)"
  [[ -n "$epoch" && "$(status_field lastResult)" == '"ok"' ]] && (( epoch > last_write_epoch )) \
    && rclone_in_offsite lsf "offsitecrypt:wal/$switched" 2>/dev/null | grep -q . \
    && [[ "$(rclone_in_offsite size "offsitecrypt:objects" --json | sed -n 's/.*"count":\([0-9]*\).*/\1/p')" == "$ATTACHMENT_COUNT" ]]
}
wait_for "cópia externa de WAL, dump e objetos" $(( SHIP_INTERVAL * 8 + 90 )) shipped
shipped_epoch="$(status_field lastShippedEpoch)"
docker exec "$offsite_container" sh /opt/backup/check-offsite.sh >&2
db_bytes="$(psql_main -c "SELECT pg_database_size('$pg_db')")"
step "cópia externa completa ${shipped_epoch}: RPO medido $(( shipped_epoch - last_write_epoch ))s desde a última gravação"

# (e) loss of the server: database, local backups, WAL archive and bucket volumes are gone. Only the off-site copy remains.
step "destruindo postgres, backups locais, arquivo de WAL e storage (perda simulada)"
"${DC[@]}" rm -sf postgres migrate backup offsite storage storage-init storage-iam >/dev/null 2>&1
for volume in cvg-postgres cvg-backups cvg-wal-archive cvg-storage; do docker volume rm "${PROJECT}_${volume}" >/dev/null; done
restore_started="$(date +%s)"

# (f) fetch the off-site copy through the crypt remote (only the crypt secrets open it), restore database and bucket.
mkdir -p "$offsite_dir"
"${DC[@]}" --profile restore run --rm --no-deps -T -v "$offsite_dir:/out" storage-restore copy "offsitecrypt:" /out --log-level ERROR
docker run --rm -v "$offsite_dir:/w" --entrypoint sh postgres:16-alpine -c 'chmod -R a+rX /w' >/dev/null
fetch_seconds=$(( $(date +%s) - restore_started ))
base_dir="$(ls -1d "$offsite_dir"/dumps/base/[0-9]*Z | sort | tail -1)"
wal_count="$(ls "$offsite_dir/wal" | grep -cE '^[0-9A-F]{24}$' || true)"
step "cópia externa baixada em ${fetch_seconds}s: base $(basename "$base_dir"), $wal_count segmentos de WAL, $(ls "$offsite_dir/objects/attachments" 2>/dev/null | wc -l) pasta(s) de objetos"
db_restore_started="$(date +%s)"
restore_json="$(bash "$ROOT_DIR/scripts/restore-pitr.sh" --base "$base_dir" --wal "$offsite_dir/wal" --latest --data "$work_dir/data-latest" --port "$PORT" --user "$pg_user" --name "$restore_name")"
echo "$restore_json" >&2
db_restore_seconds=$(( $(date +%s) - db_restore_started ))
restored_attachments="$(docker exec "$restore_name" psql -U "$pg_user" -d "$pg_db" -Atq -c "SELECT count(*) FROM cvg_runtime_entities WHERE collection = 'attachments'" 2>/dev/null || echo "?")"
step "banco restaurado (--latest) em ${db_restore_seconds}s: $restored_attachments linhas de anexo"
bucket_restore_started="$(date +%s)"
"${DC[@]}" up -d storage storage-init storage-iam >&2
wait_for "bucket novo endurecido" 180 exited_ok storage-init
wait_for "usuários recriados" 120 exited_ok storage-iam
rclone_as_app() { "${DC[@]}" --profile restore run --rm --no-deps -T storage-restore "$@"; }
[[ "$(rclone_as_app size "minio:$bucket" --json | sed -n 's/.*"count":\([0-9]*\).*/\1/p')" == "0" ]] || { echo "o bucket novo não está vazio" >&2; exit 1; }
rclone_as_app copy "offsitecrypt:objects" "minio:$bucket" --ignore-existing --log-level ERROR
bucket_restore_seconds=$(( $(date +%s) - bucket_restore_started ))
step "bucket restaurado a partir da cópia externa em ${bucket_restore_seconds}s"

# (g) reconciliation of the restored database against the restored bucket, from the host, as the runtime user.
reconcile_started="$(date +%s)"
reconcile() {
  ( cd "$ROOT_DIR" && APP_DATA_MODE=postgres \
      DATABASE_URL="postgresql://${runtime_user}:\${POSTGRES_RUNTIME_PASSWORD}@127.0.0.1:${PORT}/${pg_db}" \
      POSTGRES_RUNTIME_PASSWORD_FILE="$secrets_dir/postgres_runtime_password" \
      STORAGE_MODE=s3 STORAGE_ENDPOINT="http://127.0.0.1:${STORAGE_PORT}" STORAGE_BUCKET="$bucket" STORAGE_ACCESS_KEY=cvg-app \
      STORAGE_SECRET_KEY_FILE="$secrets_dir/storage_secret_key" STORAGE_FORCE_PATH_STYLE=true \
      node_modules/.bin/tsx scripts/attachments-reconcile.ts 2>/dev/null | grep -F '"event":"attachments.' | tail -1 ) || true
}
reconcile_json="$(reconcile)"
[[ "$(json_field "$reconcile_json" event)" == "attachments.reconciled" ]] || { echo "FALHA: banco e bucket restaurados divergem: $reconcile_json" >&2; exit 1; }
[[ "$(sed -n 's/.*"finalized":\([0-9]*\).*/\1/p' <<<"$reconcile_json")" == "$ATTACHMENT_COUNT" ]] || { echo "FALHA: anexos finalizados restaurados diferentes de $ATTACHMENT_COUNT: $reconcile_json" >&2; exit 1; }
reconcile_seconds=$(( $(date +%s) - reconcile_started ))
rto_seconds=$(( $(date +%s) - restore_started ))
step "reconciliação ok em ${reconcile_seconds}s: $reconcile_json"

# The reconciliation must see what a bad restore would leave behind: one object missing, one object nobody owns.
rclone_as_app deletefile "minio:$bucket/attachments/drill-$batch/1.bin" --log-level ERROR
missing_json="$(reconcile)"
[[ "$(json_field "$missing_json" event)" == "attachments.divergent" && "$missing_json" == *'"attachment-drill-'"$batch"'-1","source":"active"'* ]] || { echo "FALHA: objeto removido não detectado: $missing_json" >&2; exit 1; }
printf 'stray' > "$work_dir/stray.bin"; chmod a+r "$work_dir/stray.bin"
"${DC[@]}" --profile restore run --rm --no-deps -T -v "$work_dir/stray.bin:/stray.bin:ro" storage-restore copyto /stray.bin "minio:$bucket/attachments/stray.bin" --s3-no-check-bucket --log-level ERROR
stray_json="$(reconcile)"
[[ "$(json_field "$stray_json" orphanObjects)" == "1" ]] || { echo "FALHA: objeto órfão não detectado: $stray_json" >&2; exit 1; }
step "reconciliação detecta objeto faltante e objeto órfão"

# (h) summary.
printf '{"event":"restore_drill.completed","date":"%s","project":"%s","attachments":%s,"attachmentKb":%s,"databaseBytes":%s,"walSegmentsRestored":%s,"rpo":{"lastWriteToOffsiteSeconds":%s,"nominalSeconds":%s,"budgetSeconds":900},"rto":{"fetchSeconds":%s,"databaseRestoreSeconds":%s,"bucketRestoreSeconds":%s,"reconcileSeconds":%s,"totalSeconds":%s,"budgetSeconds":14400},"reconciliation":%s,"detectsMissingObject":true,"detectsOrphanObject":true,"encryptedDestination":true,"secretsAsFiles":true,"drillWallClockSeconds":%s}\n' \
  "$(date -u +%Y-%m-%d)" "$PROJECT" "$ATTACHMENT_COUNT" "$ATTACHMENT_KB" "$db_bytes" "$wal_count" \
  "$(( shipped_epoch - last_write_epoch ))" "$(( ${archive_timeout:-300} + SHIP_INTERVAL ))" \
  "$fetch_seconds" "$db_restore_seconds" "$bucket_restore_seconds" "$reconcile_seconds" "$rto_seconds" "$reconcile_json" "$(( $(date +%s) - drill_started ))"
