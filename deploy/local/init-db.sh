#!/bin/sh
set -eu

# Runs only when this stack's private PostgreSQL volume is empty.
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=ON_ERROR_STOP=1 \
  --set=migrator_password="$POSTGRES_MIGRATION_PASSWORD" \
  --set=runtime_password="$POSTGRES_RUNTIME_PASSWORD" \
  --set=database_name="$POSTGRES_DB" <<'SQL'
CREATE ROLE cvg_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'migrator_password';
CREATE ROLE cvg_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'runtime_password';
ALTER DATABASE :"database_name" OWNER TO cvg_migrator;
ALTER SCHEMA public OWNER TO cvg_migrator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO cvg_runtime;
SQL
