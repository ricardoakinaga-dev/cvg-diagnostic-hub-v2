import * as integration from "../../../../server/http/hospital-integration-schemas";
import * as ai from "../../../../server/http/hospital-ai-schemas";
import { ApiError } from "../../../../server/http/envelope";
import { readBytesWithLimit } from "../../../../server/http/request-body";
import { getRuntimeStoreAsync } from "../../../../server/store/runtime";
import { createApplicationService } from "../../../../server/application/service";
import { assertRateLimit } from "../../../../server/security/rate-limit";
import { responseFor, type ApiHandlerGroup } from "./route-support";
import { planningCommand, planningFilters } from "./hospital-planning-handler-support";
export const hospitalExternalHandlers = {
  getHospitalHisV4Catalog: { authentication: "session", handle: async ({ actor, service, correlationId, id }) => responseFor(await service.getHospitalHisV4Catalog(actor), correlationId, id) },
  receiveHospitalHisV4Webhook: { authentication: "public", handle: async ({ request, path, correlationId, id, rateLimitClientKey }) => {
    await assertRateLimit(`his-v4-webhook:${rateLimitClientKey}`, 60, 60_000);
    if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new ApiError("UNSUPPORTED_MEDIA_TYPE", "O evento deve usar application/json.", 415);
    let bytes: Uint8Array; try { bytes = await readBytesWithLimit(request, 100_000); } catch (error) { if (error instanceof ApiError && error.code === "VALIDATION_ERROR") throw new ApiError("PAYLOAD_TOO_LARGE", "O evento excede o limite permitido.", 413); throw error; }
    let body: string; try { body = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new ApiError("VALIDATION_ERROR", "O evento exige UTF-8 válido.", 400); }
    const value = (name: string) => request.headers.get(name) ?? "";
    const headers = { signature: value("x-webhook-signature"), timestamp: value("x-webhook-timestamp"), signatureVersion: value("x-webhook-signature-version"), webhookId: value("x-webhook-id"), deliveryId: value("x-webhook-delivery-id"), event: value("x-webhook-event"), idempotencyKey: value("idempotency-key") };
    const service = createApplicationService(await getRuntimeStoreAsync());
    return responseFor(await service.receiveHospitalHisV4Webhook(path[3], headers, body, correlationId), correlationId, id);
  } },
  getHospitalIntegrationCapabilities: { authentication: "session", handle: async ({ actor, service, correlationId, id }) => responseFor(await service.getHospitalIntegrationCapabilities(actor), correlationId, id) },
  getHospitalIntegrationOptions: { authentication: "session", handle: async ({ path, actor, service, correlationId, id }) => responseFor(await service.getHospitalIntegrationOptions(actor, path[1] as "HIS" | "LIS" | "PACS"), correlationId, id) },
  listHospitalIntegrationCredentials: { authentication: "session", handle: async ({ actor, service, correlationId, id }) => responseFor(await service.listHospitalIntegrationCredentials(actor), correlationId, id) },
  createHospitalIntegrationCredential: { authentication: "session", handle: async (c) => planningCommand(c, integration.hospitalIntegrationCredentialCreateSchema, (input) => c.service.createHospitalIntegrationCredential(c.actor, input), false, 201) },
  rotateHospitalIntegrationCredential: { authentication: "session", handle: async (c) => planningCommand(c, integration.hospitalIntegrationCredentialRotateSchema, (input) => c.service.rotateHospitalIntegrationCredential(c.actor, c.path[1], input)) },
  revokeHospitalIntegrationCredential: { authentication: "session", handle: async (c) => planningCommand(c, integration.hospitalIntegrationCredentialRevokeSchema, (input) => c.service.revokeHospitalIntegrationCredential(c.actor, c.path[1], input)) },
  listHospitalIntegrationMessages: { authentication: "session", handle: async ({ request, actor, service, correlationId, id }) => responseFor(await service.listHospitalIntegrationMessages(actor, planningFilters(request, integration.hospitalIntegrationFiltersSchema)), correlationId, id) },
  exchangeHospitalIntegration: { authentication: "session", handle: async (c) => planningCommand(c, integration.hospitalIntegrationExchangeSchema, (input) => c.service.exchangeHospitalIntegration(c.actor, input)) },
  retryHospitalIntegrationMessage: { authentication: "session", handle: async (c) => planningCommand(c, integration.hospitalIntegrationRetrySchema, (input) => c.service.retryHospitalIntegrationMessage(c.actor, c.path[2], input)) },
  receiveHospitalIntegrationMessage: { authentication: "public", handle: async ({ request, path, correlationId, id, rateLimitClientKey }) => {
    await assertRateLimit(`integration-ingress:${rateLimitClientKey}`, 60, 60_000);
    if (!["HIS", "LIS", "PACS"].includes(path[1])) throw new ApiError("VALIDATION_ERROR", "Sistema de integração inválido.", 400);
    const authorization = request.headers.get("authorization") ?? ""; const match = /^Bearer (cvg_int_[A-Za-z0-9_-]{43})$/.exec(authorization); if (!match) throw new ApiError("INTEGRATION_UNAUTHORIZED", "Informe a credencial de serviço dedicada.", 401);
    if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new ApiError("UNSUPPORTED_MEDIA_TYPE", "O corpo deve usar application/json.", 415);
    let bytes: Uint8Array; try { bytes = await readBytesWithLimit(request, 2_000_000); } catch (error) { if (error instanceof ApiError && error.code === "VALIDATION_ERROR") throw new ApiError("PAYLOAD_TOO_LARGE", "A mensagem excede o limite permitido.", 413); throw error; }
    let rawBody: string; try { rawBody = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new ApiError("VALIDATION_ERROR", "A mensagem exige UTF-8 válido.", 400); }
    const service = createApplicationService(await getRuntimeStoreAsync());
    return responseFor(await service.receiveHospitalIntegrationMessage(path[1] as "HIS" | "LIS" | "PACS", match[1], request.headers.get("x-hub-signature-256") ?? "", rawBody, correlationId), correlationId, id);
  } },
  getHospitalAiCapability: { authentication: "session", handle: async ({ actor, service, correlationId, id }) => responseFor(await service.getHospitalAiCapability(actor), correlationId, id) },
  listHospitalAiSuggestions: { authentication: "session", handle: async ({ path, actor, service, correlationId, id }) => responseFor(await service.listHospitalAiSuggestions(actor, path[1]), correlationId, id) },
  suggestHospitalDocumentText: { authentication: "session", handle: async (c) => planningCommand(c, ai.hospitalAiSuggestSchema, (input) => c.service.suggestHospitalDocumentText(c.actor, c.path[1], input)) },
  reviewHospitalAiSuggestion: { authentication: "session", handle: async (c) => planningCommand(c, ai.hospitalAiReviewSchema, (input) => c.service.reviewHospitalAiSuggestion(c.actor, c.path[1], input)) }
} satisfies ApiHandlerGroup;
