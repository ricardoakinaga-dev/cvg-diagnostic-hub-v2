import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "../../app/api/v1/[...path]/route";
import { createApplicationService } from "../application/service";
import { loginUser } from "../security/session";
import { resetRateLimits } from "../security/rate-limit";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";

const policy = { version: "synthetic-policy-1", approvedAt: "2026-01-01T00:00:00Z", approvalReference: "SYNTHETIC-ROUTE-APPROVAL", departmentCodes: ["INPATIENT", "LABORATORY"], reasons: [{ code: "COVERED", label: "Demanda já coberta" }], defaultReasonCode: "COVERED" };
async function fixture(options: { viewer?: boolean; triageOnly?: boolean } = {}) {
  const password = "synthetic-intake-route-password"; const state = createDemoState(password);
  const actor = state.users.find((user) => user.id === "user-vet")!;
  if (options.viewer) state.users.push({ ...actor, id: "synthetic-viewer", role: "VIEWER", email: "viewer@example.invalid", accessGroupId: "access-group-viewer" });
  const store = new MemoryStore(state); globalThis.__cvgDiagnosticsStore = store; globalThis.__cvgDiagnosticsStorePromise = undefined;
  const service = createApplicationService(store);
  const intake = await service.createHospitalIntake(actor, { title: "Materiais de rotina", departmentCode: "INPATIENT", priority: "ROUTINE", source: "MANUAL", idempotencyKey: "setup-intake" });
  if (options.triageOnly) await store.transaction((current) => ({ state: { ...current, accessGroups: current.accessGroups.map((group) => group.id === actor.accessGroupId ? { ...group, permissions: ["hospital_intake.triage"] } : group) }, result: undefined }));
  const login = await loginUser(store, options.viewer ? "viewer@example.invalid" : actor.email, password);
  const headers = { cookie: `cvg_session=${login.sessionToken}; cvg_csrf=${login.csrfToken}`, origin: "http://localhost", "x-csrf-token": login.csrfToken, "content-type": "application/json" };
  async function send(method: "GET" | "POST", path: string, body?: object, overrides: Record<string, string | null> = {}) {
    const requestHeaders = new Headers({ ...headers, "idempotency-key": "triage-intent" });
    for (const [key, value] of Object.entries(overrides)) value === null ? requestHeaders.delete(key) : requestHeaders.set(key, value);
    const response = await ({ GET, POST })[method](new Request(`http://localhost/api/v1/${path}`, { method, headers: requestHeaders, ...(body ? { body: JSON.stringify(body) } : {}) }), { params: Promise.resolve({ path: path.split("?")[0].split("/") }) });
    return { status: response.status, body: await response.json() };
  }
  return { store, actor, intake, send };
}

describe.sequential("approved intake rejection HTTP contract", () => {
  beforeEach(() => { vi.stubEnv("APP_DATA_MODE", "memory"); vi.stubEnv("HOSPITAL_INTAKE_REJECTION_POLICY_JSON", JSON.stringify(policy)); resetRateLimits(); });
  afterEach(() => { delete globalThis.__cvgDiagnosticsStore; delete globalThis.__cvgDiagnosticsStorePromise; delete globalThis.__cvgDiagnosticsFileStore; vi.unstubAllEnvs(); resetRateLimits(); });

  it("reads authorized native options and rejects with header-only version, saving approved evidence exactly once", async () => {
    const c = await fixture(); const read = await c.send("GET", "hospital-intakes/options?departmentCode=INPATIENT");
    expect(read.status).toBe(200); expect(read.body.data).toMatchObject({ rejectionPolicyStatus: "AVAILABLE", rejectionPolicy: { version: policy.version, departmentCodes: ["INPATIENT"] } });
    expect(JSON.stringify(read.body.data)).not.toMatch(/passwordHash|patientIds|sessionToken/);
    const body = { decision: "REJECT", reasonCode: "COVERED", reasonPolicyVersion: policy.version };
    const first = await c.send("POST", `hospital-intakes/${c.intake.id}/triage`, body, { "if-match": '"1"' });
    expect(first.status, JSON.stringify(first.body.error)).toBe(200);
    expect(first.body.data).toMatchObject({ state: "REJECTED", reason: policy.reasons[0].label, reasonPolicy: { code: "COVERED", policyVersion: policy.version }, version: 2 });
    const replay = await c.send("POST", `hospital-intakes/${c.intake.id}/triage`, body, { "if-match": '"1"' });
    expect(replay.status).toBe(200); expect(replay.body.data).toEqual(first.body.data);
    expect(c.store.getState().auditEvents.filter((event) => event.eventType === "HospitalIntakeTriaged")).toHaveLength(1);
    expect(c.store.getState().hospitalTasks).toHaveLength(0); expect(c.store.getState().items).toHaveLength(0);
  });

  it("rejects malformed pairs, unapproved versions, missing CSRF/idempotency and scoped options without mutating demand", async () => {
    const c = await fixture(); const path = `hospital-intakes/${c.intake.id}/triage`; const before = structuredClone(c.store.getState().hospitalIntakes);
    const valid = { decision: "REJECT", reasonCode: "COVERED", reasonPolicyVersion: policy.version, expectedVersion: 1 };
    expect((await c.send("POST", path, valid, { "x-csrf-token": null })).status).toBe(403);
    expect((await c.send("POST", path, valid, { "idempotency-key": null })).status).toBe(400);
    expect((await c.send("POST", path, { decision: "REJECT", reasonCode: "COVERED", expectedVersion: 1 })).status).toBe(400);
    expect((await c.send("POST", path, { ...valid, reasonPolicyVersion: "obsolete" })).status).toBe(409);
    expect((await c.send("GET", "hospital-intakes/options?departmentCode=LABORATORY")).status).toBe(404);
    expect((await c.send("GET", "hospital-intakes/options?unexpected=1")).status).toBe(400);
    expect(c.store.getState().hospitalIntakes).toEqual(before);
  });

  it("requires current triage permission for metadata, without broadening read permission or trusting historical capabilities", async () => {
    const c = await fixture({ triageOnly: true });
    expect((await c.send("GET", "hospital-intakes/options")).status).toBe(200);
    expect((await c.send("GET", "hospital-intakes")).status).toBe(404);
    await c.store.transaction((state) => ({ state: { ...state, accessGroups: state.accessGroups.map((group) => group.id === c.actor.accessGroupId ? { ...group, permissions: [] } : group) }, result: undefined }));
    expect((await c.send("GET", "hospital-intakes/options")).status).toBe(404);
    const viewer = await fixture({ viewer: true });
    expect((await viewer.send("GET", "hospital-intakes/options")).status).toBe(404);
    expect((await viewer.send("POST", `hospital-intakes/${viewer.intake.id}/triage`, { decision: "REJECT", reasonCode: "COVERED", reasonPolicyVersion: policy.version, expectedVersion: 1 })).status).toBe(404);
  });
});
