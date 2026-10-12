import type { HospitalReportDefinition } from "@cvg/contracts";
import type { StoreState, User } from "../domain/models";
import { ApiError } from "../http/envelope";
import { requireActiveUser, requirePermission } from "./service-common";
import { requireHospitalMetricAccess } from "./hospital-metrics-service";
import { requireHospitalTaskAccess } from "./hospital-task-policy";

export function requireHospitalReportAccess(state: StoreState, actor: User, reportId: string, mutate = false): HospitalReportDefinition {
  requirePermission(actor, mutate ? "hospital_report.manage" : "hospital_report.view", {});
  const report = state.hospitalReports.find((entry) => entry.id === reportId);
  if (!report || mutate && report.ownerId !== actor.id) throw new ApiError("SCOPE_DENIED", "Relatório indisponível.", 404);
  if (report.ownerId !== actor.id) {
    if (!report.sharedDepartmentCode) throw new ApiError("SCOPE_DENIED", "Relatório indisponível.", 404);
    requireHospitalTaskAccess(state, actor, "hospital_report.view", { departmentCode: report.sharedDepartmentCode });
  }
  requireHospitalMetricAccess(state, actor, report.filters, report.metricCode);
  return report;
}

export function canAccessHospitalReport(state: StoreState, actor: User, reportId: string): boolean {
  try { requireHospitalReportAccess(state, requireActiveUser(state, actor), reportId); return true; } catch { return false; }
}
