import type { HospitalCapability } from "@cvg/contracts";
import type { StoreState } from "../domain/models";
import { ApiError } from "../http/envelope";
/** Capability configuration only denies new work. It never supplies rights or hides pending care. */
export function requireHospitalCapability(state: StoreState, departmentCode: string, capability: HospitalCapability): void {
  const config = state.hospitalInstitutionSettings[0]?.departmentCapabilities.find((entry) => entry.departmentCode === departmentCode);
  if (config?.archived || config?.disabledNewWork.includes(capability)) throw new ApiError("DEPARTMENT_WORK_DISABLED", "O setor está arquivado ou esse módulo está desabilitado para novos registros. As pendências existentes continuam disponíveis.", 409);
}
export function requireHospitalOnboardingDepartment(state: StoreState, departmentCode: string): void {
  if (state.hospitalInstitutionSettings[0]?.departmentCapabilities.some((entry) => entry.departmentCode === departmentCode && entry.archived)) throw new ApiError("DEPARTMENT_WORK_DISABLED", "Restaure o setor antes de admitir novos usuários.", 409);
}
