import { describe, expect, it } from "vitest";
import { createApplicationService } from "./service";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { InProcessEventBus, processOutboxBatch } from "../operations/outbox";

describe("server-side validation and conflict branches", () => {
  it("rejects malformed request context and unsafe idempotency reuse", async () => {
    const store = new MemoryStore(createDemoState());
    const service = createApplicationService(store);
    const vet = store.getState().users.find((user) => user.email === "vet@cvg.local");
    if (!vet) throw new Error("fixture actor missing");
    await expect(service.createRequest(vet, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [] }, { idempotencyKey: "invalid-empty" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(service.createRequest(vet, { patientId: "patient-thor", encounterId: "encounter-mel", priority: "ROUTINE", items: [{ serviceId: "service-hemogram" }] }, { idempotencyKey: "invalid-encounter" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(service.createRequest(vet, { patientId: "patient-thor", encounterId: "encounter-thor", admissionId: "admission-missing", priority: "ROUTINE", items: [{ serviceId: "service-hemogram" }] }, { idempotencyKey: "invalid-admission" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(service.createRequest(vet, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-hemogram" }] }, { idempotencyKey: "invalid-service" })).resolves.toBeTruthy();
    await expect(service.createRequest(vet, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-crp" }] }, { idempotencyKey: "invalid-service" })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    await expect(service.createRequest(vet, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-xray", note: "x".repeat(2001) }] }, { idempotencyKey: "invalid-note" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(service.createRequest(vet, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-xray" }], overrideReason: "" }, { idempotencyKey: "invalid-override", allowDuplicateOverride: true })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(service.getRequest(vet, "request-missing")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects invalid operational phases, roles, reasons and schedule windows", async () => {
    const store = new MemoryStore(createDemoState());
    const service = createApplicationService(store);
    const vet = store.getState().users.find((user) => user.email === "vet@cvg.local");
    const lab = store.getState().users.find((user) => user.email === "lab@cvg.local");
    const us = store.getState().users.find((user) => user.email === "us@cvg.local");
    if (!vet || !lab || !us) throw new Error("fixture actors missing");
    const labRequest = await service.createRequest(vet, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-hemogram" }] }, { idempotencyKey: "error-lab-request" });
    await expect(service.receiveSample(vet, [labRequest.items[0].id], { accessionCode: "ACC-UNAUTHORIZED", sampleType: "EDTA", expectedVersion: labRequest.items[0].version, idempotencyKey: "unauthorized-sample" })).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    await expect(service.receiveSample(lab, [], { accessionCode: "ACC-ERR", sampleType: "EDTA", expectedVersion: labRequest.items[0].version })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(service.requestRecollection(lab, "sample-missing", { reasonCode: "HEMOLYZED", expectedVersion: labRequest.items[0].version, idempotencyKey: "missing-recollect" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(service.createResultDraft(lab, labRequest.items[0].id, { narrative: "Ainda não", content: {}, expectedVersion: labRequest.items[0].version })).rejects.toMatchObject({ code: "RESULT_RELEASE_BLOCKED" });
    await expect(service.cancelItem(vet, labRequest.items[0].id, { reasonCode: "MISSING_REASON", expectedVersion: labRequest.items[0].version, idempotencyKey: "missing-cancel" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(service.rejectItem(lab, labRequest.items[0].id, { reasonCode: "MISSING_REASON", expectedVersion: labRequest.items[0].version, idempotencyKey: "missing-reject" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(service.timeline(vet)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(service.listQueue(vet, "LABORATORY")).rejects.toMatchObject({ code: "NOT_FOUND" });

    const usRequest = await service.createRequest(vet, { patientId: "patient-mel", encounterId: "encounter-mel", priority: "ROUTINE", items: [{ serviceId: "service-ultrasound" }] }, { idempotencyKey: "error-us-request" });
    await expect(service.timeline(vet, labRequest.id, usRequest.items[0].id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(service.scheduleProcedure(us, usRequest.items[0].id, { startsAt: "bad", endsAt: "also-bad", resource: "US-ERR", expectedVersion: usRequest.items[0].version })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(service.scheduleProcedure(us, usRequest.items[0].id, { startsAt: "2026-08-25T10:00:00.000Z", endsAt: "2026-08-27T11:00:00.000Z", resource: "US-ERR", expectedVersion: usRequest.items[0].version })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("covers retries, sample conflicts and replacement guards", async () => {
    const store = new MemoryStore(createDemoState());
    const service = createApplicationService(store);
    const vet = store.getState().users.find((user) => user.email === "vet@cvg.local");
    const lab = store.getState().users.find((user) => user.email === "lab@cvg.local");
    const rx = store.getState().users.find((user) => user.email === "rx@cvg.local");
    if (!vet || !lab || !rx) throw new Error("fixture actors missing");
    const input = { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE" as const, items: [{ serviceId: "service-hemogram" }] };
    const first = await service.createRequest(vet, input, { idempotencyKey: "retry-request" });
    expect((await service.createRequest(vet, input, { idempotencyKey: "retry-request" })).id).toBe(first.id);
    await expect(service.createRequest({ ...vet, id: "inactive-user" }, input)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect((await service.getRequest(lab, first.id)).id).toBe(first.id);
    await expect(service.getRequest(rx, first.id)).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    await expect(service.receiveSample(lab, [first.items[0].id], { accessionCode: "bad", sampleType: "EDTA", expectedVersion: first.items[0].version })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const received = await service.receiveSample(lab, [first.items[0].id], { accessionCode: "ACC-RETRY-1", sampleType: "EDTA", expectedVersion: first.items[0].version, idempotencyKey: "retry-sample" });
    expect((await service.receiveSample(lab, [first.items[0].id], { accessionCode: "ACC-RETRY-1", sampleType: "EDTA", expectedVersion: first.items[0].version, idempotencyKey: "retry-sample" })).sample.id).toBe(received.sample.id);
    await expect(service.receiveSample(lab, [first.items[0].id], { accessionCode: "ACC-RETRY-2", sampleType: "EDTA", expectedVersion: received.items[0].version, idempotencyKey: "retry-sample-new" })).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    await expect(service.requestRecollection(lab, received.sample.id, { reasonCode: "MISSING_REASON", expectedVersion: received.items[0].version, idempotencyKey: "bad-recollect" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const recollection = await service.requestRecollection(lab, received.sample.id, { reasonCode: "HEMOLYZED", expectedVersion: received.items[0].version, idempotencyKey: "retry-recollect" });
    expect((await service.requestRecollection(lab, received.sample.id, { reasonCode: "HEMOLYZED", expectedVersion: received.items[0].version, idempotencyKey: "retry-recollect" })).replacement.id).toBe(recollection.replacement.id);
    const replacement = await service.receiveReplacement(lab, recollection.replacement.id, { accessionCode: "ACC-RETRY-2", sampleType: "EDTA", expectedVersion: recollection.items[0].version, idempotencyKey: "retry-replacement" });
    expect((await service.receiveReplacement(lab, recollection.replacement.id, { accessionCode: "ACC-RETRY-2", sampleType: "EDTA", expectedVersion: recollection.items[0].version, idempotencyKey: "retry-replacement" })).sample.id).toBe(replacement.sample.id);
    await expect(service.receiveReplacement(lab, recollection.replacement.id, { accessionCode: "ACC-RETRY-3", sampleType: "EDTA", expectedVersion: replacement.items[0].version, idempotencyKey: "retry-replacement-new" })).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    const started = await service.startProcessing(lab, first.items[0].id, { expectedVersion: replacement.items[0].version, idempotencyKey: "retry-processing" });
    expect((await service.startProcessing(lab, first.items[0].id, { expectedVersion: replacement.items[0].version, idempotencyKey: "retry-processing" })).item.id).toBe(started.item.id);
    await expect(service.startProcessing(lab, first.items[0].id, { expectedVersion: 1, idempotencyKey: "stale-processing" })).rejects.toMatchObject({ code: "STALE_VERSION" });
  });

  it("covers critical release policy and result visibility guards", async () => {
    const store = new MemoryStore(createDemoState());
    const service = createApplicationService(store);
    const vet = store.getState().users.find((user) => user.email === "vet@cvg.local");
    const lab = store.getState().users.find((user) => user.email === "lab@cvg.local");
    if (!vet || !lab) throw new Error("fixture actors missing");
    const request = await service.createRequest(vet, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-crp" }] }, { idempotencyKey: "critical-request" });
    const received = await service.receiveSample(lab, [request.items[0].id], { accessionCode: "ACC-CRITICAL-1", sampleType: "EDTA", expectedVersion: request.items[0].version, idempotencyKey: "critical-receive" });
    const started = await service.startProcessing(lab, request.items[0].id, { expectedVersion: received.items[0].version, idempotencyKey: "critical-start" });
    const draft = await service.createResultDraft(lab, request.items[0].id, { narrative: "Resultado sensível.", content: {}, conclusion: "Necessita avaliação", expectedVersion: started.item.version, idempotencyKey: "critical-draft" });
    await expect(service.releaseResult(lab, draft.result.id, { critical: true, expectedVersion: draft.result.version, idempotencyKey: "critical-release" })).rejects.toMatchObject({ code: "CRITICAL_POLICY_MISSING" });
    const previousPolicyFlag = process.env.CRITICAL_POLICY_ENABLED;
    const previousPolicyVersion = process.env.CRITICAL_POLICY_VERSION;
    const previousPolicyApprovalRef = process.env.CRITICAL_POLICY_APPROVAL_REF;
    const previousPolicyApprovedAt = process.env.CRITICAL_POLICY_APPROVED_AT;
    process.env.CRITICAL_POLICY_ENABLED = "true";
    try {
      await expect(service.releaseResult(lab, draft.result.id, { critical: true, expectedVersion: draft.result.version, idempotencyKey: "critical-release-bare-flag" })).rejects.toMatchObject({ code: "CRITICAL_POLICY_MISSING" });
      await expect(service.viewResult(vet, draft.version.id, { expectedVersion: draft.item.version, idempotencyKey: "draft-view" })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(service.reviewResult(vet, draft.result.id, { versionId: draft.version.id, expectedVersion: draft.item.version, idempotencyKey: "draft-review" })).rejects.toMatchObject({ code: "REVIEW_STALE" });
      await expect(service.amendResult(lab, draft.result.id, { reason: "Ainda draft", narrative: "Nova versão", content: {}, expectedVersion: draft.result.version, idempotencyKey: "draft-amend" })).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
      await expect(service.voidResult(lab, draft.result.id, { reason: "Ainda draft", expectedVersion: draft.result.version, idempotencyKey: "draft-void" })).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
      process.env.CRITICAL_POLICY_VERSION = "policy-v1";
      process.env.CRITICAL_POLICY_APPROVAL_REF = "approval-test-1";
      process.env.CRITICAL_POLICY_APPROVED_AT = "2026-08-20T10:00:00.000Z";
      const released = await service.releaseResult(lab, draft.result.id, { critical: true, expectedVersion: draft.result.version, idempotencyKey: "critical-release-approved" });
      expect(released.version).toMatchObject({ status: "RELEASED", critical: true });
      expect(store.getState().notifications).toContainEqual(expect.objectContaining({ category: "CRITICAL", entityId: released.version.id }));
      await service.viewResult(vet, released.version.id, { expectedVersion: released.item.version, idempotencyKey: "critical-view" });
      await expect(service.reviewResult(vet, released.result.id, { versionId: released.version.id, expectedVersion: released.item.version, idempotencyKey: "critical-review-before-ack" })).rejects.toMatchObject({ code: "CRITICAL_ACK_REQUIRED", status: 409 });
      const criticalNotification = store.getState().notifications.find((notification) => notification.category === "CRITICAL" && notification.entityId === released.version.id);
      if (!criticalNotification) throw new Error("critical notification missing");
      await processOutboxBatch(store, new InProcessEventBus(), { now: () => new Date(Date.now() + 1_000), batchSize: 50 });
      const deliveredCriticalNotification = store.getState().notifications.find((notification) => notification.id === criticalNotification.id);
      if (!deliveredCriticalNotification) throw new Error("critical notification delivery missing");
      await service.acknowledgeNotification(vet, deliveredCriticalNotification.id, { expectedVersion: deliveredCriticalNotification.version, reason: "Confirmei a comunicação crítica.", confirm: true, idempotencyKey: "critical-ack" });
      await expect(service.reviewResult(vet, released.result.id, { versionId: released.version.id, expectedVersion: released.item.version, idempotencyKey: "critical-review-after-ack" })).resolves.toMatchObject({ item: { status: "REVIEWED" } });
    } finally {
      if (previousPolicyFlag === undefined) delete process.env.CRITICAL_POLICY_ENABLED;
      else process.env.CRITICAL_POLICY_ENABLED = previousPolicyFlag;
      if (previousPolicyVersion === undefined) delete process.env.CRITICAL_POLICY_VERSION;
      else process.env.CRITICAL_POLICY_VERSION = previousPolicyVersion;
      if (previousPolicyApprovalRef === undefined) delete process.env.CRITICAL_POLICY_APPROVAL_REF;
      else process.env.CRITICAL_POLICY_APPROVAL_REF = previousPolicyApprovalRef;
      if (previousPolicyApprovedAt === undefined) delete process.env.CRITICAL_POLICY_APPROVED_AT;
      else process.env.CRITICAL_POLICY_APPROVED_AT = previousPolicyApprovedAt;
    }
  });

  it("supersedes an unacknowledged critical notification when its version is amended", async () => {
    const store = new MemoryStore(createDemoState());
    const service = createApplicationService(store);
    const vet = store.getState().users.find((user) => user.email === "vet@cvg.local");
    const lab = store.getState().users.find((user) => user.email === "lab@cvg.local");
    if (!vet || !lab) throw new Error("fixture actors missing");
    const previous = {
      enabled: process.env.CRITICAL_POLICY_ENABLED,
      version: process.env.CRITICAL_POLICY_VERSION,
      approval: process.env.CRITICAL_POLICY_APPROVAL_REF,
      approvedAt: process.env.CRITICAL_POLICY_APPROVED_AT
    };
    process.env.CRITICAL_POLICY_ENABLED = "true";
    process.env.CRITICAL_POLICY_VERSION = "policy-stale-test";
    process.env.CRITICAL_POLICY_APPROVAL_REF = "approval-stale-test";
    process.env.CRITICAL_POLICY_APPROVED_AT = "2026-08-20T10:00:00.000Z";
    try {
      const request = await service.createRequest(vet, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-hemogram" }] }, { idempotencyKey: "stale-critical-request" });
      const received = await service.receiveSample(lab, [request.items[0].id], { accessionCode: "ACC-STALE-CRITICAL", sampleType: "EDTA", expectedVersion: request.items[0].version, idempotencyKey: "stale-critical-receive" });
      const started = await service.startProcessing(lab, request.items[0].id, { expectedVersion: received.items[0].version, idempotencyKey: "stale-critical-start" });
      const draft = await service.createResultDraft(lab, request.items[0].id, { narrative: "Crítico antes da emenda.", content: {}, expectedVersion: started.item.version, idempotencyKey: "stale-critical-draft" });
      const released = await service.releaseResult(lab, draft.result.id, { critical: true, expectedVersion: draft.result.version, idempotencyKey: "stale-critical-release" });
      await processOutboxBatch(store, new InProcessEventBus(), { now: () => new Date(Date.now() + 1_000), batchSize: 50 });
      const notification = store.getState().notifications.find((entry) => entry.category === "CRITICAL" && entry.entityId === released.version.id);
      if (!notification) throw new Error("critical notification missing");
      const amended = await service.amendResult(lab, released.result.id, { reason: "Atualização clínica controlada.", narrative: "Nova interpretação após revisão.", content: {}, expectedVersion: released.result.version, idempotencyKey: "stale-critical-amend" });
      expect(amended.version.status).toBe("DRAFT");
      const superseded = store.getState().notifications.find((entry) => entry.id === notification.id);
      expect(superseded).toMatchObject({ state: "SUPERSEDED", version: notification.version + 1 });
      await expect(service.acknowledgeNotification(vet, notification.id, { expectedVersion: superseded!.version, reason: "Tentativa obsoleta", confirm: true, idempotencyKey: "stale-critical-ack" })).rejects.toMatchObject({ code: "NOTIFICATION_STALE", status: 409 });
    } finally {
      if (previous.enabled === undefined) delete process.env.CRITICAL_POLICY_ENABLED; else process.env.CRITICAL_POLICY_ENABLED = previous.enabled;
      if (previous.version === undefined) delete process.env.CRITICAL_POLICY_VERSION; else process.env.CRITICAL_POLICY_VERSION = previous.version;
      if (previous.approval === undefined) delete process.env.CRITICAL_POLICY_APPROVAL_REF; else process.env.CRITICAL_POLICY_APPROVAL_REF = previous.approval;
      if (previous.approvedAt === undefined) delete process.env.CRITICAL_POLICY_APPROVED_AT; else process.env.CRITICAL_POLICY_APPROVED_AT = previous.approvedAt;
    }
  });
});
