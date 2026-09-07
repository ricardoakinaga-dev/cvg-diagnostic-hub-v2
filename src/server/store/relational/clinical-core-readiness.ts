export const RELATIONAL_CORE_TABLES = [
  "diagnostic_requests",
  "diagnostic_request_items",
  "samples",
  "sample_item_links",
  "procedures",
  "procedure_schedules",
  "results",
  "result_versions",
  "attachments",
  "notifications"
] as const;

const RELATIONAL_CORE_CONSTRAINTS = [
  { table: "diagnostic_requests", name: "diagnostic_requests_encounter_patient_fk" },
  { table: "diagnostic_request_items", name: "diagnostic_request_items_current_sample_fk" },
  { table: "diagnostic_request_items", name: "diagnostic_request_items_current_result_fk" },
  { table: "diagnostic_request_items", name: "diagnostic_request_items_procedure_fk" },
  { table: "results", name: "results_current_version_fk" },
  { table: "result_versions", name: "result_versions_result_sequence_key" },
  { table: "sample_item_links", name: "sample_item_links_sample_item_key" },
  { table: "samples", name: "samples_accession_format" },
  { table: "samples", name: "samples_replacement_reason_required" },
  { table: "samples", name: "samples_item_ids_nonempty" },
  { table: "sample_item_links", name: "sample_item_links_status_check" },
  { table: "notifications", name: "notifications_recipient_dedupe_key" }
] as const;

export const RELATIONAL_CORE_CONSTRAINT_NAMES = RELATIONAL_CORE_CONSTRAINTS.map(({ name }) => name);

// These are adapter-owned constants, never user input. Keeping the expected
// table beside each name prevents a homonymous constraint on another table
// from satisfying relational readiness.
export const RELATIONAL_CORE_CONSTRAINT_ROWS_SQL = RELATIONAL_CORE_CONSTRAINTS
  .map(({ table, name }) => `('${table}', '${name}')`)
  .join(",\n        ");
