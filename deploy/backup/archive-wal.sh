#!/bin/sh
# PostgreSQL archive_command (PROD-304): archive-wal.sh %p %f
#   %p = path of the finished WAL segment (relative to PGDATA), %f = its file name.
# PostgreSQL deletes the segment only when this exits 0, so every doubt is a non-zero exit and a retry.
# The copy is atomic: written under a temp name in the same directory, flushed, then renamed, so the shipper
# (rclone) and a restore never see half a segment.
set -eu
umask 077

source_path="${1:?uso: archive-wal.sh <caminho-do-segmento> <nome-do-segmento>}"
name="${2:?uso: archive-wal.sh <caminho-do-segmento> <nome-do-segmento>}"
archive="${WAL_ARCHIVE_DIRECTORY:-/wal-archive}"
target="$archive/$name"
partial="$archive/.$name.$$.tmp"

[ -f "$source_path" ] || { echo "{\"event\":\"wal.archive_failed\",\"file\":\"$name\",\"reason\":\"source_missing\"}" >&2; exit 1; }
[ -d "$archive" ] || { echo "{\"event\":\"wal.archive_failed\",\"file\":\"$name\",\"reason\":\"archive_missing\"}" >&2; exit 1; }

# Never overwrite: an existing identical segment means a previous attempt crashed after the rename, which is success;
# a different one means two clusters share the archive, which must stop the archiver loudly.
if [ -f "$target" ]; then
  if cmp -s "$source_path" "$target"; then exit 0; fi
  echo "{\"event\":\"wal.archive_failed\",\"file\":\"$name\",\"reason\":\"different_segment_exists\"}" >&2
  exit 1
fi

trap 'rm -f "$partial"' EXIT
if cp "$source_path" "$partial" && sync && mv "$partial" "$target"; then
  exit 0
fi
echo "{\"event\":\"wal.archive_failed\",\"file\":\"$name\",\"reason\":\"copy_failed\"}" >&2
exit 1
