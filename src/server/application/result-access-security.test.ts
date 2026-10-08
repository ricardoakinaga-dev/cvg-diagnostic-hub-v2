import { describe, expect, it } from "vitest";
import type { User } from "../domain/models";
import { createDemoState, syntheticHemogramContent } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { createApplicationService } from "./service";

function requiredUser(users: User[], email: string): User {
  const user = users.find((entry) => entry.email === email);
  if (!user) throw new Error(`missing fixture actor: ${email}`);
  return user;
}

function setup() {
  const initialState = createDemoState("result-security-password");
  const fixtureLab = requiredUser(initialState.users, "lab@cvg.local");
  const peerLab: User = {
    ...fixtureLab,
    id: "user-lab-peer",
    email: "lab-peer@cvg.local",
    displayName: "Técnica Colega",
    serviceCodes: ["HEMOGRAM"]
  };
  const store = new MemoryStore({
    ...initialState,
    users: [...initialState.users, peerLab]
  });
  const service = createApplicationService(store);
  const users = store.getState().users;
  return {
    store,
    service,
    vet: requiredUser(users, "vet@cvg.local"),
    lab: requiredUser(users, "lab@cvg.local"),
    peerLab: requiredUser(users, "lab-peer@cvg.local"),
    manager: requiredUser(users, "manager@cvg.local")
  };
}

async function prepareHemogramItem(context: ReturnType<typeof setup>) {
  const request = await context.service.createRequest(context.vet, {
    patientId: "patient-thor",
    encounterId: "encounter-thor",
    priority: "ROUTINE",
    items: [{ serviceId: "service-hemogram" }]
  }, { idempotencyKey: `security-request-${crypto.randomUUID()}` });
  const received = await context.service.receiveSample(context.lab, [request.items[0].id], {
    sampleType: "EDTA",
    expectedVersion: request.items[0].version,
    idempotencyKey: `security-receive-${crypto.randomUUID()}`
  });
  const started = await context.service.startProcessing(context.lab, request.items[0].id, {
    expectedVersion: received.items[0].version,
    idempotencyKey: `security-start-${crypto.randomUUID()}`
  });
  return { request, item: started.item };
}

async function createHemogramDraft(context: ReturnType<typeof setup>) {
  const { request, item } = await prepareHemogramItem(context);
  const draft = await context.service.createResultDraft(context.lab, request.items[0].id, {
    narrative: "Resultado clínico ainda não liberado.",
    content: syntheticHemogramContent(),
    expectedVersion: item.version,
    idempotencyKey: `security-draft-${crypto.randomUUID()}`
  });
  return { request, item, draft };
}

async function createManagerMultiSectorDraft(context: ReturnType<typeof setup>) {
  const request = await context.service.createRequest(context.manager, {
    patientId: "patient-thor",
    encounterId: "encounter-thor",
    priority: "ROUTINE",
    items: [{ serviceId: "service-hemogram" }, { serviceId: "service-ultrasound" }]
  }, { idempotencyKey: `security-manager-multi-sector-${crypto.randomUUID()}` });
  const hemogramItem = request.items.find((item) => item.serviceId === "service-hemogram");
  if (!hemogramItem) throw new Error("missing manager hemogram item");
  const received = await context.service.receiveSample(context.manager, [hemogramItem.id], {
    sampleType: "EDTA",
    expectedVersion: hemogramItem.version,
    idempotencyKey: `security-manager-receive-${crypto.randomUUID()}`
  });
  const started = await context.service.startProcessing(context.manager, hemogramItem.id, {
    expectedVersion: received.items[0].version,
    idempotencyKey: `security-manager-start-${crypto.randomUUID()}`
  });
  const draft = await context.service.createResultDraft(context.manager, hemogramItem.id, {
    narrative: "Resultado gerencial multi-setor.",
    content: syntheticHemogramContent("Resultado gerencial multi-setor."),
    expectedVersion: started.item.version,
    idempotencyKey: `security-manager-draft-${crypto.randomUUID()}`
  });
  return { request, hemogramItem, draft };
}

async function narrowManagerToLaboratory(context: ReturnType<typeof setup>): Promise<User> {
  await context.store.transaction((state) => ({
    state: {
      ...state,
      users: state.users.map((user) => user.id === context.manager.id
        ? { ...user, managedDepartmentCodes: ["LABORATORY"] }
        : user)
    },
    result: undefined
  }));
  return requiredUser(context.store.getState().users, "manager@cvg.local");
}

async function rejectionFrom(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("clinical result access security", () => {
  it("does not expose a current DRAFT through result, report, or history reads", async () => {
    const context = setup();
    const { draft } = await createHemogramDraft(context);

    const errors = await Promise.all([
      rejectionFrom(() => context.service.getResult(context.vet, draft.result.id)),
      rejectionFrom(() => context.service.getReport(context.vet, draft.result.id)),
      rejectionFrom(() => context.service.listResultVersions(context.vet, draft.result.id))
    ]);
    for (const error of errors) {
      expect.soft(error).toMatchObject({ code: "NOT_FOUND", status: 404 });
    }
  });

  it("does not expose a VOIDED result or its invalidated version to a clinical reader", async () => {
    const context = setup();
    const { draft } = await createHemogramDraft(context);
    const released = await context.service.releaseResult(context.lab, draft.result.id, {
      expectedVersion: draft.result.version,
      idempotencyKey: "security-release-before-void"
    });
    await context.service.voidResult(context.lab, released.result.id, {
      reason: "Invalidação de segurança",
      expectedVersion: released.result.version,
      idempotencyKey: "security-void"
    });

    const errors = await Promise.all([
      rejectionFrom(() => context.service.getResult(context.vet, released.result.id)),
      rejectionFrom(() => context.service.getReport(context.vet, released.result.id)),
      rejectionFrom(() => context.service.listResultVersions(context.vet, released.result.id))
    ]);
    for (const error of errors) {
      expect.soft(error).toMatchObject({ code: "NOT_FOUND", status: 404 });
    }
  });

  it("keeps a previously released version visible in history while hiding an amended DRAFT", async () => {
    const context = setup();
    const { draft } = await createHemogramDraft(context);
    const released = await context.service.releaseResult(context.lab, draft.result.id, {
      expectedVersion: draft.result.version,
      idempotencyKey: "security-release-before-amend"
    });
    const amended = await context.service.amendResult(context.lab, released.result.id, {
      reason: "Correção ainda não liberada",
      narrative: "Versão corrigida em elaboração.",
      content: syntheticHemogramContent("Correção ainda não liberada."),
      expectedVersion: released.result.version,
      idempotencyKey: "security-amend-draft"
    });

    const [resultError, reportError, versions] = await Promise.all([
      rejectionFrom(() => context.service.getResult(context.vet, amended.result.id)),
      rejectionFrom(() => context.service.getReport(context.vet, amended.result.id)),
      context.service.listResultVersions(context.vet, amended.result.id)
    ]);
    expect.soft(resultError).toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect.soft(reportError).toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect.soft(versions).toEqual([
      expect.objectContaining({ id: released.version.id, status: "SUPERSEDED" })
    ]);
  });

  it("audits permitted GET reads without creating the deliberate ResultViewed event", async () => {
    const context = setup();
    const { draft } = await createHemogramDraft(context);
    const released = await context.service.releaseResult(context.lab, draft.result.id, {
      expectedVersion: draft.result.version,
      idempotencyKey: "security-release-for-read-audit"
    });

    await context.service.getResult(context.vet, released.result.id);
    await context.service.getReport(context.vet, released.result.id);
    await context.service.listResultVersions(context.vet, released.result.id);

    const actorEvents = context.store.getState().auditEvents.filter((event) => event.actorId === context.vet.id);
    expect(actorEvents.map((event) => event.eventType)).toEqual(expect.arrayContaining([
      "ResultRead",
      "ReportRead",
      "ResultHistoryRead"
    ]));
    expect(actorEvents).not.toContainEqual(expect.objectContaining({
      eventType: "ResultViewed",
      entityId: released.version.id
    }));
    await expect(context.service.reviewResult(context.vet, released.result.id, {
      versionId: released.version.id,
      expectedVersion: released.item.version,
      idempotencyKey: "security-review-with-get-only"
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 });
  });

  it("only exposes clean finalized attachments in a released report", async () => {
    const context = setup();
    const { draft } = await createHemogramDraft(context);
    const released = await context.service.releaseResult(context.lab, draft.result.id, {
      expectedVersion: draft.result.version,
      idempotencyKey: "security-release-attachment-boundary"
    });
    const baseAttachment = {
      resultVersionId: released.version.id,
      safeName: "laudo.pdf",
      storageKey: "private/result/laudo.pdf",
      detectedMime: "application/pdf",
      sizeBytes: 2048,
      checksum: "b".repeat(64),
      scanStatus: "CLEAN" as const,
      uploadStatus: "FINALIZED" as const,
      createdBy: context.lab.id,
      createdAt: new Date().toISOString()
    };
    await context.store.transaction((state) => ({
      state: {
        ...state,
        attachments: [
          ...state.attachments,
          { ...baseAttachment, id: "attachment-report-clean" },
          { ...baseAttachment, id: "attachment-report-pending", safeName: "pending.pdf", scanStatus: "PENDING", uploadStatus: "UPLOADED" },
          { ...baseAttachment, id: "attachment-report-quarantined", safeName: "quarantined.pdf", scanStatus: "QUARANTINED" }
        ]
      },
      result: undefined
    }));

    const report = await context.service.getReport(context.vet, released.result.id);

    expect(report.attachments).toEqual([expect.objectContaining({ id: "attachment-report-clean", scanStatus: "CLEAN", uploadStatus: "FINALIZED" })]);
    expect(report.attachments).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "attachment-report-pending" }),
      expect.objectContaining({ id: "attachment-report-quarantined" })
    ]));
  });

  it("allows only the exact draft author to read the current draft and audits that access", async () => {
    const context = setup();
    const { draft } = await createHemogramDraft(context);

    const readable = await context.service.getResult(context.lab, draft.result.id);

    expect(readable.version).toMatchObject({ id: draft.version.id, status: "DRAFT" });
    expect(context.store.getState().auditEvents).toContainEqual(expect.objectContaining({
      eventType: "ResultDraftRead",
      actorId: context.lab.id,
      entityId: draft.version.id
    }));
  });
});

describe("result draft write security", () => {
  it("requires the LAB_TECH actor to own the draft being edited", async () => {
    const context = setup();
    const { draft } = await createHemogramDraft(context);

    await expect(context.service.updateResultDraft(context.peerLab, draft.result.id, {
      narrative: "Edição indevida por outro autor.",
      content: { hemoglobin: 13.1 },
      expectedVersion: draft.result.version,
      idempotencyKey: "security-peer-edit"
    })).rejects.toMatchObject({ code: "SCOPE_DENIED", status: 404 });
  });

  it("denies editing when the draft service is outside the LAB_TECH serviceCodes", async () => {
    const context = setup();
    const { draft } = await createHemogramDraft(context);
    await context.store.transaction((state) => ({
      state: {
        ...state,
        users: state.users.map((user) => user.id === context.lab.id
          ? { ...user, serviceCodes: ["CRP"] }
          : user)
      },
      result: undefined
    }));
    const restrictedLab = requiredUser(context.store.getState().users, "lab@cvg.local");

    await expect(context.service.updateResultDraft(restrictedLab, draft.result.id, {
      narrative: "Edição fora do serviço atribuído.",
      content: { hemoglobin: 13.2 },
      expectedVersion: draft.result.version,
      idempotencyKey: "security-out-of-service-edit"
    })).rejects.toMatchObject({ code: "SCOPE_DENIED", status: 404 });
  });

  it("denies release when the result service is outside the LAB_TECH serviceCodes", async () => {
    const context = setup();
    const { draft } = await createHemogramDraft(context);
    await context.store.transaction((state) => ({
      state: { ...state, users: state.users.map((user) => user.id === context.lab.id ? { ...user, serviceCodes: ["CRP"] } : user) },
      result: undefined
    }));
    const restrictedLab = requiredUser(context.store.getState().users, "lab@cvg.local");

    await expect(context.service.releaseResult(restrictedLab, draft.result.id, {
      expectedVersion: draft.result.version,
      idempotencyKey: "security-out-of-service-release"
    })).rejects.toMatchObject({ code: "SCOPE_DENIED", status: 404 });
  });

  it("rechecks draft scope before replaying a previously successful edit", async () => {
    const context = setup();
    const { draft } = await createHemogramDraft(context);
    const input = {
      narrative: "Edição idempotente autorizada.",
      content: syntheticHemogramContent("Edição idempotente autorizada."),
      expectedVersion: draft.result.version,
      idempotencyKey: "security-draft-replay-after-revocation"
    };
    await context.service.updateResultDraft(context.lab, draft.result.id, input);
    await context.store.transaction((state) => ({
      state: {
        ...state,
        users: state.users.map((user) => user.id === context.lab.id ? { ...user, serviceCodes: [] } : user)
      },
      result: undefined
    }));
    const revokedLab = requiredUser(context.store.getState().users, "lab@cvg.local");

    await expect(context.service.updateResultDraft(revokedLab, draft.result.id, input)).rejects.toMatchObject({ code: "SCOPE_DENIED", status: 404 });
  });

  it("denies amend when the result service is outside the LAB_TECH serviceCodes", async () => {
    const context = setup();
    const { draft } = await createHemogramDraft(context);
    const released = await context.service.releaseResult(context.lab, draft.result.id, {
      expectedVersion: draft.result.version,
      idempotencyKey: "security-release-before-scope-amend"
    });
    await context.store.transaction((state) => ({
      state: { ...state, users: state.users.map((user) => user.id === context.lab.id ? { ...user, serviceCodes: ["CRP"] } : user) },
      result: undefined
    }));
    const restrictedLab = requiredUser(context.store.getState().users, "lab@cvg.local");

    await expect(context.service.amendResult(restrictedLab, released.result.id, {
      reason: "Tentativa fora do serviço",
      narrative: "Emenda indevida.",
      content: {},
      expectedVersion: released.result.version,
      idempotencyKey: "security-out-of-service-amend"
    })).rejects.toMatchObject({ code: "SCOPE_DENIED", status: 404 });
  });

  it("denies void when the result service is outside the LAB_TECH serviceCodes", async () => {
    const context = setup();
    const { draft } = await createHemogramDraft(context);
    const released = await context.service.releaseResult(context.lab, draft.result.id, {
      expectedVersion: draft.result.version,
      idempotencyKey: "security-release-before-scope-void"
    });
    await context.store.transaction((state) => ({
      state: { ...state, users: state.users.map((user) => user.id === context.lab.id ? { ...user, serviceCodes: ["CRP"] } : user) },
      result: undefined
    }));
    const restrictedLab = requiredUser(context.store.getState().users, "lab@cvg.local");

    await expect(context.service.voidResult(restrictedLab, released.result.id, {
      reason: "Tentativa fora do serviço",
      expectedVersion: released.result.version,
      idempotencyKey: "security-out-of-service-void"
    })).rejects.toMatchObject({ code: "SCOPE_DENIED", status: 404 });
  });

  it("denies a same-service peer from amending another technician's released result", async () => {
    const context = setup();
    const { draft } = await createHemogramDraft(context);
    const released = await context.service.releaseResult(context.lab, draft.result.id, {
      expectedVersion: draft.result.version,
      idempotencyKey: "security-peer-amend-release"
    });
    const before = context.store.getState();

    await expect(context.service.amendResult(context.peerLab, released.result.id, {
      reason: "Emenda indevida por colega",
      narrative: "Tentativa de alterar resultado alheio.",
      content: syntheticHemogramContent("Tentativa de alteração indevida."),
      expectedVersion: released.result.version,
      idempotencyKey: "security-peer-amend"
    })).rejects.toMatchObject({ code: "SCOPE_DENIED", status: 404 });

    const after = context.store.getState();
    expect(after.results).toEqual(before.results);
    expect(after.resultVersions).toEqual(before.resultVersions);
    expect(after.auditEvents).toEqual(before.auditEvents);
    expect(after.outbox).toEqual(before.outbox);
  });

  it("denies a same-service peer from releasing another technician's draft", async () => {
    const context = setup();
    const { draft } = await createHemogramDraft(context);
    const before = context.store.getState();

    await expect(context.service.releaseResult(context.peerLab, draft.result.id, {
      expectedVersion: draft.result.version,
      idempotencyKey: "security-peer-release"
    })).rejects.toMatchObject({ code: "SCOPE_DENIED", status: 404 });

    const after = context.store.getState();
    expect(after.results).toEqual(before.results);
    expect(after.resultVersions).toEqual(before.resultVersions);
    expect(after.auditEvents).toEqual(before.auditEvents);
    expect(after.outbox).toEqual(before.outbox);
  });

  it("revalidates scope before replaying a previously successful release", async () => {
    const context = setup();
    const { draft } = await createHemogramDraft(context);
    const input = {
      expectedVersion: draft.result.version,
      idempotencyKey: "security-release-replay-after-revocation"
    };
    await context.service.releaseResult(context.lab, draft.result.id, input);
    await context.store.transaction((state) => ({
      state: {
        ...state,
        users: state.users.map((user) => user.id === context.lab.id ? { ...user, serviceCodes: [] } : user)
      },
      result: undefined
    }));
    const revokedLab = requiredUser(context.store.getState().users, "lab@cvg.local");

    await expect(context.service.releaseResult(revokedLab, draft.result.id, input)).rejects.toMatchObject({ code: "SCOPE_DENIED", status: 404 });
  });

  it("reprojects a successful release replay after a manager loses one delegated department", async () => {
    const context = setup();
    const { draft } = await createManagerMultiSectorDraft(context);
    const input = {
      expectedVersion: draft.result.version,
      idempotencyKey: "security-manager-release-projection-replay"
    };
    const first = await context.service.releaseResult(context.manager, draft.result.id, input);
    expect(first.request.items).toHaveLength(2);

    const narrowedManager = await narrowManagerToLaboratory(context);
    const replay = await context.service.releaseResult(narrowedManager, draft.result.id, input);

    expect(replay.request.itemIds).toEqual([first.item.id]);
    expect(replay.request.items).toEqual([expect.objectContaining({ id: first.item.id, serviceId: "service-hemogram" })]);
    expect(replay.request.items).not.toEqual(expect.arrayContaining([expect.objectContaining({ serviceId: "service-ultrasound" })]));
  });

  it("reprojects a successful amendment replay after a manager loses one delegated department", async () => {
    const context = setup();
    const { draft } = await createManagerMultiSectorDraft(context);
    const released = await context.service.releaseResult(context.manager, draft.result.id, {
      expectedVersion: draft.result.version,
      idempotencyKey: "security-manager-amend-release"
    });
    const input = {
      reason: "Correção gerencial",
      narrative: "Resultado corrigido.",
      content: syntheticHemogramContent("Resultado corrigido."),
      expectedVersion: released.result.version,
      idempotencyKey: "security-manager-amend-projection-replay"
    };
    const first = await context.service.amendResult(context.manager, released.result.id, input);
    expect(first.request.items).toHaveLength(2);

    const narrowedManager = await narrowManagerToLaboratory(context);
    const replay = await context.service.amendResult(narrowedManager, released.result.id, input);

    expect(replay.request.itemIds).toEqual([first.item.id]);
    expect(replay.request.items).not.toEqual(expect.arrayContaining([expect.objectContaining({ serviceId: "service-ultrasound" })]));
  });

  it("reprojects a successful void replay after a manager loses one delegated department", async () => {
    const context = setup();
    const { draft } = await createManagerMultiSectorDraft(context);
    const released = await context.service.releaseResult(context.manager, draft.result.id, {
      expectedVersion: draft.result.version,
      idempotencyKey: "security-manager-void-release"
    });
    const input = {
      reason: "Invalidação gerencial",
      expectedVersion: released.result.version,
      idempotencyKey: "security-manager-void-projection-replay"
    };
    const first = await context.service.voidResult(context.manager, released.result.id, input);
    expect(first.request.items).toHaveLength(2);

    const narrowedManager = await narrowManagerToLaboratory(context);
    const replay = await context.service.voidResult(narrowedManager, released.result.id, input);

    expect(replay.request.itemIds).toEqual([first.item.id]);
    expect(replay.request.items).not.toEqual(expect.arrayContaining([expect.objectContaining({ serviceId: "service-ultrasound" })]));
  });

  it("denies a same-service peer from voiding another technician's released result", async () => {
    const context = setup();
    const { draft } = await createHemogramDraft(context);
    const released = await context.service.releaseResult(context.lab, draft.result.id, {
      expectedVersion: draft.result.version,
      idempotencyKey: "security-peer-void-release"
    });
    const before = context.store.getState();

    await expect(context.service.voidResult(context.peerLab, released.result.id, {
      reason: "Invalidação indevida por colega",
      expectedVersion: released.result.version,
      idempotencyKey: "security-peer-void"
    })).rejects.toMatchObject({ code: "SCOPE_DENIED", status: 404 });

    const after = context.store.getState();
    expect(after.results).toEqual(before.results);
    expect(after.resultVersions).toEqual(before.resultVersions);
    expect(after.auditEvents).toEqual(before.auditEvents);
    expect(after.outbox).toEqual(before.outbox);
  });

  it("rejects a second active draft and preserves the original result lineage", async () => {
    const context = setup();
    const { draft } = await createHemogramDraft(context);
    let duplicateError: unknown;

    try {
      await context.service.createResultDraft(context.lab, draft.item.id, {
        narrative: "Segundo draft concorrente indevido.",
        content: { hemoglobin: 99 },
        expectedVersion: draft.item.version,
        idempotencyKey: "security-second-active-draft"
      });
    } catch (error) {
      duplicateError = error;
    }

    expect.soft(duplicateError).toMatchObject({ code: "INVALID_STATE_TRANSITION", status: 409 });
    const state = context.store.getState();
    expect.soft(state.results.filter((result) => result.itemId === draft.item.id)).toHaveLength(1);
    expect.soft(state.resultVersions.filter((version) => version.resultId === draft.result.id)).toHaveLength(1);
    expect.soft(state.items.find((item) => item.id === draft.item.id)?.currentResultId).toBe(draft.result.id);
  });

  it("serializes concurrent draft creation into one canonical result", async () => {
    const context = setup();
    const { item } = await prepareHemogramItem(context);

    const attempts = await Promise.allSettled([
      context.service.createResultDraft(context.lab, item.id, {
        narrative: "Draft concorrente A.",
        content: { source: "A" },
        expectedVersion: item.version,
        idempotencyKey: "security-concurrent-draft-a"
      }),
      context.service.createResultDraft(context.lab, item.id, {
        narrative: "Draft concorrente B.",
        content: { source: "B" },
        expectedVersion: item.version,
        idempotencyKey: "security-concurrent-draft-b"
      })
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    const state = context.store.getState();
    expect(state.results.filter((result) => result.itemId === item.id)).toHaveLength(1);
    expect(state.resultVersions.filter((version) => version.resultId === state.results.find((result) => result.itemId === item.id)?.id)).toHaveLength(1);
  });

  it("creates a replacement version in the same logical result after void", async () => {
    const context = setup();
    const { draft } = await createHemogramDraft(context);
    const released = await context.service.releaseResult(context.lab, draft.result.id, {
      expectedVersion: draft.result.version,
      idempotencyKey: "security-replacement-release"
    });
    const voided = await context.service.voidResult(context.lab, released.result.id, {
      reason: "Substituição necessária",
      expectedVersion: released.result.version,
      idempotencyKey: "security-replacement-void"
    });

    const replacement = await context.service.createResultDraft(context.lab, voided.item.id, {
      narrative: "Resultado substituto em elaboração.",
      content: syntheticHemogramContent("Resultado substituto em elaboração."),
      expectedVersion: voided.item.version,
      idempotencyKey: "security-replacement-draft"
    });

    expect(replacement.result.id).toBe(draft.result.id);
    expect(replacement.version).toMatchObject({ resultId: draft.result.id, sequence: 2, status: "DRAFT" });
    expect(replacement.item).toMatchObject({ currentResultId: draft.result.id, status: "IN_PROGRESS" });
    const state = context.store.getState();
    expect(state.results.filter((result) => result.itemId === draft.item.id)).toHaveLength(1);
    expect(state.resultVersions.filter((version) => version.resultId === draft.result.id)).toHaveLength(2);
  });
});
