#!/bin/sh
# Entrypoint of the storage-restore service (and of any manual rclone run that needs the secrets): loads the *_FILE
# secrets the rclone remotes use, defines the offsitecrypt remote, then runs rclone with the given arguments.
#   docker compose ... --profile restore run --rm storage-restore copy offsitecrypt:objects minio:<bucket> --ignore-existing
set -eu
. /opt/backup/secrets-env.sh
load_file_secrets RCLONE_CONFIG_MINIO_SECRET_ACCESS_KEY
configure_offsite_crypt
exec rclone "$@"
