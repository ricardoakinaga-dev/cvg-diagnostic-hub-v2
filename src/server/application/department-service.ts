import { TERMINAL_ITEM_STATES, type DepartmentType } from "@cvg/contracts";
import type { Department, StoreState, User } from "../domain/models";
import type { ApplicationServiceContext } from "./service-context";
import type { CommandMeta } from "./service-types";
import { ApiError } from "../http/envelope";
import { canAccessResource, hasPermissionForUser } from "../security/authorization";
import { canViewItem, createAudit, ensureExpectedVersion, findOrThrow, id, now, requireActiveUser, requireIdempotencyKey, requirePermission, requireText, saveIdempotency, withIdempotency } from "./service-common";
import { normalizedDepartmentCode, validatedDepartmentType } from "./department-registry";
import { canAccessHospitalTask } from "./hospital-task-policy";

export type DepartmentCreateInput = CommandMeta & { code: string; name: string; type: DepartmentType };
export type DepartmentPatchInput = CommandMeta & { name?: string; type?: DepartmentType; active?: true };
export type DepartmentMembersInput = CommandMeta & { memberUserIds: string[]; responsibleUserId?: string | null };

function team(state: StoreState, department: Department, input: DepartmentMembersInput): Pick<Department, "memberUserIds" | "responsibleUserId"> {
  if (input.memberUserIds.length > 500 || new Set(input.memberUserIds).size !== input.memberUserIds.length) throw new ApiError("VALIDATION_ERROR", "A equipe deve ter até 500 membros distintos.", 400);
  for (const userId of input.memberUserIds) {
    const user = state.users.find((entry) => entry.id === userId);
    if (!user?.active || user.departmentCode !== department.code) throw new ApiError("VALIDATION_ERROR", "O membro deve ser um usuário ativo vinculado a este setor.", 400);
  }
  const responsibleUserId = input.responsibleUserId ?? undefined;
  if (responsibleUserId && !input.memberUserIds.includes(responsibleUserId)) throw new ApiError("VALIDATION_ERROR", "O responsável deve fazer parte da equipe do setor.", 400);
  return { memberUserIds: [...input.memberUserIds], responsibleUserId };
}

export function createDepartmentService({ store }: ApplicationServiceContext) {
  async function change(actor: User, departmentId: string, input: DepartmentPatchInput | DepartmentMembersInput | CommandMeta, action: "UPDATE" | "DEACTIVATE" | "MEMBERS") {
    const scope = `${action}:/departments/${departmentId}`;
    return store.transaction((state) => {
      const current = requireActiveUser(state, actor);
      const previous = findOrThrow(state.departments.find((entry) => entry.id === departmentId));
      requirePermission(current, action === "DEACTIVATE" ? "department.deactivate" : action === "MEMBERS" ? "department.members.manage" : "department.update", { departmentCode: previous.code });
      requireIdempotencyKey(input.idempotencyKey);
      const replay = withIdempotency<Department>(state, current.id, scope, input.idempotencyKey, { input });
      if (replay.found) return { state, result: replay.existing! };
      ensureExpectedVersion(previous.version, input.expectedVersion);
      const timestamp = now();
      let changed: Department;
      if (action === "DEACTIVATE") changed = { ...previous, active: false };
      else if (action === "MEMBERS") {
        if (!previous.active) throw new ApiError("VALIDATION_ERROR", "Reative o setor para alterar a equipe.", 400);
        changed = { ...previous, ...team(state, previous, input as DepartmentMembersInput) };
      } else {
        const patch = input as DepartmentPatchInput;
        if (patch.name === undefined && patch.type === undefined && patch.active === undefined) throw new ApiError("VALIDATION_ERROR", "Informe uma alteração no setor.", 400);
        changed = { ...previous, name: patch.name === undefined ? previous.name : requireText(patch.name, "nome do setor", 120), type: patch.type === undefined ? previous.type : validatedDepartmentType(patch.type), active: patch.active ?? previous.active };
      }
      changed = { ...changed, updatedAt: timestamp, version: previous.version + 1 };
      const eventType = action === "MEMBERS" ? "DepartmentMembersUpdated" : action === "DEACTIVATE" ? "DepartmentDeactivated" : !previous.active && changed.active ? "DepartmentReactivated" : "DepartmentUpdated";
      const next = { ...state, departments: state.departments.map((entry) => entry.id === departmentId ? changed : entry), auditEvents: [...state.auditEvents, createAudit(eventType, current.id, "Department", previous.id, input.correlationId ?? id("corr"), previous.active ? "ACTIVE" : "INACTIVE", changed.active ? "ACTIVE" : "INACTIVE", { departmentCode: previous.code, previousVersion: previous.version, version: changed.version, previousName: previous.name, name: changed.name, type: changed.type, previousMembers: previous.memberUserIds.join(","), members: changed.memberUserIds.join(","), previousResponsibleUserId: previous.responsibleUserId ?? null, responsibleUserId: changed.responsibleUserId ?? null })] };
      return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, changed, { input }), result: changed };
    });
  }
  return {
    async listDepartments(actor: User, options: { includeInactive?: boolean } = {}): Promise<Department[]> {
      const state = await store.readState();
      const current = requireActiveUser(state, actor);
      requirePermission(current, "department.view", {});
      return state.departments.filter((entry) => (options.includeInactive || entry.active) && canAccessResource(current, "department.view", { departmentCode: entry.code })).sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
    },
    async getDepartment(actor: User, departmentId: string): Promise<Department> {
      const state = await store.readState();
      const current = requireActiveUser(state, actor);
      const department = findOrThrow(state.departments.find((entry) => entry.id === departmentId));
      requirePermission(current, "department.view", { departmentCode: department.code });
      if (!canAccessResource(current, "department.deactivate", { departmentCode: department.code })) return department;
      return { ...department, pendingWork: {
        asOf: now(), scope: "AUTHORIZED_ONLY",
        diagnosticItems: hasPermissionForUser(current, "item.view") ? state.items.filter((entry) => entry.departmentCode === department.code && !TERMINAL_ITEM_STATES.some((status) => status === entry.status) && canViewItem(state, current, entry)).length : null,
        hospitalTasks: hasPermissionForUser(current, "hospital_task.view") ? state.hospitalTasks.filter((entry) => entry.departmentCode === department.code && !entry.archivedAt && !entry.draftCancelledAt && !["COMPLETED", "CANCELLED"].includes(entry.phase) && canAccessHospitalTask(state, current, "hospital_task.view", entry)).length : null,
        intakes: hasPermissionForUser(current, "hospital_intake.view") ? state.hospitalIntakes.filter((entry) => entry.departmentCode === department.code && ["RECEIVED", "DEFERRED"].includes(entry.state) && canAccessHospitalTask(state, current, "hospital_intake.view", entry)).length : null
      } };
    },
    async createDepartment(actor: User, input: DepartmentCreateInput): Promise<Department> {
      const scope = "POST:/departments";
      return store.transaction((state) => {
        const current = requireActiveUser(state, actor);
        requirePermission(current, "department.create", {});
        requireIdempotencyKey(input.idempotencyKey);
        const replay = withIdempotency<Department>(state, current.id, scope, input.idempotencyKey, { input });
        if (replay.found) return { state, result: replay.existing! };
        const code = normalizedDepartmentCode(input.code);
        if (state.departments.some((entry) => entry.code === code)) throw new ApiError("CONFLICT", "Este código de setor já está cadastrado.", 409);
        const timestamp = now();
        const department: Department = { id: id("department"), code, name: requireText(input.name, "nome do setor", 120), type: validatedDepartmentType(input.type), active: true, memberUserIds: [], version: 1, createdAt: timestamp, updatedAt: timestamp };
        const next = { ...state, departments: [...state.departments, department], auditEvents: [...state.auditEvents, createAudit("DepartmentCreated", current.id, "Department", department.id, input.correlationId ?? id("corr"), undefined, "ACTIVE", { departmentCode: code, name: department.name, type: department.type })] };
        return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, department, { input }), result: department };
      });
    },
    updateDepartment: (actor: User, departmentId: string, input: DepartmentPatchInput) => change(actor, departmentId, input, "UPDATE"),
    deactivateDepartment: (actor: User, departmentId: string, input: CommandMeta) => change(actor, departmentId, input, "DEACTIVATE"),
    setDepartmentMembers: (actor: User, departmentId: string, input: DepartmentMembersInput) => change(actor, departmentId, input, "MEMBERS")
  };
}
