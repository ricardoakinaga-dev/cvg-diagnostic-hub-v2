import type { Permission, RoleCode } from "@cvg/contracts";
import type { Actor, ScopedResource } from "../domain/models";

export type { Actor, ScopedResource } from "../domain/models";

const commonRead: Permission[] = [
  "hospital_task.comment.view",
  "hospital_task.attachment.view",
  "hospital_task.attachment.download",
  "work_notification.view",
  "work_notification.read",
  "work_notification.archive",
  "work_notification.preferences.manage",
  "work_activity.preference.manage",
  "hospital_document.view",
  "hospital_metric.view",
  "hospital_report.view",
  "hospital_report.manage",
  "hospital_report.export",

  "plan.view",
  "shift.view",
  "checklist_template.view",
  "recurrence.view",
  "hospital_resource.view",
  "hospital_calendar.view",
  "hospital_capacity.view",

  "planner_view.view", "planner_view.create", "planner_view.update", "planner_view.deactivate",
  "hospital_task.view", "hospital_intake.view",
  "department.view",
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

const hospitalTaskWrite: Permission[] = ["hospital_task.create", "hospital_task.update", "hospital_task.execute", "hospital_task.assign", "hospital_task.priority.update", "hospital_task.dependency.manage", "hospital_intake.create", "hospital_intake.triage"];

const scopedRolePermissions: Record<Exclude<RoleCode, "SUPERADMIN">, readonly Permission[]> = {
  ADMIN: [
    "integration.manage",
    "work_notification.view",
    "work_notification.read",
    "work_notification.archive",
    "work_notification.preferences.manage",
    "work_activity.preference.manage",
    "hospital_document.view",
    "hospital_document.create",
    "hospital_document.update",
    "hospital_document.retire",
    "hospital_document.lock",
    "hospital_document.archive",
    "institution.manage",
    "department.capabilities.manage",
    "user_invite.manage",

    "checklist_template.view",
    "checklist_template.manage",
    "hospital_resource.view",
    "hospital_resource.create",
    "hospital_resource.update",
    "hospital_resource.deactivate",

    "hospital_task_type.manage",
    "access_group.view", "access_group.create", "access_group.update", "access_group.deactivate", "access_group.assign", "patient_scope.manage",
    "user.view", "user.create", "user.update", "user.deactivate",
    "service.catalog.create", "service.catalog.update", "service.catalog.deactivate",
    "department.view", "department.create", "department.update", "department.deactivate", "department.members.manage",
    "service.catalog.view",
    "realtime.connect",
    "service.catalog.manage",
    "sla_policy.manage",
    "critical_result_policy.manage",
    "reason_code.manage",
    "user_role.manage",
    "patient.data_export",
    "audit.view",
    "health.liveness",
    "health.readiness",
    "outbox.manage"
  ],
  MANAGER: [
    "integration.manage", "integration.exchange",
    "hospital_task.comment.create",
    "hospital_task.comment.edit_own",
    "hospital_task.attachment.upload",
    "hospital_task.archive",
    "hospital_task.restore",
    "hospital_task.comment.moderate",
    "hospital_document.create",
    "hospital_document.update",
    "hospital_document.retire",
    "hospital_document.lock",
    "hospital_document.archive",
    "hospital_document.approve",
    "user_invite.manage",

    "plan.create",
    "plan.update",
    "plan.archive",
    "shift.manage",
    "shift.assign",
    "handoff.offer",
    "handoff.accept",
    "checklist_template.manage",
    "checklist_template.approve",
    "checklist.execute",
    "recurrence.manage",
    "care.execute",
    "hospital_resource.create",
    "hospital_resource.update",
    "hospital_resource.deactivate",
    "hospital_calendar.reserve",
    "hospital_calendar.reschedule",
    "hospital_calendar.cancel",

    "planner_view.share",
    ...hospitalTaskWrite,
    "item.assignment.update", "item.priority.update", "item.plan.update",
    "exam_definition.approve",
    "access_group.view", "access_group.create", "access_group.update", "access_group.deactivate", "access_group.assign", "patient_scope.manage",
    "user.view", "user.create", "user.update", "user.deactivate",
    "service.catalog.create", "service.catalog.update", "service.catalog.deactivate",
    "department.update", "department.members.manage",
    ...commonRead,
    "admission.context.manage",
    "encounter.manage",
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
    "integration.exchange",
    "hospital_task.comment.create",
    "hospital_task.comment.edit_own",
    "hospital_task.attachment.upload",
    "hospital_task.archive",
    "hospital_task.restore",
    "hospital_document.create",
    "hospital_document.update",
    "hospital_document.retire",
    "hospital_document.lock",
    "hospital_document.archive",
    "hospital_document.approve",

    "plan.create",
    "plan.update",
    "plan.archive",
    "handoff.offer",
    "handoff.accept",
    "checklist_template.manage",
    "checklist_template.approve",
    "checklist.execute",
    "recurrence.manage",
    "care.execute",
    "hospital_calendar.reserve",
    "hospital_calendar.reschedule",
    "hospital_calendar.cancel",

    ...hospitalTaskWrite,
    "item.priority.update",
    "exam_definition.approve",
    ...commonRead,
    "patient.create",
    "encounter.manage",
    "request.create",
    "request.cancel",
    "request.duplicate_override",
    "item.cancel",
    "result.review",
    "attachment.download",
    "notification.acknowledge"
  ],
  INPATIENT_TEAM: [
    "integration.exchange",
    "hospital_task.comment.create",
    "hospital_task.comment.edit_own",
    "hospital_task.attachment.upload",
    "hospital_task.archive",
    "hospital_task.restore",
    "hospital_document.create",
    "hospital_document.update",
    "hospital_document.retire",
    "hospital_document.lock",
    "hospital_document.archive",

    "plan.create",
    "plan.update",
    "plan.archive",
    "handoff.offer",
    "handoff.accept",
    "checklist.execute",
    "recurrence.manage",
    "care.execute",
    "hospital_calendar.reserve",
    "hospital_calendar.reschedule",
    "hospital_calendar.cancel",

    ...hospitalTaskWrite,
    "item.priority.update",
    ...commonRead,
    "patient.create",
    "encounter.manage",
    "request.create",
    "request.cancel",
    "request.duplicate_override",
    "item.cancel",
    "result.review",
    "attachment.download",
    "notification.acknowledge"
  ],
  LAB_TECH: [
    "integration.exchange",
    "hospital_task.comment.create",
    "hospital_task.comment.edit_own",
    "hospital_task.attachment.upload",
    "hospital_task.archive",
    "hospital_task.restore",
    "hospital_document.create",
    "hospital_document.update",
    "hospital_document.retire",
    "hospital_document.lock",
    "hospital_document.archive",

    "plan.create",
    "plan.update",
    "plan.archive",
    "handoff.offer",
    "handoff.accept",
    "checklist.execute",
    "recurrence.manage",
    "hospital_calendar.reserve",
    "hospital_calendar.reschedule",
    "hospital_calendar.cancel",

    ...hospitalTaskWrite,
    "item.assignment.update", "item.plan.update",
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
    "integration.exchange",
    "hospital_task.comment.create",
    "hospital_task.comment.edit_own",
    "hospital_task.attachment.upload",
    "hospital_task.archive",
    "hospital_task.restore",
    "hospital_document.create",
    "hospital_document.update",
    "hospital_document.retire",
    "hospital_document.lock",
    "hospital_document.archive",

    "plan.create",
    "plan.update",
    "plan.archive",
    "handoff.offer",
    "handoff.accept",
    "checklist.execute",
    "recurrence.manage",
    "hospital_calendar.reserve",
    "hospital_calendar.reschedule",
    "hospital_calendar.cancel",

    ...hospitalTaskWrite,
    "item.assignment.update", "item.plan.update",
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
    "integration.exchange",
    "hospital_task.comment.create",
    "hospital_task.comment.edit_own",
    "hospital_task.attachment.upload",
    "hospital_task.archive",
    "hospital_task.restore",
    "hospital_document.create",
    "hospital_document.update",
    "hospital_document.retire",
    "hospital_document.lock",
    "hospital_document.archive",

    "plan.create",
    "plan.update",
    "plan.archive",
    "handoff.offer",
    "handoff.accept",
    "checklist.execute",
    "recurrence.manage",
    "hospital_calendar.reserve",
    "hospital_calendar.reschedule",
    "hospital_calendar.cancel",

    ...hospitalTaskWrite,
    "item.assignment.update", "item.plan.update",
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

// This privileged role combines the defined capabilities; it does not grant
// unknown permissions or remove ownership, session or workflow checks.
export const rolePermissions: Record<RoleCode, readonly Permission[]> = {
  ...scopedRolePermissions,
  SUPERADMIN: [...new Set(Object.values(scopedRolePermissions).flat())]
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

export function hasPermissionForUser(user: Pick<Actor, "active" | "role" | "permissions">, permission: Permission): boolean {
  return user.active === true && hasPermission(user.role, permission) && (user.permissions === undefined || user.permissions.includes(permission));
}

export function canAccessResource(
  actor: Actor,
  permission: Permission,
  resource: ScopedResource
): boolean {
  if (actor.active === false || !hasPermission(actor.role, permission) || (actor.permissions !== undefined && !actor.permissions.includes(permission))) {
    return false;
  }

  if (actor.role === "ADMIN") {
    // The technical role may operate platform/configuration resources, but
    // cannot enter patient scope without an explicitly approved break-glass
    // capability that is not part of this local boundary.
    return !resource.patientId;
  }

  if (
    (permission === "result.draft.edit_own" || permission === "hospital_task.comment.edit_own") &&
    (!resource.ownerId || resource.ownerId !== actor.id)
  ) {
    return false;
  }

  if (actor.role === "SUPERADMIN") return true;

  if (permission === "department.view" && resource.departmentCode && actor.role !== "MANAGER" && resource.departmentCode !== actor.departmentCode) return false;

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
