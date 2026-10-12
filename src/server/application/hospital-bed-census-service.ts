import type { HospitalBedCensus, HospitalBedCensusRow } from "@cvg/contracts";
import type { Admission, StoreState, User } from "../domain/models";
import type { ApplicationServiceContext } from "./service-context";
import { canViewItem, requireActiveUser, requirePatientPermission, requirePermission } from "./service-common";
import { canAccessHospitalResource, requireHospitalResourceAccess } from "./hospital-resource-policy";
import { hasUnreconciledAdmissions } from "./hospital-bed-policy";
import { canAccessHospitalTask } from "./hospital-task-policy";

function canViewAdmission(state: StoreState, actor: User, admission: Admission): boolean {
  const encounter = state.encounters.find((entry) => entry.id === admission.encounterId);
  if (!encounter || !canAccessHospitalResource(actor, "admission.view", admission.departmentCode)) return false;
  try { requirePatientPermission(state, actor, "patient.view", encounter.patientId); requirePatientPermission(state, actor, "admission.view", encounter.patientId); return true; } catch { return false; }
}
function pendingWork(state: StoreState, actor: User, admission: Admission): { openDiagnosticItemCount: number; openHospitalTaskCount: number } {
  const requestIds = new Set(state.requests.filter((request) => request.admissionId === admission.id).map((request) => request.id));
  return {
    openDiagnosticItemCount: state.items.filter((item) => requestIds.has(item.requestId) && !["COMPLETED", "CANCELLED", "REJECTED"].includes(item.status) && canViewItem(state, actor, item)).length,
    openHospitalTaskCount: state.hospitalTasks.filter((task) => task.encounterId === admission.encounterId && !task.isDraft && !task.draftCancelledAt && !task.archivedAt && !["COMPLETED", "CANCELLED"].includes(task.phase) && canAccessHospitalTask(state, actor, "hospital_task.view", task)).length
  };
}

export function createHospitalBedCensusService({ store }: ApplicationServiceContext) {
  return {
    async getBedCensus(actor: User, filters: { departmentCode?: string } = {}): Promise<HospitalBedCensus> {
      const state = await store.readState(); const current = requireActiveUser(state, actor); requirePermission(current, "admission.view", { departmentCode: filters.departmentCode });
      if (filters.departmentCode) requireHospitalResourceAccess(current, "admission.view", filters.departmentCode);
      const resources = state.hospitalResources.filter((resource) => resource.kind === "BED" && (!filters.departmentCode || resource.departmentCode === filters.departmentCode) && canAccessHospitalResource(current, "admission.view", resource.departmentCode)).sort((a, b) => a.code.localeCompare(b.code));
      const beds: HospitalBedCensusRow[] = resources.map((resource) => {
        const admission = state.admissions.find((entry) => entry.bedResourceId === resource.id && !entry.dischargedAt);
        if (admission) {
          if (!canViewAdmission(state, current, admission)) return { resource: structuredClone(resource), state: "RESTRICTED_OCCUPANCY" };
          const encounter = state.encounters.find((entry) => entry.id === admission.encounterId)!; const patient = state.patients.find((entry) => entry.id === encounter.patientId)!;
          return { resource: structuredClone(resource), state: "OCCUPIED", occupancy: { admissionId: admission.id, encounterId: encounter.id, patientId: patient.id, patientName: patient.displayName, admittedAt: admission.admittedAt, responsibleUserId: admission.responsibleUserId, version: admission.version, ...pendingWork(state, current, admission) } };
        }
        const status = !resource.active ? "INACTIVE" : resource.availability !== "AVAILABLE" ? resource.availability : hasUnreconciledAdmissions(state, resource.departmentCode) ? "UNRECONCILED" : "AVAILABLE";
        return { resource: structuredClone(resource), state: status };
      });
      const admissions = state.admissions.filter((admission) => (!filters.departmentCode || admission.departmentCode === filters.departmentCode) && canViewAdmission(state, current, admission));
      const unregisteredAdmissions = admissions.filter((admission) => !admission.dischargedAt && (!admission.bedResourceId || !state.hospitalResources.some((resource) => resource.id === admission.bedResourceId && resource.kind === "BED"))).map((admission) => {
        const encounter = state.encounters.find((entry) => entry.id === admission.encounterId)!; const patient = state.patients.find((entry) => entry.id === encounter.patientId)!;
        return { admissionId: admission.id, patientId: patient.id, patientName: patient.displayName, departmentCode: admission.departmentCode, ward: admission.ward, bed: admission.bed, version: admission.version };
      });
      const dischargedWithPendingWork = admissions.filter((admission) => admission.dischargedAt).flatMap((admission) => {
        const pending = pendingWork(state, current, admission); if (!pending.openDiagnosticItemCount && !pending.openHospitalTaskCount) return [];
        const encounter = state.encounters.find((entry) => entry.id === admission.encounterId)!; const patient = state.patients.find((entry) => entry.id === encounter.patientId)!;
        return [{ admissionId: admission.id, patientId: patient.id, patientName: patient.displayName, ...pending }];
      });
      return { asOf: new Date().toISOString(), beds, unregisteredAdmissions, dischargedWithPendingWork };
    }
  };
}
