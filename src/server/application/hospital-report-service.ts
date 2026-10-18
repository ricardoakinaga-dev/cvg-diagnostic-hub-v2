import type { HospitalReportArtifact, HospitalReportDefinition, HospitalReportJob, HospitalReportJobView, HospitalMetricRow } from "@cvg/contracts";
import type { StoreState, User } from "../domain/models";
import type { ApplicationServiceContext } from "./service-context";
import type { z } from "zod";
import { hospitalReportCreateSchema, hospitalReportPatchSchema, hospitalReportJobCreateSchema, hospitalReportJobRetrySchema } from "../http/hospital-analytics-schemas";
import { ApiError } from "../http/envelope";
import { requireActiveUser, requirePermission, requireIdempotencyKey, ensureExpectedVersion, withIdempotency, saveIdempotency, createAudit, createOutbox, id, now } from "./service-common";
import { deriveHospitalMetricRows, requireHospitalMetricAccess } from "./hospital-metrics-service";
import { requireHospitalTaskAccess } from "./hospital-task-policy";
import { requireHospitalReportAccess as requireReportAccess } from "./hospital-report-policy";
import { captureHospitalReportRows, readHospitalReportArchiveReferences, resolveHospitalReportRows } from "./hospital-report-rows";
import { validateTaskBody } from "./hospital-task-common";
import type { CommandMeta } from "./service-types";

type CreateInput = z.input<typeof hospitalReportCreateSchema> & CommandMeta;
type PatchInput = z.input<typeof hospitalReportPatchSchema> & CommandMeta;
type JobInput = z.input<typeof hospitalReportJobCreateSchema> & CommandMeta;
type RetryInput = z.input<typeof hospitalReportJobRetrySchema> & CommandMeta;
type StoredJob = StoreState["hospitalReportJobs"][number];
function normalizeReport(state: StoreState, actor: User, input: CreateInput) {
  const filters = { ...input.filters, departmentCode: input.filters.departmentCode?.toUpperCase() };
  requireHospitalMetricAccess(state, actor, filters, input.metricCode);
  const sharedDepartmentCode = input.sharedDepartmentCode?.toUpperCase();
  if (sharedDepartmentCode) requireHospitalTaskAccess(state, actor, "hospital_report.manage", { departmentCode: sharedDepartmentCode });
  if (state.hospitalReports.some((entry) => entry.ownerId === actor.id && entry.active && entry.name.toLocaleLowerCase("pt-BR") === input.name.trim().toLocaleLowerCase("pt-BR"))) throw new ApiError("CONFLICT", "Já existe um relatório ativo com esse nome.", 409);
  return { name: input.name.trim(), metricCode: input.metricCode, metricDefinitionVersion: "HPL-OPERATIONAL-1" as const, filters, format: input.format, sharedDepartmentCode };
}
function jobView(job: StoredJob): HospitalReportJobView {
  const { rows: _rows, ...publicJob } = job;
  return { job: publicJob, downloadAvailable: job.status === "SUCCEEDED" };
}
function existingJob(state: StoreState, actor: User, jobId: string): StoredJob {
  requirePermission(actor, "hospital_report.export", {});
  const job = state.hospitalReportJobs.find((entry) => entry.id === jobId && entry.ownerId === actor.id);
  if (!job) throw new ApiError("SCOPE_DENIED", "Exportação indisponível.", 404);
  requireReportAccess(state, actor, job.reportId);
  requireHospitalMetricAccess(state, actor, job.definitionSnapshot.filters, job.definitionSnapshot.metricCode);
  return job;
}
function recordReportChange(state: StoreState, actor: User, entityId: string, event: string, correlationId?: string): StoreState {
  const correlation = correlationId ?? id("corr");
  return { ...state, auditEvents: [...state.auditEvents, createAudit(event, actor.id, "HospitalReport", entityId, correlation)], outbox: [...state.outbox, createOutbox(event, "HospitalReport", entityId, correlation, { reportId: entityId })] };
}
function csvCell(value: string): string {
  // Neutralize spreadsheet formulas in both direct and whitespace-prefixed cells.
  const safe = /^[\s\u0000-\u001f]*[=+@-]/u.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}
function artifact(job: StoredJob, rows: HospitalMetricRow[]): HospitalReportArtifact {
  const format = job.definitionSnapshot.format;
  const fields = ["targetType", "id", "label", "departmentCode", "occurredAt", "status", "deepLink"] as const;
  const content = format === "JSONL" ? rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : "") : [fields.join(","), ...rows.map((row) => fields.map((field) => csvCell(row[field])).join(","))].join("\r\n") + "\r\n";
  return { jobId: job.id, name: `${job.id}.${format === "CSV" ? "csv" : "jsonl"}`, format, contentType: format === "CSV" ? "text/csv" : "application/x-ndjson", content, rowCount: rows.length, generatedAt: job.generatedAt!, definition: structuredClone(job.definitionSnapshot) };
}
export function createHospitalReportService({ store }: Pick<ApplicationServiceContext, "store">) {
  return {
    async listHospitalReports(actor: User): Promise<HospitalReportDefinition[]> {
      const state = await store.readState(); const current = requireActiveUser(state, actor); requirePermission(current, "hospital_report.view", {});
      return state.hospitalReports.filter((entry) => { try { requireReportAccess(state, current, entry.id); return true; } catch { return false; } }).map((entry) => structuredClone(entry));
    },
    async createHospitalReport(actor: User, input: CreateInput): Promise<HospitalReportDefinition> {
      validateTaskBody(hospitalReportCreateSchema, input);
      return store.transaction((state) => {
        const current = requireActiveUser(state, actor); requirePermission(current, "hospital_report.manage", {}); requireIdempotencyKey(input.idempotencyKey);
        requireHospitalMetricAccess(state, current, input.filters, input.metricCode);
        const scope = "POST:/hospital-reports"; const replay = withIdempotency<HospitalReportDefinition>(state, current.id, scope, input.idempotencyKey, { input });
        if (replay.found) { const result = requireReportAccess(state, current, replay.existing!.id, true); return { state, result }; }
        const timestamp = now(); const report: HospitalReportDefinition = { ...normalizeReport(state, current, input), id: id("hospital-report"), ownerId: current.id, active: true, version: 1, createdAt: timestamp, updatedAt: timestamp };
        let next = { ...state, hospitalReports: [...state.hospitalReports, report] }; next = recordReportChange(next, current, report.id, "HospitalReportCreated", input.correlationId);
        return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, report, { input }), result: report };
      });
    },
    async updateHospitalReport(actor: User, reportId: string, input: PatchInput): Promise<HospitalReportDefinition> {
      validateTaskBody(hospitalReportPatchSchema, input);
      return store.transaction((state) => {
        const current = requireActiveUser(state, actor); const previous = requireReportAccess(state, current, reportId, true); requireIdempotencyKey(input.idempotencyKey);
        const scope = `PATCH:/hospital-reports/${reportId}`; const replay = withIdempotency<HospitalReportDefinition>(state, current.id, scope, input.idempotencyKey, { input }); if (replay.found) return { state, result: previous };
        ensureExpectedVersion(previous.version, input.expectedVersion);
        const merged: CreateInput = { name: input.name ?? previous.name, metricCode: input.metricCode ?? previous.metricCode, filters: input.filters ?? previous.filters, format: input.format ?? previous.format, sharedDepartmentCode: input.sharedDepartmentCode === null ? undefined : input.sharedDepartmentCode ?? previous.sharedDepartmentCode };
        const normalized = normalizeReport({ ...state, hospitalReports: state.hospitalReports.filter((entry) => entry.id !== reportId) }, current, merged);
        const report = { ...previous, ...normalized, active: input.active ?? previous.active, version: previous.version + 1, updatedAt: now() };
        const next = recordReportChange({ ...state, hospitalReports: state.hospitalReports.map((entry) => entry.id === reportId ? report : entry) }, current, reportId, "HospitalReportUpdated", input.correlationId);
        return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, report, { input }), result: report };
      });
    },
    async createHospitalReportJob(actor: User, input: JobInput): Promise<HospitalReportJobView> {
      validateTaskBody(hospitalReportJobCreateSchema, input);
      return store.transaction((state) => {
        const current = requireActiveUser(state, actor); requirePermission(current, "hospital_report.export", {}); const report = requireReportAccess(state, current, input.reportId); requireIdempotencyKey(input.idempotencyKey);
        const scope = "POST:/hospital-report-jobs"; const replay = withIdempotency<HospitalReportJobView>(state, current.id, scope, input.idempotencyKey, { input }); if (replay.found) return { state, result: jobView(existingJob(state, current, replay.existing!.job.id)) };
        ensureExpectedVersion(report.version, input.expectedReportVersion); if (!report.active) throw new ApiError("INVALID_STATE_TRANSITION", "Reative a definição para gerar uma nova exportação.", 409);
        const { name, metricCode, metricDefinitionVersion, filters, format, version } = report; const timestamp = now();
        const job: HospitalReportJob = { id: id("hospital-report-job"), reportId: report.id, ownerId: current.id, definitionSnapshot: structuredClone({ name, metricCode, metricDefinitionVersion, filters, format, version }), status: "PENDING", attempts: 0, version: 1, createdAt: timestamp, updatedAt: timestamp };
        const result = jobView(job); const next = recordReportChange({ ...state, hospitalReportJobs: [...state.hospitalReportJobs, job] }, current, report.id, "HospitalReportExportQueued", input.correlationId);
        return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, result, { input }), result };
      });
    },
    async listHospitalReportJobs(actor: User): Promise<HospitalReportJobView[]> {
      const state = await store.readState(); const current = requireActiveUser(state, actor); requirePermission(current, "hospital_report.export", {});
      return state.hospitalReportJobs.flatMap((job) => { try { return [jobView(existingJob(state, current, job.id))]; } catch { return []; } });
    },
    async getHospitalReportJob(actor: User, jobId: string): Promise<HospitalReportJobView> { const state = await store.readState(); return jobView(existingJob(state, requireActiveUser(state, actor), jobId)); },
    async retryHospitalReportJob(actor: User, jobId: string, input: RetryInput): Promise<HospitalReportJobView> {
      validateTaskBody(hospitalReportJobRetrySchema, input);
      return store.transaction((state) => {
        const current = requireActiveUser(state, actor); const previous = existingJob(state, current, jobId); requireIdempotencyKey(input.idempotencyKey); const scope = `POST:/hospital-report-jobs/${jobId}/retry`;
        const replay = withIdempotency<HospitalReportJobView>(state, current.id, scope, input.idempotencyKey, { input }); if (replay.found) return { state, result: jobView(previous) };
        ensureExpectedVersion(previous.version, input.expectedVersion); if (previous.status !== "FAILED") throw new ApiError("INVALID_STATE_TRANSITION", "Somente exportações com falha podem ser reenfileiradas.", 409);
        const job: StoredJob = { ...previous, status: "PENDING", errorCode: undefined, rows: undefined, rowCount: undefined, generatedAt: undefined, version: previous.version + 1, updatedAt: now() };
        const result = jobView(job); const next = recordReportChange({ ...state, hospitalReportJobs: state.hospitalReportJobs.map((entry) => entry.id === job.id ? job : entry) }, current, job.reportId, "HospitalReportExportRetried", input.correlationId);
        return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, result, { input }), result };
      });
    },
    async downloadHospitalReportJob(actor: User, jobId: string): Promise<HospitalReportArtifact> {
      const initial = await store.readState(); const initialJob = existingJob(initial, requireActiveUser(initial, actor), jobId);
      if (initialJob.status !== "SUCCEEDED" || !initialJob.rows || !initialJob.generatedAt) throw new ApiError("INVALID_STATE_TRANSITION", "A exportação ainda não está disponível.", 409);
      // Read outside the write queue first; revocation during archive I/O is
      // observed by the final authoritative transaction. Never serialize it yet.
      await readHospitalReportArchiveReferences(initial, initialJob.rows, (requestId) => store.readArchivedRequest(requestId));
      return store.transaction(async (state, audit) => {
        const current = requireActiveUser(state, actor); const job = existingJob(state, current, jobId);
        if (job.status !== "SUCCEEDED" || !job.rows || !job.generatedAt) throw new ApiError("INVALID_STATE_TRANSITION", "A exportação ainda não está disponível.", 409);
        // Same-connection cold reads under the final lock also exclude purged
        // references. Refresh labels/links without recalculating captured facts.
        const rows = await resolveHospitalReportRows(state, current, job.definitionSnapshot.metricCode, job.rows, audit);
        const next = recordReportChange(state, current, job.reportId, "HospitalReportExportDownloaded"); return { state: next, result: artifact(job, rows) };
      });
    }
  };
}
/** Serializes competing workers using the same authoritative state transaction. */
export async function processPendingHospitalReportJobs(store: ApplicationServiceContext["store"], limit = 10, asOf = now()) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 25 || !Number.isFinite(Date.parse(asOf))) throw new ApiError("VALIDATION_ERROR", "Lote de exportação inválido.", 400);
  return store.transaction((state) => {
    let next = state; let succeeded = 0; let failed = 0;
    for (const pending of state.hospitalReportJobs.filter((job) => job.status === "PENDING").sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).slice(0, limit)) {
      let job: StoredJob;
      try {
        const actor = requireActiveUser(next, next.users.find((user) => user.id === pending.ownerId)!); existingJob(next, actor, pending.id);
        const { metricCode, filters } = pending.definitionSnapshot;
        const rows = captureHospitalReportRows(next, actor, metricCode, filters, deriveHospitalMetricRows(next, actor, metricCode, filters, asOf));
        if (rows.length > 50_000) throw new ApiError("REPORT_ROW_LIMIT", "Restrinja o intervalo para exportar até 50.000 linhas.", 422);
        job = { ...pending, rows, status: "SUCCEEDED", rowCount: rows.length, generatedAt: asOf, attempts: pending.attempts + 1, version: pending.version + 1, updatedAt: asOf }; succeeded++;
      } catch (error) {
        job = { ...pending, rows: undefined, status: "FAILED", errorCode: error instanceof ApiError ? error.code : "REPORT_GENERATION_FAILED", attempts: pending.attempts + 1, version: pending.version + 1, updatedAt: asOf }; failed++;
      }
      next = recordReportChange({ ...next, hospitalReportJobs: next.hospitalReportJobs.map((entry) => entry.id === job.id ? job : entry) }, { id: "system-report-worker" } as User, job.reportId, job.status === "SUCCEEDED" ? "HospitalReportExportGenerated" : "HospitalReportExportFailed");
    }
    return { state: next, result: { succeeded, failed } };
  });
}
