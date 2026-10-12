import type { Permission } from "@cvg/contracts";
import type { User } from "../domain/models";
import type { ApplicationServiceContext } from "./service-context";
import { ApiError } from "../http/envelope";
import { requireActiveUser, requirePermission } from "./service-common";
import { canAccessHospitalTask, eligibleTaskUser } from "./hospital-task-policy";
import { canAccessChecklistTemplate } from "./hospital-checklist-policy";
import { requirePlanDepartmentBindings } from "./hospital-plan-policy";

export function createHospitalPlannerOptionsService({ store }: ApplicationServiceContext) {
  return {
    async listHospitalPlannerOptions(actor: User, action: "plan.create" | "plan.update" | "shift.manage" | "handoff.offer" | "recurrence.manage" | "checklist_template.manage" = "plan.create") {
      if (!["plan.create", "plan.update", "shift.manage", "handoff.offer", "recurrence.manage", "checklist_template.manage"].includes(action)) throw new ApiError("VALIDATION_ERROR", "Selecione uma ação de planejamento válida.", 400);
      const state = await store.readState(); const current = requireActiveUser(state, actor); requirePermission(current, action, {});
      const departments = state.departments.filter((entry) => {
        if (!entry.active) return false;
        if (action === "plan.create" || action === "plan.update") {
          try { requirePlanDepartmentBindings(state, current, [entry.code], action); return true; } catch { return false; }
        }
        return action === "checklist_template.manage" ? canAccessChecklistTemplate(state, current, action, { departmentCode: entry.code }) : canAccessHospitalTask(state, current, action as Permission, { departmentCode: entry.code });
      });
      const staff = state.users.flatMap((user) => {
        try { const candidate = departments.map((department) => { try { return eligibleTaskUser(state, user.id, { departmentCode: department.code }, true); } catch { return undefined; } }).find(Boolean); return candidate ? [{ id: candidate.id, displayName: candidate.displayName, role: candidate.role, departmentCode: candidate.departmentCode }] : []; } catch { return []; }
      });
      return { departments: departments.map(({ code, name }) => ({ code, name })), staff };
    }
  };
}
