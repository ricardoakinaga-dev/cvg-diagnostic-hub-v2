import { createHash } from "node:crypto";
import { ROLES, type EffectiveAccessPreview, type AccessGroupImpactPreview, type AccessGroup, type PatientGrant, type Permission } from "@cvg/contracts";
import type { StoreState, User } from "../domain/models";
import type { ApplicationServiceContext } from "./service-context";
import type { CommandMeta } from "./service-types";
import { ApiError } from "../http/envelope";
import { rolePermissions } from "../security/authorization";
import { assertAdministrativeAccessRetained, expandLegacyPermissions, PERMISSION_CODES, requireAnyPermission, resolveUserPermissions } from "../security/access-group-policy";
import { canManageUserTarget, createAudit, ensureExpectedVersion, findOrThrow, hasManagerPatientContext, id, managedUser, now, operationalManagedRoles, requireActiveUser, requireIdempotencyKey, requireRecentReauthentication, requireText, saveIdempotency, withIdempotency } from "./service-common";

export type AccessGroupCreateInput = CommandMeta & { code: string; description: string; permissions: Permission[] };
export type AccessGroupPatchInput = CommandMeta & { description?: string; permissions?: Permission[]; active?: boolean; expectedImpactToken?: string };
export type UserGroupAssignmentInput = CommandMeta & { accessGroupId: string; expectedGroupVersion?: number };
export type EffectiveAccessPreviewInput = { accessGroupId?: string; permissions?: Permission[] };
export type PatientGrantInput = CommandMeta & { patientId: string; active: boolean; reason: string };

function targetFor(state: StoreState, actor: User, userId: string): User {
  const target = findOrThrow(state.users.find((user) => user.id === userId));
  if (!canManageUserTarget(actor, target.role, target.departmentCode)) throw new ApiError("SCOPE_DENIED", "Colaborador fora do escopo de administração.", 404);
  return target;
}

export function delegatedPermissions(actor: User, permissions: readonly Permission[]): Permission[] {
  if (permissions.length > PERMISSION_CODES.length || new Set(permissions).size !== permissions.length || permissions.some((permission) => !PERMISSION_CODES.includes(permission))) throw new ApiError("VALIDATION_ERROR", "Matriz de permissões inválida.", 400);
  const roles = actor.role === "SUPERADMIN" ? ROLES : actor.role === "ADMIN" ? ROLES.filter((role) => role !== "SUPERADMIN") : operationalManagedRoles;
  const ceiling = new Set(roles.flatMap((role) => rolePermissions[role]));
  const expanded = expandLegacyPermissions(permissions);
  if (expanded.some((permission) => !ceiling.has(permission))) throw new ApiError("FORBIDDEN", "A matriz ultrapassa o limite de delegação do seu perfil.", 403);
  return [...permissions];
}

function impact(state: StoreState, actor: User, nextGroups: AccessGroup[], users = state.users, requireReauthentication = true) {
  const proposed = { ...state, accessGroups: nextGroups, users };
  const affected = users.filter((user) => JSON.stringify(resolveUserPermissions(state, state.users.find((old) => old.id === user.id) ?? user)) !== JSON.stringify(resolveUserPermissions(proposed, user)) || user.accessGroupId !== state.users.find((old) => old.id === user.id)?.accessGroupId);
  for (const user of affected) {
    targetFor(state, actor, user.id);
    if (user.id === actor.id) throw new ApiError("FORBIDDEN", "A própria sessão não pode alterar seu grupo ou suas permissões.", 403);
    if (requireReauthentication && (user.role === "ADMIN" || user.role === "SUPERADMIN")) requireRecentReauthentication(actor);
  }
  assertAdministrativeAccessRetained(state, proposed);
  const timestamp = now();
  const ids = new Set(affected.map((user) => user.id));
  return { ...proposed, users: users.map((user) => ids.has(user.id) ? { ...user, version: user.version + 1 } : user), sessions: state.sessions.map((session) => ids.has(session.userId) && !session.revokedAt ? { ...session, revokedAt: timestamp, version: session.version + 1 } : session), affected };
}

function requireGroupChange(actor: User, input: AccessGroupPatchInput): void {
  requireAnyPermission(actor, ["user_role.manage", input.active === false ? "access_group.deactivate" : "access_group.update"]);
  if (input.active === false && (input.permissions !== undefined || input.description !== undefined)) requireAnyPermission(actor, ["user_role.manage", "access_group.update"]);
}
function proposedGroup(previous: AccessGroup, actor: User, input: AccessGroupPatchInput): AccessGroup {
  if (input.expectedVersion === undefined) throw new ApiError("VALIDATION_ERROR", "expectedVersion é obrigatório.", 400);
  ensureExpectedVersion(previous.version, input.expectedVersion);
  if (input.description === undefined && input.permissions === undefined && input.active === undefined) throw new ApiError("VALIDATION_ERROR", "Informe uma alteração no grupo.", 400);
  return { ...previous, description: input.description === undefined ? previous.description : requireText(input.description, "descrição", 160), permissions: input.permissions === undefined ? previous.permissions : delegatedPermissions(actor, input.permissions), active: input.active ?? previous.active };
}
function groupBindings(state: StoreState, actor: User, groupId: string): User[] {
  const bound = state.users.filter((user) => user.accessGroupId === groupId).sort((a, b) => a.id.localeCompare(b.id));
  for (const user of bound) targetFor(state, actor, user.id);
  return bound;
}
function groupImpactPreview(state: StoreState, actor: User, previous: AccessGroup, candidate: AccessGroup): AccessGroupImpactPreview {
  // The preview is complete or denied, including unchanged/reduced/inactive bindings.
  const bound = groupBindings(state, actor, previous.id);
  const changed = impact(state, actor, state.accessGroups.map((group) => group.id === previous.id ? candidate : group), state.users, false);
  const users = bound.map((user) => {
    const beforePermissions = resolveUserPermissions(state, user); const permissions = resolveUserPermissions(changed, user);
    const addedPermissions = permissions.filter((permission) => !beforePermissions.includes(permission)); const removedPermissions = beforePermissions.filter((permission) => !permissions.includes(permission));
    return { userId: user.id, displayName: user.displayName, role: user.role, userVersion: user.version, active: user.active === true, departmentCode: user.departmentCode, managedDepartmentCodes: [...user.managedDepartmentCodes ?? []], serviceCodes: [...user.serviceCodes ?? []], patientCount: user.patientIds?.length ?? 0, beforePermissions, permissions, addedPermissions, removedPermissions, effectiveAccessChanges: addedPermissions.length > 0 || removedPermissions.length > 0 };
  });
  const tokenInput = { groupId: previous.id, groupVersion: previous.version, description: candidate.description, active: candidate.active, permissions: [...candidate.permissions].sort(), users: bound.map((user) => ({ id: user.id, version: user.version, active: user.active, role: user.role, departmentCode: user.departmentCode, managedDepartmentCodes: [...user.managedDepartmentCodes ?? []].sort(), serviceCodes: [...user.serviceCodes ?? []].sort(), patientIds: [...user.patientIds ?? []].sort() })) };
  return { groupId: previous.id, groupVersion: previous.version, proposedActive: candidate.active, permissions: [...candidate.permissions], impactToken: createHash("sha256").update(JSON.stringify(tokenInput)).digest("hex"), boundUserCount: users.length, affectedUserCount: users.filter((user) => user.effectiveAccessChanges).length, activeAffectedUserCount: users.filter((user) => user.active && user.effectiveAccessChanges).length, requiresReauthentication: changed.affected.some((user) => user.role === "ADMIN" || user.role === "SUPERADMIN"), users };
}

function preview(state: StoreState, target: User, input: EffectiveAccessPreviewInput): EffectiveAccessPreview {
  const accessGroupId = input.accessGroupId ?? target.accessGroupId;
  const group = state.accessGroups.find((entry) => entry.id === accessGroupId);
  if (input.accessGroupId && !group) throw new ApiError("NOT_FOUND", "Grupo não encontrado.", 404);
  if (input.permissions && !group) throw new ApiError("VALIDATION_ERROR", "Informe um grupo para simular a matriz.", 400);
  const groups = input.permissions ? state.accessGroups.map((entry) => entry.id === group!.id ? { ...entry, permissions: input.permissions! } : entry) : state.accessGroups;
  const simulated = { ...target, accessGroupId };
  const permissions = resolveUserPermissions({ accessGroups: groups }, simulated);
  const before = resolveUserPermissions(state, target);
  const ceiling = new Set(rolePermissions[target.role]);
  return { userId: target.id, userVersion: target.version, groupVersion: group?.version, role: target.role, accessGroupId, groupActive: group?.active ?? !accessGroupId, origin: accessGroupId ? "GROUP" : "LEGACY_PROFILE", permissions, deniedByProfile: expandLegacyPermissions(input.permissions ?? group?.permissions ?? []).filter((permission) => !ceiling.has(permission)), addedPermissions: permissions.filter((permission) => !before.includes(permission)), removedPermissions: before.filter((permission) => !permissions.includes(permission)), scopes: { departmentCode: target.departmentCode, managedDepartmentCodes: [...(target.managedDepartmentCodes ?? [])], serviceCodes: [...(target.serviceCodes ?? [])], patientCount: target.patientIds?.length ?? 0, globalPatients: target.role === "SUPERADMIN" }, restrictions: ["O grupo limita o perfil; não altera elegibilidade clínica.", "Escopos de paciente, setor, serviço e autoria continuam obrigatórios.", "Estado clínico, sessão, CSRF e reautenticação permanecem obrigatórios.", ...(target.role === "ADMIN" ? ["ADMIN mantém administração técnica e não recebe operação clínica."] : [])] };
}

export function createAccessGroupService({ store }: ApplicationServiceContext) {
  return {
    async listDelegablePermissions(actor: User): Promise<Permission[]> {
      const state = await store.readState();
      const current = requireActiveUser(state, actor);
      requireAnyPermission(current, ["user_role.manage", "access_group.view"]);
      return PERMISSION_CODES.filter((permission) => {
        if (permission === "user_role.manage" || permission === "service.catalog.manage") return false;
        try { delegatedPermissions(current, [permission]); return true; } catch { return false; }
      });
    },
    async listAccessGroups(actor: User): Promise<AccessGroup[]> {
      const state = await store.readState();
      const current = requireActiveUser(state, actor);
      requireAnyPermission(current, ["user_role.manage", "access_group.view"]);
      return state.accessGroups.map((group) => ({ ...group, permissions: [...group.permissions] })).sort((a, b) => a.code.localeCompare(b.code));
    },
    async createAccessGroup(actor: User, input: AccessGroupCreateInput): Promise<AccessGroup> {
      return store.transaction((state) => {
        const current = requireActiveUser(state, actor);
        requireAnyPermission(current, ["user_role.manage", "access_group.create"]);
        requireIdempotencyKey(input.idempotencyKey);
        const replay = withIdempotency<AccessGroup>(state, current.id, "POST:/access-groups", input.idempotencyKey, { input });
        if (replay.found) return { state, result: replay.existing! };
        const code = requireText(input.code, "código do grupo", 60).toUpperCase();
        if (!/^[A-Z][A-Z0-9_-]{1,59}$/.test(code)) throw new ApiError("VALIDATION_ERROR", "Código de grupo inválido.", 400);
        if (state.accessGroups.some((group) => group.code === code)) throw new ApiError("CONFLICT", "Código de grupo já utilizado.", 409);
        const timestamp = now();
        const group: AccessGroup = { id: id("access-group"), code, description: requireText(input.description, "descrição", 160), permissions: delegatedPermissions(current, input.permissions), active: true, version: 1, createdAt: timestamp, updatedAt: timestamp };
        const next = { ...state, accessGroups: [...state.accessGroups, group], auditEvents: [...state.auditEvents, createAudit("AccessGroupCreated", current.id, "AccessGroup", group.id, input.correlationId ?? id("corr"), undefined, "ACTIVE", { code, permissions: JSON.stringify(group.permissions) })] };
        return { state: saveIdempotency(next, current.id, "POST:/access-groups", input.idempotencyKey, group, { input }), result: group };
      });
    },
    async updateAccessGroup(actor: User, groupId: string, input: AccessGroupPatchInput): Promise<AccessGroup> {
      return store.transaction((state) => {
        const current = requireActiveUser(state, actor);
        requireGroupChange(current, input);
        requireIdempotencyKey(input.idempotencyKey);
        const previous = findOrThrow(state.accessGroups.find((group) => group.id === groupId));
        groupBindings(state, current, groupId);
        if (input.permissions !== undefined) delegatedPermissions(current, input.permissions);
        const scope = `PATCH:/access-groups/${groupId}`;
        const replay = withIdempotency<AccessGroup>(state, current.id, scope, input.idempotencyKey, { input });
        if (replay.found) return { state, result: replay.existing! };
        const proposed = proposedGroup(previous, current, input);
        const preview = groupImpactPreview(state, current, previous, proposed);
        if (input.expectedImpactToken !== undefined && input.expectedImpactToken !== preview.impactToken) throw new ApiError("STALE_VERSION", "O impacto mudou. Atualize a prévia antes de salvar.", 409);
        const updated = { ...proposed, version: previous.version + 1, updatedAt: now() };
        const changed = impact(state, current, state.accessGroups.map((group) => group.id === groupId ? updated : group));
        const { affected, ...next } = changed;
        next.auditEvents = [...state.auditEvents, createAudit("AccessGroupUpdated", current.id, "AccessGroup", groupId, input.correlationId ?? id("corr"), String(previous.version), String(updated.version), { active: updated.active, previousPermissions: JSON.stringify(previous.permissions), permissions: JSON.stringify(updated.permissions), affectedUserIds: JSON.stringify(affected.map((user) => user.id)), sessionsRevoked: changed.sessions.filter((session, index) => session !== state.sessions[index]).length })];
        return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, updated, { input }), result: updated };
      });
    },
    async previewAccessGroupImpact(actor: User, groupId: string, input: AccessGroupPatchInput): Promise<AccessGroupImpactPreview> {
      const state = await store.readState(); const current = requireActiveUser(state, actor);
      requireGroupChange(current, input);
      const previous = findOrThrow(state.accessGroups.find((group) => group.id === groupId));
      return groupImpactPreview(state, current, previous, proposedGroup(previous, current, input));
    },
    async assignUserAccessGroup(actor: User, userId: string, input: UserGroupAssignmentInput) {
      return store.transaction((state) => {
        const current = requireActiveUser(state, actor);
        requireAnyPermission(current, ["user_role.manage", "access_group.assign"]);
        requireIdempotencyKey(input.idempotencyKey);
        const target = targetFor(state, current, userId);
        if (target.id === current.id) throw new ApiError("FORBIDDEN", "A própria sessão não pode trocar seu grupo.", 403);
        if (target.role === "ADMIN" || target.role === "SUPERADMIN") requireRecentReauthentication(current);
        const group = findOrThrow(state.accessGroups.find((entry) => entry.id === input.accessGroupId));
        if (!group.active) throw new ApiError("VALIDATION_ERROR", "O grupo deve estar ativo para receber um vínculo.", 400);
        delegatedPermissions(current, group.permissions);
        const scope = `PUT:/users/${userId}/access-group`;
        const replay = withIdempotency<ReturnType<typeof managedUser>>(state, current.id, scope, input.idempotencyKey, { input });
        if (replay.found) return { state, result: replay.existing! };
        if (input.expectedVersion === undefined) throw new ApiError("VALIDATION_ERROR", "expectedVersion é obrigatório.", 400);
        ensureExpectedVersion(target.version, input.expectedVersion);
        if (input.expectedGroupVersion !== undefined) ensureExpectedVersion(group.version, input.expectedGroupVersion);
        const changed = impact(state, current, state.accessGroups, state.users.map((user) => user.id === userId ? { ...user, accessGroupId: group.id } : user));
        const { affected: _affected, ...next } = changed;
        next.auditEvents = [...state.auditEvents, createAudit("UserAccessGroupAssigned", current.id, "User", userId, input.correlationId ?? id("corr"), target.accessGroupId ?? "LEGACY_PROFILE", group.id, { role: target.role, departmentCode: target.departmentCode, effectivePermissions: JSON.stringify(resolveUserPermissions(next, next.users.find((user) => user.id === userId)!)) })];
        const result = managedUser(next.users.find((user) => user.id === userId)!);
        return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, result, { input }), result };
      });
    },
    async previewUserAccess(actor: User, userId: string, input: EffectiveAccessPreviewInput = {}): Promise<EffectiveAccessPreview> {
      const state = await store.readState();
      const current = requireActiveUser(state, actor);
      requireAnyPermission(current, ["user_role.manage", "access_group.view"]);
      const target = targetFor(state, current, userId);
      if (input.permissions) delegatedPermissions(current, input.permissions);
      return preview(state, target, input);
    },
    async listPatientGrants(actor: User, userId: string): Promise<PatientGrant[]> {
      const state = await store.readState();
      const current = requireActiveUser(state, actor);
      requireAnyPermission(current, ["user_role.manage", "patient_scope.manage"]);
      targetFor(state, current, userId);
      return state.patientGrants.filter((grant) => grant.userId === userId && (current.role !== "MANAGER" || hasManagerPatientContext(state, current, grant.patientId))).map((grant) => ({ ...grant }));
    },
    async changePatientGrant(actor: User, userId: string, input: PatientGrantInput): Promise<PatientGrant> {
      return store.transaction((state) => {
        const current = requireActiveUser(state, actor);
        requireAnyPermission(current, ["user_role.manage", "patient_scope.manage"]);
        requireIdempotencyKey(input.idempotencyKey);
        const target = targetFor(state, current, userId);
        if (!["VETERINARIAN", "INPATIENT_TEAM", "VIEWER"].includes(target.role)) throw new ApiError("VALIDATION_ERROR", "Este perfil usa escopo por setor/serviço ou acesso global, não concessão individual de paciente.", 400);
        if (!state.patients.some((patient) => patient.id === input.patientId) || (current.role === "MANAGER" && !hasManagerPatientContext(state, current, input.patientId))) throw new ApiError("NOT_FOUND", "Paciente fora do escopo de delegação.", 404);
        const reason = requireText(input.reason, "motivo contextual da concessão ou retirada", 500);
        const scope = `PUT:/users/${userId}/patient-grants/${input.patientId}`;
        const replay = withIdempotency<PatientGrant>(state, current.id, scope, input.idempotencyKey, { input });
        if (replay.found) return { state, result: replay.existing! };
        if (input.expectedVersion === undefined) throw new ApiError("VALIDATION_ERROR", "expectedVersion do usuário é obrigatório.", 400);
        ensureExpectedVersion(target.version, input.expectedVersion);
        const previous = state.patientGrants.find((grant) => grant.userId === userId && grant.patientId === input.patientId);
        const timestamp = now();
        const grant: PatientGrant = { ...(previous ?? { id: id("patient-grant"), userId, patientId: input.patientId, createdAt: timestamp, version: 0 }), source: "ADMIN", grantedBy: current.id, active: input.active, version: (previous?.version ?? 0) + 1, updatedAt: timestamp };
        const patientIds = [...new Set(input.active ? [...(target.patientIds ?? []), input.patientId] : (target.patientIds ?? []).filter((patientId) => patientId !== input.patientId))];
        const updated = { ...target, patientIds, version: target.version + 1 };
        const next = { ...state, users: state.users.map((user) => user.id === userId ? updated : user), patientGrants: previous ? state.patientGrants.map((entry) => entry.id === previous.id ? grant : entry) : [...state.patientGrants, grant], sessions: state.sessions.map((session) => session.userId === userId && !session.revokedAt ? { ...session, revokedAt: timestamp, version: session.version + 1 } : session), auditEvents: [...state.auditEvents, createAudit("PatientScopeChanged", current.id, "User", userId, input.correlationId ?? id("corr"), previous?.active ? "GRANTED" : "DENIED", grant.active ? "GRANTED" : "DENIED", { patientId: input.patientId, reason, source: grant.source, grantId: grant.id, departmentCode: target.departmentCode })] };
        return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, grant, { input }), result: grant };
      });
    }
  };
}
