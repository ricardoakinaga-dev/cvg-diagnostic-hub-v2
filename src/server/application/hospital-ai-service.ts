import type { HospitalAiCapability, HospitalAiSuggestion } from "@cvg/contracts";
import type { User } from "../domain/models";
import type { ApplicationServiceContext } from "./service-context";
import { ApiError } from "../http/envelope";
import { hospitalAiSuggestSchema, hospitalAiReviewSchema, hospitalAiRemoteResponseSchema, type HospitalAiSuggestInput, type HospitalAiReviewInput } from "../http/hospital-ai-schemas";
import { existingHospitalDocument, requireEditableHospitalDocument } from "./hospital-document-policy";
import { currentDocumentDraft, parseDocumentCommand } from "./hospital-document-common";
import { createHospitalDocumentDraftService } from "./hospital-document-draft-service";
import { integrationDigest } from "./hospital-integration-policy";
import { hospitalAiHttpConfigFromEnv, sendHospitalAiHttp, type HospitalAiHttpConfig } from "./hospital-ai-http";
import { createAudit, ensureExpectedVersion, id, now, requireActiveUser, requireIdempotencyKey, requirePermission, saveIdempotency, withIdempotency } from "./service-common";
import { transactionalServiceContext } from "./transactional-service-context";
import { validateHospitalIntegrationHttpConfig } from "./hospital-integration-http";
export interface HospitalAiDependencies { config?: () => HospitalAiHttpConfig | undefined; send?: typeof sendHospitalAiHttp }
export function createHospitalAiService(context: ApplicationServiceContext, dependencies: HospitalAiDependencies = {}) {
  const loader = dependencies.config ?? hospitalAiHttpConfigFromEnv; const send = dependencies.send ?? sendHospitalAiHttp;
  function configured() { let config: HospitalAiHttpConfig | undefined; try { config = loader(); if (config) { validateHospitalIntegrationHttpConfig(config.transport); if (!config.provider || !config.model || !config.decisionReference) throw new Error(); } } catch { throw new ApiError("AI_CONFIGURATION_INVALID", "A assistência não possui configuração aprovada válida.", 503); } if (!config) throw new ApiError("AI_NOT_CONFIGURED", "A assistência está desativada até configurar provedor, finalidade e decisão institucional.", 503); return config; }
  return {
    async getHospitalAiCapability(actor: User): Promise<HospitalAiCapability> {
      const state = await context.store.readState(); const current = requireActiveUser(state, actor); requirePermission(current, "hospital_document.update", {});
      const base = { purpose: "OPERATIONAL_DOCUMENT_TEXT" as const, deploymentVerified: false as const, requiresHumanReview: true as const };
      try { const config = configured(); return { ...base, configured: true, provider: config.provider, model: config.model, decisionReference: config.decisionReference }; } catch (error) { return { ...base, configured: false, reason: error instanceof ApiError && error.code === "AI_NOT_CONFIGURED" ? "CONFIGURATION_MISSING" : "CONFIGURATION_INVALID" }; }
    },
    async listHospitalAiSuggestions(actor: User, documentId: string): Promise<HospitalAiSuggestion[]> {
      const state = await context.store.readState(); const current = requireActiveUser(state, actor); existingHospitalDocument(state, current, documentId, "hospital_document.view"); return structuredClone(state.hospitalAiSuggestions.filter((entry) => entry.documentId === documentId));
    },
    async suggestHospitalDocumentText(actor: User, documentId: string, input: HospitalAiSuggestInput): Promise<HospitalAiSuggestion> {
      const body = parseDocumentCommand(hospitalAiSuggestSchema, input); requireIdempotencyKey(input.idempotencyKey); const config = configured(); const scope = `POST:/hospital-documents/${documentId}/assistance`;
      const state = await context.store.readState(); const current = requireActiveUser(state, actor); const document = existingHospitalDocument(state, current, documentId, "hospital_document.update"); existingHospitalDocument(state, current, documentId, "hospital_document.view"); requireEditableHospitalDocument(document);
      const replay = withIdempotency<{ id?: string; leaseUntil?: string; claimId?: string }>(state, current.id, scope, input.idempotencyKey, { input }); if (replay.found && replay.existing?.id) return structuredClone(state.hospitalAiSuggestions.find((entry) => entry.id === replay.existing!.id)!);
      const draft = currentDocumentDraft(document); ensureExpectedVersion(document.version, body.expectedVersion); ensureExpectedVersion(draft.version, body.expectedDraftVersion);
      const messageId = `ai:${integrationDigest({ actorId: current.id, documentId, key: input.idempotencyKey })}`;
      const claimId = id("ai-claim");
      const claimed = await context.store.transaction<{ cached?: HospitalAiSuggestion }>((latest) => {
        const fresh = requireActiveUser(latest, actor); const source = existingHospitalDocument(latest, fresh, documentId, "hospital_document.update"); existingHospitalDocument(latest, fresh, documentId, "hospital_document.view"); requireEditableHospitalDocument(source);
        const replay = withIdempotency<{ id?: string; leaseUntil?: string; claimId?: string }>(latest, fresh.id, scope, input.idempotencyKey, { input });
        if (replay.found && replay.existing?.id) return { state: latest, result: { cached: structuredClone(latest.hospitalAiSuggestions.find((entry) => entry.id === replay.existing!.id)!) } };
        if (replay.existing?.leaseUntil && Date.parse(replay.existing.leaseUntil) > Date.now()) throw new ApiError("AI_REQUEST_IN_PROGRESS", "A solicitação anterior ainda está em processamento.", 409);
        const currentDraft = currentDocumentDraft(source); ensureExpectedVersion(source.version, body.expectedVersion); ensureExpectedVersion(currentDraft.version, body.expectedDraftVersion);
        if (currentDraft.id !== draft.id || integrationDigest(currentDraft.content) !== integrationDigest(draft.content)) throw new ApiError("AI_SOURCE_CHANGED", "A origem mudou antes de transmitir.", 409);
        return { state: saveIdempotency(latest, fresh.id, scope, input.idempotencyKey, { claimId, leaseUntil: new Date(Date.now() + 120_000).toISOString() }, { input }), result: {} };
      });
      if (claimed.cached) return claimed.cached;
      async function releaseClaim() { await context.store.transaction((latest) => { const replay = withIdempotency<{ id?: string; claimId?: string }>(latest, current.id, scope, input.idempotencyKey, { input }); return { state: replay.existing?.claimId === claimId && !replay.existing.id ? saveIdempotency(latest, current.id, scope, input.idempotencyKey, { leaseUntil: new Date(0).toISOString() }, { input }) : latest, result: undefined }; }); }
      let response: Awaited<ReturnType<typeof sendHospitalAiHttp>>; try { response = await send(config, { contract: "CVG_DOCUMENT_ASSISTANCE_V1", messageId, purpose: "OPERATIONAL_DOCUMENT_TEXT", model: config.model, instruction: body.instruction, content: draft.content }); } catch (error) { await releaseClaim(); if (error instanceof ApiError) throw error; throw new ApiError("AI_PROVIDER_UNAVAILABLE", "O provedor não retornou uma sugestão válida; nenhuma alteração foi aplicada.", 502); }
      const parsed = hospitalAiRemoteResponseSchema.safeParse(response); if (!parsed.success || parsed.data.messageId !== messageId || parsed.data.model !== config.model) { await releaseClaim(); throw new ApiError("AI_RESPONSE_INVALID", "O recibo, modelo ou conteúdo não corresponde ao contrato configurado.", 502); }
      return context.store.transaction((latest) => {
        const fresh = requireActiveUser(latest, actor); const currentDocument = existingHospitalDocument(latest, fresh, documentId, "hospital_document.update"); existingHospitalDocument(latest, fresh, documentId, "hospital_document.view"); requireEditableHospitalDocument(currentDocument);
        const replay = withIdempotency<{ id?: string; leaseUntil?: string; claimId?: string }>(latest, fresh.id, scope, input.idempotencyKey, { input }); if (replay.found && replay.existing?.id) return { state: latest, result: structuredClone(latest.hospitalAiSuggestions.find((entry) => entry.id === replay.existing!.id)!) };
        if (replay.existing?.claimId !== claimId) throw new ApiError("AI_CLAIM_CHANGED", "A solicitação foi retomada por outro comando; consulte a sugestão atual.", 409);
        const currentDraft = currentDocumentDraft(currentDocument); ensureExpectedVersion(currentDocument.version, body.expectedVersion); ensureExpectedVersion(currentDraft.version, body.expectedDraftVersion);
        if (currentDraft.id !== draft.id || integrationDigest(currentDraft.content) !== integrationDigest(draft.content)) throw new ApiError("AI_SOURCE_CHANGED", "O texto mudou durante a assistência; revise a versão atual antes de solicitar novamente.", 409);
        const suggestion: HospitalAiSuggestion = { id: id("ai-suggestion"), documentId, draftRevisionId: draft.id, sourceDocumentVersion: document.version, sourceDraftVersion: draft.version, sourceContentHash: integrationDigest(draft.content), requestedBy: fresh.id, createdAt: now(), provider: config.provider, model: config.model, remoteReceiptId: parsed.data.receiptId, content: structuredClone(parsed.data.content), status: "PENDING_REVIEW", version: 1 };
        const next = { ...latest, hospitalAiSuggestions: [...latest.hospitalAiSuggestions, suggestion], auditEvents: [...latest.auditEvents, createAudit("HospitalAiSuggestionReceived", fresh.id, "HospitalDocument", documentId, input.correlationId ?? id("corr"), undefined, "PENDING_REVIEW", { suggestionId: suggestion.id, provider: config.provider, model: config.model, decisionReference: config.decisionReference, remoteReceiptId: suggestion.remoteReceiptId, sourceDocumentVersion: document.version, sourceDraftVersion: draft.version })] };
        return { state: saveIdempotency(next, fresh.id, scope, input.idempotencyKey, { id: suggestion.id }, { input }), result: suggestion };
      });
    },
    async reviewHospitalAiSuggestion(actor: User, suggestionId: string, input: HospitalAiReviewInput): Promise<HospitalAiSuggestion> {
      return context.store.transaction(async (state, audit) => {
        const current = requireActiveUser(state, actor); const previous = state.hospitalAiSuggestions.find((entry) => entry.id === suggestionId); if (!previous) throw new ApiError("NOT_FOUND", "Sugestão indisponível.", 404);
        const document = existingHospitalDocument(state, current, previous.documentId, "hospital_document.update"); existingHospitalDocument(state, current, document.id, "hospital_document.view"); const body = parseDocumentCommand(hospitalAiReviewSchema, input); requireIdempotencyKey(input.idempotencyKey); const scope = `POST:/hospital-assistance/${suggestionId}/review`; const replay = withIdempotency(state, current.id, scope, input.idempotencyKey, { input }); if (replay.found) return { state, result: structuredClone(previous) };
        ensureExpectedVersion(previous.version, body.expectedVersion); ensureExpectedVersion(document.version, body.expectedDocumentVersion); const draft = currentDocumentDraft(document); ensureExpectedVersion(draft.version, body.expectedDraftVersion); if (previous.status !== "PENDING_REVIEW") throw new ApiError("INVALID_STATE_TRANSITION", "A sugestão já foi revisada.", 409);
        const tx = transactionalServiceContext(context, state, audit); let appliedDocumentVersion: number | undefined;
        if (body.decision === "APPLY") {
          requireEditableHospitalDocument(document);
          if (draft.id !== previous.draftRevisionId || draft.version !== previous.sourceDraftVersion || document.version !== previous.sourceDocumentVersion || integrationDigest(draft.content) !== previous.sourceContentHash) throw new ApiError("AI_SOURCE_CHANGED", "O rascunho mudou; a sugestão não pode sobrescrever a revisão atual.", 409);
          const changed = await createHospitalDocumentDraftService(tx.context).updateHospitalDocumentDraft(current, document.id, { content: previous.content, expectedVersion: document.version, expectedDraftVersion: draft.version, idempotencyKey: `ai-review:${suggestionId}:${input.idempotencyKey}`, correlationId: input.correlationId }); appliedDocumentVersion = changed.document.version;
        }
        const updated: HospitalAiSuggestion = { ...previous, status: body.decision === "APPLY" ? "APPLIED" : "REJECTED", reviewedBy: current.id, reviewedAt: now(), reviewReason: body.reason, appliedDocumentVersion, version: previous.version + 1 }; const changed = tx.state(); const next = { ...changed, hospitalAiSuggestions: changed.hospitalAiSuggestions.map((entry) => entry.id === suggestionId ? updated : entry), auditEvents: [...changed.auditEvents, createAudit("HospitalAiSuggestionReviewed", current.id, "HospitalDocument", document.id, input.correlationId ?? id("corr"), "PENDING_REVIEW", updated.status, { suggestionId, reason: body.reason, appliedDocumentVersion: appliedDocumentVersion ?? null, clinicalApproval: false })] };
        return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, { id: suggestionId }, { input }), result: updated };
      });
    }
  };
}
