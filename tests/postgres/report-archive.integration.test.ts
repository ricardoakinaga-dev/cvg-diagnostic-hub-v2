import { describe, expect, it, vi } from "vitest";
import { withDisposablePostgresDatabase } from "../support/postgres-test-harness";
import { createDemoState } from "../../src/server/store/fixtures";
import { createApplicationService } from "../../src/server/application/service";
import { processPendingHospitalReportJobs } from "../../src/server/application/hospital-report-service";

describe("captured reports and native cold references on disposable PostgreSQL", () => {
  it("keeps generated pending facts after completion and reopening an independent reader", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const base = createDemoState("synthetic-frozen-report-pg"); const writer = await database.createStore(base);
      let reader = await database.createStore();
      try {
        const actor = base.users.find((user) => user.id === "user-us")!; const service = createApplicationService(writer);
        const task = await service.createHospitalTask(actor, { title: "Pendência sintética", typeId: "hospital-task-type-routine", departmentCode: "ULTRASOUND", responsibleUserId: actor.id, priority: "ROUTINE", idempotencyKey: "captured-pending-task" });
        const filters = { from: "2020-01-01T00:00:00.000Z", to: "2090-01-01T00:00:00.000Z", departmentCode: "ULTRASOUND" };
        const report = await service.createHospitalReport(actor, { name: "Pendência capturada", metricCode: "TASK_PENDING", filters, format: "JSONL", idempotencyKey: "captured-pending-definition" });
        const job = await service.createHospitalReportJob(actor, { reportId: report.id, expectedReportVersion: 1, idempotencyKey: "captured-pending-job" });
        expect(await processPendingHospitalReportJobs(writer)).toEqual({ succeeded: 1, failed: 0 });
        const started = await service.commandHospitalTask(actor, task.task.id, { command: "START", expectedVersion: 1, idempotencyKey: "captured-start" });
        await service.commandHospitalTask(actor, task.task.id, { command: "COMPLETE", expectedVersion: started.task.version, idempotencyKey: "captured-complete" });
        await database.closeStore(reader); reader = await database.createStore();
        const reopened = createApplicationService(reader);
        expect((await reopened.listHospitalMetricRows(actor, "TASK_PENDING", filters)).total).toBe(0);
        const artifact = await reopened.downloadHospitalReportJob(actor, job.job.id);
        expect(artifact.rowCount).toBe(1);
        expect(JSON.parse(artifact.content.trim())).toMatchObject({ id: task.task.id, occurredAt: task.task.createdAt, status: "PENDING" });
        expect((await reader.readState()).hospitalReportJobs[0]).toMatchObject({ status: "SUCCEEDED", attempts: 1, rowCount: 1 });
        await writer.transaction((state) => ({ state: { ...state, accessGroups: state.accessGroups.map((group) => group.id === actor.accessGroupId ? { ...group, permissions: group.permissions.filter((permission) => permission !== "hospital_task.view") } : group) }, result: undefined }));
        await expect(reopened.downloadHospitalReportJob(actor, job.job.id)).rejects.toMatchObject({ status: 404 });
      } finally { await database.closeStore(writer); await database.closeStore(reader); }
    });
  });

  it("reads cold facts with one runtime connection and observes another instance revoking access during archive I/O", async () => {
    vi.stubEnv("DB_POOL_MAX", "1");
    try {
      await withDisposablePostgresDatabase(async (database) => {
        const base = createDemoState("synthetic-cold-report-pg"); const writer = await database.createStore(base); const reader = await database.createStore();
        try {
          const actor = base.users.find((user) => user.id === "user-us")!; const vet = base.users.find((user) => user.id === "user-vet")!;
          const service = createApplicationService(writer);
          const request = await service.createRequest(vet, { patientId: "patient-thor", encounterId: "encounter-thor", admissionId: "admission-thor", priority: "ROUTINE", items: [{ serviceId: "service-ultrasound" }] }, { idempotencyKey: "cold-request" });
          const itemId = request.items[0].id;
          await service.cancelItem(vet, itemId, { reasonCode: "CLINICAL_DECISION", expectedVersion: 1, idempotencyKey: "cold-settle" });
          await writer.transaction((state) => ({ state: { ...state, requests: state.requests.map((entry) => entry.id === request.id ? { ...entry, updatedAt: "2020-10-11T09:00:00.000Z" } : entry), items: state.items.map((item) => item.id === itemId ? { ...item, requestedAt: "2020-10-11T08:00:00.000Z" } : item) }, result: undefined }));
          const filters = { from: "2020-10-11T00:00:00.000Z", to: "2020-10-12T00:00:00.000Z", departmentCode: "ULTRASOUND" };
          const report = await service.createHospitalReport(actor, { name: "Exame no arquivo", metricCode: "DIAGNOSTIC_REQUESTED", filters, format: "JSONL", idempotencyKey: "cold-definition" });
          const job = await service.createHospitalReportJob(actor, { reportId: report.id, expectedReportVersion: 1, idempotencyKey: "cold-job" });
          expect(await processPendingHospitalReportJobs(writer)).toEqual({ succeeded: 1, failed: 0 });
          expect((await writer.archiveClinicalRecords({ now: new Date("2026-10-11T12:00:00.000Z"), activeMonths: 24 })).requestIds).toContain(request.id);
          const persisted = await database.query("SELECT data->'rows' AS rows FROM cvg_runtime_entities WHERE collection = 'hospitalReportJobs' AND entity_key = $1", [job.job.id]);
          expect(persisted.rows[0]).toMatchObject({ rows: [{ sourceRequestId: request.id, id: itemId }] });
          expect((await reader.readState()).items.some((item) => item.id === itemId)).toBe(false);
          const nativeRead = reader.readArchivedRequest.bind(reader); const reads = vi.spyOn(reader, "readArchivedRequest");
          const independent = createApplicationService(reader); const artifact = await independent.downloadHospitalReportJob(actor, job.job.id);
          expect(artifact.rowCount).toBe(1);
          expect(JSON.parse(artifact.content.trim())).toMatchObject({ id: itemId, occurredAt: "2020-10-11T08:00:00.000Z", status: "CANCELLED", deepLink: `/archive/${request.id}` });
          // Only preloading uses the public store reader. The final cold read
          // uses the locked transaction's connection, avoiding a max=1 deadlock.
          expect(reads).toHaveBeenCalledTimes(1);
          expect(artifact.content).not.toContain("sourceRequestId");
          reads.mockImplementationOnce(async (requestId) => {
            const rows = await nativeRead(requestId);
            await writer.transaction((state) => ({ state: { ...state, accessGroups: state.accessGroups.map((group) => group.id === actor.accessGroupId ? { ...group, permissions: group.permissions.filter((permission) => permission !== "item.view") } : group) }, result: undefined }));
            return rows;
          });
          await expect(independent.downloadHospitalReportJob(actor, job.job.id)).rejects.toMatchObject({ status: 404 });
          expect((await database.query("SELECT count(*)::int AS count FROM audit_events WHERE event_type = 'HospitalReportExportDownloaded' AND entity_id = $1", [report.id])).rows).toEqual([{ count: 1 }]);
        } finally { await database.closeStore(writer); await database.closeStore(reader); }
      });
    } finally { vi.unstubAllEnvs(); }
  });
});
