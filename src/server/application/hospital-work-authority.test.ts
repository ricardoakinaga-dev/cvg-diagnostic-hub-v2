import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Permission, WorkActivityTargetType } from "@cvg/contracts";
import { hospitalOperationFixture } from "../../test/hospital-operation-fixtures";
import { systemGroupId } from "../security/access-group-policy";
import { auditEventWithinScope, auditScopeForActor, redactPlannerAuditEvent } from "./audit-read";
import { eventVisible } from "./realtime-visibility";
import { requireActiveUser } from "./service-common";
import { resolveWorkActivity } from "./work-activity-policy";
import { appendWorkNotifications } from "./work-notification-policy";

async function references() {
  const f = hospitalOperationFixture();
  await f.store.transaction((state) => ({ state: { ...state, users: [...state.users,
    { ...f.user("user-vet"), id: "vet-b", email: "vet-b@example.test" },
    { ...f.user("user-vet"), id: "super", email: "super@example.test", role: "SUPERADMIN", accessGroupId: systemGroupId("SUPERADMIN") }],
    departments: state.departments.map((entry) => entry.code === "INPATIENT" ? { ...entry, memberUserIds: [...entry.memberUserIds, "vet-b"] } : entry) }, result: undefined }));
  const vet = f.user("user-vet"); const admin = f.user("user-admin"); const superuser = f.user("super");
  const task = await f.task("authority-task", "INPATIENT");
  const plan = await f.service.createHospitalPlan(vet, { title: "Plano sintético", objective: "Conferência", patientId: "patient-thor", encounterId: "encounter-thor", departmentCodes: ["INPATIENT"], idempotencyKey: "authority-plan" });
  const from = await f.service.createHospitalShift(superuser, { name: "Origem", departmentCode: "INPATIENT", startAt: "2026-10-11T06:00:00Z", endAt: "2026-10-11T12:00:00Z", members: [{ userId: vet.id }], idempotencyKey: "authority-from" });
  const to = await f.service.createHospitalShift(superuser, { name: "Destino", departmentCode: "INPATIENT", startAt: "2026-10-11T12:00:00Z", endAt: "2026-10-11T18:00:00Z", members: [{ userId: "vet-b" }], idempotencyKey: "authority-to" });
  await f.service.assignHospitalActivityShift(superuser, { targetType: "HOSPITAL_TASK", targetId: task.task.id, shiftId: from.shift.id, expectedVersion: 1, idempotencyKey: "authority-shift" });
  const handoff = await f.service.offerHospitalHandoff(vet, { fromShiftId: from.shift.id, toShiftId: to.shift.id, recipientUserId: "vet-b", entries: [{ targetType: "HOSPITAL_TASK", targetId: task.task.id, expectedTargetVersion: 2 }], idempotencyKey: "authority-handoff" });
  const intake = await f.service.createHospitalIntake(vet, { title: "Entrada sintética", departmentCode: "INPATIENT", priority: "ROUTINE", source: "MANUAL", idempotencyKey: "authority-intake" });
  const template = await f.service.createHospitalChecklistTemplate(admin, { code: "AUTH_CHECK", name: "Checklist", departmentCode: "INPATIENT", careContextRequired: false, steps: [{ code: "CHECK", label: "Conferir", required: true, evidenceRequired: false }], idempotencyKey: "authority-template" });
  await f.service.approveHospitalChecklistTemplate(vet, template.template.id, { expectedVersion: 1, idempotencyKey: "authority-approve" });
  const recurrence = await f.service.createHospitalRecurrence(vet, { templateId: template.template.id, departmentCode: "INPATIENT", title: "Rotina", priority: "ROUTINE", startAt: "2026-10-11T12:00:00Z", intervalMinutes: 60, idempotencyKey: "authority-recurrence" });
  const document = await f.service.createHospitalDocument(admin, { code: "AUTH_DOC", title: "Documento", departmentCode: "INPATIENT", responsibleUserId: vet.id, content: { type: "hospital-document", version: 1, blocks: [{ type: "paragraph", content: [{ text: "Conteúdo sintético" }] }] }, idempotencyKey: "authority-document" });
  const resource = await f.service.createHospitalResource(admin, { code: "AUTH_RESOURCE", name: "Recurso", kind: "EQUIPMENT", departmentCode: "INPATIENT", availabilityWindows: [], idempotencyKey: "authority-resource" });
  const service = await f.service.createHospitalService(admin, { code: "AUTH_SERVICE", name: "Serviço", kind: "OPERATIONAL", departmentCode: "INPATIENT", idempotencyKey: "authority-service" });
  const request = await f.service.createRequest(vet, { patientId: "patient-thor", encounterId: "encounter-thor", admissionId: "admission-thor", priority: "ROUTINE", items: [{ serviceId: "service-hemogram" }] }, { idempotencyKey: "authority-request" });
  const saved = await f.service.createPlannerView(vet, { name: "Visão privada", filters: {}, display: { layout: "TABLE", orderBy: "UPDATED", direction: "DESC", groupBy: "NONE", columns: ["title"] }, idempotencyKey: "authority-view" });
  const refs: Array<{ type: WorkActivityTargetType; id: string; permission: Permission; entity?: string }> = [
    { type: "HOSPITAL_TASK", id: task.task.id, permission: "hospital_task.view", entity: "HospitalTask" },
    { type: "HOSPITAL_PLAN", id: plan.plan.id, permission: "plan.view", entity: "HospitalPlan" },
    { type: "HOSPITAL_SHIFT", id: from.shift.id, permission: "shift.view", entity: "HospitalShift" },
    { type: "HOSPITAL_HANDOFF", id: handoff.handoff.id, permission: "shift.view", entity: "HospitalHandoff" },
    { type: "HOSPITAL_INTAKE", id: intake.id, permission: "hospital_intake.view", entity: "HospitalIntake" },
    { type: "CHECKLIST_TEMPLATE", id: template.template.id, permission: "checklist_template.view", entity: "HospitalChecklistTemplate" },
    { type: "HOSPITAL_RECURRENCE", id: recurrence.recurrence.id, permission: "recurrence.view", entity: "HospitalRecurrence" },
    { type: "HOSPITAL_DOCUMENT", id: document.document.id, permission: "hospital_document.view", entity: "HospitalDocument" },
    { type: "HOSPITAL_RESOURCE", id: resource.id, permission: "hospital_resource.view" },
    { type: "HOSPITAL_SERVICE", id: service.id, permission: "service.catalog.view", entity: "HospitalService" },
    { type: "DIAGNOSTIC_ITEM", id: request.items[0].id, permission: "item.view", entity: "DiagnosticRequestItem" },
    { type: "DIAGNOSTIC_REQUEST", id: request.id, permission: "request.view", entity: "DiagnosticRequest" },
    { type: "SAVED_PLANNER_VIEW", id: saved.id, permission: "planner_view.view" },
    { type: "DEPARTMENT", id: f.store.getState().departments.find((entry) => entry.code === "INPATIENT")!.id, permission: "department.view" }
  ];
  return { ...f, refs, task: task.task, shift: from.shift, template: template.template, saved };
}

describe("current authority for private hospital work references and event history", () => {
  it("resolves all fourteen native targets, then removes revoked targets from preferences, inbox and SSE", async () => {
    const f = await references(); const actor = f.user("user-vet"); const originalGroup = f.store.getState().accessGroups.find((entry) => entry.id === actor.accessGroupId)!;
    for (const ref of f.refs) {
      const input = { targetType: ref.type, targetId: ref.id, favorite: true, following: true, privateNote: `private-${ref.type}`, expectedVersion: 0, idempotencyKey: `favorite-${ref.type}` };
      const saved = await f.service.putWorkActivityPreference(actor, input);
      expect(saved.target).toEqual(resolveWorkActivity(f.store.getState(), actor, ref.type, ref.id));
      expect((await f.service.listWorkActivityPreferences(actor, { targetType: ref.type, targetId: ref.id })).items[0].preference.id).toBe(saved.preference.id);
      await f.store.transaction((state) => ({ state: appendWorkNotifications(state, { sourceKey: `authority-${ref.type}`, targetType: ref.type, targetId: ref.id, eventType: "TASK_CHANGED", recipientUserIds: [actor.id], createdAt: new Date().toISOString() }), result: undefined }));
      const notice = f.store.getState().workNotifications.find((entry) => entry.sourceKey === `authority-${ref.type}`)!;
      expect(eventVisible(f.store.getState(), actor, "WorkActivityPreference", saved.preference.id, {})).toBe(true);
      expect(eventVisible(f.store.getState(), actor, "WorkNotification", notice.id, {})).toBe(true);
      if (ref.entity) expect(eventVisible(f.store.getState(), actor, ref.entity, ref.id, {})).toBe(true);
      // A request event may also be authorized through a visible item. Revoke
      // that source permission as well when withdrawing the whole request.
      await f.store.transaction((state) => ({ state: { ...state, accessGroups: state.accessGroups.map((group) => group.id === originalGroup.id ? { ...group, permissions: group.permissions.filter((permission) => permission !== ref.permission && !(ref.type === "DIAGNOSTIC_REQUEST" && permission === "item.view")) } : group) }, result: undefined }));
      await expect(f.service.putWorkActivityPreference(actor, input)).rejects.toMatchObject({ status: 404 });
      await expect(f.service.listWorkActivityPreferences(actor, { targetType: ref.type, targetId: ref.id })).rejects.toMatchObject({ status: 404 });
      expect(eventVisible(f.store.getState(), actor, "WorkActivityPreference", saved.preference.id, { targetId: "forged" })).toBe(false);
      expect(eventVisible(f.store.getState(), actor, "WorkNotification", notice.id, {})).toBe(false);
      if (ref.entity) expect(eventVisible(f.store.getState(), actor, ref.entity, ref.id, {}), ref.type).toBe(false);
      await f.store.transaction((state) => ({ state: { ...state, accessGroups: state.accessGroups.map((group) => group.id === originalGroup.id ? originalGroup : group) }, result: undefined }));
    }
    expect((await f.service.listWorkActivityPreferences(actor, { mode: "NOTES" })).total).toBe(14);
    expect((await f.service.listWorkActivityPreferences(f.user("vet-b"))).items).toEqual([]);
    expect(JSON.stringify(f.store.getState().auditEvents)).not.toContain("private-HOSPITAL");
  });

  it("does not expose private entities through technical or global administration audit fallbacks", async () => {
    const f = await references(); const actor = f.user("user-vet");
    const preference = await f.service.putWorkActivityPreference(actor, { targetType: "HOSPITAL_TASK", targetId: f.task.id, favorite: true, expectedVersion: 0, idempotencyKey: "private" });
    const settings = await f.service.putWorkNotificationPreferences(actor, { mutedEvents: [], expectedVersion: 0, idempotencyKey: "notice-settings" });
    await f.store.transaction((state) => ({ state: appendWorkNotifications(state, { sourceKey: "own-notice", targetType: "HOSPITAL_TASK", targetId: f.task.id, eventType: "TASK_CHANGED", recipientUserIds: [actor.id], createdAt: new Date().toISOString() }), result: undefined }));
    const notice = f.store.getState().workNotifications.at(-1)!;
    const comment = await f.service.createHospitalTaskComment(actor, f.task.id, { body: "Comentário restrito", expectedVersion: 2, idempotencyKey: "authority-comment" });
    const bytes = Buffer.from("%PDF-1.7\nsynthetic\n");
    const attachment = await f.service.createHospitalTaskAttachmentSession(actor, f.task.id, { filename: "synthetic.pdf", mimeType: "application/pdf", sizeBytes: bytes.length, checksum: createHash("sha256").update(bytes).digest("hex"), expectedVersion: 2, idempotencyKey: "authority-attachment" });
    const privateEntities = [{ entityType: "WorkActivityPreference", entityId: preference.preference.id }, { entityType: "WorkNotificationPreference", entityId: settings.id }, { entityType: "WorkNotification", entityId: notice.id }, { entityType: "UserWorkInbox", entityId: actor.id }];
    for (const id of [actor.id, "vet-b", "user-admin", "super"]) {
      const current = requireActiveUser(f.store.getState(), f.user(id)); const scope = auditScopeForActor(f.store.getState(), current);
      for (const entity of privateEntities) {
        expect(auditEventWithinScope(scope, entity)).toBe(id === actor.id);
        expect(eventVisible(f.store.getState(), f.user(id), entity.entityType, entity.entityId, {})).toBe(id === actor.id);
      }
    }
    for (const [entityType, entityId] of [["HospitalTaskComment", comment.comment.id], ["HospitalTaskAttachment", attachment.attachment.id]] as const) {
      expect(eventVisible(f.store.getState(), actor, entityType, entityId, {})).toBe(true);
      expect(auditEventWithinScope(auditScopeForActor(f.store.getState(), requireActiveUser(f.store.getState(), actor)), { entityType, entityId })).toBe(true);
      expect(eventVisible(f.store.getState(), f.user("user-lab"), entityType, entityId, { departmentCode: "LABORATORY" })).toBe(false);
    }
    const before = structuredClone(f.store.getState());
    await f.store.transaction((state) => ({ state: { ...state, users: state.users.map((entry) => entry.id === actor.id ? { ...entry, active: false } : entry) }, result: undefined }));
    expect(eventVisible(f.store.getState(), actor, "HospitalTask", f.task.id, {})).toBe(false);
    await expect(f.service.listWorkActivityPreferences(actor)).rejects.toMatchObject({ status: 401 });
    expect(f.store.getState().workActivityPreferences).toEqual(before.workActivityPreferences);
  });

  it("redacts historical patient, calendar, parent, template and shift references after present rights disappear", async () => {
    const f = await references(); const actor = f.user("user-vet"); const state = f.store.getState();
    const event = { id: "historical-context", eventType: "HospitalTaskContextChanged", entityType: "HospitalTask", entityId: f.task.id, occurredAt: new Date().toISOString(), correlationId: "synthetic", metadata: { patientId: "patient-thor", previousPatientId: "patient-mel", encounterId: "encounter-thor", previousEncounterId: "encounter-mel", shiftId: f.shift.id, previousShiftId: f.shift.id, templateId: f.template.id, parentTaskId: f.task.id, previousParentTaskId: "missing", targetType: "HOSPITAL_TASK", targetId: f.task.id, resourceIds: JSON.stringify(["private-resource"]), scheduleId: "private-schedule", scheduleVersion: 1, startsAt: "2026-10-11T08:00:00Z", endsAt: "2026-10-11T10:00:00Z", entryCount: 99, version: 4 } };
    const visible = redactPlannerAuditEvent(state, requireActiveUser(state, actor), event);
    expect(visible.metadata).toMatchObject({ patientId: "patient-thor", shiftId: f.shift.id, templateId: f.template.id, parentTaskId: f.task.id, scheduleId: "private-schedule" });
    expect(visible.metadata).not.toHaveProperty("entryCount"); expect(visible.metadata).not.toHaveProperty("previousParentTaskId");
    await f.store.transaction((current) => ({ state: { ...current, accessGroups: current.accessGroups.map((group) => group.id === actor.accessGroupId ? { ...group, permissions: group.permissions.filter((permission) => !["patient.view", "hospital_calendar.view", "shift.view", "checklist_template.view", "hospital_task.view"].includes(permission)) } : group) }, result: undefined }));
    const redacted = redactPlannerAuditEvent(f.store.getState(), requireActiveUser(f.store.getState(), actor), event);
    expect(redacted.metadata).toEqual({ targetType: "HOSPITAL_TASK", version: 4 });
    expect(event.metadata).toHaveProperty("patientId", "patient-thor");
    const diagnostic = { ...event, metadata: { targetType: "DIAGNOSTIC_ITEM", targetId: state.items[0].id } };
    expect(redactPlannerAuditEvent(state, requireActiveUser(state, actor), diagnostic).metadata).toEqual(diagnostic.metadata);
    expect(redactPlannerAuditEvent(state, actor, { ...event, entityType: "WorkActivityPreference" }).metadata).toEqual(event.metadata);
  });
});
