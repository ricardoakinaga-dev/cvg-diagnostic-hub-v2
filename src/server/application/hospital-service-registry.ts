import type { HospitalService, HospitalServiceCatalogEntry, HospitalServiceSnapshot } from "@cvg/contracts";
import type { StoreState } from "../domain/models";
import { ApiError } from "../http/envelope";
import { requireActiveDepartment } from "./department-registry";
import { definitionStatus } from "./exam-definition";

/** Team membership describes capacity; it never writes user grants. */
export function validateHospitalServiceBindings(state: StoreState, service: Pick<HospitalService, "departmentCode" | "teamUserIds" | "resourceIds">): void {
  const department = requireActiveDepartment(state, service.departmentCode);
  for (const userId of service.teamUserIds) {
    const user = state.users.find((entry) => entry.id === userId);
    if (!user?.active || user.departmentCode !== department.code || !department.memberUserIds.includes(userId)) throw new ApiError("VALIDATION_ERROR", "Selecione colaboradores ativos que pertençam à equipe deste setor.", 400);
  }
  for (const resourceId of service.resourceIds) {
    const resource = state.hospitalResources.find((entry) => entry.id === resourceId);
    if (!resource?.active || resource.departmentCode !== department.code) throw new ApiError("VALIDATION_ERROR", "Selecione recursos cadastrados e ativos deste setor.", 400);
  }
}

export function hospitalServiceCatalog(state: StoreState): HospitalServiceCatalogEntry[] {
  return [...state.hospitalServices.map((service) => ({ ...service, source: "HOSPITAL_SERVICE" as const })), ...state.services.map((service) => ({ source: "DIAGNOSTIC_SERVICE" as const, id: service.id, code: service.code, name: service.name, kind: "DIAGNOSTIC" as const, departmentCode: service.departmentCode, teamUserIds: [], resourceIds: [], active: service.active && definitionStatus(service) === "ACTIVE", version: service.version }))];
}

/** The caller authorizes the activity and patient first; this validates only its catalog binding. */
export function captureHospitalServiceForActivity(state: StoreState, serviceId: string, capturedAt: string): HospitalServiceSnapshot {
  const service = hospitalServiceCatalog(state).find((entry) => entry.id === serviceId);
  if (!service?.active) throw new ApiError("SERVICE_UNAVAILABLE", "Selecione um serviço hospitalar ativo.", 422);
  requireActiveDepartment(state, service.departmentCode);
  if (service.source === "HOSPITAL_SERVICE") validateHospitalServiceBindings(state, service);
  return { source: service.source, serviceId: service.id, serviceVersion: service.version, code: service.code, name: service.name, kind: service.kind, departmentCode: service.departmentCode, teamUserIds: [...service.teamUserIds], resourceIds: [...service.resourceIds], capturedAt };
}
