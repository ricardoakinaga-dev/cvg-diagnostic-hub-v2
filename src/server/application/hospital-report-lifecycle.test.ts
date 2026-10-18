import { describe, expect, it } from "vitest";
import { hospitalOperationFixture } from "../../test/hospital-operation-fixtures";
import { processPendingHospitalReportJobs } from "./hospital-report-service";

const filters = { from: "2020-01-01T00:00:00Z", to: "2030-01-01T00:00:00Z", departmentCode: "ULTRASOUND" };
const definition = { name: "Relatório sintético", metricCode: "TASK_CREATED" as const, filters, format: "CSV" as const, sharedDepartmentCode: "ULTRASOUND", idempotencyKey: "definition" };
describe("report definitions, exports and current authorization across their lifecycle", () => {
  it("keeps names unique per current owner, binds replay and versions, and permits explicit removal of sharing", async () => {
    const f = hospitalOperationFixture(); const actor = f.user("user-us"); const report = await f.service.createHospitalReport(actor, definition);
    expect(await f.service.createHospitalReport(actor, definition)).toEqual(report);
    await expect(f.service.createHospitalReport(actor, { ...definition, name: "RELATÓRIO SINTÉTICO", idempotencyKey: "duplicate-name" })).rejects.toMatchObject({ code: "CONFLICT" });
    const input = { name: "Outro nome", metricCode: "TASK_PENDING" as const, filters: { ...filters, from: "2021-01-01T00:00:00Z" }, format: "JSONL" as const, sharedDepartmentCode: null, expectedVersion: 1, idempotencyKey: "change-definition" };
    const changed = await f.service.updateHospitalReport(actor, report.id, input);
    expect(changed).toMatchObject({ version: 2, metricCode: "TASK_PENDING", format: "JSONL", name: "Outro nome", sharedDepartmentCode: undefined });
    expect(await f.service.updateHospitalReport(actor, report.id, input)).toEqual(changed);
    await expect(f.service.updateHospitalReport(actor, report.id, { name: "Competing", expectedVersion: 1, idempotencyKey: "stale" })).rejects.toMatchObject({ code: "STALE_VERSION" });
    const inactive = await f.service.updateHospitalReport(actor, report.id, { active: false, expectedVersion: 2, idempotencyKey: "deactivate" });
    await expect(f.service.createHospitalReportJob(actor, { reportId: report.id, expectedReportVersion: inactive.version, idempotencyKey: "inactive-export" })).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    expect((await f.service.listHospitalReports(f.user("user-manager"))).some((entry) => entry.id === report.id)).toBe(false);
  });

  it("lists only authorized owner jobs and keeps generated definition snapshots after definition edits", async () => {
    const f = hospitalOperationFixture(); const actor = f.user("user-us"); await f.task("report-row");
    const report = await f.service.createHospitalReport(actor, definition);
    await expect(f.service.createHospitalReportJob(actor, { reportId: report.id, expectedReportVersion: 4, idempotencyKey: "wrong-version" })).rejects.toMatchObject({ code: "STALE_VERSION" });
    const input = { reportId: report.id, expectedReportVersion: 1, idempotencyKey: "queued-export" }; const queued = await f.service.createHospitalReportJob(actor, input);
    await expect(f.service.downloadHospitalReportJob(actor, queued.job.id)).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    await expect(f.service.retryHospitalReportJob(actor, queued.job.id, { expectedVersion: 1, idempotencyKey: "retry-pending" })).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    expect(await f.service.listHospitalReportJobs(f.user("user-manager"))).toEqual([]);
    await expect(f.service.getHospitalReportJob(f.user("user-manager"), queued.job.id)).rejects.toMatchObject({ status: 404 });
    await f.service.updateHospitalReport(actor, report.id, { name: "Nome posterior", expectedVersion: 1, idempotencyKey: "later-definition" });
    expect(await processPendingHospitalReportJobs(f.store)).toEqual({ succeeded: 1, failed: 0 });
    const replay = await f.service.createHospitalReportJob(actor, input);
    expect(replay).toMatchObject({ downloadAvailable: true, job: { status: "SUCCEEDED", definitionSnapshot: { name: definition.name, version: 1 } } });
    expect((await f.service.listHospitalReportJobs(actor)).map((entry) => entry.job.id)).toEqual([queued.job.id]);
    const output = await f.service.downloadHospitalReportJob(actor, queued.job.id); expect(output.definition.name).toBe(definition.name); expect(output.rowCount).toBe(1);
    await f.store.transaction((state) => ({ state: { ...state, accessGroups: state.accessGroups.map((entry) => entry.id === actor.accessGroupId ? { ...entry, permissions: entry.permissions.filter((permission) => permission !== "hospital_task.view") } : entry) }, result: undefined }));
    expect(await f.service.listHospitalReportJobs(actor)).toEqual([]);
    await expect(f.service.createHospitalReportJob(actor, input)).rejects.toMatchObject({ status: 404 });
  });

  it("does not reexecute a retry replay and binds worker attempts to current grants", async () => {
    const f = hospitalOperationFixture(); const actor = f.user("user-us"); const group = f.store.getState().accessGroups.find((entry) => entry.id === actor.accessGroupId)!;
    const report = await f.service.createHospitalReport(actor, definition); const queued = await f.service.createHospitalReportJob(actor, { reportId: report.id, expectedReportVersion: 1, idempotencyKey: "failed-job" });
    await f.store.transaction((state) => ({ state: { ...state, accessGroups: state.accessGroups.map((entry) => entry.id === group.id ? { ...entry, permissions: entry.permissions.filter((permission) => permission !== "hospital_task.view") } : entry) }, result: undefined }));
    expect(await processPendingHospitalReportJobs(f.store)).toEqual({ succeeded: 0, failed: 1 });
    await f.store.transaction((state) => ({ state: { ...state, accessGroups: state.accessGroups.map((entry) => entry.id === group.id ? group : entry) }, result: undefined }));
    const input = { expectedVersion: 2, idempotencyKey: "retry-intent" }; const retry = await f.service.retryHospitalReportJob(actor, queued.job.id, input);
    expect(retry.job).toMatchObject({ status: "PENDING", version: 3, errorCode: undefined });
    expect(await f.service.retryHospitalReportJob(actor, queued.job.id, input)).toEqual(retry);
    await processPendingHospitalReportJobs(f.store);
    expect((await f.service.retryHospitalReportJob(actor, queued.job.id, input)).job).toMatchObject({ status: "SUCCEEDED", attempts: 2 });
    expect(f.store.getState().auditEvents.filter((entry) => entry.eventType === "HospitalReportExportRetried")).toHaveLength(1);
  });

  it("rejects unbounded batches and oversized reports without generating a partial downloadable artifact", async () => {
    const f = hospitalOperationFixture(); const actor = f.user("user-us"); const task = await f.task("row-limit");
    const report = await f.service.createHospitalReport(actor, definition); const job = await f.service.createHospitalReportJob(actor, { reportId: report.id, expectedReportVersion: 1, idempotencyKey: "too-many-rows" });
    const before = structuredClone(f.store.getState());
    for (const [limit, asOf] of [[0, "2026-10-11T10:00:00Z"], [26, "2026-10-11T10:00:00Z"], [1.5, "2026-10-11T10:00:00Z"], [1, "invalid"]] as const) await expect(processPendingHospitalReportJobs(f.store, limit, asOf)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(f.store.getState()).toEqual(before);
    await f.store.transaction((state) => ({ state: { ...state, hospitalTasks: Array.from({ length: 50_001 }, (_, index) => ({ ...task.task, id: `bounded-task-${index}` })) }, result: undefined }));
    expect(await processPendingHospitalReportJobs(f.store)).toEqual({ succeeded: 0, failed: 1 });
    const failed = await f.service.getHospitalReportJob(actor, job.job.id); expect(failed).toMatchObject({ downloadAvailable: false, job: { errorCode: "REPORT_ROW_LIMIT", status: "FAILED", attempts: 1 } });
    expect(f.store.getState().hospitalReportJobs[0].rows).toBeUndefined();
    await expect(f.service.downloadHospitalReportJob(actor, job.job.id)).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
  });
});
