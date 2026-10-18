import type { HospitalIntegrationMessage, HospitalIntegrationReceipt, HospitalIntegrationSystem } from "@cvg/contracts";
import type { StoreState, User } from "../domain/models";
import type { ApplicationServiceContext } from "./service-context";
import { ApiError } from "../http/envelope";
import { hospitalIntegrationExchangeSchema, hospitalIntegrationFiltersSchema, hospitalIntegrationRetrySchema, type HospitalIntegrationExchangeInput, type HospitalIntegrationFilters, type HospitalIntegrationRetryInput } from "../http/hospital-integration-schemas";
import { parseDocumentCommand } from "./hospital-document-common";
import { authorizedIntegrationItem, configuredIntegration, integrationDigest, integrationPurposeFor, integrationReceipt, requireIntegrationExchange } from "./hospital-integration-policy";
import { hospitalIntegrationHttpConfigFromEnv, HospitalIntegrationHttpError, sendHospitalIntegrationHttp, type HospitalIntegrationHttpConfig } from "./hospital-integration-http";
import type { HospitalIntegrationDependencies } from "./hospital-integration-credential-service";
import { createAudit, ensureExpectedVersion, id, now, requireActiveUser, requireIdempotencyKey, requireItemPermission, requirePermission, withIdempotency, saveIdempotency } from "./service-common";
import { requireHospitalTaskAccess } from "./hospital-task-policy";
import { assertIntegrationSequence } from "./hospital-integration-ingress-service";

function sourceFor(state: StoreState, actor: User, system: HospitalIntegrationSystem, targetType: "HOSPITAL_INTAKE" | "DIAGNOSTIC_ITEM", targetId: string) {
  if (system === "HIS" && targetType === "HOSPITAL_INTAKE") {
    const intake = state.hospitalIntakes.find((entry) => entry.id === targetId); if (!intake) throw new ApiError("NOT_FOUND", "Origem indisponível.", 404);
    requireIntegrationExchange(actor, intake.departmentCode); requireHospitalTaskAccess(state, actor, "hospital_intake.view", intake);
    return { version: intake.version, payload: { id: intake.id, title: intake.title, description: intake.description, departmentCode: intake.departmentCode, patientId: intake.patientId, encounterId: intake.encounterId, priority: intake.priority, state: intake.state } };
  }
  if (system === "HIS" || targetType !== "DIAGNOSTIC_ITEM") throw new ApiError("VALIDATION_ERROR", "Origem incompatível com o sistema.", 400);
  // Sending an order does not require the future external result's executor. Draft ingress does.
  const item = state.items.find((entry) => entry.id === targetId); const request = item && state.requests.find((entry) => entry.id === item.requestId);
  if (!item || !request || (system === "LIS" ? item.workflowType !== "LABORATORY" : item.workflowType === "LABORATORY")) throw new ApiError("NOT_FOUND", "Origem indisponível.", 404);
  requireIntegrationExchange(actor, item.departmentCode); requireItemPermission(state, actor, "item.view", item);
  return { version: item.version, payload: { id: item.id, requestId: request.id, patientId: request.patientId, encounterId: request.encounterId, departmentCode: item.departmentCode, serviceId: item.serviceId, workflowType: item.workflowType, status: item.status, examDefinitionSnapshot: item.definitionSnapshot } };
}
function requireMessageAccess(state: StoreState, actor: User, message: HospitalIntegrationMessage): void {
  if (message.actorUserId !== actor.id && actor.role !== "SUPERADMIN") throw new ApiError("NOT_FOUND", "Recibo indisponível.", 404);
  if (message.direction === "OUTBOUND") { sourceFor(state, actor, message.system, message.targetType as "HOSPITAL_INTAKE" | "DIAGNOSTIC_ITEM", message.targetId!); return; }
  if (message.targetType === "HOSPITAL_INTAKE" && message.targetId) { sourceFor(state, actor, "HIS", "HOSPITAL_INTAKE", message.targetId); return; }
  if (message.targetType === "RESULT" && message.targetId) { const result = state.results.find((entry) => entry.id === message.targetId); if (!result) throw new ApiError("NOT_FOUND", "Recibo indisponível.", 404); authorizedIntegrationItem(state, actor, result.itemId, message.system as "LIS" | "PACS"); return; }
  const credential = state.hospitalIntegrationCredentials.find((entry) => entry.id === message.credentialId);
  if (!credential || credential.actorUserId !== actor.id || !credential.active || Date.parse(credential.expiresAt) <= Date.now()) throw new ApiError("NOT_FOUND", "Recibo indisponível.", 404);
  for (const department of credential.scope.departmentCodes) requireIntegrationExchange(actor, department);
}
export interface HospitalIntegrationExchangeDependencies extends HospitalIntegrationDependencies {
  send?: (config: HospitalIntegrationHttpConfig, envelope: Parameters<typeof sendHospitalIntegrationHttp>[1]) => ReturnType<typeof sendHospitalIntegrationHttp>;
}
export function createHospitalIntegrationExchangeService(context: ApplicationServiceContext, dependencies: HospitalIntegrationExchangeDependencies = {}) {
  const loader = dependencies.config ?? hospitalIntegrationHttpConfigFromEnv; const send = dependencies.send ?? sendHospitalIntegrationHttp;
  async function deliver(actor: User, messageId: string): Promise<HospitalIntegrationReceipt> {
    const state = await context.store.readState(); const message = state.hospitalIntegrationMessages.find((entry) => entry.id === messageId)!;
    let receipt: Awaited<ReturnType<typeof sendHospitalIntegrationHttp>> | undefined; let failure: HospitalIntegrationHttpError | undefined;
    try {
      const current = requireActiveUser(state, actor); requireMessageAccess(state, current, message);
      const config = configuredIntegration(message.system, loader); const source = sourceFor(state, current, message.system, message.targetType as "HOSPITAL_INTAKE" | "DIAGNOSTIC_ITEM", message.targetId!);
      if (source.version !== message.expectedSourceVersion || integrationDigest(source.payload) !== message.payloadHash) throw new ApiError("INTEGRATION_SOURCE_CHANGED", "A origem mudou; concilie e emita outra mensagem com a versão atual.", 409);
      receipt = await send(config, { contract: "CVG_OPERATIONAL_V1", messageId: message.messageId, externalEntityId: message.externalEntityId, sequence: message.sequence, purpose: message.purpose, occurredAt: message.createdAt, payload: source.payload });
    } catch (error) { failure = error instanceof HospitalIntegrationHttpError ? error : error instanceof ApiError ? new HospitalIntegrationHttpError(error.code, error.code !== "INTEGRATION_SOURCE_CHANGED") : new HospitalIntegrationHttpError("INTEGRATION_DELIVERY_UNAVAILABLE", true); }
    return context.store.transaction((latest) => {
      const claimed = latest.hospitalIntegrationMessages.find((entry) => entry.id === message.id)!;
      if (claimed.version !== message.version || claimed.status !== "CLAIMED") throw new ApiError("INTEGRATION_CLAIM_CHANGED", "O recibo foi conciliado por outro comando.", 409);
      const completed: HospitalIntegrationMessage = { ...claimed, status: receipt ? "SUCCEEDED" : "FAILED", remoteReceiptId: receipt?.receiptId, errorCode: failure?.code, retryable: failure?.retryable ?? false, nextAttemptAt: failure?.retryable ? new Date(Date.now() + 30_000).toISOString() : undefined, leaseUntil: undefined, completedAt: now(), version: claimed.version + 1 };
      // Persist the actual remote outcome even if grants were revoked while the request was in flight.
      const next = { ...latest, hospitalIntegrationMessages: latest.hospitalIntegrationMessages.map((entry) => entry.id === completed.id ? completed : entry), auditEvents: [...latest.auditEvents, createAudit("HospitalIntegrationDeliveryRecorded", actor.id, "HospitalIntegrationMessage", completed.id, completed.correlationId, "CLAIMED", completed.status, { system: completed.system, messageId: completed.messageId, remoteReceiptId: receipt?.receiptId ?? null, errorCode: failure?.code ?? null })] };
      try { const fresh = requireActiveUser(latest, actor); requireMessageAccess(latest, fresh, completed); } catch { return { state: next, result: undefined }; }
      return { state: next, result: integrationReceipt(completed) };
    }).then((result) => { if (!result) throw new ApiError("SCOPE_DENIED", "O acesso à integração foi revogado.", 404); return result; });
  }
  return {
    async listHospitalIntegrationMessages(actor: User, filters: HospitalIntegrationFilters = {}): Promise<{ items: HospitalIntegrationReceipt[]; total: number; nextCursor?: string }> {
      const body = hospitalIntegrationFiltersSchema.safeParse(filters); if (!body.success) throw new ApiError("VALIDATION_ERROR", "Filtros inválidos.", 400);
      const state = await context.store.readState(); const current = requireActiveUser(state, actor); requirePermission(current, "integration.exchange", {});
      const rows = state.hospitalIntegrationMessages.filter((entry) => { try { requireMessageAccess(state, current, entry); return (!filters.system || entry.system === filters.system) && (!filters.direction || entry.direction === filters.direction) && (!filters.status || entry.status === filters.status); } catch { return false; } }).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
      const position = filters.cursor ? rows.findIndex((entry) => entry.id === filters.cursor) + 1 : 0; if (filters.cursor && position === 0) throw new ApiError("VALIDATION_ERROR", "Continuação inválida ou sem acesso atual.", 400); const limit = filters.limit ?? 50; const page = rows.slice(position, position + limit);
      return { items: page.map(integrationReceipt), total: rows.length, ...(position + limit < rows.length ? { nextCursor: page.at(-1)!.id } : {}) };
    },
    async exchangeHospitalIntegration(actor: User, input: HospitalIntegrationExchangeInput): Promise<HospitalIntegrationReceipt> {
      const claimed = await context.store.transaction((state) => {
        const current = requireActiveUser(state, actor); const body = parseDocumentCommand(hospitalIntegrationExchangeSchema, input); configuredIntegration(body.system, loader); const source = sourceFor(state, current, body.system, body.targetType, body.targetId); requireIdempotencyKey(input.idempotencyKey);
        const scope = "POST:/hospital-integrations/exchange"; const replay = withIdempotency<{ id: string }>(state, current.id, scope, input.idempotencyKey, { input });
        if (replay.found) { const message = state.hospitalIntegrationMessages.find((entry) => entry.id === replay.existing!.id)!; requireMessageAccess(state, current, message); return { state, result: { message, deliver: false } }; }
        ensureExpectedVersion(source.version, body.expectedVersion); if (state.hospitalIntegrationMessages.some((entry) => entry.system === body.system && entry.direction === "OUTBOUND" && entry.messageId === body.messageId)) throw new ApiError("INTEGRATION_MESSAGE_CONFLICT", "O identificador já foi usado; use o comando de conciliação ou repetição.", 409);
        assertIntegrationSequence(state.hospitalIntegrationMessages, body.system, "OUTBOUND", body.externalEntityId, body.sequence);
        const message: HospitalIntegrationMessage = { id: id("integration-message"), system: body.system, targetType: body.targetType, targetId: body.targetId, messageId: body.messageId, externalEntityId: body.externalEntityId, sequence: body.sequence, purpose: integrationPurposeFor(body.system), direction: "OUTBOUND", status: "CLAIMED", attempts: 1, retryable: true, leaseUntil: new Date(Date.now() + 120_000).toISOString(), createdAt: now(), version: 1, actorUserId: current.id, payloadHash: integrationDigest(source.payload), correlationId: input.correlationId ?? id("corr"), expectedSourceVersion: source.version };
        const next = { ...state, hospitalIntegrationMessages: [...state.hospitalIntegrationMessages, message] }; return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, { id: message.id }, { input }), result: { message, deliver: true } };
      });
      return claimed.deliver ? deliver(actor, claimed.message.id) : integrationReceipt(claimed.message);
    },
    async retryHospitalIntegrationMessage(actor: User, messageId: string, input: HospitalIntegrationRetryInput): Promise<HospitalIntegrationReceipt> {
      const claimed = await context.store.transaction((state) => {
        const current = requireActiveUser(state, actor); const message = state.hospitalIntegrationMessages.find((entry) => entry.id === messageId); if (!message || message.direction !== "OUTBOUND") throw new ApiError("NOT_FOUND", "Mensagem de saída indisponível.", 404); requireMessageAccess(state, current, message); const body = parseDocumentCommand(hospitalIntegrationRetrySchema, input); configuredIntegration(message.system, loader); requireIdempotencyKey(input.idempotencyKey);
        const scope = `POST:/hospital-integrations/messages/${messageId}/retry`; const replay = withIdempotency<{ id: string }>(state, current.id, scope, input.idempotencyKey, { input }); if (replay.found) return { state, result: false };
        ensureExpectedVersion(message.version, body.expectedVersion);
        if (message.status === "SUCCEEDED" || message.status === "FAILED" && !message.retryable || message.status === "CLAIMED" && Date.parse(message.leaseUntil ?? "") > Date.now() || message.nextAttemptAt && Date.parse(message.nextAttemptAt) > Date.now()) throw new ApiError("INTEGRATION_RETRY_NOT_AVAILABLE", "A mensagem não está disponível para repetição agora.", 409);
        const source = sourceFor(state, current, message.system, message.targetType as "HOSPITAL_INTAKE" | "DIAGNOSTIC_ITEM", message.targetId!); if (source.version !== message.expectedSourceVersion || integrationDigest(source.payload) !== message.payloadHash) throw new ApiError("INTEGRATION_SOURCE_CHANGED", "A origem mudou; não repita conteúdo diferente sob o mesmo identificador.", 409);
        assertIntegrationSequence(state.hospitalIntegrationMessages.filter((entry) => entry.id !== message.id), message.system, "OUTBOUND", message.externalEntityId, message.sequence);
        const updated: HospitalIntegrationMessage = { ...message, status: "CLAIMED", attempts: message.attempts + 1, leaseUntil: new Date(Date.now() + 120_000).toISOString(), errorCode: undefined, nextAttemptAt: undefined, version: message.version + 1 }; const next = { ...state, hospitalIntegrationMessages: state.hospitalIntegrationMessages.map((entry) => entry.id === messageId ? updated : entry) }; return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, { id: messageId }, { input }), result: true };
      });
      if (claimed) return deliver(actor, messageId);
      const state = await context.store.readState(); const current = requireActiveUser(state, actor); const message = state.hospitalIntegrationMessages.find((entry) => entry.id === messageId)!; requireMessageAccess(state, current, message); return integrationReceipt(message);
    }
  };
}
