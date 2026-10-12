import { DEPARTMENT_TYPES, type DepartmentType } from "@cvg/contracts";
import type { Department, StoreState, User } from "../domain/models";
import { ApiError } from "../http/envelope";

export function requireActiveDepartment(state: StoreState, code: string): Department {
  const department = state.departments.find((entry) => entry.code === code);
  if (!department?.active) throw new ApiError("VALIDATION_ERROR", "Selecione um setor ativo cadastrado.", 400);
  return department;
}

export function normalizedDepartmentCode(value: string): string {
  const code = value.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{1,60}$/.test(code)) throw new ApiError("VALIDATION_ERROR", "Código de setor inválido.", 400);
  return code;
}

export function validatedDepartmentType(value: DepartmentType): DepartmentType {
  if (!DEPARTMENT_TYPES.includes(value)) throw new ApiError("VALIDATION_ERROR", "Tipo de setor inválido.", 400);
  return value;
}

/** Descriptive team membership never changes clinical grants. */
export function reconcileDepartmentMembership(state: StoreState, user: User, timestamp: string): Department[] {
  const previous = state.users.find((candidate) => candidate.id === user.id);
  if (previous && previous.departmentCode === user.departmentCode && previous.active === user.active) return state.departments;
  return state.departments.map((department) => {
    const memberUserIds = department.memberUserIds.filter((id) => id !== user.id);
    if (user.active && department.code === user.departmentCode) memberUserIds.push(user.id);
    const responsibleUserId = department.responsibleUserId === user.id && (!user.active || department.code !== user.departmentCode)
      ? undefined : department.responsibleUserId;
    if (responsibleUserId === department.responsibleUserId && memberUserIds.length === department.memberUserIds.length && memberUserIds.every((id) => department.memberUserIds.includes(id))) return department;
    return { ...department, memberUserIds, responsibleUserId, version: department.version + 1, updatedAt: timestamp };
  });
}
