import { describe, expect, it } from "vitest";
import { hospitalDateTimeInput, hospitalDateTimeInputToIso } from "../../src/lib/hospital-time";
import { createApplicationService } from "../../src/server/application/service";
import { createDemoState } from "../../src/server/store/fixtures";
import { withDisposablePostgresDatabase } from "../support/postgres-test-harness";

const DST_WINDOW = { startsAt: "2026-11-01T00:00:00-04:00", endsAt: "2026-11-01T04:00:00-05:00" };
const FIRST_HOUR = { startsAt: "2026-11-01T01:00:00-04:00", endsAt: "2026-11-01T01:30:00-04:00" };
const SECOND_HOUR = { startsAt: "2026-11-01T01:00:00-05:00", endsAt: "2026-11-01T01:30:00-05:00" };

describe("persistent resource boundaries and atomic calendar failures", () => {
  it("keeps two repeated DST civil hours distinct, retains remapping history and rolls back a partially invalid resource selection", async () => {
    await withDisposablePostgresDatabase(async database => {
      const base = createDemoState("synthetic-calendar-dst-boundary");
      const first = await database.createStore(base); const second = await database.createStore();
      try {
        const a = createApplicationService(first); const b = createApplicationService(second);
        const actor = (id: string) => base.users.find(user => user.id === id)!;
        const resources = [];
        for (const kind of ["ROOM", "EQUIPMENT", "PROFESSIONAL"] as const) resources.push(await a.createHospitalResource(actor("user-admin"), { code: `DST_${kind}`, name: `Recurso sintético ${kind}`, kind, departmentCode: "ULTRASOUND", ...(kind === "PROFESSIONAL" ? { userId: "user-us" } : {}), availabilityWindows: [DST_WINDOW], idempotencyKey: `dst-${kind}` }));
        const ids = resources.map(resource => resource.id);
        const task = await a.createHospitalTask(actor("user-us"), { title: "Rotina sintética no DST", typeId: "hospital-task-type-routine", departmentCode: "ULTRASOUND", responsibleUserId: "user-us", priority: "URGENT", plannedStartAt: FIRST_HOUR.startsAt, plannedEndAt: FIRST_HOUR.endsAt, idempotencyKey: "dst-task" });
        const rival = await b.createHospitalTask(actor("user-us"), { title: "Outra rotina sintética", typeId: "hospital-task-type-routine", departmentCode: "ULTRASOUND", priority: "ROUTINE", idempotencyKey: "dst-rival" });
        expect(() => hospitalDateTimeInputToIso("2026-11-01T01:00", "America/New_York")).toThrow("ambíguo");
        expect(() => hospitalDateTimeInputToIso("2026-03-08T02:30", "America/New_York")).toThrow("não existe");
        const booking = await a.reserveHospitalTaskSchedule(actor("user-us"), task.task.id, { ...FIRST_HOUR, resourceIds: ids, expectedVersion: 1, idempotencyKey: "dst-book" });
        expect(booking).toMatchObject({ startsAt: "2026-11-01T05:00:00.000Z", endsAt: "2026-11-01T05:30:00.000Z" });
        await expect(b.reserveHospitalTaskSchedule(actor("user-us"), rival.task.id, { startsAt: "2026-11-01T05:00:00Z", endsAt: "2026-11-01T05:30:00Z", resourceIds: [ids[0]], expectedVersion: 1, idempotencyKey: "dst-equivalent-instant" })).rejects.toMatchObject({ code: "SCHEDULE_CONFLICT", status: 409 });
        await a.updateHospitalResource(actor("user-admin"), resources[1].id, { active: false, expectedVersion: 1, idempotencyKey: "dst-equipment-inactive" });
        const beforeInvalid = await second.readState();
        await expect(b.rescheduleHospitalTaskSchedule(actor("user-us"), booking.id, { ...SECOND_HOUR, resourceIds: ids, reason: "Tentativa sem equipamento ativo", expectedVersion: 1, idempotencyKey: "dst-partial-selection" })).rejects.toMatchObject({ code: "RESOURCE_UNAVAILABLE" });
        expect(await first.readState()).toEqual(beforeInvalid);
        expect((await b.listHospitalCalendar(actor("user-us"), { from: DST_WINDOW.startsAt, to: DST_WINDOW.endsAt, kinds: ["RESERVATION"] })).items).toMatchObject([{ schedule: { id: booking.id, status: "SCHEDULED" } }]);
        await a.updateHospitalResource(actor("user-admin"), resources[1].id, { active: true, expectedVersion: 2, idempotencyKey: "dst-equipment-reactivate" });
        const moved = await b.rescheduleHospitalTaskSchedule(actor("user-us"), booking.id, { ...SECOND_HOUR, resourceIds: ids, reason: "Segundo intervalo com offset explícito", expectedVersion: 1, idempotencyKey: "dst-move" });
        expect(moved).toMatchObject({ previousSchedule: { ...booking, status: "CANCELLED", version: 2 }, schedule: { startsAt: "2026-11-01T06:00:00.000Z", endsAt: "2026-11-01T06:30:00.000Z", status: "SCHEDULED" } });
        expect(hospitalDateTimeInput(booking.startsAt, "America/New_York")).toBe(hospitalDateTimeInput(moved.schedule.startsAt, "America/New_York"));
        expect(Date.parse(moved.schedule.startsAt) - Date.parse(booking.startsAt)).toBe(3_600_000);
        expect((await first.readState()).hospitalTasks.find(entry => entry.id === task.task.id)).toEqual(task.task);
        await expect(a.reserveHospitalTaskSchedule(actor("user-us"), rival.task.id, { ...FIRST_HOUR, resourceIds: ids, expectedVersion: 1, idempotencyKey: "dst-original-window-now-free" })).resolves.toMatchObject({ status: "SCHEDULED" });
        const persisted = await second.readState();
        await database.closeStore(first); await database.closeStore(second);
        const reopened = await database.createStore();
        try {
          const c = createApplicationService(reopened); const history = await c.listHospitalCalendar(actor("user-us"), { from: DST_WINDOW.startsAt, to: DST_WINDOW.endsAt, kinds: ["RESERVATION"], limit: 100 });
          expect(history.items.filter(event => event.targetId === task.task.id).map(event => event.schedule)).toEqual([moved.previousSchedule, moved.schedule]);
          expect((await reopened.readState()).schedules).toEqual(persisted.schedules);
          expect((await reopened.readState()).patientGrants).toEqual(base.patientGrants);
        } finally { await database.closeStore(reopened); }
      } finally { await database.closeStore(first); await database.closeStore(second); }
    });
  });

  it("rolls back an actual database failure after the first reschedule audit and permits an idempotent retry without losing the original slot", async () => {
    await withDisposablePostgresDatabase(async database => {
      const base = createDemoState("synthetic-calendar-partial-db-failure");
      const first = await database.createStore(base); const second = await database.createStore();
      try {
        const a = createApplicationService(first); const b = createApplicationService(second); const actor = (id: string) => base.users.find(user => user.id === id)!;
        const resource = await a.createHospitalResource(actor("user-admin"), { code: "ATOMIC_ROOM", name: "Sala sintética", kind: "ROOM", departmentCode: "ULTRASOUND", availabilityWindows: [DST_WINDOW], idempotencyKey: "atomic-resource" });
        const task = await a.createHospitalTask(actor("user-us"), { title: "Rotina de falha sintética", typeId: "hospital-task-type-routine", departmentCode: "ULTRASOUND", priority: "ROUTINE", idempotencyKey: "atomic-task" });
        const booking = await a.reserveHospitalTaskSchedule(actor("user-us"), task.task.id, { ...FIRST_HOUR, resourceIds: [resource.id], expectedVersion: 1, idempotencyKey: "atomic-book" });
        const before = await second.readState();
        await database.query("CREATE FUNCTION synthetic_calendar_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type = 'HospitalTaskRescheduled' THEN RAISE EXCEPTION 'synthetic-calendar-write-failure' USING ERRCODE = 'P0001'; END IF; RETURN NEW; END $$");
        await database.query("CREATE TRIGGER synthetic_calendar_failure BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION synthetic_calendar_failure()");
        const move = { ...SECOND_HOUR, resourceIds: [resource.id], reason: "Remarcação sintética atômica", expectedVersion: 1, idempotencyKey: "atomic-move" };
        await expect(b.rescheduleHospitalTaskSchedule(actor("user-us"), booking.id, move)).rejects.toMatchObject({ code: "P0001", message: "synthetic-calendar-write-failure" });
        expect(await first.readState()).toEqual(before); expect(await second.readState()).toEqual(before);
        expect((await database.query("SELECT event_type FROM audit_events WHERE event_type IN ('HospitalTaskReservationSuperseded', 'HospitalTaskRescheduled')")).rows).toEqual([]);
        await database.query("DROP TRIGGER synthetic_calendar_failure ON audit_events"); await database.query("DROP FUNCTION synthetic_calendar_failure()");
        const moved = await a.rescheduleHospitalTaskSchedule(actor("user-us"), booking.id, move); const after = await first.readState();
        expect(await b.rescheduleHospitalTaskSchedule(actor("user-us"), booking.id, move)).toEqual(moved); expect(await second.readState()).toEqual(after);
        expect(after.schedules).toMatchObject([{ id: booking.id, status: "CANCELLED", version: 2 }, { id: moved.schedule.id, status: "SCHEDULED", version: 1 }]);
        // PostgreSQL keeps durable audits/outbox outside the aggregate returned by readState.
        expect((await database.query("SELECT event_type FROM audit_events WHERE entity_id = $1 AND event_type IN ('HospitalTaskReservationSuperseded', 'HospitalTaskRescheduled')", [task.task.id])).rows).toHaveLength(2);
        expect((await database.query("SELECT event_type FROM outbox_messages WHERE aggregate_id = $1 AND event_type IN ('HospitalTaskReservationSuperseded', 'HospitalTaskRescheduled')", [task.task.id])).rows).toHaveLength(2);
      } finally { await database.closeStore(first); await database.closeStore(second); }
    });
  });
});
