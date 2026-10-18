import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hospitalOperationFixture, BOOKING_WINDOW, OPERATION_NOW, OPERATION_WINDOW } from "../../test/hospital-operation-fixtures";
import { systemGroupId } from "../security/access-group-policy";

describe("registered resources and shared reservation authority", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(OPERATION_NOW); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
  it("registers stable inventory without grants and preserves booked identity through metadata changes", async () => {
    const c = hospitalOperationFixture(); const before = c.store.getState(); const room = await c.resource({ kind: "ROOM" }); const task = await c.task("task");
    const reservation = await c.service.reserveHospitalTaskSchedule(c.user("user-us"), task.task.id, { ...BOOKING_WINDOW, resourceIds: [room.id], expectedVersion: 1, idempotencyKey: "reserve" });
    const changed = await c.service.updateHospitalResource(c.user("user-admin"), room.id, { name: "Nome atual", expectedVersion: 1, idempotencyKey: "rename" });
    expect(changed.version).toBe(2); expect(reservation.resourceSnapshots?.[0]).toMatchObject({ name: room.name, resourceVersion: 1 });
    expect(c.store.getState().users).toEqual(before.users); expect(c.store.getState().accessGroups).toEqual(before.accessGroups); expect(c.store.getState().patientGrants).toEqual(before.patientGrants);
    await expect(c.service.updateHospitalResource(c.user("user-admin"), room.id, { departmentCode: "RADIOLOGY", expectedVersion: 2, idempotencyKey: "move-used" })).rejects.toMatchObject({ code: "RESOURCE_IN_USE" });
  });
  it("requires one active registered professional and forbids alias inventories or foreign membership", async () => {
    const c = hospitalOperationFixture(); await c.resource({ kind: "PROFESSIONAL", userId: "user-us" });
    await expect(c.resource({ kind: "PROFESSIONAL", userId: "user-us" })).rejects.toMatchObject({ status: 409 });
    await expect(c.resource({ kind: "PROFESSIONAL", userId: "user-vet" })).rejects.toMatchObject({ code: "RESOURCE_PROFESSIONAL_UNAVAILABLE" });
    await expect(c.resource({ kind: "PROFESSIONAL", userId: "missing" })).rejects.toMatchObject({ code: "RESOURCE_PROFESSIONAL_UNAVAILABLE" });
  });
  it("provides create-only options without exposing patients or permitting inventory or clinical reads", async () => {
    const c = hospitalOperationFixture(); await c.store.transaction((state) => ({ state: { ...state, accessGroups: state.accessGroups.map((group) => group.id === systemGroupId("ADMIN") ? { ...group, permissions: ["hospital_resource.create"] } : group) }, result: undefined }));
    const options = await c.service.getHospitalResourceOptions(c.user("user-admin")); expect(options.departments).not.toHaveLength(0); expect(options.professionals).toContainEqual(expect.objectContaining({ id: "user-us" }));
    expect(JSON.stringify(options)).not.toMatch(/patientIds|passwordHash|whatsapp/); await c.resource();
    await expect(c.service.listHospitalResources(c.user("user-admin"))).rejects.toMatchObject({ status: 404 });
    await expect(c.service.getBedCensus(c.user("user-admin"))).rejects.toMatchObject({ status: 404 });
    await expect(c.service.listHospitalCalendar(c.user("user-admin"), { from: OPERATION_WINDOW.startsAt, to: OPERATION_WINDOW.endsAt })).rejects.toMatchObject({ status: 404 });
  });
  it("applies delegated sectors to options, reads and both sides of a move", async () => {
    const c = hospitalOperationFixture(); await c.store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === "user-manager" ? { ...user, managedDepartmentCodes: ["ULTRASOUND"] } : user) }, result: undefined }));
    const manager = c.user("user-manager"); const resource = await c.resource(); expect((await c.service.getHospitalResourceOptions(manager)).departments.map((department) => department.code)).not.toContain("RADIOLOGY");
    await expect(c.service.updateHospitalResource(manager, resource.id, { departmentCode: "RADIOLOGY", expectedVersion: 1, idempotencyKey: "foreign-move" })).rejects.toMatchObject({ status: 404 });
    await expect(c.service.listHospitalResources(manager, { departmentCode: "RADIOLOGY" })).rejects.toMatchObject({ status: 404 });
  });
  it.each(["BLOCKED", "MAINTENANCE", "INACTIVE", "NO_CALENDAR", "UNKNOWN"])("refuses reservation for %s resources before mutation", async (condition) => {
    const c = hospitalOperationFixture(); const resource = await c.resource({ availability: condition === "BLOCKED" || condition === "MAINTENANCE" ? condition : "AVAILABLE", active: condition !== "INACTIVE", availabilityWindows: condition === "NO_CALENDAR" ? [] : [OPERATION_WINDOW] }); const task = await c.task("task"); const before = c.store.getState();
    await expect(c.service.reserveHospitalTaskSchedule(c.user("user-us"), task.task.id, { ...BOOKING_WINDOW, resourceIds: [condition === "UNKNOWN" ? "missing" : resource.id], expectedVersion: 1, idempotencyKey: "reserve" })).rejects.toMatchObject({ code: "RESOURCE_UNAVAILABLE" });
    expect(c.store.getState()).toEqual(before);
  });
  it("serializes incompatible bookings while allowing the adjacent half-open slot", async () => {
    const c = hospitalOperationFixture(); const resource = await c.resource(); const first = await c.task("first"); const second = await c.task("second");
    const results = await Promise.allSettled([first, second].map((task, index) => c.service.reserveHospitalTaskSchedule(c.user("user-us"), task.task.id, { ...BOOKING_WINDOW, resourceIds: [resource.id], expectedVersion: 1, idempotencyKey: `race-${index}` })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1); expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "SCHEDULE_CONFLICT" } });
    const loser = results[0].status === "rejected" ? first : second; await expect(c.service.reserveHospitalTaskSchedule(c.user("user-us"), loser.task.id, { startsAt: BOOKING_WINDOW.endsAt, endsAt: "2026-10-11T12:00:00Z", resourceIds: [resource.id], expectedVersion: 1, idempotencyKey: "adjacent" })).resolves.toMatchObject({ status: "SCHEDULED" });
  });
  it("shares every resource conflict between diagnostics and tasks and preserves original dueAt", async () => {
    const c = hospitalOperationFixture(); const resource = await c.resource(); const item = await c.ultrasound("request"); const dueAt = item.dueAt;
    const scheduled = await c.service.scheduleProcedure(c.user("user-us"), item.id, { ...BOOKING_WINDOW, resourceIds: [resource.id], expectedVersion: item.version, idempotencyKey: "diagnostic" }); const task = await c.task("task");
    await expect(c.service.reserveHospitalTaskSchedule(c.user("user-us"), task.task.id, { ...BOOKING_WINDOW, resourceIds: [resource.id], expectedVersion: 1, idempotencyKey: "task-conflict" })).rejects.toMatchObject({ code: "SCHEDULE_CONFLICT" });
    const moved = await c.service.rescheduleProcedure(c.user("user-us"), scheduled.procedure.id, { startsAt: "2026-10-11T11:00:00-03:00", endsAt: "2026-10-11T12:00:00-03:00", resourceIds: [resource.id], expectedVersion: 1, reason: "Recurso disponível", idempotencyKey: "move" });
    expect(moved.schedule.startsAt).toBe("2026-10-11T14:00:00.000Z"); expect(moved.history).toHaveLength(2); expect(moved.history[0].status).toBe("CANCELLED"); expect(c.store.getState().items.find((entry) => entry.id === item.id)?.dueAt).toBe(dueAt);
  });
  it("preserves task remapping history and refuses stale revision or revoked grant on replay", async () => {
    const c = hospitalOperationFixture(); const resource = await c.resource(); const task = await c.task("task"); const reserve = { ...BOOKING_WINDOW, resourceIds: [resource.id], expectedVersion: 1, idempotencyKey: "reserve" }; const schedule = await c.service.reserveHospitalTaskSchedule(c.user("user-us"), task.task.id, reserve);
    const moved = await c.service.rescheduleHospitalTaskSchedule(c.user("user-us"), schedule.id, { startsAt: BOOKING_WINDOW.endsAt, endsAt: "2026-10-11T12:00:00Z", resourceIds: [resource.id], expectedVersion: 1, reason: "Ajuste explícito", idempotencyKey: "move" });
    expect(moved.previousSchedule).toMatchObject({ status: "CANCELLED", version: 2 }); expect(c.store.getState().schedules).toHaveLength(2);
    await expect(c.service.cancelHospitalTaskSchedule(c.user("user-us"), moved.schedule.id, { reason: "Cancelamento", expectedVersion: 4, idempotencyKey: "stale" })).rejects.toMatchObject({ code: "STALE_VERSION" });
    await c.store.transaction((state) => ({ state: { ...state, accessGroups: state.accessGroups.map((group) => group.id === systemGroupId("ULTRASOUND_TEAM") ? { ...group, permissions: group.permissions.filter((permission) => permission !== "hospital_calendar.reserve") } : group) }, result: undefined }));
    await expect(c.service.reserveHospitalTaskSchedule(c.user("user-us"), task.task.id, reserve)).rejects.toMatchObject({ status: 404 });
  });
  it("requires IDs in production or configured inventory without guessing legacy resource text", async () => {
    const c = hospitalOperationFixture(); const item = await c.ultrasound("request");
    vi.stubEnv("NODE_ENV", "production"); await expect(c.service.scheduleProcedure(c.user("user-us"), item.id, { ...BOOKING_WINDOW, resource: "Ultrassom", expectedVersion: 1, idempotencyKey: "production-text" })).rejects.toMatchObject({ code: "RESOURCE_INVENTORY_REQUIRED" });
    vi.stubEnv("NODE_ENV", "test"); await c.resource({ name: "Ultrassom" }); await expect(c.service.scheduleProcedure(c.user("user-us"), item.id, { ...BOOKING_WINDOW, resource: "Ultrassom", expectedVersion: 1, idempotencyKey: "inventory-text" })).rejects.toMatchObject({ code: "RESOURCE_INVENTORY_REQUIRED" });
  });
  it.each(["BEFORE", "AT_END", "INACTIVE", "CANCELLED", "PROFESSIONAL_INACTIVE"])("revalidates diagnostic start at %s boundary", async (condition) => {
    const c = hospitalOperationFixture(); const resource = await c.resource(condition === "PROFESSIONAL_INACTIVE" ? { kind: "PROFESSIONAL", userId: "user-us" } : {}); const item = await c.ultrasound("request");
    const result = await c.service.scheduleProcedure(c.user("user-us"), item.id, { ...BOOKING_WINDOW, resourceIds: [resource.id], expectedVersion: 1, idempotencyKey: "schedule" });
    if (condition === "BEFORE") vi.setSystemTime("2026-10-11T09:59:59Z"); if (condition === "AT_END") vi.setSystemTime(BOOKING_WINDOW.endsAt);
    if (condition === "INACTIVE") await c.service.updateHospitalResource(c.user("user-admin"), resource.id, { active: false, expectedVersion: 1, idempotencyKey: "off" });
    if (condition === "CANCELLED") await c.store.transaction((state) => ({ state: { ...state, schedules: state.schedules.map((schedule) => schedule.id === result.schedule.id ? { ...schedule, status: "CANCELLED" } : schedule) }, result: undefined }));
    if (condition === "PROFESSIONAL_INACTIVE") await c.store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === "user-us" ? { ...user, active: false } : user) }, result: undefined }));
    await expect(c.service.startProcedure(c.user("user-manager"), item.id, { expectedVersion: result.item.version, idempotencyKey: "start" })).rejects.toMatchObject({ status: condition === "INACTIVE" || condition === "PROFESSIONAL_INACTIVE" ? 422 : 409 });
    expect(c.store.getState().items.find((entry) => entry.id === item.id)?.status).toBe("SCHEDULED");
  });
  it("accepts exact start and blocks another execution while the previous resource runs late", async () => {
    const c = hospitalOperationFixture(); const resource = await c.resource(); const item = await c.ultrasound("request"); const scheduled = await c.service.scheduleProcedure(c.user("user-us"), item.id, { ...BOOKING_WINDOW, resourceIds: [resource.id], expectedVersion: 1, idempotencyKey: "schedule" });
    await expect(c.service.startProcedure(c.user("user-us"), item.id, { expectedVersion: scheduled.item.version, idempotencyKey: "start" })).resolves.toMatchObject({ item: { status: "IN_PROGRESS" } });
    vi.setSystemTime("2026-10-11T11:15:00Z"); const task = await c.task("other");
    await expect(c.service.reserveHospitalTaskSchedule(c.user("user-us"), task.task.id, { startsAt: "2026-10-11T11:00:00Z", endsAt: "2026-10-11T12:00:00Z", resourceIds: [resource.id], expectedVersion: 1, idempotencyKey: "overrun" })).rejects.toMatchObject({ code: "RESOURCE_EXECUTION_IN_PROGRESS" });
  });
  it("blocks new reservations when calendar is disabled while allowing existing reschedule and cancellation", async () => {
    const c = hospitalOperationFixture(); const resource = await c.resource(); const first = await c.task("existing"); const second = await c.task("new");
    const booking = await c.service.reserveHospitalTaskSchedule(c.user("user-us"), first.task.id, { ...BOOKING_WINDOW, resourceIds: [resource.id], expectedVersion: 1, idempotencyKey: "book" });
    await c.store.transaction((state) => ({ state: { ...state, hospitalInstitutionSettings: [{ id: "hospital-institution", name: "Synthetic", timezone: "America/Sao_Paulo", departmentCapabilities: [{ departmentCode: "ULTRASOUND", archived: false, disabledNewWork: ["CALENDAR"] }], version: 1, updatedAt: OPERATION_NOW, updatedBy: "user-admin" }] }, result: undefined }));
    await expect(c.service.reserveHospitalTaskSchedule(c.user("user-us"), second.task.id, { startsAt: "2026-10-11T12:00:00Z", endsAt: "2026-10-11T13:00:00Z", resourceIds: [resource.id], expectedVersion: 1, idempotencyKey: "disabled" })).rejects.toMatchObject({ code: "DEPARTMENT_WORK_DISABLED" });
    const revised = await c.service.rescheduleHospitalTaskSchedule(c.user("user-us"), booking.id, { startsAt: "2026-10-11T11:00:00Z", endsAt: "2026-10-11T12:00:00Z", resourceIds: [resource.id], expectedVersion: 1, reason: "Ajuste de pendência", idempotencyKey: "reschedule-existing" });
    expect((await c.service.cancelHospitalTaskSchedule(c.user("user-us"), revised.schedule.id, { expectedVersion: 1, reason: "Cancelamento explícito", idempotencyKey: "cancel-existing" })).status).toBe("CANCELLED");
  });
  it.each(["DRAFT", "ARCHIVED"])("does not reserve unpublished activity %s", async (kind) => {
    const c = hospitalOperationFixture(); const resource = await c.resource(); const created = await c.task("unpublished");
    await c.store.transaction(state => ({ state: { ...state, hospitalTasks: state.hospitalTasks.map(task => task.id === created.task.id ? { ...task, ...(kind === "DRAFT" ? { isDraft: true } : { archivedAt: OPERATION_NOW, archivedBy: "user-us" }) } : task) }, result: undefined }));
    const before = c.store.getState(); await expect(c.service.reserveHospitalTaskSchedule(c.user("user-us"), created.task.id, { ...BOOKING_WINDOW, resourceIds: [resource.id], expectedVersion: 1, idempotencyKey: "blocked" })).rejects.toMatchObject({ status: kind === "DRAFT" ? 404 : 409 }); expect(c.store.getState()).toEqual(before);
  });

  it("paginates current inventory without losing records and binds the continuation to its filters", async () => {
    const c = hospitalOperationFixture(); const a = await c.resource({ code: "A_ROOM", kind: "ROOM", name: "Sala sintética A" }); const b = await c.resource({ code: "B_ROOM", kind: "ROOM", name: "Sala sintética B" }); const inactive = await c.resource({ code: "C_ROOM", kind: "ROOM", active: false });
    const filters = { departmentCode: "ULTRASOUND", kind: "ROOM" as const, query: "sintética", limit: 1 };
    const first = await c.service.listHospitalResources(c.user("user-admin"), filters); const second = await c.service.listHospitalResources(c.user("user-admin"), { ...filters, cursor: first.nextCursor });
    expect(first).toMatchObject({ total: 2, items: [{ id: a.id }] }); expect(first.nextCursor).toBeTruthy(); expect(second).toMatchObject({ total: 2, items: [{ id: b.id }] }); expect(second.nextCursor).toBeUndefined();
    await expect(c.service.listHospitalResources(c.user("user-admin"), { ...filters, query: "different", cursor: first.nextCursor })).rejects.toMatchObject({ status: 400 });
    expect((await c.service.listHospitalResources(c.user("user-admin"), { departmentCode: "ULTRASOUND", includeInactive: true })).items.map(resource => resource.id)).toEqual([a.id, b.id, inactive.id]);
    await expect(c.service.getHospitalResource(c.user("user-admin"), "missing-resource")).rejects.toMatchObject({ status: 404 });
    await expect(c.service.updateHospitalResource(c.user("user-admin"), "missing-resource", { name: "Sem alvo", expectedVersion: 1, idempotencyKey: "missing-resource" })).rejects.toMatchObject({ status: 404 });
  });

  it("keeps catalog restrictions and idempotent reservation history through reschedule and cancellation", async () => {
    const c = hospitalOperationFixture(); const allowed = await c.resource(); const other = await c.resource();
    const service = await c.service.createHospitalService(c.user("user-admin"), { code: "SYNTHETIC_RESOURCE_BINDING", name: "Operação com equipamento registrado", kind: "OPERATIONAL", departmentCode: "ULTRASOUND", teamUserIds: ["user-us"], resourceIds: [allowed.id], idempotencyKey: "service-binding" });
    const created = await c.service.createHospitalTask(c.user("user-us"), { title: "Operação vinculada", typeId: "hospital-task-type-routine", departmentCode: "ULTRASOUND", responsibleUserId: "user-us", priority: "ROUTINE", serviceId: service.id, idempotencyKey: "bound-task" });
    const reserve = { ...BOOKING_WINDOW, resourceIds: [allowed.id], expectedVersion: 1, idempotencyKey: "bound-reserve" };
    const before = c.store.getState(); await expect(c.service.reserveHospitalTaskSchedule(c.user("user-us"), created.task.id, { ...reserve, resourceIds: [other.id], idempotencyKey: "unlisted-resource" })).rejects.toMatchObject({ status: 400 }); expect(c.store.getState()).toEqual(before);
    const schedule = await c.service.reserveHospitalTaskSchedule(c.user("user-us"), created.task.id, reserve); const afterReserve = c.store.getState();
    expect(await c.service.reserveHospitalTaskSchedule(c.user("user-us"), created.task.id, reserve)).toEqual(schedule); expect(c.store.getState()).toEqual(afterReserve);
    const move = { startsAt: BOOKING_WINDOW.endsAt, endsAt: "2026-10-11T12:00:00Z", resourceIds: [allowed.id], reason: "Ajuste sintético explícito", expectedVersion: 1, idempotencyKey: "bound-move" };
    await expect(c.service.rescheduleHospitalTaskSchedule(c.user("user-us"), schedule.id, { ...move, resourceIds: [other.id], idempotencyKey: "move-unlisted" })).rejects.toMatchObject({ status: 400 }); expect(c.store.getState()).toEqual(afterReserve);
    const moved = await c.service.rescheduleHospitalTaskSchedule(c.user("user-us"), schedule.id, move); const afterMove = c.store.getState(); expect(await c.service.rescheduleHospitalTaskSchedule(c.user("user-us"), schedule.id, move)).toEqual(moved); expect(c.store.getState()).toEqual(afterMove);
    const cancel = { reason: "Cancelamento sintético explícito", expectedVersion: 1, idempotencyKey: "bound-cancel" }; const cancelled = await c.service.cancelHospitalTaskSchedule(c.user("user-us"), moved.schedule.id, cancel); const afterCancel = c.store.getState();
    expect(await c.service.cancelHospitalTaskSchedule(c.user("user-us"), moved.schedule.id, cancel)).toEqual(cancelled); expect(c.store.getState()).toEqual(afterCancel); expect(cancelled.status).toBe("CANCELLED");
    await expect(c.service.cancelHospitalTaskSchedule(c.user("user-us"), moved.schedule.id, { ...cancel, expectedVersion: 2, idempotencyKey: "cancel-twice" })).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    await expect(c.service.rescheduleHospitalTaskSchedule(c.user("user-us"), schedule.id, { ...move, expectedVersion: 2, idempotencyKey: "move-cancelled" })).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    await expect(c.service.rescheduleHospitalTaskSchedule(c.user("user-us"), "missing-reservation", move)).rejects.toMatchObject({ status: 404 }); await expect(c.service.cancelHospitalTaskSchedule(c.user("user-us"), "missing-reservation", cancel)).rejects.toMatchObject({ status: 404 });
    await expect(c.service.reserveHospitalTaskSchedule(c.user("user-us"), "missing-task", reserve)).rejects.toMatchObject({ status: 404 }); expect(c.store.getState().hospitalTasks.find(task => task.id === created.task.id)?.phase).toBe("PENDING");
  });

});
