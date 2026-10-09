#!/bin/sh
# Ships the WAL archive and the backups out of the building with rclone (PROD-304). Opt-in: with
# OFFSITE_RCLONE_REMOTE empty it logs offsite.disabled and sleeps, so the stack starts without a destination.
#
#   OFFSITE_RCLONE_REMOTE   remote and path, e.g. s3:cvg-offsite/hospital-a or sftp:/backups (defined in rclone.conf)
#   OFFSITE_BUCKET_SOURCE   optional (PROD-514, on-prem MinIO): rclone path of the attachments bucket, e.g. minio:cvg-attachments;
#                           its objects go to <remote>/objects with the same write-once rule. Empty = PostgreSQL artifacts only.
#   RCLONE_CONFIG           rclone config file (mounted read-only)
#
# NOTHING in this script deletes or overwrites on the remote: WAL, dumps and base backups all go with `rclone copy
# --ignore-existing`. The artifacts are write-once (a dump is renamed from .partial only after pg_restore --list, a base
# backup lives in a stamped directory), so a file that changed in place locally (for example encrypted by ransomware,
# same name, fresh mtime) never replaces the good copy on the remote. A local pruning
# mistake, an empty volume or a wrong mount can therefore never reach the destination (AUD-04: `sync --max-delete`
# emptied the remote from an empty /backups and eroded it across cycles). On top of that a cycle is REFUSED
# (status error, event offsite.refused) when /backups holds no valid recent backup: a non-empty cvg-*.dump or
# base/<stamp>/base.tar.gz (never one still in a .partial directory) whose newest mtime is at most OFFSITE_MAX_BACKUP_AGE_SECONDS old (default 2 x
# BACKUP_INTERVAL_SECONDS). WAL is copied first and also in a refused cycle (immutable, never harmful).
# The bucket copy (OFFSITE_BUCKET_SOURCE) follows the same rule: `rclone copy --ignore-existing`, so an object deleted
# or re-encrypted at the source never removes or replaces the copy; the cycle is refused (bucket source unreachable)
# when the source bucket cannot be listed, which is what a wrong bucket name, a dead MinIO or a revoked credential look like.
# Retention of the remote belongs to the destination (lifecycle rule) or to a separate operator step.
# Every cycle rewrites offsite-status.json; check-offsite.sh reads it.
set -eu
umask 077

# PROD-302 / D-051: secrets from files and the encrypted destination. The `offsitecrypt` remote (type crypt) wraps
# OFFSITE_CRYPT_REMOTE; a destination that is not a crypt remote is refused unless OFFSITE_ALLOW_PLAINTEXT=true
# (a decision of the hospital recorded in D-051: destination with its own encryption and restricted access).
. "${BACKUP_HELPERS_DIR:-$(dirname "$0")}/secrets-env.sh"
load_file_secrets RCLONE_CONFIG_MINIO_SECRET_ACCESS_KEY
configure_offsite_crypt

REMOTE="${OFFSITE_RCLONE_REMOTE:-}"
INTERVAL="${OFFSITE_SHIP_INTERVAL_SECONDS:-300}"
WAL_DIRECTORY="${WAL_ARCHIVE_DIRECTORY:-/wal-archive}"
BACKUP_DIRECTORY="${BACKUP_DIRECTORY:-/backups}"
STATUS_FILE="${OFFSITE_STATUS_FILE:-$BACKUP_DIRECTORY/offsite-status.json}"
BACKUP_INTERVAL="${BACKUP_INTERVAL_SECONDS:-86400}"
MAX_BACKUP_AGE="${OFFSITE_MAX_BACKUP_AGE_SECONDS:-$((BACKUP_INTERVAL * 2))}"
REMOTE="${REMOTE%/}"
BUCKET_SOURCE="${OFFSITE_BUCKET_SOURCE:-}"
BUCKET_SOURCE="${BUCKET_SOURCE%/}"

OBJECTS=0

write_status() {
  # $1 result, $2 last success epoch (0 = never), $3 walSegments, $4 bytes, $5 optional refusal reason
  shipped_at="1970-01-01T00:00:00Z"
  if [ "$2" -gt 0 ]; then shipped_at="$(date -u -d "@$2" +%Y-%m-%dT%H:%M:%SZ)"; fi
  reason=""
  if [ -n "${5:-}" ]; then reason=",\"reason\":\"$5\""; fi
  printf '{"lastShippedAt":"%s","lastShippedEpoch":%s,"lastAttemptAt":"%s","lastResult":"%s","walSegments":%s,"bytes":%s,"objects":%s%s}\n' \
    "$shipped_at" "$2" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$3" "$4" "$OBJECTS" "$reason" > "$STATUS_FILE.tmp"
  mv "$STATUS_FILE.tmp" "$STATUS_FILE"
}

previous_success() {
  [ -f "$STATUS_FILE" ] || { echo 0; return; }
  value="$(sed -n 's/.*"lastShippedEpoch":\([0-9]*\).*/\1/p' "$STATUS_FILE" | head -1)"
  echo "${value:-0}"
}

# Prints the newest mtime (epoch) among valid backup artifacts; prints 0 when there is none. Only finished artifacts
# count, the same set the copy below ships: a base backup still being written lives in base/<stamp>.partial/ (renamed
# after gzip -t) and a dump in progress is cvg-<stamp>.dump.partial, so neither can make a cycle look fresh (REM-02).
newest_backup_epoch() {
  newest=0
  for artifact in "$BACKUP_DIRECTORY"/cvg-*.dump "$BACKUP_DIRECTORY"/base/*/base.tar.gz; do
    case "$artifact" in *.partial/*) continue ;; esac
    [ -f "$artifact" ] && [ -s "$artifact" ] || continue
    mtime="$(stat -c %Y "$artifact" 2>/dev/null || echo 0)"
    if [ "$mtime" -gt "$newest" ]; then newest="$mtime"; fi
  done
  echo "$newest"
}

# Sets REFUSAL to the reason when /backups cannot be shipped; leaves it empty otherwise.
check_backups() {
  REFUSAL=""
  if [ ! -d "$BACKUP_DIRECTORY" ]; then REFUSAL="backup directory missing"; return; fi
  newest="$(newest_backup_epoch)"
  if [ "$newest" -le 0 ]; then REFUSAL="no valid backup (cvg-*.dump or base/*/base.tar.gz) in backup directory"; return; fi
  age=$(( $(date +%s) - newest ))
  if [ "$age" -gt "$MAX_BACKUP_AGE" ]; then
    REFUSAL="newest backup is $age s old (limit $MAX_BACKUP_AGE s)"
  fi
}

# Sets OBJECTS to the object count of the source bucket and BUCKET_REFUSAL when it cannot be listed.
check_bucket() {
  BUCKET_REFUSAL=""
  OBJECTS=0
  [ -n "$BUCKET_SOURCE" ] || return 0
  size_json="$(rclone size "$BUCKET_SOURCE" --json --exclude '.cvg-bucket-probe/**' --log-level ERROR 2>/dev/null)" || { BUCKET_REFUSAL="bucket source unreachable ($BUCKET_SOURCE)"; return 0; }
  OBJECTS="$(printf '%s' "$size_json" | sed -n 's/.*"count":\([0-9]*\).*/\1/p' | head -1)"
  OBJECTS="${OBJECTS:-0}"
}

ship_once() {
  wal_count="$(ls -1 "$WAL_DIRECTORY" 2>/dev/null | grep -cE '^[0-9A-F]{24}$' || true)"
  bytes="$(( ( $(du -sk "$WAL_DIRECTORY" "$BACKUP_DIRECTORY" 2>/dev/null | cut -f1 | paste -sd+ - | sed 's/^$/0/') ) * 1024 ))"
  last_ok="$(previous_success)"
  wal_ok=0
  rclone copy "$WAL_DIRECTORY" "$REMOTE/wal" --exclude '.*.tmp' --ignore-existing --log-level ERROR && wal_ok=1
  check_backups
  check_bucket
  if [ -n "$REFUSAL" ] || [ -n "$BUCKET_REFUSAL" ]; then
    cycle_reason="$REFUSAL"
    if [ -n "$BUCKET_REFUSAL" ]; then
      # The PostgreSQL artifacts are still shipped (write-once, never harmful); the cycle is not a success.
      if [ -z "$REFUSAL" ] && [ "$wal_ok" = 1 ]; then
        rclone copy "$BACKUP_DIRECTORY" "$REMOTE/dumps" --exclude 'offsite-status.json*' --exclude '*.partial/**' --exclude '*.partial' \
          --ignore-existing --log-level ERROR || true
      fi
      cycle_reason="${cycle_reason:+$cycle_reason; }$BUCKET_REFUSAL"
    fi
    write_status error "$last_ok" "$wal_count" "$bytes" "$cycle_reason"
    printf '{"event":"offsite.refused","reason":"%s","walSegments":%s}\n' "$cycle_reason" "$wal_count" >&2
    return 1
  fi
  bucket_ok=1
  if [ -n "$BUCKET_SOURCE" ]; then
    rclone copy "$BUCKET_SOURCE" "$REMOTE/objects" --exclude '.cvg-bucket-probe/**' --ignore-existing --log-level ERROR || bucket_ok=0
  fi
  if [ "$wal_ok" = 1 ] && [ "$bucket_ok" = 1 ] \
    && rclone copy "$BACKUP_DIRECTORY" "$REMOTE/dumps" --exclude 'offsite-status.json*' --exclude '*.partial/**' --exclude '*.partial' \
      --ignore-existing --log-level ERROR; then
    write_status ok "$(date +%s)" "$wal_count" "$bytes"
    echo "{\"event\":\"offsite.shipped\",\"walSegments\":$wal_count,\"bytes\":$bytes,\"objects\":$OBJECTS}"
  else
    write_status error "$last_ok" "$wal_count" "$bytes"
    echo "{\"event\":\"offsite.failed\",\"walSegments\":$wal_count,\"objects\":$OBJECTS}" >&2
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

# Health data leaves the building only encrypted (D-051): the destination must be a crypt remote.
case "$REMOTE" in
  :*) DESTINATION_TYPE="connection-string" ;;
  *) DESTINATION_TYPE="$(remote_type "${REMOTE%%:*}")" ;;
esac
if [ "$DESTINATION_TYPE" != "crypt" ] && [ "${OFFSITE_ALLOW_PLAINTEXT:-false}" != "true" ]; then
  mkdir -p "$BACKUP_DIRECTORY"
  write_status error "$(previous_success)" 0 0 "destination is not a crypt remote (type $DESTINATION_TYPE); set OFFSITE_ALLOW_PLAINTEXT=true only by decision of the hospital (D-051)" 2>/dev/null || true
  echo "{\"event\":\"offsite.refused\",\"reason\":\"destination is not a crypt remote (type $DESTINATION_TYPE)\"}" >&2
  [ "${1:-}" = "--once" ] && exit 1
  while true; do sleep 3600; done
fi

if [ "${1:-}" = "--once" ]; then ship_once; exit $?; fi
while true; do
  ship_once || true
  sleep "$INTERVAL"
done
