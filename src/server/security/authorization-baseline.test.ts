import { describe, expect, it } from "vitest";
import { ROLES, type Permission, type RoleCode } from "@cvg/contracts";
import { canAccessResource, hasPermission } from "./authorization";

// Approved 2026-10-11 baseline, stored independently of the authorization implementation.
// New commands extend this contract; changing these grants requires a reviewed migration.
const approvedRolesByPermission: Record<Permission, readonly RoleCode[]> = {
  "integration.manage": ["ADMIN", "MANAGER", "SUPERADMIN"],
  "integration.exchange": ["MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "SUPERADMIN"],
  "hospital_task.comment.view": ["MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "VIEWER", "SUPERADMIN"],
  "hospital_task.attachment.view": ["MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "VIEWER", "SUPERADMIN"],
  "hospital_task.attachment.download": ["MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "VIEWER", "SUPERADMIN"],
  "hospital_task.comment.create": ["MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "SUPERADMIN"],
  "hospital_task.comment.edit_own": ["MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "SUPERADMIN"],
  "hospital_task.attachment.upload": ["MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "SUPERADMIN"],
  "hospital_task.archive": ["MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "SUPERADMIN"],
  "hospital_task.restore": ["MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "SUPERADMIN"],
  "hospital_task.comment.moderate": ["MANAGER", "SUPERADMIN"],
  "work_notification.view": ["ADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "VIEWER", "SUPERADMIN"],
  "work_notification.read": ["ADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "VIEWER", "SUPERADMIN"],
  "work_notification.archive": ["ADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "VIEWER", "SUPERADMIN"],
  "work_notification.preferences.manage": ["ADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "VIEWER", "SUPERADMIN"],
  "work_activity.preference.manage": ["ADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "VIEWER", "SUPERADMIN"],
  "hospital_document.view": ["ADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "VIEWER", "SUPERADMIN"],
  "hospital_document.create": ["ADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "SUPERADMIN"],
  "hospital_document.update": ["ADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "SUPERADMIN"],
  "hospital_document.retire": ["ADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "SUPERADMIN"],
  "hospital_document.lock": ["ADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "SUPERADMIN"],
  "hospital_document.archive": ["ADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "SUPERADMIN"],
  "hospital_document.approve": ["MANAGER", "VETERINARIAN", "SUPERADMIN"],
  "hospital_metric.view": ["MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "VIEWER", "SUPERADMIN"],
  "hospital_report.view": ["MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "VIEWER", "SUPERADMIN"],
  "hospital_report.manage": ["MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "VIEWER", "SUPERADMIN"],
  "hospital_report.export": ["MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "VIEWER", "SUPERADMIN"],
  "institution.manage": ["ADMIN", "SUPERADMIN"],
  "department.capabilities.manage": ["ADMIN", "SUPERADMIN"],
  "user_invite.manage": ["ADMIN", "MANAGER", "SUPERADMIN"],

  "plan.view": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "VIEWER"],
  "plan.create": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM"],
  "plan.update": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM"],
  "plan.archive": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM"],
  "shift.view": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "VIEWER"],
  "shift.manage": ["SUPERADMIN", "MANAGER"],
  "shift.assign": ["SUPERADMIN", "MANAGER"],
  "handoff.offer": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM"],
  "handoff.accept": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM"],
  "checklist_template.view": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "VIEWER", "ADMIN"],
  "checklist_template.manage": ["SUPERADMIN", "ADMIN", "MANAGER", "VETERINARIAN"],
  "checklist_template.approve": ["SUPERADMIN", "MANAGER", "VETERINARIAN"],
  "checklist.execute": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM"],
  "recurrence.view": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "VIEWER"],
  "recurrence.manage": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM"],
  "care.execute": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM"],
  "hospital_resource.view": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "VIEWER", "ADMIN"],
  "hospital_resource.create": ["SUPERADMIN", "ADMIN", "MANAGER"],
  "hospital_resource.update": ["SUPERADMIN", "ADMIN", "MANAGER"],
  "hospital_resource.deactivate": ["SUPERADMIN", "ADMIN", "MANAGER"],
  "hospital_calendar.view": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "VIEWER"],
  "hospital_calendar.reserve": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM"],
  "hospital_calendar.reschedule": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM"],
  "hospital_calendar.cancel": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM"],
  "hospital_capacity.view": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "VIEWER"],

  "planner_view.view": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "VIEWER"],
  "planner_view.create": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "VIEWER"],
  "planner_view.update": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "VIEWER"],
  "planner_view.deactivate": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "VIEWER"],
  "planner_view.share": ["SUPERADMIN", "MANAGER"],

  "hospital_task_type.manage": ["SUPERADMIN", "ADMIN"],
  "hospital_task.view": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "VIEWER"],
  "hospital_task.create": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM"],
  "hospital_task.update": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM"],
  "hospital_task.execute": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM"],
  "hospital_task.assign": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM"],
  "hospital_task.priority.update": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM"],
  "hospital_task.dependency.manage": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM"],
  "hospital_intake.view": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "VIEWER"],
  "hospital_intake.create": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM"],
  "hospital_intake.triage": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM"],

  "item.assignment.update": ["SUPERADMIN", "MANAGER", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM"],
  "item.priority.update": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM"],
  "item.plan.update": ["SUPERADMIN", "MANAGER", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM"],
  "exam_definition.approve": ["SUPERADMIN", "MANAGER", "VETERINARIAN"],
  "access_group.view": ["SUPERADMIN", "ADMIN", "MANAGER"],
  "access_group.create": ["SUPERADMIN", "ADMIN", "MANAGER"],
  "access_group.update": ["SUPERADMIN", "ADMIN", "MANAGER"],
  "access_group.deactivate": ["SUPERADMIN", "ADMIN", "MANAGER"],
  "access_group.assign": ["SUPERADMIN", "ADMIN", "MANAGER"],
  "patient_scope.manage": ["SUPERADMIN", "ADMIN", "MANAGER"],
  "user.view": ["SUPERADMIN", "ADMIN", "MANAGER"],
  "user.create": ["SUPERADMIN", "ADMIN", "MANAGER"],
  "user.update": ["SUPERADMIN", "ADMIN", "MANAGER"],
  "user.deactivate": ["SUPERADMIN", "ADMIN", "MANAGER"],
  "service.catalog.create": ["SUPERADMIN", "ADMIN", "MANAGER"],
  "service.catalog.update": ["SUPERADMIN", "ADMIN", "MANAGER"],
  "service.catalog.deactivate": ["SUPERADMIN", "ADMIN", "MANAGER"],
  "department.update": ["SUPERADMIN", "ADMIN", "MANAGER"],
  "department.members.manage": ["SUPERADMIN", "ADMIN", "MANAGER"],
  "department.create": ["SUPERADMIN", "ADMIN"],
  "department.deactivate": ["SUPERADMIN", "ADMIN"],
  "department.view": ROLES,
  "admission.context.manage": ["SUPERADMIN", "MANAGER"],
  "admission.view": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "VIEWER"],
  "attachment.download": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM"],
  "attachment.finalize": ["SUPERADMIN", "MANAGER", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM"],
  "attachment.upload_session": ["SUPERADMIN", "MANAGER", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM"],
  "attachment.view": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "VIEWER"],
  "audit.view": ["SUPERADMIN", "ADMIN", "MANAGER"],
  "critical_result_policy.manage": ["SUPERADMIN", "ADMIN"],
  "dashboard.view": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "VIEWER"],
  "diagnostic.timeline.view": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "VIEWER"],
  "encounter.manage": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM"],
  "encounter.view": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "VIEWER"],
  "health.liveness": ["SUPERADMIN", "ADMIN"],
  "health.readiness": ["SUPERADMIN", "ADMIN"],
  "item.cancel": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM"],
  "item.complete": ["SUPERADMIN", "MANAGER"],
  "item.reject": ["SUPERADMIN", "MANAGER", "LAB_TECH"],
  "item.view": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "VIEWER"],
  "notification.acknowledge": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM"],
  "notification.view": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "VIEWER"],
  "outbox.manage": ["SUPERADMIN", "ADMIN"],
  "patient.create": ["SUPERADMIN", "VETERINARIAN", "INPATIENT_TEAM"],
  "patient.data_export": ["SUPERADMIN", "ADMIN"],
  "patient.view": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "VIEWER"],
  "procedure.mark_performed": ["SUPERADMIN", "MANAGER", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM"],
  "procedure.reschedule": ["SUPERADMIN", "MANAGER", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM"],
  "procedure.schedule": ["SUPERADMIN", "MANAGER", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM"],
  "procedure.start": ["SUPERADMIN", "MANAGER", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM"],
  "queue.view": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "VIEWER"],
  "realtime.connect": ["SUPERADMIN", "ADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "VIEWER"],
  "reason_code.manage": ["SUPERADMIN", "ADMIN", "MANAGER"],
  "request.cancel": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM"],
  "request.create": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM"],
  "request.duplicate_override": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM"],
  "request.list": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "VIEWER"],
  "request.view": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "VIEWER"],
  "result.amend": ["SUPERADMIN", "MANAGER", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM"],
  "result.draft.create": ["SUPERADMIN", "MANAGER", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM"],
  "result.draft.edit_own": ["SUPERADMIN", "MANAGER", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM"],
  "result.history.view": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "VIEWER"],
  "result.release": ["SUPERADMIN", "MANAGER", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM"],
  "result.review": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM"],
  "result.view": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "VIEWER"],
  "result.view.record": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "VIEWER"],
  "result.void": ["SUPERADMIN", "MANAGER", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM"],
  "sample.process": ["SUPERADMIN", "MANAGER", "LAB_TECH"],
  "sample.receive": ["SUPERADMIN", "MANAGER", "LAB_TECH"],
  "sample.recollection.request": ["SUPERADMIN", "MANAGER", "LAB_TECH"],
  "sample.replacement.receive": ["SUPERADMIN", "MANAGER", "LAB_TECH"],
  "search.execute": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "VIEWER"],
  "service.catalog.manage": ["SUPERADMIN", "ADMIN", "MANAGER"],
  "service.catalog.view": ["SUPERADMIN", "ADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "VIEWER"],
  "sla_policy.manage": ["SUPERADMIN", "ADMIN", "MANAGER"],
  "timeline.view": ["SUPERADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "VIEWER"],
  "user_role.manage": ["SUPERADMIN", "ADMIN", "MANAGER"],
};

const permissions = Object.keys(approvedRolesByPermission) as Permission[];
const actors = ROLES.map((role) => ({ id: `actor-${role}`, role, departmentCode: "LABORATORY", patientIds: ["authorized-patient"], serviceCodes: ["AUTHORIZED_EXAM"], managedDepartmentCodes: ["LABORATORY"], active: true }));

describe("approved permission and nine-role authorization contract", () => {
  for (const actor of actors) {
    it.each(permissions)(`${actor.role}: %s follows its approved grant and denies inactive users`, (permission) => {
      const allowed = approvedRolesByPermission[permission].includes(actor.role);
      expect(hasPermission(actor.role, permission)).toBe(allowed);
      const resource = { departmentCode: "LABORATORY", serviceCode: "AUTHORIZED_EXAM", ownerId: actor.id, ...(actor.role === "ADMIN" ? {} : { patientId: "authorized-patient" }) };
      expect(canAccessResource(actor, permission, resource)).toBe(allowed);
      expect(canAccessResource({ ...actor, active: false }, permission, resource)).toBe(false);
    });
    it(`${actor.role} does not gain unknown permissions`, () => {
      expect(canAccessResource(actor, "unknown.permission" as Permission, {})).toBe(false);
    });
  }

  it.each(["VETERINARIAN", "INPATIENT_TEAM", "VIEWER"] as const)("%s never gains an unassigned patient through a grant", (role) => {
    const actor = actors.find((user) => user.role === role)!;
    for (const permission of permissions.filter((code) => approvedRolesByPermission[code].includes(role))) {
      expect(canAccessResource(actor, permission, { patientId: "unassigned-patient", departmentCode: "LABORATORY" })).toBe(false);
    }
  });

  it.each(["LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM"] as const)("%s still requires department and materialized exam grants", (role) => {
    const actor = actors.find((user) => user.role === role)!;
    for (const permission of permissions.filter((code) => approvedRolesByPermission[code].includes(role))) {
      expect(canAccessResource(actor, permission, { departmentCode: "ANOTHER_SECTOR", ownerId: actor.id })).toBe(false);
      expect(canAccessResource({ ...actor, serviceCodes: [] }, permission, { departmentCode: "LABORATORY", serviceCode: "UNAUTHORIZED_EXAM", ownerId: actor.id })).toBe(false);
    }
  });

  it("global administration never bypasses clinical boundaries or draft authorship", () => {
    const admin = actors.find((user) => user.role === "ADMIN")!;
    for (const permission of permissions) expect(canAccessResource(admin, permission, { patientId: "authorized-patient" })).toBe(false);
    const manager = actors.find((user) => user.role === "MANAGER")!;
    expect(canAccessResource(manager, "request.view", { departmentCode: "UNDELEGATED" })).toBe(false);
    for (const role of ["SUPERADMIN", "MANAGER", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM"]) {
      const actor = actors.find((user) => user.role === role)!;
      expect(canAccessResource(actor, "result.draft.edit_own", { departmentCode: "LABORATORY", serviceCode: "AUTHORIZED_EXAM", ownerId: "another-author" })).toBe(false);
    }
  });
});
