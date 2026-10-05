#!/bin/sh
# Scheduled logical backup of the application database (custom format, restorable with pg_restore).
# Runs as the RUNTIME role, which can read every table: no administrative credential lives in this container.
#
# This is a safety net on the same host, not disaster recovery: copy /backups off the machine
# (docs/operations/BACKUP_RESTORE.md) and rehearse a restore. Point-in-time recovery needs WAL archiving or a
# managed database (decision D2/D11).
set -eu

: "${PGHOST:?}" "${PGUSER:?}" "${PGPASSWORD:?}" "${PGDATABASE:?}"
INTERVAL="${BACKUP_INTERVAL_SECONDS:-86400}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
DIRECTORY="${BACKUP_DIRECTORY:-/backups}"
mkdir -p "$DIRECTORY"

backup_once() {
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
  find "$DIRECTORY" -name 'cvg-*.dump' -mtime +"$RETENTION_DAYS" -delete
}

if [ "${1:-}" = "--once" ]; then backup_once; exit $?; fi
while true; do
  backup_once || true
  sleep "$INTERVAL"
done
