#!/bin/sh
# Wrapper around the official entrypoint (PROD-304). A new named volume is root-owned, so the archive directory
# is prepared here, as root, before the image drops to the postgres user.
set -eu
mkdir -p "${WAL_ARCHIVE_DIRECTORY:-/wal-archive}"
chown postgres:postgres "${WAL_ARCHIVE_DIRECTORY:-/wal-archive}"
chmod 700 "${WAL_ARCHIVE_DIRECTORY:-/wal-archive}"
exec docker-entrypoint.sh "$@"
