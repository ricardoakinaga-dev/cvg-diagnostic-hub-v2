import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hospitalOperationFixture } from "../../test/hospital-operation-fixtures";
import { processPendingHospitalReportJobs } from "./hospital-report-service";
import { runScheduledHospitalReports, createHospitalReportSchedule } from "./hospital-report-job";
const window = { from: "2026-10-11T00:00:00.000Z", to: "2026-10-12T00:00:00.000Z", departmentCode: "ULTRASOUND" };
async function setup() {
  const fixture = hospitalOperationFixture(); const task = await fixture.task("analytics-task");
  await fixture.store.transaction((state) => ({ state: { ...state, hospitalTasks: state.hospitalTasks.map((entry) => ({ ...entry, createdAt: "2026-10-11T08:00:00.000Z" })) }, result: undefined }));
  return { ...fixture, task: task.task, actor: fixture.user("user-us") };
}
async function archivedReport() {
  const f = await setup(); const item = await f.ultrasound("archived-export-request");
  await f.service.cancelItem(f.user("user-vet"), item.id, { reasonCode: "CLINICAL_DECISION", expectedVersion: 1, idempotencyKey: "settle-export-request" });
  const oldWindow = { ...window, from: "2020-10-11T00:00:00.000Z", to: "2020-10-12T00:00:00.000Z" };
  await f.store.transaction((state) => ({ state: { ...state, requests: state.requests.map((request) => request.id === item.requestId ? { ...request, updatedAt: "2020-10-11T09:00:00.000Z" } : request), items: state.items.map((entry) => entry.id === item.id ? { ...entry, requestedAt: "2020-10-11T08:00:00.000Z" } : entry) }, result: undefined }));
  const report = await f.service.createHospitalReport(f.actor, { name: "Arquivo sintético", metricCode: "DIAGNOSTIC_REQUESTED", filters: oldWindow, format: "JSONL", idempotencyKey: "archive-definition" });
  const job = await f.service.createHospitalReportJob(f.actor, { reportId: report.id, expectedReportVersion: 1, idempotencyKey: "archive-job" });
  expect(await processPendingHospitalReportJobs(f.store)).toEqual({ succeeded: 1, failed: 0 });
  expect((await f.store.archiveClinicalRecords({ now: new Date("2026-10-11T12:00:00.000Z"), activeMonths: 24 })).requestIds).toContain(item.requestId);
  expect(f.store.getState().items.some((entry) => entry.id === item.id)).toBe(false);
  return { ...f, item, report, job };
}
describe("operational metrics and report jobs", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-11T10:00:00.000Z"));
  });
  afterEach(() => vi.useRealTimers());
  it("counts the half-open event window once, excludes drafts and retains terminal archived history", async () => {
    const f = await setup();
    await f.store.transaction((state) => ({ state: { ...state, hospitalTasks: [...state.hospitalTasks, { ...f.task, id: "at-end", createdAt: window.to }, { ...f.task, id: "draft", isDraft: true }, { ...f.task, id: "archived", phase: "COMPLETED", completedAt: "2026-10-11T09:00:00.000Z", archivedAt: "2026-10-11T10:00:00.000Z" }] }, result: undefined }));
    const metrics = await f.service.getHospitalPlannerMetrics(f.actor, window);
    expect(metrics.values.find((entry) => entry.definition.code === "TASK_CREATED")).toMatchObject({ value: 2, availability: "AUTHORIZED" });
    expect(metrics.values.find((entry) => entry.definition.code === "TASK_COMPLETED")).toMatchObject({ value: 1 });
    expect(metrics.values.find((entry) => entry.definition.code === "TASK_PENDING")).toMatchObject({ value: 1 });
    expect(metrics.values.every((entry) => entry.definition.version === "HPL-OPERATIONAL-1")).toBe(true);
    await f.store.transaction((state) => ({ state: { ...state, departments: state.departments.map((entry) => entry.code === "ULTRASOUND" ? { ...entry, active: false } : entry) }, result: undefined }));
    const historical = await f.service.getHospitalPlannerMetrics(f.actor, window);
    expect(historical.scope.departmentCodes).toEqual(["ULTRASOUND"]);
    expect(historical.values.find((entry) => entry.definition.code === "TASK_CREATED")?.value).toBe(2);
  });
  it("uses null for missing source permission and denies an explicit outside sector", async () => {
    const f = await setup();
    await f.store.transaction((state) => ({ state: { ...state, accessGroups: state.accessGroups.map((group) => group.id === f.actor.accessGroupId ? { ...group, permissions: group.permissions.filter((permission) => permission !== "hospital_task.view") } : group) }, result: undefined }));
    expect((await f.service.getHospitalPlannerMetrics(f.actor, window)).values.find((entry) => entry.definition.code === "TASK_CREATED")).toMatchObject({ value: null, availability: "NOT_AUTHORIZED" });
    await expect(f.service.getHospitalPlannerMetrics(f.actor, { ...window, departmentCode: "LABORATORY" })).rejects.toMatchObject({ status: 404 });
    await expect(f.service.listHospitalMetricRows(f.actor, "TASK_CREATED", window)).rejects.toMatchObject({ status: 404 });
  });
  it("binds continuation cursors to the metric and exact window", async () => {
    const f = await setup();
    await f.store.transaction((state) => ({ state: { ...state, hospitalTasks: [...state.hospitalTasks, { ...f.task, id: "second" }] }, result: undefined }));
    const first = await f.service.listHospitalMetricRows(f.actor, "TASK_CREATED", { ...window, limit: 1 });
    expect(first.nextCursor).toBeTruthy();
    expect((await f.service.listHospitalMetricRows(f.actor, "TASK_CREATED", { ...window, limit: 1, cursor: first.nextCursor })).items[0].id).not.toBe(first.items[0].id);
    await expect(f.service.listHospitalMetricRows(f.actor, "TASK_PENDING", { ...window, cursor: first.nextCursor })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
  it("persists one job for concurrent workers, reconciles CSV rows, and revalidates download access", async () => {
    const f = await setup();
    const report = await f.service.createHospitalReport(f.actor, { name: "Operação sintética", metricCode: "TASK_CREATED", filters: window, format: "CSV", idempotencyKey: "report-create" });
    const queued = await f.service.createHospitalReportJob(f.actor, { reportId: report.id, expectedReportVersion: report.version, idempotencyKey: "export-job" });
    expect(queued).toMatchObject({ job: { status: "PENDING" }, downloadAvailable: false });
    const races = await Promise.all([processPendingHospitalReportJobs(f.store), processPendingHospitalReportJobs(f.store)]);
    expect(races.reduce((sum, result) => sum + result.succeeded, 0)).toBe(1);
    const output = await f.service.downloadHospitalReportJob(f.actor, queued.job.id);
    expect(output.rowCount).toBe((await f.service.listHospitalMetricRows(f.actor, "TASK_CREATED", window)).total);
    expect(output.content).toContain(f.task.id); expect(output.definition.version).toBe(report.version);
    await f.store.transaction((state) => ({ state: { ...state, accessGroups: state.accessGroups.map((group) => group.id === f.actor.accessGroupId ? { ...group, permissions: group.permissions.filter((permission) => permission !== "hospital_task.view") } : group) }, result: undefined }));
    await expect(f.service.downloadHospitalReportJob(f.actor, queued.job.id)).rejects.toMatchObject({ status: 404 });
  });
  it("retains generated pending facts after completion without adding new metric members", async () => {
    const f = await setup();
    const report = await f.service.createHospitalReport(f.actor, { name: "Pendências capturadas", metricCode: "TASK_PENDING", filters: window, format: "JSONL", idempotencyKey: "pending-definition" });
    const job = await f.service.createHospitalReportJob(f.actor, { reportId: report.id, expectedReportVersion: 1, idempotencyKey: "pending-job" });
    await processPendingHospitalReportJobs(f.store);
    const renamed = await f.service.updateHospitalTask(f.actor, f.task.id, { title: "Título atual autorizado", expectedVersion: 1, idempotencyKey: "rename-before-completion" });
    const started = await f.service.commandHospitalTask(f.actor, f.task.id, { command: "START", expectedVersion: renamed.task.version, idempotencyKey: "pending-start" });
    await f.service.commandHospitalTask(f.actor, f.task.id, { command: "COMPLETE", expectedVersion: started.task.version, idempotencyKey: "pending-complete" });
    const later = await f.service.createHospitalTask(f.actor, { title: "Nova pendência", typeId: "hospital-task-type-routine", departmentCode: "ULTRASOUND", responsibleUserId: f.actor.id, priority: "ROUTINE", idempotencyKey: "later-member" });
    expect((await f.service.listHospitalMetricRows(f.actor, "TASK_PENDING", window)).items.map((row) => row.id)).toEqual([later.task.id]);
    const artifact = await f.service.downloadHospitalReportJob(f.actor, job.job.id);
    expect(artifact.rowCount).toBe(1);
    expect(JSON.parse(artifact.content.trim())).toMatchObject({ id: f.task.id, occurredAt: "2026-10-11T08:00:00.000Z", status: "PENDING", label: expect.stringContaining("Título atual autorizado") });
    expect(artifact.content).not.toContain(later.task.id);
  });
  it("resolves an archived diagnostic from its native request, refreshes its label and keeps private provenance out of DTOs", async () => {
    const f = await archivedReport();
    await f.service.updateDiagnosticService(f.user("user-admin"), f.item.serviceId, { name: "Ultrassom atual autorizado", expectedVersion: 1, idempotencyKey: "archive-service-label" });
    expect(f.store.getState().hospitalReportJobs[0].rows?.[0]).toMatchObject({ sourceRequestId: f.item.requestId });
    const artifact = await f.service.downloadHospitalReportJob(f.actor, f.job.job.id);
    expect(artifact.rowCount).toBe(1);
    expect(JSON.parse(artifact.content.trim())).toMatchObject({ id: f.item.id, label: "Ultrassom atual autorizado", occurredAt: "2020-10-11T08:00:00.000Z", status: "CANCELLED", deepLink: `/archive/${f.item.requestId}` });
    expect(artifact.content).not.toContain("sourceRequestId");
    expect(JSON.stringify(await f.service.getHospitalReportJob(f.actor, f.job.job.id))).not.toContain("sourceRequestId");
  });
  it("observes source-permission revocation during cold I/O before serializing or recording a download", async () => {
    const f = await archivedReport(); const nativeRead = f.store.readArchivedRequest.bind(f.store);
    vi.spyOn(f.store, "readArchivedRequest").mockImplementationOnce(async (requestId) => {
      const rows = await nativeRead(requestId);
      await f.store.transaction((state) => ({ state: { ...state, accessGroups: state.accessGroups.map((group) => group.id === f.actor.accessGroupId ? { ...group, permissions: group.permissions.filter((permission) => permission !== "item.view") } : group) }, result: undefined }));
      return rows;
    });
    await expect(f.service.downloadHospitalReportJob(f.actor, f.job.job.id)).rejects.toMatchObject({ status: 404 });
    expect(f.store.getState().auditEvents.filter((event) => event.eventType === "HospitalReportExportDownloaded")).toEqual([]);
  });
  it("does not return a preloaded archive row after service scope revocation or native purge", async () => {
    for (const revoke of ["SERVICE", "PURGE"] as const) {
      const f = await archivedReport(); const nativeRead = f.store.readArchivedRequest.bind(f.store);
      vi.spyOn(f.store, "readArchivedRequest").mockImplementationOnce(async (requestId) => {
        const rows = await nativeRead(requestId);
        if (revoke === "SERVICE") await f.store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === f.actor.id ? { ...user, serviceCodes: [] } : user) }, result: undefined }));
        else expect((await f.store.purgeClinicalArchive({ now: new Date("2030-10-11T12:00:00.000Z"), purgeAfterMonths: 1 })).requestsPurged).toBe(1);
        return rows;
      });
      const artifact = await f.service.downloadHospitalReportJob(f.actor, f.job.job.id);
      expect(artifact).toMatchObject({ rowCount: 0, content: "" });
    }
  });
  it("pins the accepted handoff origin instead of substituting a later passage for the same task", async () => {
    const f = await setup(); const firstActor = f.actor;
    await f.store.transaction((state) => ({ state: { ...state, users: [...state.users, { ...firstActor, id: "us-second", email: "second-us@example.test" }], departments: state.departments.map((department) => department.code === "ULTRASOUND" ? { ...department, memberUserIds: [...department.memberUserIds, "us-second"] } : department) }, result: undefined }));
    const manager = f.user("user-manager");
    const shifts = await Promise.all([
      { name: "Origem", startAt: "2026-10-11T06:00:00.000Z", endAt: "2026-10-11T12:00:00.000Z", members: [{ userId: firstActor.id }] },
      { name: "Destino", startAt: "2026-10-11T12:00:00.000Z", endAt: "2026-10-11T18:00:00.000Z", members: [{ userId: "us-second" }] },
      { name: "Continuação", startAt: "2026-10-11T18:00:00.000Z", endAt: "2026-10-12T00:00:00.000Z", members: [{ userId: firstActor.id }] }
    ].map((input, index) => f.service.createHospitalShift(manager, { ...input, departmentCode: "ULTRASOUND", idempotencyKey: `origin-shift-${index}` })));
    const bind = await f.service.assignHospitalActivityShift(manager, { targetType: "HOSPITAL_TASK", targetId: f.task.id, shiftId: shifts[0].shift.id, expectedVersion: 1, idempotencyKey: "bind-origin" });
    const first = await f.service.offerHospitalHandoff(firstActor, { fromShiftId: shifts[0].shift.id, toShiftId: shifts[1].shift.id, recipientUserId: "us-second", entries: [{ targetType: "HOSPITAL_TASK", targetId: f.task.id, expectedTargetVersion: bind.version }], idempotencyKey: "first-origin" });
    await f.service.decideHospitalHandoff(f.user("us-second"), first.handoff.id, { decision: "ACCEPT", expectedVersion: 1, idempotencyKey: "accept-first-origin" });
    const report = await f.service.createHospitalReport(firstActor, { name: "Passagem capturada", metricCode: "ACTIVITY_HANDED_OVER", filters: window, format: "JSONL", idempotencyKey: "origin-definition" });
    const job = await f.service.createHospitalReportJob(firstActor, { reportId: report.id, expectedReportVersion: 1, idempotencyKey: "origin-job" }); await processPendingHospitalReportJobs(f.store);
    expect(f.store.getState().hospitalReportJobs[0].rows?.[0]).toMatchObject({ sourceHandoffId: first.handoff.id });
    const currentTask = f.store.getState().hospitalTasks.find((task) => task.id === f.task.id)!;
    const second = await f.service.offerHospitalHandoff(f.user("us-second"), { fromShiftId: shifts[1].shift.id, toShiftId: shifts[2].shift.id, recipientUserId: firstActor.id, entries: [{ targetType: "HOSPITAL_TASK", targetId: f.task.id, expectedTargetVersion: currentTask.version }], idempotencyKey: "second-origin" });
    await f.service.decideHospitalHandoff(firstActor, second.handoff.id, { decision: "ACCEPT", expectedVersion: 1, idempotencyKey: "accept-second-origin" });
    expect((await f.service.downloadHospitalReportJob(firstActor, job.job.id)).rowCount).toBe(1);
    // An unavailable original source cannot be replaced by another authorized
    // passage, even though the task and its latest passage remain visible.
    await f.store.transaction((state) => ({ state: { ...state, hospitalHandoffs: state.hospitalHandoffs.filter((handoff) => handoff.id !== first.handoff.id) }, result: undefined }));
    expect((await f.service.listHospitalMetricRows(firstActor, "ACTIVITY_HANDED_OVER", window)).total).toBe(1);
    expect((await f.service.downloadHospitalReportJob(firstActor, job.job.id)).rowCount).toBe(0);
    expect(JSON.stringify(await f.service.getHospitalReportJob(firstActor, job.job.id))).not.toContain("sourceHandoffId");
  });
  it("records failed jobs, requires explicit retry and runs them through the scheduled worker job", async () => {
    const f = await setup(); const report = await f.service.createHospitalReport(f.actor, { name: "Retry sintético", metricCode: "TASK_CREATED", filters: window, format: "JSONL", idempotencyKey: "retry-report" });
    const queued = await f.service.createHospitalReportJob(f.actor, { reportId: report.id, expectedReportVersion: 1, idempotencyKey: "retry-job" });
    await f.store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === f.actor.id ? { ...user, active: false } : user) }, result: undefined }));
    expect(await processPendingHospitalReportJobs(f.store)).toEqual({ succeeded: 0, failed: 1 });
    await f.store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === f.actor.id ? { ...user, active: true } : user) }, result: undefined }));
    const failed = await f.service.getHospitalReportJob(f.actor, queued.job.id); expect(failed.job).toMatchObject({ status: "FAILED", attempts: 1, version: 2 });
    await expect(f.service.retryHospitalReportJob(f.actor, queued.job.id, { expectedVersion: 1, idempotencyKey: "stale-retry" })).rejects.toMatchObject({ code: "STALE_VERSION" });
    await f.service.retryHospitalReportJob(f.actor, queued.job.id, { expectedVersion: 2, idempotencyKey: "retry" });
    expect(await runScheduledHospitalReports(f.store, createHospitalReportSchedule())).toEqual({ succeeded: 1, failed: 0 });
    expect(JSON.parse((await f.service.downloadHospitalReportJob(f.actor, queued.job.id)).content.trim())).toMatchObject({ id: f.task.id });
  });
  it("prevents private definition mutation by others and neutralizes spreadsheet formulas", async () => {
    const f = await setup();
    const item = await f.ultrasound("formula-diagnostic");
    await f.store.transaction((state) => ({ state: { ...state, services: state.services.map((service) => service.id === item.serviceId ? { ...service, name: "\t=IMPORTXML(unsafe)" } : service), items: state.items.map((entry) => entry.id === item.id ? { ...entry, requestedAt: "2026-10-11T08:00:00.000Z" } : entry) }, result: undefined }));
    const report = await f.service.createHospitalReport(f.actor, { name: "Privado", sharedDepartmentCode: "ULTRASOUND", metricCode: "DIAGNOSTIC_REQUESTED", filters: window, format: "CSV", idempotencyKey: "private" });
    await expect(f.service.updateHospitalReport(f.user("user-manager"), report.id, { name: "Troca", expectedVersion: 1, idempotencyKey: "not-owner" })).rejects.toMatchObject({ status: 404 });
    const job = await f.service.createHospitalReportJob(f.actor, { reportId: report.id, expectedReportVersion: 1, idempotencyKey: "csv" }); await processPendingHospitalReportJobs(f.store);
    const artifact = await f.service.downloadHospitalReportJob(f.actor, job.job.id); expect(artifact.content.startsWith("targetType,id,label")).toBe(true);
    expect(artifact.rowCount).toBe(1);
    expect(artifact.content).toContain('"\'\t=IMPORTXML(unsafe)"');
    expect(artifact.content).not.toContain(',"\t=IMPORTXML(unsafe)",');
  });
});
