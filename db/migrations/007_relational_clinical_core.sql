-- AAA-W1-SCHEMA-EXPAND / RELATIONAL_CLINICAL_CORE_EXPAND_V1
-- This migration is executed inside BEGIN/COMMIT by src/server/store/migrations.ts.
-- It is additive: it creates empty relational structures and does not copy or
-- rewrite the cvg_runtime_state snapshot. The runtime boundary therefore stays
-- TRANSITIONAL until a later dual-read/backfill/cutover task.
--
-- StoreState currently uses text identifiers (including identifiers containing
-- hyphens). All identifiers in this expand schema are text as well. Department
-- IDs are intended to carry the existing stable department code so the future
-- adapter can map departmentCode without an identifier conversion.
--
-- Critical-result configuration is deliberately opaque and versioned. This
-- migration inserts no clinical catalog or policy rows and defines no clinical
-- interpretation values.

CREATE TABLE IF NOT EXISTS relational_schema_markers (
  marker_key text PRIMARY KEY,
  schema_version text NOT NULL,
  installed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT relational_schema_markers_key_nonempty CHECK (btrim(marker_key) <> ''),
  CONSTRAINT relational_schema_markers_version_nonempty CHECK (btrim(schema_version) <> '')
);

INSERT INTO relational_schema_markers (marker_key, schema_version)
VALUES ('RELATIONAL_CLINICAL_CORE_EXPAND_V1', '007_relational_clinical_core')
ON CONFLICT (marker_key) DO UPDATE
SET schema_version = EXCLUDED.schema_version;

COMMENT ON TABLE relational_schema_markers IS 'RELATIONAL_CLINICAL_CORE_EXPAND_V1 control marker for the additive relational clinical core; it does not change runtime authority.';

CREATE TABLE IF NOT EXISTS departments (
  id text PRIMARY KEY,
  code text NOT NULL,
  name text NOT NULL,
  kind text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT departments_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT departments_code_nonempty CHECK (btrim(code) <> ''),
  CONSTRAINT departments_name_nonempty CHECK (btrim(name) <> ''),
  CONSTRAINT departments_kind_nonempty CHECK (btrim(kind) <> ''),
  CONSTRAINT departments_version_positive CHECK (version > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS departments_code_normalized_uidx
  ON departments (lower(btrim(code)));

CREATE TABLE IF NOT EXISTS roles (
  id text PRIMARY KEY,
  code text NOT NULL,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT roles_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT roles_code_nonempty CHECK (btrim(code) <> ''),
  CONSTRAINT roles_name_nonempty CHECK (btrim(name) <> ''),
  CONSTRAINT roles_version_positive CHECK (version > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS roles_code_normalized_uidx
  ON roles (lower(btrim(code)));

CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  email text NOT NULL,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  timezone text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT users_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT users_email_nonempty CHECK (btrim(email) <> ''),
  CONSTRAINT users_display_name_nonempty CHECK (btrim(display_name) <> ''),
  CONSTRAINT users_password_hash_nonempty CHECK (btrim(password_hash) <> ''),
  CONSTRAINT users_timezone_nonempty CHECK (btrim(timezone) <> ''),
  CONSTRAINT users_version_positive CHECK (version > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_normalized_uidx
  ON users (lower(btrim(email)));

CREATE TABLE IF NOT EXISTS user_roles (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  role_id text NOT NULL,
  department_id text,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT user_roles_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT user_roles_valid_range CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT user_roles_version_positive CHECK (version > 0),
  CONSTRAINT user_roles_user_fk FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT user_roles_role_fk FOREIGN KEY (role_id) REFERENCES roles (id),
  CONSTRAINT user_roles_department_fk FOREIGN KEY (department_id) REFERENCES departments (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS user_roles_active_assignment_uidx
  ON user_roles (user_id, role_id, COALESCE(department_id, ''))
  WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS user_roles_department_active_idx
  ON user_roles (department_id, valid_to, user_id);

CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  token_hash text NOT NULL,
  csrf_token_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  reauthenticated_at timestamptz,
  last_seen_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT sessions_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT sessions_token_hash_nonempty CHECK (btrim(token_hash) <> ''),
  CONSTRAINT sessions_csrf_hash_nonempty CHECK (btrim(csrf_token_hash) <> ''),
  CONSTRAINT sessions_expiry_after_creation CHECK (expires_at > created_at),
  CONSTRAINT sessions_version_positive CHECK (version > 0),
  CONSTRAINT sessions_user_fk FOREIGN KEY (user_id) REFERENCES users (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_token_hash_uidx ON sessions (token_hash);
CREATE INDEX IF NOT EXISTS sessions_user_active_idx
  ON sessions (user_id, revoked_at, expires_at);

CREATE TABLE IF NOT EXISTS auth_identities (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  provider text NOT NULL,
  subject text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT auth_identities_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT auth_identities_provider_nonempty CHECK (btrim(provider) <> ''),
  CONSTRAINT auth_identities_subject_nonempty CHECK (btrim(subject) <> ''),
  CONSTRAINT auth_identities_provider_subject_key UNIQUE (provider, subject),
  CONSTRAINT auth_identities_version_positive CHECK (version > 0),
  CONSTRAINT auth_identities_user_fk FOREIGN KEY (user_id) REFERENCES users (id)
);
CREATE INDEX IF NOT EXISTS auth_identities_user_idx ON auth_identities (user_id, provider);

CREATE TABLE IF NOT EXISTS owners (
  id text PRIMARY KEY,
  display_name text NOT NULL,
  privacy_flags jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT owners_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT owners_display_name_nonempty CHECK (btrim(display_name) <> ''),
  CONSTRAINT owners_version_positive CHECK (version > 0)
);
CREATE INDEX IF NOT EXISTS owners_display_name_normalized_idx
  ON owners (lower(btrim(display_name)));

CREATE TABLE IF NOT EXISTS patients (
  id text PRIMARY KEY,
  display_name text NOT NULL,
  species text NOT NULL,
  breed text NOT NULL,
  sex text NOT NULL,
  birth_date date,
  birth_date_approx boolean NOT NULL DEFAULT false,
  external_id text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT patients_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT patients_display_name_nonempty CHECK (btrim(display_name) <> ''),
  CONSTRAINT patients_species_nonempty CHECK (btrim(species) <> ''),
  CONSTRAINT patients_breed_nonempty CHECK (btrim(breed) <> ''),
  CONSTRAINT patients_sex_nonempty CHECK (btrim(sex) <> ''),
  CONSTRAINT patients_external_id_nonempty CHECK (external_id IS NULL OR btrim(external_id) <> ''),
  CONSTRAINT patients_version_positive CHECK (version > 0)
);
CREATE INDEX IF NOT EXISTS patients_display_name_species_idx
  ON patients (lower(btrim(display_name)), lower(btrim(species)));
CREATE INDEX IF NOT EXISTS patients_external_id_idx ON patients (external_id) WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS patient_owners (
  id text PRIMARY KEY,
  patient_id text NOT NULL,
  owner_id text NOT NULL,
  relation text NOT NULL,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT patient_owners_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT patient_owners_relation_nonempty CHECK (btrim(relation) <> ''),
  CONSTRAINT patient_owners_valid_range CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT patient_owners_version_positive CHECK (version > 0),
  CONSTRAINT patient_owners_patient_fk FOREIGN KEY (patient_id) REFERENCES patients (id),
  CONSTRAINT patient_owners_owner_fk FOREIGN KEY (owner_id) REFERENCES owners (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS patient_owners_current_uidx
  ON patient_owners (patient_id, owner_id, relation)
  WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS patient_owners_patient_current_idx
  ON patient_owners (patient_id, valid_to, owner_id);

CREATE TABLE IF NOT EXISTS external_references (
  id text PRIMARY KEY,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  source_system text NOT NULL,
  external_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT external_references_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT external_references_entity_type_nonempty CHECK (btrim(entity_type) <> ''),
  CONSTRAINT external_references_entity_id_nonempty CHECK (btrim(entity_id) <> ''),
  CONSTRAINT external_references_source_nonempty CHECK (btrim(source_system) <> ''),
  CONSTRAINT external_references_external_id_nonempty CHECK (btrim(external_id) <> ''),
  CONSTRAINT external_references_source_entity_key UNIQUE (source_system, entity_type, external_id)
);
CREATE INDEX IF NOT EXISTS external_references_entity_idx
  ON external_references (entity_type, entity_id);

CREATE TABLE IF NOT EXISTS encounters (
  id text PRIMARY KEY,
  patient_id text NOT NULL,
  source_system text,
  external_id text,
  type text NOT NULL,
  status text NOT NULL,
  opened_at timestamptz NOT NULL,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT encounters_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT encounters_type_check CHECK (type IN ('INPATIENT', 'EMERGENCY', 'OUTPATIENT')),
  CONSTRAINT encounters_status_check CHECK (status IN ('OPEN', 'CLOSED')),
  CONSTRAINT encounters_time_range CHECK (closed_at IS NULL OR closed_at >= opened_at),
  CONSTRAINT encounters_version_positive CHECK (version > 0),
  CONSTRAINT encounters_id_patient_key UNIQUE (id, patient_id),
  CONSTRAINT encounters_patient_fk FOREIGN KEY (patient_id) REFERENCES patients (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS encounters_external_reference_uidx
  ON encounters (source_system, external_id)
  WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS encounters_patient_status_idx
  ON encounters (patient_id, status, opened_at DESC);

CREATE TABLE IF NOT EXISTS admissions (
  id text PRIMARY KEY,
  encounter_id text NOT NULL,
  department_id text NOT NULL,
  ward text NOT NULL,
  bed text NOT NULL,
  admitted_at timestamptz NOT NULL,
  discharged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT admissions_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT admissions_ward_nonempty CHECK (btrim(ward) <> ''),
  CONSTRAINT admissions_bed_nonempty CHECK (btrim(bed) <> ''),
  CONSTRAINT admissions_time_range CHECK (discharged_at IS NULL OR discharged_at >= admitted_at),
  CONSTRAINT admissions_version_positive CHECK (version > 0),
  CONSTRAINT admissions_id_encounter_key UNIQUE (id, encounter_id),
  CONSTRAINT admissions_encounter_fk FOREIGN KEY (encounter_id) REFERENCES encounters (id),
  CONSTRAINT admissions_department_fk FOREIGN KEY (department_id) REFERENCES departments (id)
);
CREATE INDEX IF NOT EXISTS admissions_encounter_active_idx
  ON admissions (encounter_id, discharged_at, admitted_at DESC);
CREATE INDEX IF NOT EXISTS admissions_department_active_idx
  ON admissions (department_id, discharged_at, admitted_at DESC);

CREATE TABLE IF NOT EXISTS diagnostic_services (
  id text PRIMARY KEY,
  code text NOT NULL,
  name text NOT NULL,
  category text NOT NULL,
  department_id text NOT NULL,
  workflow_type text NOT NULL,
  requires_sample boolean NOT NULL DEFAULT false,
  requires_schedule boolean NOT NULL DEFAULT false,
  allows_attachment boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  result_schema text NOT NULL,
  result_template jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT diagnostic_services_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT diagnostic_services_code_nonempty CHECK (btrim(code) <> ''),
  CONSTRAINT diagnostic_services_name_nonempty CHECK (btrim(name) <> ''),
  CONSTRAINT diagnostic_services_category_check CHECK (category IN ('LABORATORY', 'IMAGING')),
  CONSTRAINT diagnostic_services_workflow_check CHECK (workflow_type IN ('LABORATORY', 'RADIOLOGY', 'ULTRASOUND')),
  CONSTRAINT diagnostic_services_result_schema_check CHECK (result_schema IN ('NUMERIC_PANEL', 'NARRATIVE')),
  CONSTRAINT diagnostic_services_version_positive CHECK (version > 0),
  CONSTRAINT diagnostic_services_code_key UNIQUE (code),
  CONSTRAINT diagnostic_services_department_fk FOREIGN KEY (department_id) REFERENCES departments (id)
);
CREATE INDEX IF NOT EXISTS diagnostic_services_active_scope_idx
  ON diagnostic_services (department_id, workflow_type, active, code);

CREATE TABLE IF NOT EXISTS service_instructions (
  id text PRIMARY KEY,
  service_id text NOT NULL,
  version integer NOT NULL,
  instruction text NOT NULL,
  active_from timestamptz,
  active_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_instructions_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT service_instructions_version_positive CHECK (version > 0),
  CONSTRAINT service_instructions_text_nonempty CHECK (btrim(instruction) <> ''),
  CONSTRAINT service_instructions_time_range CHECK (active_to IS NULL OR active_from IS NULL OR active_to > active_from),
  CONSTRAINT service_instructions_service_version_key UNIQUE (service_id, version),
  CONSTRAINT service_instructions_service_fk FOREIGN KEY (service_id) REFERENCES diagnostic_services (id)
);
CREATE INDEX IF NOT EXISTS service_instructions_active_idx
  ON service_instructions (service_id, active_from, active_to);

CREATE TABLE IF NOT EXISTS sla_policies (
  id text PRIMARY KEY,
  service_id text NOT NULL,
  priority text NOT NULL,
  calendar_code text NOT NULL,
  start_event text NOT NULL,
  duration interval NOT NULL,
  effective_from timestamptz,
  effective_to timestamptz,
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sla_policies_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT sla_policies_priority_check CHECK (priority IN ('ROUTINE', 'URGENT', 'EMERGENCY')),
  CONSTRAINT sla_policies_calendar_nonempty CHECK (btrim(calendar_code) <> ''),
  CONSTRAINT sla_policies_start_event_nonempty CHECK (btrim(start_event) <> ''),
  CONSTRAINT sla_policies_time_range CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to > effective_from),
  CONSTRAINT sla_policies_version_positive CHECK (version > 0),
  CONSTRAINT sla_policies_service_priority_version_key UNIQUE (service_id, priority, version),
  CONSTRAINT sla_policies_service_fk FOREIGN KEY (service_id) REFERENCES diagnostic_services (id)
);
CREATE INDEX IF NOT EXISTS sla_policies_active_scope_idx
  ON sla_policies (service_id, priority, active, effective_from);

CREATE TABLE IF NOT EXISTS critical_result_policies (
  id text PRIMARY KEY,
  service_id text,
  policy_reference text NOT NULL,
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  recipient_rule jsonb NOT NULL DEFAULT '{}'::jsonb,
  acknowledgement_deadline interval,
  escalation_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  approval_reference text,
  approved_at timestamptz,
  approved_by text,
  active boolean NOT NULL DEFAULT false,
  version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT critical_result_policies_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT critical_result_policies_reference_nonempty CHECK (btrim(policy_reference) <> ''),
  CONSTRAINT critical_result_policies_version_positive CHECK (version > 0),
  CONSTRAINT critical_result_policies_approval_pair CHECK ((approved_at IS NULL) = (approved_by IS NULL)),
  CONSTRAINT critical_result_policies_service_fk FOREIGN KEY (service_id) REFERENCES diagnostic_services (id),
  CONSTRAINT critical_result_policies_approved_by_fk FOREIGN KEY (approved_by) REFERENCES users (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS critical_result_policies_scope_version_uidx
  ON critical_result_policies (COALESCE(service_id, ''), version);
CREATE INDEX IF NOT EXISTS critical_result_policies_active_scope_idx
  ON critical_result_policies (service_id, active, version DESC);

CREATE TABLE IF NOT EXISTS reason_codes (
  id text PRIMARY KEY,
  type text NOT NULL,
  code text NOT NULL,
  label text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT reason_codes_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT reason_codes_type_check CHECK (type IN ('RECOLLECTION', 'CANCEL', 'REJECT', 'AMEND')),
  CONSTRAINT reason_codes_code_nonempty CHECK (btrim(code) <> ''),
  CONSTRAINT reason_codes_label_nonempty CHECK (btrim(label) <> ''),
  CONSTRAINT reason_codes_version_positive CHECK (version > 0),
  CONSTRAINT reason_codes_type_code_key UNIQUE (type, code)
);
CREATE INDEX IF NOT EXISTS reason_codes_active_type_idx ON reason_codes (type, active, code);

CREATE TABLE IF NOT EXISTS request_code_sequences (
  local_date date PRIMARY KEY,
  next_value bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT request_code_sequences_next_value_valid CHECK (next_value >= 0)
);

CREATE TABLE IF NOT EXISTS diagnostic_requests (
  id text PRIMARY KEY,
  request_code varchar(20) NOT NULL,
  patient_id text NOT NULL,
  encounter_id text NOT NULL,
  admission_id text,
  requester_id text NOT NULL,
  requesting_department_id text NOT NULL,
  priority text NOT NULL,
  aggregate_status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT diagnostic_requests_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT diagnostic_requests_code_nonempty CHECK (btrim(request_code) <> ''),
  CONSTRAINT diagnostic_requests_priority_check CHECK (priority IN ('ROUTINE', 'URGENT', 'EMERGENCY')),
  CONSTRAINT diagnostic_requests_status_check CHECK (aggregate_status IN ('REQUESTED', 'IN_PROGRESS', 'PARTIALLY_AVAILABLE', 'RESULTS_AVAILABLE', 'COMPLETED', 'CANCELLED')),
  CONSTRAINT diagnostic_requests_version_positive CHECK (version > 0),
  CONSTRAINT diagnostic_requests_request_code_key UNIQUE (request_code),
  CONSTRAINT diagnostic_requests_patient_fk FOREIGN KEY (patient_id) REFERENCES patients (id),
  CONSTRAINT diagnostic_requests_encounter_patient_fk FOREIGN KEY (encounter_id, patient_id) REFERENCES encounters (id, patient_id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT diagnostic_requests_admission_encounter_fk FOREIGN KEY (admission_id, encounter_id) REFERENCES admissions (id, encounter_id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT diagnostic_requests_requester_fk FOREIGN KEY (requester_id) REFERENCES users (id),
  CONSTRAINT diagnostic_requests_department_fk FOREIGN KEY (requesting_department_id) REFERENCES departments (id)
);
CREATE INDEX IF NOT EXISTS diagnostic_requests_patient_created_idx
  ON diagnostic_requests (patient_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS diagnostic_requests_encounter_created_idx
  ON diagnostic_requests (encounter_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS diagnostic_requests_status_created_idx
  ON diagnostic_requests (aggregate_status, created_at DESC, id);
CREATE INDEX IF NOT EXISTS diagnostic_requests_department_status_idx
  ON diagnostic_requests (requesting_department_id, aggregate_status, created_at DESC);

CREATE TABLE IF NOT EXISTS diagnostic_request_items (
  id text PRIMARY KEY,
  request_id text NOT NULL,
  service_id text NOT NULL,
  department_id text NOT NULL,
  workflow_type text NOT NULL,
  priority text NOT NULL,
  status text NOT NULL,
  note text,
  requested_at timestamptz NOT NULL,
  received_at timestamptz,
  started_at timestamptz,
  performed_at timestamptz,
  released_at timestamptz,
  reviewed_at timestamptz,
  completed_at timestamptz,
  sla_started_at timestamptz NOT NULL,
  due_at timestamptz NOT NULL,
  sla_policy_version integer NOT NULL,
  cancellation_reason_id text,
  rejection_reason_id text,
  current_result_id text,
  current_sample_id text,
  procedure_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT diagnostic_request_items_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT diagnostic_request_items_workflow_check CHECK (workflow_type IN ('LABORATORY', 'RADIOLOGY', 'ULTRASOUND')),
  CONSTRAINT diagnostic_request_items_priority_check CHECK (priority IN ('ROUTINE', 'URGENT', 'EMERGENCY')),
  CONSTRAINT diagnostic_request_items_status_check CHECK (status IN ('REQUESTED', 'RECEIVED', 'SCHEDULED', 'IN_PROGRESS', 'AWAITING_REPORT', 'RESULT_AVAILABLE', 'REVIEWED', 'COMPLETED', 'RECOLLECTION_REQUIRED', 'FAILED', 'CANCELLED', 'REJECTED', 'RESULT_VOIDED')),
  CONSTRAINT diagnostic_request_items_sla_range CHECK (due_at >= sla_started_at),
  CONSTRAINT diagnostic_request_items_sla_version_positive CHECK (sla_policy_version > 0),
  CONSTRAINT diagnostic_request_items_version_positive CHECK (version > 0),
  CONSTRAINT diagnostic_request_items_id_request_key UNIQUE (id, request_id),
  CONSTRAINT diagnostic_request_items_request_fk FOREIGN KEY (request_id) REFERENCES diagnostic_requests (id),
  CONSTRAINT diagnostic_request_items_service_fk FOREIGN KEY (service_id) REFERENCES diagnostic_services (id),
  CONSTRAINT diagnostic_request_items_department_fk FOREIGN KEY (department_id) REFERENCES departments (id),
  CONSTRAINT diagnostic_request_items_cancellation_reason_fk FOREIGN KEY (cancellation_reason_id) REFERENCES reason_codes (id),
  CONSTRAINT diagnostic_request_items_rejection_reason_fk FOREIGN KEY (rejection_reason_id) REFERENCES reason_codes (id)
);
CREATE INDEX IF NOT EXISTS diagnostic_request_items_queue_idx
  ON diagnostic_request_items (department_id, status, priority, due_at, created_at);
CREATE INDEX IF NOT EXISTS diagnostic_request_items_request_idx
  ON diagnostic_request_items (request_id, id);
CREATE INDEX IF NOT EXISTS diagnostic_request_items_service_status_idx
  ON diagnostic_request_items (service_id, status, due_at);

CREATE TABLE IF NOT EXISTS samples (
  id text PRIMARY KEY,
  request_id text NOT NULL,
  accession_code text NOT NULL,
  sample_type text NOT NULL,
  status text NOT NULL,
  replaces_sample_id text,
  rejection_reason_id text,
  rejection_note text,
  collected_at timestamptz,
  received_at timestamptz,
  received_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT samples_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT samples_accession_nonempty CHECK (btrim(accession_code) <> ''),
  CONSTRAINT samples_type_nonempty CHECK (btrim(sample_type) <> ''),
  CONSTRAINT samples_status_check CHECK (status IN ('EXPECTED', 'RECEIVED', 'REJECTED', 'REPLACED')),
  CONSTRAINT samples_rejection_reason_required CHECK (status <> 'REJECTED' OR rejection_reason_id IS NOT NULL),
  CONSTRAINT samples_version_positive CHECK (version > 0),
  CONSTRAINT samples_accession_code_key UNIQUE (accession_code),
  CONSTRAINT samples_id_request_key UNIQUE (id, request_id),
  CONSTRAINT samples_request_fk FOREIGN KEY (request_id) REFERENCES diagnostic_requests (id),
  CONSTRAINT samples_replaces_same_request_fk FOREIGN KEY (replaces_sample_id, request_id) REFERENCES samples (id, request_id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT samples_rejection_reason_fk FOREIGN KEY (rejection_reason_id) REFERENCES reason_codes (id),
  CONSTRAINT samples_received_by_fk FOREIGN KEY (received_by) REFERENCES users (id)
);
CREATE INDEX IF NOT EXISTS samples_request_status_idx ON samples (request_id, status, created_at);
CREATE INDEX IF NOT EXISTS samples_replacement_lineage_idx ON samples (replaces_sample_id, created_at);

CREATE TABLE IF NOT EXISTS sample_item_links (
  id text PRIMARY KEY,
  sample_id text NOT NULL,
  item_id text NOT NULL,
  request_id text NOT NULL,
  link_status text NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT now(),
  linked_by text,
  rejection_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT sample_item_links_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT sample_item_links_status_nonempty CHECK (btrim(link_status) <> ''),
  CONSTRAINT sample_item_links_version_positive CHECK (version > 0),
  CONSTRAINT sample_item_links_sample_request_fk FOREIGN KEY (sample_id, request_id) REFERENCES samples (id, request_id),
  CONSTRAINT sample_item_links_item_request_fk FOREIGN KEY (item_id, request_id) REFERENCES diagnostic_request_items (id, request_id),
  CONSTRAINT sample_item_links_linked_by_fk FOREIGN KEY (linked_by) REFERENCES users (id),
  CONSTRAINT sample_item_links_sample_item_key UNIQUE (sample_id, item_id)
);
CREATE INDEX IF NOT EXISTS sample_item_links_item_idx ON sample_item_links (item_id, linked_at);
CREATE INDEX IF NOT EXISTS sample_item_links_request_idx ON sample_item_links (request_id, linked_at);

CREATE TABLE IF NOT EXISTS procedures (
  id text PRIMARY KEY,
  item_id text NOT NULL,
  workflow_type text NOT NULL,
  status text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  performed_at timestamptz,
  performed_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT procedures_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT procedures_workflow_check CHECK (workflow_type IN ('RADIOLOGY', 'ULTRASOUND')),
  CONSTRAINT procedures_status_check CHECK (status IN ('EXPECTED', 'SCHEDULED', 'IN_PROGRESS', 'PERFORMED', 'AWAITING_REPORT', 'CANCELLED')),
  CONSTRAINT procedures_version_positive CHECK (version > 0),
  CONSTRAINT procedures_id_item_key UNIQUE (id, item_id),
  CONSTRAINT procedures_item_fk FOREIGN KEY (item_id) REFERENCES diagnostic_request_items (id),
  CONSTRAINT procedures_performed_by_fk FOREIGN KEY (performed_by) REFERENCES users (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS procedures_active_item_uidx
  ON procedures (item_id)
  WHERE status <> 'CANCELLED';
CREATE INDEX IF NOT EXISTS procedures_status_workflow_idx
  ON procedures (workflow_type, status, created_at);

CREATE TABLE IF NOT EXISTS procedure_schedules (
  id text PRIMARY KEY,
  procedure_id text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  resource text NOT NULL,
  status text NOT NULL,
  reason text,
  actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT procedure_schedules_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT procedure_schedules_resource_nonempty CHECK (btrim(resource) <> ''),
  CONSTRAINT procedure_schedules_status_check CHECK (status IN ('SCHEDULED', 'CANCELLED', 'COMPLETED')),
  CONSTRAINT procedure_schedules_time_range CHECK (ends_at > starts_at),
  CONSTRAINT procedure_schedules_version_positive CHECK (version > 0),
  CONSTRAINT procedure_schedules_procedure_fk FOREIGN KEY (procedure_id) REFERENCES procedures (id),
  CONSTRAINT procedure_schedules_actor_fk FOREIGN KEY (actor_id) REFERENCES users (id)
);
CREATE INDEX IF NOT EXISTS procedure_schedules_resource_time_idx
  ON procedure_schedules (resource, status, starts_at, ends_at);
CREATE INDEX IF NOT EXISTS procedure_schedules_procedure_idx
  ON procedure_schedules (procedure_id, starts_at DESC);

CREATE TABLE IF NOT EXISTS results (
  id text PRIMARY KEY,
  item_id text NOT NULL,
  current_version_id text,
  lifecycle_status text NOT NULL,
  needs_re_review boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT results_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT results_lifecycle_status_check CHECK (lifecycle_status IN ('DRAFT', 'RELEASED', 'VOIDED')),
  CONSTRAINT results_version_positive CHECK (version > 0),
  CONSTRAINT results_item_key UNIQUE (item_id),
  CONSTRAINT results_id_item_key UNIQUE (id, item_id),
  CONSTRAINT results_item_fk FOREIGN KEY (item_id) REFERENCES diagnostic_request_items (id)
);
CREATE INDEX IF NOT EXISTS results_lifecycle_idx ON results (lifecycle_status, updated_at DESC);

CREATE TABLE IF NOT EXISTS result_versions (
  id text PRIMARY KEY,
  result_id text NOT NULL,
  sequence integer NOT NULL,
  status text NOT NULL,
  content jsonb NOT NULL DEFAULT '{}'::jsonb,
  narrative text NOT NULL,
  conclusion text,
  author_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  released_by text,
  amendment_reason text,
  supersedes_id text,
  policy_version text,
  schema_version text,
  critical boolean NOT NULL DEFAULT false,
  needs_re_review boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT result_versions_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT result_versions_sequence_positive CHECK (sequence > 0),
  CONSTRAINT result_versions_status_check CHECK (status IN ('DRAFT', 'RELEASED', 'SUPERSEDED', 'VOIDED')),
  CONSTRAINT result_versions_release_fields_pair CHECK ((released_at IS NULL) = (released_by IS NULL)),
  CONSTRAINT result_versions_release_status_check CHECK (released_at IS NULL OR status IN ('RELEASED', 'SUPERSEDED')),
  CONSTRAINT result_versions_published_fields_required CHECK (status NOT IN ('RELEASED', 'SUPERSEDED') OR released_at IS NOT NULL),
  CONSTRAINT result_versions_amendment_reason_required CHECK (supersedes_id IS NULL OR (amendment_reason IS NOT NULL AND btrim(amendment_reason) <> '')),
  CONSTRAINT result_versions_not_self_superseding CHECK (supersedes_id IS NULL OR supersedes_id <> id),
  CONSTRAINT result_versions_version_positive CHECK (version > 0),
  CONSTRAINT result_versions_result_sequence_key UNIQUE (result_id, sequence),
  CONSTRAINT result_versions_result_id_key UNIQUE (id, result_id),
  CONSTRAINT result_versions_result_fk FOREIGN KEY (result_id) REFERENCES results (id),
  CONSTRAINT result_versions_author_fk FOREIGN KEY (author_id) REFERENCES users (id),
  CONSTRAINT result_versions_released_by_fk FOREIGN KEY (released_by) REFERENCES users (id),
  CONSTRAINT result_versions_supersedes_fk FOREIGN KEY (supersedes_id) REFERENCES result_versions (id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS result_versions_result_sequence_idx
  ON result_versions (result_id, sequence DESC);
CREATE INDEX IF NOT EXISTS result_versions_status_created_idx
  ON result_versions (status, created_at DESC);

CREATE TABLE IF NOT EXISTS result_components (
  id text PRIMARY KEY,
  result_version_id text NOT NULL,
  code text NOT NULL,
  value jsonb NOT NULL,
  unit_code text,
  reference_range jsonb,
  abnormal_flag text,
  display_order integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT result_components_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT result_components_code_nonempty CHECK (btrim(code) <> ''),
  CONSTRAINT result_components_display_order_positive CHECK (display_order > 0),
  CONSTRAINT result_components_version_code_key UNIQUE (result_version_id, code),
  CONSTRAINT result_components_version_order_key UNIQUE (result_version_id, display_order),
  CONSTRAINT result_components_result_version_fk FOREIGN KEY (result_version_id) REFERENCES result_versions (id)
);
CREATE INDEX IF NOT EXISTS result_components_version_order_idx
  ON result_components (result_version_id, display_order);

CREATE TABLE IF NOT EXISTS attachments (
  id text PRIMARY KEY,
  result_version_id text NOT NULL,
  safe_name text NOT NULL,
  storage_key text NOT NULL,
  detected_mime text NOT NULL,
  size_bytes bigint NOT NULL,
  checksum text NOT NULL,
  scan_status text NOT NULL,
  upload_status text NOT NULL,
  upload_claim_token text,
  upload_claim_expires_at timestamptz,
  expires_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attachments_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT attachments_safe_name_nonempty CHECK (btrim(safe_name) <> ''),
  CONSTRAINT attachments_storage_key_nonempty CHECK (btrim(storage_key) <> ''),
  CONSTRAINT attachments_detected_mime_nonempty CHECK (btrim(detected_mime) <> ''),
  CONSTRAINT attachments_checksum_nonempty CHECK (btrim(checksum) <> ''),
  CONSTRAINT attachments_size_valid CHECK (size_bytes >= 0),
  CONSTRAINT attachments_scan_status_check CHECK (scan_status IN ('PENDING', 'CLEAN', 'QUARANTINED', 'FAILED')),
  CONSTRAINT attachments_upload_status_check CHECK (upload_status IN ('INITIATED', 'UPLOADED', 'FINALIZED')),
  CONSTRAINT attachments_result_version_fk FOREIGN KEY (result_version_id) REFERENCES result_versions (id),
  CONSTRAINT attachments_created_by_fk FOREIGN KEY (created_by) REFERENCES users (id),
  CONSTRAINT attachments_storage_key_key UNIQUE (storage_key)
);
CREATE INDEX IF NOT EXISTS attachments_result_version_scan_idx
  ON attachments (result_version_id, scan_status, upload_status);

CREATE TABLE IF NOT EXISTS notifications (
  id text PRIMARY KEY,
  category text NOT NULL,
  priority text NOT NULL,
  recipient_user_id text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  deep_link text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  dedupe_key text NOT NULL,
  state text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  acknowledged_at timestamptz,
  acknowledged_by text,
  attempts integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT notifications_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT notifications_category_check CHECK (category IN ('INFORMATIONAL', 'ACTIONABLE', 'CRITICAL', 'ADMINISTRATIVE')),
  CONSTRAINT notifications_priority_check CHECK (priority IN ('NORMAL', 'HIGH', 'URGENT')),
  CONSTRAINT notifications_entity_type_check CHECK (entity_type IN ('REQUEST', 'ITEM', 'RESULT_VERSION', 'SAMPLE')),
  CONSTRAINT notifications_entity_id_nonempty CHECK (btrim(entity_id) <> ''),
  CONSTRAINT notifications_state_check CHECK (state IN ('PENDING', 'DELIVERED', 'SEEN', 'ACKNOWLEDGED', 'FAILED', 'SUPERSEDED', 'ESCALATED')),
  CONSTRAINT notifications_dedupe_nonempty CHECK (btrim(dedupe_key) <> ''),
  CONSTRAINT notifications_attempts_valid CHECK (attempts >= 0),
  CONSTRAINT notifications_version_positive CHECK (version > 0),
  CONSTRAINT notifications_acknowledgement_pair CHECK ((acknowledged_at IS NULL) = (acknowledged_by IS NULL)),
  CONSTRAINT notifications_recipient_fk FOREIGN KEY (recipient_user_id) REFERENCES users (id),
  CONSTRAINT notifications_acknowledged_by_fk FOREIGN KEY (acknowledged_by) REFERENCES users (id),
  CONSTRAINT notifications_recipient_dedupe_key UNIQUE (recipient_user_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS notifications_recipient_state_created_idx
  ON notifications (recipient_user_id, state, created_at DESC, id);
CREATE INDEX IF NOT EXISTS notifications_entity_idx
  ON notifications (entity_type, entity_id, created_at DESC);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id text PRIMARY KEY,
  notification_id text NOT NULL,
  channel text NOT NULL,
  status text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  sent_at timestamptz,
  delivered_at timestamptz,
  seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT notification_deliveries_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT notification_deliveries_channel_nonempty CHECK (btrim(channel) <> ''),
  CONSTRAINT notification_deliveries_status_check CHECK (status IN ('PENDING', 'SENT', 'DELIVERED', 'FAILED')),
  CONSTRAINT notification_deliveries_attempts_valid CHECK (attempts >= 0),
  CONSTRAINT notification_deliveries_version_positive CHECK (version > 0),
  CONSTRAINT notification_deliveries_notification_fk FOREIGN KEY (notification_id) REFERENCES notifications (id),
  CONSTRAINT notification_deliveries_notification_channel_key UNIQUE (notification_id, channel)
);
CREATE INDEX IF NOT EXISTS notification_deliveries_worker_idx
  ON notification_deliveries (status, updated_at, created_at);

CREATE TABLE IF NOT EXISTS acknowledgements (
  id text PRIMARY KEY,
  notification_id text NOT NULL,
  result_version_id text,
  actor_id text NOT NULL,
  acknowledged_at timestamptz NOT NULL,
  method text NOT NULL,
  reason text NOT NULL,
  confirmed boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT acknowledgements_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT acknowledgements_method_nonempty CHECK (btrim(method) <> ''),
  CONSTRAINT acknowledgements_reason_nonempty CHECK (btrim(reason) <> ''),
  CONSTRAINT acknowledgements_notification_actor_key UNIQUE (notification_id, actor_id),
  CONSTRAINT acknowledgements_notification_fk FOREIGN KEY (notification_id) REFERENCES notifications (id),
  CONSTRAINT acknowledgements_result_version_fk FOREIGN KEY (result_version_id) REFERENCES result_versions (id),
  CONSTRAINT acknowledgements_actor_fk FOREIGN KEY (actor_id) REFERENCES users (id)
);
CREATE INDEX IF NOT EXISTS acknowledgements_result_version_idx
  ON acknowledgements (result_version_id, acknowledged_at DESC);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id text PRIMARY KEY,
  actor_id text NOT NULL,
  scope text NOT NULL,
  key text NOT NULL,
  payload_hash text NOT NULL,
  response jsonb NOT NULL,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT idempotency_keys_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT idempotency_keys_actor_nonempty CHECK (btrim(actor_id) <> ''),
  CONSTRAINT idempotency_keys_scope_nonempty CHECK (btrim(scope) <> ''),
  CONSTRAINT idempotency_keys_key_nonempty CHECK (btrim(key) <> ''),
  CONSTRAINT idempotency_keys_payload_hash_nonempty CHECK (btrim(payload_hash) <> ''),
  CONSTRAINT idempotency_keys_actor_scope_key_key UNIQUE (actor_id, scope, key),
  CONSTRAINT idempotency_keys_actor_fk FOREIGN KEY (actor_id) REFERENCES users (id)
);
CREATE INDEX IF NOT EXISTS idempotency_keys_expiry_idx
  ON idempotency_keys (expires_at, created_at);

-- These projections already predate the clinical core. Indexes improve future
-- joins while deliberately avoiding a new FK that could reject legacy rows.
CREATE INDEX IF NOT EXISTS audit_events_actor_occurred_idx
  ON audit_events (actor_id, occurred_at);
CREATE INDEX IF NOT EXISTS outbox_messages_aggregate_idx
  ON outbox_messages (aggregate_type, aggregate_id, available_at);

-- The three pointers below form intentional cycles with their owning rows. A
-- deferred FK keeps the invariant database-enforceable without forcing a
-- write order on the future cutover transaction.
DO $relational_clinical_core_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'diagnostic_request_items'::regclass
       AND conname = 'diagnostic_request_items_current_sample_fk'
  ) THEN
    ALTER TABLE diagnostic_request_items
      ADD CONSTRAINT diagnostic_request_items_current_sample_fk
      FOREIGN KEY (current_sample_id, request_id)
      REFERENCES samples (id, request_id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'diagnostic_request_items'::regclass
       AND conname = 'diagnostic_request_items_procedure_fk'
  ) THEN
    ALTER TABLE diagnostic_request_items
      ADD CONSTRAINT diagnostic_request_items_procedure_fk
      FOREIGN KEY (procedure_id, id)
      REFERENCES procedures (id, item_id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'diagnostic_request_items'::regclass
       AND conname = 'diagnostic_request_items_current_result_fk'
  ) THEN
    ALTER TABLE diagnostic_request_items
      ADD CONSTRAINT diagnostic_request_items_current_result_fk
      FOREIGN KEY (current_result_id, id)
      REFERENCES results (id, item_id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'results'::regclass
       AND conname = 'results_current_version_fk'
  ) THEN
    ALTER TABLE results
      ADD CONSTRAINT results_current_version_fk
      FOREIGN KEY (current_version_id, id)
      REFERENCES result_versions (id, result_id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END;
$relational_clinical_core_constraints$;

COMMENT ON TABLE departments IS 'Relational clinical core v1; IDs remain text-compatible with StoreState and runtime authority is still cvg_runtime_state.';
COMMENT ON TABLE critical_result_policies IS 'Versioned policy configuration boundary. Policy contents require later clinical governance; no interpretation values are seeded here.';
COMMENT ON TABLE diagnostic_request_items IS 'Relational request-item core. Runtime still reads and writes the StoreState snapshot until a later cutover.';
COMMENT ON TABLE result_versions IS 'Version lineage is relational and auditable; release/amend/void behavior remains owned by a later runtime integration.';
COMMENT ON TABLE audit_events IS 'Existing append-only projection; 007 adds only a compatible lookup index and does not duplicate the table.';
COMMENT ON TABLE outbox_messages IS 'Existing transactional projection; 007 adds only a compatible aggregate lookup index and does not duplicate the table.';
