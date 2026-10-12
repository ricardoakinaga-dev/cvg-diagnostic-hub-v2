import type { HospitalResource } from "@cvg/contracts";
import type { Patient, StoreState, User } from "../domain/models";
import { ApiError } from "../http/envelope";
import { managerCanAccessDepartment } from "../security/authorization";
import { requireActiveDepartment } from "./department-registry";
import { requireText } from "./service-common";

const fold = (value: string) => value.normalize("NFKC").trim().toLocaleLowerCase("pt-BR");
export interface HospitalBedPlacement { departmentCode: string; ward: string; bed: string; bedResourceId?: string }
/** Occupancy is always derived from Admission inside its existing transaction. */
export function resolveAdmissionBed(state: StoreState, actor: User, patient: Pick<Patient, "species">, input: { departmentCode: string; ward?: string; bed?: string; bedResourceId?: string }, excludeAdmissionId?: string): HospitalBedPlacement {
  const departmentCode = input.departmentCode.toUpperCase();
  if (!input.bedResourceId) {
    if (process.env.NODE_ENV === "production" || state.hospitalResources.some((resource) => resource.active && resource.kind === "BED" && resource.departmentCode === departmentCode)) throw new ApiError("BED_INVENTORY_REQUIRED", "Selecione um leito cadastrado por ID. Configure o inventário de leitos deste setor antes de admitir ou transferir.", 422, { nextAction: "Cadastrar leitos e compatibilidade no inventário hospitalar." });
    return { departmentCode, ward: requireText(input.ward ?? "", "ward", 100), bed: requireText(input.bed ?? "", "bed", 100) };
  }
  const resource = state.hospitalResources.find((entry) => entry.id === input.bedResourceId);
  if (!resource || resource.kind !== "BED" || resource.departmentCode !== departmentCode || !resource.active || resource.availability !== "AVAILABLE") throw new ApiError("BED_UNAVAILABLE", "O leito selecionado está indisponível para este setor.", 422);
  const scopeAllowed = actor.role === "SUPERADMIN" || (actor.role === "MANAGER" ? managerCanAccessDepartment(actor, departmentCode) : actor.departmentCode === departmentCode);
  if (!scopeAllowed) throw new ApiError("SCOPE_DENIED", "Você não tem acesso a este recurso.", 404);
  requireActiveDepartment(state, departmentCode);
  if (!resource.ward || !resource.bedLabel || !resource.allowedSpecies?.map(fold).includes(fold(patient.species))) throw new ApiError("BED_INCOMPATIBLE", "O leito não possui compatibilidade cadastrada para a espécie do paciente.", 422);
  if (input.ward !== undefined && input.ward.trim() !== resource.ward || input.bed !== undefined && input.bed.trim() !== resource.bedLabel) throw new ApiError("VALIDATION_ERROR", "A identificação deve corresponder ao leito cadastrado selecionado.", 400);
  const current = excludeAdmissionId ? state.admissions.find((admission) => admission.id === excludeAdmissionId) : undefined;
  const explicitlyReconciling = current && !current.bedResourceId && current.departmentCode === departmentCode;
  if (!explicitlyReconciling && hasUnreconciledAdmissions(state, departmentCode, excludeAdmissionId)) throw new ApiError("BED_OCCUPANCY_UNRECONCILED", "Há internações vigentes sem vínculo de leito neste setor. Concilie cada internação por uma mudança de leito explícita antes de admitir nova ocupação.", 409, { nextAction: "Vincular os leitos das internações existentes no censo hospitalar com a política D-01 aprovada." });
  if (state.admissions.some((admission) => admission.id !== excludeAdmissionId && admission.bedResourceId === resource.id && !admission.dischargedAt)) throw new ApiError("BED_OCCUPIED", "O leito já está ocupado por uma internação vigente.", 409);
  return { departmentCode, ward: resource.ward, bed: resource.bedLabel, bedResourceId: resource.id };
}
export function hasUnreconciledAdmissions(state: StoreState, departmentCode: string, excludeAdmissionId?: string): boolean {
  return state.admissions.some((admission) => admission.id !== excludeAdmissionId && admission.departmentCode === departmentCode && !admission.dischargedAt && (!admission.bedResourceId || !state.hospitalResources.some((resource) => resource.id === admission.bedResourceId && resource.kind === "BED")));
}
export function placementDepartment(state: StoreState, actor: User, bedResourceId?: string): string {
  const resource: HospitalResource | undefined = bedResourceId ? state.hospitalResources.find((entry) => entry.id === bedResourceId && entry.kind === "BED") : undefined;
  return resource?.departmentCode ?? actor.departmentCode;
}
