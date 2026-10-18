import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { systemGroupId } from "../security/access-group-policy";
import { createApplicationService } from "./service";
import { createHospitalTaskCommentService } from "./hospital-task-comment-service";
import { createHospitalTaskAttachmentService } from "./hospital-task-attachment-service";
import { createWorkActivityService } from "./work-activity-service";
import { createWorkNotificationService } from "./work-notification-service";
import { appendDueTaskNotifications, appendWorkNotifications } from "./work-notification-policy";
import { auditEventWithinScope, auditScopeForActor } from "./audit-read";
import { eventVisible } from "./realtime-visibility";
import type { ApplicationServiceContext } from "./service-context";
import { requireActiveUser } from "./service-common";

function setup() {
  const state = createDemoState(); const vet = state.users.find((entry) => entry.id === "user-vet")!;
  state.users.push({ ...vet, id: "vet-b", email: "vet-b@example.test" }, { ...vet, id: "viewer", email: "viewer@example.test", role: "VIEWER", accessGroupId: systemGroupId("VIEWER") }, { ...vet, id: "super", role: "SUPERADMIN", accessGroupId: systemGroupId("SUPERADMIN") });
  state.departments.find((entry) => entry.code === "INPATIENT")!.memberUserIds.push("vet-b");
  const store = new MemoryStore(state); const files = new Map<string, Buffer>();
  const storage = { put: vi.fn(async (key: string, content: Uint8Array) => { files.set(key, Buffer.from(content)); }), get: vi.fn(async (key: string) => { const file = files.get(key); if (!file) throw new Error("MISSING"); return file; }), remove: vi.fn(async (key: string) => { files.delete(key); }), exists: async (key: string) => files.has(key) };
  const scanner = { scan: vi.fn(async () => "CLEAN" as "CLEAN" | "QUARANTINED" | "FAILED") }; const context: ApplicationServiceContext = { store, storage, scanner, patientDiagnosticsAuxiliaryReader: () => ({ samples: [], results: [], attachments: [] }) };
  const service = { ...createApplicationService(store, { storage }), ...createHospitalTaskCommentService(context), ...createHospitalTaskAttachmentService(context), ...createWorkActivityService(context), ...createWorkNotificationService(context) };
  const user = (id = "user-vet") => store.getState().users.find((entry) => entry.id === id)!;
  const task = (key = "task", care = false) => service.createHospitalTask(user(), { title: "Rotina sintética restrita", typeId: care ? "hospital-task-type-care" : "hospital-task-type-routine", departmentCode: "INPATIENT", priority: "ROUTINE", responsibleUserId: "user-vet", ...(care ? { patientId: "patient-thor", encounterId: "encounter-thor" } : {}), idempotencyKey: key });
  const revoke = (permission: string) => store.transaction((current) => ({ state: { ...current, accessGroups: current.accessGroups.map((group) => group.id === systemGroupId("VETERINARIAN") ? { ...group, permissions: group.permissions.filter((entry) => entry !== permission) } : group) }, result: undefined }));
  const pdf = Buffer.from("%PDF-1.7\nsynthetic hospital attachment\n");
  const session = async (taskId: string, key = "upload") => service.createHospitalTaskAttachmentSession(user(), taskId, { filename: "../../synthetic.pdf", mimeType: "application/pdf", sizeBytes: pdf.length, checksum: createHash("sha256").update(pdf).digest("hex"), expectedVersion: 1, idempotencyKey: key });
  return { store, service, user, task, revoke, context, storage, scanner, files, pdf, session };
}
describe("hospital collaboration and private work references", () => {
  it("preserves comment authorship and immutable edits, denies cross-author changes, and gives moderators a reasoned tombstone", async () => {
    const { service, user, task, store } = setup(); const created = await task();
    const comment = await service.createHospitalTaskComment(user(), created.task.id, { body: "Primeira anotação sintética", expectedVersion: 1, idempotencyKey: "comment" });
    await expect(service.updateHospitalTaskComment(user("vet-b"), created.task.id, comment.comment.id, { body: "Spoof", expectedVersion: 1, idempotencyKey: "spoof" })).rejects.toMatchObject({ status: 404 });
    const results = await Promise.allSettled([service.updateHospitalTaskComment(user(), created.task.id, comment.comment.id, { body: "Correção A", expectedVersion: 1, idempotencyKey: "edit-a" }), service.updateHospitalTaskComment(user(), created.task.id, comment.comment.id, { body: "Correção B", expectedVersion: 1, idempotencyKey: "edit-b" })]);
    expect(results.filter((entry) => entry.status === "fulfilled")).toHaveLength(1); expect(results.find((entry) => entry.status === "rejected")).toMatchObject({ reason: { status: 409 } });
    const edited = store.getState().hospitalTaskComments[0]; expect(edited.authorId).toBe("user-vet"); expect(edited.revisions[0].body).toBe("Primeira anotação sintética");
    await expect(service.deleteHospitalTaskComment(user("super"), created.task.id, edited.id, { expectedVersion: 2, idempotencyKey: "missing-reason" })).rejects.toMatchObject({ status: 400 });
    const deleted = await service.deleteHospitalTaskComment(user("super"), created.task.id, edited.id, { expectedVersion: 2, reason: "Conteúdo indevido", idempotencyKey: "moderate" }); expect(deleted.comment.body).toBe(""); expect(deleted.comment.revisions).toEqual([]); expect(store.getState().hospitalTaskComments[0].body).toMatch(/Correção/);
    expect(JSON.stringify(store.getState().outbox)).not.toContain("Correção"); expect(JSON.stringify(store.getState().auditEvents)).not.toContain("Primeira anotação");
  });
  it("validates mentioned professionals, freezes the context with conversation history, and revokes comment replay and SSE", async () => {
    const { service, user, task, store, revoke } = setup(); const created = await task("care", true);
    await expect(service.createHospitalTaskComment(user(), created.task.id, { body: "Menção negada", mentionedUserIds: ["user-lab"], expectedVersion: 1, idempotencyKey: "outside" })).rejects.toMatchObject({ status: 404 });
    const input = { body: "Equipe sintética", mentionedUserIds: ["vet-b"], expectedVersion: 1, idempotencyKey: "mention" }; const comment = await service.createHospitalTaskComment(user(), created.task.id, input);
    expect(store.getState().workNotifications).toContainEqual(expect.objectContaining({ userId: "vet-b", eventType: "TASK_MENTIONED" }));
    await expect(service.updateHospitalTaskContext(user(), created.task.id, { patientId: "patient-mel", encounterId: "encounter-mel", expectedVersion: 1, idempotencyKey: "move" })).rejects.toMatchObject({ status: 409 });
    await revoke("hospital_task.comment.view"); await expect(service.listHospitalTaskComments(user(), created.task.id)).rejects.toMatchObject({ status: 404 });
    expect(eventVisible(store.getState(), user(), "HospitalTaskComment", comment.comment.id, {})).toBe(false);
    await revoke("hospital_task.comment.create"); await expect(service.createHospitalTaskComment(user(), created.task.id, input)).rejects.toMatchObject({ status: 404 });
  });
  it("stores private favorites, following and notes per account, excluding revoked targets and administrative audit fallback", async () => {
    const { service, user, task, store, revoke } = setup(); const created = await task("care", true); const input = { targetType: "HOSPITAL_TASK" as const, targetId: created.task.id, privateNote: "PRIVATE SYNTHETIC", favorite: true, following: true, opened: true as const, expectedVersion: 0, idempotencyKey: "private" };
    const preference = await service.putWorkActivityPreference(user(), input); expect(preference.preference.version).toBe(1); expect((await service.listWorkActivityPreferences(user(), { mode: "RECENTS" })).total).toBe(1);
    expect((await service.listWorkActivityPreferences(user("vet-b"))).total).toBe(0); expect((await service.listWorkActivityPreferences(user("user-admin"))).total).toBe(0); expect(JSON.stringify(store.getState().auditEvents)).not.toContain("PRIVATE SYNTHETIC");
    const event = store.getState().auditEvents.find((entry) => entry.entityType === "WorkActivityPreference")!; expect(auditEventWithinScope(auditScopeForActor(store.getState(), user("user-admin")), event)).toBe(false); expect(auditEventWithinScope(auditScopeForActor(store.getState(), user("super")), event)).toBe(false);
    await revoke("hospital_task.view"); expect((await service.listWorkActivityPreferences(user())).total).toBe(0); await expect(service.putWorkActivityPreference(user(), input)).rejects.toMatchObject({ status: 404 });
    expect(preference.preference.lastOpenedAt).toBeDefined(); expect(store.getState().users.find((entry) => entry.id === "vet-b")!.patientIds).toEqual(["patient-thor", "patient-mel"]);
  });
  it("opens saved references through existing list pages and the authorized diagnostic item's anchor", async () => {
    const { service, user, task } = setup();
    const template = await service.createHospitalChecklistTemplate(user("user-admin"), { code: "LINK_TEMPLATE", name: "Checklist sintético", departmentCode: "INPATIENT", careContextRequired: false, steps: [{ code: "CHECK", label: "Conferir", required: true, evidenceRequired: false }], idempotencyKey: "link-template" });
    await service.approveHospitalChecklistTemplate(user(), template.template.id, { expectedVersion: 1, idempotencyKey: "link-approve" });
    const recurrence = await service.createHospitalRecurrence(user(), { templateId: template.template.id, departmentCode: "INPATIENT", title: "Rotina sintética", priority: "ROUTINE", startAt: "2026-10-11T12:00:00Z", intervalMinutes: 60, idempotencyKey: "link-recurrence" });
    const resource = await service.createHospitalResource(user("user-admin"), { code: "LINK_RESOURCE", name: "Recurso sintético", kind: "EQUIPMENT", departmentCode: "INPATIENT", availabilityWindows: [], idempotencyKey: "link-resource" });
    const request = await service.createRequest(user(), { patientId: "patient-thor", encounterId: "encounter-thor", admissionId: "admission-thor", priority: "ROUTINE", items: [{ serviceId: "service-hemogram" }] }, { idempotencyKey: "link-request" });
    const from = await service.createHospitalShift(user("super"), { name: "Origem sintética", departmentCode: "INPATIENT", startAt: "2026-10-11T06:00:00Z", endAt: "2026-10-11T12:00:00Z", members: [{ userId: "user-vet" }], idempotencyKey: "link-from" });
    const to = await service.createHospitalShift(user("super"), { name: "Destino sintético", departmentCode: "INPATIENT", startAt: "2026-10-11T12:00:00Z", endAt: "2026-10-11T18:00:00Z", members: [{ userId: "vet-b" }], idempotencyKey: "link-to" });
    const created = await task();
    await service.assignHospitalActivityShift(user("super"), { targetType: "HOSPITAL_TASK", targetId: created.task.id, shiftId: from.shift.id, expectedVersion: 1, idempotencyKey: "link-bind" });
    const handoff = await service.offerHospitalHandoff(user(), { fromShiftId: from.shift.id, toShiftId: to.shift.id, recipientUserId: "vet-b", entries: [{ targetType: "HOSPITAL_TASK", targetId: created.task.id, expectedTargetVersion: 2 }], idempotencyKey: "link-handoff" });
    const references = [
      ["HOSPITAL_HANDOFF", handoff.handoff.id, `/planner/handoffs?handoffId=${handoff.handoff.id}`],
      ["CHECKLIST_TEMPLATE", template.template.id, `/planner/checklists?templateId=${template.template.id}`],
      ["HOSPITAL_RECURRENCE", recurrence.recurrence.id, `/planner/recurrences?recurrenceId=${recurrence.recurrence.id}`],
      ["HOSPITAL_RESOURCE", resource.id, `/admin/resources?resourceId=${resource.id}`],
      ["DIAGNOSTIC_ITEM", request.items[0].id, `/requests/${request.id}#${request.items[0].id}`]
    ] as const;
    for (const [targetType, targetId, deepLink] of references) {
      const saved = await service.putWorkActivityPreference(user(), { targetType, targetId, favorite: true, expectedVersion: 0, idempotencyKey: `link-${targetType}` });
      expect(saved.target.deepLink).toBe(deepLink);
    }
    await expect(service.putWorkActivityPreference(user("user-lab"), { targetType: "HOSPITAL_RESOURCE", targetId: resource.id, favorite: true, expectedVersion: 0, idempotencyKey: "link-outside" })).rejects.toMatchObject({ status: 404 });
  });
  it("deduplicates notifications, applies current targets before counts/read-all, and never confirms critical or handoff state", async () => {
    const { service, user, task, store, revoke } = setup(); const created = await task();
    const notification = { sourceKey: "source-1", targetType: "HOSPITAL_TASK" as const, targetId: created.task.id, eventType: "TASK_CHANGED" as const, recipientUserIds: ["user-vet", "user-admin", "vet-b"], createdAt: new Date().toISOString() };
    await store.transaction((state) => ({ state: appendWorkNotifications(appendWorkNotifications(state, notification), notification), result: undefined })); expect(store.getState().workNotifications).toHaveLength(2); const before = structuredClone({ critical: store.getState().notifications, handoffs: store.getState().hospitalHandoffs });
    expect((await service.listWorkNotifications(user())).unread).toBe(1); const ownId = (await service.listWorkNotifications(user())).items[0].notification.id; const otherId = (await service.listWorkNotifications(user("vet-b"))).items[0].notification.id;
    await expect(service.markWorkNotificationsRead(user(), { notificationIds: [otherId], idempotencyKey: "other" })).rejects.toMatchObject({ status: 404 });
    expect(await service.markWorkNotificationsRead(user(), { all: true, idempotencyKey: "read-all" })).toEqual({ marked: 1 }); expect((await service.listWorkNotifications(user())).unread).toBe(0);
    await service.markWorkNotificationsRead(user(), { notificationIds: [ownId], read: false, idempotencyKey: "unread" }); expect((await service.listWorkNotifications(user())).unread).toBe(1); expect({ critical: store.getState().notifications, handoffs: store.getState().hospitalHandoffs }).toEqual(before);
    await revoke("hospital_task.view"); expect((await service.listWorkNotifications(user())).total).toBe(0); expect(await service.markWorkNotificationsRead(user(), { all: true, idempotencyKey: "revoked-read-all" })).toEqual({ marked: 0 }); expect(store.getState().workNotifications.find((entry) => entry.id === ownId)!.readAt).toBeUndefined();
  });
  it("uses versioned private preferences and archive/unarchive without changing institutional alerts", async () => {
    const { service, user, task, store } = setup(); const created = await task(); const settings = await service.putWorkNotificationPreferences(user(), { mutedEvents: ["TASK_CHANGED"], expectedVersion: 0, idempotencyKey: "mute" }); expect(settings.version).toBe(1);
    await store.transaction((state) => ({ state: appendWorkNotifications(state, { sourceKey: "muted", targetType: "HOSPITAL_TASK", targetId: created.task.id, eventType: "TASK_CHANGED", recipientUserIds: ["user-vet", "vet-b"], createdAt: new Date().toISOString() }), result: undefined })); expect((await service.listWorkNotifications(user())).total).toBe(0); expect((await service.listWorkNotifications(user("vet-b"))).total).toBe(1);
    const notice = (await service.listWorkNotifications(user("vet-b"))).items[0]; const archived = await service.setWorkNotificationArchived(user("vet-b"), notice.notification.id, { archived: true, expectedVersion: 1, idempotencyKey: "archive" }); expect((await service.listWorkNotifications(user("vet-b"))).total).toBe(0); expect((await service.listWorkNotifications(user("vet-b"), { includeArchived: true })).total).toBe(1);
    await expect(service.setWorkNotificationArchived(user("vet-b"), notice.notification.id, { archived: false, expectedVersion: 1, idempotencyKey: "stale" })).rejects.toMatchObject({ status: 409 }); await service.setWorkNotificationArchived(user("vet-b"), notice.notification.id, { archived: false, expectedVersion: archived.notification.version, idempotencyKey: "unarchive" }); expect((await service.listWorkNotifications(user("vet-b"))).unread).toBe(1);
  });
  it("creates due-task convenience notices once without executing or closing any task", async () => {
    const { service, user, task, store } = setup(); const created = await task(); const end = new Date(Date.now() - 60_000).toISOString(); await service.updateHospitalTask(user(), created.task.id, { plannedEndAt: end, expectedVersion: 1, idempotencyKey: "due" }); const before = store.getState().hospitalTasks[0]; const asOf = new Date().toISOString();
    await store.transaction((state) => ({ state: appendDueTaskNotifications(appendDueTaskNotifications(state, asOf), asOf), result: undefined })); expect(store.getState().workNotifications.filter((entry) => entry.eventType === "TASK_DUE")).toHaveLength(1); expect(store.getState().hospitalTasks[0]).toEqual(before);
  });
  it("drains more than one due-notification batch without starving later tasks or notifying drafts", async () => {
    const { task, store } = setup(); const created = await task(); const end = new Date(Date.now() - 60_000).toISOString(); const asOf = new Date().toISOString();
    await store.transaction((state) => ({ state: { ...state, hospitalTasks: [...Array.from({ length: 150 }, (_, index) => ({ ...created.task, id: `batch-task-${String(index).padStart(3, "0")}`, plannedEndAt: end })), { ...created.task, id: "draft-due", isDraft: true, plannedEndAt: end }] }, result: undefined }));
    await store.transaction((state) => ({ state: appendDueTaskNotifications(state, asOf), result: undefined })); expect(store.getState().workNotifications).toHaveLength(100);
    await store.transaction((state) => ({ state: appendDueTaskNotifications(state, asOf), result: undefined })); expect(store.getState().workNotifications).toHaveLength(150); expect(store.getState().workNotifications.some((entry) => entry.targetId === "draft-due")).toBe(false);
    await store.transaction((state) => ({ state: appendDueTaskNotifications(state, asOf), result: undefined })); expect(store.getState().workNotifications).toHaveLength(150);
  });
  it("uploads, scans and finalizes a real private task file, with opaque DTOs and independent result storage", async () => {
    const { service, user, task, session, pdf, store } = setup(); const created = await task(); const prepared = await session(created.task.id); expect(JSON.stringify(prepared)).not.toMatch(/storageKey|uploadClaim/); expect(prepared.attachment.safeName).toBe("synthetic.pdf");
    const uploaded = await service.uploadHospitalTaskAttachment(user(), prepared.attachment.id, pdf); expect(uploaded.attachment).toMatchObject({ version: 2, scanStatus: "CLEAN", uploadStatus: "UPLOADED" }); await expect(service.downloadHospitalTaskAttachment(user(), prepared.attachment.id)).rejects.toMatchObject({ status: 404 });
    const finalized = await service.finalizeHospitalTaskAttachment(user(), prepared.attachment.id, { expectedVersion: 2, idempotencyKey: "finalize" }); expect(finalized.attachment.version).toBe(3); const downloaded = await service.downloadHospitalTaskAttachment(user("viewer"), prepared.attachment.id); expect(downloaded.content.equals(pdf)).toBe(true); expect(JSON.stringify(downloaded.attachment)).not.toContain("storageKey"); expect(store.getState().attachments).toEqual([]); expect(store.getState().resultVersions).toEqual([]);
  });
  it("rejects forged checksum, quarantined MIME and scans that lose access, cleaning abandoned objects", async () => {
    const { service, user, task, session, pdf, scanner, files, revoke } = setup(); const created = await task(); const prepared = await session(created.task.id);
    await expect(service.uploadHospitalTaskAttachment(user(), prepared.attachment.id, Buffer.alloc(pdf.length))).rejects.toMatchObject({ code: "ATTACHMENT_CHECKSUM_MISMATCH" }); scanner.scan.mockResolvedValueOnce("QUARANTINED"); const quarantined = await service.uploadHospitalTaskAttachment(user(), prepared.attachment.id, pdf); expect(quarantined.attachment.scanStatus).toBe("QUARANTINED"); await expect(service.finalizeHospitalTaskAttachment(user(), prepared.attachment.id, { expectedVersion: 2, idempotencyKey: "quarantine" })).rejects.toMatchObject({ status: 422 });
    const second = await session(created.task.id, "race"); scanner.scan.mockImplementationOnce(async () => { await revoke("hospital_task.attachment.upload"); return "CLEAN"; }); await expect(service.uploadHospitalTaskAttachment(user(), second.attachment.id, pdf)).rejects.toMatchObject({ status: 404 }); expect(files.size).toBe(1); await expect(service.downloadHospitalTaskAttachment(user(), second.attachment.id)).rejects.toMatchObject({ status: 404 });
  });
  it("revalidates download access after awaiting bytes and rejects changed storage integrity", async () => {
    const { service, user, task, session, pdf, storage, store, files, revoke } = setup(); const created = await task(); const prepared = await session(created.task.id); await service.uploadHospitalTaskAttachment(user(), prepared.attachment.id, pdf); await service.finalizeHospitalTaskAttachment(user(), prepared.attachment.id, { expectedVersion: 2, idempotencyKey: "finalize" });
    storage.get.mockImplementationOnce(async (key) => { await revoke("hospital_task.attachment.download"); return files.get(key)!; }); await expect(service.downloadHospitalTaskAttachment(user(), prepared.attachment.id)).rejects.toMatchObject({ status: 404 }); expect(store.getState().auditEvents.filter((entry) => entry.eventType === "HospitalTaskAttachmentDownloaded")).toEqual([]);
    const key = store.getState().hospitalTaskAttachments[0].storageKey; files.set(key, Buffer.from("%PDF-corrupt")); await expect(service.downloadHospitalTaskAttachment(user("viewer"), prepared.attachment.id)).rejects.toMatchObject({ code: "ATTACHMENT_INTEGRITY_FAILED" });
  });
  it("serializes upload claims and permits recovery after a storage failure without attaching abandoned bytes", async () => {
    const { service, user, task, session, pdf, scanner, storage, store } = setup(); const created = await task(); const prepared = await session(created.task.id);
    storage.put.mockRejectedValueOnce(new Error("synthetic unavailable")); await expect(service.uploadHospitalTaskAttachment(user(), prepared.attachment.id, pdf)).rejects.toMatchObject({ status: 503 }); expect(store.getState().hospitalTaskAttachments[0].uploadClaimToken).toBeUndefined();
    let started!: () => void; const hasStarted = new Promise<void>((resolve) => { started = resolve; }); let finish!: (verdict: "CLEAN") => void; scanner.scan.mockImplementationOnce(async () => { started(); return new Promise<"CLEAN">((resolve) => { finish = resolve; }); });
    const uploading = service.uploadHospitalTaskAttachment(user(), prepared.attachment.id, pdf); await hasStarted; await expect(service.uploadHospitalTaskAttachment(user(), prepared.attachment.id, pdf)).rejects.toMatchObject({ code: "UPLOAD_IN_PROGRESS", status: 409 }); finish("CLEAN"); const uploaded = await uploading; expect(uploaded.attachment.scanStatus).toBe("CLEAN"); expect(store.getState().hospitalTaskAttachments[0].uploadClaimToken).toBeUndefined();
  });
  it("redacts revoked operational document snapshots from task parents, children and plans while preserving frozen stored bytes", async () => {
    const { service, user, store, revoke } = setup();
    const document = await service.createHospitalDocument(user("user-admin"), { code: "DOC_SYNTHETIC", title: "Documento sintético restrito", departmentCode: "INPATIENT", responsibleUserId: "user-vet", content: { type: "hospital-document", version: 1, blocks: [{ type: "paragraph", content: [{ text: "FROZEN SYNTHETIC CONTENT" }] }] }, idempotencyKey: "doc-create" });
    const approved = await service.approveHospitalDocument(user(), document.document.id, { confirm: true, policyReference: "synthetic-policy-only", expectedVersion: 1, expectedDraftVersion: 1, idempotencyKey: "doc-approve" });
    const input = { title: "Rotina com documento", typeId: "hospital-task-type-routine", departmentCode: "INPATIENT", priority: "ROUTINE" as const, documentIds: [approved.document.id] };
    const parent = await service.createHospitalTask(user(), { ...input, idempotencyKey: "doc-parent" }); await service.createHospitalTask(user(), { ...input, parentTaskId: parent.task.id, idempotencyKey: "doc-child" });
    const plan = await service.createHospitalPlan(user(), { title: "Plano sintético", objective: "Conferência", patientId: "patient-thor", encounterId: "encounter-thor", departmentCodes: ["INPATIENT"], documentIds: [approved.document.id], idempotencyKey: "doc-plan" }); expect((await service.getHospitalTask(user(), parent.task.id)).children[0].documentSnapshots).toHaveLength(1);
    const stored = structuredClone(store.getState().hospitalTasks.map((entry) => entry.documentSnapshots)); await revoke("hospital_document.view"); const read = await service.getHospitalTask(user(), parent.task.id); expect(read.task.documentSnapshots).toEqual([]); expect(read.children[0].documentSnapshots).toEqual([]); expect((await service.getHospitalPlan(user(), plan.plan.id)).plan.documentSnapshots).toEqual([]); expect(store.getState().hospitalTasks.map((entry) => entry.documentSnapshots)).toEqual(stored); expect(JSON.stringify(read)).not.toContain("FROZEN SYNTHETIC CONTENT"); expect(eventVisible(store.getState(), user(), "HospitalDocument", approved.document.id, {})).toBe(false);
    const scope = auditScopeForActor(store.getState(), requireActiveUser(store.getState(), user())); expect(scope.entities).not.toContainEqual({ entityType: "HospitalDocument", entityId: approved.document.id });
  });
});
