#!/usr/bin/env bash
# End-to-end rehearsal of backup + point-in-time recovery (PROD-304/PROD-514) on a DISPOSABLE Compose project:
#   (a) starts postgres + migrate + backup + offsite from docker-compose.prod.yml (+ docker-compose.pitr-drill.yml);
#   (b) writes marker rows with timestamps, (c) forces a WAL switch, waits for archive and off-site shipment;
#   (d) restores from the OFF-SITE copy to a time between two markers (scripts/restore-pitr.sh), then again with --latest;
#   (e) verifies the marker sets, (f) prints a JSON summary with RPO and RTO, and tears everything down.
#
#   npm run db:backup:drill            # or: bash scripts/backup-drill.sh [--keep]
#
# Environment: DRILL_PROJECT (default cvg-pitr-drill), DRILL_PORT (PostgreSQL on loopback, default 55304; the restore uses
# DRILL_PORT+1), DRILL_SHIP_INTERVAL_SECONDS (default 15), DRILL_ROW_COUNT (bulk rows for a measurable data size, default 200000).
# Never point it at a production Compose project: it runs `down -v` on DRILL_PROJECT.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="${DRILL_PROJECT:-cvg-pitr-drill}"
PORT="${DRILL_PORT:-55304}"
SHIP_INTERVAL="${DRILL_SHIP_INTERVAL_SECONDS:-15}"
ROW_COUNT="${DRILL_ROW_COUNT:-200000}"
KEEP="false"
[[ "${1:-}" == "--keep" ]] && KEEP="true"
[[ "${1:-}" == "--help" || "${1:-}" == "-h" ]] && { sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0; }
[[ "$PROJECT" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || { echo "DRILL_PROJECT inválido" >&2; exit 2; }
[[ "$PROJECT" != "cvg-hub" && "$PROJECT" != "cvg-diagnostic-hub-v2" ]] || { echo "recusando usar o projeto $PROJECT: use um projeto descartável" >&2; exit 2; }

work_dir="$(mktemp -d)"
env_file="$work_dir/drill.env"
DC=(docker compose -p "$PROJECT" -f "$ROOT_DIR/docker-compose.prod.yml" -f "$ROOT_DIR/docker-compose.pitr-drill.yml" --env-file "$env_file")
restore_names=("$PROJECT-restore-pitr" "$PROJECT-restore-latest")
drill_started="$(date +%s)"

cleanup() {
  status=$?
  for restore in "${restore_names[@]}"; do docker rm -f "$restore" >/dev/null 2>&1 || true; done
  if [[ "$KEEP" != "true" ]]; then
    "${DC[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
    # The restored data directories belong to the container's postgres user.
    [[ -d "$work_dir" ]] && docker run --rm -v "$work_dir:/w" --entrypoint sh postgres:16-alpine -c 'rm -rf /w/*' >/dev/null 2>&1 || true
    rm -rf "$work_dir"
  else
    echo "--keep: projeto $PROJECT e $work_dir mantidos" >&2
  fi
  exit "$status"
}
trap cleanup EXIT

secret() { head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32; }
step() { printf '[%ss] %s\n' "$(( $(date +%s) - drill_started ))" "$1" >&2; }

# Environment built from the production example, with throwaway values.
sed -e "s|^APP_DOMAIN=.*|APP_DOMAIN=localhost|" \
    -e "s|^IMAGE_PREFIX=.*|IMAGE_PREFIX=$PROJECT|" \
    -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(secret)|" \
    -e "s|^SESSION_SECRET=.*|SESSION_SECRET=$(secret)$(secret)|" \
    -e "s|^TRUST_PROXY_SHARED_SECRET=.*|TRUST_PROXY_SHARED_SECRET=$(secret)|" \
    -e "s|^STORAGE_ENDPOINT=.*|STORAGE_ENDPOINT=http://storage.invalid|" \
    -e "s|^STORAGE_BUCKET=.*|STORAGE_BUCKET=drill|" \
    -e "s|^STORAGE_ACCESS_KEY=.*|STORAGE_ACCESS_KEY=drill|" \
    -e "s|^STORAGE_SECRET_KEY=.*|STORAGE_SECRET_KEY=$(secret)|" \
    -e "s|^MALWARE_SCANNER_ENDPOINT=.*|MALWARE_SCANNER_ENDPOINT=http://scanner.invalid|" \
    -e "s|^MALWARE_SCANNER_API_KEY=.*|MALWARE_SCANNER_API_KEY=$(secret)|" \
    -e "s|^MALWARE_SCANNER_ALLOWED_HOSTS=.*|MALWARE_SCANNER_ALLOWED_HOSTS=scanner.invalid|" \
    -e "s|^POSTGRES_MIGRATION_PASSWORD=.*|POSTGRES_MIGRATION_PASSWORD=$(secret)|" \
    -e "s|^POSTGRES_RUNTIME_PASSWORD=.*|POSTGRES_RUNTIME_PASSWORD=$(secret)|" \
    -e "s|^POSTGRES_BACKUP_PASSWORD=.*|POSTGRES_BACKUP_PASSWORD=$(secret)|" \
    -e "s|^OFFSITE_RCLONE_REMOTE=.*|OFFSITE_RCLONE_REMOTE=:local:/offsite-destination|" \
    -e "s|^OFFSITE_RCLONE_CONFIG=.*|OFFSITE_RCLONE_CONFIG=$ROOT_DIR/deploy/backup/rclone.conf.example|" \
    -e "s|^OFFSITE_SHIP_INTERVAL_SECONDS=.*|OFFSITE_SHIP_INTERVAL_SECONDS=$SHIP_INTERVAL|" \
    "$ROOT_DIR/.env.production.example" > "$env_file"
echo "DRILL_PORT=$PORT" >> "$env_file"
chmod 600 "$env_file"
# shellcheck disable=SC1090
pg_user="$(sed -n 's/^POSTGRES_USER=//p' "$env_file")"; pg_db="$(sed -n 's/^POSTGRES_DB=//p' "$env_file")"
archive_timeout="$(sed -n 's/^WAL_ARCHIVE_TIMEOUT_SECONDS=//p' "$env_file")"

step "subindo postgres, migrate, backup e offsite (projeto $PROJECT)"
"${DC[@]}" up -d postgres migrate backup offsite >&2
postgres_container="$("${DC[@]}" ps -q postgres)"
offsite_container="$("${DC[@]}" ps -q offsite)"
psql_main() { docker exec "$postgres_container" psql -U "$pg_user" -d "$pg_db" -v ON_ERROR_STOP=1 -Atq "$@"; }

wait_for() { # description, timeout, command...
  local description="$1" limit="$2"; shift 2
  local until=$(( $(date +%s) + limit ))
  until "$@" >/dev/null 2>&1; do
    (( $(date +%s) < until )) || { echo "tempo esgotado esperando: $description" >&2; "${DC[@]}" logs --tail 40 >&2 || true; exit 1; }
    sleep 2
  done
}
migrate_done() { [[ "$(docker inspect -f '{{.State.ExitCode}}' "$("${DC[@]}" ps -aq migrate)" 2>/dev/null)" == "0" && "$(docker inspect -f '{{.State.Status}}' "$("${DC[@]}" ps -aq migrate)")" == "exited" ]]; }
wait_for "migrate concluído" 600 migrate_done
wait_for "primeiro backup base" 180 "${DC[@]}" exec -T backup sh -c 'ls /backups/base/*Z/base.tar.gz'
step "pilha pronta; backup base inicial presente"

backup_role="$(psql_main -c "SELECT rolreplication AND NOT rolsuper FROM pg_roles WHERE rolname = 'cvg_backup'")"
[[ "$backup_role" == "t" ]] || { echo "papel cvg_backup ausente ou incorreto" >&2; exit 1; }

# (b) markers. m1/m2 precede the target, m3/m4 follow it.
psql_main -c "CREATE TABLE drill_markers (id serial PRIMARY KEY, label text NOT NULL, written_at timestamptz NOT NULL DEFAULT clock_timestamp())" \
  -c "CREATE TABLE drill_bulk (id integer PRIMARY KEY, payload text NOT NULL)" >/dev/null
psql_main -c "INSERT INTO drill_bulk SELECT g, md5(g::text) || md5((g * 7)::text) FROM generate_series(1, $ROW_COUNT) g" >/dev/null
psql_main -c "INSERT INTO drill_markers (label) VALUES ('m1')" >/dev/null; sleep 2
psql_main -c "INSERT INTO drill_markers (label) VALUES ('m2')" >/dev/null; sleep 2
target_time="$(psql_main -c "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')")"
sleep 2
psql_main -c "INSERT INTO drill_markers (label) VALUES ('m3')" >/dev/null; sleep 1
psql_main -c "INSERT INTO drill_markers (label) VALUES ('m4')" >/dev/null
step "marcadores escritos; alvo $target_time"

# (c) close the current segment and wait until it is archived and shipped.
switched="$(psql_main -c "SELECT pg_walfile_name(pg_switch_wal())")"
archived() { [[ "$(psql_main -c "SELECT COALESCE(last_archived_wal >= '$switched', false) FROM pg_stat_archiver")" == "t" ]]; }
wait_for "segmento $switched arquivado" 120 archived
last_archived_time="$(psql_main -c "SELECT to_char(last_archived_time AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') FROM pg_stat_archiver")"
archived_epoch="$(date -u -d "$last_archived_time" +%s)"
shipped() { # lastShippedEpoch strictly after the archive time
  local epoch; epoch="$(docker exec "$offsite_container" sed -n 's/.*"lastShippedEpoch":\([0-9]*\).*/\1/p' /backups/offsite-status.json 2>/dev/null)"
  [[ -n "$epoch" ]] && (( epoch > archived_epoch )) && docker exec "$offsite_container" test -f "/offsite-destination/wal/$switched"
}
wait_for "cópia externa de $switched" $(( SHIP_INTERVAL * 6 + 60 )) shipped
shipped_epoch="$(docker exec "$offsite_container" sed -n 's/.*"lastShippedEpoch":\([0-9]*\).*/\1/p' /backups/offsite-status.json)"
step "WAL $switched arquivado e copiado para fora"
docker exec "$offsite_container" sh /opt/backup/check-offsite.sh >&2

# (d) restore from the off-site copy, never from the live volumes.
mkdir -p "$work_dir/offsite"
docker cp "$offsite_container:/offsite-destination/." "$work_dir/offsite" >&2
wal_count="$(ls "$work_dir/offsite/wal" | grep -cE '^[0-9A-F]{24}$' || true)"
base_dir="$(ls -1d "$work_dir"/offsite/dumps/base/[0-9]*Z | sort | tail -1)"
base_bytes="$(stat -c %s "$base_dir/base.tar.gz")"
db_bytes="$(psql_main -c "SELECT pg_database_size('$pg_db')")"
chmod -R a+rX "$work_dir/offsite"

step "restaurando para $target_time"
restore_json="$(bash "$ROOT_DIR/scripts/restore-pitr.sh" --base "$base_dir" --wal "$work_dir/offsite/wal" --target-time "$target_time" \
  --data "$work_dir/data-pitr" --port $((PORT + 1)) --user "$pg_user" --name "${restore_names[0]}")"
echo "$restore_json" >&2
rto_seconds="$(sed -n 's/.*"elapsedSeconds":\([0-9]*\).*/\1/p' <<<"$restore_json")"
restored_psql() { docker exec "$1" psql -U "$pg_user" -d "$pg_db" -Atq -c "$2"; }
labels="$(restored_psql "${restore_names[0]}" "SELECT string_agg(label, ',' ORDER BY id) FROM drill_markers")"
bulk_rows="$(restored_psql "${restore_names[0]}" "SELECT count(*) FROM drill_bulk")"
[[ "$labels" == "m1,m2" ]] || { echo "FALHA: marcadores restaurados '$labels', esperado 'm1,m2'" >&2; exit 1; }
[[ "$bulk_rows" == "$ROW_COUNT" ]] || { echo "FALHA: $bulk_rows linhas em drill_bulk, esperado $ROW_COUNT" >&2; exit 1; }
step "PITR verificado: marcadores $labels, $bulk_rows linhas"

step "restaurando até o fim do arquivo (--latest)"
latest_json="$(bash "$ROOT_DIR/scripts/restore-pitr.sh" --base "$base_dir" --wal "$work_dir/offsite/wal" --latest \
  --data "$work_dir/data-latest" --port $((PORT + 2)) --user "$pg_user" --name "${restore_names[1]}")"
echo "$latest_json" >&2
latest_labels="$(restored_psql "${restore_names[1]}" "SELECT string_agg(label, ',' ORDER BY id) FROM drill_markers")"
[[ "$latest_labels" == "m1,m2,m3,m4" ]] || { echo "FALHA: marcadores com --latest '$latest_labels', esperado 'm1,m2,m3,m4'" >&2; exit 1; }
latest_seconds="$(sed -n 's/.*"elapsedSeconds":\([0-9]*\).*/\1/p' <<<"$latest_json")"

target_epoch="$(date -u -d "$target_time" +%s)"
printf '{"event":"drill.completed","date":"%s","targetTime":"%s","markersAtTarget":"%s","markersLatest":"%s","rto":{"restoreSeconds":%s,"restoreLatestSeconds":%s,"budgetSeconds":14400},"rpo":{"targetToLastArchivedSeconds":%s,"archiveToOffsiteSeconds":%s,"nominalSeconds":%s,"budgetSeconds":900},"data":{"databaseBytes":%s,"baseBackupBytes":%s,"walSegmentsRestored":%s},"drillWallClockSeconds":%s}\n' \
  "$(date -u +%Y-%m-%d)" "$target_time" "$labels" "$latest_labels" "$rto_seconds" "$latest_seconds" \
  "$(( archived_epoch - target_epoch ))" "$(( shipped_epoch - archived_epoch ))" "$(( archive_timeout + SHIP_INTERVAL ))" \
  "$db_bytes" "$base_bytes" "$wal_count" "$(( $(date +%s) - drill_started ))"
