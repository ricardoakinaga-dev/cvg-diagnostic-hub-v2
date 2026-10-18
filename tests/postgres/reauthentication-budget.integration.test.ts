import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoState } from "../../src/server/store/fixtures";
import { authenticateRequest, loginUser, reauthenticateUser } from "../../src/server/security/session";
import * as defaultLimiter from "../../src/server/security/rate-limit";
import * as passwordSecurity from "../../src/server/security/password";
import { withDisposablePostgresDatabase } from "../support/postgres-test-harness";

const WINDOW = 15 * 60 * 1000;
const PASSWORD = "Synthetic-postgres-reauth-1234";
const WRONG = "Wrong-postgres-reauth-1234";
const peers: typeof defaultLimiter[] = [];

afterEach(async () => {
  await Promise.all([defaultLimiter.closeRateLimitBackend(), ...peers.splice(0).map((peer) => peer.closeRateLimitBackend())]);
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules();
});

function request(login: Awaited<ReturnType<typeof loginUser>>) {
  return new Request("http://synthetic.invalid/api/v1/session/reauth", { headers: {
    cookie: `cvg_session=${login.sessionToken}; cvg_csrf=${login.csrfToken}`, "x-csrf-token": login.csrfToken
  } });
}

async function poolPeer(connectionString: string, name: string) {
  vi.resetModules();
  const peer = await import("../../src/server/security/rate-limit"); peers.push(peer);
  const url = new URL(connectionString); url.searchParams.set("application_name", name);
  vi.stubEnv("DATABASE_URL", url.toString());
  await peer.reserveRateLimitSlot(`prime:${name}`, 5, WINDOW);
  return peer;
}

describe("native shared PostgreSQL reauthentication admission", () => {
  it("admits only five of six concurrent reservations across independent pools and does not release a later generation", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      vi.stubEnv("RATE_LIMIT_MODE", "postgres"); vi.stubEnv("RATE_LIMIT_DB_POOL_MAX", "1");
      const a = await poolPeer(database.connectionString(), "reauth-native-pool-a");
      const b = await poolPeer(database.connectionString(), "reauth-native-pool-b");
      try {
        const timestamp = Date.now(); const key = "reauth-native-shared";
        const outcomes = await Promise.allSettled(Array.from({ length: 6 }, (_, index) => (index % 2 ? a : b).reserveRateLimitSlot(key, 5, WINDOW, timestamp)));
        const admitted = outcomes.flatMap((outcome) => outcome.status === "fulfilled" ? [outcome.value] : []);
        expect(admitted.map((entry) => entry.count).sort()).toEqual([1, 2, 3, 4, 5]);
        expect(outcomes.filter((outcome) => outcome.status === "rejected").map((outcome) => outcome.reason)).toMatchObject([{ code: "RATE_LIMITED", status: 429 }]);
        expect((await database.query("SELECT request_count FROM rate_limit_buckets WHERE bucket_key=$1", [key])).rows).toEqual([{ request_count: 5 }]);
        expect((await database.query("SELECT DISTINCT application_name FROM pg_stat_activity WHERE datname=current_database() AND application_name IN ($1,$2)", ["reauth-native-pool-a", "reauth-native-pool-b"])).rowCount).toBe(2);
        expect((await database.query("SELECT request_count FROM rate_limit_buckets WHERE bucket_key=$1", [`${key}:confirmed:${timestamp}`])).rows).toEqual([{ request_count: 0 }]);
        const legacyKey = "reauth-native-previous-implementation";
        await database.query("INSERT INTO rate_limit_buckets(bucket_key,window_started_at,request_count) VALUES($1,$2,4)", [legacyKey, new Date(timestamp)]);
        const legacy = await a.reserveRateLimitSlot(legacyKey, 5, WINDOW, timestamp);
        expect(await b.confirmRateLimitSlotFailure(legacy, 5)).toBe(5);

        await a.releaseRateLimitSlot(admitted[0]);
        expect(await b.reserveRateLimitSlot(key, 5, WINDOW, timestamp)).toMatchObject({ count: 5 });
        const current = await b.reserveRateLimitSlot(key, 5, WINDOW, timestamp + WINDOW);
        await a.reserveRateLimitSlot(key, 5, WINDOW, timestamp + WINDOW);
        await a.releaseRateLimitSlot(admitted[0]);
        expect((await database.query("SELECT request_count FROM rate_limit_buckets WHERE bucket_key=$1", [key])).rows).toEqual([{ request_count: 2 }]);
        await b.releaseRateLimitSlot(current);
        expect((await database.query("SELECT request_count FROM rate_limit_buckets WHERE bucket_key=$1", [key])).rows).toEqual([{ request_count: 1 }]);

        await database.query(`CREATE FUNCTION reject_reauth_release() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF NEW.bucket_key='reauth-native-shared' AND NEW.request_count<OLD.request_count THEN RAISE EXCEPTION 'SYNTHETIC_RELEASE_FAILURE'; END IF; RETURN NEW; END; $$`);
        await database.query("CREATE TRIGGER reject_reauth_release BEFORE UPDATE ON rate_limit_buckets FOR EACH ROW EXECUTE FUNCTION reject_reauth_release()");
        await expect(a.releaseRateLimitSlot({ key, count: 1, windowStartedAt: timestamp + WINDOW })).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE", status: 503 });
        expect((await database.query("SELECT request_count FROM rate_limit_buckets WHERE bucket_key=$1", [key])).rows).toEqual([{ request_count: 1 }]);
      } finally { await Promise.all([a.closeRateLimitBackend(), b.closeRateLimitBackend()]); }
    });
  });

  it("bounds real scrypt confirmations across two stores and rolls back confirmation if reservation or release fails", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("RATE_LIMIT_MODE", "postgres"); vi.stubEnv("DATABASE_URL", database.connectionString());
      const firstStore = await database.createStore(createDemoState(PASSWORD)); const secondStore = await database.createStore();
      try {
        const first = await loginUser(firstStore, "admin@cvg.local", PASSWORD); const second = await loginUser(secondStore, "admin@cvg.local", PASSWORD);
        const verify = vi.spyOn(passwordSecurity, "verifyPassword");
        const key = `reauth-failure:${first.user.id}`;
        for (let index = 0; index < 4; index += 1) await expect(reauthenticateUser(firstStore, request(first), WRONG)).rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
        // Correct confirmations release only their slot, retaining all four wrong attempts.
        await expect(reauthenticateUser(secondStore, request(second), PASSWORD)).resolves.toMatchObject({ id: first.user.id });
        expect(await defaultLimiter.readRateLimitCounter(key, WINDOW)).toBe(4);
        const outcomes = await Promise.allSettled([reauthenticateUser(firstStore, request(first), WRONG), reauthenticateUser(secondStore, request(second), WRONG)]);
        expect(verify.mock.calls.filter(([value]) => value === WRONG)).toHaveLength(5);
        expect(outcomes.map((outcome) => outcome.status === "rejected" ? outcome.reason.code : "SUCCESS").sort()).toEqual(["RATE_LIMITED", "SESSION_EXPIRED"]);
        expect(await defaultLimiter.readRateLimitCounter(key, WINDOW)).toBe(5);
        expect((await secondStore.readState()).sessions.filter((session) => session.userId === first.user.id && session.revokedAt)).toHaveLength(1);

        const labFirst = await loginUser(firstStore, "lab@cvg.local", PASSWORD);
        const labSecond = await loginUser(secondStore, "lab@cvg.local", PASSWORD);
        const labKey = `reauth-failure:${labFirst.user.id}`;
        for (let index = 0; index < 3; index += 1) await expect(reauthenticateUser(firstStore, request(labFirst), WRONG)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
        let admitted!: () => void; let release!: () => void;
        const arrived = new Promise<void>((resolve) => { admitted = resolve; });
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const nativeTransaction = secondStore.transaction.bind(secondStore);
        vi.spyOn(secondStore, "transaction").mockImplementationOnce(async (operation) => { admitted(); await gate; return nativeTransaction(operation); });
        const correct = reauthenticateUser(secondStore, request(labSecond), PASSWORD);
        await arrived;
        let wrong: unknown;
        try { await reauthenticateUser(firstStore, request(labFirst), WRONG); } catch (error) { wrong = error; }
        finally { release(); }
        await expect(correct).resolves.toMatchObject({ id: labFirst.user.id });
        expect(wrong).toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
        expect(await defaultLimiter.readRateLimitCounter(labKey, WINDOW)).toBe(4);
        await expect(authenticateRequest(firstStore, request(labFirst), { requireCsrf: true })).resolves.toMatchObject({ id: labFirst.user.id });
        await expect(reauthenticateUser(firstStore, request(labFirst), WRONG)).rejects.toMatchObject({ code: "SESSION_EXPIRED" });

        const vet = await loginUser(firstStore, "vet@cvg.local", PASSWORD); const vetKey = `reauth-failure:${vet.user.id}`;
        await database.query(`CREATE FUNCTION reject_reauth_slot() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF NEW.bucket_key='${vetKey}' THEN RAISE EXCEPTION 'SYNTHETIC_ADMISSION_FAILURE'; END IF; RETURN NEW; END; $$`);
        await database.query("CREATE TRIGGER reject_reauth_slot BEFORE INSERT ON rate_limit_buckets FOR EACH ROW EXECUTE FUNCTION reject_reauth_slot()");
        verify.mockClear();
        await expect(reauthenticateUser(secondStore, request(vet), PASSWORD)).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE", status: 503 });
        expect(verify).not.toHaveBeenCalled();
        await database.query("DROP TRIGGER reject_reauth_slot ON rate_limit_buckets");
        await database.query(`CREATE FUNCTION reject_reauth_good_release() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF NEW.bucket_key='${vetKey}' AND NEW.request_count<OLD.request_count THEN RAISE EXCEPTION 'SYNTHETIC_RELEASE_FAILURE'; END IF; RETURN NEW; END; $$`);
        await database.query("CREATE TRIGGER reject_reauth_good_release BEFORE UPDATE ON rate_limit_buckets FOR EACH ROW EXECUTE FUNCTION reject_reauth_good_release()");
        const before = await firstStore.readStateSnapshot();
        await expect(reauthenticateUser(secondStore, request(vet), PASSWORD)).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE", status: 503 });
        expect(verify).toHaveBeenCalledExactlyOnceWith(PASSWORD, expect.any(String));
        expect(await firstStore.readStateSnapshot()).toEqual(before);
        expect((await database.query("SELECT request_count FROM rate_limit_buckets WHERE bucket_key=$1", [vetKey])).rows).toEqual([{ request_count: 1 }]);
        await expect(authenticateRequest(firstStore, request(vet), { requireCsrf: true })).resolves.toMatchObject({ id: vet.user.id, reauthenticatedAt: undefined });
      } finally { await defaultLimiter.closeRateLimitBackend(); await database.closeStore(secondStore); await database.closeStore(firstStore); }
    });
  });
});
