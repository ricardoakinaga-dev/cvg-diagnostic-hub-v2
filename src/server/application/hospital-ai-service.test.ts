import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHospitalAiService } from "./hospital-ai-service";
import { hospitalExternalFixture, externalConfig, EXTERNAL_NOW, rich } from "../../test/hospital-external-fixtures";
import { systemGroupId } from "../security/access-group-policy";
import type { HospitalAiDependencies } from "./hospital-ai-service";
import { ApiError } from "../http/envelope";
const instruction = { instruction: "Revisar clareza do texto operacional sintético", confirmTransmission: true as const, expectedVersion: 1, expectedDraftVersion: 1, idempotencyKey: "suggest" };
function setup(dependencies: HospitalAiDependencies = {}) { const c = hospitalExternalFixture(); const send = vi.fn().mockImplementation(async (_config, envelope) => ({ contract: "CVG_DOCUMENT_ASSISTANCE_V1", messageId: envelope.messageId, receiptId: "synthetic-provider-receipt", model: "synthetic-model", content: rich("Sugestão revisável") })); const service = createHospitalAiService(c.context, { config: () => ({ transport: externalConfig("HIS"), provider: "synthetic-provider", model: "synthetic-model", decisionReference: "synthetic-institutional-decision" }), send, ...dependencies }); return { ...c, assistance: service, send }; }
describe("optional human-reviewed operational text assistance", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(EXTERNAL_NOW); }); afterEach(() => vi.useRealTimers());
  it("defaults off and produces no synthetic delivery or suggestion when unconfigured", async () => {
    const c = setup({ config: () => undefined }); const doc = await c.document(); expect(await c.assistance.getHospitalAiCapability(c.user("user-admin"))).toMatchObject({ configured: false, reason: "CONFIGURATION_MISSING", deploymentVerified: false, requiresHumanReview: true }); await expect(c.assistance.suggestHospitalDocumentText(c.user("user-admin"), doc.document.id, instruction)).rejects.toMatchObject({ status: 503 }); expect(c.send).not.toHaveBeenCalled(); expect(c.store.getState().hospitalAiSuggestions).toHaveLength(0);
  });
  it("stores a pending suggestion with real receipt and applies only the confirmed draft revision without publishing", async () => {
    const c = setup(); const doc = await c.document(); const suggestion = await c.assistance.suggestHospitalDocumentText(c.user("user-admin"), doc.document.id, instruction); expect(suggestion).toMatchObject({ status: "PENDING_REVIEW", remoteReceiptId: "synthetic-provider-receipt", sourceDocumentVersion: 1, sourceDraftVersion: 1 }); expect(c.store.getState().hospitalDocuments[0].revisions[0].content).toEqual(rich("Original")); expect((await c.assistance.suggestHospitalDocumentText(c.user("user-admin"), doc.document.id, instruction)).id).toBe(suggestion.id); expect(c.send).toHaveBeenCalledTimes(1);
    const command = { decision: "APPLY" as const, confirm: true as const, reason: "Revisão humana sintética", expectedVersion: 1, expectedDocumentVersion: 1, expectedDraftVersion: 1, idempotencyKey: "apply" }; const applied = await c.assistance.reviewHospitalAiSuggestion(c.user("user-admin"), suggestion.id, command); expect(applied).toMatchObject({ status: "APPLIED", reviewedBy: "user-admin", appliedDocumentVersion: 2 }); expect(c.store.getState().hospitalDocuments[0].revisions[0]).toMatchObject({ status: "DRAFT", content: rich("Sugestão revisável") }); expect(c.store.getState().hospitalDocuments[0].currentPublishedRevisionId).toBeUndefined(); const after = c.store.getState(); expect((await c.assistance.reviewHospitalAiSuggestion(c.user("user-admin"), suggestion.id, command)).id).toBe(suggestion.id); expect(c.store.getState()).toEqual(after);
  });
  it("allows rejection without changing document content and requires explicit human confirmation", async () => {
    const c = setup(); const doc = await c.document(); await expect(c.assistance.suggestHospitalDocumentText(c.user("user-admin"), doc.document.id, { ...instruction, confirmTransmission: false } as unknown as typeof instruction)).rejects.toMatchObject({ status: 400 }); const suggestion = await c.assistance.suggestHospitalDocumentText(c.user("user-admin"), doc.document.id, instruction); const before = c.store.getState().hospitalDocuments;
    await c.assistance.reviewHospitalAiSuggestion(c.user("user-admin"), suggestion.id, { decision: "REJECT", confirm: true, reason: "Não adotar texto", expectedVersion: 1, expectedDocumentVersion: 1, expectedDraftVersion: 1, idempotencyKey: "reject" }); expect(c.store.getState().hospitalDocuments).toEqual(before); expect(c.store.getState().hospitalAiSuggestions[0].status).toBe("REJECTED");
  });
  it("refuses stale or changed source text even when an editor sends its current versions", async () => {
    const c = setup(); const doc = await c.document(); const suggestion = await c.assistance.suggestHospitalDocumentText(c.user("user-admin"), doc.document.id, instruction); await c.service.updateHospitalDocumentDraft(c.user("user-admin"), doc.document.id, { content: rich("Edição posterior"), expectedVersion: 1, expectedDraftVersion: 1, idempotencyKey: "later" }); const before = c.store.getState();
    await expect(c.assistance.reviewHospitalAiSuggestion(c.user("user-admin"), suggestion.id, { decision: "APPLY", confirm: true, reason: "Tentar sobrescrever", expectedVersion: 1, expectedDocumentVersion: 2, expectedDraftVersion: 2, idempotencyKey: "stale-source" })).rejects.toMatchObject({ code: "AI_SOURCE_CHANGED", status: 409 }); expect(c.store.getState()).toEqual(before);
  });
  it("revalidates grants after an in-flight provider response and before cached replay", async () => {
    const c = setup(); const doc = await c.document(); c.send.mockImplementationOnce(async (_config, envelope) => { await c.store.transaction(state => ({ state: { ...state, accessGroups: state.accessGroups.map(group => group.id === systemGroupId("ADMIN") ? { ...group, permissions: group.permissions.filter(permission => permission !== "hospital_document.update") } : group) }, result: undefined })); return { contract: "CVG_DOCUMENT_ASSISTANCE_V1", messageId: envelope.messageId, receiptId: "synthetic", model: "synthetic-model", content: rich("No access") }; }); await expect(c.assistance.suggestHospitalDocumentText(c.user("user-admin"), doc.document.id, instruction)).rejects.toMatchObject({ status: 404 }); expect(c.store.getState().hospitalAiSuggestions).toHaveLength(0);
  });
  it("rejects mismatched model, missing receipt and executable rich nodes without changing the draft", async () => {
    for (const failure of ["MODEL", "RECEIPT", "HTML"]) { const c = setup(); const doc = await c.document(); c.send.mockImplementationOnce(async (_config, envelope) => ({ contract: "CVG_DOCUMENT_ASSISTANCE_V1", messageId: envelope.messageId, receiptId: failure === "RECEIPT" ? "" : "synthetic", model: failure === "MODEL" ? "different-model" : "synthetic-model", content: failure === "HTML" ? { type: "hospital-document", version: 1, blocks: [{ type: "html", html: "<script>unsafe</script>" }] } : rich("Suggestion") })); const before = c.store.getState(); await expect(c.assistance.suggestHospitalDocumentText(c.user("user-admin"), doc.document.id, instruction)).rejects.toMatchObject({ status: 502 }); expect(c.store.getState().hospitalDocuments).toEqual(before.hospitalDocuments); expect(c.store.getState().hospitalAiSuggestions).toHaveLength(0); }
  });
  it("serializes competing reviewers and keeps provider text out of audit events", async () => {
    const c = setup(); const doc = await c.document(); const suggestion = await c.assistance.suggestHospitalDocumentText(c.user("user-admin"), doc.document.id, instruction); const outcomes = await Promise.allSettled(["a", "b"].map(key => c.assistance.reviewHospitalAiSuggestion(c.user("user-admin"), suggestion.id, { decision: "APPLY", confirm: true, reason: "Synthetic human review", expectedVersion: 1, expectedDocumentVersion: 1, expectedDraftVersion: 1, idempotencyKey: key }))); expect(outcomes.filter(entry => entry.status === "fulfilled")).toHaveLength(1); expect(JSON.stringify(c.store.getState().auditEvents)).not.toContain("Sugestão revisável");
  });
  it("durably claims the provider request and refuses concurrent or changed content under its idempotency key", async () => {
    const c = setup(); const doc = await c.document(); let signal!: () => void; const entered = new Promise<void>(resolve => { signal = resolve; }); let fail!: (error: Error) => void;
    c.send.mockImplementationOnce(async () => { signal(); return new Promise((_resolve, reject) => { fail = reject; }); });
    const pending = c.assistance.suggestHospitalDocumentText(c.user("user-admin"), doc.document.id, instruction); await entered;
    await expect(c.assistance.suggestHospitalDocumentText(c.user("user-admin"), doc.document.id, instruction)).rejects.toMatchObject({ code: "AI_REQUEST_IN_PROGRESS", status: 409 });
    await expect(c.assistance.suggestHospitalDocumentText(c.user("user-admin"), doc.document.id, { ...instruction, instruction: "Different request" })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED", status: 409 }); expect(c.send).toHaveBeenCalledTimes(1);
    fail(new Error("Disposable provider failure")); await expect(pending).rejects.toMatchObject({ code: "AI_PROVIDER_UNAVAILABLE" }); const retried = await c.assistance.suggestHospitalDocumentText(c.user("user-admin"), doc.document.id, instruction); expect(retried.status).toBe("PENDING_REVIEW"); expect(c.send.mock.calls[0][1].messageId).toBe(c.send.mock.calls[1][1].messageId);
  });

  it("returns one cached suggestion when another request finishes between the initial read and claim", async () => {
    const c = setup(); const doc = await c.document(); const read = c.store.readState.bind(c.store); let concurrentId: string | undefined;
    vi.spyOn(c.store, "readState").mockImplementationOnce(async () => {
      const earlier = await read(); const completed = await c.assistance.suggestHospitalDocumentText(c.user("user-admin"), doc.document.id, instruction); concurrentId = completed.id; return earlier;
    });
    const replay = await c.assistance.suggestHospitalDocumentText(c.user("user-admin"), doc.document.id, instruction);
    expect(replay.id).toBe(concurrentId); expect(c.send).toHaveBeenCalledTimes(1); expect(c.store.getState().hospitalAiSuggestions).toHaveLength(1);
  });

  it("keeps the newer receipt when a replaced expired claim receives its late response", async () => {
    const c = setup(); const doc = await c.document(); let entered!: () => void; let finish!: (value: unknown) => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    c.send.mockImplementationOnce(async (_config, envelope) => { entered(); return new Promise(resolve => { finish = value => resolve({ contract: "CVG_DOCUMENT_ASSISTANCE_V1", messageId: envelope.messageId, receiptId: value, model: "synthetic-model", content: rich("Late suggestion") }); }); });
    const old = c.assistance.suggestHospitalDocumentText(c.user("user-admin"), doc.document.id, instruction); await started;
    vi.setSystemTime(Date.parse(EXTERNAL_NOW) + 120_001); const newer = await c.assistance.suggestHospitalDocumentText(c.user("user-admin"), doc.document.id, instruction); const beforeLate = c.store.getState();
    finish("late-old-receipt"); expect((await old).id).toBe(newer.id); expect(c.store.getState()).toEqual(beforeLate); expect(c.store.getState().hospitalAiSuggestions).toHaveLength(1); expect(c.send).toHaveBeenCalledTimes(2);
  });

  it("reports invalid provider configuration and preserves a provider's safe failure without altering the draft", async () => {
    const c = setup({ config: () => ({ transport: externalConfig("HIS"), provider: "", model: "synthetic-model", decisionReference: "synthetic-decision" }) }); const doc = await c.document();
    expect(await c.assistance.getHospitalAiCapability(c.user("user-admin"))).toMatchObject({ configured: false, reason: "CONFIGURATION_INVALID", deploymentVerified: false });
    await expect(c.assistance.suggestHospitalDocumentText(c.user("user-admin"), doc.document.id, instruction)).rejects.toMatchObject({ code: "AI_CONFIGURATION_INVALID", status: 503 }); expect(c.send).not.toHaveBeenCalled();
    const d = setup(); const other = await d.document(); d.send.mockRejectedValueOnce(new ApiError("AI_PROVIDER_RATE_LIMITED", "Provedor indisponível", 502)); const before = d.store.getState().hospitalDocuments;
    await expect(d.assistance.suggestHospitalDocumentText(d.user("user-admin"), other.document.id, instruction)).rejects.toMatchObject({ code: "AI_PROVIDER_RATE_LIMITED", status: 502 }); expect(d.store.getState().hospitalDocuments).toEqual(before);
    expect((await d.assistance.suggestHospitalDocumentText(d.user("user-admin"), other.document.id, instruction)).status).toBe("PENDING_REVIEW");
  });

  it("lists reviewable suggestions only for the selected currently authorized document", async () => {
    const c = setup(); const doc = await c.document(); const suggestion = await c.assistance.suggestHospitalDocumentText(c.user("user-admin"), doc.document.id, instruction);
    const other = await c.service.createHospitalDocument(c.user("user-admin"), { code: "OTHER_ASSISTANCE_DOC", title: "Outro documento sintético", departmentCode: "INPATIENT", responsibleUserId: "user-vet", content: rich("Outro texto"), idempotencyKey: "other-doc" });
    expect(await c.assistance.listHospitalAiSuggestions(c.user("user-admin"), doc.document.id)).toEqual([suggestion]); expect(await c.assistance.listHospitalAiSuggestions(c.user("user-admin"), other.document.id)).toEqual([]);
    await c.store.transaction(state => ({ state: { ...state, accessGroups: state.accessGroups.map(group => group.id === systemGroupId("ADMIN") ? { ...group, permissions: group.permissions.filter(permission => permission !== "hospital_document.view") } : group) }, result: undefined }));
    await expect(c.assistance.listHospitalAiSuggestions(c.user("user-admin"), doc.document.id)).rejects.toMatchObject({ status: 404 });
  });

});
