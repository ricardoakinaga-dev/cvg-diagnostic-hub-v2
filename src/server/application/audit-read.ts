import type { AuditEntity, AuditEvent, AuditScope, DiagnosticRequest, StateStore, StoreState, User } from "../domain/models";
import { canAccessResource, managerCanAccessDepartment } from "../security/authorization";
import { auditEventDepartmentCode, auditEventItemIds, canViewItem, canViewManagementAudit, canViewRequest, itemFor, requestForAuditEvent } from "./service-common";
import { canAccessHospitalTask } from "./hospital-task-policy";
import { canAccessHospitalPlan } from "./hospital-plan-policy";
import { canAccessChecklistTemplate } from "./hospital-checklist-policy";
import { canAccessHospitalDocument } from "./hospital-document-policy";
import { canResolveWorkActivity } from "./work-activity-policy";
import { canAccessHospitalReport } from "./hospital-report-policy";

// The existing audit policies resolve resources from this identity only; event
// metadata, actor and event type do not affect their visibility decisions.
function eventForEntity(entity: AuditEntity): AuditEvent {
  return { ...entity, id: "", eventType: "", correlationId: "", metadata: {}, occurredAt: "" };
}

function clinicalEntities(state: StoreState): AuditEntity[] {
  const collections = [
    ["DiagnosticRequest", state.requests],
    ["DiagnosticRequestItem", state.items],
    ["Sample", state.samples],
    ["Result", state.results],
    ["ResultVersion", state.resultVersions],
    ["Procedure", state.procedures],
    ["ProcedureSchedule", state.schedules],
    ["Attachment", state.attachments]
  ] as const;
  return collections.flatMap(([entityType, entries]) => entries.map(({ id }) => ({ entityType, entityId: id })));
}

function resolvedClinicalEntities(state: StoreState) {
  return clinicalEntities(state).flatMap((entity) => {
    const event = eventForEntity(entity);
    const request = requestForAuditEvent(state, event);
    return request ? [{ entity, event, request }] : [];
  });
}

export function auditScopeForActor(state: StoreState, actor: User): AuditScope {
  const resolved = resolvedClinicalEntities(state);
  const entities = resolved.filter(({ event, request }) => {
    const departmentCode = auditEventDepartmentCode(state, event);
    if (actor.role === "MANAGER" && departmentCode && !managerCanAccessDepartment(actor, departmentCode)) return false;
    return canViewRequest(state, actor, request) && auditEventItemIds(state, event).every((itemId) => canViewItem(state, actor, itemFor(state, itemId)));
  }).map(({ entity }) => entity);

  const plannerEntities = [
    ...state.hospitalReports.map((report) => ({ entityType: "HospitalReport", entityId: report.id, visible: canAccessHospitalReport(state, actor, report.id) })),
    ...state.hospitalTasks.map((task) => ({ entityType: "HospitalTask", entityId: task.id, visible: canAccessHospitalTask(state, actor, "hospital_task.view", task) })),
    ...state.hospitalIntakes.map((intake) => ({ entityType: "HospitalIntake", entityId: intake.id, visible: canAccessHospitalTask(state, actor, "hospital_intake.view", intake) })),
    ...state.hospitalPlans.map((plan) => ({ entityType: "HospitalPlan", entityId: plan.id, visible: canAccessHospitalPlan(state, actor, "plan.view", plan) })),
    ...state.hospitalShifts.map((shift) => ({ entityType: "HospitalShift", entityId: shift.id, visible: canAccessHospitalTask(state, actor, "shift.view", shift) })),
    ...state.hospitalHandoffs.map((handoff) => ({ entityType: "HospitalHandoff", entityId: handoff.id, visible: canAccessHospitalTask(state, actor, "shift.view", handoff) })),
    ...state.hospitalChecklistTemplates.map((template) => ({ entityType: "HospitalChecklistTemplate", entityId: template.id, visible: canAccessChecklistTemplate(state, actor, "checklist_template.view", template) })),
    ...state.hospitalRecurrences.map((recurrence) => ({ entityType: "HospitalRecurrence", entityId: recurrence.id, visible: canAccessHospitalTask(state, actor, "recurrence.view", recurrence) })),
    ...state.hospitalDocuments.map((document) => ({ entityType: "HospitalDocument", entityId: document.id, visible: canAccessHospitalDocument(actor, "hospital_document.view", document.departmentCode) })),
    ...state.hospitalTaskComments.map((comment) => ({ entityType: "HospitalTaskComment", entityId: comment.id, visible: state.hospitalTasks.some((task) => task.id === comment.taskId && canAccessHospitalTask(state, actor, "hospital_task.view", task) && canAccessHospitalTask(state, actor, "hospital_task.comment.view", task)) })),
    ...state.hospitalTaskAttachments.map((attachment) => ({ entityType: "HospitalTaskAttachment", entityId: attachment.id, visible: state.hospitalTasks.some((task) => task.id === attachment.taskId && canAccessHospitalTask(state, actor, "hospital_task.view", task) && canAccessHospitalTask(state, actor, "hospital_task.attachment.view", task)) })),
    ...state.workActivityPreferences.map((preference) => ({ entityType: "WorkActivityPreference", entityId: preference.id, visible: preference.userId === actor.id && canAccessResource(actor, "work_activity.preference.manage", {}) && canResolveWorkActivity(state, actor, preference.targetType, preference.targetId) })),
    ...state.workNotificationPreferences.map((preference) => ({ entityType: "WorkNotificationPreference", entityId: preference.id, visible: preference.userId === actor.id && canAccessResource(actor, "work_notification.preferences.manage", {}) })),
    ...state.workNotifications.map((notification) => ({ entityType: "WorkNotification", entityId: notification.id, visible: notification.userId === actor.id && canAccessResource(actor, "work_notification.view", {}) && canResolveWorkActivity(state, actor, notification.targetType, notification.targetId) })),
    ...state.users.map((user) => ({ entityType: "UserWorkInbox", entityId: user.id, visible: user.id === actor.id && canAccessResource(actor, "work_notification.view", {}) }))
  ];
  entities.push(...plannerEntities.filter((entity) => entity.visible).map(({ entityType, entityId }) => ({ entityType, entityId })));

  if (actor.role === "ADMIN" || actor.role === "SUPERADMIN") return { entities, unresolved: { resolvedEntities: [...resolved.map(({ entity }) => entity), ...plannerEntities.map(({ entityType, entityId }) => ({ entityType, entityId }))] } };
  if (actor.role === "MANAGER") {
    entities.push(...state.hospitalServices.filter((service) => canAccessResource(actor, "service.catalog.view", { departmentCode: service.departmentCode })).map((service) => ({ entityType: "HospitalService", entityId: service.id })));
    const managementEntities = [
      ...state.users.map(({ id }) => ({ entityType: "User", entityId: id })),
      ...state.services.map(({ id }) => ({ entityType: "DiagnosticService", entityId: id }))
    ];
    entities.push(...managementEntities.filter((entity) => canViewManagementAudit(state, actor, eventForEntity(entity))));
    return { entities, entityTypes: ["ReasonCode"] };
  }
  return { entities };
}

export function auditEventWithinScope(scope: AuditScope, event: AuditEntity): boolean {
  const same = (entity: AuditEntity) => entity.entityType === event.entityType && entity.entityId === event.entityId;
  return scope.entities.some(same) || Boolean(scope.entityTypes?.includes(event.entityType)) || Boolean(scope.unresolved && !scope.unresolved.resolvedEntities.some(same));
}

/** Preserve the immutable trail while removing references the reader can no longer resolve. */
export function redactPlannerAuditEvent(state: StoreState, actor: User, event: AuditEvent): AuditEvent {
  if (!event.entityType.startsWith("Hospital")) return { ...event, metadata: { ...event.metadata } };
  const metadata = Object.fromEntries(Object.entries(event.metadata).filter(([key, value]) => {
    if (key === "entryCount") return false;
    if (event.entityType === "HospitalTask" && ["scheduleId", "scheduleVersion", "resourceIds", "startsAt", "endsAt"].includes(key)) { const task = state.hospitalTasks.find((entry) => entry.id === event.entityId); if (!task || !canAccessHospitalTask(state, actor, "hospital_calendar.view", task)) return false; }
    if (typeof value !== "string") return true;
    if (["patientId", "previousPatientId"].includes(key)) { const patient = state.patients.find((entry) => entry.id === value); if (!patient) return false; try { return canAccessHospitalTask(state, actor, "patient.view", { departmentCode: actor.departmentCode, patientId: patient.id }); } catch { return false; } }
    if (["encounterId", "previousEncounterId"].includes(key)) { const encounter = state.encounters.find((entry) => entry.id === value); return Boolean(encounter && canAccessHospitalTask(state, actor, "patient.view", { departmentCode: actor.departmentCode, patientId: encounter.patientId })); }
    if (["shiftId", "previousShiftId"].includes(key)) return state.hospitalShifts.some((shift) => shift.id === value && canAccessHospitalTask(state, actor, "shift.view", shift));
    if (key === "templateId") return state.hospitalChecklistTemplates.some((template) => template.id === value && canAccessChecklistTemplate(state, actor, "checklist_template.view", template));
    if (key === "targetId") return event.metadata.targetType === "HOSPITAL_TASK" ? state.hospitalTasks.some((task) => task.id === value && canAccessHospitalTask(state, actor, "hospital_task.view", task)) : event.metadata.targetType === "DIAGNOSTIC_ITEM" && state.items.some((item) => item.id === value && canViewItem(state, actor, item));
    if (["parentTaskId", "previousParentTaskId"].includes(key)) return state.hospitalTasks.some((task) => task.id === value && canAccessHospitalTask(state, actor, "hospital_task.view", task));
    return true;
  }));
  return { ...event, metadata };
}

export function requestAuditScope(state: StoreState, actor: User, request: DiagnosticRequest): AuditScope {
  const visibleItemIds = new Set(request.itemIds.filter((itemId) => canViewItem(state, actor, itemFor(state, itemId))));
  return patientAuditScope(state, request.patientId, new Set([request.id]), visibleItemIds);
}

export function patientAuditScope(state: StoreState, patientId: string, requestIds: ReadonlySet<string>, itemIds: ReadonlySet<string>): AuditScope {
  return {
    entities: resolvedClinicalEntities(state)
      .filter(({ event, request }) => request.patientId === patientId && requestIds.has(request.id) && auditEventItemIds(state, event).every((itemId) => itemIds.has(itemId)))
      .map(({ entity }) => entity)
  };
}

// The workspace response contains all scoped history, including requests beyond
// its request page. Keep that contract while bounding each historical read.
export async function readPatientAuditEvents(store: StateStore, scope: AuditScope): Promise<AuditEvent[]> {
  const events: AuditEvent[] = [];
  let cursor: { occurredAt: string; id: string } | undefined;
  while (true) {
    const page = await store.readAuditEvents({ scope, order: "asc", limit: 100, cursor });
    events.push(...page.items);
    if (!page.hasMore) return events;
    const last = page.items.at(-1);
    if (!last || (cursor && last.occurredAt === cursor.occurredAt && last.id === cursor.id)) throw new Error("AUDIT_READ_CURSOR_NOT_ADVANCING");
    cursor = { occurredAt: last.occurredAt, id: last.id };
  }
}
