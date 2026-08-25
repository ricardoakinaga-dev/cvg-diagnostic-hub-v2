import { deriveOperationalContext } from "@cvg/domain";
import type { DiagnosticItem, DiagnosticService } from "../domain/models";

export function operationalContextFor(item: DiagnosticItem, service: DiagnosticService, asOf = new Date().toISOString(), requestingDepartmentCode?: string) {
  return deriveOperationalContext({
    status: item.status,
    workflowType: item.workflowType,
    priority: item.priority,
    departmentCode: item.departmentCode || service.departmentCode,
    requestingDepartmentCode,
    requiresSample: service.requiresSample,
    requiresSchedule: service.requiresSchedule,
    requestedAt: item.requestedAt,
    receivedAt: item.receivedAt,
    startedAt: item.startedAt,
    performedAt: item.performedAt,
    releasedAt: item.releasedAt,
    dueAt: item.dueAt,
    asOf
  });
}

export function nextActionFor(item: DiagnosticItem, service: DiagnosticService): string {
  return operationalContextFor(item, service).nextAction.label;
}
