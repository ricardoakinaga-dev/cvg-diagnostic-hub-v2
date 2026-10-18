-- Coordinated cutover: stop app and worker before expanding StoreState.
-- Diagnostic services remain in their existing authority; no duplicate catalog is created.
CREATE OR REPLACE FUNCTION cvg_runtime_entity_collections() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 SELECT ARRAY['users','sessions','patients','encounters','admissions','services','reasonCodes',
  'requests','items','samples','procedures','schedules','results','resultVersions','notifications',
  'idempotency','attachments','departments','accessGroups','patientGrants','examDefinitions','hospitalServices']::text[]
$$;
CREATE UNIQUE INDEX cvg_hospital_services_code_unique ON cvg_runtime_entities ((data->>'code')) WHERE collection='hospitalServices';
DO $$
DECLARE current_version bigint;
BEGIN
 SELECT version INTO current_version FROM cvg_runtime_state WHERE id=1 FOR UPDATE;
 IF current_version IS NOT NULL THEN
  UPDATE cvg_runtime_state SET state=cvg_runtime_state_header(state),version=current_version+1,updated_at=now() WHERE id=1;
  INSERT INTO audit_events(id,event_type,entity_type,entity_id,correlation_id,metadata,occurred_at)
   VALUES('audit-migration-022','HospitalServicesEnabled','SchemaMigration','022_hospital_services','corr-migration-022',
    jsonb_build_object('servicesFabricated',false,'diagnosticAuthorityPreserved',true,'clinicalScopeChanged',false),CURRENT_TIMESTAMP);
 END IF;
END $$;
ALTER TABLE cvg_runtime_state ADD CONSTRAINT runtime_hospital_services_are_external CHECK(COALESCE(state->'hospitalServices'='[]'::jsonb,false));
UPDATE relational_schema_markers SET schema_version='022_hospital_services' WHERE marker_key='RELATIONAL_CLINICAL_CORE_EXPAND_V1';
