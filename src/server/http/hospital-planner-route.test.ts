import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET, PATCH, POST, PUT } from "../../app/api/v1/[...path]/route";
import { createApplicationService } from "../application/service";
import { loginUser } from "../security/session";
import { resetRateLimits } from "../security/rate-limit";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import type { Permission } from "@cvg/contracts";

const password = "planner-http-synthetic-password";
const routine = { title: "Conferência operacional sintética", typeId: "hospital-task-type-routine", departmentCode: "INPATIENT", priority: "ROUTINE" };

async function fixture(options: { viewer?: boolean; permissions?: Permission[] } = {}) {
  const state = createDemoState(password);
  const vet = state.users.find((user) => user.id === "user-vet")!;
  if (options.viewer) state.users.push({ ...vet, id: "route-viewer", email: "route-viewer@example.test", role: "VIEWER", accessGroupId: "access-group-viewer" });
  if (options.permissions) state.accessGroups.find((group) => group.id === vet.accessGroupId)!.permissions = options.permissions;
  const store = new MemoryStore(state);
  globalThis.__cvgDiagnosticsStore = store;
  globalThis.__cvgDiagnosticsStorePromise = undefined;
  const login = await loginUser(store, options.viewer ? "route-viewer@example.test" : vet.email, password);
  const sessionHeaders = { cookie: `cvg_session=${login.sessionToken}; cvg_csrf=${login.csrfToken}`, origin: "http://localhost", "x-csrf-token": login.csrfToken, "content-type": "application/json" };
  let sequence = 0;
  return {
    store,
    service: createApplicationService(store),
    async send(method: "GET" | "PATCH" | "POST" | "PUT", path: string, body?: unknown, overrides: Record<string, string | null> = {}) {
      const headers = new Headers({ ...sessionHeaders, "idempotency-key": `planner-route-${++sequence}` });
      for (const [key, value] of Object.entries(overrides)) value === null ? headers.delete(key) : headers.set(key, value);
      const request = new Request(`http://localhost/api/v1/${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const context = { params: Promise.resolve({ path: path.split("?")[0].split("/") }) };
      const response = await ({ GET, PATCH, POST, PUT })[method](request, context);
      return { status: response.status, envelope: await response.json() };
    }
  };
}

describe.sequential("hospital planner authenticated HTTP journey", () => {
  beforeEach(() => { process.env.APP_DATA_MODE = "memory"; resetRateLimits(); });
  afterEach(() => {
    delete globalThis.__cvgDiagnosticsStore;
    delete globalThis.__cvgDiagnosticsStorePromise;
    delete globalThis.__cvgDiagnosticsFileStore;
    delete process.env.APP_DATA_MODE;
    resetRateLimits();
  });

  it("creates with a normal account, accepts header-only concurrency and paginates its contextual history", async () => {
    const c = await fixture();
    const created = await c.send("POST", "hospital-tasks", routine);
    expect(created.status, JSON.stringify(created.envelope.error)).toBe(201);
    const taskId = created.envelope.data.task.id;
    const updated = await c.send("PATCH", `hospital-tasks/${taskId}`, { title: "Conferência revisada" }, { "if-match": '"1"' });
    expect(updated.status).toBe(200);
    expect(updated.envelope.data.task).toMatchObject({ title: "Conferência revisada", version: 2 });
    const before = c.store.getState().hospitalTasks;
    expect((await c.send("PATCH", `hospital-tasks/${taskId}`, { title: "Obsoleta" }, { "if-match": '"1"' })).status).toBe(409);
    expect((await c.send("PATCH", `hospital-tasks/${taskId}`, { title: "Conflitante", expectedVersion: 2 }, { "if-match": '"1"' })).status).toBe(400);
    expect(c.store.getState().hospitalTasks).toEqual(before);
    const first = await c.send("GET", `hospital-tasks/${taskId}/history?limit=1`);
    expect(first.status).toBe(200);
    expect(first.envelope.data).toHaveLength(1);
    expect(first.envelope.meta).toMatchObject({ total: 2, limit: 1, nextCursor: expect.any(String) });
    const second = await c.send("GET", `hospital-tasks/${taskId}/history?limit=1&cursor=${encodeURIComponent(first.envelope.meta.nextCursor)}`);
    expect(second.envelope.data).toHaveLength(1);
    expect(second.envelope.data[0].id).not.toBe(first.envelope.data[0].id);
    const search = await c.send("GET", "planner/search?types=HOSPITAL_TASK,PATIENT&query=Conferência");
    expect(search.status).toBe(200);
    expect(search.envelope.data.items.map((item: { id: string }) => item.id)).toEqual([taskId]);
  });

  it("rejects missing CSRF, idempotency and revision without changing activities", async () => {
    const c = await fixture();
    expect((await c.send("POST", "hospital-tasks", routine, { "x-csrf-token": null })).status).toBe(403);
    expect((await c.send("POST", "hospital-tasks", routine, { "idempotency-key": null })).status).toBe(400);
    expect(c.store.getState().hospitalTasks).toEqual([]);
    const created = await c.send("POST", "hospital-tasks", routine);
    const taskId = created.envelope.data.task.id;
    const before = c.store.getState().hospitalTasks;
    expect((await c.send("PATCH", `hospital-tasks/${taskId}`, { title: "Sem revisão" })).status).toBe(400);
    expect((await c.send("PATCH", `hospital-tasks/${taskId}`, { title: "Revisão inválida" }, { "if-match": "invalid" })).status).toBe(400);
    expect(c.store.getState().hospitalTasks).toEqual(before);
  });

  it("allows create-only metadata and creation without directory or ongoing reading grants", async () => {
    const c = await fixture({ permissions: ["hospital_task.create"] });
    const options = await c.send("GET", "hospital-tasks/options");
    expect(options.status).toBe(200);
    expect(options.envelope.data.departments.map((department: { code: string }) => department.code)).toEqual(["INPATIENT"]);
    expect(JSON.stringify(options.envelope)).not.toMatch(/passwordHash|patientIds|whatsappPhone/);
    const created = await c.send("POST", "hospital-tasks", routine);
    expect(created.status).toBe(201);
    expect(created.envelope.data.permissions).toEqual([]);
    expect((await c.send("GET", `hospital-tasks/${created.envelope.data.task.id}`)).status).toBe(404);
    expect((await c.send("GET", "hospital-tasks")).status).toBe(404);
    expect((await c.send("GET", "departments")).status).toBe(404);
  });

  it("permits viewer detail/history and denies direct mutations with no clinical side effects", async () => {
    const c = await fixture({ viewer: true });
    const vet = c.store.getState().users.find((user) => user.id === "user-vet")!;
    const created = await c.service.createHospitalTask(vet, { ...routine, priority: "ROUTINE", idempotencyKey: "viewer-seed" });
    expect((await c.send("GET", `hospital-tasks/${created.task.id}`)).status).toBe(200);
    expect((await c.send("GET", `hospital-tasks/${created.task.id}/history`)).status).toBe(200);
    const before = c.store.getState().hospitalTasks;
    expect((await c.send("POST", `hospital-tasks/${created.task.id}/commands`, { command: "START" }, { "if-match": '"1"' })).status).toBe(404);
    expect((await c.send("PUT", `hospital-tasks/${created.task.id}/priority`, { priority: "URGENT", reason: "Teste negado" }, { "if-match": '"1"' })).status).toBe(404);
    expect(c.store.getState().hospitalTasks).toEqual(before);
    expect(c.store.getState().items).toEqual([]);
    expect(c.store.getState().results).toEqual([]);
  });

  it("uses the current patient scope for detail, history, list and search after withdrawal", async () => {
    const c = await fixture();
    const created = await c.send("POST", "hospital-tasks", { ...routine, title: "Cuidado reservado Thor", typeId: "hospital-task-type-care", patientId: "patient-thor", encounterId: "encounter-thor" });
    expect(created.status).toBe(201);
    const taskId = created.envelope.data.task.id;
    await c.store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === "user-vet" ? { ...user, patientIds: ["patient-mel"] } : user) }, result: undefined }));
    expect((await c.send("GET", `hospital-tasks/${taskId}`)).status).toBe(404);
    expect((await c.send("GET", `hospital-tasks/${taskId}/history`)).status).toBe(404);
    expect((await c.send("GET", "hospital-tasks")).envelope.data.total).toBe(0);
    const search = await c.send("GET", "planner/search?types=HOSPITAL_TASK&query=reservado");
    expect(search.envelope.data.total).toBe(0);
    expect(JSON.stringify(search.envelope)).not.toContain("Thor");
  });
});
