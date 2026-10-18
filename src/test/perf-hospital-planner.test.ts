import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { GET, PATCH, POST, PUT } from "../app/api/v1/[...path]/route";
import { loginUser } from "../server/security/session";
import { resetRateLimits } from "../server/security/rate-limit";
import { systemGroupId } from "../server/security/access-group-policy";
import { hospitalDocumentContentSchema } from "../server/http/hospital-document-schemas";
import { createDemoState } from "../server/store/fixtures";
import { MemoryStore } from "../server/store/memory-store";
import { plannerIntegrity } from "../../scripts/perf-hospital-planner";
import { PLANNER_TARGETS, PlannerRecorder, plannerContent, plannerKey, plannerLoadSettings, provePlannerGuards, provePlannerRevocation, runPlannerJourney, runPlannerLoad, type PlannerActor, type PlannerJourneyInput, type PlannerTransport } from "../../scripts/perf-hospital-planner-model";

const password = "hpl-perf-native-route-synthetic-password";
async function fixture() {
  const state = createDemoState(password);
  state.users = state.users.map((user) => user.id === "user-manager" ? { ...user, managedDepartmentCodes: ["ULTRASOUND"] } : user);
  const store = new MemoryStore(state); globalThis.__cvgDiagnosticsStore = store; globalThis.__cvgDiagnosticsStorePromise = undefined;
  const sessions = {} as Record<PlannerActor, Record<string, string>>;
  for (const [actor, userId] of [["manager", "user-manager"], ["operator", "user-us"], ["outsider", "user-lab"]] as const) {
    const user = state.users.find((user) => user.id === userId)!; const login = await loginUser(store, user.email, password);
    sessions[actor] = { cookie: `cvg_session=${login.sessionToken}; cvg_csrf=${login.csrfToken}`, "x-csrf-token": login.csrfToken, origin: "http://localhost", "content-type": "application/json" };
  }
  const transport: PlannerTransport = async (call) => {
    const started = performance.now(); const headers = { ...sessions[call.actor], "idempotency-key": plannerKey(call), ...(call.version ? { "if-match": `"${call.version}"` } : {}) };
    const request = new Request(`http://localhost/api/v1${call.route}`, { method: call.method, headers, ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }) });
    const response = await ({ GET, POST, PUT, PATCH })[call.method](request, { params: Promise.resolve({ path: call.route.split("?")[0].slice(1).split("/") }) });
    const envelope = await response.json();
    return { status: response.status, durationMs: performance.now() - started, ...(response.ok ? { data: envelope.data } : { errorCode: envelope.error?.code }) };
  };
  const input = (index = 0, journeys = 1, concurrency = 1): PlannerJourneyInput => ({ index, prefix: randomUUID().slice(0, 8).toUpperCase(), patientId: "patient-thor", encounterId: "encounter-thor", managerId: "user-manager", operatorId: "user-us", window: { startsAt: new Date(Date.now() - 60_000).toISOString(), endsAt: new Date(Date.now() + 3_600_000).toISOString() }, config: { journeys, concurrency, readRounds: 1, contentChars: 64 } });
  return { store, transport, input, recorder: new PlannerRecorder(transport) };
}
describe.sequential("synthetic HPL load profile against native authenticated HTTP", () => {
  beforeEach(() => { process.env.APP_DATA_MODE = "memory"; resetRateLimits(); });
  afterEach(() => { delete process.env.APP_DATA_MODE; delete globalThis.__cvgDiagnosticsStore; delete globalThis.__cvgDiagnosticsStorePromise; delete globalThis.__cvgDiagnosticsFileStore; resetRateLimits(); });
  it("bounds the declared workload without changing the existing latency/error targets", () => {
    expect(PLANNER_TARGETS).toEqual({ readP95Ms: 500, writeP95Ms: 800, maxErrorRate: 0.01 });
    expect(plannerLoadSettings({ PERF_HPL_JOURNEYS: "2", PERF_HPL_CONCURRENCY: "2", PERF_HPL_READ_ROUNDS: "1", PERF_HPL_CONTENT_CHARS: "64" })).toEqual({ journeys: 2, concurrency: 2, readRounds: 1, contentChars: 64 });
    for (const environment of [{ PERF_HPL_JOURNEYS: "0" }, { PERF_HPL_CONCURRENCY: "21" }, { PERF_HPL_READ_ROUNDS: " " }, { PERF_HPL_CONTENT_CHARS: "20001" }, { PERF_HPL_JOURNEYS: "1", PERF_HPL_CONCURRENCY: "2" }]) expect(() => plannerLoadSettings(environment)).toThrow(/PLANNER_LOAD_/);
    expect(hospitalDocumentContentSchema.safeParse(plannerContent(20_000, "FULL_BOUNDARY-edited")).success).toBe(true);
  });
  it("measures actual document→snapshot→task→plan→reservation→completion and native scoped reads", async () => {
    const c = await fixture(); const input = c.input(); const result = await runPlannerJourney(c.recorder, input);
    expect(result.completed).toBe(true); const state = c.store.getState();
    expect(state.hospitalTasks).toHaveLength(1); expect(state.hospitalTasks[0]).toMatchObject({ id: result.taskId, phase: "COMPLETED", version: 3, completedBy: "user-us", estimatedMinutes: 30 });
    expect(state.hospitalPlans[0]).toMatchObject({ id: result.planId, state: "CLOSED", version: 3, links: [{ targetId: result.taskId }] });
    expect(state.schedules[0]).toMatchObject({ hospitalTaskId: result.taskId, status: "COMPLETED", resourceIds: [result.resourceId] });
    expect(state.hospitalTasks[0].documentSnapshots?.[0].revisionId).toBe(result.revisionId);
    expect(c.recorder.samples.filter((sample) => sample.kind === "read").map((sample) => sample.operation)).toEqual(expect.arrayContaining(["task.list", "plan.detail", "document.detail", "resource.list", "calendar.read", "capacity.read", "metrics.read"]));
    expect(c.recorder.samples.every((sample) => sample.status >= 200 && sample.status < 300)).toBe(true);
    expect(c.recorder.guards).toEqual([expect.objectContaining({ name: "task.stale-edit", actualStatus: 409, passed: true })]);
    expect(state.requests).toEqual([]); expect(state.items).toEqual([]);
  });
  it("keeps two simultaneous journeys unique, rejects a contended reservation and rechecks current grants", async () => {
    const c = await fixture(); const first = c.input(0, 2, 2); const second = { ...first, index: 1 };
    const load = await runPlannerLoad(c.recorder, [first, second]); expect(load.failures).toEqual([]); expect(load.completed).toHaveLength(2);
    const guard = await provePlannerGuards(c.recorder, first, load.completed[0]);
    const integrity = plannerIntegrity(c.store.getState(), load.completed, guard, 2); expect(integrity.holds, JSON.stringify(integrity.checks)).toBe(true);
    expect(integrity.counts).toMatchObject({ tasks: 4, plans: 2, documents: 2, resources: 3, schedules: 3 });
    expect(c.recorder.samples.filter((sample) => sample.operation === "task.cursor-page")).toHaveLength(2);
    expect(c.recorder.summary(1000).peakInFlightHttpRequests).toBeGreaterThanOrEqual(10);
    expect(c.recorder.guards.filter((entry) => entry.name === "calendar.overlap").map((entry) => entry.actualStatus).sort()).toEqual([201, 409]);
    await c.store.transaction((state) => ({ state: { ...state, accessGroups: state.accessGroups.map((group) => group.id === systemGroupId("ULTRASOUND_TEAM") ? { ...group, permissions: group.permissions.filter((permission) => permission !== "hospital_task.view") } : group.id === systemGroupId("MANAGER") ? { ...group, permissions: group.permissions.filter((permission) => permission !== "hospital_document.view") } : group) }, result: undefined }));
    await provePlannerRevocation(c.recorder, first, load.completed[0]);
    expect(c.recorder.guards.filter((entry) => entry.name.startsWith("revocation.")).map((entry) => entry.actualStatus)).toEqual([404, 404, 404]);
    expect(c.store.getState().hospitalTasks).toHaveLength(4);
  });
  it("keeps unexpected HTTP failures in the measured error budget instead of classifying them as expected conflicts", async () => {
    const c = await fixture(); const recorder = new PlannerRecorder(async (call) => call.route === "/hospital-documents" && call.method === "POST" ? { status: 503, durationMs: 12, errorCode: "RUNTIME_UNAVAILABLE" } : c.transport(call));
    const load = await runPlannerLoad(recorder, [c.input()]); expect(load.completed).toEqual([]); expect(load.failures).toEqual([{ index: 0, code: "PLANNER_document.create_RUNTIME_UNAVAILABLE" }]);
    expect(recorder.summary(1000)).toMatchObject({ requests: 1, errorRate: 1, withinTargets: false }); expect(recorder.guards).toEqual([]);
    expect(c.store.getState().hospitalTasks).toEqual([]);
  });
  it("fails integrity if a creation loses its idempotency key and really creates a second task", async () => {
    const c = await fixture(); let taskCreates = 0;
    const recorder = new PlannerRecorder(async (call) => c.transport(call.method === "POST" && call.route === "/hospital-tasks" && ++taskCreates === 2 ? { ...call, key: randomUUID() } : call));
    await expect(runPlannerJourney(recorder, c.input())).rejects.toThrow("PLANNER_INTEGRITY_TASK_REPLAY_ID_VERSION");
    expect(c.store.getState().hospitalTasks).toHaveLength(2); expect(c.store.getState().hospitalPlans).toEqual([]);
  });
  it("records a transport exception as a failed sample and fails an incorrect expected-denial result", async () => {
    const recorder = new PlannerRecorder(async () => { throw new Error("synthetic connection reset"); });
    await expect(recorder.call("task.list", { actor: "operator", method: "GET", route: "/hospital-tasks" })).rejects.toThrow("PLANNER_task.list_TRANSPORT");
    expect(recorder.summary(100)).toMatchObject({ errorRate: 1, withinTargets: false });
    await expect(recorder.guard("scope.denial", { actor: "outsider", method: "GET", route: "/hospital-tasks" }, 404)).rejects.toThrow("EXPECTED_404_ACTUAL_0");
    expect(recorder.summary(100).correctnessPassed).toBe(false);
  });
  it("does not continue a journey when its normal operator has lost the create grant", async () => {
    const c = await fixture(); await c.store.transaction((state) => ({ state: { ...state, accessGroups: state.accessGroups.map((group) => group.id === systemGroupId("ULTRASOUND_TEAM") ? { ...group, permissions: group.permissions.filter((permission) => permission !== "hospital_task.create") } : group) }, result: undefined }));
    const load = await runPlannerLoad(c.recorder, [c.input()]); expect(load.completed).toEqual([]); expect(load.failures[0].code).toMatch(/^PLANNER_task.create_/);
    expect(c.store.getState().hospitalTasks).toEqual([]); expect(c.recorder.samples.find((sample) => sample.operation === "task.create")?.status).toBe(404);
  });
});
