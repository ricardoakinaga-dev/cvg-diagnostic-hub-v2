import { LEGACY_PERMISSION_ACTIONS, PERMISSIONS, ROLES, type AccessGroup, type Permission, type RoleCode } from "@cvg/contracts";
import type { StoreState, User } from "../domain/models";
import { rolePermissions } from "./authorization";
import { canAccessResource, type ScopedResource } from "./authorization";
import { ApiError } from "../http/envelope";

export { LEGACY_PERMISSION_ACTIONS } from "@cvg/contracts";

export const PERMISSION_CODES: readonly Permission[] = [...PERMISSIONS].sort();
export const systemGroupId = (role: RoleCode): string => `access-group-${role.toLowerCase()}`;

export function activeSystemGroupId(state: Pick<StoreState, "accessGroups">, role: RoleCode): string {
  const groupId = systemGroupId(role);
  if (!state.accessGroups.some((group) => group.id === groupId && group.active)) throw new ApiError("VALIDATION_ERROR", "Reative o grupo base do perfil antes de criar este vínculo.", 400);
  return groupId;
}

export function expandLegacyPermissions(permissions: ReadonlyArray<Permission>): Permission[] {
  return [...new Set(permissions.flatMap((permission) => [permission, ...(LEGACY_PERMISSION_ACTIONS[permission] ?? [])]))];
}

export function initialSystemAccessGroups(timestamp: string): AccessGroup[] {
  return ROLES.map((role) => ({ id: systemGroupId(role), code: `PROFILE_${role}`, description: `Perfil inicial ${role}`, active: true, permissions: [...rolePermissions[role]], systemRole: role, version: 1, createdAt: timestamp, updatedAt: timestamp }));
}

/** A group narrows the approved profile ceiling; it never supplies clinical eligibility or scope. */
export function resolveUserPermissions(state: Pick<StoreState, "accessGroups">, user: Pick<User, "role" | "accessGroupId" | "active">): Permission[] {
  if (!user.active) return [];
  const ceiling = rolePermissions[user.role];
  if (!user.accessGroupId) return [...ceiling];
  const group = state.accessGroups.find((candidate) => candidate.id === user.accessGroupId);
  if (!group?.active) return [];
  const granted = new Set(expandLegacyPermissions(group.permissions));
  return ceiling.filter((permission) => granted.has(permission));
}

export function hydrateUserPermissions(state: Pick<StoreState, "accessGroups">, user: User): User {
  return { ...user, permissions: resolveUserPermissions(state, user) };
}

export function retainsAdministrativeAccess(state: Pick<StoreState, "accessGroups">, user: User): boolean {
  if (!user.active || (user.role !== "ADMIN" && user.role !== "SUPERADMIN")) return false;
  const permissions = new Set(resolveUserPermissions(state, user));
  return ["user.create", "user.update", "access_group.assign", "access_group.update"].every((permission) => permissions.has(permission as Permission));
}

export function assertAdministrativeAccessRetained(previous: Pick<StoreState, "users" | "accessGroups">, next: Pick<StoreState, "users" | "accessGroups">): void {
  if (previous.users.some((user) => retainsAdministrativeAccess(previous, user)) && !next.users.some((user) => retainsAdministrativeAccess(next, user))) {
    throw new ApiError("CONFLICT", "O último acesso administrativo efetivo não pode ser removido.", 409);
  }
  if (previous.users.some((user) => user.role === "SUPERADMIN" && retainsAdministrativeAccess(previous, user)) && !next.users.some((user) => user.role === "SUPERADMIN" && retainsAdministrativeAccess(next, user))) {
    throw new ApiError("CONFLICT", "O último superadministrador com acesso efetivo não pode ser removido.", 409);
  }
}

export function requireAnyPermission(actor: User, permissions: readonly Permission[], resource: ScopedResource = {}): void {
  if (!permissions.some((permission) => canAccessResource(actor, permission, resource))) throw new ApiError("SCOPE_DENIED", "Você não tem acesso a esta ação.", 404);
}
