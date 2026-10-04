import { beforeEach, describe, expect, it } from "vitest";
import { GET, POST } from "../../app/api/v1/[...path]/route";
import { getRuntimeStoreAsync, resetRuntimeStore } from "../store/runtime";
import { resetRateLimits } from "../security/rate-limit";

const context = (path: string[]) => ({ params: Promise.resolve({ path }) });
const AUTH_PASSWORD = "ux-route-test-password-1234";
function sessionFrom(response: Response) {
  const header = response.headers.get("set-cookie") ?? "";
  const token = header.match(/cvg_session=([^;]+)/)?.[1];
  const csrf = header.match(/cvg_csrf=([^;]+)/)?.[1];
  if (!token || !csrf) throw new Error("Session cookies absent");
  return { cookie: `cvg_session=${token}; cvg_csrf=${csrf}`, "x-csrf-token": csrf };
}
async function login(email: string, password = AUTH_PASSWORD) {
  const response = await POST(new Request("http://localhost/api/v1/session/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) }), context(["session", "login"]));
  expect(response.status).toBe(200);
  return { response, headers: sessionFrom(response) };
}
function post(path: string[], body: object, headers: Record<string, string>, key = "ux-command") {
  return POST(new Request(`http://localhost/api/v1/${path.join("/")}`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key, ...headers }, body: JSON.stringify(body) }), context(path));
}

describe("simplified UI retains server security boundaries", () => {
  beforeEach(() => {
    process.env.APP_DATA_MODE = "memory";
    process.env.DEMO_PASSWORD = AUTH_PASSWORD;
    process.env.LOGIN_RATE_LIMIT = "100";
    resetRuntimeStore(); resetRateLimits();
  });
  it("rejects missing CSRF, grants ordinary access without step-up and reveals generated credentials only once", async () => {
    const admin = await login("admin@cvg.local");
    const input = { displayName: "Nova colaboradora", email: "new@cvg.local", role: "LAB_TECH" };
    expect((await post(["users"], input, { cookie: admin.headers.cookie })).status).toBe(403);
    const created = await post(["users"], input, admin.headers, "create-new");
    expect(created.status).toBe(201);
    const user = (await created.json()).data;
    expect(user.initialPassword).toEqual(expect.any(String));
    expect(user.departmentCode).toBe("IT");
    const replay = await post(["users"], input, admin.headers, "create-new");
    expect((await replay.json()).data).not.toHaveProperty("initialPassword");
    const list = await GET(new Request("http://localhost/api/v1/users", { headers: admin.headers }), context(["users"]));
    expect(JSON.stringify(await list.json())).not.toContain(user.initialPassword);
    expect(JSON.stringify(await (await getRuntimeStoreAsync()).readState())).not.toContain(user.initialPassword);
    const initial = await login(input.email, user.initialPassword);
    expect((await GET(new Request("http://localhost/api/v1/dashboard", { headers: initial.headers }), context(["dashboard"]))).status).toBe(403);
    expect((await GET(new Request("http://localhost/api/v1/session/me", { headers: initial.headers }), context(["session", "me"]))).status).toBe(200);
    expect((await post(["session", "password"], { password: "Personal-password-5678" }, { cookie: initial.headers.cookie })).status).toBe(403);
    const changed = await post(["session", "password"], { password: "Personal-password-5678" }, initial.headers);
    expect(changed.status).toBe(200);
    const next = sessionFrom(changed);
    expect(next.cookie).not.toBe(initial.headers.cookie);
    expect((await GET(new Request("http://localhost/api/v1/session/me", { headers: initial.headers }), context(["session", "me"]))).status).toBe(401);
    expect((await GET(new Request("http://localhost/api/v1/session/me", { headers: next }), context(["session", "me"]))).status).toBe(200);
  });
  it("requires reauthentication for ADMIN grants and rejects unprivileged management directly", async () => {
    const admin = await login("admin@cvg.local");
    expect((await post(["users"], { displayName: "Admin novo", email: "admin-new@cvg.local", role: "ADMIN" }, admin.headers)).status).toBe(403);
    expect((await post(["users", "user-vet", "roles"], { role: "ADMIN", departmentCode: "IT", expectedVersion: 1 }, admin.headers)).status).toBe(403);
    const vet = await login("vet@cvg.local");
    expect((await post(["users"], { displayName: "Tentativa indevida", email: "forbidden@cvg.local", role: "VIEWER" }, vet.headers)).status).toBe(404);
    const reasons = await GET(new Request("http://localhost/api/v1/clinical-reasons", { headers: (await login("lab@cvg.local")).headers }), context(["clinical-reasons"]));
    expect(reasons.status).toBe(200);
    const list = (await reasons.json()).data;
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((reason: { active: boolean }) => reason.active)).toBe(true);
  });

  it("recovers an access atomically, revokes old sessions and never replays or persists the generated secret", async () => {
    const admin = await login("admin@cvg.local");
    const vet = await login("vet@cvg.local");
    const path = ["users", "user-vet", "password"];
    expect((await post(path, { expectedVersion: 1 }, { cookie: admin.headers.cookie })).status).toBe(403);
    expect((await post(path, {}, admin.headers)).status).toBe(400);
    expect((await post(path, { expectedVersion: 1, password: "chosen-password-1234" }, admin.headers)).status).toBe(400);
    const reset = await post(path, { expectedVersion: 1 }, admin.headers, "recover-vet");
    expect(reset.status).toBe(200);
    expect(reset.headers.get("cache-control")).toBe("no-store");
    const recovered = (await reset.json()).data as { initialPassword: string; version: number };
    expect(recovered.initialPassword).toMatch(/^Cvg1-/);
    expect(recovered.version).toBe(2);
    expect((await GET(new Request("http://localhost/api/v1/session/me", { headers: vet.headers }), context(["session", "me"]))).status).toBe(401);
    const replay = await post(path, { expectedVersion: 1 }, admin.headers, "recover-vet");
    expect(replay.status).toBe(200);
    expect((await replay.json()).data).not.toHaveProperty("initialPassword");
    expect((await post(path, { expectedVersion: 1 }, admin.headers, "stale-recovery")).status).toBe(409);
    const store = await getRuntimeStoreAsync();
    const state = await store.readState();
    expect(JSON.stringify(state)).not.toContain(recovered.initialPassword);
    expect(state.auditEvents.filter((event) => event.eventType === "UserPasswordRegenerated")).toHaveLength(1);
    expect(state.auditEvents.at(-1)).toMatchObject({ actorId: "user-admin", entityId: "user-vet" });
    const oldCredential = await post(["session", "login"], { email: "vet@cvg.local", password: AUTH_PASSWORD }, {}, "old-login");
    expect(oldCredential.status).toBe(401);
    const temporary = await login("vet@cvg.local", recovered.initialPassword);
    expect((await GET(new Request("http://localhost/api/v1/dashboard", { headers: temporary.headers }), context(["dashboard"]))).status).toBe(403);
    expect((await post(["session", "password"], { password: "Recovered-personal-password-5678" }, temporary.headers)).status).toBe(200);
  });

  it("denies unauthorized recovery, self recovery, inactive accounts and ADMIN recovery without persisted step-up", async () => {
    const admin = await login("admin@cvg.local");
    const manager = await login("manager@cvg.local");
    const vet = await login("vet@cvg.local");
    const store = await getRuntimeStoreAsync();
    await store.transaction((state) => ({ state: { ...state, users: [...state.users, { ...state.users.find((user) => user.id === "user-admin")!, id: "other-admin", email: "other-admin@cvg.local" }, { ...state.users.find((user) => user.id === "user-vet")!, id: "outside-user", email: "outside@cvg.local", departmentCode: "OTHER" }] }, result: undefined }));
    const before = await store.readState();
    expect((await post(["users", "user-lab", "password"], { expectedVersion: 1 }, vet.headers)).status).toBe(404);
    expect((await post(["users", "outside-user", "password"], { expectedVersion: 1 }, manager.headers)).status).toBe(404);
    expect((await post(["users", "other-admin", "password"], { expectedVersion: 1 }, manager.headers)).status).toBe(404);
    expect((await post(["users", "user-admin", "password"], { expectedVersion: 1 }, admin.headers)).status).toBe(400);
    expect((await post(["users", "other-admin", "password"], { expectedVersion: 1 }, admin.headers)).status).toBe(403);
    expect(await store.readState()).toEqual(before);
    await store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === "user-lab" ? { ...user, active: false } : user) }, result: undefined }));
    expect((await post(["users", "user-lab", "password"], { expectedVersion: 1 }, manager.headers)).status).toBe(409);
    expect((await post(["session", "reauth"], { password: AUTH_PASSWORD }, admin.headers)).status).toBe(200);
    expect((await post(["users", "other-admin", "password"], { expectedVersion: 1 }, admin.headers, "recover-admin")).status).toBe(200);
  });
});
