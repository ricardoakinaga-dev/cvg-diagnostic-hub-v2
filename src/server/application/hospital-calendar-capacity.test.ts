import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hospitalOperationFixture, OPERATION_NOW, OPERATION_WINDOW, BOOKING_WINDOW } from "../../test/hospital-operation-fixtures";

describe("calendar meaning and explicit capacity denominators", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(OPERATION_NOW); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
  it("keeps reservation, original deadline and actual execution distinct across cursor pages", async () => {
    const c = hospitalOperationFixture(); const resource = await c.resource(); const item = await c.ultrasound("request"); const scheduled = await c.service.scheduleProcedure(c.user("user-us"), item.id, { ...BOOKING_WINDOW, resourceIds: [resource.id], expectedVersion: 1, idempotencyKey: "reserve" });
    await c.service.startProcedure(c.user("user-us"), item.id, { expectedVersion: scheduled.item.version, idempotencyKey: "start" }); const ids: string[] = []; const kinds: string[] = []; let cursor: string | undefined;
    do { const page = await c.service.listHospitalCalendar(c.user("user-us"), { from: OPERATION_NOW, to: "2026-10-14T10:00:00Z", limit: 1, cursor }); ids.push(...page.items.map((event) => event.id)); kinds.push(...page.items.map((event) => event.kind)); cursor = page.nextCursor; } while (cursor);
    expect(new Set(ids).size).toBe(3); expect(new Set(kinds)).toEqual(new Set(["RESERVATION", "DEADLINE", "EXECUTION"]));
    const resourceOnly = await c.service.listHospitalCalendar(c.user("user-us"), { from: OPERATION_WINDOW.startsAt, to: OPERATION_WINDOW.endsAt, resourceId: resource.id }); expect(resourceOnly.items.map((event) => event.kind)).toEqual(["RESERVATION"]);
    const deadline = (await c.service.listHospitalCalendar(c.user("user-us"), { from: OPERATION_NOW, to: "2026-10-14T10:00:00Z", kinds: ["DEADLINE"] })).items[0]; expect(deadline.dueAt).toBe(item.dueAt);
  });
  it("binds continuation to identity and the normalized range, rejects invalid time bounds", async () => {
    const c = hospitalOperationFixture(); const resource = await c.resource(); const task = await c.task("task"); await c.service.reserveHospitalTaskSchedule(c.user("user-us"), task.task.id, { ...BOOKING_WINDOW, resourceIds: [resource.id], expectedVersion: 1, idempotencyKey: "reserve" });
    await c.store.transaction((state) => ({ state: { ...state, schedules: [...state.schedules, { ...state.schedules[0], id: "another-reservation", startsAt: "2026-10-11T12:00:00.000Z", endsAt: "2026-10-11T13:00:00.000Z" }] }, result: undefined }));
    const first = await c.service.listHospitalCalendar(c.user("user-us"), { from: OPERATION_WINDOW.startsAt, to: OPERATION_WINDOW.endsAt, limit: 1 }); expect(first.nextCursor).toBeTruthy();
    await expect(c.service.listHospitalCalendar(c.user("user-us"), { from: OPERATION_WINDOW.startsAt, to: OPERATION_WINDOW.endsAt, cursor: first.nextCursor, kinds: ["DEADLINE"] })).rejects.toMatchObject({ status: 400 });
    await expect(c.service.listHospitalCalendar(c.user("user-us"), { from: OPERATION_WINDOW.endsAt, to: OPERATION_WINDOW.startsAt })).rejects.toMatchObject({ status: 400 });
    await expect(c.service.getHospitalCapacity(c.user("user-us"), { from: OPERATION_NOW, to: "2027-01-14T10:00:00Z" })).rejects.toMatchObject({ status: 400 });
  });
  it("filters actual clinical access instead of leaking reservations or diagnostic deadlines", async () => {
    const c = hospitalOperationFixture(); const item = await c.ultrasound("request"); const resource = await c.resource(); await c.service.scheduleProcedure(c.user("user-us"), item.id, { ...BOOKING_WINDOW, resourceIds: [resource.id], expectedVersion: 1, idempotencyKey: "reserve" });
    await c.store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === "viewer" ? { ...user, patientIds: ["patient-mel"] } : user) }, result: undefined }));
    expect(await c.service.listHospitalCalendar(c.user("viewer"), { from: OPERATION_NOW, to: "2026-10-14T10:00:00Z" })).toEqual({ items: [], total: 0 });
    await expect(c.service.listHospitalCalendar(c.user("user-admin"), { from: OPERATION_WINDOW.startsAt, to: OPERATION_WINDOW.endsAt })).rejects.toMatchObject({ status: 404 });
    await expect(c.service.getHospitalCapacity(c.user("user-admin"), { from: OPERATION_WINDOW.startsAt, to: OPERATION_WINDOW.endsAt })).rejects.toMatchObject({ status: 404 });
  });
  it("reports registered minutes across two shifts with known reservation and no inferred estimate", async () => {
    const c = hospitalOperationFixture(); const resource = await c.resource({ availabilityWindows: [{ startsAt: "2026-10-11T09:00:00Z", endsAt: "2026-10-11T12:00:00Z" }, { startsAt: "2026-10-11T13:00:00Z", endsAt: "2026-10-11T17:00:00Z" }] }); const task = await c.task("task"); await c.service.reserveHospitalTaskSchedule(c.user("user-us"), task.task.id, { ...BOOKING_WINDOW, resourceIds: [resource.id], expectedVersion: 1, idempotencyKey: "reserve" });
    const capacity = await c.service.getHospitalCapacity(c.user("user-us"), { from: OPERATION_WINDOW.startsAt, to: OPERATION_WINDOW.endsAt }); expect(capacity.resources[0]).toMatchObject({ unit: "MINUTES", nominal: 420, reserved: 60, available: 360, unavailable: 0, availabilityKnown: true }); expect(capacity.authorizedLoad.estimatedMinutes).toBeNull(); expect(capacity.sla).toEqual({ source: "REQUEST_CAPTURE", unit: "ELAPSED_HOURS", calendarPausesDeadline: false });
    await c.service.updateHospitalResource(c.user("user-admin"), resource.id, { availability: "MAINTENANCE", expectedVersion: 1, idempotencyKey: "maintenance" });
    expect((await c.service.getHospitalCapacity(c.user("user-us"), { from: OPERATION_WINDOW.startsAt, to: OPERATION_WINDOW.endsAt })).resources[0]).toMatchObject({ nominal: 420, reserved: 60, unavailable: 420, available: 0, reason: "RESOURCE_UNAVAILABLE" });
  });
  it("does not fabricate calendar capacity or pause an overdue original deadline", async () => {
    const c = hospitalOperationFixture(); await c.resource({ availabilityWindows: [] }); const item = await c.ultrasound("request"); vi.setSystemTime("2026-10-14T10:00:00Z");
    const capacity = await c.service.getHospitalCapacity(c.user("user-us"), { from: OPERATION_WINDOW.startsAt, to: OPERATION_WINDOW.endsAt }); expect(capacity.resources[0]).toMatchObject({ unit: "MINUTES", nominal: null, available: null, availabilityKnown: false, reason: "CALENDAR_NOT_CONFIGURED" }); expect(capacity.authorizedLoad.overdueDiagnosticItems).toBe(1); expect(c.store.getState().items[0].dueAt).toBe(item.dueAt);
  });
  it("normalizes two device offsets to one UTC reservation and rejects the same instant", async () => {
    const c = hospitalOperationFixture(); const resource = await c.resource(); const first = await c.task("first"); const second = await c.task("second");
    const schedule = await c.service.reserveHospitalTaskSchedule(c.user("user-us"), first.task.id, { startsAt: "2026-10-11T07:00:00-03:00", endsAt: "2026-10-11T08:00:00-03:00", resourceIds: [resource.id], expectedVersion: 1, idempotencyKey: "south" }); expect(schedule.startsAt).toBe(OPERATION_NOW);
    await expect(c.service.reserveHospitalTaskSchedule(c.user("user-us"), second.task.id, { startsAt: "2026-10-11T12:00:00+02:00", endsAt: "2026-10-11T13:00:00+02:00", resourceIds: [resource.id], expectedVersion: 1, idempotencyKey: "north" })).rejects.toMatchObject({ code: "SCHEDULE_CONFLICT" });
  });
  it("excludes a private unpublished draft from operational capacity", async () => {
    const c = hospitalOperationFixture(); const draft = await c.service.createHospitalTaskDraft(c.user("user-us"), { title: "Rascunho privado", typeId: "hospital-task-type-routine", departmentCode: "ULTRASOUND", responsibleUserId: "user-us", priority: "ROUTINE", idempotencyKey: "capacity-draft" });
    expect((await c.service.getHospitalTask(c.user("user-us"), draft.task.id)).task.isDraft).toBe(true);
    const capacity = await c.service.getHospitalCapacity(c.user("user-us"), { from: OPERATION_WINDOW.startsAt, to: OPERATION_WINDOW.endsAt, departmentCode: "ULTRASOUND" });
    expect(capacity.authorizedLoad.openHospitalTasks).toBe(0);
    await c.service.commandHospitalTaskDraft(c.user("user-us"), draft.task.id, { command: "PUBLISH", expectedVersion: 1, idempotencyKey: "publish-capacity" });
    expect((await c.service.getHospitalCapacity(c.user("user-us"), { from: OPERATION_WINDOW.startsAt, to: OPERATION_WINDOW.endsAt })).authorizedLoad.openHospitalTasks).toBe(1);
    const discarded = await c.service.createHospitalTaskDraft(c.user("user-us"), { title: "Rascunho descartado", typeId: "hospital-task-type-routine", departmentCode: "ULTRASOUND", priority: "ROUTINE", idempotencyKey: "discard-capacity" });
    await c.service.commandHospitalTaskDraft(c.user("user-us"), discarded.task.id, { command: "DISCARD", expectedVersion: 1, idempotencyKey: "discard-capacity-command" });
    expect((await c.service.getHospitalCapacity(c.user("user-us"), { from: OPERATION_WINDOW.startsAt, to: OPERATION_WINDOW.endsAt })).authorizedLoad.openHospitalTasks).toBe(1);
    await c.service.commandHospitalTask(c.user("user-us"), draft.task.id, { command: "CANCEL", reason: "Encerrar atividade sintética", expectedVersion: 2, idempotencyKey: "cancel-capacity" });
    await c.service.setHospitalTaskArchived(c.user("user-us"), draft.task.id, { archived: true, expectedVersion: 3, idempotencyKey: "archive-capacity" });
    expect((await c.service.getHospitalCapacity(c.user("user-us"), { from: OPERATION_WINDOW.startsAt, to: OPERATION_WINDOW.endsAt })).authorizedLoad.openHospitalTasks).toBe(0);
  });
  it("derives bed capacity from explicit Admission occupancy and current inventory availability", async () => {
    const c = hospitalOperationFixture();
    const input = { kind: "BED" as const, departmentCode: "INPATIENT", ward: "Ala sintética", allowedSpecies: ["Canino"], availabilityWindows: [] };
    const occupied = await c.resource({ ...input, bedLabel: "Leito 1" }); const free = await c.resource({ ...input, bedLabel: "Leito 2" }); const blocked = await c.resource({ ...input, bedLabel: "Leito 3", availability: "BLOCKED" });
    vi.stubEnv("ADMISSION_CONTEXT_POLICY_ENABLED", "true"); vi.stubEnv("ADMISSION_CONTEXT_POLICY_VERSION", "SYNTHETIC_CAPACITY_D01"); vi.stubEnv("ADMISSION_CONTEXT_POLICY_APPROVAL_REF", "test-only-not-hospital-approval"); vi.stubEnv("ADMISSION_CONTEXT_POLICY_APPROVED_AT", "2026-01-01T00:00:00Z"); vi.stubEnv("ADMISSION_CONTEXT_ALLOWED_RESPONSIBLE_ROLES", "VETERINARIAN,INPATIENT_TEAM");
    await c.service.updateAdmissionContext(c.user("user-manager"), "admission-thor", { action: "BED_CHANGE", bedResourceId: occupied.id, effectiveAt: "2026-10-11T09:59:59Z", reason: "Vínculo explícito sintético", expectedVersion: 1, idempotencyKey: "bed-capacity-reconcile" });
    const capacity = await c.service.getHospitalCapacity(c.user("user-vet"), { from: OPERATION_WINDOW.startsAt, to: OPERATION_WINDOW.endsAt, departmentCode: "INPATIENT" });
    expect(capacity.resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ resourceId: occupied.id, unit: "BEDS", nominal: 1, reserved: 1, available: 0, unavailable: 0, availabilityKnown: true }),
      expect.objectContaining({ resourceId: free.id, unit: "BEDS", nominal: 1, reserved: 0, available: 1, unavailable: 0, availabilityKnown: true }),
      expect.objectContaining({ resourceId: blocked.id, unit: "BEDS", available: 0, unavailable: 1, reason: "RESOURCE_UNAVAILABLE" })
    ]));
  });
  it.each(["INACTIVE", "TEMPORARY_PASSWORD", "DEPARTMENT_CHANGED", "TEAM_WITHDRAWN"] as const)("does not count a professional as available after %s", async condition => {
    const c = hospitalOperationFixture(); const resource = await c.resource({ kind: "PROFESSIONAL", userId: "user-us" });
    const filters = { from: "2026-10-11T10:00:00Z", to: "2026-10-11T12:00:00Z", departmentCode: "ULTRASOUND" };
    expect((await c.service.getHospitalCapacity(c.user("user-manager"), filters)).resources[0]).toMatchObject({ resourceId: resource.id, nominal: 120, available: 120 });
    await c.store.transaction(state => ({ state: { ...state, users: state.users.map(user => user.id === "user-us" ? { ...user, ...(condition === "INACTIVE" ? { active: false } : condition === "TEMPORARY_PASSWORD" ? { mustChangePassword: true } : condition === "DEPARTMENT_CHANGED" ? { departmentCode: "LABORATORY" } : {}) } : user), departments: condition === "TEAM_WITHDRAWN" ? state.departments.map(department => department.code === "ULTRASOUND" ? { ...department, memberUserIds: department.memberUserIds.filter(id => id !== "user-us") } : department) : state.departments }, result: undefined }));
    expect((await c.service.getHospitalCapacity(c.user("user-manager"), filters)).resources[0]).toMatchObject({ nominal: 120, available: 0, unavailable: 120, reason: "RESOURCE_UNAVAILABLE" });
  });
  it("clips registered windows to the requested interval and keeps completed activities outside the open load", async () => {
    const c = hospitalOperationFixture(); const resource = await c.resource({ availabilityWindows: [{ startsAt: "2026-10-11T07:00:00Z", endsAt: "2026-10-11T08:00:00Z" }, OPERATION_WINDOW, { startsAt: "2026-10-11T19:00:00Z", endsAt: "2026-10-11T20:00:00Z" }] });
    const task = await c.task("capacity-completed"); await c.service.commandHospitalTask(c.user("user-us"), task.task.id, { command: "START", expectedVersion: 1, idempotencyKey: "capacity-start" }); await c.service.commandHospitalTask(c.user("user-us"), task.task.id, { command: "COMPLETE", expectedVersion: 2, idempotencyKey: "capacity-finish" });
    const capacity = await c.service.getHospitalCapacity(c.user("user-us"), { from: "2026-10-11T10:00:00Z", to: "2026-10-11T12:00:00Z", departmentCode: "ULTRASOUND" }); expect(capacity.resources[0]).toMatchObject({ resourceId: resource.id, nominal: 120 }); expect(capacity.authorizedLoad.openHospitalTasks).toBe(0);
    expect((await c.service.listHospitalCalendar(c.user("user-us"), { from: OPERATION_WINDOW.startsAt, to: OPERATION_WINDOW.endsAt, departmentCode: "ULTRASOUND", kinds: ["EXECUTION"] })).items[0]).toMatchObject({ targetId: task.task.id, endsAt: OPERATION_NOW });
  });
  it("shows a legacy diagnostic reservation and deadline using its existing catalog label without fabricating a snapshot", async () => {
    const c = hospitalOperationFixture(); const resource = await c.resource(); const item = await c.ultrasound("legacy-calendar");
    const scheduled = await c.service.scheduleProcedure(c.user("user-us"), item.id, { ...BOOKING_WINDOW, resourceIds: [resource.id], expectedVersion: item.version, idempotencyKey: "legacy-reservation" });
    await c.store.transaction(state => ({ state: { ...state, items: state.items.map(entry => entry.id === item.id ? { ...entry, definitionSnapshot: undefined } : entry) }, result: undefined }));
    const before = c.store.getState(); const page = await c.service.listHospitalCalendar(c.user("user-us"), { from: OPERATION_NOW, to: "2026-10-14T10:00:00Z" });
    const label = before.services.find(service => service.id === item.serviceId)!.name;
    expect(page.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: `reservation:${scheduled.schedule.id}`, label }), expect.objectContaining({ id: `deadline:${item.id}`, label })]));
    expect(c.store.getState()).toEqual(before); expect(c.store.getState().items.find(entry => entry.id === item.id)?.definitionSnapshot).toBeUndefined();
  });
});
