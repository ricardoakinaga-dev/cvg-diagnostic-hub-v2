import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET, POST, PATCH, PUT } from "../../app/api/v1/[...path]/route";
import { loginUser } from "../security/session";
import { resetRateLimits } from "../security/rate-limit";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";

const password = "hospital-task-route-synthetic-password";
const params = (path: string[]) => ({ params: Promise.resolve({ path }) });
async function fixture(email = "vet@cvg.local") {
  const store = new MemoryStore(createDemoState(password)); globalThis.__cvgDiagnosticsStore = store; globalThis.__cvgDiagnosticsStorePromise = undefined;
  const login = await loginUser(store, email, password);
  const headers = { cookie: `cvg_session=${login.sessionToken}; cvg_csrf=${login.csrfToken}`, origin: "http://localhost", "x-csrf-token": login.csrfToken, "content-type": "application/json" };
  const command = (method: "POST" | "PATCH" | "PUT", path: string[], body: unknown, key: string, version?: number) => ({ POST, PATCH, PUT })[method](new Request(`http://localhost/api/v1/${path.join("/")}`, { method, headers: { ...headers, "idempotency-key": key, ...(version ? { "if-match": `"${version}"` } : {}) }, body: JSON.stringify(body) }), params(path));
  const get = (path: string[], query = "") => GET(new Request(`http://localhost/api/v1/${path.join("/")}${query}`, { headers }), params(path));
  return { store, command, get };
}

describe.sequential("hospital task HTTP authority", () => {
  beforeEach(() => { process.env.APP_DATA_MODE = "memory"; resetRateLimits(); });
  afterEach(() => { delete globalThis.__cvgDiagnosticsStore; delete globalThis.__cvgDiagnosticsStorePromise; delete globalThis.__cvgDiagnosticsFileStore; delete process.env.APP_DATA_MODE; resetRateLimits(); });
  it("creates and executes a real task with If-Match, CSRF, idempotency and strict lifecycle fields", async () => {
    const c = await fixture();
    const created = await c.command("POST", ["hospital-tasks"], { title: "Rotina HTTP", typeId: "hospital-task-type-routine", departmentCode: "INPATIENT", priority: "ROUTINE", responsibleUserId: "user-vet" }, "create-http");
    const body = await created.json(); expect(created.status, JSON.stringify(body.error)).toBe(201); const task = body.data.task;
    const start = await c.command("POST", ["hospital-tasks", task.id, "commands"], { command: "START" }, "start-http", 1);
    expect(start.status, JSON.stringify((await start.clone().json()).error)).toBe(200); expect((await start.json()).data.task.phase).toBe("IN_PROGRESS");
    expect((await c.command("PATCH", ["hospital-tasks", task.id], { title: "Stale" }, "stale-http", 1)).status).toBe(409);
    expect((await c.command("POST", ["hospital-tasks", task.id, "commands"], { command: "COMPLETE", completedBy: "forged", expectedVersion: 2 }, "spoof-http")).status).toBe(400);
    const complete = await c.command("POST", ["hospital-tasks", task.id, "commands"], { command: "COMPLETE" }, "complete-http", 2); expect(complete.status).toBe(200);
    const list = await c.get(["hospital-tasks"], "?limit=1&orderBy=PRIORITY&direction=DESC"); expect(list.status).toBe(200); expect((await list.json()).data).toMatchObject({ total: 1, items: [{ task: { phase: "COMPLETED" } }] });
    expect((await c.get(["planner", "search"], "?query=Rotina&types=HOSPITAL_TASK")).status).toBe(200);
    expect(c.store.getState().items).toHaveLength(0);
  });
  it("keeps technical ADMIN out of clinical and general task operation while allowing type configuration", async () => {
    const c = await fixture("admin@cvg.local");
    expect((await c.get(["hospital-tasks"])).status).toBe(404); expect((await c.get(["hospital-task-types"])).status).toBe(200);
    expect((await c.command("POST", ["hospital-tasks"], { title: "Negada", typeId: "hospital-task-type-routine", departmentCode: "IT", priority: "ROUTINE" }, "admin-denied")).status).toBe(404);
    expect(c.store.getState().hospitalTasks).toHaveLength(0);
  });
});
