import { afterEach, describe, expect, it } from "vitest";
import { isGeneratedAccessionFormat, validateAccessionCheckCharacter } from "../domain/accession";
import type { User } from "../domain/models";
import { createDemoState, withoutPreassignedSamples } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { createApplicationService } from "./service";

function setup() {
  const store = new MemoryStore(createDemoState());
  const service = createApplicationService(store);
  const user = (email: string) => store.getState().users.find((entry) => entry.email === email)!;
  const catalog = (patch: Record<string, string | undefined>) => store.transaction((state) => ({ state: { ...state, services: state.services.map((entry) => entry.id in patch ? { ...entry, sampleType: patch[entry.id] } : entry) }, result: undefined }));
  let key = 0;
  const create = (items: string[], patientId = "patient-thor") => service.createRequest(user("vet@cvg.local"), { patientId, encounterId: patientId.replace("patient", "encounter"), priority: "ROUTINE", items: items.map((serviceId) => ({ serviceId })) }, { idempotencyKey: `acc-${key++}` });
  return { store, service, create, catalog, vet: user("vet@cvg.local"), lab: user("lab@cvg.local"), rx: user("rx@cvg.local"), manager: user("manager@cvg.local"), user };
}

afterEach(() => {
  delete process.env.ACCESSION_PREFIX;
  delete process.env.LABEL_WIDTH_MM;
  delete process.env.LABEL_HEIGHT_MM;
});

describe("pre-assigned samples at request creation (D8)", () => {
  it("creates one EXPECTED sample per catalog sample type and one per item without a type", async () => {
    const c = setup();
    await c.catalog({ "service-hemogram": "EDTA", "service-crp": "EDTA" });
    const request = await c.create(["service-hemogram", "service-crp", "service-xray"]);

    expect(request.samples).toHaveLength(1);
    const [sample] = request.samples;
    expect(sample).toMatchObject({ status: "EXPECTED", sampleType: "EDTA", requestId: request.id, itemIds: [request.items[0].id, request.items[1].id] });
    expect(isGeneratedAccessionFormat(sample.accessionCode)).toBe(true);
    expect(validateAccessionCheckCharacter(sample.accessionCode)).toBe(true);
    expect(request.items.map((item) => item.currentSampleId)).toEqual([sample.id, sample.id, undefined]);
    expect(c.store.getState().auditEvents).toContainEqual(expect.objectContaining({ eventType: "SampleExpected", entityType: "Sample", entityId: sample.id, newState: "EXPECTED", actorId: c.vet.id, metadata: { accessionCode: sample.accessionCode, itemIds: sample.itemIds.join(",") } }));
    expect(c.store.getState().outbox.find((message) => message.eventType === "DiagnosticRequestCreated")?.payload).toMatchObject({ samples: [{ id: sample.id, accessionCode: sample.accessionCode, itemIds: sample.itemIds }] });
  });

  it("falls back to 'A definir' and one sample per item when the catalog has no sample type", async () => {
    const c = setup();
    const request = await c.create(["service-hemogram", "service-crp"]);
    expect(request.samples.map((sample) => sample.sampleType)).toEqual(["A definir", "A definir"]);
    expect(new Set(request.samples.map((sample) => sample.accessionCode)).size).toBe(2);
    expect(request.samples.map((sample) => sample.itemIds)).toEqual([[request.items[0].id], [request.items[1].id]]);
  });

  it("creates no sample for imaging-only requests and numbers samples per calendar day", async () => {
    const c = setup();
    const imaging = await c.create(["service-xray"]);
    expect(imaging.samples).toEqual([]);
    expect(c.store.getState().outbox.find((message) => message.eventType === "DiagnosticRequestCreated")?.payload).toEqual({ requestCode: imaging.requestCode });
    const first = await c.create(["service-hemogram"]);
    const second = await c.create(["service-hemogram"], "patient-mel");
    expect(first.samples[0].accessionCode).toMatch(/^A\d{6}-0001\d$/);
    expect(second.samples[0].accessionCode).toMatch(/^A\d{6}-0002\d$/);
  });

  it("uses the configured prefix and exposes only the samples of visible items", async () => {
    const c = setup();
    process.env.ACCESSION_PREFIX = "HV";
    const request = await c.create(["service-hemogram", "service-xray"]);
    expect(request.samples[0].accessionCode).toMatch(/^HV\d{6}-0001\d$/);
    const viewForRadiology = await c.service.getRequest(c.rx, request.id);
    expect(viewForRadiology.samples).toEqual([]);
    const viewForLab = await c.service.getRequest(c.lab, request.id);
    expect(viewForLab.samples).toHaveLength(1);
    expect(viewForLab.samples[0].itemIds).toEqual([request.items[0].id]);
  });
});

describe("receipt by scan", () => {
  it("receives the whole tube without a code and keeps the catalog type", async () => {
    const c = setup();
    await c.catalog({ "service-hemogram": "EDTA", "service-crp": "EDTA" });
    const request = await c.create(["service-hemogram", "service-crp"]);
    const received = await c.service.receiveSample(c.lab, [request.items[0].id], { expectedVersion: 1, idempotencyKey: "scan-1" });
    expect(received.sample).toMatchObject({ id: request.samples[0].id, status: "RECEIVED", sampleType: "EDTA", accessionCode: request.samples[0].accessionCode, receivedBy: c.lab.id, version: 2 });
    expect(received.sample.receivedAt).toBeTruthy();
    expect(received.items.map((item) => item.status)).toEqual(["RECEIVED", "RECEIVED"]);
    expect(received.request.items.map((item) => item.status)).toEqual(["RECEIVED", "RECEIVED"]);
    expect(c.store.getState().samples).toHaveLength(1);
    expect(c.store.getState().auditEvents.filter((event) => event.eventType === "SampleReceived")).toHaveLength(2);
    const replay = await c.service.receiveSample(c.lab, [request.items[0].id], { expectedVersion: 1, idempotencyKey: "scan-1" });
    expect(replay.sample.id).toBe(received.sample.id);
  });

  it("accepts the matching scanned code and lets the operator override the type", async () => {
    const c = setup();
    await c.catalog({ "service-hemogram": "EDTA" });
    const request = await c.create(["service-hemogram"]);
    const received = await c.service.receiveSample(c.lab, [request.items[0].id], { accessionCode: request.samples[0].accessionCode, sampleType: "  Citrato ", expectedVersion: 1 });
    expect(received.sample).toMatchObject({ status: "RECEIVED", sampleType: "Citrato" });
  });

  it("requires the type when the catalog has none", async () => {
    const c = setup();
    const request = await c.create(["service-hemogram"]);
    await expect(c.service.receiveSample(c.lab, [request.items[0].id], { expectedVersion: 1 })).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 });
    await expect(c.service.receiveSample(c.lab, [request.items[0].id], { sampleType: "Soro", expectedVersion: 1 })).resolves.toMatchObject({ sample: { sampleType: "Soro" } });
  });

  it("rejects another sample's code with 409 and a corrupted check character with 400", async () => {
    const c = setup();
    const request = await c.create(["service-hemogram", "service-crp"]);
    const other = request.samples[1].accessionCode;
    const base = { sampleType: "EDTA", expectedVersion: 1 };
    await expect(c.service.receiveSample(c.lab, [request.items[0].id], { ...base, accessionCode: other })).rejects.toMatchObject({ code: "ACCESSION_MISMATCH", status: 409, message: "O código lido não corresponde à amostra esperada deste exame." });
    await expect(c.service.receiveSample(c.lab, [request.items[0].id], { ...base, accessionCode: "ACC-LEGACY-1" })).rejects.toMatchObject({ code: "ACCESSION_MISMATCH", status: 409 });
    const own = request.samples[0].accessionCode;
    const wrongCheck = `${own.slice(0, -1)}${(Number(own.at(-1)) + 1) % 10}`;
    await expect(c.service.receiveSample(c.lab, [request.items[0].id], { ...base, accessionCode: wrongCheck })).rejects.toMatchObject({ code: "ACCESSION_INVALID", status: 400 });
    await expect(c.service.receiveSample(c.lab, [request.items[0].id], { ...base, accessionCode: "bad code" })).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 });
    expect(c.store.getState().samples.every((sample) => sample.status === "EXPECTED")).toBe(true);
  });

  it("refuses to receive items that belong to different tubes with one scan", async () => {
    const c = setup();
    const request = await c.create(["service-hemogram", "service-crp"]);
    await expect(c.service.receiveSample(c.lab, request.items.map((item) => item.id), { sampleType: "EDTA", expectedVersion: 1 })).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION", status: 409 });
  });

  it("receives only the still-requested, authorized items that share the tube", async () => {
    const c = setup();
    await c.catalog({ "service-hemogram": "EDTA", "service-crp": "EDTA" });
    const request = await c.create(["service-hemogram", "service-crp"]);
    await c.store.transaction((state) => ({ state: { ...state, items: state.items.map((item) => item.id === request.items[1].id ? { ...item, status: "CANCELLED" as const } : item) }, result: undefined }));
    const received = await c.service.receiveSample(c.lab, [request.items[0].id], { expectedVersion: 1 });
    expect(received.items.map((item) => item.id)).toEqual([request.items[0].id]);
    expect(c.store.getState().items.find((item) => item.id === request.items[1].id)?.status).toBe("CANCELLED");
  });

  it("skips tube-mates the receiving technician has no permission for", async () => {
    const c = setup();
    await c.catalog({ "service-hemogram": "EDTA", "service-crp": "EDTA" });
    const request = await c.create(["service-hemogram", "service-crp"]);
    await c.store.transaction((state) => ({ state: { ...state, users: state.users.map((user: User) => user.id === c.lab.id ? { ...user, serviceCodes: ["HEMOGRAM"] } : user) }, result: undefined }));
    const lab = c.store.getState().users.find((user) => user.id === c.lab.id)!;
    const received = await c.service.receiveSample(lab, [request.items[0].id], { expectedVersion: 1 });
    expect(received.items.map((item) => item.id)).toEqual([request.items[0].id]);
    expect(c.store.getState().items.find((item) => item.id === request.items[1].id)?.status).toBe("REQUESTED");
  });

  it("receives the rest of an already received tube into the same tube, after checking the scanned code (AUD-03)", async () => {
    const c = setup();
    await c.catalog({ "service-hemogram": "EDTA", "service-crp": "EDTA" });
    await c.store.transaction((state) => ({ state: { ...state, users: [...state.users, { ...c.lab, id: "user-lab-hemo", email: "hemo@cvg.local", serviceCodes: ["HEMOGRAM"], version: 1 }, { ...c.lab, id: "user-lab-crp", email: "crp@cvg.local", serviceCodes: ["CRP"], version: 1 }] }, result: undefined }));
    const hemoTech = c.user("hemo@cvg.local");
    const crpTech = c.user("crp@cvg.local");
    const request = await c.create(["service-hemogram", "service-crp"]);
    const [tube] = request.samples;
    const [hemo, crp] = request.items;
    const first = await c.service.receiveSample(hemoTech, [hemo.id], { accessionCode: tube.accessionCode, expectedVersion: hemo.version, idempotencyKey: "aud03-hemo" });
    expect(first.items.map((item) => item.id)).toEqual([hemo.id]);
    expect(c.store.getState().items.find((item) => item.id === crp.id)).toMatchObject({ status: "REQUESTED", currentSampleId: tube.id });

    // A foreign code is refused and nothing changes: no second tube, CRP still requested.
    await expect(c.service.receiveSample(crpTech, [crp.id], { accessionCode: "WRONG-TUBE-123", sampleType: "EDTA", expectedVersion: crp.version, idempotencyKey: "aud03-wrong" })).rejects.toMatchObject({ code: "ACCESSION_MISMATCH", status: 409 });
    await expect(c.service.receiveSample(crpTech, [crp.id], { accessionCode: "A261008-00019", sampleType: "EDTA", expectedVersion: crp.version, idempotencyKey: "aud03-bad-check" })).rejects.toMatchObject({ code: "ACCESSION_INVALID", status: 400 });
    expect(c.store.getState().samples.filter((sample) => sample.requestId === request.id)).toHaveLength(1);
    expect(c.store.getState().items.find((item) => item.id === crp.id)).toMatchObject({ status: "REQUESTED", currentSampleId: tube.id, version: crp.version });

    // The assigned label is accepted and the item lands in the tube that already holds the hemogram.
    const second = await c.service.receiveSample(crpTech, [crp.id], { accessionCode: tube.accessionCode, sampleType: "EDTA", expectedVersion: crp.version, idempotencyKey: "aud03-crp" });
    expect(second.sample).toMatchObject({ id: tube.id, status: "RECEIVED", receivedBy: hemoTech.id, version: first.sample.version });
    expect(second.items.map((item) => item.id)).toEqual([crp.id]);
    expect(c.store.getState().samples.filter((sample) => sample.requestId === request.id)).toHaveLength(1);
    expect(c.store.getState().items.find((item) => item.id === crp.id)).toMatchObject({ status: "RECEIVED", currentSampleId: tube.id });
    expect(c.store.getState().outbox.filter((message) => message.eventType === "SampleReceived").map((message) => message.payload)).toEqual([
      { accessionCode: tube.accessionCode, itemIds: [hemo.id] },
      { accessionCode: tube.accessionCode, itemIds: [crp.id] }
    ]);
    // Received twice is an idempotent replay, not a transition.
    await expect(c.service.receiveSample(crpTech, [crp.id], { accessionCode: tube.accessionCode, expectedVersion: crp.version + 1, idempotencyKey: "aud03-again" })).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION", status: 409 });
  });

  it("receives the rest of a received tube without a scan and falls back to a new tube when the assigned one was rejected", async () => {
    const c = setup();
    await c.catalog({ "service-hemogram": "EDTA", "service-crp": "EDTA" });
    await c.store.transaction((state) => ({ state: { ...state, users: state.users.map((user: User) => user.id === c.lab.id ? { ...user, serviceCodes: ["HEMOGRAM"] } : user) }, result: undefined }));
    const hemoOnly = c.user("lab@cvg.local");
    const request = await c.create(["service-hemogram", "service-crp"]);
    const [tube] = request.samples;
    const [hemo, crp] = request.items;
    const first = await c.service.receiveSample(hemoOnly, [hemo.id], { expectedVersion: hemo.version });
    const full = { ...hemoOnly, serviceCodes: ["HEMOGRAM", "CRP"] };
    await c.store.transaction((state) => ({ state: { ...state, users: state.users.map((user: User) => user.id === full.id ? full : user) }, result: undefined }));
    const typed = await c.service.receiveSample(full, [crp.id], { expectedVersion: crp.version });
    expect(typed.sample.id).toBe(tube.id);
    expect(typed.items.map((item) => item.id)).toEqual([crp.id]);

    // Rejecting the received hemogram rejects the tube; a still-requested tube-mate then needs a new sample.
    const again = await c.create(["service-hemogram", "service-crp"], "patient-mel");
    const [tube2] = again.samples;
    const [hemo2, crp2] = again.items;
    await c.service.receiveSample(hemoOnly, [hemo2.id], { expectedVersion: hemo2.version });
    const received = c.store.getState().items.find((item) => item.id === hemo2.id)!;
    await c.service.rejectItem(full, hemo2.id, { reasonCode: "UNPROCESSABLE", expectedVersion: received.version, idempotencyKey: "aud03-reject" });
    expect(c.store.getState().samples.find((sample) => sample.id === tube2.id)?.status).toBe("REJECTED");
    const fresh = await c.service.receiveSample(full, [crp2.id], { sampleType: "EDTA", expectedVersion: crp2.version });
    expect(fresh.sample.id).not.toBe(tube2.id);
    expect(fresh.sample).toMatchObject({ status: "RECEIVED", itemIds: [crp2.id] });
    void first;
  });

  it("keeps the legacy path for requests created before the feature", async () => {
    const c = setup();
    const request = await c.create(["service-hemogram", "service-crp"]);
    await c.store.transaction((state) => ({ state: withoutPreassignedSamples(state, request.id), result: undefined }));
    const generated = await c.service.receiveSample(c.lab, [request.items[0].id], { sampleType: "EDTA", expectedVersion: 1 });
    expect(generated.sample.accessionCode).toMatch(/^A\d{6}-0001\d$/);
    const typed = await c.service.receiveSample(c.lab, [request.items[1].id], { accessionCode: "ACC-LEGACY-1", sampleType: "EDTA", expectedVersion: 1 });
    expect(typed.sample.accessionCode).toBe("ACC-LEGACY-1");
    const again = await c.create(["service-hemogram"], "patient-mel");
    await c.store.transaction((state) => ({ state: withoutPreassignedSamples(state, again.id), result: undefined }));
    await expect(c.service.receiveSample(c.lab, [again.items[0].id], { accessionCode: "ACC-LEGACY-1", sampleType: "EDTA", expectedVersion: 1 })).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
    await expect(c.service.receiveSample(c.lab, [again.items[0].id], { accessionCode: "A261008-00019", sampleType: "EDTA", expectedVersion: 1 })).rejects.toMatchObject({ code: "ACCESSION_INVALID", status: 400 });
    const blank = await c.service.receiveSample(c.lab, [again.items[0].id], { accessionCode: "  ", sampleType: "EDTA", expectedVersion: 1 });
    expect(validateAccessionCheckCharacter(blank.sample.accessionCode)).toBe(true);
  });
});

describe("recollection with generated accession", () => {
  it("gives the replacement a real code that can be printed and scanned", async () => {
    const c = setup();
    await c.catalog({ "service-hemogram": "EDTA" });
    const request = await c.create(["service-hemogram"]);
    const received = await c.service.receiveSample(c.lab, [request.items[0].id], { expectedVersion: 1 });
    const recollection = await c.service.requestRecollection(c.lab, received.sample.id, { reasonCode: "HEMOLYZED", expectedVersion: received.items[0].version, idempotencyKey: "recollect-gen" });
    const { replacement } = recollection;
    expect(replacement.accessionCode).not.toMatch(/^PENDING-/);
    expect(validateAccessionCheckCharacter(replacement.accessionCode)).toBe(true);
    expect(replacement.accessionCode).not.toBe(received.sample.accessionCode);
    expect(replacement).toMatchObject({ status: "EXPECTED", sampleType: "EDTA", replacesSampleId: received.sample.id });
    await expect(c.service.receiveReplacement(c.lab, replacement.id, { accessionCode: received.sample.accessionCode, expectedVersion: recollection.items[0].version, idempotencyKey: "replacement-wrong" })).rejects.toMatchObject({ code: "ACCESSION_MISMATCH", status: 409 });
    const done = await c.service.receiveReplacement(c.lab, replacement.id, { accessionCode: replacement.accessionCode, expectedVersion: recollection.items[0].version, idempotencyKey: "replacement-scan" });
    expect(done.sample).toMatchObject({ status: "RECEIVED", accessionCode: replacement.accessionCode, sampleType: "EDTA" });
  });

  it("still receives a recollection that carries the legacy PENDING placeholder", async () => {
    const c = setup();
    const request = await c.create(["service-hemogram"]);
    const received = await c.service.receiveSample(c.lab, [request.items[0].id], { sampleType: "EDTA", expectedVersion: 1 });
    const recollection = await c.service.requestRecollection(c.lab, received.sample.id, { reasonCode: "HEMOLYZED", expectedVersion: received.items[0].version, idempotencyKey: "recollect-legacy" });
    const setCode = (code: string) => c.store.transaction((state) => ({ state: { ...state, samples: state.samples.map((sample) => sample.id === recollection.replacement.id ? { ...sample, accessionCode: code } : sample) }, result: undefined }));
    await setCode("PENDING-ABCD1234");
    await expect(c.service.receiveReplacement(c.lab, recollection.replacement.id, { accessionCode: received.sample.accessionCode, expectedVersion: recollection.items[0].version, idempotencyKey: "legacy-dup" })).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
    const typed = await c.service.receiveReplacement(c.lab, recollection.replacement.id, { accessionCode: "ACC-REPL-1", expectedVersion: recollection.items[0].version, idempotencyKey: "legacy-typed" });
    expect(typed.sample.accessionCode).toBe("ACC-REPL-1");

    const second = await c.service.requestRecollection(c.lab, typed.sample.id, { reasonCode: "HEMOLYZED", expectedVersion: typed.items[0].version, idempotencyKey: "recollect-legacy-2" });
    await c.store.transaction((state) => ({ state: { ...state, samples: state.samples.map((sample) => sample.id === second.replacement.id ? { ...sample, accessionCode: "PENDING-ZZZZ9999" } : sample) }, result: undefined }));
    const generated = await c.service.receiveReplacement(c.lab, second.replacement.id, { expectedVersion: second.items[0].version, idempotencyKey: "legacy-generated" });
    expect(validateAccessionCheckCharacter(generated.sample.accessionCode)).toBe(true);
  });

  it("detaches one exam from a shared EXPECTED tube instead of rejecting the tube", async () => {
    const c = setup();
    await c.catalog({ "service-hemogram": "EDTA", "service-crp": "EDTA" });
    const request = await c.create(["service-hemogram", "service-crp"]);
    await c.service.rejectItem(c.lab, request.items[0].id, { reasonCode: "UNPROCESSABLE", expectedVersion: 1, idempotencyKey: "reject-shared" });
    const [sample] = c.store.getState().samples;
    expect(sample).toMatchObject({ status: "EXPECTED", itemIds: [request.items[1].id], version: 2 });
  });
});

describe("sample label read", () => {
  it("returns the printable label with a Code 128 barcode and the configured size", async () => {
    const c = setup();
    await c.catalog({ "service-hemogram": "EDTA", "service-crp": "EDTA" });
    const request = await c.create(["service-hemogram", "service-crp"]);
    const label = await c.service.getSampleLabel(c.lab, request.samples[0].id);
    expect(label).toMatchObject({
      sample: { id: request.samples[0].id, accessionCode: request.samples[0].accessionCode, sampleType: "EDTA", status: "EXPECTED" },
      request: { id: request.id, requestCode: request.requestCode, priority: "ROUTINE" },
      patient: { id: "patient-thor", displayName: "Thor", species: "Canino", externalId: "HIS-THOR-001" },
      services: [{ code: "HEMOGRAM", name: "Hemograma" }, { code: "CRP", name: "Proteína C reativa" }],
      encounter: { externalId: "ATD-THOR-001" },
      requestedAt: request.createdAt,
      label: { widthMm: 50, heightMm: 30, barcode: { symbology: "code128" } }
    });
    expect(label.label.barcode.bars.length).toBeGreaterThan(10);
    expect(label.label.barcode.bars.every((bar) => bar.x >= 10 && bar.x + bar.width <= label.label.barcode.modules - 10)).toBe(true);
    process.env.LABEL_WIDTH_MM = "70";
    process.env.LABEL_HEIGHT_MM = "40";
    expect((await c.service.getSampleLabel(c.manager, request.samples[0].id)).label).toMatchObject({ widthMm: 70, heightMm: 40 });
  });

  it("lists only the services the reader may see and hides foreign or unknown samples", async () => {
    const c = setup();
    await c.catalog({ "service-hemogram": "EDTA", "service-crp": "EDTA" });
    const request = await c.create(["service-hemogram", "service-crp"]);
    const sampleId = request.samples[0].id;
    await c.store.transaction((state) => ({ state: { ...state, users: state.users.map((user: User) => user.id === c.lab.id ? { ...user, serviceCodes: ["CRP"] } : user) }, result: undefined }));
    const partialLab = c.store.getState().users.find((user) => user.id === c.lab.id)!;
    expect((await c.service.getSampleLabel(partialLab, sampleId)).services).toEqual([{ code: "CRP", name: "Proteína C reativa" }]);

    await expect(c.service.getSampleLabel(c.rx, sampleId)).rejects.toMatchObject({ code: "SCOPE_DENIED", status: 404 });
    await expect(c.service.getSampleLabel(c.lab, "sample-missing")).rejects.toMatchObject({ code: "SCOPE_DENIED", status: 404 });
    await expect(c.service.getSampleLabel({ ...c.vet, patientIds: ["patient-mel"] }, sampleId)).rejects.toMatchObject({ status: 404 });
    await expect(c.service.getSampleLabel({ ...c.lab, id: "nobody" }, sampleId)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
});
