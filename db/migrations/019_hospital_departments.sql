-- Coordinated cutover: stop app and worker before expanding StoreState.
-- Preserve referenced codes and clinical history; no clinical grants are added.
CREATE OR REPLACE FUNCTION cvg_runtime_entity_collections() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['users', 'sessions', 'patients', 'encounters', 'admissions', 'services', 'reasonCodes',
    'requests', 'items', 'samples', 'procedures', 'schedules', 'results', 'resultVersions',
    'notifications', 'idempotency', 'attachments', 'departments']::text[]
$$;

CREATE UNIQUE INDEX cvg_departments_code_unique ON cvg_runtime_entities ((data->>'code'))
  WHERE collection = 'departments';

DO $$
DECLARE
  current_version bigint;
  sector_count integer;
BEGIN
  SELECT version INTO current_version FROM cvg_runtime_state WHERE id = 1 FOR UPDATE;
  IF current_version IS NOT NULL THEN
    WITH existing AS (
      SELECT collection, data FROM cvg_runtime_entities
      UNION ALL SELECT collection, data FROM cvg_clinical_archive
    ), codes AS (
      SELECT data->>'departmentCode' AS code FROM existing WHERE collection IN ('users', 'services', 'items', 'admissions')
      UNION SELECT data->>'requestingDepartmentCode' FROM existing WHERE collection = 'requests'
      UNION SELECT jsonb_array_elements_text(COALESCE(data->'managedDepartmentCodes', '[]'::jsonb)) FROM existing WHERE collection = 'users'
    ), canonical AS (
      SELECT DISTINCT code FROM codes WHERE code IS NOT NULL AND code <> ''
    )
    INSERT INTO cvg_runtime_entities(collection, entity_key, position, data, written_version)
    SELECT 'departments', 'department-' || code, row_number() OVER (ORDER BY code),
      jsonb_build_object('id', 'department-' || code, 'code', code, 'name',
        CASE code WHEN 'INPATIENT' THEN 'Internação' WHEN 'LABORATORY' THEN 'Laboratório'
        WHEN 'RADIOLOGY' THEN 'Radiologia' WHEN 'ULTRASOUND' THEN 'Ultrassom'
        WHEN 'IT' THEN 'Administração técnica' ELSE code END,
        'type', CASE WHEN code = 'IT' THEN 'ADMINISTRATIVE' WHEN code IN ('LABORATORY','RADIOLOGY','ULTRASOUND') THEN 'DIAGNOSTIC' ELSE 'CLINICAL' END,
        'memberUserIds', COALESCE((SELECT jsonb_agg(data->>'id' ORDER BY position) FROM cvg_runtime_entities
          WHERE collection = 'users' AND data->>'departmentCode' = code AND data->>'active' = 'true'), '[]'::jsonb),
        'active', true, 'version', 1, 'createdAt', to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'updatedAt', to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
      current_version + 1 FROM canonical;
    GET DIAGNOSTICS sector_count = ROW_COUNT;
    UPDATE cvg_runtime_state SET state = cvg_runtime_state_header(state), version = current_version + 1, updated_at = now() WHERE id = 1;
    INSERT INTO audit_events(id, event_type, entity_type, entity_id, correlation_id, metadata, occurred_at)
    VALUES ('audit-migration-019', 'HospitalDepartmentsMigrated', 'SchemaMigration', '019_hospital_departments',
      'corr-migration-019', jsonb_build_object('departmentCount', sector_count, 'clinicalGrantsChanged', false), CURRENT_TIMESTAMP);
  END IF;
END $$;

ALTER TABLE cvg_runtime_state ADD CONSTRAINT runtime_departments_are_external
  CHECK (COALESCE(state->'departments' = '[]'::jsonb, false));
UPDATE relational_schema_markers SET schema_version = '019_hospital_departments'
  WHERE marker_key = 'RELATIONAL_CLINICAL_CORE_EXPAND_V1';
