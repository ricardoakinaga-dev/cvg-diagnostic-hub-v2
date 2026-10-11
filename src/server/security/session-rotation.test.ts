import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../store/memory-store";
import { createDemoState } from "../store/fixtures";
import { createRealtimeResponse } from "../observability/realtime-stream";
import { resetSharedRealtimeStateReaders } from "../observability/realtime-state-reader";
import { resetMetrics } from "../observability/metrics";
import { ApiError } from "../http/envelope";
import { authenticateRequest, authorizationSnapshotIsCurrent, hashSessionToken, loginUser, reauthenticateUser, sessionTerminallyExpired } from "./session";
import { completePasswordReset, createPasswordResetGrant } from "./password-reset";

const FIRST_SECRET = "rotation-first-secret-01234567890123456789";
const SECOND_SECRET = "rotation-second-secret-01234567890123456789";
const PASSWORD = "Rotation-Lua-48-xkz";
const cookieRequest = (token: string) => new Request("http://localhost", { headers: { cookie: `cvg_session=${token}` } });

describe("SESSION_SECRET generation", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetSharedRealtimeStateReaders();
    resetMetrics();
  });

  it("survives a restart with the same secret and rejects the persisted cookie and actor after rotation", async () => {
    vi.stubEnv("SESSION_SECRET", FIRST_SECRET);
    const store = new MemoryStore(createDemoState(PASSWORD));
    const signedIn = await loginUser(store, "vet@cvg.local", PASSWORD);
    const actor = await authenticateRequest(store, cookieRequest(signedIn.sessionToken));
    const persisted = store.getState();
    expect(JSON.stringify(persisted)).not.toContain(FIRST_SECRET);
    expect(JSON.stringify(persisted)).not.toContain(signedIn.sessionToken);

    // Two independent Node processes read the same persisted state. This proves
    // rotation is not an in-memory flag or a module cache invalidation.
    const program = `
      const { readFileSync } = require('node:fs');
      const { MemoryStore } = require('./src/server/store/memory-store.ts');
      const { authenticateRequest, authorizationSnapshotIsCurrent } = require('./src/server/security/session.ts');
      const input = JSON.parse(readFileSync(0, 'utf8'));
      const store = new MemoryStore(input.state);
      (async () => {
        let code;
        try { await authenticateRequest(store, new Request('http://localhost', {headers:{cookie:'cvg_session='+input.token}})); code='ACCEPTED'; }
        catch (error) { code=error.code; }
        process.stdout.write(JSON.stringify({code, actorCurrent:authorizationSnapshotIsCurrent(store.getState(), input.actor)}));
      })().catch(() => process.exit(1));
    `;
    const restarted = (secret: string) => JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--eval", program], {
      input: JSON.stringify({ state: persisted, token: signedIn.sessionToken, actor }),
      env: { ...process.env, NODE_ENV: "production", SESSION_SECRET: secret }, encoding: "utf8"
    }));
    expect(restarted(FIRST_SECRET)).toEqual({ code: "ACCEPTED", actorCurrent: true });
    expect(restarted(SECOND_SECRET)).toEqual({ code: "SESSION_EXPIRED", actorCurrent: false });

    vi.stubEnv("SESSION_SECRET", SECOND_SECRET);
    const nextStore = new MemoryStore(persisted);
    await expect(authenticateRequest(nextStore, cookieRequest(signedIn.sessionToken))).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    await expect(reauthenticateUser(nextStore, cookieRequest(signedIn.sessionToken), PASSWORD)).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    const currentLogin = await loginUser(nextStore, "vet@cvg.local", PASSWORD);
    await expect(authenticateRequest(nextStore, cookieRequest(currentLogin.sessionToken))).resolves.toMatchObject({ id: actor.id });
  });

  it("expires an already open SSE stream on rotation without a database-version change", async () => {
    vi.stubEnv("SESSION_SECRET", FIRST_SECRET);
    vi.stubEnv("REALTIME_NOTIFICATION_ADAPTER", "process-local");
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("REALTIME_STREAM_INTERVAL_MS", "1000");
    vi.useFakeTimers();
    resetMetrics();
    resetSharedRealtimeStateReaders();
    const store = new MemoryStore(createDemoState(PASSWORD));
    const signedIn = await loginUser(store, "vet@cvg.local", PASSWORD);
    const actor = await authenticateRequest(store, cookieRequest(signedIn.sessionToken));
    const version = await store.readStateVersion();
    const response = await createRealtimeResponse(store, actor, "corr-rotation", undefined, false, cookieRequest(signedIn.sessionToken), {
      isAuthorized: authorizationSnapshotIsCurrent, eventVisible: () => true,
      authorizationError: () => new ApiError("SESSION_EXPIRED", "Sessão expirada.", 401)
    });
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    vi.stubEnv("SESSION_SECRET", SECOND_SECRET);
    const next = reader.read();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await next).toEqual({ done: true, value: undefined });
    expect(await store.readStateVersion()).toBe(version);
  });

  it("closes the last authorization check when rotation occurs during the version read", async () => {
    vi.stubEnv("SESSION_SECRET", FIRST_SECRET);
    const store = new MemoryStore(createDemoState(PASSWORD));
    const signedIn = await loginUser(store, "vet@cvg.local", PASSWORD);
    const actor = await authenticateRequest(store, cookieRequest(signedIn.sessionToken));
    const readVersion = store.readStateVersion.bind(store);
    vi.spyOn(store, "readStateVersion").mockImplementation(async () => {
      vi.stubEnv("SESSION_SECRET", SECOND_SECRET);
      return readVersion();
    });
    await expect(createRealtimeResponse(store, actor, "corr-rotation-race", undefined, true, cookieRequest(signedIn.sessionToken), {
      isAuthorized: authorizationSnapshotIsCurrent, eventVisible: () => true,
      authorizationError: () => new ApiError("SESSION_EXPIRED", "Sessão expirada.", 401)
    })).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
  });

  it("invalidates pending password-reset links along with sessions", async () => {
    vi.stubEnv("SESSION_SECRET", FIRST_SECRET);
    const { token, grant } = createPasswordResetGrant("user-admin");
    const state = createDemoState(PASSWORD);
    state.users.find((user) => user.id === "user-vet")!.passwordReset = grant;
    const store = new MemoryStore(state);
    await loginUser(store, "vet@cvg.local", PASSWORD);
    vi.stubEnv("SESSION_SECRET", SECOND_SECRET);
    await expect(completePasswordReset(new MemoryStore(store.getState()), token, "Another-Lua-79-xkz", "corr-reset-rotation"))
      .rejects.toMatchObject({ code: "PASSWORD_RESET_INVALID" });
  });

  it("accepts legacy sessions only without a secret in development/test and fails closed in production", () => {
    const token = "legacy-cookie";
    const legacy = { tokenHash: createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 60_000).toISOString() };
    expect(hashSessionToken(token, {})).toBe(legacy.tokenHash);
    expect(sessionTerminallyExpired(legacy, {})).toBe(false);
    expect(sessionTerminallyExpired(legacy, { SESSION_SECRET: FIRST_SECRET })).toBe(true);
    expect(sessionTerminallyExpired(legacy, { NODE_ENV: "production" })).toBe(true);
    expect(() => hashSessionToken(token, { NODE_ENV: "production" })).toThrow();
    expect(() => hashSessionToken(token, { NODE_ENV: "production", SESSION_SECRET: "short" })).toThrow();
    const keyed = { ...legacy, tokenHash: hashSessionToken(token, { SESSION_SECRET: FIRST_SECRET }) };
    expect(sessionTerminallyExpired(keyed, {})).toBe(true);
    expect(sessionTerminallyExpired(keyed, { SESSION_SECRET: FIRST_SECRET })).toBe(false);
    expect(sessionTerminallyExpired({ ...keyed, tokenHash: "v1:malformed" }, { SESSION_SECRET: FIRST_SECRET })).toBe(true);
    expect(sessionTerminallyExpired({ ...keyed, expiresAt: "invalid" }, { SESSION_SECRET: FIRST_SECRET })).toBe(true);
    expect(sessionTerminallyExpired({ ...keyed, revokedAt: new Date().toISOString() }, { SESSION_SECRET: FIRST_SECRET })).toBe(true);
  });
});
