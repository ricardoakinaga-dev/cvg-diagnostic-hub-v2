import { describe, expect, it } from "vitest";
import type { Sample } from "../domain/models";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { createApplicationService } from "./service";

function setup() {
  const state = createDemoState();
  state.services = state.services.map((entry) => entry.workflowType === "LABORATORY" ? { ...entry, sampleType: "EDTA" } : entry);
  const store = new MemoryStore(state);
  const service = createApplicationService(store);
  const user = (role: string) => state.users.find((entry) => entry.role === role)!;
  let sequence = 0;
  const meta = (expectedVersion?: number) => ({ expectedVersion, idempotencyKey: `integrity-${sequence++}` });
  const vet = user("VETERINARIAN");
  const lab = user("LAB_TECH");
  const create = (serviceIds = ["service-hemogram", "service-crp"]) => service.createRequest(vet, {
    patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: serviceIds.map((serviceId) => ({ serviceId }))
  }, meta());
  const releaseCrp = async (itemId: string, expectedVersion: number) => {
    const started = await service.startProcessing(lab, itemId, meta(expectedVersion));
    const draft = await service.createResultDraft(lab, itemId, { narrative: "Resultado sintético da amostra válida.", content: {}, ...meta(started.item.version) });
    return service.releaseResult(lab, draft.result.id, meta(draft.result.version));
  };
  return { store, service, create, meta, vet, lab, admin: user("ADMIN"), manager: user("MANAGER"), releaseCrp };
}

describe("production audit clinical integrity regressions", () => {
  it("rejects one received examination without rejecting a shared tube or blocking its other result", async () => {
    const c = setup();
    const request = await c.create();
    const received = await c.service.receiveSample(c.lab, [request.items[0].id], c.meta(1));
    await c.service.rejectItem(c.lab, request.items[0].id, { reasonCode: "UNPROCESSABLE", ...c.meta(2) });
    expect(c.store.getState().samples[0]).toEqual(received.sample);
    const released = await c.releaseCrp(request.items[1].id, 2);
    expect(released.version.status).toBe("RELEASED");
    expect(c.store.getState().samples[0].status).toBe("RECEIVED");
    expect(released.request.items[0].status).toBe("REJECTED");
  });

  it("requires recollection rather than a direct item rejection once processing has started", async () => {
    const c = setup();
    const request = await c.create(["service-crp"]);
    await c.service.receiveSample(c.lab, [request.items[0].id], c.meta(1));
    await c.service.startProcessing(c.lab, request.items[0].id, c.meta(2));
    await expect(c.service.rejectItem(c.lab, request.items[0].id, { reasonCode: "UNPROCESSABLE", ...c.meta(3) })).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION", status: 409 });
    expect(c.store.getState().samples[0].status).toBe("RECEIVED");
  });

  it("rejects the last useful examination's tube and preserves tubes supporting completed results", async () => {
    const last = setup();
    const single = await last.create(["service-crp"]);
    await last.service.receiveSample(last.lab, [single.items[0].id], last.meta(1));
    await last.service.rejectItem(last.lab, single.items[0].id, { reasonCode: "UNPROCESSABLE", ...last.meta(2) });
    expect(last.store.getState().samples[0].status).toBe("REJECTED");

    const c = setup();
    const request = await c.create();
    await c.service.receiveSample(c.lab, [request.items[0].id], c.meta(1));
    const released = await c.releaseCrp(request.items[1].id, 2);
    await c.service.viewResult(c.vet, released.version.id, c.meta(released.item.version));
    const reviewed = await c.service.reviewResult(c.vet, released.result.id, { versionId: released.version.id, ...c.meta(released.item.version) });
    await c.service.completeItem(c.manager, reviewed.item.id, c.meta(reviewed.item.version));
    await c.service.rejectItem(c.lab, request.items[0].id, { reasonCode: "UNPROCESSABLE", ...c.meta(2) });
    expect(c.store.getState().samples[0].status).toBe("RECEIVED");
    expect((await c.service.getResult(c.vet, released.result.id)).item.status).toBe("COMPLETED");
  });

  for (const status of ["EXPECTED", "REJECTED", "REPLACED"] as const) {
    for (const command of ["start", "draft", "release"] as const) {
      it(`blocks ${command} on a ${status} tube atomically`, async () => {
        const c = setup();
        const request = await c.create(["service-crp"]);
        const received = await c.service.receiveSample(c.lab, [request.items[0].id], c.meta(1));
        const started = command === "start" ? undefined : await c.service.startProcessing(c.lab, request.items[0].id, c.meta(2));
        const draft = command === "release" ? await c.service.createResultDraft(c.lab, request.items[0].id, { narrative: "Resultado sintético.", content: {}, ...c.meta(started!.item.version) }) : undefined;
        await c.store.transaction((state) => ({ state: { ...state, samples: state.samples.map((sample) => sample.id === received.sample.id ? { ...sample, status } : sample) }, result: undefined }));
        const before = c.store.getState();
        const result = command === "start"
          ? c.service.startProcessing(c.lab, request.items[0].id, c.meta(2))
          : command === "draft"
            ? c.service.createResultDraft(c.lab, request.items[0].id, { narrative: "Resultado sintético.", content: {}, ...c.meta(started!.item.version) })
            : c.service.releaseResult(c.lab, draft!.result.id, c.meta(draft!.result.version));
        await expect(result).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION", status: 409 });
        expect(c.store.getState()).toEqual(before);
      });
    }
  }

  it.each(["missing", "foreign-request", "not-linked"])("blocks processing with a %s sample link", async (defect) => {
    const c = setup();
    const request = await c.create(["service-crp"]);
    await c.service.receiveSample(c.lab, [request.items[0].id], c.meta(1));
    await c.store.transaction((state) => ({ state: {
      ...state,
      samples: defect === "missing" ? [] : state.samples.map((sample) => ({ ...sample, ...(defect === "foreign-request" ? { requestId: "foreign-request" } : { itemIds: [] }) }))
    }, result: undefined }));
    await expect(c.service.startProcessing(c.lab, request.items[0].id, c.meta(2))).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION", status: 409 });
  });

  it("recollects and receives a shared tube whose examinations have independent versions, with safe replay and stale guards", async () => {
    const c = setup();
    const request = await c.create();
    const received = await c.service.receiveSample(c.lab, [request.items[0].id], c.meta(1));
    const started = await c.service.startProcessing(c.lab, request.items[0].id, c.meta(2));
    const input = { reasonCode: "HEMOLYZED", expectedSampleVersion: received.sample.version, ...c.meta(started.item.version) };
    const before = c.store.getState();
    await expect(c.service.requestRecollectionForItem(c.lab, request.items[0].id, { ...input, expectedVersion: 2, idempotencyKey: "stale-item" })).rejects.toMatchObject({ code: "STALE_VERSION" });
    await expect(c.service.requestRecollectionForItem(c.lab, request.items[0].id, { ...input, expectedSampleVersion: 1, idempotencyKey: "stale-tube" })).rejects.toMatchObject({ code: "STALE_VERSION" });
    expect(c.store.getState()).toEqual(before);

    const recollection = await c.service.requestRecollectionForItem(c.lab, request.items[0].id, input);
    expect(recollection.items.map((item) => item.version)).toEqual([4, 3]);
    expect((await c.service.requestRecollectionForItem(c.lab, request.items[0].id, input)).replacement.id).toBe(recollection.replacement.id);
    const receive = { ...c.meta(recollection.items[0].version), expectedSampleVersion: recollection.replacement.version };
    await expect(c.service.receiveReplacement(c.lab, recollection.replacement.id, { ...receive, expectedSampleVersion: 99, idempotencyKey: "stale-replacement" })).rejects.toMatchObject({ code: "STALE_VERSION" });
    const replacement = await c.service.receiveReplacement(c.lab, recollection.replacement.id, receive);
    expect(replacement.items.map((item) => item.version)).toEqual([5, 4]);
    expect((await c.service.receiveReplacement(c.lab, recollection.replacement.id, receive)).sample.id).toBe(replacement.sample.id);
    const released = await c.releaseCrp(request.items[1].id, 4);
    expect(released.version.status).toBe("RELEASED");
  });

  it("keeps a cancelled examination unchanged when a pending shared replacement arrives", async () => {
    const c = setup();
    const request = await c.create();
    const received = await c.service.receiveSample(c.lab, [request.items[0].id], c.meta(1));
    const recollection = await c.service.requestRecollectionForItem(c.lab, request.items[0].id, { reasonCode: "HEMOLYZED", expectedSampleVersion: received.sample.version, ...c.meta(2) });
    const cancelled = await c.service.cancelItem(c.vet, request.items[1].id, { reasonCode: "CLINICAL_DECISION", ...c.meta(3) });
    const replacement = await c.service.receiveReplacement(c.lab, recollection.replacement.id, { expectedSampleVersion: recollection.replacement.version, ...c.meta(3) });
    expect(replacement.items.map((item) => item.id)).toEqual([request.items[0].id]);
    expect(c.store.getState().items.find((item) => item.id === cancelled.item.id)).toEqual(cancelled.item);
  });

  it.each(["RECEIVED", "IN_PROGRESS"] as const)("recovers a legacy %s examination on a rejected shared tube while preserving completed results", async (status) => {
    const c = setup();
    const request = await c.create();
    const received = await c.service.receiveSample(c.lab, [request.items[0].id], c.meta(1));
    const eligible = status === "IN_PROGRESS" ? (await c.service.startProcessing(c.lab, request.items[0].id, c.meta(2))).item : received.items[0];
    const released = await c.releaseCrp(request.items[1].id, 2);
    await c.service.viewResult(c.vet, released.version.id, c.meta(released.item.version));
    const reviewed = await c.service.reviewResult(c.vet, released.result.id, { versionId: released.version.id, ...c.meta(released.item.version) });
    await c.service.completeItem(c.manager, reviewed.item.id, c.meta(reviewed.item.version));
    await c.store.transaction((state) => ({ state: { ...state, samples: state.samples.map((sample) => ({ ...sample, status: "REJECTED" as const, rejectionCode: "UNPROCESSABLE", version: sample.version + 1 })) }, result: undefined }));
    const before = c.store.getState();
    const tube = before.samples[0];
    const input = { reasonCode: "HEMOLYZED", expectedSampleVersion: tube.version, ...c.meta(eligible.version) };
    await expect(c.service.requestRecollectionForItem(c.lab, eligible.id, { ...input, expectedVersion: 99, idempotencyKey: "legacy-stale-item" })).rejects.toMatchObject({ code: "STALE_VERSION" });
    await expect(c.service.requestRecollectionForItem(c.lab, eligible.id, { ...input, expectedSampleVersion: received.sample.version, idempotencyKey: "legacy-stale-tube" })).rejects.toMatchObject({ code: "STALE_VERSION" });
    await expect(c.service.requestRecollectionForItem(c.lab, eligible.id, { ...input, reasonCode: "MISSING", idempotencyKey: "legacy-invalid-reason" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(c.service.requestRecollectionForItem(c.vet, eligible.id, { ...input, idempotencyKey: "legacy-forbidden" })).rejects.toMatchObject({ status: 404 });
    expect(c.store.getState()).toEqual(before);
    const recovery = await c.service.requestRecollectionForItem(c.lab, eligible.id, input);
    expect(recovery.sample).toMatchObject({ id: tube.id, status: "REPLACED", version: tube.version + 1 });
    expect(recovery.replacement).toMatchObject({ status: "EXPECTED", replacesSampleId: tube.id, itemIds: [eligible.id] });
    expect(c.store.getState().results).toEqual(before.results);
    expect(c.store.getState().resultVersions).toEqual(before.resultVersions);
    expect(c.store.getState().items.find((item) => item.id === released.item.id)).toEqual(before.items.find((item) => item.id === released.item.id));
    expect(c.store.getState().auditEvents).toContainEqual(expect.objectContaining({ eventType: "SampleRejected", entityId: tube.id, previousState: "REJECTED", newState: "REPLACED", metadata: { reasonCode: "HEMOLYZED" } }));
    expect((await c.service.requestRecollectionForItem(c.lab, eligible.id, input)).replacement.id).toBe(recovery.replacement.id);
    const fresh = await c.service.receiveReplacement(c.lab, recovery.replacement.id, { expectedSampleVersion: recovery.replacement.version, ...c.meta(recovery.items[0].version) });
    expect(fresh.items[0]).toMatchObject({ id: eligible.id, status: "RECEIVED", currentSampleId: recovery.replacement.id });
    expect(c.store.getState().resultVersions).toEqual(before.resultVersions);
    expect(c.store.getState().samples.find((sample) => sample.id === tube.id)?.status).toBe("REPLACED");
  });

  it("keeps a legacy draft and cancelled tube-mate unchanged during rejected-tube recovery", async () => {
    const c = setup();
    const request = await c.create();
    await c.service.receiveSample(c.lab, [request.items[0].id], c.meta(1));
    const started = await c.service.startProcessing(c.lab, request.items[1].id, c.meta(2));
    await c.service.createResultDraft(c.lab, started.item.id, { narrative: "Rascunho sintético anterior à recoleta.", content: {}, ...c.meta(started.item.version) });
    await c.service.cancelItem(c.manager, request.items[0].id, { reasonCode: "CLINICAL_DECISION", ...c.meta(2) });
    await c.store.transaction((state) => ({ state: { ...state, samples: state.samples.map((sample) => ({ ...sample, status: "REJECTED" as const, version: sample.version + 1 })) }, result: undefined }));
    const before = c.store.getState();
    const eligible = before.items.find((item) => item.id === started.item.id)!;
    const recovery = await c.service.requestRecollectionForItem(c.lab, eligible.id, { reasonCode: "HEMOLYZED", expectedSampleVersion: before.samples[0].version, ...c.meta(eligible.version) });
    expect(recovery.replacement.itemIds).toEqual([eligible.id]);
    expect(c.store.getState().items.find((item) => item.id === request.items[0].id)).toEqual(before.items.find((item) => item.id === request.items[0].id));
    expect(c.store.getState().results).toEqual(before.results);
    expect(c.store.getState().resultVersions).toEqual(before.resultVersions);
    await expect(c.service.releaseResult(c.lab, before.results[0].id, c.meta(before.results[0].version))).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
  });

  it("receives a still-requested tube-mate into new material after the old tube is replaced", async () => {
    const c = setup();
    const request = await c.create();
    await c.store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === c.lab.id ? { ...user, serviceCodes: ["HEMOGRAM"] } : user) }, result: undefined }));
    const restrictedLab = c.store.getState().users.find((user) => user.id === c.lab.id)!;
    const received = await c.service.receiveSample(restrictedLab, [request.items[0].id], c.meta(1));
    expect(c.store.getState().items.find((item) => item.id === request.items[1].id)?.status).toBe("REQUESTED");
    await c.store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === c.lab.id ? { ...user, serviceCodes: c.lab.serviceCodes } : user) }, result: undefined }));
    const recollection = await c.service.requestRecollectionForItem(c.lab, request.items[0].id, { reasonCode: "HEMOLYZED", expectedSampleVersion: received.sample.version, ...c.meta(2) });
    const fresh = await c.service.receiveSample(c.lab, [request.items[1].id], { sampleType: "EDTA", ...c.meta(1) });
    expect(fresh.sample.id).not.toBe(received.sample.id);
    expect(fresh.sample.id).not.toBe(recollection.replacement.id);
    expect(fresh.items[0]).toMatchObject({ status: "RECEIVED", currentSampleId: fresh.sample.id });
    expect(c.store.getState().samples.find((sample) => sample.id === received.sample.id)?.status).toBe("REPLACED");
    expect((await c.releaseCrp(request.items[1].id, 2)).version.status).toBe("RELEASED");
  });

  it("recovers a failed examination with new material instead of processing its replaced tube", async () => {
    const c = setup();
    const request = await c.create();
    const received = await c.service.receiveSample(c.lab, [request.items[0].id], c.meta(1));
    const started = await c.service.startProcessing(c.lab, request.items[1].id, c.meta(2));
    const failed = await c.service.updateItemState(c.lab, request.items[1].id, "FAILED", c.meta(started.item.version), "sample.process");
    await c.service.requestRecollectionForItem(c.lab, request.items[0].id, { reasonCode: "HEMOLYZED", expectedSampleVersion: received.sample.version, ...c.meta(2) });
    await expect(c.service.receiveSample(c.lab, [failed.item.id], { accessionCode: received.sample.accessionCode, sampleType: "EDTA", ...c.meta(failed.item.version) })).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
    const fresh = await c.service.receiveSample(c.lab, [failed.item.id], { sampleType: "EDTA", ...c.meta(failed.item.version) });
    expect(fresh.sample.id).not.toBe(received.sample.id);
    expect(fresh.items[0]).toMatchObject({ status: "RECEIVED", currentSampleId: fresh.sample.id });
    expect(c.store.getState().samples.find((sample) => sample.id === received.sample.id)?.status).toBe("REPLACED");
    expect(c.store.getState().auditEvents).toContainEqual(expect.objectContaining({ eventType: "SampleReceived", entityId: failed.item.id, previousState: "FAILED", newState: "RECEIVED" }));
    expect((await c.releaseCrp(failed.item.id, fresh.items[0].version)).version.status).toBe("RELEASED");
  });

  it("recollects only unfinished examinations and permits an explicit correction of a released historical result", async () => {
    const c = setup();
    const request = await c.create();
    const received = await c.service.receiveSample(c.lab, [request.items[0].id], c.meta(1));
    const released = await c.releaseCrp(request.items[1].id, 2);
    const recollection = await c.service.requestRecollectionForItem(c.lab, request.items[0].id, { reasonCode: "HEMOLYZED", expectedSampleVersion: received.sample.version, ...c.meta(2) });
    expect(recollection.replacement.itemIds).toEqual([request.items[0].id]);
    expect(c.store.getState().items.find((item) => item.id === released.item.id)).toEqual(released.item);
    const amended = await c.service.amendResult(c.lab, released.result.id, { reason: "Correção de digitação", narrative: "Narrativa corrigida sem nova análise.", content: {}, ...c.meta(released.result.version) });
    const corrected = await c.service.releaseResult(c.lab, released.result.id, c.meta(amended.result.version));
    expect(corrected.version.status).toBe("RELEASED");
    expect(corrected.item.currentSampleId).toBe(received.sample.id);
  });

  it.each(["REPLACED", "REJECTED"] as const)("does not rewrite a historical %s tube when an examination is rejected", async (status: Sample["status"]) => {
    const c = setup();
    const request = await c.create(["service-crp"]);
    await c.service.receiveSample(c.lab, [request.items[0].id], c.meta(1));
    await c.store.transaction((state) => ({ state: { ...state, samples: state.samples.map((sample) => ({ ...sample, status })) }, result: undefined }));
    const before = c.store.getState().samples[0];
    await c.service.rejectItem(c.lab, request.items[0].id, { reasonCode: "UNPROCESSABLE", ...c.meta(2) });
    expect(c.store.getState().samples[0]).toEqual(before);
  });

  it("keeps historical projections, authorized workflow and request replay after catalog deactivation while blocking new requests", async () => {
    const c = setup();
    const input = { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE" as const, items: [{ serviceId: "service-crp" }] };
    const command = c.meta();
    const request = await c.service.createRequest(c.vet, input, command);
    const catalog = c.store.getState().services.find((entry) => entry.id === "service-crp")!;
    await c.service.updateDiagnosticService(c.admin, catalog.id, { active: false, ...c.meta(catalog.version) });
    expect((await c.service.createRequest(c.vet, input, command)).id).toBe(request.id);
    await expect(c.service.createRequest(c.vet, { ...input, patientId: "patient-mel", encounterId: "encounter-mel" }, c.meta())).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect((await c.service.listServices(c.vet)).some((entry) => entry.id === catalog.id)).toBe(false);

    await c.service.receiveSample(c.lab, [request.items[0].id], c.meta(1));
    const released = await c.releaseCrp(request.items[0].id, 2);
    expect((await c.service.getResult(c.vet, released.result.id)).service.active).toBe(false);
    expect((await c.service.getRequest(c.vet, request.id)).items[0].status).toBe("RESULT_AVAILABLE");
    expect((await c.service.listRequests(c.vet)).items).toHaveLength(1);
    expect((await c.service.getPatientDiagnostics(c.vet, "patient-thor")).items).toHaveLength(1);
    await expect(c.service.dashboard(c.vet)).resolves.toHaveProperty("updatedAt");
    await expect(c.service.search(c.vet, request.requestCode)).resolves.toHaveProperty("items");
    await expect(c.service.timeline(c.vet, request.id)).resolves.toHaveProperty("items");
    await expect(c.service.getSampleLabel(c.lab, released.item.currentSampleId!)).resolves.toHaveProperty("sample.version", 2);
    await expect(c.service.getRequest({ ...c.vet, patientIds: ["patient-mel"] }, request.id)).rejects.toMatchObject({ status: 404 });
  });
});
