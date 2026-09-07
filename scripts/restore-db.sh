#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL é obrigatório}"
: "${ALLOW_DB_RESTORE:?Defina ALLOW_DB_RESTORE=true para confirmar a restauração}"
if [[ "$ALLOW_DB_RESTORE" != "true" ]]; then
  echo "Restauração bloqueada: ALLOW_DB_RESTORE precisa ser true." >&2
  exit 1
fi
restore_file="${1:?Informe o caminho do arquivo .dump}"
if [[ ! -f "$restore_file" ]]; then
  echo "Backup não encontrado: $restore_file" >&2
  exit 1
fi
manifest_file="${BACKUP_MANIFEST:-${restore_file}.manifest.json}"
if [[ ! -f "$manifest_file" ]]; then
  echo "Restauração bloqueada: manifesto de recuperação não encontrado: $manifest_file" >&2
  exit 1
fi
artifact_root="$(cd "$(dirname "$restore_file")" && pwd)"
npx --no-install tsx scripts/recovery-manifest.ts verify --manifest "$manifest_file" --artifact-root "$artifact_root" --database-artifact "$restore_file"
pg_restore --clean --if-exists --no-owner --dbname "$DATABASE_URL" "$restore_file"
echo "Backup restaurado. A verificação de checksum do manifesto passou; execute npm run db:migrate e valide a aplicação em alvo isolado. Isto não prova restauração de anexos, chaves, semântica clínica ou RPO/RTO."
