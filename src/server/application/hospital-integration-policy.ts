import type { HospitalIntegrationCredential, HospitalIntegrationCredentialView, HospitalIntegrationPurpose, HospitalIntegrationScope, HospitalIntegrationSystem, HospitalIntegrationMessage, HospitalIntegrationReceipt } from "@cvg/contracts";
import type { DiagnosticItem, StoreState, User } from "../domain/models";
import { createHash, timingSafeEqual } from "node:crypto";
import { ApiError } from "../http/envelope";
import { canAccessResource, managerCanAccessDepartment } from "../security/authorization";
import { requireActiveUser, requireItemPermission, requirePermission, requirePatientPermission } from "./service-common";
import { requireHospitalTaskAccess } from "./hospital-task-policy";
import type { HospitalIntegrationMessageInput } from "../http/hospital-integration-schemas";
import { hospitalIntegrationHttpConfigFromEnv, type HospitalIntegrationHttpConfig, validateHospitalIntegrationHttpConfig } from "./hospital-integration-http";

export const integrationPurposeFor = (system: HospitalIntegrationSystem): HospitalIntegrationPurpose => ({ HIS: "HIS_INTAKE", LIS: "LIS_RESULT_DRAFT", PACS: "PACS_RESULT_DRAFT" } as const)[system];
export function integrationDigest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export function integrationTokenHash(token: string): string { return createHash("sha256").update(token).digest("hex"); }
export function integrationCredentialView(credential: HospitalIntegrationCredential): HospitalIntegrationCredentialView {
  const { tokenHash: _token, ...view } = credential; return structuredClone(view);
}
export function integrationReceipt(message: HospitalIntegrationMessage): HospitalIntegrationReceipt {
  const { credentialId: _credential, actorUserId: _actor, payloadHash: _hash, correlationId: _correlation, leaseUntil: _lease, expectedSourceVersion: _sourceVersion, ...receipt } = message; return structuredClone(receipt);
}
export function requireIntegrationManagement(actor: User, scope: HospitalIntegrationScope): void {
  if (!["ADMIN", "SUPERADMIN", "MANAGER"].includes(actor.role) || !scope.departmentCodes.every((departmentCode) => (actor.role !== "MANAGER" || managerCanAccessDepartment(actor, departmentCode)) && canAccessResource(actor, "integration.manage", { departmentCode }))) throw new ApiError("SCOPE_DENIED", "Você não pode administrar esta credencial de integração.", 404);
}
export function requireIntegrationExchange(actor: User, departmentCode: string): void {
  const scoped = actor.role === "SUPERADMIN" || (actor.role === "MANAGER" ? managerCanAccessDepartment(actor, departmentCode) : actor.departmentCode === departmentCode);
  if (!scoped) throw new ApiError("SCOPE_DENIED", "A integração não está autorizada para este setor.", 404);
  requirePermission(actor, "integration.exchange", { departmentCode });
}
export function configuredIntegration(system: HospitalIntegrationSystem, loader: (system: HospitalIntegrationSystem) => HospitalIntegrationHttpConfig | undefined = hospitalIntegrationHttpConfigFromEnv): HospitalIntegrationHttpConfig {
  if (!["HIS", "LIS", "PACS"].includes(system)) throw new ApiError("VALIDATION_ERROR", "Sistema de integração inválido.", 400);
  let config: HospitalIntegrationHttpConfig | undefined; try { config = loader(system); if (config) validateHospitalIntegrationHttpConfig(config); } catch { throw new ApiError("INTEGRATION_CONFIGURATION_INVALID", "A integração não possui configuração aprovada válida.", 503); }
  if (!config) throw new ApiError("INTEGRATION_NOT_CONFIGURED", "Configure o contrato e as credenciais do sistema adotado antes de integrar.", 503);
  return config;
}
export function currentIntegrationCredential(state: StoreState, system: HospitalIntegrationSystem, token: string): { credential: HospitalIntegrationCredential; actor: User } {
  if (!/^cvg_int_[A-Za-z0-9_-]{43}$/.test(token)) throw new ApiError("INTEGRATION_UNAUTHORIZED", "Credencial de serviço indisponível.", 401);
  const digest = Buffer.from(integrationTokenHash(token), "hex");
  const credential = state.hospitalIntegrationCredentials.find((entry) => { const candidate = Buffer.from(entry.tokenHash, "hex"); return candidate.length === digest.length && timingSafeEqual(candidate, digest); });
  if (!credential?.active || credential.profile === "HIS_V4" || credential.system !== system || credential.purpose !== integrationPurposeFor(system) || !Number.isFinite(Date.parse(credential.expiresAt)) || Date.parse(credential.expiresAt) <= Date.now()) throw new ApiError("INTEGRATION_UNAUTHORIZED", "Credencial de serviço indisponível.", 401);
  const actor = requireActiveUser(state, state.users.find((entry) => entry.id === credential.actorUserId) ?? ({ id: credential.actorUserId } as User));
  if (actor.mustChangePassword) throw new ApiError("INTEGRATION_UNAUTHORIZED", "O ator da integração ainda não está habilitado.", 401);
  return { credential, actor };
}
function requireCredentialContext(scope: HospitalIntegrationScope, departmentCode: string, patientId?: string): void {
  if (!scope.departmentCodes.includes(departmentCode) || patientId && scope.patientIds && !scope.patientIds.includes(patientId)) throw new ApiError("SCOPE_DENIED", "O alvo está fora da finalidade e do escopo desta credencial.", 404);
}
export function authorizedIntegrationItem(state: StoreState, actor: User, itemId: string, system: "LIS" | "PACS", credential?: HospitalIntegrationCredential): DiagnosticItem {
  const item = state.items.find((entry) => entry.id === itemId); const request = item && state.requests.find((entry) => entry.id === item.requestId);
  if (!item || !request || (system === "LIS" ? item.workflowType !== "LABORATORY" : item.workflowType === "LABORATORY")) throw new ApiError("NOT_FOUND", "O item não está disponível para esta finalidade.", 404);
  const departmentCode = item.departmentCode;
  requireIntegrationExchange(actor, departmentCode); if (credential) requireCredentialContext(credential.scope, departmentCode, request.patientId);
  requireItemPermission(state, actor, "item.view", item); requireItemPermission(state, actor, "result.draft.create", item);
  const executor = item.workflowType === "LABORATORY" ? item.assignedUserId : state.procedures.find((entry) => entry.itemId === item.id)?.performedBy;
  if (executor !== actor.id) throw new ApiError("SCOPE_DENIED", "O rascunho externo exige o executor atual deste item.", 404);
  return item;
}
export function authorizeInboundIntegration(state: StoreState, actor: User, credential: HospitalIntegrationCredential, message: HospitalIntegrationMessageInput): void {
  if (message.purpose !== credential.purpose) throw new ApiError("INTEGRATION_PURPOSE_DENIED", "A mensagem não pertence à finalidade da credencial.", 403);
  if (message.purpose !== "HIS_INTAKE") { authorizedIntegrationItem(state, actor, message.payload.itemId, credential.system as "LIS" | "PACS", credential); return; }
  const context = { departmentCode: message.payload.departmentCode.toUpperCase(), patientId: message.payload.patientId, encounterId: message.payload.encounterId };
  requireCredentialContext(credential.scope, context.departmentCode, context.patientId); requireIntegrationExchange(actor, context.departmentCode); requireHospitalTaskAccess(state, actor, "hospital_intake.create", context);
  if (context.patientId) requirePatientPermission(state, actor, "patient.view", context.patientId);
}
