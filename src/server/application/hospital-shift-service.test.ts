import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { systemGroupId } from "../security/access-group-policy";
import { createApplicationService } from "./service";
import { currentShiftCoverage } from "./hospital-shift-policy";

function setup() {
  const state = createDemoState(); const vet = state.users.find((user) => user.id === "user-vet")!; const lab = state.users.find((user) => user.id === "user-lab")!;
  state.users.push({ ...vet, id: "vet-b", email: "b@example.test" }, { ...vet, id: "super", role: "SUPERADMIN", accessGroupId: systemGroupId("SUPERADMIN") }, { ...lab, id: "lab-b", email: "lab-b@example.test" });
  state.departments.find((department) => department.code === "INPATIENT")!.memberUserIds.push("vet-b"); state.departments.find((department) => department.code === "LABORATORY")!.memberUserIds.push("lab-b");
  const store = new MemoryStore(state); const service = createApplicationService(store); const actor = (id = "user-vet") => store.getState().users.find((user) => user.id === id)!;
  const shift = (key: string, startAt: string, endAt: string, userId: string, departmentCode = "INPATIENT") => service.createHospitalShift(actor("super"), { name: key, departmentCode, startAt, endAt, members: [{ userId }], idempotencyKey: key });
  const task = (key: string) => service.createHospitalTask(actor(), { title: key, typeId: "hospital-task-type-care", departmentCode: "INPATIENT", patientId: "patient-thor", encounterId: "encounter-thor", responsibleUserId: "user-vet", priority: "URGENT", plannedStartAt: "2026-10-11T11:00:00Z", plannedEndAt: "2026-10-11T15:00:00Z", idempotencyKey: key });
  return { store, service, actor, shift, task };
}
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime("2026-10-11T12:00:00Z"); }); afterEach(() => vi.useRealTimers());
describe("real shift coverage and acknowledged handoffs", () => {
  it("uses half-open intervals, rejects overlap and keeps onCall unchanged", async () => {
    const { store, service, actor, shift } = setup(); const onCall = store.getState().users.map((user) => [user.id, user.onCall]);
    await shift("morning", "2026-10-11T06:00:00Z", "2026-10-11T12:00:00Z", "user-vet"); const afternoon = await shift("afternoon", "2026-10-11T12:00:00Z", "2026-10-11T18:00:00Z", "user-vet");
    expect((await service.listHospitalShifts(actor(), { current: true })).items.map((row) => row.shift.id)).toEqual([afternoon.shift.id]);
    expect(currentShiftCoverage(store.getState(), "INPATIENT").map((user) => user.id)).toEqual(["user-vet"]);
    await expect(shift("overlap", "2026-10-11T17:00:00Z", "2026-10-11T19:00:00Z", "user-vet")).rejects.toMatchObject({ code: "SHIFT_CONFLICT", status: 409 });
    await expect(shift("invalid", "2026-10-11T18:00:00Z", "2026-10-11T18:00:00Z", "vet-b")).rejects.toMatchObject({ status: 400 });
    expect(store.getState().users.map((user) => [user.id, user.onCall])).toEqual(onCall); vi.setSystemTime("2026-10-11T18:00:00Z"); expect(currentShiftCoverage(store.getState(), "INPATIENT")).toEqual([]);
  });
  it("preserves responsibility until recipient acceptance, including deadlines and source workflows", async () => {
    const { store, service, actor, shift, task } = setup(); const from = await shift("from", "2026-10-11T06:00:00Z", "2026-10-11T12:00:00Z", "user-vet"); const to = await shift("to", "2026-10-11T12:00:00Z", "2026-10-11T18:00:00Z", "vet-b"); const created = await task("pending");
    const assigned = await service.assignHospitalActivityShift(actor("super"), { targetType: "HOSPITAL_TASK", targetId: created.task.id, shiftId: from.shift.id, expectedVersion: 1, idempotencyKey: "bind" });
    const offered = await service.offerHospitalHandoff(actor(), { fromShiftId: from.shift.id, toShiftId: to.shift.id, recipientUserId: "vet-b", entries: [{ targetType: "HOSPITAL_TASK", targetId: created.task.id, expectedTargetVersion: assigned.version }], idempotencyKey: "offer" });
    expect(store.getState().hospitalTasks[0].responsibleUserId).toBe("user-vet");
    await expect(service.decideHospitalHandoff(actor(), offered.handoff.id, { decision: "ACCEPT", expectedVersion: 1, idempotencyKey: "impersonate" })).rejects.toMatchObject({ status: 404 });
    const outcomes = await Promise.allSettled(["a", "b"].map((key) => service.decideHospitalHandoff(actor("vet-b"), offered.handoff.id, { decision: "ACCEPT", expectedVersion: 1, idempotencyKey: key })));
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1); expect(outcomes.find((outcome) => outcome.status === "rejected")).toMatchObject({ reason: { status: 409 } });
    expect(store.getState().hospitalTasks[0]).toMatchObject({ authorId: "user-vet", responsibleUserId: "vet-b", shiftId: to.shift.id, phase: "PENDING", priority: "URGENT", plannedStartAt: created.task.plannedStartAt, plannedEndAt: created.task.plannedEndAt });
    expect((await service.getHospitalShift(actor("vet-b"), to.shift.id)).workload).toMatchObject({ visibleActivities: 1, completedActivities: 0 }); expect(actor("vet-b").patientIds).toEqual(["patient-thor", "patient-mel"]);
  });
  it("rejects stale multi-activity acceptance atomically and records refusal without transfer", async () => {
    const { store, service, actor, shift, task } = setup(); const from = await shift("from", "2026-10-11T06:00:00Z", "2026-10-11T12:00:00Z", "user-vet"); const to = await shift("to", "2026-10-11T12:00:00Z", "2026-10-11T18:00:00Z", "vet-b"); const first = await task("first"); const second = await task("second");
    for (const task of [first, second]) await service.assignHospitalActivityShift(actor("super"), { targetType: "HOSPITAL_TASK", targetId: task.task.id, shiftId: from.shift.id, expectedVersion: 1, idempotencyKey: `bind-${task.task.id}` });
    const offered = await service.offerHospitalHandoff(actor(), { fromShiftId: from.shift.id, toShiftId: to.shift.id, recipientUserId: "vet-b", entries: [first, second].map((task) => ({ targetType: "HOSPITAL_TASK", targetId: task.task.id, expectedTargetVersion: 2 })), idempotencyKey: "offer" });
    await service.updateHospitalTask(actor(), second.task.id, { title: "Mudança posterior", expectedVersion: 2, idempotencyKey: "edit" });
    await expect(service.decideHospitalHandoff(actor("vet-b"), offered.handoff.id, { decision: "ACCEPT", expectedVersion: 1, idempotencyKey: "stale" })).rejects.toMatchObject({ status: 409 });
    expect(store.getState().hospitalTasks.every((task) => task.responsibleUserId === "user-vet" && task.shiftId === from.shift.id)).toBe(true); expect(store.getState().hospitalHandoffs[0].state).toBe("OFFERED");
    const declined = await service.decideHospitalHandoff(actor("vet-b"), offered.handoff.id, { decision: "REJECT", reason: "Equipe precisa revisar as pendências", expectedVersion: 1, idempotencyKey: "decline" }); expect(declined.handoff.state).toBe("REJECTED"); expect(store.getState().hospitalTasks[0].responsibleUserId).toBe("user-vet");
  });
  it("fails closed when either professional loses patient scope, including replay", async () => {
    const { store, service, actor, shift, task } = setup(); const from = await shift("from", "2026-10-11T06:00:00Z", "2026-10-11T12:00:00Z", "user-vet"); const to = await shift("to", "2026-10-11T12:00:00Z", "2026-10-11T18:00:00Z", "vet-b"); const created = await task("pending"); await service.assignHospitalActivityShift(actor("super"), { targetType: "HOSPITAL_TASK", targetId: created.task.id, shiftId: from.shift.id, expectedVersion: 1, idempotencyKey: "bind" });
    const offer = { fromShiftId: from.shift.id, toShiftId: to.shift.id, recipientUserId: "vet-b", entries: [{ targetType: "HOSPITAL_TASK" as const, targetId: created.task.id, expectedTargetVersion: 2 }], idempotencyKey: "offer" }; const offered = await service.offerHospitalHandoff(actor(), offer);
    await store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === "vet-b" ? { ...user, patientIds: [] } : user) }, result: undefined }));
    await expect(service.decideHospitalHandoff(actor("vet-b"), offered.handoff.id, { decision: "ACCEPT", expectedVersion: 1, idempotencyKey: "revoked" })).rejects.toMatchObject({ status: 404 }); await expect(service.offerHospitalHandoff(actor(), offer)).rejects.toMatchObject({ status: 404 }); expect(store.getState().hospitalTasks[0].responsibleUserId).toBe("user-vet");
  });
  it("transfers the original diagnostic item without changing FSM, SLA or acknowledgments", async () => {
    const { store, service, actor, shift } = setup(); const from = await shift("lab-from", "2026-10-11T06:00:00Z", "2026-10-11T12:00:00Z", "user-lab", "LABORATORY"); const to = await shift("lab-to", "2026-10-11T12:00:00Z", "2026-10-11T18:00:00Z", "lab-b", "LABORATORY");
    const request = await service.createRequest(actor(), { patientId: "patient-thor", encounterId: "encounter-thor", priority: "URGENT", items: [{ serviceId: "service-hemogram" }] }, { idempotencyKey: "request" }); const itemId = request.items[0].id;
    await service.assignDiagnosticItem(actor("user-lab"), itemId, { userId: "user-lab", expectedVersion: 1, idempotencyKey: "responsible" }); await service.assignHospitalActivityShift(actor("super"), { targetType: "DIAGNOSTIC_ITEM", targetId: itemId, shiftId: from.shift.id, expectedVersion: 2, idempotencyKey: "bind-item" }); const previous = structuredClone(store.getState().items[0]);
    const offered = await service.offerHospitalHandoff(actor("user-lab"), { fromShiftId: from.shift.id, toShiftId: to.shift.id, recipientUserId: "lab-b", entries: [{ targetType: "DIAGNOSTIC_ITEM", targetId: itemId, expectedTargetVersion: previous.version }], idempotencyKey: "offer-item" });
    await service.decideHospitalHandoff(actor("lab-b"), offered.handoff.id, { decision: "ACCEPT", expectedVersion: 1, idempotencyKey: "accept-item" }); expect(store.getState().items[0]).toMatchObject({ id: previous.id, assignedUserId: "lab-b", shiftId: to.shift.id, status: previous.status, requestedAt: previous.requestedAt, dueAt: previous.dueAt, slaStartedAt: previous.slaStartedAt, slaPolicyVersion: previous.slaPolicyVersion, priority: previous.priority }); expect(store.getState().results).toEqual([]);
  });
  it("withdraws stale coverage and archives without cancelling assigned pending work", async () => {
    const { store, service, actor, shift, task } = setup(); const created = await shift("current", "2026-10-11T12:00:00Z", "2026-10-11T18:00:00Z", "user-vet"); const pending = await task("pending"); await service.assignHospitalActivityShift(actor("super"), { targetType: "HOSPITAL_TASK", targetId: pending.task.id, shiftId: created.shift.id, expectedVersion: 1, idempotencyKey: "bind" });
    await store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === "user-vet" ? { ...user, active: false } : user) }, result: undefined })); expect(currentShiftCoverage(store.getState(), "INPATIENT")).toEqual([]);
    const archived = await service.updateHospitalShift(actor("super"), created.shift.id, { status: "ARCHIVED", expectedVersion: 1, idempotencyKey: "archive" }); expect(archived.shift.status).toBe("ARCHIVED"); expect(store.getState().hospitalTasks[0].phase).toBe("PENDING");
    await expect(service.createHospitalShift(actor("user-admin"), { name: "No clinical administration", departmentCode: "IT", startAt: "2026-10-11T12:00:00Z", endAt: "2026-10-11T18:00:00Z", members: [], idempotencyKey: "admin" })).rejects.toMatchObject({ status: 404 });
  });
});

it("clears an operational shift explicitly, replays the clear intent and leaves other linked work untouched", async () => {
  const f = setup(); const shift = await f.shift("from", "2026-10-11T06:00:00Z", "2026-10-11T12:00:00Z", "user-vet"); const task = await f.task("task"); const other = await f.task("other-task");
  const bind = { targetType: "HOSPITAL_TASK" as const, targetId: task.task.id, shiftId: shift.shift.id, expectedVersion: 1, idempotencyKey: "bind-task" };
  const linked = await f.service.assignHospitalActivityShift(f.actor("super"), bind); expect((await f.service.assignHospitalActivityShift(f.actor("super"), bind)).version).toBe(linked.version);
  const clear = { targetType: "HOSPITAL_TASK" as const, targetId: task.task.id, shiftId: null, expectedVersion: 2, idempotencyKey: "clear-task" }; const cleared = await f.service.assignHospitalActivityShift(f.actor("super"), clear); expect(cleared.shiftId).toBeUndefined(); expect((await f.service.assignHospitalActivityShift(f.actor("super"), clear)).version).toBe(3); expect(f.store.getState().hospitalTasks.find((task) => task.id === other.task.id)).toEqual(other.task);
});

it("refuses duplicate pending offers, a recipient outside the destination team and a target outside the origin shift", async () => {
  const f = setup(); const from = await f.shift("from", "2026-10-11T06:00:00Z", "2026-10-11T12:00:00Z", "user-vet"); const to = await f.shift("to", "2026-10-11T12:00:00Z", "2026-10-11T18:00:00Z", "vet-b"); const task = await f.task("pending"); const other = await f.task("other");
  const offer = { fromShiftId: from.shift.id, toShiftId: to.shift.id, recipientUserId: "vet-b", entries: [{ targetType: "HOSPITAL_TASK" as const, targetId: task.task.id, expectedTargetVersion: 1 }], idempotencyKey: "offer" };
  await expect(f.service.offerHospitalHandoff(f.actor(), offer)).rejects.toMatchObject({ status: 404 }); await expect(f.service.offerHospitalHandoff(f.actor(), { ...offer, toShiftId: from.shift.id, idempotencyKey: "same-shift" })).rejects.toMatchObject({ status: 400 });
  await f.service.assignHospitalActivityShift(f.actor("super"), { targetType: "HOSPITAL_TASK", targetId: task.task.id, shiftId: from.shift.id, expectedVersion: 1, idempotencyKey: "bind-task" });
  const bound = { ...offer, entries: [{ ...offer.entries[0], expectedTargetVersion: 2 }] }; const offered = await f.service.offerHospitalHandoff(f.actor(), bound);
  await expect(f.service.offerHospitalHandoff(f.actor(), { ...bound, idempotencyKey: "duplicate-pending" })).rejects.toMatchObject({ code: "HANDOFF_PENDING" });
  await expect(f.service.offerHospitalHandoff(f.actor("super"), { ...bound, recipientUserId: "user-vet", idempotencyKey: "non-member" })).rejects.toMatchObject({ status: 404 });
  await f.service.assignHospitalActivityShift(f.actor("super"), { targetType: "HOSPITAL_TASK", targetId: other.task.id, shiftId: from.shift.id, expectedVersion: 1, idempotencyKey: "bind-other" });
  const next = await f.service.offerHospitalHandoff(f.actor(), { ...bound, entries: [{ targetType: "HOSPITAL_TASK", targetId: other.task.id, expectedTargetVersion: 2 }], idempotencyKey: "different-pending" }); expect(next.handoff.id).not.toBe(offered.handoff.id);
  const rejected = await f.service.decideHospitalHandoff(f.actor("vet-b"), offered.handoff.id, { decision: "REJECT", reason: "Revisar pendência", expectedVersion: 1, idempotencyKey: "reject" });
  await expect(f.service.decideHospitalHandoff(f.actor("vet-b"), offered.handoff.id, { decision: "REJECT", reason: "Outra decisão", expectedVersion: rejected.handoff.version, idempotencyKey: "already-decided" })).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
});

it("replays a diagnostic handoff only with current eligibility and clears its shift without changing clinical deadlines", async () => {
  const f = setup(); const from = await f.shift("lab-from", "2026-10-11T06:00:00Z", "2026-10-11T12:00:00Z", "user-lab", "LABORATORY"); const to = await f.shift("lab-to", "2026-10-11T12:00:00Z", "2026-10-11T18:00:00Z", "lab-b", "LABORATORY");
  const request = await f.service.createRequest(f.actor(), { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-hemogram" }] }, { idempotencyKey: "request" }); const itemId = request.items[0].id;
  await f.service.assignDiagnosticItem(f.actor("user-lab"), itemId, { userId: "user-lab", expectedVersion: 1, idempotencyKey: "assign" }); await f.service.assignHospitalActivityShift(f.actor("super"), { targetType: "DIAGNOSTIC_ITEM", targetId: itemId, shiftId: from.shift.id, expectedVersion: 2, idempotencyKey: "bind" });
  const before = structuredClone(f.store.getState().items[0]); const offer = { fromShiftId: from.shift.id, toShiftId: to.shift.id, recipientUserId: "lab-b", entries: [{ targetType: "DIAGNOSTIC_ITEM" as const, targetId: itemId, expectedTargetVersion: 3 }], idempotencyKey: "offer" }; const offered = await f.service.offerHospitalHandoff(f.actor("user-lab"), offer); expect((await f.service.offerHospitalHandoff(f.actor("user-lab"), offer)).handoff.id).toBe(offered.handoff.id);
  await f.service.decideHospitalHandoff(f.actor("lab-b"), offered.handoff.id, { decision: "ACCEPT", expectedVersion: 1, idempotencyKey: "accept" });
  const clear = { targetType: "DIAGNOSTIC_ITEM" as const, targetId: itemId, shiftId: null, expectedVersion: 4, idempotencyKey: "clear", correlationId: "synthetic-clear-diagnostic-shift" }; expect((await f.service.assignHospitalActivityShift(f.actor("super"), clear)).shiftId).toBeUndefined();
  expect(f.store.getState().items[0]).toMatchObject({ status: before.status, dueAt: before.dueAt, slaStartedAt: before.slaStartedAt, assignedUserId: "lab-b" });
  await f.store.transaction((state) => ({ state: { ...state, items: state.items.map((item) => ({ ...item, status: "COMPLETED" })) }, result: undefined })); await expect(f.service.assignHospitalActivityShift(f.actor("super"), { ...clear, shiftId: to.shift.id, expectedVersion: 5, idempotencyKey: "terminal" })).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
});
