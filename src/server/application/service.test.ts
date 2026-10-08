import { describe, expect, it } from "vitest";
import { createApplicationService } from "./service";
import { createDemoState, syntheticHemogramContent, withoutPreassignedSamples } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";

function setup() {
  const store = new MemoryStore(createDemoState());
  const service = createApplicationService(store);
  const actor = store.getState().users.find((user) => user.email === "vet@cvg.local");
  const labActor = store.getState().users.find((user) => user.email === "lab@cvg.local");
  if (!actor || !labActor) throw new Error("missing fixture actor");
  return { store, service, actor, labActor };
}

describe("diagnostic application service", () => {
  it("creates a contextual multi-item request and stable human protocol", async () => {
    const { service, actor } = setup();
    const patient = "patient-thor";
    const encounter = "encounter-thor";

    const result = await service.createRequest(actor, {
      patientId: patient,
      encounterId: encounter,
      priority: "URGENT",
      items: [{ serviceId: "service-hemogram" }, { serviceId: "service-xray" }]
    }, { idempotencyKey: "request-1", correlationId: "corr-request-1" });

    expect(result.requestCode).toMatch(/^EX-/);
    expect(result.items).toHaveLength(2);
    expect(result.items.map((item) => item.status)).toEqual(["REQUESTED", "REQUESTED"]);
    expect(result.requesterId).toBe(actor.id);
    expect(result.items[0]).toMatchObject({ slaPolicyVersion: 1, slaStartedAt: expect.any(String), dueAt: expect.any(String) });
    expect(Date.parse(result.items[0].dueAt) - Date.parse(result.items[0].slaStartedAt)).toBe(4 * 60 * 60 * 1000);
  });

  it("returns the committed request for a repeated idempotency key", async () => {
    const { service, actor } = setup();
    const input = {
      patientId: "patient-thor",
      encounterId: "encounter-thor",
      priority: "ROUTINE" as const,
      items: [{ serviceId: "service-hemogram" }]
    };

    const first = await service.createRequest(actor, input, { idempotencyKey: "request-retry" });
    const second = await service.createRequest(actor, input, { idempotencyKey: "request-retry" });

    expect(second.id).toBe(first.id);
    expect(second.requestCode).toBe(first.requestCode);
  });

  it("keeps duplicate requests behind an explicit warning and reason", async () => {
    const { service, actor } = setup();
    const input = {
      patientId: "patient-thor",
      encounterId: "encounter-thor",
      priority: "ROUTINE" as const,
      items: [{ serviceId: "service-hemogram" }]
    };

    await service.createRequest(actor, input, { idempotencyKey: "request-original" });
    await expect(
      service.createRequest(actor, input, { idempotencyKey: "request-duplicate" })
    ).rejects.toMatchObject({ code: "DUPLICATE_WARNING", status: 409 });

    await expect(
      service.createRequest(actor, input, { idempotencyKey: "request-override-without-reason", allowDuplicateOverride: true })
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 });
    const override = await service.createRequest(
      actor,
      { ...input, overrideReason: "Repetir coleta por decisão clínica" },
      { idempotencyKey: "request-override", allowDuplicateOverride: true }
    );
    expect(override.items).toHaveLength(1);
    // Every active duplicate is reported, in the order the exams were created.
    const [original] = (await service.listRequests(actor, {})).items.filter((request) => request.id !== override.id);
    await expect(
      service.createRequest(actor, input, { idempotencyKey: "request-third" })
    ).rejects.toMatchObject({ code: "DUPLICATE_WARNING", details: { existingRequestCodes: [original.requestCode, override.requestCode] } });
  });

  it("preserves a replaced sample chain and makes replacement actionable", async () => {
    const { service, actor, labActor, store } = setup();
    const request = await service.createRequest(actor, {
      patientId: "patient-thor",
      encounterId: "encounter-thor",
      priority: "ROUTINE",
      items: [{ serviceId: "service-hemogram" }, { serviceId: "service-crp" }]
    }, { idempotencyKey: "request-lab" });
    // Legacy path (request created before the generated accession): one tube for both items.
    await store.transaction((state) => ({ state: withoutPreassignedSamples(state, request.id), result: undefined }));

    const received = await service.receiveSample(labActor, request.items.map((item) => item.id), {
      accessionCode: "ACC-0001",
      sampleType: "EDTA",
      expectedVersion: 1,
      idempotencyKey: "sample-receive"
    });
    const recollection = await service.requestRecollection(labActor, received.sample.id, {
      reasonCode: "HEMOLYZED",
      note: "Amostra hemolisada",
      expectedVersion: received.items[0].version,
      idempotencyKey: "sample-recollect"
    });

    expect(recollection.sample.status).toBe("REPLACED");
    expect(recollection.sample.version).toBe(2);
    expect(recollection.replacement.replacesSampleId).toBe(received.sample.id);
    expect(recollection.replacement.status).toBe("EXPECTED");
    expect(recollection.items.every((item) => item.status === "RECOLLECTION_REQUIRED")).toBe(true);
    expect(store.getState().samples).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: received.sample.id, status: "REPLACED", version: 2 }),
      expect.objectContaining({ id: recollection.replacement.id, status: "EXPECTED", version: 1, replacesSampleId: received.sample.id })
    ]));
    await expect(service.receiveReplacement(labActor, recollection.replacement.id, {
      accessionCode: "bad accession",
      sampleType: "EDTA",
      expectedVersion: recollection.items[0].version,
      idempotencyKey: "sample-replacement-invalid-accession"
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 });
    const replacement = await service.receiveReplacement(labActor, recollection.replacement.id, {
      sampleType: "EDTA",
      expectedVersion: recollection.items[0].version,
      idempotencyKey: "sample-replacement-receive"
    });
    expect(replacement.sample).toMatchObject({ status: "RECEIVED", version: 2, replacesSampleId: received.sample.id });
    expect(store.getState().samples).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: received.sample.id, status: "REPLACED", version: 2 }),
      expect.objectContaining({ id: replacement.sample.id, status: "RECEIVED", version: 2 })
    ]));
    expect((await service.timeline(actor, request.id)).items.some((event) => event.entityType === "Sample")).toBe(true);
  });

  it("rejects duplicate item IDs before creating a sample or links", async () => {
    const { service, actor, labActor, store } = setup();
    const request = await service.createRequest(actor, {
      patientId: "patient-thor",
      encounterId: "encounter-thor",
      priority: "ROUTINE",
      items: [{ serviceId: "service-hemogram" }]
    }, { idempotencyKey: "request-duplicate-sample-items" });

    await expect(service.receiveSample(labActor, [request.items[0].id, request.items[0].id], {
      sampleType: "EDTA",
      expectedVersion: request.items[0].version,
      idempotencyKey: "sample-duplicate-item"
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 });
    expect(store.getState().samples.map((sample) => sample.status)).toEqual(["EXPECTED"]);
  });

  it("rejects stale item versions across sample receipt and recollection", async () => {
    const { service, actor, labActor, store } = setup();
    const request = await service.createRequest(actor, {
      patientId: "patient-thor",
      encounterId: "encounter-thor",
      priority: "ROUTINE",
      items: [{ serviceId: "service-hemogram" }]
    }, { idempotencyKey: "request-sample-concurrency" });
    const item = request.items[0];

    await expect(service.receiveSample(labActor, [item.id], {
      sampleType: "EDTA",
      expectedVersion: item.version + 1,
      idempotencyKey: "sample-stale-receive"
    })).rejects.toMatchObject({ code: "STALE_VERSION", status: 409 });
    expect(store.getState().items.find((entry) => entry.id === item.id)).toMatchObject({ status: "REQUESTED", version: item.version });

    const received = await service.receiveSample(labActor, [item.id], {
      sampleType: "EDTA",
      expectedVersion: item.version,
      idempotencyKey: "sample-fresh-receive"
    });
    await expect(service.requestRecollection(labActor, received.sample.id, {
      reasonCode: "HEMOLYZED",
      expectedVersion: item.version,
      idempotencyKey: "sample-stale-recollection"
    })).rejects.toMatchObject({ code: "STALE_VERSION", status: 409 });

    const recollection = await service.requestRecollection(labActor, received.sample.id, {
      reasonCode: "HEMOLYZED",
      expectedVersion: received.items[0].version,
      idempotencyKey: "sample-fresh-recollection"
    });
    await expect(service.receiveReplacement(labActor, recollection.replacement.id, {
      sampleType: "EDTA",
      expectedVersion: received.items[0].version,
      idempotencyKey: "replacement-stale-receive"
    })).rejects.toMatchObject({ code: "STALE_VERSION", status: 409 });
  });

  it("releases once, records notifications, and rejects stale review", async () => {
    const { service, actor, labActor, store } = setup();
    const request = await service.createRequest(actor, {
      patientId: "patient-thor",
      encounterId: "encounter-thor",
      priority: "ROUTINE",
      items: [{ serviceId: "service-hemogram" }]
    }, { idempotencyKey: "request-result" });
    const item = request.items[0];
    await service.receiveSample(labActor, [item.id], {
      sampleType: "EDTA",
      expectedVersion: 1,
      idempotencyKey: "sample-result"
    });
    await service.startProcessing(labActor, item.id, { expectedVersion: 2, idempotencyKey: "start-result" });
    const draft = await service.createResultDraft(labActor, item.id, {
      narrative: "Hemograma dentro dos parâmetros.",
      content: syntheticHemogramContent("clinical-domain-a"),
      expectedVersion: 3,
      idempotencyKey: "draft-result"
    });
    await expect(service.createResultDraft(labActor, item.id, {
      narrative: "Hemograma dentro dos parâmetros.",
      content: syntheticHemogramContent("clinical-domain-b"),
      expectedVersion: 3,
      idempotencyKey: "draft-result"
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED", status: 409 });
    await expect(service.updateResultDraft(actor, draft.result.id, {
      narrative: "Hemograma atualizado dentro dos parâmetros.",
      content: syntheticHemogramContent("Atualizado dentro dos parâmetros."),
      expectedVersion: draft.result.version,
      idempotencyKey: "draft-update-denied"
    })).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    const updatedDraft = await service.updateResultDraft(labActor, draft.result.id, {
      narrative: "Hemograma atualizado dentro dos parâmetros.",
      content: syntheticHemogramContent("Atualizado dentro dos parâmetros."),
      expectedVersion: draft.result.version,
      idempotencyKey: "draft-update"
    });
    expect(updatedDraft.version.narrative).toContain("atualizado");
    expect(updatedDraft.result.version).toBe(draft.result.version + 1);
    const released = await service.releaseResult(labActor, draft.result.id, {
      expectedVersion: updatedDraft.result.version,
      idempotencyKey: "release-result"
    });

    expect(released.version.status).toBe("RELEASED");
    expect(released.item.status).toBe("RESULT_AVAILABLE");
    expect((await service.listResultVersions(actor, released.result.id))).toHaveLength(1);
    expect(store.getState().notifications).toHaveLength(1);
    expect(store.getState().auditEvents.some((event) => event.eventType === "ResultReleased")).toBe(true);
    expect((await service.timeline(actor, request.id)).items.some((event) => event.entityType === "ResultVersion")).toBe(true);

    const repeated = await service.releaseResult(labActor, draft.result.id, {
      expectedVersion: updatedDraft.result.version,
      idempotencyKey: "release-result"
    });
    expect(repeated.version.id).toBe(released.version.id);

    await expect(service.viewResult(actor, released.version.id, {
      expectedVersion: released.item.version - 1,
      idempotencyKey: "view-result-stale"
    })).rejects.toMatchObject({ code: "STALE_VERSION", status: 409 });
    await service.viewResult(actor, released.version.id, { expectedVersion: released.item.version, idempotencyKey: "view-result" });
    await expect(
      service.reviewResult(actor, released.result.id, {
        versionId: "different-version",
        expectedVersion: released.item.version,
        idempotencyKey: "review-stale"
      })
    ).rejects.toMatchObject({ code: "REVIEW_STALE", status: 409 });
  });
});
