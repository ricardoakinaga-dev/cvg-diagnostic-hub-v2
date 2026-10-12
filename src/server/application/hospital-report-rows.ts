import type { HospitalMetricCode, HospitalMetricFilters, HospitalMetricRow } from "@cvg/contracts";
import type { AuditTransactionReader, ClinicalArchiveRow, DiagnosticItem, DiagnosticRequest, StoreState, User } from "../domain/models";
import { archivedEntitiesOf } from "../domain/clinical-archive";
import { findById } from "../domain/state-index";
import { canAccessResource } from "../security/authorization";
import { ApiError } from "../http/envelope";
import { canViewItem } from "./service-common";
import { canAccessHospitalTask, requireHospitalTaskAccess } from "./hospital-task-policy";
import { canAccessHospitalPlan } from "./hospital-plan-policy";
import { hospitalHandoffView } from "./hospital-shift-policy";

/** Private provenance stays inside StoredJob.rows, which public job DTOs omit. */
export interface CapturedHospitalMetricRow extends HospitalMetricRow {
  sourceRequestId?: string;
  sourceHandoffId?: string;
}
const key = (row: Pick<HospitalMetricRow, "targetType" | "id">) => `${row.targetType}:${row.id}`;
type ArchiveReader = NonNullable<AuditTransactionReader["readArchivedRequest"]>;

export function captureHospitalReportRows(state: StoreState, actor: User, code: HospitalMetricCode, filters: HospitalMetricFilters, rows: HospitalMetricRow[]): CapturedHospitalMetricRow[] {
  const origins = new Map<string, string>();
  if (code === "ACTIVITY_HANDED_OVER") {
    const selected = new Map(rows.map((row) => [key(row), row]));
    // Matches the metric's latest-event selection and its first-source tie rule.
    for (const handoff of state.hospitalHandoffs) {
      if (handoff.state !== "ACCEPTED" || filters.departmentCode && handoff.departmentCode !== filters.departmentCode) continue;
      try {
        for (const entry of hospitalHandoffView(state, actor, handoff).activities) {
          const targetKey = `${entry.targetType}:${entry.targetId}`;
          if (!origins.has(targetKey) && selected.get(targetKey)?.occurredAt === handoff.acceptedAt) origins.set(targetKey, handoff.id);
        }
      } catch { continue; }
    }
  }
  return rows.map((row) => ({ ...row,
    ...(row.targetType === "DIAGNOSTIC_ITEM" ? { sourceRequestId: findById(state.items, row.id)?.requestId } : {}),
    ...(code === "ACTIVITY_HANDED_OVER" ? { sourceHandoffId: origins.get(key(row)) } : {})
  }));
}

function sourceRequestId(row: CapturedHospitalMetricRow): string | undefined {
  if (row.targetType !== "DIAGNOSTIC_ITEM") return;
  if (row.sourceRequestId) return row.sourceRequestId;
  // Earlier generated jobs already stored this server-derived request link.
  const match = /^\/requests\/([^/?#]+)#([^?#]+)$/.exec(row.deepLink);
  return match?.[2] === row.id ? match[1] : undefined;
}

export async function readHospitalReportArchiveReferences(state: StoreState, rows: CapturedHospitalMetricRow[], readRequest: ArchiveReader): Promise<Map<string, ClinicalArchiveRow[] | undefined>> {
  const hotIds = new Set(state.items.map((item) => item.id));
  const requestIds = new Set(rows.filter((row) => row.targetType === "DIAGNOSTIC_ITEM" && !hotIds.has(row.id)).flatMap((row) => sourceRequestId(row) ?? []));
  const archive = new Map<string, ClinicalArchiveRow[] | undefined>();
  // Bounded by this job's selected references; never scan the global archive.
  for (const requestId of requestIds) archive.set(requestId, await readRequest(requestId));
  return archive;
}

function diagnosticReference(state: StoreState, actor: User, row: CapturedHospitalMetricRow, archive: Map<string, ClinicalArchiveRow[] | undefined>): Pick<HospitalMetricRow, "label" | "departmentCode" | "deepLink"> | undefined {
  const hotItem = findById(state.items, row.id);
  if (hotItem) {
    if (!canViewItem(state, actor, hotItem)) return;
    return { label: findById(state.services, hotItem.serviceId)?.name ?? "Exame", departmentCode: hotItem.departmentCode, deepLink: `/requests/${hotItem.requestId}#${hotItem.id}` };
  }
  const requestId = sourceRequestId(row); const rows = requestId ? archive.get(requestId) : undefined;
  if (!rows) return;
  const request = archivedEntitiesOf<DiagnosticRequest>(rows, "requests").find((entry) => entry.id === requestId);
  const item = archivedEntitiesOf<DiagnosticItem>(rows, "items").find((entry) => entry.id === row.id && entry.requestId === requestId);
  if (!request || !item || !findById(state.patients, request.patientId)) return;
  const service = findById(state.services, item.serviceId);
  const serviceCode = service?.code ?? item.definitionSnapshot?.definition.code ?? item.serviceId;
  if (!canAccessResource(actor, "item.view", { patientId: request.patientId, departmentCode: item.departmentCode, serviceCode })) return;
  return { label: service?.name ?? item.definitionSnapshot?.definition.name ?? "Exame", departmentCode: item.departmentCode, deepLink: `/archive/${request.id}` };
}

/** Resolve captured objects under current rights, independently of today's metric membership. */
export async function resolveHospitalReportRows(state: StoreState, actor: User, code: HospitalMetricCode, rows: CapturedHospitalMetricRow[], audit?: AuditTransactionReader): Promise<HospitalMetricRow[]> {
  const archive = await readHospitalReportArchiveReferences(state, rows, audit?.readArchivedRequest ?? (async () => { throw new ApiError("ARCHIVE_READ_UNAVAILABLE", "O arquivo clínico está temporariamente indisponível.", 503); }));
  return rows.flatMap((row) => {
    if (code === "ACTIVITY_HANDED_OVER") {
      const handoff = state.hospitalHandoffs.find((entry) => entry.id === row.sourceHandoffId && entry.state === "ACCEPTED" && entry.acceptedAt === row.occurredAt && entry.entries.some((target) => target.targetType === row.targetType && target.targetId === row.id));
      if (!handoff) return [];
      try { requireHospitalTaskAccess(state, actor, "shift.view", handoff); } catch { return []; }
    }
    let reference: Pick<HospitalMetricRow, "label" | "departmentCode" | "deepLink"> | undefined;
    if (row.targetType === "DIAGNOSTIC_ITEM") reference = diagnosticReference(state, actor, row, archive);
    else if (row.targetType === "HOSPITAL_TASK") {
      const task = findById(state.hospitalTasks, row.id);
      if (task && !task.isDraft && !task.draftCancelledAt && canAccessHospitalTask(state, actor, "hospital_task.view", task)) reference = { label: code === "ACTIVITY_HANDED_OVER" ? task.title : `${task.taskCode} · ${task.title}`, departmentCode: task.departmentCode, deepLink: `/planner/tasks/${task.id}` };
    } else if (row.targetType === "HOSPITAL_PLAN") {
      const plan = findById(state.hospitalPlans, row.id);
      const departmentCode = plan?.departmentCodes.find((departmentCode) => canAccessHospitalTask(state, actor, "plan.view", { departmentCode, patientId: plan.patientId }));
      if (plan && departmentCode && canAccessHospitalPlan(state, actor, "plan.view", plan)) reference = { label: `${plan.code} · ${plan.title}`, departmentCode, deepLink: `/planner/plans/${plan.id}` };
    } else if (row.targetType === "HOSPITAL_SHIFT") {
      const shift = findById(state.hospitalShifts, row.id);
      if (shift && canAccessHospitalTask(state, actor, "shift.view", shift)) reference = { label: `${shift.code} · ${shift.name}`, departmentCode: shift.departmentCode, deepLink: `/planner/shifts/${shift.id}` };
    }
    return reference ? [{ targetType: row.targetType, id: row.id, occurredAt: row.occurredAt, status: row.status, ...reference }] : [];
  });
}
