#!/bin/sh
# Health check for the off-site copy (PROD-304): exits non-zero when the last SUCCESSFUL shipment is older than
# 3 x OFFSITE_SHIP_INTERVAL_SECONDS, or when the status file is missing/unreadable.
# Used as the Compose healthcheck of the `offsite` service and by hand / cron on the host:
#   docker compose -f docker-compose.prod.yml --env-file .env.production exec offsite sh /opt/backup/check-offsite.sh
# Disabled destinations (OFFSITE_RCLONE_REMOTE empty) are healthy: the feature is opt-in.
# NOW_EPOCH and OFFSITE_STATUS_FILE can be overridden (tests).
set -eu

STATUS_FILE="${1:-${OFFSITE_STATUS_FILE:-/backups/offsite-status.json}}"
INTERVAL="${OFFSITE_SHIP_INTERVAL_SECONDS:-300}"
NOW="${NOW_EPOCH:-$(date +%s)}"

if [ -z "${OFFSITE_RCLONE_REMOTE:-}" ] && [ -z "${OFFSITE_CHECK_FORCE:-}" ]; then
  echo '{"event":"offsite.check","result":"disabled"}'
  exit 0
fi
if [ ! -f "$STATUS_FILE" ]; then
  echo '{"event":"offsite.check","result":"fail","reason":"status file missing"}' >&2
  exit 1
fi
last="$(sed -n 's/.*"lastShippedEpoch":\([0-9][0-9]*\).*/\1/p' "$STATUS_FILE" | head -1)"
if [ -z "$last" ]; then
  echo '{"event":"offsite.check","result":"fail","reason":"status file unreadable"}' >&2
  exit 1
fi
age=$((NOW - last))
limit=$((INTERVAL * 3))
if [ "$last" -le 0 ] || [ "$age" -gt "$limit" ]; then
  echo "{\"event\":\"offsite.check\",\"result\":\"fail\",\"reason\":\"stale\",\"ageSeconds\":$age,\"limitSeconds\":$limit}" >&2
  exit 1
fi
echo "{\"event\":\"offsite.check\",\"result\":\"ok\",\"ageSeconds\":$age,\"limitSeconds\":$limit}"
