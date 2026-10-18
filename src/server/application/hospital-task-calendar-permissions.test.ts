import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Permission } from "@cvg/contracts";
import { hospitalOperationFixture, BOOKING_WINDOW, OPERATION_NOW } from "../../test/hospital-operation-fixtures";
import { authenticateRequest, getSessionCookieName, loginUser } from "../security/session";

function setup() {
  const c = hospitalOperationFixture();
  const manager = () => c.user("user-manager");
  const create = (key: string) => c.service.createHospitalTask(manager(), { title: "Conferência operacional sintética", typeId: "hospital-task-type-routine", departmentCode: "INPATIENT", responsibleUserId: manager().id, priority: "ROUTINE", idempotencyKey: key });
  const limit = async (permissions: Permission[]) => {
    const group = await c.service.createAccessGroup(c.user("user-admin"), { code: "CONTEXTUAL_CALENDAR_READ", description: "Leitura contextual reduzida", permissions, idempotencyKey: "limited-group" });
    await c.service.assignUserAccessGroup(c.user("user-admin"), manager().id, { accessGroupId: group.id, expectedVersion: manager().version, expectedGroupVersion: group.version, idempotencyKey: "limited-manager" });
    return group;
  };
  return { ...c, manager, create, limit };
}

describe("native task calendar capabilities and current authorization", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(OPERATION_NOW); });
  afterEach(() => { vi.useRealTimers(); });

  it("projects calendar reading with native booking actions and keeps terminal/archive calendars read only", async () => {
    const c = setup();
    const room = await c.resource({ kind: "ROOM", departmentCode: "INPATIENT" });
    const pending = await c.create("booking-journey");
    expect(pending.permissions).toEqual(expect.arrayContaining(["hospital_task.view", "hospital_calendar.view", "hospital_calendar.reserve"]));
    expect(pending.reservations).toEqual([]);
    const schedule = await c.service.reserveHospitalTaskSchedule(c.manager(), pending.task.id, { ...BOOKING_WINDOW, resourceIds: [room.id], expectedVersion: pending.task.version, idempotencyKey: "reserve-real-room" });
    const booked = await c.service.getHospitalTask(c.manager(), pending.task.id);
    expect(booked.task).toEqual(pending.task);
    expect(booked.reservations).toEqual([schedule]);
    expect(booked.permissions).toEqual(expect.arrayContaining(["hospital_calendar.view", "hospital_calendar.reschedule", "hospital_calendar.cancel"]));
    expect(booked.permissions).not.toContain("hospital_calendar.reserve");
    const started = await c.service.commandHospitalTask(c.manager(), pending.task.id, { command: "START", expectedVersion: booked.task.version, idempotencyKey: "start-booked-task" });
    expect(started.permissions).toContain("hospital_calendar.view");
    expect(started.permissions).not.toContain("hospital_calendar.reserve");
    expect(started.permissions).not.toContain("hospital_calendar.reschedule");
    const completed = await c.service.commandHospitalTask(c.manager(), pending.task.id, { command: "COMPLETE", expectedVersion: started.task.version, idempotencyKey: "complete-operational-task" });
    expect(completed.task.careExecution).toBeUndefined();
    expect(completed.permissions).toContain("hospital_calendar.view");
    expect(completed.permissions.filter((permission) => permission.startsWith("hospital_calendar.") && permission !== "hospital_calendar.view")).toEqual([]);
    expect(completed.reservations).toEqual([]);
    expect(c.store.getState().schedules.find((entry) => entry.id === schedule.id)).toMatchObject({ status: "COMPLETED", version: 2 });
    await expect(c.service.reserveHospitalTaskSchedule(c.manager(), completed.task.id, { ...BOOKING_WINDOW, resourceIds: [room.id], expectedVersion: completed.task.version, idempotencyKey: "terminal-cannot-reserve" })).rejects.toMatchObject({ status: 409 });
    const archived = await c.service.setHospitalTaskArchived(c.manager(), completed.task.id, { archived: true, expectedVersion: completed.task.version, idempotencyKey: "archive-completed" });
    expect(archived.permissions).toEqual(expect.arrayContaining(["hospital_calendar.view", "hospital_task.restore"]));
    expect(archived.permissions.filter((permission) => permission.startsWith("hospital_calendar.") && permission !== "hospital_calendar.view")).toEqual([]);
    await expect(c.service.reserveHospitalTaskSchedule(c.manager(), archived.task.id, { ...BOOKING_WINDOW, resourceIds: [room.id], expectedVersion: archived.task.version, idempotencyKey: "archived-cannot-reserve" })).rejects.toMatchObject({ status: 409 });
    const historical = await c.service.listHospitalCalendar(c.manager(), { from: BOOKING_WINDOW.startsAt, to: BOOKING_WINDOW.endsAt, departmentCode: "INPATIENT" });
    expect(historical.items).toMatchObject([
      { kind: "EXECUTION", targetId: completed.task.id, startsAt: OPERATION_NOW, endsAt: OPERATION_NOW, deepLink: `/planner/tasks/${completed.task.id}` },
      { kind: "RESERVATION", targetId: completed.task.id, schedule: { id: schedule.id, status: "COMPLETED", version: 2 } }
    ]);
    expect((await c.service.getHospitalTask(c.manager(), archived.task.id)).task).toEqual(archived.task);
  });

  it("preserves cancellation and private-draft early returns without operational capabilities", async () => {
    const c = setup(); const task = await c.create("cancelled-task");
    const cancelled = await c.service.commandHospitalTask(c.manager(), task.task.id, { command: "CANCEL", reason: "Rotina operacional dispensada", expectedVersion: task.task.version, idempotencyKey: "cancel" });
    expect(cancelled.permissions).toContain("hospital_calendar.view");
    expect(cancelled.permissions).not.toContain("hospital_calendar.reserve");
    expect(cancelled.task.startedAt).toBeUndefined();
    const draft = await c.service.createHospitalTaskDraft(c.manager(), { title: "Rascunho operacional privado", typeId: "hospital-task-type-routine", departmentCode: "INPATIENT", priority: "ROUTINE", idempotencyKey: "private-draft" });
    expect(draft.permissions).toEqual(["hospital_task.view", "hospital_task.update"]);
    expect(draft.reservations).toBeUndefined();
    await expect(c.service.reserveHospitalTaskSchedule(c.manager(), draft.task.id, { ...BOOKING_WINDOW, resourceIds: [], expectedVersion: draft.task.version, idempotencyKey: "draft-reservation" })).rejects.toMatchObject({ status: 404 });
  });

  it("a task-read-only group gets neither reservation details nor calendar writes", async () => {
    const c = setup(); const room = await c.resource({ departmentCode: "INPATIENT" }); const task = await c.create("read-only-task");
    const schedule = await c.service.reserveHospitalTaskSchedule(c.manager(), task.task.id, { ...BOOKING_WINDOW, resourceIds: [room.id], expectedVersion: task.task.version, idempotencyKey: "booking-before-reduction" });
    await c.limit(["hospital_task.view"]);
    const view = await c.service.getHospitalTask(c.manager(), task.task.id);
    expect(view.permissions).toEqual(["hospital_task.view"]); expect(view.reservations).toBeUndefined();
    await expect(c.service.reserveHospitalTaskSchedule(c.manager(), task.task.id, { ...BOOKING_WINDOW, resourceIds: [room.id], expectedVersion: task.task.version, idempotencyKey: "read-cannot-book" })).rejects.toMatchObject({ status: 404 });
    await expect(c.service.cancelHospitalTaskSchedule(c.manager(), schedule.id, { reason: "Sem autorização", expectedVersion: schedule.version, idempotencyKey: "read-cannot-cancel" })).rejects.toMatchObject({ status: 404 });
    expect(c.store.getState().schedules.find((entry) => entry.id === schedule.id)).toEqual(schedule);
  });

  it("calendar reading alone cannot bypass task-read authority", async () => {
    const c = setup(); const task = await c.create("task-authority-required");
    await c.limit(["hospital_calendar.view"]);
    await expect(c.service.getHospitalTask(c.manager(), task.task.id)).rejects.toMatchObject({ status: 404 });
    expect(c.store.getState().hospitalTasks.find((entry) => entry.id === task.task.id)).toEqual(task.task);
  });

  it("permission withdrawal revokes a real session and removes reading/details in the fresh task DTO", async () => {
    const c = setup(); const room = await c.resource({ departmentCode: "INPATIENT" }); const task = await c.create("current-permission-task");
    const schedule = await c.service.reserveHospitalTaskSchedule(c.manager(), task.task.id, { ...BOOKING_WINDOW, resourceIds: [room.id], expectedVersion: task.task.version, idempotencyKey: "current-booking" });
    const group = await c.limit(["hospital_task.view", "hospital_calendar.view"]);
    const sessionRequest = (token: string) => new Request("http://localhost/api/v1/hospital-tasks", { headers: { cookie: `${getSessionCookieName()}=${token}` } });
    const login = await loginUser(c.store, c.manager().email, "hospital-operation-fixture-password");
    const actor = await authenticateRequest(c.store, sessionRequest(login.sessionToken));
    const readable = await c.service.getHospitalTask(actor, task.task.id);
    expect(readable.permissions).toEqual(["hospital_task.view", "hospital_calendar.view"]); expect(readable.reservations).toEqual([schedule]);
    await c.service.updateAccessGroup(c.user("user-admin"), group.id, { permissions: ["hospital_task.view"], expectedVersion: group.version, idempotencyKey: "revoke-calendar-read" });
    await expect(authenticateRequest(c.store, sessionRequest(login.sessionToken))).rejects.toMatchObject({ status: 401 });
    await expect(c.service.getHospitalTask(actor, task.task.id)).rejects.toMatchObject({ status: 401 });
    const freshLogin = await loginUser(c.store, c.manager().email, "hospital-operation-fixture-password");
    const freshActor = await authenticateRequest(c.store, sessionRequest(freshLogin.sessionToken));
    const reduced = await c.service.getHospitalTask(freshActor, task.task.id);
    expect(reduced.permissions).toEqual(["hospital_task.view"]); expect(reduced.reservations).toBeUndefined();
    await expect(c.service.listHospitalCalendar(freshActor, { from: BOOKING_WINDOW.startsAt, to: BOOKING_WINDOW.endsAt })).rejects.toMatchObject({ status: 404 });
    expect(reduced.task).toEqual(task.task); expect(c.store.getState().schedules.find((entry) => entry.id === schedule.id)).toEqual(schedule);
  });
});
