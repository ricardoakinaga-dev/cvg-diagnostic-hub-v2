#!/bin/sh
# Test probe for deploy/backup/secrets-env.sh (scripts/backup-wal.test.mjs). Sources the helper from BACKUP_HELPERS_DIR,
# runs one function and prints the resulting environment, so the tests never build a shell command from a path.
#   secrets-env-probe.sh configure            -> configure_offsite_crypt, then the RCLONE_CONFIG_OFFSITECRYPT_* variables
#   secrets-env-probe.sh load NAME...         -> load_file_secrets NAME..., then the PG*/OFFSITE* variables
#   secrets-env-probe.sh backup-loop          -> sources backup-loop.sh (BACKUP_LOOP_SOURCE_ONLY=1), then the PG* variables
set -eu
. "${BACKUP_HELPERS_DIR:?BACKUP_HELPERS_DIR is required}/secrets-env.sh"
mode="$1"; shift
case "$mode" in
  configure) configure_offsite_crypt; env | grep '^RCLONE_CONFIG_OFFSITECRYPT_' | sort ;;
  load) load_file_secrets "$@"; env | grep -E '^(PG|OFFSITE)' | sort ;;
  backup-loop) . "$BACKUP_HELPERS_DIR/backup-loop.sh"; env | grep '^PG' | sort ;;
  *) echo "unknown mode: $mode" >&2; exit 2 ;;
esac
