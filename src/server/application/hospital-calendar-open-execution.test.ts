import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HospitalTaskView } from "@cvg/contracts";
import type { DiagnosticItem, StoreState } from "../domain/models";
import { BOOKING_WINDOW, hospitalOperationFixture, OPERATION_NOW } from "../../test/hospital-operation-fixtures";

const laterWindow = { from: "2026-10-11T11:00:00Z", to: "2026-10-11T12:00:00Z", departmentCode: "ULTRASOUND" };
async function startedReservation(c: ReturnType<typeof hospitalOperationFixture>, kind: "TASK" | "DIAGNOSTIC", resourceId: string): Promise<{ task?: HospitalTaskView; item?: DiagnosticItem }> {
  if (kind === "TASK") {
    const task = await c.task("capacity-overrun-task");
    await c.service.reserveHospitalTaskSchedule(c.user("user-us"), task.task.id, { ...BOOKING_WINDOW, resourceIds: [resourceId], expectedVersion: task.task.version, idempotencyKey: "capacity-overrun-reserve-task" });
    return { task: await c.service.commandHospitalTask(c.user("user-us"), task.task.id, { command: "START", expectedVersion: task.task.version, idempotencyKey: "capacity-overrun-start-task" }) };
  }
  const item = await c.ultrasound("capacity-overrun-exam");
  const booked = await c.service.scheduleProcedure(c.user("user-us"), item.id, { ...BOOKING_WINDOW, resourceIds: [resourceId], expectedVersion: item.version, idempotencyKey: "capacity-overrun-reserve-exam" });
  const started = await c.service.startProcedure(c.user("user-us"), item.id, { expectedVersion: booked.item.version, idempotencyKey: "capacity-overrun-start-exam" });
  return { item: c.store.getState().items.find(entry => entry.id === started.item.id)! };
}

describe("open execution across resource windows", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(OPERATION_NOW); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it("opens every diagnostic event at its existing request and item, retaining native identity and deadlines", async () => {
    const c = hospitalOperationFixture(); const resource = await c.resource(); const item = await c.ultrasound("calendar-native-links");
    const booking = await c.service.scheduleProcedure(c.user("user-us"), item.id, { ...BOOKING_WINDOW, resourceIds: [resource.id], expectedVersion: item.version, idempotencyKey: "calendar-native-reservation" });
    await c.service.startProcedure(c.user("user-us"), item.id, { expectedVersion: booking.item.version, idempotencyKey: "calendar-native-start" });
    const before = structuredClone(c.store.getState());
    const calendar = await c.service.listHospitalCalendar(c.user("user-us"), { from: OPERATION_NOW, to: "2026-10-14T10:00:00Z" });
    expect(calendar.items.map(event => event.kind).sort()).toEqual(["DEADLINE", "EXECUTION", "RESERVATION"]);
    for (const event of calendar.items) expect(event).toMatchObject({ targetType: "DIAGNOSTIC_ITEM", targetId: item.id, deepLink: `/requests/${item.requestId}#${item.id}` });
    expect(c.store.getState()).toEqual(before);
  });

  it("paginates open task and diagnostic executions that began before the window without fabricating an end", async () => {
    const c = hospitalOperationFixture(); const resource = await c.resource(); const item = await c.ultrasound("calendar-crossing-exam");
    const booking = await c.service.scheduleProcedure(c.user("user-us"), item.id, { ...BOOKING_WINDOW, resourceIds: [resource.id], expectedVersion: item.version, idempotencyKey: "calendar-crossing-booking" });
    await c.service.startProcedure(c.user("user-us"), item.id, { expectedVersion: booking.item.version, idempotencyKey: "calendar-crossing-start" });
    const task = await c.task("calendar-crossing-task"); await c.service.commandHospitalTask(c.user("user-us"), task.task.id, { command: "START", expectedVersion: task.task.version, idempotencyKey: "calendar-crossing-task-start" });
    vi.setSystemTime("2026-10-11T11:15:00Z");
    const first = await c.service.listHospitalCalendar(c.user("user-us"), { ...laterWindow, kinds: ["EXECUTION"], limit: 1 });
    expect(first.total).toBe(2); expect(first.nextCursor).toBeTruthy();
    const second = await c.service.listHospitalCalendar(c.user("user-us"), { ...laterWindow, kinds: ["EXECUTION"], limit: 1, cursor: first.nextCursor });
    expect(new Set([...first.items, ...second.items].map(event => event.targetId))).toEqual(new Set([item.id, task.task.id]));
    expect(second.nextCursor).toBeUndefined();
    for (const event of [...first.items, ...second.items]) { expect(event.startsAt).toBe(OPERATION_NOW); expect(event.endsAt).toBeUndefined(); }
  });

  it.each(["TASK", "DIAGNOSTIC"] as const)("keeps %s resource availability unknown while execution runs late, recovering only after native completion", async kind => {
    const c = hospitalOperationFixture(); const resource = await c.resource();
    const { task: startedTask, item: startedItem } = await startedReservation(c, kind, resource.id);
    vi.setSystemTime("2026-10-11T11:15:00Z");
    const before = structuredClone(c.store.getState());
    const capacity = await c.service.getHospitalCapacity(c.user("user-us"), laterWindow);
    expect(capacity.resources).toMatchObject([{ resourceId: resource.id, unit: "MINUTES", nominal: 60, reserved: 0, unavailable: 0, available: null, availabilityKnown: false, reason: "EXECUTION_END_UNKNOWN" }]);
    expect(c.store.getState()).toEqual(before); expect(capacity.sla.calendarPausesDeadline).toBe(false);
    const challenger = await c.task("capacity-overrun-challenger");
    await expect(c.service.reserveHospitalTaskSchedule(c.user("user-us"), challenger.task.id, { startsAt: laterWindow.from, endsAt: laterWindow.to, resourceIds: [resource.id], expectedVersion: challenger.task.version, idempotencyKey: "capacity-overrun-conflict" })).rejects.toMatchObject({ code: "RESOURCE_EXECUTION_IN_PROGRESS" });
    if (startedTask) await c.service.commandHospitalTask(c.user("user-us"), startedTask.task.id, { command: "COMPLETE", expectedVersion: startedTask.task.version, idempotencyKey: "capacity-overrun-complete-task" });
    if (startedItem) await c.service.markProcedurePerformed(c.user("user-us"), startedItem.id, { expectedVersion: startedItem.version, idempotencyKey: "capacity-overrun-performed-exam" });
    const recovered = await c.service.getHospitalCapacity(c.user("user-us"), laterWindow);
    expect(recovered.resources[0]).toMatchObject({ nominal: 60, reserved: 0, unavailable: 0, available: 60, availabilityKnown: true }); expect(recovered.resources[0].reason).toBeUndefined();
    const events = (await c.service.listHospitalCalendar(c.user("user-us"), { ...laterWindow, kinds: ["EXECUTION"] })).items;
    expect(events).toHaveLength(1); expect(events[0].endsAt).toBe("2026-10-11T11:15:00.000Z");
    expect((await c.service.listHospitalCalendar(c.user("user-us"), { ...laterWindow, from: "2026-10-11T11:15:00Z", kinds: ["EXECUTION"] })).items).toEqual([]);
    if (startedItem) expect(c.store.getState().items.find(entry => entry.id === startedItem.id)?.dueAt).toBe(startedItem.dueAt);
  });

  it("does not carry cancelled or historical executions into later windows, or pull future deadlines into past windows", async () => {
    const c = hospitalOperationFixture(); const task = await c.task("calendar-cancelled");
    const started = await c.service.commandHospitalTask(c.user("user-us"), task.task.id, { command: "START", expectedVersion: task.task.version, idempotencyKey: "calendar-cancelled-start" });
    vi.setSystemTime("2026-10-11T10:20:00Z");
    await c.service.commandHospitalTask(c.user("user-us"), task.task.id, { command: "CANCEL", reason: "Interrupção sintética", expectedVersion: started.task.version, idempotencyKey: "calendar-cancelled-command" });
    await c.ultrasound("calendar-future-deadline");
    expect((await c.service.listHospitalCalendar(c.user("user-us"), { ...laterWindow, kinds: ["EXECUTION"] })).items).toEqual([]);
    const during = await c.service.listHospitalCalendar(c.user("user-us"), { ...laterWindow, from: "2026-10-11T10:10:00Z", kinds: ["EXECUTION"] });
    expect(during.items).toMatchObject([{ targetId: task.task.id, endsAt: "2026-10-11T10:20:00.000Z" }]);
    expect((await c.service.listHospitalCalendar(c.user("user-us"), { from: "2026-10-11T09:00:00Z", to: OPERATION_NOW, kinds: ["DEADLINE"] })).items).toEqual([]);
  });

  it("retains instantaneous completion and legacy terminal timestamps as points rather than open occupancy", async () => {
    const c = hospitalOperationFixture(); const task = await c.task("calendar-instantaneous");
    const started = await c.service.commandHospitalTask(c.user("user-us"), task.task.id, { command: "START", expectedVersion: 1, idempotencyKey: "calendar-instant-start" });
    await c.service.commandHospitalTask(c.user("user-us"), task.task.id, { command: "COMPLETE", expectedVersion: started.task.version, idempotencyKey: "calendar-instant-complete" });
    const item = await c.ultrasound("calendar-legacy-terminal");
    // Historical records may lack an actual end; their timestamp cannot imply ongoing execution.
    await c.store.transaction(state => ({ state: { ...state, items: state.items.map(entry => entry.id === item.id ? { ...entry, status: "CANCELLED", startedAt: OPERATION_NOW } : entry) }, result: undefined }));
    const at = await c.service.listHospitalCalendar(c.user("user-us"), { ...laterWindow, from: OPERATION_NOW, kinds: ["EXECUTION"] });
    expect(new Set(at.items.map(event => event.targetId))).toEqual(new Set([task.task.id, item.id]));
    expect(at.items.find(event => event.targetId === task.task.id)).toMatchObject({ startsAt: OPERATION_NOW, endsAt: OPERATION_NOW });
    expect(at.items.find(event => event.targetId === item.id)?.endsAt).toBeUndefined();
    expect((await c.service.listHospitalCalendar(c.user("user-us"), { ...laterWindow, kinds: ["EXECUTION"] })).items).toEqual([]);
    expect((await c.service.listHospitalCalendar(c.user("user-us"), { from: "2026-10-11T09:00:00Z", to: OPERATION_NOW, kinds: ["EXECUTION"] })).items).toEqual([]);
  });

  it("keeps planned capacity and availability priorities explicit without predicting an ongoing execution end", async () => {
    const c = hospitalOperationFixture(); const resource = await c.resource();
    await startedReservation(c, "TASK", resource.id); vi.setSystemTime("2026-10-11T11:15:00Z");
    expect((await c.service.getHospitalCapacity(c.user("user-us"), { ...laterWindow, from: "2026-10-11T09:00:00Z", to: OPERATION_NOW })).resources[0]).toMatchObject({ nominal: 60, reserved: 0, available: 60, availabilityKnown: true });
    const current = await c.service.getHospitalCapacity(c.user("user-us"), { ...laterWindow, from: OPERATION_NOW, to: "2026-10-11T11:00:00Z" });
    expect(current.resources[0]).toMatchObject({ nominal: 60, reserved: 60, unavailable: 0, available: null, reason: "EXECUTION_END_UNKNOWN" });
    expect((await c.service.getHospitalCapacity(c.user("user-us"), { ...laterWindow, from: "2026-10-12T10:00:00Z", to: "2026-10-12T11:00:00Z" })).resources[0]).toMatchObject({ nominal: 0, reserved: 0, available: null, reason: "EXECUTION_END_UNKNOWN" });
    await c.service.updateHospitalResource(c.user("user-admin"), resource.id, { availability: "MAINTENANCE", expectedVersion: resource.version, idempotencyKey: "overrun-maintenance" });
    expect((await c.service.getHospitalCapacity(c.user("user-us"), laterWindow)).resources[0]).toMatchObject({ nominal: 60, reserved: 0, unavailable: 60, available: 0, availabilityKnown: true, reason: "RESOURCE_UNAVAILABLE" });
    await c.service.updateHospitalResource(c.user("user-admin"), resource.id, { availabilityWindows: [], expectedVersion: 2, idempotencyKey: "overrun-calendar-withdrawn" });
    expect((await c.service.getHospitalCapacity(c.user("user-us"), laterWindow)).resources[0]).toMatchObject({ nominal: null, reserved: 0, unavailable: null, available: null, availabilityKnown: false, reason: "CALENDAR_NOT_CONFIGURED" });
  });

  it.each(["TASK", "DIAGNOSTIC"] as const)("does not turn invalid or historical %s bindings into indefinite resource occupancy", async kind => {
    const c = hospitalOperationFixture(); const resource = await c.resource(); const target = await startedReservation(c, kind, resource.id);
    vi.setSystemTime("2026-10-11T11:15:00Z"); const valid = structuredClone(c.store.getState()); const schedule = valid.schedules[0];
    const common: Array<(state: StoreState) => void> = [
      state => { state.schedules[0].status = "CANCELLED"; },
      state => { state.schedules[0].hospitalTaskId = "orphan-task"; state.schedules[0].procedureId = "orphan-procedure"; },
      state => { state.schedules[0].hospitalTaskId = undefined; state.schedules[0].procedureId = undefined; }
    ];
    const conditions: Array<(state: StoreState) => void> = target.task ? [
      state => { state.hospitalTasks = []; },
      state => { state.hospitalTasks[0].phase = "CANCELLED"; },
      state => { state.hospitalTasks[0].isDraft = true; },
      state => { state.hospitalTasks[0].draftCancelledAt = OPERATION_NOW; },
      state => { state.hospitalTasks[0].archivedAt = OPERATION_NOW; }
    ] : [
      state => { state.procedures = state.procedures.filter(entry => entry.id !== schedule.procedureId); },
      state => { state.procedures.find(entry => entry.id === schedule.procedureId)!.scheduleIds = []; },
      state => { state.items = state.items.filter(entry => entry.id !== target.item!.id); },
      state => { state.items.find(entry => entry.id === target.item!.id)!.status = "REJECTED"; }
    ];
    expect((await c.service.getHospitalCapacity(c.user("user-us"), laterWindow)).resources[0].reason).toBe("EXECUTION_END_UNKNOWN");
    for (const invalidate of [...common, ...conditions]) {
      const damaged = structuredClone(valid); invalidate(damaged);
      await c.store.transaction(() => ({ state: damaged, result: undefined }));
      expect((await c.service.getHospitalCapacity(c.user("user-us"), laterWindow)).resources[0]).toMatchObject({ available: 60, availabilityKnown: true, reserved: 0 });
      expect((await c.service.getHospitalCapacity(c.user("user-us"), laterWindow)).resources[0].reason).toBeUndefined();
    }
    if (target.item) {
      const orphan = structuredClone(valid); orphan.requests = orphan.requests.filter(entry => entry.id !== target.item!.requestId);
      await c.store.transaction(() => ({ state: orphan, result: undefined }));
      await expect(c.service.getHospitalCapacity(c.user("user-us"), laterWindow)).rejects.toMatchObject({ status: 404 });
      expect((await c.service.listHospitalCalendar(c.user("user-us"), { ...laterWindow, kinds: ["EXECUTION"] })).items).toEqual([]);
    }
  });

  it.each(["TASK", "DIAGNOSTIC"] as const)("keeps current and future %s availability unknown when the active authority lacks a trustworthy start", async kind => {
    const c = hospitalOperationFixture(); const resource = await c.resource(); const target = await startedReservation(c, kind, resource.id);
    vi.setSystemTime("2026-10-11T11:15:00Z"); const valid = structuredClone(c.store.getState());
    const challenger = await c.task("unknown-start-challenger");
    for (const startedAt of [undefined, "invalid-historical-timestamp", "2026-10-12T10:00:00Z"]) {
      const state = structuredClone(valid); state.hospitalTasks.push(challenger.task);
      if (target.task) state.hospitalTasks.find(entry => entry.id === target.task!.task.id)!.startedAt = startedAt;
      if (target.item) state.items.find(entry => entry.id === target.item!.id)!.startedAt = startedAt;
      await c.store.transaction(() => ({ state, result: undefined }));
      for (const window of [laterWindow, { ...laterWindow, from: "2026-10-11T12:00:00Z", to: "2026-10-11T13:00:00Z" }]) {
        expect((await c.service.getHospitalCapacity(c.user("user-us"), window)).resources[0]).toMatchObject({ nominal: 60, reserved: 0, available: null, availabilityKnown: false, reason: "EXECUTION_END_UNKNOWN" });
      }
      await expect(c.service.reserveHospitalTaskSchedule(c.user("user-us"), challenger.task.id, { startsAt: laterWindow.from, endsAt: laterWindow.to, resourceIds: [resource.id], expectedVersion: challenger.task.version, idempotencyKey: `unknown-start-conflict-${String(startedAt)}` })).rejects.toMatchObject({ code: "RESOURCE_EXECUTION_IN_PROGRESS" });
      expect((await c.service.getHospitalCapacity(c.user("user-us"), { ...laterWindow, from: "2026-10-11T09:00:00Z", to: OPERATION_NOW })).resources[0]).toMatchObject({ available: 60, availabilityKnown: true });
      if (!startedAt) expect((await c.service.listHospitalCalendar(c.user("user-us"), { ...laterWindow, kinds: ["EXECUTION"] })).items).toEqual([]);
    }
  });

  it("rechecks current grants and sector delegation before exposing an open execution or its diagnostic link", async () => {
    const c = hospitalOperationFixture(); const resource = await c.resource(); await startedReservation(c, "DIAGNOSTIC", resource.id);
    vi.setSystemTime("2026-10-11T11:15:00Z");
    expect((await c.service.listHospitalCalendar(c.user("user-manager"), { ...laterWindow, kinds: ["EXECUTION"] })).total).toBe(1);
    const snapshot = structuredClone(c.store.getState());
    await expect(c.service.listHospitalCalendar(c.user("user-lab"), { ...laterWindow, kinds: ["EXECUTION"] })).rejects.toMatchObject({ status: 404 });
    await expect(c.service.getHospitalCapacity(c.user("user-lab"), laterWindow)).rejects.toMatchObject({ status: 404 });
    expect(c.store.getState()).toEqual(snapshot);
    const manager = c.user("user-manager");
    const group = await c.service.createAccessGroup(c.user("user-admin"), { code: "OPEN_EXECUTION_CAPACITY_ONLY", description: "Capacidade sem leitura de atividade clínica", permissions: ["hospital_capacity.view"], idempotencyKey: "open-execution-current-group" });
    await c.service.assignUserAccessGroup(c.user("user-admin"), manager.id, { accessGroupId: group.id, expectedVersion: manager.version, expectedGroupVersion: group.version, idempotencyKey: "open-execution-revoke-reading" });
    await expect(c.service.listHospitalCalendar(c.user("user-manager"), { ...laterWindow, kinds: ["EXECUTION"] })).rejects.toMatchObject({ status: 404 });
    const capacity = await c.service.getHospitalCapacity(c.user("user-manager"), laterWindow);
    expect(capacity.resources[0].reason).toBe("EXECUTION_END_UNKNOWN");
    expect(capacity.authorizedLoad).toEqual({ openDiagnosticItems: 0, overdueDiagnosticItems: 0, openHospitalTasks: 0, estimatedMinutes: 0 });
    expect(JSON.stringify(capacity)).not.toContain("patient-thor");
  });
});
