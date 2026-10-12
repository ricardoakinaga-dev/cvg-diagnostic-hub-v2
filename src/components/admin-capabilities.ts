import type { Permission } from "@cvg/contracts";
export function canAdminister(user: { permissions?: readonly Permission[] }, permission: Permission, legacy?: Permission): boolean {
  return user.permissions === undefined || user.permissions.includes(permission) || Boolean(legacy && user.permissions.includes(legacy));
}
