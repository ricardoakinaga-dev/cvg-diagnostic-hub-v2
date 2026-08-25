export const PRIORITIES = ["ROUTINE", "URGENT", "EMERGENCY"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const WORKFLOW_TYPES = ["LABORATORY", "RADIOLOGY", "ULTRASOUND"] as const;
export type WorkflowType = (typeof WORKFLOW_TYPES)[number];

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
