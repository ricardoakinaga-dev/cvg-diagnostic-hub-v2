import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hospitalPlannerHttpFixture as fixture } from "@/test/hospital-planner-http-fixture";
import { processPendingHospitalReportJobs } from "../application/hospital-report-service";
import { resetRateLimits } from "../security/rate-limit";

const version = (value: number) => ({ "if-match": `"${value}"` });
const window = { from: "2026-10-11T00:00:00.000Z", to: "2026-10-12T00:00:00.000Z", departmentCode: "INPATIENT" };

describe.sequential("institutional governance and export recovery through current HTTP authorization", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime("2026-10-11T12:00:00Z"); process.env.APP_DATA_MODE = "memory"; resetRateLimits(); });
  afterEach(() => { vi.useRealTimers(); delete process.env.APP_DATA_MODE; delete globalThis.__cvgDiagnosticsStore; delete globalThis.__cvgDiagnosticsStorePromise; delete globalThis.__cvgDiagnosticsFileStore; resetRateLimits(); });

  it("paginates actual counted objects and rejects a cursor used for another indicator or revoked object scope", async () => {
    const c = await fixture();
    const input = { title: "Objeto contado", typeId: "hospital-task-type-routine", departmentCode: "INPATIENT", responsibleUserId: "user-vet", priority: "ROUTINE" };
    const tasks = await Promise.all(["Primeiro", "Segundo"].map(title => c.send("user-vet", "POST", "hospital-tasks", { ...input, title })));
    expect(tasks.map(task => task.status)).toEqual([201, 201]);
    const query = new URLSearchParams({ ...window, limit: "1" });
    const first = await c.send("user-vet", "GET", `hospital-metrics/TASK_CREATED/rows?${query}`); expect(first.status).toBe(200); expect(first.envelope.data).toMatchObject({ total: 2, limit: 1 });
    const next = new URLSearchParams({ ...window, limit: "1", cursor: first.envelope.data.nextCursor });
    const second = await c.send("user-vet", "GET", `hospital-metrics/TASK_CREATED/rows?${next}`); expect(second.status).toBe(200);
    expect(new Set([...first.envelope.data.items, ...second.envelope.data.items].map(row => row.id))).toEqual(new Set(tasks.map(task => task.envelope.data.task.id)));
    expect(second.envelope.data.nextCursor).toBeUndefined();
    expect((await c.send("user-vet", "GET", `hospital-metrics/TASK_PENDING/rows?${next}`)).status).toBe(400);
    expect((await c.send("user-vet", "GET", `hospital-metrics/UNKNOWN/rows?${query}`)).status).toBe(400);
    await c.store.transaction(state => ({ state: { ...state, accessGroups: state.accessGroups.map(group => group.id === c.actor("user-vet").accessGroupId ? { ...group, permissions: group.permissions.filter(permission => permission !== "hospital_task.view") } : group) }, result: undefined }));
    expect((await c.send("user-vet", "GET", `hospital-metrics/TASK_CREATED/rows?${next}`)).status).toBe(404);
    const narrowed = await c.send("user-vet", "GET", `hospital-metrics?${new URLSearchParams(window)}`); expect(narrowed.status).toBe(200);
    expect(narrowed.envelope.data.values.find((value: { definition: { code: string } }) => value.definition.code === "TASK_CREATED")).toMatchObject({ value: null, availability: "NOT_AUTHORIZED" });
  });

  it("recovers a worker export failure only after current source permission is restored and never exposes another owner's job", async () => {
    const c = await fixture();
    const task = await c.send("user-vet", "POST", "hospital-tasks", { title: "=Sintético para planilha", typeId: "hospital-task-type-routine", departmentCode: "INPATIENT", priority: "ROUTINE" }); expect(task.status).toBe(201);
    const report = await c.send("user-vet", "POST", "hospital-reports", { name: "Exportação governada", metricCode: "TASK_CREATED", filters: window, format: "CSV" }); expect(report.status).toBe(201); const reportId = report.envelope.data.id;
    expect((await c.send("user-vet", "GET", "hospital-reports")).envelope.data.map((entry: { id: string }) => entry.id)).toEqual([reportId]);
    const queued = await c.send("user-vet", "POST", "hospital-report-jobs", { reportId, expectedReportVersion: 1 }, { "idempotency-key": "governance-export" }); expect(queued.status).toBe(201); const jobId = queued.envelope.data.job.id;
    expect((await c.send("user-vet", "POST", `hospital-report-jobs/${jobId}/retry`, {}, version(1))).status).toBe(409);
    const originalGroups = structuredClone(c.store.getState().accessGroups);
    await c.store.transaction(state => ({ state: { ...state, accessGroups: state.accessGroups.map(group => group.id === c.actor("user-vet").accessGroupId ? { ...group, permissions: group.permissions.filter(permission => permission !== "hospital_task.view") } : group) }, result: undefined }));
    expect(await processPendingHospitalReportJobs(c.store)).toEqual({ succeeded: 0, failed: 1 });
    expect((await c.send("user-vet", "GET", "hospital-report-jobs")).envelope.data).toEqual([]);
    expect((await c.send("user-vet", "GET", `hospital-report-jobs/${jobId}`)).status).toBe(404);
    await c.store.transaction(state => ({ state: { ...state, accessGroups: originalGroups }, result: undefined }));
    const failed = await c.send("user-vet", "GET", `hospital-report-jobs/${jobId}`); expect(failed.envelope.data.job).toMatchObject({ status: "FAILED", version: 2, attempts: 1 }); expect(failed.envelope.data.job.rows).toBeUndefined();
    const headers = { ...version(2), "idempotency-key": "governance-retry" };
    expect((await c.send("user-vet", "POST", `hospital-report-jobs/${jobId}/retry`, {}, version(1))).status).toBe(409);
    const retried = await c.send("user-vet", "POST", `hospital-report-jobs/${jobId}/retry`, {}, headers); expect(retried.status).toBe(200);
    expect((await c.send("user-vet", "POST", `hospital-report-jobs/${jobId}/retry`, {}, headers)).envelope.data).toEqual(retried.envelope.data);
    expect(await processPendingHospitalReportJobs(c.store)).toEqual({ succeeded: 1, failed: 0 });
    const completed = await c.send("user-vet", "GET", `hospital-report-jobs/${jobId}`); expect(completed.envelope.data.job).toMatchObject({ status: "SUCCEEDED", version: 4, attempts: 2 }); expect(completed.envelope.data.downloadAvailable).toBe(true);
    expect((await c.send("vet-b", "GET", "hospital-report-jobs")).envelope.data).toEqual([]); expect((await c.send("vet-b", "GET", `hospital-report-jobs/${jobId}`)).status).toBe(404);
    const download = await c.send("user-vet", "GET", `hospital-report-jobs/${jobId}/download`); expect(download.status).toBe(200); expect(download.envelope.data).toMatchObject({ format: "CSV", rowCount: 1, definition: { version: 1 } });
    expect(download.envelope.data.content).toContain(task.envelope.data.task.id);
    expect(c.store.getState().hospitalReportJobs).toHaveLength(1); expect(c.store.getState().hospitalTasks[0].phase).toBe("PENDING");
  });

  it("returns scoped invitation options and revokes the one-time token without creating a user or patient grant", async () => {
    const c = await fixture(); const initial = await c.send("user-admin", "GET", "hospital-institution"); expect(initial.envelope.data).toMatchObject({ settings: null });
    const settings = { name: "Instituição exclusivamente sintética", timezone: "America/Sao_Paulo", expectedVersion: 0 };
    const configured = await c.send("user-admin", "PUT", "hospital-institution", settings, { "idempotency-key": "institution-http-config" }); expect(configured.status).toBe(200);
    expect((await c.send("user-admin", "PUT", "hospital-institution", settings, { "idempotency-key": "institution-http-config" })).envelope.data).toEqual(configured.envelope.data);
    expect((await c.send("user-vet", "GET", "hospital-institution")).envelope.data.permissions).toEqual([]);
    const options = await c.send("user-admin", "GET", "hospital-user-invitations/options"); expect(options.status).toBe(200); expect(options.envelope.data.departments.some((entry: { code: string }) => entry.code === "INPATIENT")).toBe(true);
    expect(JSON.stringify(options.envelope)).not.toMatch(/passwordHash|tokenHash|patientIds/);
    expect((await c.send("user-vet", "GET", "hospital-user-invitations/options")).status).toBe(404);
    const group = c.store.getState().accessGroups.find(entry => entry.systemRole === "VIEWER")!;
    const before = structuredClone({ users: c.store.getState().users, grants: c.store.getState().patientGrants });
    const body = { email: "invited-governance@example.test", displayName: "Convite sintético", role: "VIEWER", departmentCode: "INPATIENT", accessGroupId: group.id, expectedGroupVersion: group.version, expiresInHours: 24 };
    const issued = await c.send("user-admin", "POST", "hospital-user-invitations", body, { "idempotency-key": "invite-once" }); expect(issued.status).toBe(201); const token = issued.envelope.data.token; const invitationId = issued.envelope.data.invitation.id;
    const replay = await c.send("user-admin", "POST", "hospital-user-invitations", body, { "idempotency-key": "invite-once" }); expect(replay.envelope.data.token).toBeUndefined(); expect(replay.envelope.data.tokenReturnedOnce).toBe(false);
    expect((await c.send("user-admin", "GET", "hospital-user-invitations")).envelope.data.map((entry: { invitation: { id: string } }) => entry.invitation.id)).toEqual([invitationId]);
    expect((await c.send("user-admin", "POST", "hospital-user-invitations/preview", { token })).status).toBe(200);
    const revoked = await c.send("user-admin", "POST", `hospital-user-invitations/${invitationId}/revoke`, { reason: "Mudança de decisão sintética" }, { ...version(1), "idempotency-key": "invite-revoke-once" }); expect(revoked.status).toBe(200);
    expect((await c.send("user-admin", "POST", `hospital-user-invitations/${invitationId}/revoke`, { reason: "Mudança de decisão sintética" }, { ...version(1), "idempotency-key": "invite-revoke-once" })).envelope.data).toEqual(revoked.envelope.data);
    expect((await c.send("user-admin", "POST", "hospital-user-invitations/preview", { token })).status).toBe(404);
    expect((await c.send("user-admin", "POST", "hospital-user-invitations/accept", { token, password: "Cvg1-SonarBridge-4847!" })).status).toBe(404);
    expect(JSON.stringify(c.store.getState())).not.toContain(token);
    expect({ users: c.store.getState().users, grants: c.store.getState().patientGrants }).toEqual(before);
  });
});
