import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { systemGroupId } from "../security/access-group-policy";
import { createApplicationService } from "./service";
import { generateDueHospitalRecurrences } from "./hospital-recurrence-service";

function setup() {
  const state = createDemoState(); const vet = state.users.find((user) => user.id === "user-vet")!; state.users.push({ ...vet, id: "super", role: "SUPERADMIN", accessGroupId: systemGroupId("SUPERADMIN") }, { ...vet, id: "viewer", role: "VIEWER", accessGroupId: systemGroupId("VIEWER") });
  const store = new MemoryStore(state); const service = createApplicationService(store); const actor = (id = "user-vet") => store.getState().users.find((user) => user.id === id)!;
  const template = async (key = "routine", clinical = false) => {
    const created = await service.createHospitalChecklistTemplate(actor("user-admin"), { code: key, name: key, departmentCode: "INPATIENT", careContextRequired: clinical, steps: [{ code: "VERIFY", label: "Conferir", required: true, evidenceRequired: true }, { code: "OPTIONAL", label: "Observação opcional", required: false, evidenceRequired: false }], ...(clinical ? { clinicalProcess: { modality: "CARE" as const, allowedExecutorRoles: ["VETERINARIAN" as const], clinicalSystemReference: "Prontuário homologado", confirmationPolicyReference: "Política clínica vigente" } } : {}), idempotencyKey: `create-${key}` });
    return service.approveHospitalChecklistTemplate(actor(), created.template.id, { expectedVersion: 1, idempotencyKey: `approve-${key}` });
  };
  const task = (templateId: string, key = "task", clinical = false) => service.createHospitalTask(actor(), { title: key, typeId: "hospital-task-type-routine", departmentCode: "INPATIENT", responsibleUserId: "user-vet", checklistTemplateId: templateId, priority: "ROUTINE", ...(clinical ? { patientId: "patient-thor", encounterId: "encounter-thor" } : {}), idempotencyKey: key });
  return { store, service, actor, template, task };
}
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime("2026-10-11T12:00:00Z"); }); afterEach(() => vi.useRealTimers());
describe("approved checklist snapshots and durable recurring work", () => {
  it("closes routine reservations atomically on completion or cancellation and hides calendar metadata after revocation", async () => {
    const { store, service, actor, template, task } = setup(); const approved = await template();
    const resource = await service.createHospitalResource(actor("user-admin"), { code: "SUPPLY_ROOM", name: "Sala de conferência", kind: "ROOM", departmentCode: "INPATIENT", availabilityWindows: [{ startsAt: "2026-10-11T12:00:00Z", endsAt: "2026-10-11T14:00:00Z" }], idempotencyKey: "room" });
    const completed = await task(approved.template.id, "finish-booking"); const booking = await service.reserveHospitalTaskSchedule(actor(), completed.task.id, { startsAt: "2026-10-11T12:00:00Z", endsAt: "2026-10-11T13:00:00Z", resourceIds: [resource.id], expectedVersion: 1, idempotencyKey: "book" }); expect((await service.getHospitalTask(actor(), completed.task.id)).reservations?.map((entry) => entry.id)).toEqual([booking.id]);
    await service.commandHospitalTask(actor(), completed.task.id, { command: "START", expectedVersion: 1, idempotencyKey: "start" }); await service.recordHospitalChecklistStep(actor(), completed.task.id, { stepCode: "VERIFY", command: "DONE", evidenceText: "Conferido", expectedVersion: 2, idempotencyKey: "evidence" }); await service.commandHospitalTask(actor(), completed.task.id, { command: "COMPLETE", expectedVersion: 3, idempotencyKey: "finish" }); expect(store.getState().schedules.find((entry) => entry.id === booking.id)).toMatchObject({ status: "COMPLETED", version: 2 });
    const cancelled = await task(approved.template.id, "cancel-booking"); const nextBooking = await service.reserveHospitalTaskSchedule(actor(), cancelled.task.id, { startsAt: "2026-10-11T12:00:00Z", endsAt: "2026-10-11T13:00:00Z", resourceIds: [resource.id], expectedVersion: 1, idempotencyKey: "book-again" }); await service.commandHospitalTask(actor(), cancelled.task.id, { command: "CANCEL", reason: "Atividade dispensada", expectedVersion: 1, idempotencyKey: "cancel" }); expect(store.getState().schedules.find((entry) => entry.id === nextBooking.id)).toMatchObject({ status: "CANCELLED", version: 2, reason: "Atividade dispensada" });
    await store.transaction((state) => ({ state: { ...state, accessGroups: state.accessGroups.map((group) => group.id === systemGroupId("VETERINARIAN") ? { ...group, permissions: group.permissions.filter((permission) => permission !== "hospital_calendar.view") } : group) }, result: undefined })); expect((await service.getHospitalTask(actor(), cancelled.task.id)).reservations).toBeUndefined(); expect(JSON.stringify(await service.getHospitalTaskHistory(actor(), cancelled.task.id))).not.toContain(nextBooking.id);
  });
  it("requires clinical approval, evidence and mandatory steps, preserving the original snapshot after editing", async () => {
    const { store, service, actor, template, task } = setup(); const approved = await template();
    const created = await task(approved.template.id); const frozen = structuredClone(created.task.checklistSnapshot);
    await expect(service.approveHospitalChecklistTemplate(actor("user-admin"), approved.template.id, { expectedVersion: approved.template.version, idempotencyKey: "admin-approve" })).rejects.toMatchObject({ status: 404 });
    const started = await service.commandHospitalTask(actor(), created.task.id, { command: "START", expectedVersion: 1, idempotencyKey: "start" });
    await expect(service.commandHospitalTask(actor(), created.task.id, { command: "COMPLETE", expectedVersion: started.task.version, idempotencyKey: "omit" })).rejects.toMatchObject({ code: "CHECKLIST_PENDING", status: 409 });
    await expect(service.recordHospitalChecklistStep(actor(), created.task.id, { stepCode: "VERIFY", command: "DONE", expectedVersion: 2, idempotencyKey: "no-evidence" })).rejects.toMatchObject({ status: 400 });
    const done = await service.recordHospitalChecklistStep(actor(), created.task.id, { stepCode: "VERIFY", command: "DONE", evidenceText: "Conferência registrada", expectedVersion: 2, idempotencyKey: "done" });
    expect(done.task.checklistExecutions?.[0]).toMatchObject({ actorId: "user-vet", executedAt: "2026-10-11T12:00:00.000Z", status: "DONE" });
    const updated = await service.updateHospitalChecklistTemplate(actor("user-admin"), approved.template.id, { name: "Revisado", steps: [{ code: "OTHER", label: "Outra etapa", required: true, evidenceRequired: false }], expectedVersion: 2, idempotencyKey: "revision" }); expect(updated.template).toMatchObject({ status: "DRAFT", approvedBy: undefined });
    expect(store.getState().hospitalTasks[0].checklistSnapshot).toEqual(frozen); await expect(task(approved.template.id, "unapproved-new")).rejects.toMatchObject({ code: "CHECKLIST_NOT_APPROVED" });
    const completed = await service.commandHospitalTask(actor(), created.task.id, { command: "COMPLETE", expectedVersion: done.task.version, idempotencyKey: "complete" }); expect(completed.task.phase).toBe("COMPLETED"); expect(store.getState().results).toEqual([]);
  });
  it("records invalidation without deleting evidence and rejects generic clinical completion", async () => {
    const { store, service, actor, template, task } = setup(); const approved = await template("care", true); const created = await task(approved.template.id, "care-task", true);
    const started = await service.commandHospitalTask(actor(), created.task.id, { command: "START", expectedVersion: 1, idempotencyKey: "start" }); const done = await service.recordHospitalChecklistStep(actor(), created.task.id, { stepCode: "VERIFY", command: "DONE", evidenceText: "Prontuário conferido", expectedVersion: started.task.version, idempotencyKey: "done" });
    expect(done.permissions).toContain("care.execute"); await expect(service.commandHospitalTask(actor(), created.task.id, { command: "COMPLETE", expectedVersion: done.task.version, idempotencyKey: "bypass" })).rejects.toMatchObject({ code: "CLINICAL_CONFIRMATION_REQUIRED" });
    const voided = await service.recordHospitalChecklistStep(actor(), created.task.id, { stepCode: "VERIFY", command: "VOID", reason: "Evidência selecionada incorretamente", expectedVersion: done.task.version, idempotencyKey: "void" }); expect(voided.task.checklistExecutions?.[0]).toMatchObject({ status: "VOIDED", actorId: "user-vet", voidedBy: "user-vet", voidReason: "Evidência selecionada incorretamente" }); expect(store.getState().results).toEqual([]);
    await expect(service.recordHospitalChecklistStep(actor("viewer"), created.task.id, { stepCode: "VERIFY", command: "DONE", evidenceText: "spoof", expectedVersion: voided.task.version, idempotencyKey: "viewer" })).rejects.toMatchObject({ status: 404 });
    await expect(service.assignHospitalTask(actor("super"), created.task.id, { responsibleUserId: "user-manager", expectedVersion: voided.task.version, idempotencyKey: "unapproved-role" })).rejects.toMatchObject({ status: 404 });
  });
  it("rejects approval spoofing, technical clinical execution and malformed eligibility references", async () => {
    const { service, actor, template, task } = setup(); const approved = await template("care", true);
    await expect(task(approved.template.id, "missing-context")).rejects.toMatchObject({ status: 400 });
    await expect(service.createHospitalChecklistTemplate(actor("user-admin"), { code: "BAD", name: "Bad", departmentCode: "INPATIENT", careContextRequired: true, steps: [{ code: "OK", label: "Ok", required: true, evidenceRequired: false }], clinicalProcess: { modality: "PROCEDURE", allowedExecutorRoles: ["ADMIN"], clinicalSystemReference: "Record", confirmationPolicyReference: "Policy" }, idempotencyKey: "bad" })).rejects.toMatchObject({ status: 400 });
    await expect(service.createHospitalChecklistTemplate(actor(), { code: "SPOOF", name: "Spoof", departmentCode: "INPATIENT", careContextRequired: false, steps: [{ code: "OK", label: "Ok", required: true, evidenceRequired: false }], approvedBy: "someone", status: "APPROVED", idempotencyKey: "spoof" } as Parameters<typeof service.createHospitalChecklistTemplate>[1])).rejects.toMatchObject({ status: 400 });
    const created = await task(approved.template.id, "real-care", true); await expect(service.commandHospitalTask(actor("user-admin"), created.task.id, { command: "START", expectedVersion: 1, idempotencyKey: "technical" })).rejects.toMatchObject({ status: 404 });
  });
  it("catches up across day and shift boundaries with atomic occurrence keys and bounded retries", async () => {
    const { store, service, actor, template } = setup(); const approved = await template(); const recurrence = await service.createHospitalRecurrence(actor(), { templateId: approved.template.id, departmentCode: "INPATIENT", title: "Conferir estoque", priority: "ROUTINE", responsibleUserId: "user-vet", startAt: "2026-10-10T23:00:00-03:00", intervalMinutes: 60, endAt: "2026-10-11T09:00:00Z", idempotencyKey: "recurrence" });
    const first = await generateDueHospitalRecurrences(store, { limit: 2 }); expect(first).toMatchObject({ generated: 2, pending: 5 });
    const reports = await Promise.all([generateDueHospitalRecurrences(store), generateDueHospitalRecurrences(store)]); expect(reports.reduce((total, report) => total + report.generated, 0)).toBe(5); expect(store.getState().hospitalTasks).toHaveLength(7);
    const keys = store.getState().hospitalTasks.map((task) => `${task.recurrenceId}:${task.occurrenceAt}`); expect(new Set(keys).size).toBe(7); expect(store.getState().hospitalTasks.every((task) => task.recurrenceId === recurrence.recurrence.id && task.checklistSnapshot?.templateVersion === 2)).toBe(true);
    expect(await generateDueHospitalRecurrences(store)).toMatchObject({ generated: 0, alreadyGenerated: 0, pending: 0 }); expect(store.getState().items).toEqual([]);
  });
  it("retains blocked cursors after owner revocation and resumes without rewriting past executions", async () => {
    const { store, service, actor, template } = setup(); const approved = await template(); const created = await service.createHospitalRecurrence(actor(), { templateId: approved.template.id, departmentCode: "INPATIENT", title: "Recorrência bloqueada", priority: "ROUTINE", startAt: "2026-10-11T11:00:00Z", intervalMinutes: 60, idempotencyKey: "recurrence" });
    await store.transaction((state) => ({ state: { ...state, accessGroups: state.accessGroups.map((group) => group.id === systemGroupId("VETERINARIAN") ? { ...group, permissions: group.permissions.filter((permission) => permission !== "hospital_task.create") } : group) }, result: undefined }));
    expect(await generateDueHospitalRecurrences(store)).toMatchObject({ generated: 0, blocked: 1, pending: 2 }); expect(store.getState().hospitalRecurrences[0]).toMatchObject({ nextOccurrenceAt: created.recurrence.nextOccurrenceAt, lastError: "SCOPE_DENIED" }); expect(store.getState().hospitalTasks).toEqual([]);
    const original = createDemoState().accessGroups.find((group) => group.id === systemGroupId("VETERINARIAN"))!; await store.transaction((state) => ({ state: { ...state, accessGroups: state.accessGroups.map((group) => group.id === original.id ? original : group) }, result: undefined }));
    expect(await generateDueHospitalRecurrences(store)).toMatchObject({ generated: 2, pending: 0 }); const frozen = structuredClone(store.getState().hospitalTasks);
    await service.retireHospitalChecklistTemplate(actor(), approved.template.id, { expectedVersion: 2, idempotencyKey: "retire" }); vi.setSystemTime("2026-10-11T13:00:00Z"); expect(await generateDueHospitalRecurrences(store)).toMatchObject({ generated: 0, blocked: 1, pending: 1 }); expect(store.getState().hospitalTasks).toEqual(frozen);
    const stopped = await service.updateHospitalRecurrence(actor(), created.recurrence.id, { active: false, expectedVersion: store.getState().hospitalRecurrences[0].version, idempotencyKey: "stop" }); expect(stopped.recurrence.active).toBe(false);
  });
  it("keeps generation and option metadata inside current grants and denies future generation", async () => {
    const { store, service, actor, template } = setup(); const approved = await template();
    await service.createHospitalRecurrence(actor(), { templateId: approved.template.id, departmentCode: "INPATIENT", title: "Routine", priority: "ROUTINE", startAt: "2026-10-11T12:00:00Z", intervalMinutes: 60, idempotencyKey: "recurrence" });
    await expect(service.generateHospitalRecurrences(actor(), { asOf: "2026-10-12T12:00:00Z", idempotencyKey: "future" })).rejects.toMatchObject({ status: 400 }); await expect(service.generateHospitalRecurrences(actor("user-admin"), { idempotencyKey: "admin" })).rejects.toMatchObject({ status: 404 });
    const generated = await service.generateHospitalRecurrences(actor(), { idempotencyKey: "api-generate" }); expect(generated.generated).toBe(1); expect(await service.generateHospitalRecurrences(actor(), { idempotencyKey: "api-generate" })).toEqual(generated); await expect(service.generateHospitalRecurrences(actor(), { limit: 2, idempotencyKey: "api-generate" })).rejects.toMatchObject({ status: 409 });
    await store.transaction((state) => ({ state: { ...state, accessGroups: state.accessGroups.map((group) => group.id === systemGroupId("VETERINARIAN") ? { ...group, permissions: ["plan.create"] } : group) }, result: undefined }));
    const options = await service.listHospitalPlannerOptions(actor(), "plan.create"); expect(options.departments.map((entry) => entry.code)).toContain("LABORATORY"); expect(JSON.stringify(options)).not.toMatch(/passwordHash|patientIds|whatsappPhone/); await expect(service.listHospitalTasks(actor())).rejects.toMatchObject({ status: 404 });
  });
});

describe("checklist concurrency, replay and evidence ownership", () => {
  it("replays an approved intent without issuing a second approval and refuses independent reapproval", async () => {
    const f = setup(); const input = { code: "SAFE_REPLAY", name: "Conferência", departmentCode: "INPATIENT", careContextRequired: false, steps: [{ code: "VERIFY", label: "Conferir", required: true, evidenceRequired: false }], idempotencyKey: "create-safe" };
    const created = await f.service.createHospitalChecklistTemplate(f.actor("user-admin"), input); expect((await f.service.createHospitalChecklistTemplate(f.actor("user-admin"), input)).template.id).toBe(created.template.id);
    const approve = { expectedVersion: 1, idempotencyKey: "approve-safe" }; const approved = await f.service.approveHospitalChecklistTemplate(f.actor(), created.template.id, approve); expect((await f.service.approveHospitalChecklistTemplate(f.actor(), created.template.id, approve)).template).toEqual(approved.template);
    await expect(f.service.approveHospitalChecklistTemplate(f.actor(), created.template.id, { expectedVersion: 2, idempotencyKey: "independent-approval" })).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    await expect(f.service.createHospitalChecklistTemplate(f.actor("user-admin"), { ...input, idempotencyKey: "duplicate-code" })).rejects.toMatchObject({ code: "CONFLICT" });
    const edit = { name: "Nova conferência", expectedVersion: 2, idempotencyKey: "edit-safe" }; const updated = await f.service.updateHospitalChecklistTemplate(f.actor("user-admin"), created.template.id, edit); expect(updated.template.steps).toEqual(input.steps); expect((await f.service.updateHospitalChecklistTemplate(f.actor("user-admin"), created.template.id, edit)).template).toEqual(updated.template);
    expect(f.store.getState().auditEvents.filter((event) => event.eventType === "HospitalChecklistTemplateApproved")).toHaveLength(1);
  });

  it("removes a clinical process only from its revised definition while keeping previously captured clinical authority", async () => {
    const f = setup(); const approved = await f.template("CLINICAL_DEFINITION", true); const previousTask = await f.task(approved.template.id, "frozen-care", true);
    const edited = await f.service.updateHospitalChecklistTemplate(f.actor("user-admin"), approved.template.id, { clinicalProcess: null, careContextRequired: false, expectedVersion: 2, idempotencyKey: "clear-process" }); expect(edited.template.clinicalProcess).toBeUndefined(); expect(edited.template.status).toBe("DRAFT");
    expect(f.store.getState().hospitalTasks.find((task) => task.id === previousTask.task.id)?.checklistSnapshot?.clinicalProcess).toEqual(approved.template.clinicalProcess);
    await expect(f.task(approved.template.id, "requires-new-approval")).rejects.toMatchObject({ code: "CHECKLIST_NOT_APPROVED" });
  });

  it("allows optional evidence, prevents cross-author invalidation and retains unrelated evidence when management voids one step", async () => {
    const f = setup(); const approved = await f.template(); const task = await f.task(approved.template.id);
    await f.store.transaction((state) => ({ state: { ...state, users: [...state.users, { ...state.users.find((user) => user.id === "user-vet")!, id: "vet-b", email: "vet-b@example.test" }], departments: state.departments.map((department) => department.code === "INPATIENT" ? { ...department, memberUserIds: [...department.memberUserIds, "vet-b"] } : department) }, result: undefined }));
    await expect(f.service.recordHospitalChecklistStep(f.actor("vet-b"), task.task.id, { stepCode: "OPTIONAL", command: "DONE", expectedVersion: 1, idempotencyKey: "not-on-team" })).rejects.toMatchObject({ status: 404 });
    const assigned = await f.service.assignHospitalTask(f.actor("super"), task.task.id, { responsibleUserId: "user-vet", executorTeamUserIds: ["vet-b"], expectedVersion: 1, idempotencyKey: "team" });
    const first = await f.service.recordHospitalChecklistStep(f.actor(), task.task.id, { stepCode: "OPTIONAL", command: "DONE", expectedVersion: assigned.task.version, idempotencyKey: "optional" }); expect(first.task.checklistExecutions?.[0].evidenceText).toBeUndefined();
    const second = await f.service.recordHospitalChecklistStep(f.actor(), task.task.id, { stepCode: "VERIFY", command: "DONE", evidenceText: "Conferência real sintética", expectedVersion: first.task.version, idempotencyKey: "required" });
    await expect(f.service.recordHospitalChecklistStep(f.actor("vet-b"), task.task.id, { stepCode: "OPTIONAL", command: "VOID", reason: "Outro autor", expectedVersion: second.task.version, idempotencyKey: "other-author" })).rejects.toMatchObject({ status: 404 });
    const voidInput = { stepCode: "OPTIONAL", command: "VOID" as const, reason: "Evidência registrada em etapa indevida", expectedVersion: second.task.version, idempotencyKey: "manager-void" };
    const voided = await f.service.recordHospitalChecklistStep(f.actor("user-manager"), task.task.id, voidInput); expect(voided.task.checklistExecutions).toMatchObject([{ status: "VOIDED", voidedBy: "user-manager" }, { status: "DONE", evidenceText: "Conferência real sintética" }]); expect((await f.service.recordHospitalChecklistStep(f.actor("user-manager"), task.task.id, voidInput)).task.version).toBe(voided.task.version);
    await expect(f.service.recordHospitalChecklistStep(f.actor(), task.task.id, { ...voidInput, expectedVersion: voided.task.version, idempotencyKey: "double-void" })).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
