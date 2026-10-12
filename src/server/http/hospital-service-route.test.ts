import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET, POST, PATCH } from "../../app/api/v1/[...path]/route";
import { loginUser } from "../security/session";
import { resetRateLimits } from "../security/rate-limit";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";

const password = "hospital-service-route-synthetic-password";
const params = (path: string[]) => ({ params: Promise.resolve({ path }) });
async function fixture(email = "admin@cvg.local") {
  const store = new MemoryStore(createDemoState(password));
  globalThis.__cvgDiagnosticsStore = store; globalThis.__cvgDiagnosticsStorePromise = undefined;
  const login = await loginUser(store, email, password);
  const headers = { cookie: `cvg_session=${login.sessionToken}; cvg_csrf=${login.csrfToken}`, origin: "http://localhost", "x-csrf-token": login.csrfToken, "content-type": "application/json" };
  return { store,
    post: (path: string[], body: unknown, key: string) => POST(new Request(`http://localhost/api/v1/${path.join("/")}`, { method: "POST", headers: { ...headers, "idempotency-key": key }, body: JSON.stringify(body) }), params(path)),
    patch: (serviceId: string, body: unknown, version: string, key: string) => PATCH(new Request(`http://localhost/api/v1/hospital-services/${serviceId}`, { method: "PATCH", headers: { ...headers, "if-match": version, "idempotency-key": key }, body: JSON.stringify(body) }), params(["hospital-services", serviceId])),
    get: (query = "") => GET(new Request(`http://localhost/api/v1/hospital-services${query}`, { headers }), params(["hospital-services"]))
  };
}
describe.sequential("hospital catalog HTTP", () => {
  beforeEach(() => { process.env.APP_DATA_MODE = "memory"; resetRateLimits(); });
  afterEach(() => { delete globalThis.__cvgDiagnosticsStore; delete globalThis.__cvgDiagnosticsStorePromise; delete globalThis.__cvgDiagnosticsFileStore; delete process.env.APP_DATA_MODE; resetRateLimits(); });
  it("accepts If-Match without a body revision and rejects stale or contradictory revisions", async () => {
    const c = await fixture();
    const created = await c.post(["hospital-services"], { code: "OPERATIONS_FIXTURE", name: "Rotina sintética", kind: "OPERATIONAL", departmentCode: "INPATIENT" }, "route-create");
    const createdBody = await created.json(); expect(created.status, JSON.stringify(createdBody.error)).toBe(201); const service = createdBody.data;
    const changed = await c.patch(service.id, { name: "Nome futuro" }, '"1"', "route-patch");
    expect(changed.status).toBe(200); expect((await changed.json()).data).toMatchObject({ name: "Nome futuro", version: 2 });
    const stale = await c.patch(service.id, { name: "Alteração obsoleta" }, '"1"', "route-stale");
    expect(stale.status).toBe(409);
    const conflict = await c.patch(service.id, { name: "Conflicting", expectedVersion: 2 }, '"1"', "route-conflicting");
    expect(conflict.status).toBe(400);
    const page = await c.get("?limit=1"); expect(page.status).toBe(200);
    expect((await page.json()).data).toMatchObject({ items: expect.any(Array), total: 5, nextCursor: expect.any(String) });
  });
  it("denies mutation by a catalog viewer and leaves the catalog unchanged", async () => {
    const c = await fixture("vet@cvg.local"); const before = c.store.getState().hospitalServices;
    const response = await c.post(["hospital-services"], { code: "DENIED", name: "Denied", kind: "CARE", departmentCode: "INPATIENT" }, "viewer-create");
    expect(response.status, JSON.stringify((await response.clone().json()).error)).toBe(404); expect(c.store.getState().hospitalServices).toEqual(before);
    expect((await c.get()).status).toBe(200);
  });
});
