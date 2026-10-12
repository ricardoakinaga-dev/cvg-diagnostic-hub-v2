import type { RoleCode, ServiceAccessPolicy } from "@cvg/contracts";
import type { DiagnosticService, StoreState, User } from "../domain/models";
import { ApiError } from "../http/envelope";

const EXECUTOR_ROLES: readonly RoleCode[] = ["LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM"];
export const isServiceExecutor = (role: RoleCode): boolean => EXECUTOR_ROLES.includes(role);

/** Legacy lists retain exactly their grants; a full list never proves consent to future exams. */
export function serviceAccessPolicyFor(user: Pick<User, "role" | "serviceCodes" | "serviceAccessPolicy">): ServiceAccessPolicy | undefined {
  if (!isServiceExecutor(user.role)) return undefined;
  return user.serviceAccessPolicy ? { ...user.serviceAccessPolicy } : { mode: user.serviceCodes?.length ? "SELECTED" : "NONE", includeFuture: false };
}

export function assignedServiceAccess(
  state: StoreState,
  role: RoleCode,
  departmentCode: string,
  codes?: ReadonlyArray<string>,
  policy?: ServiceAccessPolicy,
  previous?: User
): Pick<User, "serviceCodes" | "serviceAccessPolicy"> {
  if (!isServiceExecutor(role)) {
    if (codes?.length || policy !== undefined) throw new ApiError("VALIDATION_ERROR", "Somente equipes executoras podem receber exames autorizados.", 400);
    return { serviceCodes: undefined, serviceAccessPolicy: undefined };
  }
  const sameScope = previous && isServiceExecutor(previous.role) && previous.departmentCode === departmentCode;
  if (policy === undefined && codes === undefined && sameScope) {
    return { serviceCodes: [...previous.serviceCodes ?? []], serviceAccessPolicy: serviceAccessPolicyFor(previous) };
  }
  // Legacy provisioning keeps its current-exam default, but never opts into future exams.
  // Moving an existing user without an explicit choice grants nothing in the new department.
  const selectedPolicy: ServiceAccessPolicy = policy ?? {
    mode: codes === undefined ? previous ? "NONE" : "ALL_CURRENT" : codes.length ? "SELECTED" : "NONE",
    includeFuture: false
  };
  if (!["NONE", "SELECTED", "ALL_CURRENT"].includes(selectedPolicy.mode)
    || typeof selectedPolicy.includeFuture !== "boolean"
    || (selectedPolicy.includeFuture && selectedPolicy.mode !== "ALL_CURRENT")) {
    throw new ApiError("VALIDATION_ERROR", "Política de exames autorizados inválida.", 400);
  }
  if (selectedPolicy.mode !== "SELECTED" && codes?.length) throw new ApiError("VALIDATION_ERROR", "A lista de exames exige o modo seleção.", 400);
  if (selectedPolicy.mode === "ALL_CURRENT") {
    return { serviceAccessPolicy: { ...selectedPolicy }, serviceCodes: state.services.filter((service) => service.active && service.departmentCode === departmentCode).map((service) => service.code) };
  }
  if (selectedPolicy.mode === "NONE") return { serviceAccessPolicy: { ...selectedPolicy }, serviceCodes: [] };
  if (!codes || codes.length > 200) throw new ApiError("VALIDATION_ERROR", "Informe até 200 exames para a seleção.", 400);
  const normalized = [...new Set(codes.map((code) => typeof code === "string" ? code.trim().toUpperCase() : ""))];
  if (normalized.some((code) => !/^[A-Z][A-Z0-9_]{1,59}$/.test(code))) throw new ApiError("VALIDATION_ERROR", "Código de exame autorizado inválido.", 400);
  if (normalized.some((code) => !state.services.some((service) => service.code === code && service.departmentCode === departmentCode))) {
    throw new ApiError("SCOPE_DENIED", "O exame autorizado deve pertencer ao setor do colaborador.", 404);
  }
  return { serviceAccessPolicy: { ...selectedPolicy }, serviceCodes: normalized };
}

export interface ServiceGrantChange { before: User; after: User; added: string[]; removed: string[] }

/** Materializes only explicit future policies and removes grants that leave the user's department. */
export function reconcileCatalogServiceAccess(state: StoreState, previous: DiagnosticService | undefined, service: DiagnosticService): { users: User[]; changes: ServiceGrantChange[] } {
  const changes: ServiceGrantChange[] = [];
  const newlyAvailable = service.active && (!previous || !previous.active || previous.departmentCode !== service.departmentCode);
  const users = state.users.map((user) => {
    if (!isServiceExecutor(user.role)) return user;
    const held = new Set(user.serviceCodes ?? []);
    const removed: string[] = [];
    const added: string[] = [];
    if (previous && previous.departmentCode !== service.departmentCode && user.departmentCode === previous.departmentCode && held.delete(service.code)) removed.push(service.code);
    if (newlyAvailable && user.departmentCode === service.departmentCode
      && user.serviceAccessPolicy?.mode === "ALL_CURRENT" && user.serviceAccessPolicy.includeFuture === true && !held.has(service.code)) {
      held.add(service.code); added.push(service.code);
    }
    if (!removed.length && !added.length) return user;
    const after = { ...user, serviceCodes: [...held], version: user.version + 1 };
    changes.push({ before: user, after, added, removed });
    return after;
  });
  return { users, changes };
}
