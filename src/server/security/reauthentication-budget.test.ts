import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { authenticateRequest, loginUser, reauthenticateUser } from "./session";
import { readRateLimitCounter, resetRateLimits } from "./rate-limit";
import * as rateLimits from "./rate-limit";
import * as passwordSecurity from "./password";

const backend = vi.hoisted(() => ({ query: vi.fn(), on: vi.fn(), end: vi.fn() }));
vi.mock("pg", () => ({ Pool: class { query = backend.query; on = backend.on; end = backend.end; } }));

const PASSWORD = "Synthetic-reauth-budget-1234";
const WRONG = "Wrong-synthetic-budget-1234";
const WINDOW = 15 * 60 * 1000;

function request(login: Awaited<ReturnType<typeof loginUser>>) {
  return new Request("http://synthetic.invalid/api/v1/session/reauth", { headers: {
    cookie: `cvg_session=${login.sessionToken}; cvg_csrf=${login.csrfToken}`,
    "x-csrf-token": login.csrfToken
  } });
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("RATE_LIMIT_MODE", "memory"); resetRateLimits();
  backend.query.mockReset(); backend.end.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => { await rateLimits.closeRateLimitBackend(); resetRateLimits(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function fixture() {
  const store = new MemoryStore(createDemoState(PASSWORD));
  const first = await loginUser(store, "admin@cvg.local", PASSWORD);
  const second = await loginUser(store, "admin@cvg.local", PASSWORD);
  const firstId = (await authenticateRequest(store, request(first), { requireCsrf: true })).sessionId;
  return { store, first, second, firstId, key: `reauth-failure:${first.user.id}` };
}

describe("native reauthentication wrong-password budget", () => {
  it("admits only one real password verification for two concurrent callers after four wrong passwords", async () => {
    const { store, first, second, firstId, key } = await fixture();
    const verify = vi.spyOn(passwordSecurity, "verifyPassword");
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(reauthenticateUser(store, request(first), WRONG)).rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
    }
    expect(await readRateLimitCounter(key, WINDOW)).toBe(4);
    // Allow the two real legacy reads of4 to finish before either caller resumes.
    // The corrected admission never reads first, so this seam becomes unused.
    const nativeRead = rateLimits.readRateLimitCounter;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let arrivals = 0;
    vi.spyOn(rateLimits, "readRateLimitCounter").mockImplementation(async (...args) => {
      const count = await nativeRead(...args);
      if (args[0] === key && count === 4) {
        arrivals += 1;
        if (arrivals === 2) release();
        await gate;
      }
      return count;
    });
    const outcomes = await Promise.allSettled([
      reauthenticateUser(store, request(first), WRONG),
      reauthenticateUser(store, request(second), WRONG)
    ]);
    release();
    expect(verify.mock.calls.filter(([password]) => password === WRONG)).toHaveLength(5);
    expect(await readRateLimitCounter(key, WINDOW)).toBe(5);
    expect(outcomes.map((result) => result.status === "rejected" ? result.reason.code : "SUCCESS").sort()).toEqual(["RATE_LIMITED", "SESSION_EXPIRED"]);
    expect(store.getState().sessions.filter((session) => session.revokedAt)).toHaveLength(1);
    const live = store.getState().sessions.find((session) => !session.revokedAt)!;
    await expect(authenticateRequest(store, request(live.id === firstId ? first : second), { requireCsrf: true })).resolves.toMatchObject({ id: first.user.id });
  });

  it("preserves five sequential wrong attempts and does not verify a blocked sixth", async () => {
    const { store, first, second, key } = await fixture();
    const verify = vi.spyOn(passwordSecurity, "verifyPassword");
    for (let attempt = 0; attempt < 4; attempt += 1) await expect(reauthenticateUser(store, request(first), WRONG)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(reauthenticateUser(store, request(first), WRONG)).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    await expect(reauthenticateUser(store, request(second), WRONG)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(verify.mock.calls.filter(([password]) => password === WRONG)).toHaveLength(5);
    expect(await readRateLimitCounter(key, WINDOW)).toBe(5);
  });

  it("preserves four confirmed failures already persisted by the previous implementation", async () => {
    const { store, first, key } = await fixture();
    for (let attempt = 0; attempt < 4; attempt += 1) await rateLimits.consumeRateLimitCounter(key, WINDOW);
    await expect(reauthenticateUser(store, request(first), WRONG)).rejects.toMatchObject({ code: "SESSION_EXPIRED", status: 401 });
    expect(await readRateLimitCounter(key, WINDOW)).toBe(5);
    expect(store.getState().sessions.filter((session) => session.revokedAt)).toHaveLength(1);
  });

  it("successful confirmations return their slot without erasing the four preceding wrong passwords", async () => {
    const { store, first, second, key } = await fixture();
    for (let attempt = 0; attempt < 4; attempt += 1) await expect(reauthenticateUser(store, request(first), WRONG)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await expect(reauthenticateUser(store, request(second), PASSWORD)).resolves.toMatchObject({ id: first.user.id, reauthenticatedAt: expect.any(String) });
      expect(await readRateLimitCounter(key, WINDOW)).toBe(4);
    }
    await expect(reauthenticateUser(store, request(first), WRONG)).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    await expect(reauthenticateUser(store, request(second), PASSWORD)).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("revokes only on the fifth confirmed wrong password when a correct confirmation occupies another slot", async () => {
    const { store, first, second, key } = await fixture();
    const verify = vi.spyOn(passwordSecurity, "verifyPassword");
    for (let attempt = 0; attempt < 3; attempt += 1) await expect(reauthenticateUser(store, request(first), WRONG)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    let admitted!: () => void; let release!: () => void;
    const arrived = new Promise<void>((resolve) => { admitted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const nativeTransaction = store.transaction.bind(store);
    vi.spyOn(store, "transaction").mockImplementationOnce(async (operation) => {
      admitted(); await gate; return nativeTransaction(operation);
    });
    const correct = reauthenticateUser(store, request(first), PASSWORD);
    await arrived;
    let wrong: unknown;
    try { await reauthenticateUser(store, request(second), WRONG); } catch (error) { wrong = error; }
    finally { release(); }
    await expect(correct).resolves.toMatchObject({ id: first.user.id });
    expect(wrong).toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
    expect(await readRateLimitCounter(key, WINDOW)).toBe(4);
    await expect(authenticateRequest(store, request(second), { requireCsrf: true })).resolves.toMatchObject({ id: first.user.id });
    await expect(reauthenticateUser(store, request(second), WRONG)).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    expect(verify.mock.calls.filter(([value]) => value === WRONG)).toHaveLength(5);
  });

  it("an old successful confirmation cannot remove a real wrong-password failure in the next window", async () => {
    const { store, first, second, key } = await fixture();
    const initial = Date.now();
    vi.setSystemTime(initial);
    const nativeTransaction = store.transaction.bind(store);
    vi.spyOn(store, "transaction").mockImplementationOnce(async (operation) => {
      vi.setSystemTime(initial + WINDOW + 1);
      await expect(reauthenticateUser(store, request(second), WRONG)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
      expect(await readRateLimitCounter(key, WINDOW)).toBe(1);
      return nativeTransaction(operation);
    });
    await expect(reauthenticateUser(store, request(first), PASSWORD)).resolves.toMatchObject({ id: first.user.id });
    expect(await readRateLimitCounter(key, WINDOW)).toBe(1);
  });

  it("does not verify a password if the reservation backend fails", async () => {
    const { store, first } = await fixture();
    const verify = vi.spyOn(passwordSecurity, "verifyPassword");
    vi.stubEnv("RATE_LIMIT_MODE", "postgres"); vi.stubEnv("DATABASE_URL", "postgresql://reservation.test/synthetic");
    backend.query.mockRejectedValueOnce(new Error("synthetic connection failure"));
    await expect(reauthenticateUser(store, request(first), PASSWORD)).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE", status: 503 });
    expect(verify).not.toHaveBeenCalled();
    expect(store.getState().sessions.every((session) => !session.reauthenticatedAt)).toBe(true);
  });

  it("does not commit reauthentication when returning a successful slot fails in PostgreSQL", async () => {
    const { store, first } = await fixture();
    const verify = vi.spyOn(passwordSecurity, "verifyPassword");
    const before = await store.readStateSnapshot();
    vi.stubEnv("RATE_LIMIT_MODE", "postgres"); vi.stubEnv("DATABASE_URL", "postgresql://reservation.test/synthetic");
    backend.query.mockResolvedValueOnce({ rows: [{ request_count: 1, window_started_ms: Date.now() }] }).mockRejectedValueOnce(new Error("synthetic release failure"));
    await expect(reauthenticateUser(store, request(first), PASSWORD)).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE", status: 503 });
    expect(verify).toHaveBeenCalledExactlyOnceWith(PASSWORD, expect.any(String));
    expect(await store.readStateSnapshot()).toEqual(before);
  });

  it("keeps a wrong reservation occupied and fails closed if recording the confirmed failure fails", async () => {
    const { store, first } = await fixture();
    const verify = vi.spyOn(passwordSecurity, "verifyPassword");
    const before = await store.readStateSnapshot();
    vi.stubEnv("RATE_LIMIT_MODE", "postgres"); vi.stubEnv("DATABASE_URL", "postgresql://reservation.test/synthetic");
    backend.query.mockResolvedValueOnce({ rows: [{ request_count: 5, window_started_ms: Date.now() }] }).mockRejectedValueOnce(new Error("synthetic failure confirmation outage"));
    await expect(reauthenticateUser(store, request(first), WRONG)).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE", status: 503 });
    expect(verify).toHaveBeenCalledExactlyOnceWith(WRONG, expect.any(String));
    expect(backend.query).toHaveBeenCalledTimes(2);
    expect(await store.readStateSnapshot()).toEqual(before);
  });
});
