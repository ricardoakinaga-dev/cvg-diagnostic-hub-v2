import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET, PATCH, POST, PUT } from "../../app/api/v1/[...path]/route";
import { hospitalOperationFixture } from "../../test/hospital-operation-fixtures";
import { processPendingHospitalReportJobs } from "../application/hospital-report-service";
import { loginUser } from "../security/session";
import { resetRateLimits } from "../security/rate-limit";

const window = { from: "2026-10-11T00:00:00.000Z", to: "2026-10-12T00:00:00.000Z", departmentCode: "ULTRASOUND" };
const document = JSON.parse(readFileSync("docs/api/openapi.json", "utf8"));
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ $id: "hospital-http-contract", components: document.components });
function matchesContract(schema: string, data: unknown) {
  const validate = ajv.getSchema(`hospital-http-contract#/components/schemas/${schema}`)!;
  expect(validate(data), JSON.stringify(validate.errors)).toBe(true);
}
async function setup(actorId = "user-us") {
  const f = hospitalOperationFixture();
  globalThis.__cvgDiagnosticsStore = f.store;
  globalThis.__cvgDiagnosticsStorePromise = undefined;
  const login = await loginUser(f.store, f.user(actorId).email, "hospital-operation-fixture-password");
  const sessionHeaders = { cookie: `cvg_session=${login.sessionToken}; cvg_csrf=${login.csrfToken}`, origin: "http://localhost", "x-csrf-token": login.csrfToken, "content-type": "application/json" };
  let sequence = 0;
  const send = async (method: "GET" | "PATCH" | "POST" | "PUT", path: string, body?: unknown, options: { headers?: Record<string, string>; public?: boolean } = {}) => {
    const headers = { ...(options.public ? { "content-type": "application/json" } : sessionHeaders), "idempotency-key": `analytics-http-${++sequence}`, ...options.headers };
    const request = new Request(`http://localhost/api/v1/${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const response = await ({ GET, PATCH, POST, PUT })[method](request, { params: Promise.resolve({ path: path.split("?")[0].split("/") }) });
    return { status: response.status, body: await response.json() };
  };
  return { ...f, send };
}
describe.sequential("hospital analytics and institution HTTP contracts", () => {
  beforeEach(() => { process.env.APP_DATA_MODE = "memory"; resetRateLimits(); });
  afterEach(() => { delete globalThis.__cvgDiagnosticsStore; delete globalThis.__cvgDiagnosticsStorePromise; delete globalThis.__cvgDiagnosticsFileStore; delete process.env.APP_DATA_MODE; resetRateLimits(); });

  it("creates, versions and generates a report for a normal account, then denies downloads after source revocation", async () => {
    const c = await setup(); const task = await c.task("report-source");
    await c.store.transaction((state) => ({ state: { ...state, hospitalTasks: state.hospitalTasks.map((entry) => ({ ...entry, createdAt: "2026-10-11T08:00:00.000Z" })) }, result: undefined }));
    const metrics = await c.send("GET", `hospital-metrics?${new URLSearchParams(window)}`);
    expect(metrics.status, JSON.stringify(metrics.body.error)).toBe(200); matchesContract("HospitalPlannerMetrics", metrics.body.data);
    expect(metrics.body.data.values.find((entry: { definition: { code: string } }) => entry.definition.code === "TASK_CREATED").value).toBe(1);
    const created = await c.send("POST", "hospital-reports", { name: "Relatório HTTP sintético", metricCode: "TASK_CREATED", filters: window, format: "JSONL" });
    expect(created.status, JSON.stringify(created.body.error)).toBe(201); matchesContract("HospitalReportDefinition", created.body.data); const reportId = created.body.data.id;
    const updated = await c.send("PATCH", `hospital-reports/${reportId}`, { name: "Relatório revisado" }, { headers: { "if-match": '"1"' } });
    expect(updated.status).toBe(200);
    expect((await c.send("PATCH", `hospital-reports/${reportId}`, { name: "Obsoleto" }, { headers: { "if-match": '"1"' } })).status).toBe(409);
    const queued = await c.send("POST", "hospital-report-jobs", { reportId, expectedReportVersion: 2 });
    expect(queued.status, JSON.stringify(queued.body.error)).toBe(201); matchesContract("HospitalReportJobView", queued.body.data); const jobId = queued.body.data.job.id;
    expect((await c.send("GET", `hospital-report-jobs/${jobId}/download`)).status).toBe(409);
    expect(await processPendingHospitalReportJobs(c.store)).toEqual({ succeeded: 1, failed: 0 });
    const downloaded = await c.send("GET", `hospital-report-jobs/${jobId}/download`);
    expect(downloaded.status).toBe(200); matchesContract("HospitalReportArtifact", downloaded.body.data);
    expect(JSON.parse(downloaded.body.data.content.trim())).toMatchObject({ id: task.task.id, deepLink: `/planner/tasks/${task.task.id}` });
    await c.store.transaction((state) => ({ state: { ...state, accessGroups: state.accessGroups.map((group) => group.id === c.user("user-us").accessGroupId ? { ...group, permissions: group.permissions.filter((permission) => permission !== "hospital_task.view") } : group) }, result: undefined }));
    expect((await c.send("GET", `hospital-report-jobs/${jobId}/download`)).status).toBe(404);
  });

  it("keeps initial version zero in the institution body, versions sector controls and protects administrative scope", async () => {
    const c = await setup("user-admin"); const settings = { name: "Hospital HTTP sintético", timezone: "America/Sao_Paulo", expectedVersion: 0 };
    expect((await c.send("PUT", "hospital-institution", settings, { headers: { "if-match": '"0"' } })).status).toBe(400);
    const initial = await c.send("PUT", "hospital-institution", settings);
    expect(initial.status, JSON.stringify(initial.body.error)).toBe(200); matchesContract("HospitalInstitutionSettings", initial.body.data);
    const updated = await c.send("PUT", "hospital-departments/ULTRASOUND/capabilities", { disabledNewWork: ["TASKS"], archived: false }, { headers: { "if-match": '"1"' } });
    expect(updated.status).toBe(200); expect(updated.body.data.version).toBe(2);
    expect((await c.send("PUT", "hospital-departments/ULTRASOUND/capabilities", { disabledNewWork: [], archived: true }, { headers: { "if-match": '"1"' } })).status).toBe(409);
    expect((await c.send("GET", "hospital-tasks")).status).toBe(404);
    const normal = await setup();
    expect((await normal.send("PUT", "hospital-institution", settings)).status).toBe(404);
  });

  it("issues a token once and consumes a public body-only invitation without fabricating clinical scope", async () => {
    const c = await setup("user-admin"); const groups = c.store.getState().accessGroups; const viewer = groups.find((group) => group.systemRole === "VIEWER")!;
    const before = c.store.getState().patientGrants;
    const created = await c.send("POST", "hospital-user-invitations", { email: "recipient-http@example.test", displayName: "Pessoa HTTP sintética", role: "VIEWER", departmentCode: "ULTRASOUND", accessGroupId: viewer.id, expectedGroupVersion: viewer.version, expiresInHours: 24 });
    expect(created.status, JSON.stringify(created.body.error)).toBe(201); matchesContract("HospitalInvitationIssued", created.body.data);
    const token = created.body.data.token;
    expect(JSON.stringify(c.store.getState())).not.toContain(token);
    const preview = await c.send("POST", "hospital-user-invitations/preview", { token }, { public: true });
    expect(preview.status).toBe(200); matchesContract("HospitalInvitationPreview", preview.body.data);
    const accepted = await c.send("POST", "hospital-user-invitations/accept", { token, password: "Cvg1-SonarBridge-4847!" }, { public: true });
    expect(accepted.status, JSON.stringify(accepted.body.error)).toBe(200); matchesContract("HospitalInvitationAccepted", accepted.body.data);
    expect((await c.send("POST", "hospital-user-invitations/accept", { token, password: "Cvg1-SonarBridge-4847!" }, { public: true })).status).toBe(404);
    expect(c.store.getState().users.filter((user) => user.email === "recipient-http@example.test")).toHaveLength(1);
    expect(c.store.getState().patientGrants).toEqual(before);
  });
});
