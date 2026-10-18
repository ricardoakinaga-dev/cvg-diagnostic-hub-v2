-- Run with psql -X -v ON_ERROR_STOP=1 as the database administrator on the Hub database.
-- No credentials here: provision the password separately with psql \password.
-- Refuse existing authority instead of silently repurposing a privileged account.
BEGIN;
DO $monitor$
DECLARE monitor_oid oid;
BEGIN
  SELECT oid INTO monitor_oid FROM pg_roles WHERE rolname = 'cvg_pg_exporter';
  IF monitor_oid IS NULL THEN
    CREATE ROLE cvg_pg_exporter LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD NULL;
    SELECT oid INTO monitor_oid FROM pg_roles WHERE rolname = 'cvg_pg_exporter';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE oid = monitor_oid AND
      (rolsuper OR rolinherit OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR NOT rolcanlogin)) OR
     EXISTS (SELECT 1 FROM pg_auth_members WHERE member = monitor_oid OR roleid = monitor_oid) THEN
    RAISE EXCEPTION 'cvg_pg_exporter must be an isolated unprivileged login without role memberships';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_toast' AND
      (c.relowner = monitor_oid OR
        (c.relkind IN ('r','p','v','m','f') AND
          (has_table_privilege(monitor_oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
           has_any_column_privilege(monitor_oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))) OR
        (c.relkind = 'S' AND has_sequence_privilege(monitor_oid,c.oid,'USAGE,SELECT,UPDATE')))) OR
     EXISTS (SELECT 1 FROM pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema') AND nspname !~ '^pg_' AND
      (nspowner = monitor_oid OR has_schema_privilege(monitor_oid,oid,'CREATE'))) OR
     EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND (p.proowner = monitor_oid OR
        (p.prosecdef AND has_function_privilege(monitor_oid,p.oid,'EXECUTE')))) OR
     EXISTS (SELECT 1 FROM pg_database WHERE datdba = monitor_oid OR has_database_privilege(monitor_oid,oid,'CREATE')) THEN
    RAISE EXCEPTION 'cvg_pg_exporter has application authority (including PUBLIC grants); revoke it before provisioning';
  END IF;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO cvg_pg_exporter', current_database());
END
$monitor$;
ALTER ROLE cvg_pg_exporter SET default_transaction_read_only = on;
ALTER ROLE cvg_pg_exporter SET search_path = pg_catalog;
ALTER ROLE cvg_pg_exporter SET statement_timeout = '5s';
ALTER ROLE cvg_pg_exporter CONNECTION LIMIT 3;
COMMIT;
