import { describe, expect, it } from "vitest";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { createApplicationService } from "./service";

function setup() {
  const state = createDemoState();
  const store = new MemoryStore(state);
  return { store, service: createApplicationService(store), vet: state.users.find((user) => user.id === "user-vet")!, lab: state.users.find((user) => user.id === "user-lab")!, us: state.users.find((user) => user.id === "user-us")!, rx: state.users.find((user) => user.id === "user-rx")!, manager: state.users.find((user) => user.id === "user-manager")! };
}

describe("workflow command isolation and replay", () => {
  it("rejects reused accession numbers for initial and replacement samples without touching other work", async () => {
    const c = setup();
    const request = await c.service.createRequest(c.vet, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-hemogram" }, { serviceId: "service-crp" }] }, { idempotencyKey: "isolation-lab-request" });
    const received = await c.service.receiveSample(c.lab, [request.items[0].id], { accessionCode: "ACC-ISOLATED", sampleType: "EDTA", expectedVersion: 1, idempotencyKey: "isolated-sample" });
    const before = c.store.getState();
    await expect(c.service.receiveSample(c.lab, [request.items[1].id], { accessionCode: "ACC-ISOLATED", sampleType: "EDTA", expectedVersion: 1, idempotencyKey: "duplicate-accession" })).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
    expect(c.store.getState()).toEqual(before);
    const other = await c.service.receiveSample(c.lab, [request.items[1].id], { accessionCode: "ACC-OTHER", sampleType: "EDTA", expectedVersion: 1, idempotencyKey: "other-sample" });
    const recollected = await c.service.requestRecollection(c.lab, received.sample.id, { reasonCode: "HEMOLYZED", expectedVersion: received.items[0].version, idempotencyKey: "recollection-isolated" });
    expect(c.store.getState().samples.find((sample) => sample.id === other.sample.id)).toEqual(other.sample);
    const pending = c.store.getState();
    await expect(c.service.requestRecollection(c.lab, received.sample.id, { reasonCode: "HEMOLYZED", expectedVersion: recollected.items[0].version, idempotencyKey: "recollect-replaced" })).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION", status: 409 });
    await expect(c.service.receiveReplacement(c.lab, recollected.replacement.id, { accessionCode: "ACC-OTHER", sampleType: "EDTA", expectedVersion: recollected.items[0].version, idempotencyKey: "replacement-duplicate" })).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
    expect(c.store.getState()).toEqual(pending);
    await expect(c.service.receiveReplacement(c.lab, recollected.replacement.id, { accessionCode: "ACC-REPLACEMENT", sampleType: "EDTA", expectedVersion: recollected.items[0].version, idempotencyKey: "replacement-unique" })).resolves.toMatchObject({ sample: { status: "RECEIVED", accessionCode: "ACC-REPLACEMENT" } });
  });

  it("rejects an item before sample receipt, replays the decision and refuses a new rejection", async () => {
    const c = setup();
    const request = await c.service.createRequest(c.vet, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-hemogram" }] }, { idempotencyKey: "reject-unsampled-request" });
    const input = { reasonCode: "UNPROCESSABLE", note: "  Material indisponível  ", expectedVersion: 1, idempotencyKey: "reject-unsampled" };
    const rejected = await c.service.rejectItem(c.lab, request.items[0].id, input);
    expect(rejected.item).toMatchObject({ status: "REJECTED", rejectionReason: "Material indisponível", version: 2 });
    expect(c.store.getState().samples).toEqual([]);
    const before = c.store.getState();
    await expect(c.service.rejectItem(c.lab, request.items[0].id, input)).resolves.toEqual(rejected);
    await expect(c.service.rejectItem(c.lab, request.items[0].id, { ...input, expectedVersion: 2, idempotencyKey: "reject-again" })).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION", status: 409 });
    await expect(c.service.completeItem(c.manager, request.items[0].id, { expectedVersion: 2, idempotencyKey: "complete-rejected" })).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION", status: 409 });
    expect(c.store.getState()).toEqual(before);
  });

  it("isolates partial request cancellation from another scheduled procedure", async () => {
    const c = setup();
    const create = (key: string, patientId: string, encounterId: string) => c.service.createRequest(c.vet, { patientId, encounterId, priority: "ROUTINE", items: [{ serviceId: "service-ultrasound" }, { serviceId: "service-hemogram" }] }, { idempotencyKey: key });
    const request = await create("cancel-selected-request", "patient-thor", "encounter-thor");
    const otherRequest = await create("cancel-unrelated-request", "patient-mel", "encounter-mel");
    const window = { startsAt: "2026-10-04T13:00:00.000Z", endsAt: "2026-10-04T13:30:00.000Z", resource: "US-CANCEL" };
    const scheduled = await c.service.scheduleProcedure(c.us, request.items[0].id, { ...window, expectedVersion: 1, idempotencyKey: "cancel-selected-schedule" });
    const other = await c.service.scheduleProcedure(c.us, otherRequest.items[0].id, { ...window, resource: "US-OTHER", expectedVersion: 1, idempotencyKey: "cancel-other-schedule" });
    const input = { itemIds: [scheduled.item.id], reasonCode: "CLINICAL_DECISION", expectedVersion: scheduled.request.version, idempotencyKey: "cancel-selected" };
    const cancelled = await c.service.cancelRequest(c.manager, request.id, input);
    expect(cancelled.items.find((item) => item.id === scheduled.item.id)).toMatchObject({ status: "CANCELLED", cancellationReason: "CLINICAL_DECISION" });
    expect(cancelled.items.find((item) => item.id === request.items[1].id)).toMatchObject({ status: "REQUESTED", version: 1 });
    expect(c.store.getState().schedules.find((schedule) => schedule.id === scheduled.schedule.id)).toMatchObject({ status: "CANCELLED", reason: "CLINICAL_DECISION", version: 2 });
    expect(c.store.getState().schedules.find((schedule) => schedule.id === other.schedule.id)).toEqual(other.schedule);
    const before = c.store.getState();
    await expect(c.service.cancelRequest(c.manager, request.id, input)).resolves.toEqual(cancelled);
    expect(c.store.getState()).toEqual(before);
  });

  it("replays procedure commands and rejects attempts out of phase without changing another reservation", async () => {
    const c = setup();
    const request = await c.service.createRequest(c.vet, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-ultrasound" }, { serviceId: "service-xray" }] }, { idempotencyKey: "phase-procedure-request" });
    const usId = request.items[0].id;
    const rxId = request.items[1].id;
    const before = c.store.getState();
    await expect(c.service.startProcedure(c.us, usId, { expectedVersion: 1, idempotencyKey: "unscheduled-start" })).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION", status: 409 });
    await expect(c.service.markProcedurePerformed(c.rx, rxId, { expectedVersion: 1, idempotencyKey: "unstarted-perform" })).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION", status: 409 });
    expect(c.store.getState()).toEqual(before);
    const window = { startsAt: "2026-10-04T13:00:00.000Z", endsAt: "2026-10-04T13:30:00.000Z", resource: "PHASE-US", expectedVersion: 1, idempotencyKey: "phase-schedule" };
    const scheduled = await c.service.scheduleProcedure(c.us, usId, window);
    await expect(c.service.scheduleProcedure(c.us, usId, window)).resolves.toEqual(scheduled);
    await expect(c.service.scheduleProcedure(c.us, usId, { ...window, expectedVersion: 2, idempotencyKey: "schedule-again" })).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION", status: 409 });
    const other = await c.service.scheduleProcedure(c.rx, rxId, { ...window, resource: "PHASE-RX", idempotencyKey: "phase-rx-schedule" });
    const stable = c.store.getState();
    await expect(c.service.rescheduleProcedure(c.us, scheduled.procedure.id, { ...window, resource: "PHASE-RX", expectedVersion: scheduled.procedure.version, idempotencyKey: "reschedule-conflict" })).rejects.toMatchObject({ code: "SCHEDULE_CONFLICT", status: 409 });
    expect(c.store.getState()).toEqual(stable);
    const rescheduled = await c.service.rescheduleProcedure(c.us, scheduled.procedure.id, { ...window, startsAt: "2026-10-04T14:00:00.000Z", endsAt: "2026-10-04T14:30:00.000Z", expectedVersion: scheduled.procedure.version, idempotencyKey: "phase-reschedule" });
    expect(c.store.getState().schedules.find((schedule) => schedule.id === other.schedule.id)).toEqual(other.schedule);
    expect(c.store.getState().procedures.find((procedure) => procedure.id === other.procedure.id)).toEqual(other.procedure);
    const startInput = { expectedVersion: rescheduled.item.version, idempotencyKey: "phase-start" };
    const started = await c.service.startProcedure(c.us, usId, startInput);
    await expect(c.service.startProcedure(c.us, usId, startInput)).resolves.toEqual(started);
    const performing = c.store.getState();
    await expect(c.service.rescheduleProcedure(c.us, started.procedure.id, { ...window, expectedVersion: started.procedure.version, idempotencyKey: "reschedule-started" })).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION", status: 409 });
    expect(c.store.getState()).toEqual(performing);
    const performInput = { expectedVersion: started.item.version, idempotencyKey: "phase-perform" };
    const performed = await c.service.markProcedurePerformed(c.us, usId, performInput);
    await expect(c.service.markProcedurePerformed(c.us, usId, performInput)).resolves.toEqual(performed);
    const finished = c.store.getState();
    await expect(c.service.markProcedurePerformed(c.us, usId, { expectedVersion: performed.item.version, idempotencyKey: "perform-again" })).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION", status: 409 });
    expect(c.store.getState()).toEqual(finished);
    expect(c.store.getState().schedules.find((schedule) => schedule.id === other.schedule.id)).toEqual(other.schedule);
  });
});
