import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hospitalOperationFixture, OPERATION_NOW, OPERATION_WINDOW } from "../../test/hospital-operation-fixtures";

const filters = { from: OPERATION_WINDOW.startsAt, to: OPERATION_WINDOW.endsAt, departmentCode: "ULTRASOUND" };
describe("explicit effort of the complete currently authorized open load", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(OPERATION_NOW); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  it("reports zero for an empty load and sums all explicitly estimated open activities", async () => {
    const f = hospitalOperationFixture();
    expect((await f.service.getHospitalCapacity(f.user("user-us"), filters)).authorizedLoad).toEqual({ openDiagnosticItems: 0, overdueDiagnosticItems: 0, openHospitalTasks: 0, estimatedMinutes: 0 });
    const first = await f.task("estimated-first"); const second = await f.task("estimated-second");
    await f.service.updateHospitalTask(f.user("user-us"), first.task.id, { estimatedMinutes: 35, expectedVersion: 1, idempotencyKey: "estimate-first" });
    await f.service.updateHospitalTask(f.user("user-us"), second.task.id, { estimatedMinutes: 25, expectedVersion: 1, idempotencyKey: "estimate-second" });
    await f.service.commandHospitalTask(f.user("user-us"), second.task.id, { command: "START", expectedVersion: 2, idempotencyKey: "start-estimated-second" });
    const before = structuredClone(f.store.getState());
    expect((await f.service.getHospitalCapacity(f.user("user-us"), filters)).authorizedLoad).toMatchObject({ openHospitalTasks: 2, estimatedMinutes: 60 });
    expect(f.store.getState()).toEqual(before);
    expect((await f.service.getHospitalCapacity(f.user("user-us"), { ...filters, from: "2026-10-12T09:00:00Z", to: "2026-10-12T17:00:00Z" })).authorizedLoad.estimatedMinutes).toBe(60);
  });
  it("keeps the total unknown when one task is unestimated or an estimate is withdrawn", async () => {
    const f = hospitalOperationFixture(); const known = await f.task("known"); const missing = await f.task("missing");
    await f.service.updateHospitalTask(f.user("user-us"), known.task.id, { estimatedMinutes: 30, expectedVersion: 1, idempotencyKey: "known-estimate" });
    expect((await f.service.getHospitalCapacity(f.user("user-us"), filters)).authorizedLoad.estimatedMinutes).toBeNull();
    await f.service.updateHospitalTask(f.user("user-us"), missing.task.id, { estimatedMinutes: 20, expectedVersion: 1, idempotencyKey: "missing-estimate" });
    expect((await f.service.getHospitalCapacity(f.user("user-us"), filters)).authorizedLoad.estimatedMinutes).toBe(50);
    await f.service.updateHospitalTask(f.user("user-us"), known.task.id, { estimatedMinutes: null, expectedVersion: 2, idempotencyKey: "withdraw-estimate" });
    expect((await f.service.getHospitalCapacity(f.user("user-us"), filters)).authorizedLoad.estimatedMinutes).toBeNull();
  });
  it("does not turn an unestimated diagnostic item or its clinical deadline into effort", async () => {
    const f = hospitalOperationFixture(); const task = await f.task("with-diagnostic");
    await f.service.updateHospitalTask(f.user("user-us"), task.task.id, { estimatedMinutes: 45, expectedVersion: 1, idempotencyKey: "task-estimate" });
    const item = await f.ultrasound("diagnostic-effort-unknown"); const before = structuredClone(f.store.getState().items);
    const capacity = await f.service.getHospitalCapacity(f.user("user-us"), filters);
    expect(capacity.authorizedLoad).toMatchObject({ openDiagnosticItems: 1, openHospitalTasks: 1, estimatedMinutes: null });
    expect(capacity.sla).toEqual({ source: "REQUEST_CAPTURE", unit: "ELAPSED_HOURS", calendarPausesDeadline: false });
    expect(f.store.getState().items).toEqual(before); expect(f.store.getState().items.find(entry => entry.id === item.id)?.dueAt).toBe(item.dueAt);
  });
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("treats an invalid legacy estimate %s as unknown instead of a known total", async estimate => {
    const f = hospitalOperationFixture(); const task = await f.task("invalid-legacy-estimate");
    await f.store.transaction(state => ({ state: { ...state, hospitalTasks: state.hospitalTasks.map(entry => entry.id === task.task.id ? { ...entry, estimatedMinutes: estimate } : entry) }, result: undefined }));
    expect((await f.service.getHospitalCapacity(f.user("user-us"), filters)).authorizedLoad).toMatchObject({ openHospitalTasks: 1, estimatedMinutes: null });
  });
  it("excludes private, discarded, archived and terminal work from both the denominator and the sum", async () => {
    const f = hospitalOperationFixture(); const known = await f.task("visible-effort");
    await f.service.updateHospitalTask(f.user("user-us"), known.task.id, { estimatedMinutes: 15, expectedVersion: 1, idempotencyKey: "visible-effort-estimate" });
    const draft = await f.service.createHospitalTaskDraft(f.user("user-us"), { title: "Private synthetic effort", typeId: "hospital-task-type-routine", departmentCode: "ULTRASOUND", estimatedMinutes: 999, priority: "ROUTINE", idempotencyKey: "private-effort" });
    const discarded = await f.service.createHospitalTaskDraft(f.user("user-us"), { title: "Discarded synthetic effort", typeId: "hospital-task-type-routine", departmentCode: "ULTRASOUND", priority: "ROUTINE", idempotencyKey: "discarded-effort" });
    await f.service.commandHospitalTaskDraft(f.user("user-us"), discarded.task.id, { command: "DISCARD", expectedVersion: 1, idempotencyKey: "discard-effort" });
    const cancelled = await f.task("cancelled-effort");
    await f.service.commandHospitalTask(f.user("user-us"), cancelled.task.id, { command: "CANCEL", reason: "Synthetic cancellation", expectedVersion: 1, idempotencyKey: "cancel-effort" });
    const completed = await f.task("completed-effort");
    await f.service.commandHospitalTask(f.user("user-us"), completed.task.id, { command: "START", expectedVersion: 1, idempotencyKey: "start-effort" });
    await f.service.commandHospitalTask(f.user("user-us"), completed.task.id, { command: "COMPLETE", expectedVersion: 2, idempotencyKey: "complete-effort" });
    await f.service.setHospitalTaskArchived(f.user("user-us"), completed.task.id, { archived: true, expectedVersion: 3, idempotencyKey: "archive-effort" });
    expect((await f.service.getHospitalCapacity(f.user("user-us"), filters)).authorizedLoad).toMatchObject({ openHospitalTasks: 1, estimatedMinutes: 15 });
    await f.service.commandHospitalTaskDraft(f.user("user-us"), draft.task.id, { command: "PUBLISH", expectedVersion: 1, idempotencyKey: "publish-effort" });
    expect((await f.service.getHospitalCapacity(f.user("user-us"), filters)).authorizedLoad).toMatchObject({ openHospitalTasks: 2, estimatedMinutes: 1014 });
  });
  it("computes only the manager's current delegated scope, revalidating the stale actor", async () => {
    const f = hospitalOperationFixture(); const us = await f.task("delegated-us"); const lab = await f.service.createHospitalTask(f.user("user-manager"), { title: "Delegated laboratory effort", typeId: "hospital-task-type-routine", departmentCode: "LABORATORY", priority: "ROUTINE", idempotencyKey: "delegated-lab" });
    await f.service.updateHospitalTask(f.user("user-us"), us.task.id, { estimatedMinutes: 40, expectedVersion: 1, idempotencyKey: "delegated-us-estimate" });
    const actor = f.user("user-manager");
    expect((await f.service.getHospitalCapacity(actor, { from: filters.from, to: filters.to })).authorizedLoad.estimatedMinutes).toBeNull();
    await f.store.transaction(state => ({ state: { ...state, users: state.users.map(user => user.id === actor.id ? { ...user, managedDepartmentCodes: ["ULTRASOUND"] } : user) }, result: undefined }));
    expect((await f.service.getHospitalCapacity(actor, { from: filters.from, to: filters.to })).authorizedLoad).toMatchObject({ openHospitalTasks: 1, estimatedMinutes: 40 });
    await expect(f.service.getHospitalCapacity(actor, { ...filters, departmentCode: lab.task.departmentCode })).rejects.toMatchObject({ status: 404 });
    expect((await f.service.getHospitalCapacity(f.user("user-us"), filters)).authorizedLoad.estimatedMinutes).toBe(40);
  });
});
