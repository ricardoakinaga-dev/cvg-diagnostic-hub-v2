import { describe, expect, it } from "vitest";
import { ROLES, type RoleCode } from "@cvg/contracts";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { systemGroupId } from "../security/access-group-policy";
import { createApplicationService } from "./service";
import { eventVisible } from "./realtime-visibility";
import { auditScopeForActor } from "./audit-read";
import { hospitalTaskCreateSchema, hospitalTaskCommandSchema } from "../http/hospital-task-schemas";
import type { HospitalTaskCreateInput } from "./hospital-task-types";

function setup() {
  const state = createDemoState();
  const base = state.users.find((user) => user.role === "VETERINARIAN")!;
  state.users.push({ ...base, id: "vet-b", email: "vet-b@example.test" }, { ...base, id: "viewer", email: "viewer@example.test", role: "VIEWER", accessGroupId: systemGroupId("VIEWER") }, { ...base, id: "super", email: "super@example.test", role: "SUPERADMIN", accessGroupId: systemGroupId("SUPERADMIN"), departmentCode: "IT" });
  state.departments.find((department) => department.code === "INPATIENT")!.memberUserIds.push("vet-b");
  const store = new MemoryStore(state); const service = createApplicationService(store);
  const user = (id: string) => store.getState().users.find((entry) => entry.id === id)!;
  const create = (key: string, input: Partial<HospitalTaskCreateInput> = {}) => service.createHospitalTask(user("user-vet"), { title: "Conferir estoque do setor", typeId: "hospital-task-type-routine", departmentCode: "INPATIENT", priority: "ROUTINE", responsibleUserId: "user-vet", idempotencyKey: key, ...input });
  return { store, service, user, create };
}

describe("hospital task authority, scope and workflow", () => {
  it("creates, locates, starts and completes a real routine without any diagnostic surrogate", async () => {
    const { store, service, user, create } = setup(); const task = await create("routine");
    const started = await service.commandHospitalTask(user("user-vet"), task.task.id, { command: "START", expectedVersion: 1, idempotencyKey: "start" });
    const completed = await service.commandHospitalTask(user("user-vet"), task.task.id, { command: "COMPLETE", note: "Estoque conferido", expectedVersion: started.task.version, idempotencyKey: "complete" });
    expect(completed.task).toMatchObject({ phase: "COMPLETED", authorId: "user-vet", responsibleUserId: "user-vet", startedBy: "user-vet", completedBy: "user-vet", completionNote: "Estoque conferido" });
    expect(completed.task.startedAt! <= completed.task.completedAt!).toBe(true);
    expect((await service.listHospitalTasks(user("viewer"))).items[0].permissions).toEqual(["hospital_task.view", "hospital_calendar.view", "hospital_task.comment.view", "hospital_task.attachment.view", "hospital_task.attachment.download"]);
    expect((await service.searchPlanner(user("viewer"), task.task.taskCode, { types: ["HOSPITAL_TASK"] })).total).toBe(1);
    expect(store.getState().services).toHaveLength(4); expect(store.getState().items).toEqual([]); expect(store.getState().requests).toEqual([]);
    expect(store.getState().auditEvents.filter((event) => event.entityType === "HospitalTask")).toHaveLength(3);
    await expect(service.commandHospitalTask(user("user-vet"), task.task.id, { command: "START", expectedVersion: completed.task.version, idempotencyKey: "restart" })).rejects.toMatchObject({ status: 409 });
  });
  it("serializes repeated creation and concurrent writes, requiring versions and fresh policy on replay", async () => {
    const { store, service, user, create } = setup();
    const [first, replay] = await Promise.all([create("same"), create("same")]); expect(replay.task.id).toBe(first.task.id); expect(store.getState().hospitalTasks).toHaveLength(1);
    const edits = await Promise.allSettled([service.updateHospitalTask(user("user-vet"), first.task.id, { title: "Primeira", expectedVersion: 1, idempotencyKey: "edit-a" }), service.updateHospitalTask(user("user-vet"), first.task.id, { title: "Segunda", expectedVersion: 1, idempotencyKey: "edit-b" })]);
    expect(edits.filter((result) => result.status === "fulfilled")).toHaveLength(1); expect(edits.find((result) => result.status === "rejected")).toMatchObject({ reason: { status: 409 } });
    await store.transaction((state) => ({ state: { ...state, accessGroups: state.accessGroups.map((group) => group.id === systemGroupId("VETERINARIAN") ? { ...group, permissions: group.permissions.filter((permission) => permission !== "hospital_task.create") } : group) }, result: undefined }));
    await expect(create("same")).rejects.toMatchObject({ status: 404 });
  });
  it("allows create-only metadata and creation without granting directory or task reading", async () => {
    const { store, service, user, create } = setup();
    await store.transaction((state) => ({ state: { ...state, accessGroups: state.accessGroups.map((group) => group.id === systemGroupId("VETERINARIAN") ? { ...group, permissions: ["hospital_task.create"] } : group) }, result: undefined }));
    const options = await service.listHospitalTaskOptions(user("user-vet")); expect(options.departments.map((entry) => entry.code)).toEqual(["INPATIENT"]);
    expect(JSON.stringify(options)).not.toMatch(/passwordHash|patientIds|whatsappPhone/);
    const created = await create("create-only", { responsibleUserId: undefined, expectedVersion: undefined }); expect(created.permissions).toEqual([]);
    await expect(service.getHospitalTask(user("user-vet"), created.task.id)).rejects.toMatchObject({ status: 404 });
    await expect(service.listHospitalTasks(user("user-vet"))).rejects.toMatchObject({ status: 404 });
  });
  it("requires real patient/encounter scope and never exposes hidden titles or counts", async () => {
    const { store, service, user, create } = setup();
    await expect(create("care-missing", { typeId: "hospital-task-type-care" })).rejects.toMatchObject({ status: 400 });
    await expect(create("care-mismatch", { typeId: "hospital-task-type-care", patientId: "patient-thor", encounterId: "encounter-mel" })).rejects.toMatchObject({ status: 404 });
    const care = await create("care", { title: "Cuidado reservado Thor", typeId: "hospital-task-type-care", patientId: "patient-thor", encounterId: "encounter-thor" });
    await store.transaction((state) => ({ state: { ...state, users: state.users.map((entry) => entry.id === "vet-b" ? { ...entry, patientIds: ["patient-mel"] } : entry) }, result: undefined }));
    expect((await service.listHospitalTasks(user("vet-b"))).total).toBe(0); expect((await service.searchPlanner(user("vet-b"), "reservado")).total).toBe(0);
    await expect(service.getHospitalTask(user("vet-b"), care.task.id)).rejects.toMatchObject({ status: 404 });
    expect(eventVisible(store.getState(), user("vet-b"), "HospitalTask", care.task.id, { patientId: "patient-mel" })).toBe(false);
    expect(auditScopeForActor(store.getState(), user("user-admin")).entities).not.toContainEqual({ entityType: "HospitalTask", entityId: care.task.id });
    expect(auditScopeForActor(store.getState(), user("user-admin")).unresolved?.resolvedEntities).toContainEqual({ entityType: "HospitalTask", entityId: care.task.id });
  });
  it("assigns explicitly without changing authorship or granting a patient, with inactive and out-of-scope denial", async () => {
    const { store, service, user, create } = setup(); const task = await create("unassigned", { responsibleUserId: undefined });
    const assumed = await service.assignHospitalTask(user("vet-b"), task.task.id, { responsibleUserId: "vet-b", expectedVersion: 1, idempotencyKey: "assume" });
    expect(assumed.task).toMatchObject({ authorId: "user-vet", responsibleUserId: "vet-b" });
    await expect(service.assignHospitalTask(user("user-vet"), task.task.id, { responsibleUserId: "user-vet", expectedVersion: 2, idempotencyKey: "take" })).rejects.toMatchObject({ status: 404 });
    await expect(service.assignHospitalTask(user("super"), task.task.id, { responsibleUserId: "user-lab", expectedVersion: 2, idempotencyKey: "cross-sector" })).rejects.toMatchObject({ status: 404 });
    await store.transaction((state) => ({ state: { ...state, users: state.users.map((entry) => entry.id === "vet-b" ? { ...entry, active: false } : entry) }, result: undefined }));
    await expect(service.assignHospitalTask(user("super"), task.task.id, { responsibleUserId: "vet-b", expectedVersion: 2, idempotencyKey: "inactive" })).rejects.toMatchObject({ status: 400 });
    expect(user("user-vet").patientIds).toEqual(["patient-thor", "patient-mel"]);
  });
  it("keeps shared active work separate from explicit responsible and period filters, sorting before pagination", async () => {
    const { service, user, create } = setup(); await create("routine");
    const urgent = await create("urgent", { priority: "URGENT", plannedStartAt: "2026-10-12T10:00:00Z", plannedEndAt: "2026-10-12T11:00:00Z" });
    const emergency = await create("emergency", { priority: "EMERGENCY", responsibleUserId: undefined });
    await service.assignHospitalTask(user("vet-b"), emergency.task.id, { responsibleUserId: "vet-b", expectedVersion: 1, idempotencyKey: "emergency-assign" });
    const page = await service.listHospitalTasks(user("user-vet"), { orderBy: "PRIORITY", direction: "DESC", limit: 1 });
    expect(page.total).toBe(3); expect(page.items[0].task.id).toBe(emergency.task.id);
    const second = await service.listHospitalTasks(user("user-vet"), { orderBy: "PRIORITY", direction: "DESC", limit: 1, cursor: page.nextCursor }); expect(second.items[0].task.id).toBe(urgent.task.id);
    expect((await service.listHospitalTasks(user("user-vet"), { assignedToMe: true })).total).toBe(2);
    expect((await service.listHospitalTasks(user("vet-b"), { assignedToMe: true })).total).toBe(1);
    expect((await service.listHospitalTasks(user("user-vet"), { from: "2026-10-12T09:00:00Z", to: "2026-10-12T12:00:00Z" })).items.map((entry) => entry.task.id)).toEqual([urgent.task.id]);
    await expect(service.listHospitalTasks(user("user-vet"), { orderBy: "UPDATED", cursor: page.nextCursor })).rejects.toMatchObject({ status: 400 });
  });
  it("validates planning dates and audits priority without changing diagnostic state or clocks", async () => {
    const { store, service, user, create } = setup();
    await expect(create("invalid-date", { plannedStartAt: "2026-10-12T11:00:00Z", plannedEndAt: "2026-10-12T10:00:00Z" })).rejects.toMatchObject({ status: 400 });
    const task = await create("planned", { plannedStartAt: "2026-10-12T10:00:00Z", plannedEndAt: "2026-10-12T11:00:00Z" });
    await expect(service.reprioritizeHospitalTask(user("user-vet"), task.task.id, { priority: "URGENT", reason: "", expectedVersion: 1, idempotencyKey: "no-reason" })).rejects.toMatchObject({ status: 400 });
    const updated = await service.reprioritizeHospitalTask(user("user-vet"), task.task.id, { priority: "URGENT", reason: "Reposição necessária antes do próximo turno", expectedVersion: 1, idempotencyKey: "priority" });
    expect(updated.task.phase).toBe("PENDING"); expect(updated.task.plannedEndAt).toBe(task.task.plannedEndAt); expect(updated.task.createdAt).toBe(task.task.createdAt);
    expect(store.getState().auditEvents.at(-1)?.metadata).toMatchObject({ previousPriority: "ROUTINE", priority: "URGENT", unit: "HOSPITAL_TASK", clinicalStateChanged: false });
  });
  it("changes patient context only before execution, preserving identity and requiring every member's new scope", async () => {
    const { store, service, user, create } = setup();
    const task = await create("context", { typeId: "hospital-task-type-care", patientId: "patient-thor", encounterId: "encounter-thor" });
    await store.transaction((state) => ({ state: { ...state, users: state.users.map((entry) => entry.id === "user-vet" ? { ...entry, patientIds: ["patient-thor"] } : entry) }, result: undefined }));
    await expect(service.updateHospitalTaskContext(user("super"), task.task.id, { patientId: "patient-mel", encounterId: "encounter-mel", expectedVersion: 1, idempotencyKey: "unassigned-context" })).rejects.toMatchObject({ status: 404 });
    await store.transaction((state) => ({ state: { ...state, users: state.users.map((entry) => entry.id === "user-vet" ? { ...entry, patientIds: ["patient-thor", "patient-mel"] } : entry) }, result: undefined }));
    const moved = await service.updateHospitalTaskContext(user("super"), task.task.id, { patientId: "patient-mel", encounterId: "encounter-mel", expectedVersion: 1, idempotencyKey: "move" });
    expect(moved.task).toMatchObject({ patientId: "patient-mel", encounterId: "encounter-mel", authorId: "user-vet", responsibleUserId: "user-vet" });
    await service.commandHospitalTask(user("user-vet"), task.task.id, { command: "START", expectedVersion: moved.task.version, idempotencyKey: "context-start" });
    await expect(service.updateHospitalTaskContext(user("super"), task.task.id, { patientId: "patient-thor", encounterId: "encounter-thor", expectedVersion: 3, idempotencyKey: "after-start" })).rejects.toMatchObject({ status: 409 });
  });
  it("configures independent task states, preserving existing snapshots after type change or inactivation", async () => {
    const { service, user, create } = setup(); const original = await service.listHospitalTaskTypes(user("user-admin"));
    const states = original[0].states.map((entry) => ({ ...entry, code: `CUSTOM_${entry.code}` }));
    const custom = await service.createHospitalTaskType(user("user-admin"), { code: "STOCK", name: "Conferência", careContextRequired: false, states, idempotencyKey: "type" });
    const task = await create("custom", { typeId: custom.id });
    await service.updateHospitalTaskType(user("user-admin"), custom.id, { active: false, states: original[0].states, expectedVersion: 1, idempotencyKey: "type-disable" });
    await expect(create("new-custom", { typeId: custom.id })).rejects.toMatchObject({ status: 404 });
    const started = await service.commandHospitalTask(user("user-vet"), task.task.id, { command: "START", stateCode: "CUSTOM_IN_PROGRESS", expectedVersion: 1, idempotencyKey: "custom-start" }); expect(started.task.status).toBe("CUSTOM_IN_PROGRESS");
    await expect(service.commandHospitalTask(user("user-vet"), task.task.id, { command: "COMPLETE", stateCode: "RESULT_AVAILABLE", expectedVersion: 2, idempotencyKey: "fake-diagnostic-state" })).rejects.toMatchObject({ status: 400 });
    expect(hospitalTaskCreateSchema.safeParse({ title: "Bypass", typeId: custom.id, departmentCode: "INPATIENT", priority: "ROUTINE", phase: "COMPLETED" }).success).toBe(false);
    expect(hospitalTaskCommandSchema.safeParse({ command: "COMPLETE", expectedVersion: 1, completedBy: "other" }).success).toBe(false);
  });
  it.each(ROLES)("%s follows independent task grants, own sector and inactive denial", async (role: RoleCode) => {
    const { store, service, user } = setup(); const base = user("user-vet");
    await store.transaction((state) => ({ state: { ...state, departments: state.departments.map((department) => department.code === "LABORATORY" ? { ...department, memberUserIds: [...department.memberUserIds, `matrix-${role}`] } : department), users: [...state.users, { ...base, id: `matrix-${role}`, role, departmentCode: "LABORATORY", accessGroupId: systemGroupId(role), serviceCodes: [], managedDepartmentCodes: ["LABORATORY"] }] }, result: undefined }));
    const actor = user(`matrix-${role}`);
    const created = await service.createHospitalTask(user("super"), { title: "Rotina laboratório", typeId: "hospital-task-type-routine", departmentCode: "LABORATORY", priority: "ROUTINE", idempotencyKey: `matrix-${role}` });
    if (role === "ADMIN") await expect(service.getHospitalTask(actor, created.task.id)).rejects.toMatchObject({ status: 404 });
    else expect((await service.getHospitalTask(actor, created.task.id)).task.id).toBe(created.task.id);
    if (role === "ADMIN" || role === "VIEWER") await expect(service.createHospitalTask(actor, { title: "Negada", typeId: "hospital-task-type-routine", departmentCode: "LABORATORY", priority: "ROUTINE", idempotencyKey: `write-${role}` })).rejects.toMatchObject({ status: 404 });
    else expect((await service.createHospitalTask(actor, { title: "Rotina própria", typeId: "hospital-task-type-routine", departmentCode: "LABORATORY", priority: "ROUTINE", responsibleUserId: actor.id, idempotencyKey: `write-${role}` })).task.authorId).toBe(actor.id);
    await store.transaction((state) => ({ state: { ...state, users: state.users.map((entry) => entry.id === actor.id ? { ...entry, active: false } : entry) }, result: undefined }));
    await expect(service.getHospitalTask(actor, created.task.id)).rejects.toMatchObject({ status: 401 });
  });
});
