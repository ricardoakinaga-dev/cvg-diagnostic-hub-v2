#!/usr/bin/env bash
set -euo pipefail

: "${ALLOW_DB_RESTORE_SMOKE:?Defina ALLOW_DB_RESTORE_SMOKE=true para confirmar o smoke de restore}"
if [[ "$ALLOW_DB_RESTORE_SMOKE" != "true" ]]; then
  echo "Restore smoke bloqueado: ALLOW_DB_RESTORE_SMOKE precisa ser true." >&2
  exit 1
fi

compose_service="${POSTGRES_SERVICE:-postgres}"
db_user="${POSTGRES_USER:-cvg}"
source_db="${POSTGRES_DB:-cvg_diagnostics}"
smoke_db="cvg_restore_smoke_${BASHPID}"
direct_url="${POSTGRES_DIRECT_URL:-}"
pg_dump_bin="${PG_DUMP_BIN:-pg_dump}"
pg_restore_bin="${PG_RESTORE_BIN:-pg_restore}"
psql_bin="${PSQL_BIN:-psql}"
temp_dir="$(mktemp -d -t cvg-restore-smoke.XXXXXX)"
dump_file="$temp_dir/source.dump"

database_url_for() {
  node - "$1" "$2" <<'NODE'
const [rawUrl, databaseName] = process.argv.slice(2);
const parsed = new URL(rawUrl);
parsed.pathname = `/${databaseName}`;
process.stdout.write(parsed.toString());
NODE
}

cleanup() {
  if [[ -n "$direct_url" ]]; then
    "$psql_bin" "$direct_url" -v ON_ERROR_STOP=1 -X -q -c "DROP DATABASE IF EXISTS \"$smoke_db\"" >/dev/null 2>&1 || true
  else
    docker compose exec -T "$compose_service" dropdb --if-exists -U "$db_user" "$smoke_db" >/dev/null 2>&1 || true
  fi
  rm -f "$dump_file"
  rmdir "$temp_dir" 2>/dev/null || true
}
trap cleanup EXIT

if [[ -n "$direct_url" ]]; then
  smoke_url="$(database_url_for "$direct_url" "$smoke_db")"
  "$psql_bin" "$direct_url" -v ON_ERROR_STOP=1 -X -q -c "CREATE DATABASE \"$smoke_db\""
  "$pg_dump_bin" --format=custom --no-owner --file "$dump_file" "$direct_url"
else
  smoke_url=""
  docker compose exec -T "$compose_service" pg_dump --format=custom --no-owner -U "$db_user" -d "$source_db" > "$dump_file"
fi
npx --no-install tsx scripts/recovery-manifest.ts create --manifest "$dump_file.manifest.json" --database-artifact "$dump_file" --id "restore-smoke-${BASHPID}"
npx --no-install tsx scripts/recovery-manifest.ts verify --manifest "$dump_file.manifest.json" --artifact-root "$temp_dir"
if [[ -n "$direct_url" ]]; then
  "$pg_restore_bin" --exit-on-error --no-owner --dbname "$smoke_url" "$dump_file"
else
  docker compose exec -T "$compose_service" createdb -U "$db_user" "$smoke_db"
  docker compose exec -T "$compose_service" pg_restore --exit-on-error --no-owner -U "$db_user" -d "$smoke_db" < "$dump_file"
fi

if [[ -n "$direct_url" ]]; then
  result="$($psql_bin "$smoke_url" -At -v ON_ERROR_STOP=1 -X -c "SELECT (SELECT count(*) FROM cvg_runtime_state), (SELECT count(*) FROM audit_events), (SELECT count(*) FROM outbox_messages), (SELECT count(*) FROM cvg_runtime_entities WHERE collection = 'users');")"
else
  result="$(docker compose exec -T "$compose_service" psql -At -v ON_ERROR_STOP=1 -U "$db_user" -d "$smoke_db" -c "SELECT (SELECT count(*) FROM cvg_runtime_state), (SELECT count(*) FROM audit_events), (SELECT count(*) FROM outbox_messages), (SELECT count(*) FROM cvg_runtime_entities WHERE collection = 'users');")"
fi
# The runtime row plus its entity rows (015): an initialized state has at least one user.
if [[ ! "$result" =~ ^1\|[0-9]+\|[0-9]+\|[1-9][0-9]*$ ]]; then
  echo "Restore smoke falhou: resultado inesperado '$result'." >&2
  exit 1
fi
if [[ -n "$direct_url" ]]; then
  echo "Backup/restore smoke PostgreSQL direto passou em alvo descartável: $smoke_db ($result). Manifesto/checksum verificados; inventário de object storage está NOT_CAPTURED e a recuperação completa AAA2-045 permanece pendente."
else
  echo "Backup/restore smoke de banco passou em alvo descartável: $smoke_db ($result). Manifesto/checksum verificados; inventário de object storage está NOT_CAPTURED e a recuperação completa AAA2-045 permanece pendente."
fi
