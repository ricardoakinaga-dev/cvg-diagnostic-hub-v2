#!/bin/sh
# Ships the WAL archive and the backups out of the building with rclone (PROD-304). Opt-in: with
# OFFSITE_RCLONE_REMOTE empty it logs offsite.disabled and sleeps, so the stack starts without a destination.
#
#   OFFSITE_RCLONE_REMOTE   remote and path, e.g. s3:cvg-offsite/hospital-a or sftp:/backups (defined in rclone.conf)
#   RCLONE_CONFIG           rclone config file (mounted read-only)
#
# WAL goes with `copy`: WAL files are immutable and a base backup is useless without them, so a local pruning mistake
# must never reach the remote. Retention of remote WAL belongs to the destination (lifecycle rule) or to the operator.
# Dumps and base backups go with `sync`, so the remote follows the local retention; --max-delete caps how much a single
# run may remove, which turns an accidentally empty /backups into a failed run instead of an empty remote.
# Every cycle rewrites offsite-status.json; check-offsite.sh reads it.
set -eu
umask 077

REMOTE="${OFFSITE_RCLONE_REMOTE:-}"
INTERVAL="${OFFSITE_SHIP_INTERVAL_SECONDS:-300}"
WAL_DIRECTORY="${WAL_ARCHIVE_DIRECTORY:-/wal-archive}"
BACKUP_DIRECTORY="${BACKUP_DIRECTORY:-/backups}"
STATUS_FILE="${OFFSITE_STATUS_FILE:-$BACKUP_DIRECTORY/offsite-status.json}"
MAX_DELETE="${OFFSITE_MAX_DELETE:-20}"
REMOTE="${REMOTE%/}"

write_status() {
  # $1 result, $2 last success epoch (0 = never), $3 walSegments, $4 bytes
  shipped_at="1970-01-01T00:00:00Z"
  if [ "$2" -gt 0 ]; then shipped_at="$(date -u -d "@$2" +%Y-%m-%dT%H:%M:%SZ)"; fi
  printf '{"lastShippedAt":"%s","lastShippedEpoch":%s,"lastAttemptAt":"%s","lastResult":"%s","walSegments":%s,"bytes":%s}\n' \
    "$shipped_at" "$2" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$3" "$4" > "$STATUS_FILE.tmp"
  mv "$STATUS_FILE.tmp" "$STATUS_FILE"
}

previous_success() {
  [ -f "$STATUS_FILE" ] || { echo 0; return; }
  value="$(sed -n 's/.*"lastShippedEpoch":\([0-9]*\).*/\1/p' "$STATUS_FILE" | head -1)"
  echo "${value:-0}"
}

ship_once() {
  wal_count="$(ls -1 "$WAL_DIRECTORY" 2>/dev/null | grep -cE '^[0-9A-F]{24}$' || true)"
  bytes="$(( ( $(du -sk "$WAL_DIRECTORY" "$BACKUP_DIRECTORY" 2>/dev/null | cut -f1 | paste -sd+ - | sed 's/^$/0/') ) * 1024 ))"
  last_ok="$(previous_success)"
  if rclone copy "$WAL_DIRECTORY" "$REMOTE/wal" --exclude '.*.tmp' --ignore-existing --log-level ERROR \
    && rclone sync "$BACKUP_DIRECTORY" "$REMOTE/dumps" --exclude 'offsite-status.json*' --exclude '*.partial/**' --exclude '*.partial' \
      --max-delete "$MAX_DELETE" --log-level ERROR; then
    write_status ok "$(date +%s)" "$wal_count" "$bytes"
    echo "{\"event\":\"offsite.shipped\",\"walSegments\":$wal_count,\"bytes\":$bytes}"
  else
    write_status error "$last_ok" "$wal_count" "$bytes"
    echo "{\"event\":\"offsite.failed\",\"walSegments\":$wal_count}" >&2
    return 1
  fi
}

if [ -z "$REMOTE" ]; then
  echo "{\"event\":\"offsite.disabled\",\"reason\":\"OFFSITE_RCLONE_REMOTE not set\"}"
  mkdir -p "$BACKUP_DIRECTORY"
  write_status disabled 0 0 0 2>/dev/null || true
  [ "${1:-}" = "--once" ] && exit 0
  while true; do sleep 3600; done
fi

if [ "${1:-}" = "--once" ]; then ship_once; exit $?; fi
while true; do
  ship_once || true
  sleep "$INTERVAL"
done
