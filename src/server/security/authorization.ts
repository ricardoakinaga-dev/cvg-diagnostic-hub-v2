import type { Permission, RoleCode } from "@cvg/contracts";
import type { Actor, ScopedResource } from "../domain/models";

export type { Actor, ScopedResource } from "../domain/models";

const commonRead: Permission[] = [
  "patient.view",
  "encounter.view",
  "admission.view",
  "request.view",
  "request.list",
  "item.view",
  "result.view",
  "result.history.view",
  "result.view.record",
  "attachment.view",
  "notification.view",
  "diagnostic.timeline.view",
  "timeline.view",
  "search.execute",
  "queue.view",
  "dashboard.view",
  "service.catalog.view",
  "realtime.connect"
];

export const rolePermissions: Record<RoleCode, readonly Permission[]> = {
  ADMIN: [
    "service.catalog.view",
    "realtime.connect",
    "service.catalog.manage",
    "sla_policy.manage",
    "critical_result_policy.manage",
    "reason_code.manage",
    "user_role.manage",
    "audit.view",
    "health.liveness",
    "health.readiness"
  ],
  MANAGER: [
    ...commonRead,
    "admission.context.manage",
    "request.create",
    "request.cancel",
    "request.duplicate_override",
    "item.cancel",
    "item.reject",
    "item.complete",
    "result.draft.create",
    "result.draft.edit_own",
    "result.release",
    "result.amend",
    "result.void",
    "result.review",
    "attachment.download",
    "notification.acknowledge",
    "attachment.upload_session",
    "attachment.finalize",
    "procedure.schedule",
    "procedure.reschedule",
    "procedure.start",
    "procedure.mark_performed",
    "sample.receive",
    "sample.process",
    "sample.recollection.request",
    "sample.replacement.receive",
    "service.catalog.manage",
    "sla_policy.manage",
    "reason_code.manage",
    "user_role.manage",
    "audit.view"
  ],
  VETERINARIAN: [
    ...commonRead,
    "patient.create",
    "request.create",
    "request.cancel",
    "request.duplicate_override",
    "item.cancel",
    "result.review",
    "attachment.download",
    "notification.acknowledge"
  ],
  INPATIENT_TEAM: [
    ...commonRead,
    "patient.create",
    "request.create",
    "request.cancel",
    "request.duplicate_override",
    "item.cancel",
    "result.review",
    "attachment.download",
    "notification.acknowledge"
  ],
  LAB_TECH: [
    ...commonRead,
    "sample.receive",
    "sample.process",
    "sample.recollection.request",
    "sample.replacement.receive",
    "result.draft.create",
    "result.draft.edit_own",
    "result.release",
    "result.amend",
    "result.void",
    "attachment.download",
    "attachment.upload_session",
    "attachment.finalize",
    "notification.acknowledge",
    "item.reject"
  ],
  RADIOLOGY_TEAM: [
    ...commonRead,
    "procedure.schedule",
    "procedure.reschedule",
    "procedure.start",
    "procedure.mark_performed",
    "result.draft.create",
    "result.draft.edit_own",
    "result.release",
    "result.amend",
    "result.void",
    "attachment.download",
    "attachment.upload_session",
    "attachment.finalize",
    "notification.acknowledge"
  ],
  ULTRASOUND_TEAM: [
    ...commonRead,
    "procedure.schedule",
    "procedure.reschedule",
    "procedure.start",
    "procedure.mark_performed",
    "result.draft.create",
    "result.draft.edit_own",
    "result.release",
    "result.amend",
    "result.void",
    "attachment.download",
    "attachment.upload_session",
    "attachment.finalize",
    "notification.acknowledge"
  ],
  VIEWER: commonRead
};

export function managerDepartmentCodes(actor: Pick<Actor, "departmentCode" | "managedDepartmentCodes">): string[] {
  return Array.from(new Set([actor.departmentCode, ...(actor.managedDepartmentCodes ?? [])].map((code) => code.trim().toUpperCase()))).filter(Boolean);
}

export function managerCanAccessDepartment(actor: Pick<Actor, "departmentCode" | "managedDepartmentCodes">, departmentCode: string): boolean {
  return managerDepartmentCodes(actor).includes(departmentCode.trim().toUpperCase());
}

export function hasPermission(role: RoleCode, permission: Permission): boolean {
  return rolePermissions[role].includes(permission);
}

export function hasPermissionForUser(user: Pick<Actor, "active" | "role">, permission: Permission): boolean {
  return user.active === true && hasPermission(user.role, permission);
}

export function canAccessResource(
  actor: Actor,
  permission: Permission,
  resource: ScopedResource
): boolean {
  if (actor.active === false || !hasPermission(actor.role, permission)) {
    return false;
  }

  if (actor.role === "ADMIN") {
    // The technical role may operate platform/configuration resources, but
    // cannot enter patient scope without an explicitly approved break-glass
    // capability that is not part of this local boundary.
    return !resource.patientId;
  }

  if (
    permission === "result.draft.edit_own" &&
    (!resource.ownerId || resource.ownerId !== actor.id)
  ) {
    return false;
  }

  const patientScopeApplies = ["VETERINARIAN", "INPATIENT_TEAM", "VIEWER"].includes(actor.role);
  if (patientScopeApplies && resource.patientId && !actor.patientIds?.includes(resource.patientId)) {
    return false;
  }

  const serviceScopeApplies = [
    "LAB_TECH",
    "RADIOLOGY_TEAM",
    "ULTRASOUND_TEAM"
  ].includes(actor.role);
  if (serviceScopeApplies && resource.departmentCode && resource.departmentCode !== actor.departmentCode) {
    return false;
  }

  if (serviceScopeApplies && resource.serviceCode) {
    const allowedServiceCodes = new Set(
      (actor.serviceCodes ?? []).map((code) => code.trim().toUpperCase())
    );
    if (!allowedServiceCodes.has(resource.serviceCode.trim().toUpperCase())) {
      return false;
    }
  }

  if (
    actor.role === "VETERINARIAN" ||
    actor.role === "INPATIENT_TEAM" ||
    actor.role === "VIEWER"
  ) {
    return resource.patientId ? Boolean(actor.patientIds?.includes(resource.patientId)) : true;
  }

  if (actor.role === "MANAGER") {
    if (resource.departmentCode) return managerCanAccessDepartment(actor, resource.departmentCode);
    if (resource.patientId) return false;
    return true;
  }

  return true;
}
