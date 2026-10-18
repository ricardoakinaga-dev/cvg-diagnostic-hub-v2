import type { HospitalIntegrationCredential, HospitalIntegrationCredentialIssued, HospitalIntegrationCredentialView, HospitalIntegrationCapability } from "@cvg/contracts";
import type { User } from "../domain/models";
import type { ApplicationServiceContext } from "./service-context";
import { randomBytes } from "node:crypto";
import { ApiError } from "../http/envelope";
import { hospitalIntegrationCredentialCreateSchema, hospitalIntegrationCredentialRotateSchema, hospitalIntegrationCredentialRevokeSchema, type HospitalIntegrationCredentialCreateInput, type HospitalIntegrationCredentialRotateInput, type HospitalIntegrationCredentialRevokeInput } from "../http/hospital-integration-schemas";
import { parseDocumentCommand } from "./hospital-document-common";
import { configuredIntegration, integrationCredentialView, integrationTokenHash, requireIntegrationExchange, requireIntegrationManagement } from "./hospital-integration-policy";
import { createAudit, ensureExpectedVersion, id, now, requireActiveUser, requireIdempotencyKey, requirePatientPermission, requirePermission, saveIdempotency, withIdempotency } from "./service-common";
import { requireActiveDepartment } from "./department-registry";
import type { HospitalIntegrationHttpConfig } from "./hospital-integration-http";
import { hospitalIntegrationHttpConfigFromEnv, validateHospitalIntegrationHttpConfig } from "./hospital-integration-http";
import { hospitalHisV4ConfigFromEnv, validateHospitalHisV4Config, type HospitalHisV4Config } from "./hospital-his-v4-config";

export interface HospitalIntegrationDependencies {
  config?: (system: "HIS" | "LIS" | "PACS") => HospitalIntegrationHttpConfig | undefined;
  hisV4Config?: () => HospitalHisV4Config | undefined;
  afterInboundCommand?: () => Promise<void>;
}
export function createHospitalIntegrationCredentialService({ store }: Pick<ApplicationServiceContext, "store">, dependencies: HospitalIntegrationDependencies = {}) {
  const loader = dependencies.config ?? hospitalIntegrationHttpConfigFromEnv;
  const requireProfileConfiguration = (system: "HIS" | "LIS" | "PACS", profile?: "CVG_OPERATIONAL_V1" | "HIS_V4") => {
    if (profile !== "HIS_V4") { configuredIntegration(system, loader); return; }
    try { const config = (dependencies.hisV4Config ?? hospitalHisV4ConfigFromEnv)(); if (!config) throw new Error("MISSING"); validateHospitalHisV4Config(config); } catch { throw new ApiError("HIS_V4_NOT_CONFIGURED", "Configure a descoberta HTTPS do HIS v4 antes de emitir esta credencial.", 503); }
  };
  return {
    async getHospitalIntegrationCapabilities(actor: User): Promise<HospitalIntegrationCapability[]> {
      const state = await store.readState(); const current = requireActiveUser(state, actor);
      if (!current.permissions?.some((permission) => permission === "integration.manage" || permission === "integration.exchange")) throw new ApiError("SCOPE_DENIED", "Você não tem acesso às integrações.", 404);
      return (["HIS", "LIS", "PACS"] as const).map((system) => { try { const config = loader(system); if (config) validateHospitalIntegrationHttpConfig(config); return { system, contract: "CVG_OPERATIONAL_V1", configured: !!config, deploymentVerified: false, ...(!config ? { reason: "CONFIGURATION_MISSING" as const } : {}) }; } catch { return { system, contract: "CVG_OPERATIONAL_V1", configured: false, deploymentVerified: false, reason: "CONFIGURATION_INVALID" }; } });
    },
    async getHospitalIntegrationOptions(actor: User, system: "HIS" | "LIS" | "PACS"): Promise<{ departments: Array<{ code: string; name: string }>; actors: Array<{ id: string; displayName: string; departmentCode: string }> }> {
      if (!["HIS", "LIS", "PACS"].includes(system)) throw new ApiError("VALIDATION_ERROR", "Sistema inválido.", 400);
      const state = await store.readState(); const current = requireActiveUser(state, actor); requirePermission(current, "integration.manage", {});
      const departments = state.departments.filter((department) => { try { requireActiveDepartment(state, department.code); requireIntegrationManagement(current, { departmentCodes: [department.code] }); return true; } catch { return false; } });
      const actors = state.users.flatMap((user) => { if (!user.active || user.mustChangePassword) return []; try { const bound = requireActiveUser(state, user); const eligible = departments.some((department) => { try { requireIntegrationExchange(bound, department.code); requirePermission(bound, system === "HIS" ? "hospital_intake.create" : "result.draft.create", { departmentCode: department.code }); return true; } catch { return false; } }); return eligible ? [{ id: bound.id, displayName: bound.displayName, departmentCode: bound.departmentCode }] : []; } catch { return []; } });
      return { departments: departments.map((department) => ({ code: department.code, name: department.name })), actors };
    },
    async listHospitalIntegrationCredentials(actor: User): Promise<HospitalIntegrationCredentialView[]> {
      const state = await store.readState(); const current = requireActiveUser(state, actor); requirePermission(current, "integration.manage", {});
      return state.hospitalIntegrationCredentials.filter((credential) => { try { requireIntegrationManagement(current, credential.scope); return true; } catch { return false; } }).map(integrationCredentialView);
    },
    async createHospitalIntegrationCredential(actor: User, input: HospitalIntegrationCredentialCreateInput): Promise<HospitalIntegrationCredentialIssued> {
      return store.transaction<HospitalIntegrationCredentialIssued>((state) => {
        const current = requireActiveUser(state, actor); const body = parseDocumentCommand(hospitalIntegrationCredentialCreateSchema, input); requireIntegrationManagement(current, body.scope); requireProfileConfiguration(body.system, body.profile); requireIdempotencyKey(input.idempotencyKey);
        const scope = "POST:/integration-credentials"; const replay = withIdempotency<{ credentialId: string }>(state, current.id, scope, input.idempotencyKey, { input });
        if (replay.found) { const existing = state.hospitalIntegrationCredentials.find((entry) => entry.id === replay.existing!.credentialId); if (!existing) throw new ApiError("NOT_FOUND", "Credencial indisponível.", 404); requireIntegrationManagement(current, existing.scope); return { state, result: { credential: integrationCredentialView(existing), tokenReturnedOnce: false } }; }
        const bound = requireActiveUser(state, state.users.find((entry) => entry.id === body.actorUserId) ?? ({ id: body.actorUserId } as User)); if (bound.mustChangePassword) throw new ApiError("INTEGRATION_ACTOR_UNAVAILABLE", "Conclua a habilitação do ator antes de emitir credenciais.", 422);
        for (const departmentCode of body.scope.departmentCodes) { requireActiveDepartment(state, departmentCode); requireIntegrationExchange(bound, departmentCode); requirePermission(bound, body.purpose === "HIS_INTAKE" ? "hospital_intake.create" : "result.draft.create", { departmentCode }); }
        for (const patientId of body.scope.patientIds ?? []) requirePatientPermission(state, bound, "patient.view", patientId);
        const token = `cvg_int_${randomBytes(32).toString("base64url")}`; const timestamp = now();
        const credential: HospitalIntegrationCredential = { id: id("integration-credential"), ...(body.profile ? { profile: body.profile } : {}), system: body.system, purpose: body.purpose, actorUserId: bound.id, scope: body.scope, name: body.name, tokenHash: integrationTokenHash(token), active: true, expiresAt: new Date(Date.now() + body.ttlSeconds * 1000).toISOString(), createdBy: current.id, createdAt: timestamp, version: 1 };
        const next = { ...state, hospitalIntegrationCredentials: [...state.hospitalIntegrationCredentials, credential], auditEvents: [...state.auditEvents, createAudit("HospitalIntegrationCredentialIssued", current.id, "HospitalIntegrationCredential", credential.id, input.correlationId ?? id("corr"), undefined, "ACTIVE", { system: credential.system, purpose: credential.purpose, actorUserId: bound.id, departmentCodes: body.scope.departmentCodes.join(","), expiresAt: credential.expiresAt, version: 1 })] };
        return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, { credentialId: credential.id }, { input }), result: { credential: integrationCredentialView(credential), token, tokenReturnedOnce: true } };
      });
    },
    async rotateHospitalIntegrationCredential(actor: User, credentialId: string, input: HospitalIntegrationCredentialRotateInput): Promise<HospitalIntegrationCredentialIssued> {
      return store.transaction<HospitalIntegrationCredentialIssued>((state) => {
        const current = requireActiveUser(state, actor); const previous = state.hospitalIntegrationCredentials.find((entry) => entry.id === credentialId); if (!previous) throw new ApiError("NOT_FOUND", "Credencial indisponível.", 404); requireIntegrationManagement(current, previous.scope); const body = parseDocumentCommand(hospitalIntegrationCredentialRotateSchema, input); requireProfileConfiguration(previous.system, previous.profile); requireIdempotencyKey(input.idempotencyKey);
        const scope = `POST:/integration-credentials/${credentialId}/rotate`; const replay = withIdempotency(state, current.id, scope, input.idempotencyKey, { input }); if (replay.found) return { state, result: { credential: integrationCredentialView(previous), tokenReturnedOnce: false } };
        ensureExpectedVersion(previous.version, body.expectedVersion); if (!previous.active) throw new ApiError("INTEGRATION_CREDENTIAL_REVOKED", "Emita outra credencial; uma credencial revogada não pode ser reativada.", 409);
        const bound = requireActiveUser(state, state.users.find((entry) => entry.id === previous.actorUserId) ?? ({ id: previous.actorUserId } as User)); if (bound.mustChangePassword) throw new ApiError("INTEGRATION_ACTOR_UNAVAILABLE", "O ator não está habilitado.", 422); for (const departmentCode of previous.scope.departmentCodes) requireIntegrationExchange(bound, departmentCode);
        const token = `cvg_int_${randomBytes(32).toString("base64url")}`; const timestamp = now(); const updated = { ...previous, tokenHash: integrationTokenHash(token), rotatedAt: timestamp, expiresAt: new Date(Date.now() + body.ttlSeconds * 1000).toISOString(), version: previous.version + 1 };
        const next = { ...state, hospitalIntegrationCredentials: state.hospitalIntegrationCredentials.map((entry) => entry.id === credentialId ? updated : entry), auditEvents: [...state.auditEvents, createAudit("HospitalIntegrationCredentialRotated", current.id, "HospitalIntegrationCredential", credentialId, input.correlationId ?? id("corr"), String(previous.version), String(updated.version), { system: updated.system, purpose: updated.purpose, expiresAt: updated.expiresAt })] };
        return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, { credentialId }, { input }), result: { credential: integrationCredentialView(updated), token, tokenReturnedOnce: true } };
      });
    },
    async revokeHospitalIntegrationCredential(actor: User, credentialId: string, input: HospitalIntegrationCredentialRevokeInput): Promise<HospitalIntegrationCredentialView> {
      return store.transaction((state) => {
        const current = requireActiveUser(state, actor); const previous = state.hospitalIntegrationCredentials.find((entry) => entry.id === credentialId); if (!previous) throw new ApiError("NOT_FOUND", "Credencial indisponível.", 404); requireIntegrationManagement(current, previous.scope); const body = parseDocumentCommand(hospitalIntegrationCredentialRevokeSchema, input); requireIdempotencyKey(input.idempotencyKey);
        const scope = `POST:/integration-credentials/${credentialId}/revoke`; const replay = withIdempotency(state, current.id, scope, input.idempotencyKey, { input }); if (replay.found) return { state, result: integrationCredentialView(previous) };
        ensureExpectedVersion(previous.version, body.expectedVersion); const updated = { ...previous, active: false, revokedAt: now(), version: previous.version + 1 };
        const next = { ...state, hospitalIntegrationCredentials: state.hospitalIntegrationCredentials.map((entry) => entry.id === credentialId ? updated : entry), auditEvents: [...state.auditEvents, createAudit("HospitalIntegrationCredentialRevoked", current.id, "HospitalIntegrationCredential", credentialId, input.correlationId ?? id("corr"), "ACTIVE", "REVOKED", { reason: body.reason, system: previous.system, purpose: previous.purpose })] };
        const result = integrationCredentialView(updated); return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, result, { input }), result };
      });
    }
  };
}
