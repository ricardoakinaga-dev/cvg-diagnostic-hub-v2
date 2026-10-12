import { describe, expect, it } from "vitest";
import { withDisposablePostgresDatabase } from "../support/postgres-test-harness";
import { createDemoState } from "../../src/server/store/fixtures";
import { createApplicationService } from "../../src/server/application/service";
import { processPendingHospitalReportJobs } from "../../src/server/application/hospital-report-service";
import type { HospitalMetricRow } from "../../packages/contracts/src/index";

function currentDay() {
  const from = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
  return { from, to: new Date(Date.parse(from) + 86_400_000).toISOString() };
}

describe("hospital acceptance recovery journeys on disposable PostgreSQL", () => {
  it("exports actual delegated-sector rows after an explicit failed-job retry and rejects the cached actor after delegation is withdrawn", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const base = createDemoState("hospital-acceptance-export-postgres-fixture");
      const first = await database.createStore(base);
      const second = await database.createStore();
      try {
        const writer = createApplicationService(first);
        const reader = createApplicationService(second);
        const manager = base.users.find(user => user.id === "user-manager")!;
        const admin = base.users.find(user => user.id === "user-admin")!;
        const ultrasound = base.users.find(user => user.id === "user-us")!;
        const vet = base.users.find(user => user.id === "user-vet")!;
        const lab = base.users.find(user => user.id === "user-lab")!;
        const delegation = (codes: string[], expectedVersion: number, key: string) => writer.updateUserRole(admin, manager.id, { role: "MANAGER", departmentCode: manager.departmentCode, managedDepartmentCodes: codes, expectedVersion, idempotencyKey: key });
        let managed = await delegation(["ULTRASOUND"], manager.version, "export-delegation-initial");
        const createTask = (actor: typeof manager, title: string, departmentCode: string, key: string) => writer.createHospitalTask(actor, { title, typeId: "hospital-task-type-routine", departmentCode, responsibleUserId: actor.id, priority: "ROUTINE", idempotencyKey: key });
        const one = await createTask(ultrasound, "Delegada um", "ULTRASOUND", "export-delegated-one");
        const two = await createTask(ultrasound, "Delegada dois", "ULTRASOUND", "export-delegated-two");
        const own = await createTask(vet, "Setor próprio excluído pelo filtro", "INPATIENT", "export-own");
        const outside = await createTask(lab, "Setor não delegado", "LABORATORY", "export-outside");
        const filters = { ...currentDay(), departmentCode: "ULTRASOUND" };
        const expectedIds = [one.task.id, two.task.id].sort();
        const report = await writer.createHospitalReport(manager, { name: "Exportação delegada sintética", metricCode: "TASK_CREATED", filters, format: "JSONL", idempotencyKey: "export-definition" });
        const queued = await writer.createHospitalReportJob(manager, { reportId: report.id, expectedReportVersion: report.version, idempotencyKey: "export-job" });
        expect(queued).toMatchObject({ downloadAvailable: false, job: { ownerId: manager.id, status: "PENDING", attempts: 0, definitionSnapshot: { filters, version: report.version, metricDefinitionVersion: "HPL-OPERATIONAL-1" } } });

        // Administrative revocation is a native, audited command. The worker
        // observes it through a different connection rather than an injected error.
        managed = await delegation([], managed.version, "export-delegation-withdraw-before-worker");
        expect(await processPendingHospitalReportJobs(second)).toEqual({ succeeded: 0, failed: 1 });
        const failedStored = (await second.readState()).hospitalReportJobs.find(job => job.id === queued.job.id)!;
        expect(failedStored).toMatchObject({ status: "FAILED", attempts: 1, version: 2, errorCode: "SCOPE_DENIED" });
        expect(failedStored.rows).toBeUndefined();
        await expect(reader.getHospitalReportJob(manager, queued.job.id)).rejects.toMatchObject({ status: 404 });
        await expect(reader.downloadHospitalReportJob(manager, queued.job.id)).rejects.toMatchObject({ status: 404 });

        managed = await delegation(["ULTRASOUND"], managed.version, "export-delegation-restore");
        const failed = await reader.getHospitalReportJob(manager, queued.job.id);
        expect(failed).toMatchObject({ downloadAvailable: false, job: { status: "FAILED", version: 2 } });
        await expect(reader.retryHospitalReportJob(manager, queued.job.id, { expectedVersion: 1, idempotencyKey: "export-stale-retry" })).rejects.toMatchObject({ code: "STALE_VERSION" });
        const retryInput = { expectedVersion: failed.job.version, idempotencyKey: "export-explicit-retry" };
        const retried = await reader.retryHospitalReportJob(manager, queued.job.id, retryInput);
        expect(retried.job).toMatchObject({ status: "PENDING", attempts: 1, version: 3 });
        expect(await writer.retryHospitalReportJob(manager, queued.job.id, retryInput)).toEqual(retried);
        const workers = await Promise.all([processPendingHospitalReportJobs(first), processPendingHospitalReportJobs(second)]);
        expect(workers.reduce((sum, result) => sum + result.succeeded, 0)).toBe(1);
        expect(workers.reduce((sum, result) => sum + result.failed, 0)).toBe(0);
        const completed = await reader.getHospitalReportJob(manager, queued.job.id);
        expect(completed).toMatchObject({ downloadAvailable: true, job: { status: "SUCCEEDED", attempts: 2, version: 4, rowCount: 2 } });

        const firstPage = await reader.listHospitalMetricRows(manager, "TASK_CREATED", { ...filters, limit: 1 });
        expect(firstPage.nextCursor).toBeDefined();
        const lastPage = await reader.listHospitalMetricRows(manager, "TASK_CREATED", { ...filters, limit: 1, cursor: firstPage.nextCursor });
        const listed = [...firstPage.items, ...lastPage.items];
        expect(listed.map(row => row.id).sort()).toEqual(expectedIds);
        expect(firstPage.total).toBe(2); expect(lastPage.nextCursor).toBeUndefined();
        const download = await reader.downloadHospitalReportJob(manager, queued.job.id);
        const exported: HospitalMetricRow[] = download.content.trim().split("\n").map(line => JSON.parse(line));
        expect(download).toMatchObject({ rowCount: 2, format: "JSONL", definition: { filters, version: report.version } });
        expect(exported.map(row => row.id).sort()).toEqual(expectedIds);
        expect(exported).toEqual(listed);
        expect(exported.every(row => row.departmentCode === "ULTRASOUND")).toBe(true);
        expect(exported.some(row => row.id === own.task.id || row.id === outside.task.id)).toBe(false);
        await expect(reader.listHospitalMetricRows(manager, "TASK_CREATED", { ...filters, departmentCode: "LABORATORY" })).rejects.toMatchObject({ status: 404 });

        managed = await delegation([], managed.version, "export-delegation-withdraw-before-download");
        const beforeDenial = await second.readState();
        const reportAudit = () => second.readAuditEvents({ scope: { entities: [{ entityType: "HospitalReport", entityId: report.id }] }, order: "asc", limit: 50 });
        const downloadsBefore = (await reportAudit()).items.filter(event => event.eventType === "HospitalReportExportDownloaded").length;
        expect(downloadsBefore).toBe(1);
        await expect(reader.downloadHospitalReportJob(manager, queued.job.id)).rejects.toMatchObject({ status: 404 });
        expect(await reader.listHospitalReportJobs(manager)).toEqual([]);
        expect(await reader.listHospitalReports(manager)).toEqual([]);
        const afterDenial = await second.readState();
        expect(afterDenial.hospitalReportJobs).toHaveLength(1);
        expect(afterDenial.hospitalReportJobs[0]).toMatchObject({ status: "SUCCEEDED", attempts: 2, rowCount: 2 });
        expect((await reportAudit()).items.filter(event => event.eventType === "HospitalReportExportDownloaded")).toHaveLength(downloadsBefore);
        expect(afterDenial.patientGrants).toEqual(base.patientGrants);
        expect(afterDenial.hospitalTasks.map(task => [task.id, task.phase])).toEqual(beforeDenial.hospitalTasks.map(task => [task.id, task.phase]));
        expect(managed.managedDepartmentCodes).toEqual([]);
      } finally { await database.closeStore(first); await database.closeStore(second); }
    });
  });

  it("preserves pending work and its clinical references through sector archive, permitted continuation and versioned restoration", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const base = createDemoState("hospital-acceptance-sector-postgres-fixture");
      const first = await database.createStore(base);
      const second = await database.createStore();
      try {
        const writer = createApplicationService(first);
        const reader = createApplicationService(second);
        const admin = base.users.find(user => user.id === "user-admin")!;
        const vet = base.users.find(user => user.id === "user-vet")!;
        const input = { title: "Pendência sintética com referência", typeId: "hospital-task-type-routine", departmentCode: "INPATIENT", patientId: "patient-thor", encounterId: "encounter-thor", responsibleUserId: vet.id, priority: "ROUTINE" as const };
        const current = await writer.createHospitalTask(vet, { ...input, idempotencyKey: "sector-existing-continuation" });
        const pending = await writer.createHospitalTask(vet, { ...input, title: "Pendência preservada na restauração", idempotencyKey: "sector-existing-pending" });
        const before = await second.readState();
        const references = (state: typeof before) => ({ patients: state.patients, encounters: state.encounters, admissions: state.admissions, requests: state.requests, items: state.items, samples: state.samples, procedures: state.procedures, schedules: state.schedules, results: state.results, resultVersions: state.resultVersions, notifications: state.notifications, patientGrants: state.patientGrants, users: state.users, accessGroups: state.accessGroups });
        const initialSettings = await writer.putHospitalInstitutionSettings(admin, { name: "Hospital exclusivamente sintético", timezone: "America/Sao_Paulo", expectedVersion: 0, idempotencyKey: "sector-institution-config" });
        const archived = await writer.putHospitalDepartmentCapabilities(admin, "INPATIENT", { archived: true, disabledNewWork: ["TASKS"], expectedVersion: initialSettings.version, idempotencyKey: "sector-archive" });
        expect(archived.departmentCapabilities).toContainEqual({ departmentCode: "INPATIENT", archived: true, disabledNewWork: ["TASKS"] });
        await expect(reader.createHospitalTask(vet, { ...input, idempotencyKey: "sector-denied-new" })).rejects.toMatchObject({ code: "DEPARTMENT_WORK_DISABLED" });
        expect((await reader.listHospitalTasks(vet)).items.map(view => view.task.id).sort()).toEqual([current.task.id, pending.task.id].sort());
        expect((await reader.getHospitalTask(vet, pending.task.id)).task).toMatchObject({ phase: "PENDING", patientId: input.patientId, encounterId: input.encounterId, departmentCode: input.departmentCode, version: 1 });
        const started = await reader.commandHospitalTask(vet, current.task.id, { command: "START", expectedVersion: current.task.version, idempotencyKey: "sector-continue-start" });
        const completed = await writer.commandHospitalTask(vet, current.task.id, { command: "COMPLETE", note: "Continuidade operacional sintética", expectedVersion: started.task.version, idempotencyKey: "sector-continue-complete" });
        expect(completed.task.phase).toBe("COMPLETED");
        const beforeRestore = await second.readState();
        const taskAudit = () => second.readAuditEvents({ scope: { entities: [current.task.id, pending.task.id].map(entityId => ({ entityType: "HospitalTask", entityId })) }, order: "asc", limit: 100 });
        const historyBeforeRestore = (await taskAudit()).items;
        expect(historyBeforeRestore.length).toBeGreaterThanOrEqual(4);
        expect(references(beforeRestore)).toEqual(references(before));
        expect(beforeRestore.hospitalTasks.find(task => task.id === pending.task.id)).toEqual(pending.task);
        await expect(reader.putHospitalDepartmentCapabilities(admin, "INPATIENT", { archived: false, disabledNewWork: [], expectedVersion: initialSettings.version, idempotencyKey: "sector-stale-restore" })).rejects.toMatchObject({ code: "STALE_VERSION" });
        const restoreInput = { archived: false, disabledNewWork: [], expectedVersion: archived.version, idempotencyKey: "sector-explicit-restore" };
        const restored = await reader.putHospitalDepartmentCapabilities(admin, "INPATIENT", restoreInput);
        expect(restored).toMatchObject({ version: archived.version + 1, departmentCapabilities: [{ departmentCode: "INPATIENT", archived: false, disabledNewWork: [] }] });
        expect(await writer.putHospitalDepartmentCapabilities(admin, "INPATIENT", restoreInput)).toEqual(restored);
        const resumed = await reader.createHospitalTask(vet, { ...input, title: "Nova atividade após restauração", idempotencyKey: "sector-new-after-restore" });
        expect(resumed.task).toMatchObject({ phase: "PENDING", departmentCode: "INPATIENT", patientId: input.patientId, encounterId: input.encounterId });
        const after = await second.readState();
        expect(references(after)).toEqual(references(before));
        expect(after.hospitalTasks.find(task => task.id === pending.task.id)).toEqual(pending.task);
        expect(after.hospitalTasks.find(task => task.id === current.task.id)).toEqual(completed.task);
        expect(after.hospitalTasks).toHaveLength(3);
        expect((await taskAudit()).items).toEqual(historyBeforeRestore);
        const capabilityAudit = await second.readAuditEvents({ scope: { entities: [{ entityType: "Department", entityId: "INPATIENT" }] }, order: "asc", limit: 50 });
        expect(capabilityAudit.items.filter(event => event.eventType === "HospitalDepartmentCapabilitiesChanged")).toHaveLength(2);
        await database.closeStore(first); await database.closeStore(second);
        const reopened = await database.createStore();
        try {
          const persisted = await reopened.readState();
          expect(persisted.hospitalInstitutionSettings[0]).toEqual(restored);
          expect(persisted.hospitalTasks.find(task => task.id === pending.task.id)).toEqual(pending.task);
          expect(persisted.hospitalTasks.find(task => task.id === resumed.task.id)).toEqual(resumed.task);
          expect(references(persisted)).toEqual(references(before));
        } finally { await database.closeStore(reopened); }
      } finally { await database.closeStore(first); await database.closeStore(second); }
    });
  });
});
