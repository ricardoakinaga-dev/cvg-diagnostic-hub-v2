import type { Attachment, DiagnosticItem, DiagnosticRequest, Notification, Procedure, ProcedureSchedule, Result, ResultVersion, Sample, StoreState } from "../server/domain/models";

export const ARCHIVE_NOW = new Date("2026-10-08T12:00:00.000Z");
export const OLD = "2024-06-01T12:00:00.000Z";
export const RECENT = "2026-09-01T12:00:00.000Z";

export interface CompletedRequestOptions {
  readonly patientId?: string;
  readonly at?: string;
  readonly aggregateStatus?: DiagnosticRequest["aggregateStatus"];
  readonly itemStatus?: DiagnosticItem["status"];
  readonly notificationState?: Notification["state"];
  readonly attachmentStatus?: Attachment["uploadStatus"];
}

/** Appends one fully related request: two items (laboratory and radiology), sample, procedure, schedule, result, versions, notification and attachment. */
export function withCompletedRequest(state: StoreState, key: string, options: CompletedRequestOptions = {}): StoreState {
  const at = options.at ?? OLD;
  const patientId = options.patientId ?? "patient-thor";
  const itemStatus = options.itemStatus ?? "COMPLETED";
  const requestId = `request-${key}`;
  const labItem: DiagnosticItem = {
    id: `item-lab-${key}`, requestId, serviceId: "service-hemogram", departmentCode: "LABORATORY", workflowType: "LABORATORY", priority: "ROUTINE",
    status: itemStatus, requestedAt: at, completedAt: at, slaStartedAt: at, dueAt: at, slaPolicyVersion: 1, version: 3, currentResultId: `result-${key}`, currentSampleId: `sample-${key}`
  };
  const imagingItem: DiagnosticItem = {
    id: `item-rx-${key}`, requestId, serviceId: "service-xray", departmentCode: "RADIOLOGY", workflowType: "RADIOLOGY", priority: "ROUTINE",
    status: itemStatus, requestedAt: at, completedAt: at, slaStartedAt: at, dueAt: at, slaPolicyVersion: 1, version: 3, procedureId: `procedure-${key}`
  };
  const request: DiagnosticRequest = {
    id: requestId, requestCode: `EX-${key}`, patientId, encounterId: patientId === "patient-mel" ? "encounter-mel" : "encounter-thor", requesterId: "user-vet",
    requestingDepartmentCode: "INPATIENT", priority: "ROUTINE", aggregateStatus: options.aggregateStatus ?? "COMPLETED", itemIds: [labItem.id, imagingItem.id],
    createdAt: at, updatedAt: at, version: 4
  };
  const sample: Sample = { id: `sample-${key}`, requestId, accessionCode: `ACC-${key}`.toUpperCase(), sampleType: "EDTA", status: "RECEIVED", itemIds: [labItem.id], collectedAt: at, receivedAt: at, version: 2 };
  const procedure: Procedure = { id: `procedure-${key}`, itemId: imagingItem.id, workflowType: "RADIOLOGY", status: "PERFORMED", scheduleIds: [`schedule-${key}`], performedAt: at, version: 2 };
  const schedule: ProcedureSchedule = { id: `schedule-${key}`, procedureId: procedure.id, startsAt: at, endsAt: at, resource: "RX-1", status: "COMPLETED", actorId: "user-rx", createdAt: at, version: 1 };
  const result: Result = { id: `result-${key}`, itemId: labItem.id, currentVersionId: `version-${key}-2`, lifecycleStatus: "RELEASED", needsReReview: false, version: 3 };
  const draft: ResultVersion = { id: `version-${key}-1`, resultId: result.id, sequence: 1, status: "SUPERSEDED", content: { kind: "NARRATIVE" }, narrative: "Primeira versão.", authorId: "user-lab", createdAt: at, releasedAt: at, critical: false, needsReReview: false, version: 2 };
  const released: ResultVersion = { id: `version-${key}-2`, resultId: result.id, sequence: 2, status: "RELEASED", content: { kind: "NARRATIVE" }, narrative: "Versão final.", conclusion: "Sem alterações.", authorId: "user-lab", createdAt: at, releasedAt: at, supersedesId: draft.id, amendmentReason: "Correção", critical: false, needsReReview: false, version: 2 };
  const notification: Notification = {
    id: `notification-${key}`, category: "ACTIONABLE", priority: "NORMAL", recipientUserId: "user-vet", entityType: "RESULT_VERSION", entityId: released.id, deepLink: `/results/${result.id}`,
    title: "Resultado liberado", body: "Resultado liberado.", dedupeKey: `dedupe-${key}`, state: options.notificationState ?? "ACKNOWLEDGED", createdAt: at, attempts: 1, version: 2
  };
  const attachment: Attachment = {
    id: `attachment-${key}`, resultVersionId: released.id, safeName: "laudo.pdf", storageKey: `attachments/${result.id}/uuid-${key}/laudo.pdf`, detectedMime: "application/pdf", sizeBytes: 2048,
    checksum: "abc", scanStatus: "CLEAN", uploadStatus: options.attachmentStatus ?? "FINALIZED", createdBy: "user-lab", createdAt: at
  };
  return {
    ...state,
    requests: [...state.requests, request],
    items: [...state.items, labItem, imagingItem],
    samples: [...state.samples, sample],
    procedures: [...state.procedures, procedure],
    schedules: [...state.schedules, schedule],
    results: [...state.results, result],
    resultVersions: [...state.resultVersions, draft, released],
    notifications: [...state.notifications, notification],
    attachments: [...state.attachments, attachment]
  };
}
