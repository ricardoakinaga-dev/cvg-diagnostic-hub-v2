#!/bin/sh
# Scheduled backups of the application database. Two artifacts per cycle:
#   1. a logical dump (pg_dump, custom format) taken as the RUNTIME role, which can read every table;
#   2. a physical base backup (pg_basebackup, tar+gzip) taken as the dedicated cvg_backup role, which holds REPLICATION
#      (the runtime role must never have it). The base backup plus the WAL archive written by archive-wal.sh is what
#      point-in-time recovery needs (scripts/restore-pitr.sh).
# Retention prunes both, and never deletes WAL that the oldest retained base backup still needs.
#
# Same host as the database: deploy/backup/ship-offsite.sh copies /backups and /wal-archive out of the building.
# docs/operations/BACKUP_RESTORE.md has the restore procedures.
set -eu
# Backups hold clinical data and credential hashes: owner-only files.
umask 077

# PROD-302: PGPASSWORD_FILE / PGBACKUP_PASSWORD_FILE (Docker secrets) win over the variables; both set with different
# values is refused, like src/server/security/file-secrets.ts.
# BACKUP_HELPERS_DIR: where secrets-env.sh lives (/opt/backup in the containers; the tests point it at deploy/backup).
. "${BACKUP_HELPERS_DIR:-/opt/backup}/secrets-env.sh"
load_file_secrets PGPASSWORD PGBACKUP_PASSWORD

: "${PGHOST:?}" "${PGUSER:?}" "${PGPASSWORD:?}" "${PGDATABASE:?}"
INTERVAL="${BACKUP_INTERVAL_SECONDS:-86400}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
DIRECTORY="${BACKUP_DIRECTORY:-/backups}"
WAL_DIRECTORY="${WAL_ARCHIVE_DIRECTORY:-/wal-archive}"
BASE_DIRECTORY="$DIRECTORY/base"
mkdir -p "$DIRECTORY" "$BASE_DIRECTORY"

dump_once() {
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  target="$DIRECTORY/cvg-$stamp.dump"
  if pg_dump --format=custom --no-owner --no-privileges --file="$target.partial" && pg_restore --list "$target.partial" >/dev/null; then
    mv "$target.partial" "$target"
    echo "{\"event\":\"backup.completed\",\"file\":\"$(basename "$target")\",\"bytes\":$(wc -c < "$target")}"
  else
    rm -f "$target.partial"
    echo "{\"event\":\"backup.failed\"}" >&2
    return 1
  fi
}

# Skipped (not failed) while POSTGRES_BACKUP_PASSWORD is unset: installations without WAL archiving keep the dump only.
base_once() {
  if [ -z "${PGBACKUP_PASSWORD:-}" ]; then
    echo "{\"event\":\"basebackup.disabled\",\"reason\":\"POSTGRES_BACKUP_PASSWORD not set\"}"
    return 0
  fi
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  target="$BASE_DIRECTORY/$stamp"
  # --wal-method=none: the continuous archive supplies the WAL; pg_basebackup waits until the segment that ends the
  # backup is archived, so a successful exit means the backup is restorable from the archive alone.
  if PGUSER="${PGBACKUP_USER:-cvg_backup}" PGPASSWORD="$PGBACKUP_PASSWORD" PGDATABASE=postgres \
      pg_basebackup -D "$target.partial" --format=tar --gzip --checkpoint=fast --wal-method=none --no-password \
    && [ -s "$target.partial/base.tar.gz" ] && gzip -t "$target.partial/base.tar.gz"; then
    mv "$target.partial" "$target"
    echo "{\"event\":\"basebackup.completed\",\"directory\":\"base/$stamp\",\"bytes\":$(du -sk "$target" | cut -f1)000}"
  else
    rm -rf "$target.partial"
    echo "{\"event\":\"basebackup.failed\"}" >&2
    return 1
  fi
}

# First WAL file a base backup needs, read from the backup_label inside base.tar.gz ("... (file 00000001000000000000000A)").
base_start_wal() {
  tar -xzOf "$1/base.tar.gz" backup_label 2>/dev/null | sed -n 's/^START WAL LOCATION: .*(file \([0-9A-F]\{24\}\)).*/\1/p' | head -1
}

prune() {
  find "$DIRECTORY" -maxdepth 1 -name 'cvg-*.dump' -mtime +"$RETENTION_DAYS" -delete
  # Base backups older than the retention window go, but the newest one always stays.
  newest="$(ls -1d "$BASE_DIRECTORY"/[0-9]*Z 2>/dev/null | sort | tail -1 || true)"
  for old in $(find "$BASE_DIRECTORY" -mindepth 1 -maxdepth 1 -type d -name '[0-9]*Z' -mtime +"$RETENTION_DAYS" 2>/dev/null); do
    [ "$old" = "$newest" ] || rm -rf "$old"
  done
  find "$BASE_DIRECTORY" -mindepth 1 -maxdepth 1 -name '*.partial' -mtime +1 -exec rm -rf {} + 2>/dev/null || true
  # WAL older than the oldest retained base backup is useless: nothing can start from it. With no base backup yet, keep all.
  oldest="$(ls -1d "$BASE_DIRECTORY"/[0-9]*Z 2>/dev/null | sort | head -1 || true)"
  [ -n "$oldest" ] || return 0
  boundary="$(base_start_wal "$oldest")"
  if [ -z "$boundary" ]; then
    echo "{\"event\":\"wal.prune_skipped\",\"reason\":\"backup_label unreadable\"}" >&2
    return 0
  fi
  removed=0
  for segment in $(ls -1 "$WAL_DIRECTORY" 2>/dev/null | grep -E '^[0-9A-F]{24}$' || true); do
    # Same timeline prefix sorts lexicographically; a smaller name is older.
    if [ "$segment" \< "$boundary" ]; then rm -f "$WAL_DIRECTORY/$segment"; removed=$((removed + 1)); fi
  done
  echo "{\"event\":\"wal.pruned\",\"boundary\":\"$boundary\",\"removed\":$removed}"
}

backup_once() {
  status=0
  dump_once || status=1
  base_once || status=1
  prune || status=1
  return "$status"
}

# Tests source this file to exercise prune() without a database.
[ "${BACKUP_LOOP_SOURCE_ONLY:-}" != "1" ] || return 0
if [ "${1:-}" = "--once" ]; then backup_once; exit $?; fi
# A failed cycle is retried after RETRY seconds (at most 15 min), not after a whole day.
RETRY="$INTERVAL"
[ "$RETRY" -le 900 ] || RETRY=900
while true; do
  if backup_once; then sleep "$INTERVAL"; else sleep "$RETRY"; fi
done
