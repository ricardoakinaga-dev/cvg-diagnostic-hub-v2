import type { HospitalHisV4Catalog, HospitalHisV4Delivery, HospitalHisV4Receipt } from "@cvg/contracts";
import type { StoreState, User } from "../domain/models";
import type { ApplicationServiceContext } from "./service-context";
import { ApiError } from "../http/envelope";
import { hospitalHisV4RemoteCatalogSchema, hospitalHisV4WebhookSchema, type HospitalHisV4Headers } from "../http/hospital-his-v4-schemas";
import { hospitalHisV4ConfigFromEnv, validateHospitalHisV4Config, type HospitalHisV4Config } from "./hospital-his-v4-config";
import { discoverHospitalHisV4Http, verifyHospitalHisV4Signature } from "./hospital-his-v4-http";
import { integrationDigest, requireIntegrationExchange } from "./hospital-integration-policy";
import { requireHospitalTaskAccess } from "./hospital-task-policy";
import { createHospitalIntakeService } from "./hospital-intake-service";
import { transactionalServiceContext } from "./transactional-service-context";
import { createAudit, id, now, requireActiveUser, requirePatientPermission, requirePermission } from "./service-common";

export interface HospitalHisV4Dependencies { config?: () => HospitalHisV4Config | undefined; discover?: typeof discoverHospitalHisV4Http; afterCommand?: () => Promise<void> }
function configured(loader: () => HospitalHisV4Config | undefined): HospitalHisV4Config {
  let config: HospitalHisV4Config | undefined; try { config = loader(); if (config) validateHospitalHisV4Config(config); } catch { throw new ApiError("HIS_V4_CONFIGURATION_INVALID", "A configuração aprovada do HIS v4 não é válida.", 503); }
  if (!config) throw new ApiError("HIS_V4_NOT_CONFIGURED", "Configure endpoint HTTPS, credencial e contrato do HIS v4 antes de integrar.", 503);
  return config;
}
function receipt(delivery: HospitalHisV4Delivery): HospitalHisV4Receipt { return { profile: "HIS_V4_WEBHOOK_V2", receiptId: delivery.id, deliveryId: delivery.deliveryId, providerPayloadId: delivery.providerPayloadId, status: "RECEIVED_FOR_TRIAGE" }; }
function currentWebhookActor(state: StoreState, config: HospitalHisV4Config, credentialId: string) {
  const binding = config.webhook; const credential = state.hospitalIntegrationCredentials.find(entry => entry.id === credentialId);
  if (!binding || binding.credentialId !== credentialId || !credential?.active || credential.profile !== "HIS_V4" || credential.system !== "HIS" || credential.purpose !== "HIS_INTAKE" || credential.version !== binding.credentialVersion || !Number.isFinite(Date.parse(credential.expiresAt)) || Date.parse(credential.expiresAt) <= Date.now()) throw new ApiError("INTEGRATION_UNAUTHORIZED", "Vínculo de serviço indisponível.", 401);
  const actor = requireActiveUser(state, state.users.find(user => user.id === credential.actorUserId) ?? ({ id: credential.actorUserId } as User));
  if (actor.mustChangePassword) throw new ApiError("INTEGRATION_UNAUTHORIZED", "Ator de serviço não está habilitado.", 401);
  return { actor, credential };
}
export function createHospitalHisV4Service(context: ApplicationServiceContext, dependencies: HospitalHisV4Dependencies = {}) {
  const loader = dependencies.config ?? hospitalHisV4ConfigFromEnv;
  return {
    async getHospitalHisV4Catalog(actor: User): Promise<HospitalHisV4Catalog> {
      const before = await context.store.readState(); const current = requireActiveUser(before, actor); requirePermission(current, "integration.manage", {});
      const config = configured(loader);
      // A remote catalog is institution-wide technical metadata, never delegated patient access.
      if (!["ADMIN", "SUPERADMIN"].includes(current.role)) throw new ApiError("SCOPE_DENIED", "A descoberta institucional requer administração global.", 404);
      let remote: unknown; try { remote = await (dependencies.discover ?? discoverHospitalHisV4Http)(config); } catch { throw new ApiError("HIS_V4_DISCOVERY_FAILED", "O HIS v4 não confirmou uma resposta válida por HTTPS aprovado.", 503); }
      const parsed = hospitalHisV4RemoteCatalogSchema.safeParse(remote);
      if (!parsed.success || parsed.data.accountId !== config.accountId || !parsed.data.permissions.includes("integrations.read")) throw new ApiError("HIS_V4_CATALOG_INVALID", "O catálogo retornado não corresponde à conta e ao contrato aprovados.", 502);
      const after = await context.store.readState(); const fresh = requireActiveUser(after, actor); requirePermission(fresh, "integration.manage", {}); if (!["ADMIN", "SUPERADMIN"].includes(fresh.role)) throw new ApiError("SCOPE_DENIED", "A descoberta institucional requer administração global.", 404);
      const advertised = Object.entries(parsed.data).flatMap(([family, value]) => value && typeof value === "object" && !Array.isArray(value) && "endpoints" in value ? [{ family, ...("provider" in value && value.provider ? { provider: value.provider } : {}), endpoints: value.endpoints, capabilities: "capabilities" in value ? value.capabilities ?? [] : [] }] : []);
      return { profile: "HIS_V4", accountId: parsed.data.accountId, observedAt: now(), contractReference: config.contractReference, deploymentVerified: false, advertised };
    },
    async receiveHospitalHisV4Webhook(credentialId: string, headers: HospitalHisV4Headers, rawBody: string, correlationId?: string): Promise<HospitalHisV4Receipt> {
      if (Buffer.byteLength(rawBody) > 100_000) throw new ApiError("PAYLOAD_TOO_LARGE", "O evento excede o limite permitido.", 413);
      const config = configured(loader); const binding = config.webhook;
      if (!binding) throw new ApiError("HIS_V4_WEBHOOK_NOT_CONFIGURED", "O webhook HIS v4 requer vínculo e mapeamento aprovados.", 503);
      if (!verifyHospitalHisV4Signature(rawBody, headers.signature, headers.timestamp, headers.signatureVersion, binding.secret)) throw new ApiError("INTEGRATION_SIGNATURE_INVALID", "A assinatura v2 ou a validade temporal do evento não é válida.", 401);
      if (headers.webhookId !== binding.webhookId || !/^[A-Za-z0-9_.:-]{1,160}$/.test(headers.deliveryId) || headers.idempotencyKey !== headers.deliveryId) throw new ApiError("HIS_V4_DELIVERY_INVALID", "A entrega não corresponde ao webhook e à identidade aprovados.", 400);
      let input: unknown; try { input = JSON.parse(rawBody); } catch { throw new ApiError("INVALID_JSON", "Informe o evento HIS v4 em JSON válido.", 400); }
      const parsed = hospitalHisV4WebhookSchema.safeParse(input);
      if (!parsed.success) throw new ApiError("HIS_V4_EVENT_NOT_ADOPTED", "O evento não pertence ao contrato e à ação adotados.", 400);
      const event = parsed.data;
      if (event.accountId !== config.accountId || event.event !== headers.event) throw new ApiError("HIS_V4_EVENT_BINDING_INVALID", "A conta ou o evento não corresponde ao vínculo aprovado.", 403);
      const action = binding.mappings.actions.find(entry => entry.event === event.event);
      const patient = binding.mappings.patients.find(entry => entry.hisId === event.data.patientId);
      const encounter = binding.mappings.encounters.find(entry => entry.hisId === event.data.id);
      if (!action || !patient || !encounter) throw new ApiError("HIS_V4_MAPPING_REQUIRED", "Configure vínculos explícitos do paciente, atendimento e ação antes de receber o evento.", 422);
      const payload = { title: action.title, typeId: action.typeId, departmentCode: action.departmentCode, patientId: patient.hubId, encounterId: encounter.hubId, priority: action.priority };
      const payloadHash = integrationDigest(event); const mappingHash = integrationDigest({ accountId: config.accountId, action, patient, encounter });
      return context.store.transaction(async (state, audit) => {
        const { actor: current, credential } = currentWebhookActor(state, config, credentialId);
        if (!credential.scope.departmentCodes.includes(payload.departmentCode) || credential.scope.patientIds && !credential.scope.patientIds.includes(payload.patientId)) throw new ApiError("SCOPE_DENIED", "O contexto mapeado não pertence ao escopo da credencial.", 404);
        requireIntegrationExchange(current, payload.departmentCode); requireHospitalTaskAccess(state, current, "hospital_intake.create", payload); requirePatientPermission(state, current, "patient.view", payload.patientId);
        const previous = state.hospitalHisV4Deliveries.find(entry => entry.webhookId === headers.webhookId && entry.deliveryId === headers.deliveryId || entry.accountId === event.accountId && entry.providerPayloadId === event.id);
        if (previous) {
          if (previous.payloadHash !== payloadHash || previous.mappingHash !== mappingHash || previous.actorUserId !== current.id || previous.credentialId !== credential.id || previous.accountId !== event.accountId || previous.providerPayloadId !== event.id) throw new ApiError("INTEGRATION_MESSAGE_CONFLICT", "A entrega já foi vinculada a outro conteúdo, mapeamento ou ator.", 409);
          return { state, result: receipt(previous) };
        }
        if (state.hospitalHisV4Deliveries.some(entry => entry.accountId === event.accountId && entry.event === event.event && entry.externalEncounterId === event.data.id)) throw new ApiError("HIS_V4_EVENT_CONFLICT", "Este atendimento já originou uma demanda; concilie o novo evento antes de continuar.", 409);
        const tx = transactionalServiceContext(context, state, audit);
        const intake = await createHospitalIntakeService(tx.context).createHospitalIntake(current, { ...payload, source: "MANUAL", sourceLabel: "HIS_V4:encounter.created", idempotencyKey: `his-v4:${event.accountId}:${event.id}`, correlationId });
        await dependencies.afterCommand?.();
        const timestamp = now(); const delivery: HospitalHisV4Delivery = { id: id("his-v4-delivery"), deliveryId: headers.deliveryId, webhookId: headers.webhookId, accountId: event.accountId, event: event.event, providerPayloadId: event.id, externalEncounterId: event.data.id, credentialId: credential.id, credentialVersion: credential.version, actorUserId: current.id, payloadHash, mappingHash, intakeId: intake.id, receivedAt: timestamp, correlationId: correlationId ?? id("corr") };
        const changed = tx.state(); const next = { ...changed, hospitalHisV4Deliveries: [...changed.hospitalHisV4Deliveries, delivery], hospitalIntegrationCredentials: changed.hospitalIntegrationCredentials.map(entry => entry.id === credential.id ? { ...entry, lastUsedAt: timestamp } : entry), auditEvents: [...changed.auditEvents, createAudit("HospitalHisV4EventReceived", current.id, "HospitalHisV4Delivery", delivery.id, delivery.correlationId, undefined, "RECEIVED_FOR_TRIAGE", { providerPayloadId: event.id, deliveryId: headers.deliveryId, event: event.event, intakeId: intake.id, payloadHash, mappingHash })] };
        return { state: next, result: receipt(delivery) };
      });
    }
  };
}
