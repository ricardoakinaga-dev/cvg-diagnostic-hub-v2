import { randomBytes } from "node:crypto";
import type { HospitalInvitationAccepted, HospitalInvitationIssued, HospitalInvitationOptions, HospitalInvitationPreview, HospitalInvitationView, HospitalUserInvitation } from "@cvg/contracts";
import type { StoreState, User } from "../domain/models";
import type { ApplicationServiceContext } from "./service-context";
import type { CommandMeta } from "./service-types";
import type { z } from "zod";
import { hospitalInvitationCreateSchema, hospitalInvitationRevokeSchema, hospitalInvitationAcceptSchema, hospitalInvitationPreviewSchema } from "../http/hospital-institution-schemas";
import { ApiError } from "../http/envelope";
import { requireActiveUser, requirePermission, canManageUserTarget, normalizedEmail, operationalManagedRoles, ensureExpectedVersion, requireIdempotencyKey, saveIdempotency, withIdempotency, createAudit, id, now } from "./service-common";
import { validateTaskBody } from "./hospital-task-common";
import { requireActiveDepartment } from "./department-registry";
import { requireAnyPermission } from "../security/access-group-policy";
import { hashResetToken } from "../security/password-reset";
import { hashPassword } from "../security/password";
import { assertAcceptablePassword } from "../security/password-policy";
import { createManagementService } from "./management-service";
import { createAccessGroupService, delegatedPermissions } from "./access-group-service";
import { assignedServiceAccess } from "./executor-service-access";
import { transactionalServiceContext } from "./transactional-service-context";
import { requireHospitalOnboardingDepartment } from "./hospital-institution-policy";
type StoredInvitation = StoreState["hospitalUserInvitations"][number];
function publicInvitation(entry: StoredInvitation): HospitalUserInvitation { const { tokenHash: _hash, ...publicEntry } = entry; return structuredClone(publicEntry); }
function authorizeInviter(state: StoreState, actor: User, target: Pick<HospitalUserInvitation, "role" | "departmentCode" | "accessGroupId" | "expectedGroupVersion" | "serviceCodes">) {
  requirePermission(actor, "user_invite.manage", {}); requireAnyPermission(actor, ["user.create", "user_role.manage"]); requireAnyPermission(actor, ["access_group.assign", "user_role.manage"]);
  if (!operationalManagedRoles.includes(target.role) || !canManageUserTarget(actor, target.role, target.departmentCode)) throw new ApiError("SCOPE_DENIED", "Convite fora do seu escopo de administração.", 404);
  requireActiveDepartment(state, target.departmentCode);
  requireHospitalOnboardingDepartment(state, target.departmentCode);
  const group = state.accessGroups.find((entry) => entry.id === target.accessGroupId && entry.active);
  if (!group) throw new ApiError("SCOPE_DENIED", "Grupo indisponível para este convite.", 404);
  ensureExpectedVersion(group.version, target.expectedGroupVersion); delegatedPermissions(actor, group.permissions);
  assignedServiceAccess(state, target.role, target.departmentCode, target.serviceCodes);
}
function tokenInvitation(state: StoreState, hash: string): StoredInvitation {
  const entry = state.hospitalUserInvitations.find((entry) => entry.tokenHash === hash && entry.status === "PENDING" && Date.parse(entry.expiresAt) > Date.now());
  if (!entry) throw new ApiError("INVITATION_INVALID", "Convite inválido, expirado ou revogado.", 404);
  const issuer = state.users.find((user) => user.id === entry.issuedBy);
  try { if (!issuer) throw new Error("issuer absent"); authorizeInviter(state, requireActiveUser(state, issuer), entry); }
  catch { throw new ApiError("INVITATION_INVALID", "Convite inválido, expirado ou revogado.", 404); }
  return entry;
}
function existingInvitation(state: StoreState, actor: User, invitationId: string): StoredInvitation {
  requirePermission(actor, "user_invite.manage", {}); const entry = state.hospitalUserInvitations.find((entry) => entry.id === invitationId);
  if (!entry || !canManageUserTarget(actor, entry.role, entry.departmentCode)) throw new ApiError("SCOPE_DENIED", "Convite indisponível.", 404);
  return entry;
}
export function createHospitalInvitationService(context: ApplicationServiceContext) {
  const { store } = context;
  return {
    async getHospitalInvitationOptions(actor: User): Promise<HospitalInvitationOptions> {
      const state = await store.readState(); const current = requireActiveUser(state, actor); requirePermission(current, "user_invite.manage", {}); requireAnyPermission(current, ["user.create", "user_role.manage"]); requireAnyPermission(current, ["access_group.assign", "user_role.manage"]);
      return { roles: [...operationalManagedRoles], departments: state.departments.filter((entry) => entry.active && operationalManagedRoles.some((role) => canManageUserTarget(current, role, entry.code))).map(({ code, name }) => ({ code, name })), groups: state.accessGroups.filter((group) => { if (!group.active) return false; try { delegatedPermissions(current, group.permissions); return true; } catch { return false; } }).map(({ id, code, description, version }) => ({ id, code, description, version })) };
    },
    async listHospitalUserInvitations(actor: User): Promise<HospitalInvitationView[]> {
      const state = await store.readState(); const current = requireActiveUser(state, actor); requirePermission(current, "user_invite.manage", {});
      return state.hospitalUserInvitations.filter((entry) => canManageUserTarget(current, entry.role, entry.departmentCode)).map((entry) => ({ invitation: publicInvitation(entry), expired: entry.status === "PENDING" && Date.parse(entry.expiresAt) <= Date.now() }));
    },
    async createHospitalUserInvitation(actor: User, input: z.input<typeof hospitalInvitationCreateSchema> & CommandMeta): Promise<HospitalInvitationIssued> {
      validateTaskBody(hospitalInvitationCreateSchema, input);
      return store.transaction<HospitalInvitationIssued>((state) => {
        const current = requireActiveUser(state, actor); const target = { ...input, departmentCode: input.departmentCode.toUpperCase() }; authorizeInviter(state, current, target); requireIdempotencyKey(input.idempotencyKey);
        const scope = "POST:/hospital-user-invitations"; const replay = withIdempotency<HospitalInvitationIssued>(state, current.id, scope, input.idempotencyKey, { input });
        if (replay.found) return { state, result: { invitation: publicInvitation(existingInvitation(state, current, replay.existing!.invitation.id)), tokenReturnedOnce: false } };
        const email = normalizedEmail(input.email); if (state.users.some((user) => user.email.toLowerCase() === email)) throw new ApiError("CONFLICT", "Já existe um usuário com esse e-mail.", 409);
        if (state.hospitalUserInvitations.some((entry) => entry.email === email && entry.status === "PENDING" && Date.parse(entry.expiresAt) > Date.now())) throw new ApiError("CONFLICT", "Revogue o convite vigente antes de emitir outro.", 409);
        const token = randomBytes(32).toString("base64url"); const timestamp = now();
        const entry: StoredInvitation = { id: id("hospital-invitation"), email, displayName: input.displayName.trim(), role: input.role, departmentCode: target.departmentCode, accessGroupId: input.accessGroupId, expectedGroupVersion: input.expectedGroupVersion, serviceCodes: input.serviceCodes, issuedBy: current.id, tokenHash: hashResetToken(token), status: "PENDING", expiresAt: new Date(Date.now() + input.expiresInHours * 3_600_000).toISOString(), version: 1, createdAt: timestamp, updatedAt: timestamp };
        const invitation = publicInvitation(entry); const next = { ...state, hospitalUserInvitations: [...state.hospitalUserInvitations, entry], auditEvents: [...state.auditEvents, createAudit("HospitalUserInvitationIssued", current.id, "HospitalUserInvitation", entry.id, input.correlationId ?? id("corr"), undefined, "PENDING", { departmentCode: entry.departmentCode, role: entry.role, accessGroupId: entry.accessGroupId, expiresAt: entry.expiresAt })] };
        // Never persist the raw token in a command replay or audit record.
        return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, { invitation, tokenReturnedOnce: false }, { input }), result: { invitation, token, tokenReturnedOnce: true } };
      });
    },
    async revokeHospitalUserInvitation(actor: User, invitationId: string, input: z.input<typeof hospitalInvitationRevokeSchema> & CommandMeta): Promise<HospitalInvitationView> {
      validateTaskBody(hospitalInvitationRevokeSchema, input);
      return store.transaction((state) => {
        const current = requireActiveUser(state, actor); const previous = existingInvitation(state, current, invitationId); requireIdempotencyKey(input.idempotencyKey); const scope = `POST:/hospital-user-invitations/${invitationId}/revoke`;
        const replay = withIdempotency<HospitalInvitationView>(state, current.id, scope, input.idempotencyKey, { input }); if (replay.found) return { state, result: { invitation: publicInvitation(previous), expired: false } };
        ensureExpectedVersion(previous.version, input.expectedVersion); if (previous.status !== "PENDING") throw new ApiError("INVALID_STATE_TRANSITION", "Esse convite já foi encerrado.", 409);
        const timestamp = now(); const entry: StoredInvitation = { ...previous, status: "REVOKED", revokedAt: timestamp, updatedAt: timestamp, version: previous.version + 1 }; const result = { invitation: publicInvitation(entry), expired: false };
        const next = { ...state, hospitalUserInvitations: state.hospitalUserInvitations.map((row) => row.id === entry.id ? entry : row), auditEvents: [...state.auditEvents, createAudit("HospitalUserInvitationRevoked", current.id, "HospitalUserInvitation", entry.id, input.correlationId ?? id("corr"), "PENDING", "REVOKED", { departmentCode: entry.departmentCode, version: entry.version })] };
        return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, result, { input }), result };
      });
    },
    async previewHospitalUserInvitation(input: z.input<typeof hospitalInvitationPreviewSchema>): Promise<HospitalInvitationPreview> {
      validateTaskBody(hospitalInvitationPreviewSchema, input); const state = await store.readState(); const entry = tokenInvitation(state, hashResetToken(input.token)); const [local, domain] = entry.email.split("@");
      return { institutionName: state.hospitalInstitutionSettings[0]?.name ?? "CVG", displayName: entry.displayName, maskedEmail: `${local.slice(0, 1)}***@${domain}`, expiresAt: entry.expiresAt };
    },
    async acceptHospitalUserInvitation(input: z.input<typeof hospitalInvitationAcceptSchema> & { correlationId?: string }): Promise<HospitalInvitationAccepted> {
      validateTaskBody(hospitalInvitationAcceptSchema, input); const hash = hashResetToken(input.token); const initial = tokenInvitation(await store.readState(), hash);
      await assertAcceptablePassword(input.password, { email: initial.email, displayName: initial.displayName });
      const passwordHash = hashPassword(input.password);
      return store.transaction(async (state, audit) => {
        const entry = tokenInvitation(state, hash); const issuer = requireActiveUser(state, state.users.find((user) => user.id === entry.issuedBy)!);
        // An archived sector blocks onboarding while existing users retain their pending work.
        requireHospitalOnboardingDepartment(state, entry.departmentCode);
        const local = transactionalServiceContext(context, state, audit);
        const created = await createManagementService(local.context).createManagedUser(issuer, { email: entry.email, displayName: entry.displayName, role: entry.role, departmentCode: entry.departmentCode, serviceCodes: entry.serviceCodes, timezone: state.hospitalInstitutionSettings[0]?.timezone, idempotencyKey: `invitation-create:${entry.id}`, correlationId: input.correlationId });
        await createAccessGroupService(local.context).assignUserAccessGroup(issuer, created.id, { accessGroupId: entry.accessGroupId, expectedGroupVersion: entry.expectedGroupVersion, expectedVersion: created.version, idempotencyKey: `invitation-group:${entry.id}`, correlationId: input.correlationId });
        const current = local.state(); const timestamp = now();
        const invitation: StoredInvitation = { ...entry, status: "ACCEPTED", acceptedBy: created.id, acceptedAt: timestamp, updatedAt: timestamp, version: entry.version + 1 };
        return { state: { ...current, users: current.users.map((user) => user.id === created.id ? { ...user, passwordHash, mustChangePassword: false, version: user.version + 1 } : user), hospitalUserInvitations: current.hospitalUserInvitations.map((row) => row.id === entry.id ? invitation : row), auditEvents: [...current.auditEvents, createAudit("HospitalUserInvitationAccepted", created.id, "HospitalUserInvitation", entry.id, input.correlationId ?? id("corr"), "PENDING", "ACCEPTED", { issuedBy: entry.issuedBy, departmentCode: entry.departmentCode, version: invitation.version })] }, result: { accepted: true as const, userId: created.id, nextAction: "LOGIN" as const } };
      });
    }
  };
}
