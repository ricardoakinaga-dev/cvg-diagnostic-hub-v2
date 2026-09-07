#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL é obrigatório}"
backup_dir="${BACKUP_DIR:-backups}"
mkdir -p "$backup_dir"
backup_file="${1:-$backup_dir/cvg-$(date -u +%Y%m%dT%H%M%SZ).dump}"
pg_dump --format=custom --no-owner --file "$backup_file" "$DATABASE_URL"
manifest_file="${BACKUP_MANIFEST:-${backup_file}.manifest.json}"
manifest_args=(--manifest "$manifest_file" --database-artifact "$backup_file")
if [[ -n "${BACKUP_OBJECT_MANIFEST:-}" ]]; then
  manifest_args+=(--object-manifest "$BACKUP_OBJECT_MANIFEST")
fi
if [[ -n "${BACKUP_CONFIG_REF_NAMES:-}" ]]; then
  manifest_args+=(--config-names "$BACKUP_CONFIG_REF_NAMES")
fi
if [[ -n "${BACKUP_MANIFEST_ID:-}" ]]; then
  manifest_args+=(--id "$BACKUP_MANIFEST_ID")
fi
npx --no-install tsx scripts/recovery-manifest.ts create "${manifest_args[@]}"
echo "Backup PostgreSQL criado em $backup_file; manifesto de recuperação em $manifest_file"
