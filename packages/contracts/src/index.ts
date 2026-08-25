export const PRIORITIES = ["ROUTINE", "URGENT", "EMERGENCY"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const WORKFLOW_TYPES = ["LABORATORY", "RADIOLOGY", "ULTRASOUND"] as const;
export type WorkflowType = (typeof WORKFLOW_TYPES)[number];

export const LABORATORY_VALUE_TYPES = ["NUMERIC", "QUALITATIVE", "TEXT"] as const;
export type LaboratoryValueType = (typeof LABORATORY_VALUE_TYPES)[number];

export const LABORATORY_PANEL_STATUSES = ["DRAFT", "ACTIVE", "RETIRED"] as const;
export type LaboratoryPanelStatus = (typeof LABORATORY_PANEL_STATUSES)[number];

export const LABORATORY_REFERENCE_RANGE_KINDS = ["NUMERIC", "PENDING_POLICY"] as const;
export type LaboratoryReferenceRangeKind = (typeof LABORATORY_REFERENCE_RANGE_KINDS)[number];

export const LABORATORY_REFERENCE_RANGE_SOURCES = ["HUMAN_APPROVED", "SYNTHETIC_FIXTURE", "PENDING_HUMAN_POLICY"] as const;
export type LaboratoryReferenceRangeSource = (typeof LABORATORY_REFERENCE_RANGE_SOURCES)[number];

export const LABORATORY_FLAGS = ["NORMAL", "LOW", "HIGH", "UNINTERPRETED"] as const;
export type LaboratoryFlag = (typeof LABORATORY_FLAGS)[number];

export interface LaboratoryReferenceRange {
  kind: LaboratoryReferenceRangeKind;
  unitCode: string;
  low?: number;
  high?: number;
  source: LaboratoryReferenceRangeSource;
  note?: string;
}

export interface LaboratoryAnalyteDefinition {
  code: string;
  label: string;
  valueType: LaboratoryValueType;
  unitCode: string;
  required: boolean;
  displayOrder: number;
  referenceRange?: LaboratoryReferenceRange;
  allowedValues?: string[];
}

/** Versioned panel definition. Thresholds are configuration, never inferred by the UI. */
export interface LaboratoryPanelTemplate {
  kind: "LABORATORY_PANEL";
  code: string;
  name: string;
  version: number;
  schemaVersion: string;
  status: LaboratoryPanelStatus;
  analytes: LaboratoryAnalyteDefinition[];
}

export interface LaboratoryObservation {
  analyteCode: string;
  value: number | string;
  unitCode: string;
  flag: LaboratoryFlag;
  referenceRange: LaboratoryReferenceRange | null;
}

export interface StructuredLaboratoryResultContent {
  kind: "LABORATORY_STRUCTURED";
  panelCode: string;
  panelVersion: number;
  observations: LaboratoryObservation[];
}

export const OPERATIONAL_OWNER_CODES = [
  "REQUESTING_TEAM",
  "LABORATORY",
  "RADIOLOGY",
  "ULTRASOUND",
  "DIAGNOSTICS_OPERATIONS",
  "UNKNOWN"
] as const;
export type OperationalOwnerCode = (typeof OPERATIONAL_OWNER_CODES)[number];

export const OPERATIONAL_ACTION_CODES = [
  "COLLECT_SAMPLE",
  "SCHEDULE_EXAM",
  "ROUTE_PATIENT",
  "START_PROCESSING",
  "REGISTER_RESULT",
  "MARK_PERFORMED",
  "PRODUCE_REPORT",
  "REVIEW_RESULT",
  "REGISTER_REPLACEMENT_RESULT",
  "COLLECT_REPLACEMENT_SAMPLE",
  "MONITOR_ITEM"
] as const;
export type OperationalActionCode = (typeof OPERATIONAL_ACTION_CODES)[number];

export const OPERATIONAL_BLOCKER_CODES = [
  "WAITING_SAMPLE",
  "WAITING_REPLACEMENT_SAMPLE",
  "WAITING_SCHEDULE",
  "WAITING_REPORT"
] as const;
export type OperationalBlockerCode = (typeof OPERATIONAL_BLOCKER_CODES)[number];

export const OPERATIONAL_ESCALATION_LEVELS = ["NONE", "WATCH", "ATTENTION", "URGENT"] as const;
export type OperationalEscalationLevel = (typeof OPERATIONAL_ESCALATION_LEVELS)[number];

export interface OperationalOwner {
  code: OperationalOwnerCode;
  label: string;
}

export interface OperationalAction {
  code: OperationalActionCode;
  label: string;
}

export interface OperationalBlocker {
  code: OperationalBlockerCode;
  label: string;
}

/** Server-derived work context; it does not replace an approved clinical policy. */
export interface OperationalContext {
  currentOwner: OperationalOwner;
  nextAction: OperationalAction;
  blockedBy: OperationalBlocker | null;
  waitingSince: string | null;
  expectedBy: string | null;
  escalationLevel: OperationalEscalationLevel;
}

export const ITEM_STATES = [
  "REQUESTED",
  "RECEIVED",
  "SCHEDULED",
  "IN_PROGRESS",
  "AWAITING_REPORT",
  "RESULT_AVAILABLE",
  "REVIEWED",
  "COMPLETED",
  "RECOLLECTION_REQUIRED",
  "FAILED",
  "CANCELLED",
  "REJECTED",
  "RESULT_VOIDED"
] as const;
export type ItemState = (typeof ITEM_STATES)[number];

export const TERMINAL_ITEM_STATES = ["COMPLETED", "CANCELLED", "REJECTED"] as const;

export const RESULT_VERSION_STATES = ["DRAFT", "RELEASED", "SUPERSEDED", "VOIDED"] as const;
export type ResultVersionState = (typeof RESULT_VERSION_STATES)[number];

export const ROLES = [
  "ADMIN",
  "MANAGER",
  "VETERINARIAN",
  "INPATIENT_TEAM",
  "LAB_TECH",
  "RADIOLOGY_TEAM",
  "ULTRASOUND_TEAM",
  "VIEWER"
] as const;
export type RoleCode = (typeof ROLES)[number];

export type Permission =
  | "patient.view"
  | "patient.create"
  | "encounter.view"
  | "admission.view"
  | "request.create"
  | "request.view"
  | "request.list"
  | "request.cancel"
  | "request.duplicate_override"
  | "item.view"
  | "item.cancel"
  | "item.reject"
  | "sample.receive"
  | "sample.process"
  | "sample.recollection.request"
  | "sample.replacement.receive"
  | "procedure.schedule"
  | "procedure.reschedule"
  | "procedure.start"
  | "procedure.mark_performed"
  | "result.draft.create"
  | "result.draft.edit_own"
  | "result.release"
  | "result.amend"
  | "result.void"
  | "result.view"
  | "result.history.view"
  | "result.view.record"
  | "result.review"
  | "item.complete"
  | "attachment.view"
  | "attachment.upload_session"
  | "attachment.finalize"
  | "attachment.download"
  | "notification.view"
  | "notification.acknowledge"
  | "service.catalog.view"
  | "service.catalog.manage"
  | "sla_policy.manage"
  | "critical_result_policy.manage"
  | "reason_code.manage"
  | "user_role.manage"
  | "queue.view"
  | "dashboard.view"
  | "diagnostic.timeline.view"
  | "timeline.view"
  | "audit.view"
  | "search.execute"
  | "health.liveness"
  | "health.readiness"
  | "realtime.connect";

export interface ApiMeta {
  requestId: string;
  correlationId: string;
  nextCursor?: string;
  limit?: number;
}

export interface ApiSuccess<T> {
  data: T;
  meta: ApiMeta;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    correlationId: string;
  };
}

export interface PatientSummary {
  id: string;
  displayName: string;
  species: string;
  sex: string;
  birthDate?: string;
  ownerLabel?: string;
  externalId?: string;
}
