import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hospitalOperationFixture, OPERATION_NOW } from "../../test/hospital-operation-fixtures";
import { createHospitalRecurrenceSchedule, runScheduledHospitalRecurrences } from "./hospital-recurrence-job";
import { generateDueHospitalRecurrences } from "./hospital-recurrence-service";
import { systemGroupId } from "../security/access-group-policy";

async function setup() {
  const f = hospitalOperationFixture();
  await f.store.transaction((state) => ({ state: { ...state, users: [...state.users, { ...state.users.find((user) => user.id === "user-vet")!, id: "vet-b", email: "vet-b@example.test" }] }, result: undefined }));
  const input = { code: "VERIFY_SUPPLY", name: "Conferência de suprimentos", departmentCode: "INPATIENT", careContextRequired: false, steps: [{ code: "VERIFY", label: "Conferir", required: true, evidenceRequired: false }], idempotencyKey: "template" };
  const template = await f.service.createHospitalChecklistTemplate(f.user("user-admin"), input);
  const approved = await f.service.approveHospitalChecklistTemplate(f.user("user-vet"), template.template.id, { expectedVersion: 1, idempotencyKey: "approve" });
  const recurrenceInput = { templateId: approved.template.id, departmentCode: "INPATIENT", title: "Conferência operacional", priority: "ROUTINE" as const, startAt: OPERATION_NOW, intervalMinutes: 60 };
  const create = (key = "recurrence", extra: Partial<Parameters<typeof f.service.createHospitalRecurrence>[1]> = {}) => f.service.createHospitalRecurrence(f.user("user-vet"), { ...recurrenceInput, ...extra, idempotencyKey: key });
  return { ...f, template: approved, create, recurrenceInput };
}
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(OPERATION_NOW); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("recurrence worker recovery and explicit bindings", () => {
  it("runs due work once per interval, logs operational counts and remains silent when nothing is due", async () => {
    const f = await setup(); const created = await f.create(); const schedule = createHospitalRecurrenceSchedule(); const log = vi.spyOn(console, "log").mockImplementation(() => undefined); const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await runScheduledHospitalRecurrences(f.store, schedule)).toMatchObject({ generated: 1, blocked: 0, pending: 0 }); const first = structuredClone(f.store.getState().hospitalTasks);
    expect(log).toHaveBeenCalledTimes(1); expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ event: "hospital.recurrence_batch", generated: 1 }); expect(log.mock.calls[0][0]).not.toContain(created.recurrence.title); expect(error).not.toHaveBeenCalled();
    expect(await runScheduledHospitalRecurrences(f.store, schedule)).toBeUndefined(); expect(f.store.getState().hospitalTasks).toEqual(first);
    vi.setSystemTime("2026-10-11T10:01:00Z"); expect(await runScheduledHospitalRecurrences(f.store, schedule)).toMatchObject({ generated: 0, pending: 0 }); expect(log).toHaveBeenCalledTimes(1);
  });

  it("blocks without cursor loss, backs off repeat attempts and resumes from the same occurrence after restoring approval", async () => {
    const f = await setup(); const created = await f.create(); await f.service.retireHospitalChecklistTemplate(f.user("user-vet"), f.template.template.id, { expectedVersion: 2, idempotencyKey: "retire" });
    const schedule = createHospitalRecurrenceSchedule(); const log = vi.spyOn(console, "log").mockImplementation(() => undefined); const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await runScheduledHospitalRecurrences(f.store, schedule)).toMatchObject({ blocked: 1, pending: 1 }); const blocked = structuredClone(f.store.getState().hospitalRecurrences[0]); const notifications = f.store.getState().workNotifications.length;
    expect(error).toHaveBeenCalledWith(JSON.stringify({ event: "hospital.recurrence_blocked", errorCode: "HOSPITAL_RECURRENCE_CONTEXT_INVALID", blocked: 1 }));
    expect(await runScheduledHospitalRecurrences(f.store, schedule)).toBeUndefined(); vi.setSystemTime("2026-10-11T10:01:00Z"); expect(await runScheduledHospitalRecurrences(f.store, schedule)).toMatchObject({ blocked: 1 });
    expect(f.store.getState().hospitalRecurrences[0]).toEqual(blocked); expect(f.store.getState().workNotifications).toHaveLength(notifications); expect(log).toHaveBeenCalledTimes(2);
    // Restore a previously approved snapshot to model recovery of the configuration authority.
    await f.store.transaction((state) => ({ state: { ...state, hospitalChecklistTemplates: [f.template.template] }, result: undefined })); vi.setSystemTime("2026-10-11T10:02:00Z");
    expect(await runScheduledHospitalRecurrences(f.store, schedule)).toMatchObject({ generated: 1, blocked: 0, pending: 0 }); expect(f.store.getState().hospitalTasks[0]).toMatchObject({ recurrenceId: created.recurrence.id, occurrenceAt: OPERATION_NOW }); expect(f.store.getState().hospitalRecurrences[0].lastError).toBeUndefined();
  });

  it("recovers an existing occurrence key after cursor rollback without duplicating its task", async () => {
    const f = await setup(); const created = await f.create(); await generateDueHospitalRecurrences(f.store);
    const frozen = structuredClone(f.store.getState().hospitalTasks); await f.store.transaction((state) => ({ state: { ...state, hospitalRecurrences: state.hospitalRecurrences.map((row) => ({ ...row, nextOccurrenceAt: created.recurrence.nextOccurrenceAt })) }, result: undefined }));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await runScheduledHospitalRecurrences(f.store, createHospitalRecurrenceSchedule())).toMatchObject({ generated: 0, alreadyGenerated: 1, pending: 0 }); expect(f.store.getState().hospitalTasks).toEqual(frozen); expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ alreadyGenerated: 1 });
  });

  it("reports a bounded overdue queue, including equal due dates and an explicit end boundary", async () => {
    const f = await setup(); await f.create("first", { startAt: "2026-10-11T08:00:00Z", endAt: "2026-10-11T10:00:00Z" }); await f.create("second", { startAt: "2026-10-11T08:00:00Z", endAt: "2026-10-11T10:00:00Z" });
    expect(await generateDueHospitalRecurrences(f.store, { limit: 1, actor: f.user("user-vet") })).toMatchObject({ generated: 1, pending: 3 });
    expect(await generateDueHospitalRecurrences(f.store, { limit: 100, actor: f.user("user-vet") })).toMatchObject({ generated: 3, pending: 0 }); expect(f.store.getState().hospitalTasks).toHaveLength(4); expect(f.store.getState().hospitalTasks.some((task) => task.occurrenceAt === OPERATION_NOW)).toBe(false);
  });

  it("preserves generated tasks while editing recurrence metadata, clearing a responsible and replaying the same intent", async () => {
    const f = await setup(); const created = await f.create("create", { responsibleUserId: "user-vet", endAt: "2026-10-11T13:00:00Z" }); expect((await f.create("create", { responsibleUserId: "user-vet", endAt: "2026-10-11T13:00:00Z" })).recurrence.id).toBe(created.recurrence.id);
    await generateDueHospitalRecurrences(f.store); const previousTasks = structuredClone(f.store.getState().hospitalTasks); const version = f.store.getState().hospitalRecurrences[0].version;
    const edit = { title: "Conferência revisada", priority: "URGENT" as const, responsibleUserId: null, endAt: null, expectedVersion: version, idempotencyKey: "edit", correlationId: "recurrence-metadata" };
    const updated = await f.service.updateHospitalRecurrence(f.user("user-vet"), created.recurrence.id, edit); expect(updated.recurrence).toMatchObject({ title: "Conferência revisada", priority: "URGENT", version: version + 1 }); expect(updated.recurrence.responsibleUserId).toBeUndefined(); expect(updated.recurrence.endAt).toBeUndefined(); expect((await f.service.updateHospitalRecurrence(f.user("user-vet"), created.recurrence.id, edit)).recurrence).toEqual(updated.recurrence); expect(f.store.getState().hospitalTasks).toEqual(previousTasks);
    const clinical = await f.create("clinical", { patientId: "patient-thor", encounterId: "encounter-thor" });
    expect((await f.service.listHospitalRecurrences(f.user("user-vet"), { patientId: "patient-thor", departmentCode: "INPATIENT", active: true })).items.map((row) => row.recurrence.id)).toEqual([clinical.recurrence.id]);
    await f.service.updateHospitalRecurrence(f.user("user-vet"), clinical.recurrence.id, { active: false, expectedVersion: 1, idempotencyKey: "disable" }); expect((await f.service.listHospitalRecurrences(f.user("user-vet"), { active: false })).total).toBe(1);
  });

  it("refuses implicit reassignment and invalid recurrence intervals without mutating durable planning", async () => {
    const f = await setup(); const before = f.store.getState();
    await expect(f.create("other", { responsibleUserId: "vet-b" })).rejects.toMatchObject({ status: 404 }); await expect(f.create("invalid-end", { endAt: OPERATION_NOW })).rejects.toMatchObject({ status: 400 }); expect(f.store.getState()).toEqual(before);
    const manager = await f.service.createHospitalRecurrence(f.user("user-manager"), { ...f.recurrenceInput, responsibleUserId: "user-vet", idempotencyKey: "delegated" }); expect(manager.recurrence.responsibleUserId).toBe("user-vet");
    await f.store.transaction((state) => ({ state: { ...state, accessGroups: state.accessGroups.map((group) => group.id === systemGroupId("MANAGER") ? { ...group, permissions: group.permissions.filter((permission) => permission !== "recurrence.manage") } : group) }, result: undefined }));
    await expect(f.service.createHospitalRecurrence(f.user("user-manager"), { ...f.recurrenceInput, responsibleUserId: "user-vet", idempotencyKey: "delegated" })).rejects.toMatchObject({ status: 404 });
  });
});
