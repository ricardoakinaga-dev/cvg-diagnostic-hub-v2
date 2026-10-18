import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hospitalOperationFixture, OPERATION_NOW, OPERATION_WINDOW } from "../../test/hospital-operation-fixtures";
import { resourceWindows, validateReservationResources, validateTaskReservationStart } from "./hospital-resource-policy";

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(OPERATION_NOW); }); afterEach(() => vi.useRealTimers());
describe("resource availability and occupied inventory authority", () => {
  it("normalizes nested and adjacent windows without shortening prior availability and rejects backwards intervals", () => {
    expect(resourceWindows([{ startsAt: "2026-10-11T11:00:00Z", endsAt: "2026-10-11T12:00:00Z" }, { startsAt: "2026-10-11T09:00:00Z", endsAt: "2026-10-11T14:00:00Z" }, { startsAt: "2026-10-11T14:00:00Z", endsAt: "2026-10-11T15:00:00Z" }])).toEqual([{ startsAt: "2026-10-11T09:00:00.000Z", endsAt: "2026-10-11T15:00:00.000Z" }]);
    expect(() => resourceWindows([{ startsAt: "2026-10-11T10:00:00Z", endsAt: "2026-10-11T09:00:00Z" }])).toThrow("Intervalo de disponibilidade inválido");
  });

  it("prevents duplicate bed identity and changes to occupied beds until an explicit transfer", async () => {
    const f = hospitalOperationFixture(); const input = { kind: "BED" as const, departmentCode: "INPATIENT", ward: "UTI", bedLabel: "Box A", allowedSpecies: ["Canino"], availabilityWindows: [] };
    const bed = await f.resource(input); await expect(f.resource(input)).rejects.toMatchObject({ code: "CONFLICT" });
    await f.store.transaction((state) => ({ state: { ...state, admissions: state.admissions.map((admission) => ({ ...admission, bedResourceId: bed.id })) }, result: undefined })); const frozen = f.store.getState();
    for (const edit of [{ ward: "Outra ala" }, { bedLabel: "Outro box" }, { allowedSpecies: ["Felino"] }, { departmentCode: "RADIOLOGY" }]) await expect(f.service.updateHospitalResource(f.user("user-admin"), bed.id, { ...edit, expectedVersion: 1, idempotencyKey: JSON.stringify(edit) })).rejects.toMatchObject({ code: "RESOURCE_IN_USE" });
    expect(f.store.getState()).toEqual(frozen);
  });

  it("does not move a reserved resource to another sector or bind a second inventory record to the same professional", async () => {
    const f = hospitalOperationFixture(); const equipment = await f.resource(); const task = await f.task("reserved"); await f.service.reserveHospitalTaskSchedule(f.user("user-us"), task.task.id, { resourceIds: [equipment.id], startsAt: OPERATION_NOW, endsAt: "2026-10-11T11:00:00Z", expectedVersion: 1, idempotencyKey: "reserve" });
    await expect(f.service.updateHospitalResource(f.user("user-admin"), equipment.id, { departmentCode: "RADIOLOGY", expectedVersion: 1, idempotencyKey: "move" })).rejects.toMatchObject({ code: "RESOURCE_IN_USE" });
    await f.resource({ kind: "PROFESSIONAL", userId: "user-us" }); await expect(f.resource({ kind: "PROFESSIONAL", userId: "user-us" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("requires a real registered availability window and the reserved professional for actual start", async () => {
    const f = hospitalOperationFixture(); const professional = await f.resource({ kind: "PROFESSIONAL", userId: "user-us" }); const task = await f.task("professional-reservation");
    const booking = await f.service.reserveHospitalTaskSchedule(f.user("user-us"), task.task.id, { resourceIds: [professional.id], startsAt: OPERATION_NOW, endsAt: "2026-10-11T11:00:00Z", expectedVersion: 1, idempotencyKey: "reserve" });
    expect(() => validateTaskReservationStart(f.store.getState(), task.task, "different-professional", OPERATION_NOW)).toThrow("O executor não é um dos profissionais");
    expect(() => validateTaskReservationStart(f.store.getState(), task.task, "user-us", booking.endsAt)).toThrow("dentro do horário");
    const missingWindow = await f.resource({ availabilityWindows: [] }); const outsideWindow = { startsAt: "2026-10-11T18:00:00Z", endsAt: "2026-10-11T19:00:00Z" };
    expect(() => validateReservationResources(f.store.getState(), task.task, [missingWindow.id], OPERATION_WINDOW, OPERATION_NOW)).toThrow("ainda não foi cadastrada");
    expect(() => validateReservationResources(f.store.getState(), task.task, [professional.id], outsideWindow, OPERATION_NOW)).toThrow("fora da disponibilidade");
    for (const ids of [[], [professional.id, professional.id]]) expect(() => validateReservationResources(f.store.getState(), task.task, ids, OPERATION_WINDOW, OPERATION_NOW)).toThrow("recursos distintos");
  });
});
