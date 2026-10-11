import { describe, expect, it, vi } from "vitest";
import type { StateStore, StoreState } from "../domain/models";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { authenticateRequest, authorizationSnapshotIsCurrent, changeInitialPassword, changeOwnPassword, getCsrfCookieName, getSessionCookieName, loginUser, reauthenticateUser, revokeSession } from "./session";
import { resetRateLimits } from "./rate-limit";
import * as passwordSecurity from "./password";

/**
 * A store whose readState answers with a stale aggregate while its transaction
 * callback sees the current one. Narrow seams delegate to a real MemoryStore so
 * the session code under test exercises the production contract instead of a
 * hand-written double.
 */
function createRacingStore(readState: StoreState, transactionState: StoreState) {
  const delegate = new MemoryStore(transactionState);
  const transaction = vi.fn(async <T>(operation: (state: StoreState) => Promise<{ state: StoreState; result: T }> | { state: StoreState; result: T }) => {
    const outcome = await operation(structuredClone(transactionState));
    return outcome.result;
  });
  return {
    store: {
      getState: () => structuredClone(transactionState),
      readState: async () => structuredClone(readState),
      readStateSnapshot: delegate.readStateSnapshot.bind(delegate),
      readStateVersion: delegate.readStateVersion.bind(delegate),
      readAuditEvents: delegate.readAuditEvents.bind(delegate),
      appendReadAudit: delegate.appendReadAudit.bind(delegate),
      readAuditActors: delegate.readAuditActors.bind(delegate),
      readAuditMetrics: delegate.readAuditMetrics.bind(delegate),
      readOutbox: delegate.readOutbox.bind(delegate),
      readOutboxMetrics: delegate.readOutboxMetrics.bind(delegate),
      readRealtimeSnapshot: delegate.readRealtimeSnapshot.bind(delegate),
      outboxTransaction: delegate.outboxTransaction.bind(delegate),
      readAuthorizationSnapshot: delegate.readAuthorizationSnapshot.bind(delegate),
      readSessionActivity: delegate.readSessionActivity.bind(delegate),
      touchSessionActivity: delegate.touchSessionActivity.bind(delegate),
      compactRuntimeState: delegate.compactRuntimeState.bind(delegate),
      archiveClinicalRecords: delegate.archiveClinicalRecords.bind(delegate),
      readClinicalArchive: delegate.readClinicalArchive.bind(delegate),
      readArchivedRequest: delegate.readArchivedRequest.bind(delegate),
      readArchivedAttachmentRequest: delegate.readArchivedAttachmentRequest.bind(delegate),
      readPendingArchiveObjectDeletions: delegate.readPendingArchiveObjectDeletions.bind(delegate),
      completeArchiveObjectDeletion: delegate.completeArchiveObjectDeletion.bind(delegate),
      readArchiveObjectDeletionMetrics: delegate.readArchiveObjectDeletionMetrics.bind(delegate),
      purgeClinicalArchive: delegate.purgeClinicalArchive.bind(delegate),
      transaction: transaction as StateStore["transaction"]
    } satisfies StateStore,
    transaction
  };
}

describe("secure server sessions", () => {
  it("restricts temporary credentials until replacement, rotates sessions and audits without secrets", async () => {
    const state = createDemoState("Initial-secret-1234");
    state.users.find((user) => user.id === "user-vet")!.mustChangePassword = true;
    const store = new MemoryStore(state);
    const first = await loginUser(store, "vet@cvg.local", "Initial-secret-1234");
    const second = await loginUser(store, "vet@cvg.local", "Initial-secret-1234");
    const request = new Request("http://localhost/api/v1/session/password", { headers: { cookie: `cvg_session=${first.sessionToken}; cvg_csrf=${first.csrfToken}`, "x-csrf-token": first.csrfToken } });
    await expect(authenticateRequest(store, request)).rejects.toMatchObject({ code: "PASSWORD_CHANGE_REQUIRED" });
    await expect(authenticateRequest(store, request, { allowPasswordChange: true })).resolves.toMatchObject({ mustChangePassword: true });
    const temporaryActor = await authenticateRequest(store, request, { allowPasswordChange: true });
    expect(authorizationSnapshotIsCurrent(store.getState(), temporaryActor)).toBe(false);
    expect(authorizationSnapshotIsCurrent(store.getState(), temporaryActor, { allowPasswordChange: true })).toBe(true);
    await expect(changeInitialPassword(store, request, "Initial-secret-1234", "corr-first-login")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(changeInitialPassword(store, request, "weak", "corr-first-login")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    // PROD-203: breached/common/personal/sequential choices are refused on the first login too.
    await expect(changeInitialPassword(store, request, "Password123456", "corr-first-login")).rejects.toMatchObject({ code: "PASSWORD_POLICY" });
    await expect(changeInitialPassword(store, request, "Marina-azul-Lua-48-xk", "corr-first-login")).rejects.toMatchObject({ code: "PASSWORD_POLICY" });
    const changed = await changeInitialPassword(store, request, "Personal-secret-5678", "corr-first-login");
    expect(changed.sessionToken).not.toBe(first.sessionToken);
    expect(changed.csrfToken).not.toBe(first.csrfToken);
    for (const token of [first.sessionToken, second.sessionToken]) await expect(authenticateRequest(store, new Request("http://localhost", { headers: { cookie: `cvg_session=${token}` } }))).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    await expect(authenticateRequest(store, new Request("http://localhost", { headers: { cookie: `cvg_session=${changed.sessionToken}` } }))).resolves.toMatchObject({ mustChangePassword: false });
    await expect(loginUser(store, "vet@cvg.local", "Initial-secret-1234")).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(loginUser(store, "vet@cvg.local", "Personal-secret-5678")).resolves.toMatchObject({ user: { mustChangePassword: false } });
    const saved = await store.readState();
    expect(saved.auditEvents.at(-1)).toMatchObject({ eventType: "InitialPasswordChanged", actorId: "user-vet", previousState: "TEMPORARY_PASSWORD", newState: "ACTIVE" });
    expect(JSON.stringify(saved)).not.toContain("Personal-secret-5678");
    expect(JSON.stringify(saved)).not.toContain("Initial-secret-1234");
  });

  it("rejects missing CSRF, completed replacement and races without changing credentials", async () => {
    const state = createDemoState("Initial-secret-1234");
    state.users.find((user) => user.id === "user-vet")!.mustChangePassword = true;
    const store = new MemoryStore(state);
    const login = await loginUser(store, "vet@cvg.local", "Initial-secret-1234");
    await expect(changeInitialPassword(store, new Request("http://localhost", { headers: { cookie: `cvg_session=${login.sessionToken}` } }), "Personal-secret-5678", "corr-change")).rejects.toMatchObject({ code: "CSRF_INVALID" });
    const request = new Request("http://localhost", { headers: { cookie: `cvg_session=${login.sessionToken}; cvg_csrf=${login.csrfToken}`, "x-csrf-token": login.csrfToken } });
    const results = await Promise.allSettled([changeInitialPassword(store, request, "Personal-secret-5678", "corr-change"), changeInitialPassword(store, request, "Other-secret-9012", "corr-change")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(store.getState().auditEvents.filter((event) => event.eventType === "InitialPasswordChanged")).toHaveLength(1);
    const winner = results.find((result) => result.status === "fulfilled");
    if (winner?.status !== "fulfilled") throw new Error("No password replacement completed");
    const currentRequest = new Request("http://localhost", { headers: { cookie: `cvg_session=${winner.value.sessionToken}; cvg_csrf=${winner.value.csrfToken}`, "x-csrf-token": winner.value.csrfToken } });
    await expect(changeInitialPassword(store, currentRequest, "Another-secret-3456", "corr-change")).rejects.toMatchObject({ code: "INVALID_STATE" });
  });
  it("awaits the login hook before creating and committing a session", async () => {
    const store = new MemoryStore(createDemoState("login-hook-password"));
    const before = await store.readStateSnapshot();
    let resolveHook!: () => void;
    let signalHookStarted!: () => void;
    const hookPending = new Promise<void>((resolve) => { resolveHook = resolve; });
    const hookStarted = new Promise<void>((resolve) => { signalHookStarted = resolve; });
    const beforeSessionCreate = vi.fn(() => { signalHookStarted(); return hookPending; });
    const login = loginUser(store, "vet@cvg.local", "login-hook-password", { beforeSessionCreate });
    await hookStarted;
    expect(store.getState()).toEqual(before.state);
    expect(await store.readStateVersion()).toBe(before.version);
    resolveHook();
    await expect(login).resolves.toMatchObject({ user: { id: "user-vet" } });
    expect(beforeSessionCreate).toHaveBeenCalledOnce();
    expect(store.getState().sessions).toHaveLength(1);
    expect(await store.readStateVersion()).toBe(before.version + 1);
  });

  it("does not persist a session or version when the login hook rejects", async () => {
    const store = new MemoryStore(createDemoState("login-hook-failure-password"));
    const before = await store.readStateSnapshot();
    const failure = new Error("login counter reset failed");
    await expect(loginUser(store, "vet@cvg.local", "login-hook-failure-password", {
      beforeSessionCreate: async () => { throw failure; }
    })).rejects.toBe(failure);
    expect(await store.readStateSnapshot()).toEqual(before);
  });

  it("never calls the login hook before credentials pass transaction revalidation", async () => {
    const state = createDemoState("login-hook-revalidation-password");
    const memory = new MemoryStore(state);
    const beforeSessionCreate = vi.fn();
    await expect(loginUser(memory, "vet@cvg.local", "wrong-password", { beforeSessionCreate }))
      .rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    const current = {
      ...state,
      users: state.users.map((user) => ({ ...user, version: user.version + 1 }))
    };
    const { store } = createRacingStore(state, current);
    await expect(loginUser(store, "vet@cvg.local", "login-hook-revalidation-password", { beforeSessionCreate }))
      .rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(beforeSessionCreate).not.toHaveBeenCalled();
  });

  it("returns login with committed activity without a postcommit touch", async () => {
    const store = new MemoryStore(createDemoState("atomic-login-password"));
    const touchSpy = vi.spyOn(store, "touchSessionActivity").mockRejectedValue(new Error("postcommit touch unavailable"));
    const versionBefore = await store.readStateVersion();

    const login = await loginUser(store, "vet@cvg.local", "atomic-login-password");

    expect(login.sessionToken).toEqual(expect.any(String));
    expect(login).not.toHaveProperty("sessionId");
    const session = store.getState().sessions.at(-1)!;
    expect(await store.readSessionActivity(session.id)).toEqual({
      sessionId: session.id, userId: session.userId, lastSeenAt: session.createdAt
    });
    expect(await store.readStateVersion()).toBe(versionBefore + 1);
    expect(touchSpy).not.toHaveBeenCalled();
  });

  it("creates an opaque session and authenticates it through a cookie", async () => {
    const store = new MemoryStore(createDemoState("test-password"));
    const login = await loginUser(store, "vet@cvg.local", "test-password");
    const request = new Request("http://localhost/api/v1/me", {
      headers: { cookie: `cvg_session=${login.sessionToken}` }
    });

    const user = await authenticateRequest(store, request);

    expect(user.email).toBe("vet@cvg.local");
    expect(login.sessionToken).not.toContain(user.id);
    expect(getSessionCookieName()).toBe("cvg_session");
    expect(getCsrfCookieName()).toBe("cvg_csrf");
  });

  it("rejects wrong credentials and revoked sessions", async () => {
    const store = new MemoryStore(createDemoState("test-password"));
    await expect(loginUser(store, "vet@cvg.local", "wrong-password")).rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
    const login = await loginUser(store, "vet@cvg.local", "test-password");
    await revokeSession(store, login.sessionToken);
    await expect(
      authenticateRequest(store, new Request("http://localhost", { headers: { cookie: `cvg_session=${login.sessionToken}` } }))
    ).rejects.toMatchObject({ code: "SESSION_EXPIRED", status: 401 });
  });

  it("does not open a transaction for invalid login credentials", async () => {
    const store = new MemoryStore(createDemoState("invalid-login-password"));
    const transactionSpy = vi.spyOn(store, "transaction");

    await expect(loginUser(store, "vet@cvg.local", "wrong-password")).rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });

    expect(transactionSpy).not.toHaveBeenCalled();
  });

  it("does not open a transaction for invalid reauthentication credentials", async () => {
    const store = new MemoryStore(createDemoState("invalid-reauth-password"));
    const login = await loginUser(store, "vet@cvg.local", "invalid-reauth-password");
    const transactionSpy = vi.spyOn(store, "transaction");
    const request = new Request("http://localhost/api/v1/session/reauth", {
      headers: { cookie: `cvg_session=${login.sessionToken}` }
    });

    await expect(reauthenticateUser(store, request, "wrong-password")).rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });

    expect(transactionSpy).not.toHaveBeenCalled();
  });

  it("verifies a fixed dummy hash for unknown and inactive identities", async () => {
    const store = new MemoryStore(createDemoState("dummy-path-password"));
    const verifySpy = vi.spyOn(passwordSecurity, "verifyPassword");

    try {
      await expect(loginUser(store, "missing@cvg.local", "missing-password")).rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
      expect(verifySpy).toHaveBeenCalledWith("missing-password", expect.stringMatching(/^cvg-dummy-salt:/));

      const login = await loginUser(store, "vet@cvg.local", "dummy-path-password");
      verifySpy.mockClear();
      await store.transaction((state) => ({
        state: { ...state, users: state.users.map((user) => user.id === "user-vet" ? { ...user, active: false } : user) },
        result: undefined
      }));

      await expect(loginUser(store, "vet@cvg.local", "dummy-path-password"))
        .rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
      expect(verifySpy).toHaveBeenCalledWith("dummy-path-password", expect.stringMatching(/^cvg-dummy-salt:/));
      verifySpy.mockClear();
      await expect(reauthenticateUser(store, new Request("http://localhost", { headers: { cookie: `cvg_session=${login.sessionToken}` } }), "inactive-password"))
        .rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
      expect(verifySpy).toHaveBeenCalledWith("inactive-password", expect.stringMatching(/^cvg-dummy-salt:/));
    } finally {
      verifySpy.mockRestore();
    }
  });

  it("authenticates against the fresh read boundary instead of a stale inspection cache", async () => {
    const store = new MemoryStore(createDemoState("fresh-session-password"));
    const login = await loginUser(store, "vet@cvg.local", "fresh-session-password");
    const staleState = store.getState();
    await revokeSession(store, login.sessionToken);
    const freshnessBoundary: StateStore = {
      getState: () => structuredClone(staleState),
      readState: () => store.readState(),
      readStateSnapshot: store.readStateSnapshot.bind(store),
      readStateVersion: store.readStateVersion.bind(store),
      readAuditEvents: store.readAuditEvents.bind(store),
      appendReadAudit: store.appendReadAudit.bind(store),
      readAuditActors: store.readAuditActors.bind(store),
      readAuditMetrics: store.readAuditMetrics.bind(store),
      readOutbox: store.readOutbox.bind(store),
      readOutboxMetrics: store.readOutboxMetrics.bind(store),
      readRealtimeSnapshot: store.readRealtimeSnapshot.bind(store),
      outboxTransaction: store.outboxTransaction.bind(store),
      readAuthorizationSnapshot: store.readAuthorizationSnapshot.bind(store),
      readSessionActivity: store.readSessionActivity.bind(store),
      touchSessionActivity: store.touchSessionActivity.bind(store),
      compactRuntimeState: store.compactRuntimeState.bind(store),
      archiveClinicalRecords: store.archiveClinicalRecords.bind(store),
      readClinicalArchive: store.readClinicalArchive.bind(store),
      readArchivedRequest: store.readArchivedRequest.bind(store),
      readArchivedAttachmentRequest: store.readArchivedAttachmentRequest.bind(store),
      readPendingArchiveObjectDeletions: store.readPendingArchiveObjectDeletions.bind(store),
      completeArchiveObjectDeletion: store.completeArchiveObjectDeletion.bind(store),
      readArchiveObjectDeletionMetrics: store.readArchiveObjectDeletionMetrics.bind(store),
      purgeClinicalArchive: store.purgeClinicalArchive.bind(store),
      transaction: store.transaction.bind(store)
    };
    const request = new Request("http://localhost/api/v1/me", {
      headers: { cookie: `cvg_session=${login.sessionToken}` }
    });

    await expect(authenticateRequest(freshnessBoundary, request)).rejects.toMatchObject({
      code: "SESSION_EXPIRED",
      status: 401
    });
  });

  it("fails login closed when the credential changes between read and transaction", async () => {
    const readState = createDemoState("login-race-password");
    const user = readState.users.find((candidate) => candidate.email === "vet@cvg.local");
    if (!user) throw new Error("fixture user missing");
    const transactionState = {
      ...readState,
      users: readState.users.map((candidate) => candidate.id === user.id
        ? { ...candidate, passwordHash: `${candidate.passwordHash}:changed`, version: candidate.version + 1 }
        : candidate)
    };
    const { store, transaction } = createRacingStore(readState, transactionState);

    await expect(loginUser(store, user.email, "login-race-password")).rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });

    expect(transaction).toHaveBeenCalledOnce();
  });

  it("fails reauthentication closed when the session changes between read and transaction", async () => {
    const baseStore = new MemoryStore(createDemoState("reauth-race-password"));
    const login = await loginUser(baseStore, "vet@cvg.local", "reauth-race-password");
    const readState = baseStore.getState();
    const session = readState.sessions.find((entry) => entry.tokenHash);
    if (!session) throw new Error("fixture session missing");
    const transactionState = {
      ...readState,
      sessions: readState.sessions.map((entry) => entry.id === session.id ? { ...entry, version: entry.version + 1 } : entry)
    };
    const { store, transaction } = createRacingStore(readState, transactionState);
    const request = new Request("http://localhost/api/v1/session/reauth", {
      headers: { cookie: `cvg_session=${login.sessionToken}` }
    });

    await expect(reauthenticateUser(store, request, "reauth-race-password")).rejects.toMatchObject({ code: "SESSION_EXPIRED", status: 401 });

    expect(transaction).toHaveBeenCalledOnce();
  });

  it("rejects a long-lived realtime actor when a granular scope changes", async () => {
    const store = new MemoryStore(createDemoState("scope-session-password"));
    const login = await loginUser(store, "vet@cvg.local", "scope-session-password");
    const actor = await authenticateRequest(store, new Request("http://localhost", { headers: { cookie: `cvg_session=${login.sessionToken}` } }));

    await store.transaction((state) => ({
      state: {
        ...state,
        users: state.users.map((user) => user.id === actor.id ? { ...user, patientIds: [] } : user)
      },
      result: undefined
    }));

    expect(authorizationSnapshotIsCurrent(store.getState(), actor)).toBe(false);
  });

  it("records a recent password reauthentication on the opaque session", async () => {
    const store = new MemoryStore(createDemoState("test-password"));
    const login = await loginUser(store, "admin@cvg.local", "test-password");
    const request = new Request("http://localhost/api/v1/session/reauth", {
      headers: { cookie: `cvg_session=${login.sessionToken}` }
    });

    const reauthenticated = await reauthenticateUser(store, request, "test-password");
    expect(reauthenticated.reauthenticatedAt).toEqual(expect.any(String));
    expect((await authenticateRequest(store, request)).reauthenticatedAt).toBe(reauthenticated.reauthenticatedAt);
    await expect(reauthenticateUser(store, request, "wrong-password")).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("expires an otherwise valid session after the configured idle timeout", async () => {
    const previousIdleTimeout = process.env.SESSION_IDLE_TIMEOUT_MS;
    process.env.SESSION_IDLE_TIMEOUT_MS = "1000";
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-02T12:00:00.000Z"));
      const store = new MemoryStore(createDemoState("idle-session-password"));
      const login = await loginUser(store, "vet@cvg.local", "idle-session-password");
      vi.setSystemTime(new Date("2026-10-02T12:00:01.001Z"));

      await expect(authenticateRequest(store, new Request("http://localhost", { headers: { cookie: `cvg_session=${login.sessionToken}` } }))).rejects.toMatchObject({
        code: "SESSION_EXPIRED",
        status: 401
      });
    } finally {
      vi.useRealTimers();
      if (previousIdleTimeout === undefined) delete process.env.SESSION_IDLE_TIMEOUT_MS;
      else process.env.SESSION_IDLE_TIMEOUT_MS = previousIdleTimeout;
    }
  });

  it("records liveness through the narrow activity seam and never through a transaction", async () => {
    const previousInterval = process.env.SESSION_ACTIVITY_TOUCH_INTERVAL_MS;
    process.env.SESSION_ACTIVITY_TOUCH_INTERVAL_MS = "1";
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-02T12:00:00.000Z"));
      const store = new MemoryStore(createDemoState("touch-session-password"));
      const login = await loginUser(store, "vet@cvg.local", "touch-session-password");
      const sessionId = store.getState().sessions.at(-1)?.id ?? "";
      const transactionSpy = vi.spyOn(store, "transaction");
      const touchSpy = vi.spyOn(store, "touchSessionActivity");
      vi.setSystemTime(new Date("2026-10-02T12:00:00.002Z"));
      await authenticateRequest(store, new Request("http://localhost", { headers: { cookie: `cvg_session=${login.sessionToken}` } }));

      expect(touchSpy).toHaveBeenCalledWith({ sessionId, userId: "user-vet", lastSeenAt: "2026-10-02T12:00:00.002Z" });
      // A-01: recording activity must not open a write transaction, or every
      // authenticated read would lock and rewrite the single state row again.
      expect(transactionSpy).not.toHaveBeenCalled();
      expect(await store.readSessionActivity(sessionId)).toEqual({
        sessionId,
        userId: "user-vet",
        lastSeenAt: "2026-10-02T12:00:00.002Z"
      });
    } finally {
      vi.useRealTimers();
      if (previousInterval === undefined) delete process.env.SESSION_ACTIVITY_TOUCH_INTERVAL_MS;
      else process.env.SESSION_ACTIVITY_TOUCH_INTERVAL_MS = previousInterval;
    }
  });

  it("serves many authenticated reads without a single snapshot write", async () => {
    const store = new MemoryStore(createDemoState("read-volume-password"));
    const login = await loginUser(store, "vet@cvg.local", "read-volume-password");
    const request = new Request("http://localhost/api/v1/me", { headers: { cookie: `cvg_session=${login.sessionToken}` } });
    const transactionSpy = vi.spyOn(store, "transaction");
    const activitySpy = vi.spyOn(store, "touchSessionActivity");

    for (let attempt = 0; attempt < 50; attempt += 1) {
      await authenticateRequest(store, request);
    }

    expect(transactionSpy).not.toHaveBeenCalled();
    // The touch interval collapses 50 reads inside one interval into a single
    // narrow UPSERT instead of one global write per read.
    expect(activitySpy).toHaveBeenCalledTimes(0);
  });

  it("keeps a session created before the activity table alive for one idle window", async () => {
    process.env.SESSION_IDLE_TIMEOUT_MS = "1000";
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-02T12:00:00.000Z"));
      const store = new MemoryStore(createDemoState("legacy-session-password"));
      const login = await loginUser(store, "vet@cvg.local", "legacy-session-password");
      const sessionId = store.getState().sessions.at(-1)?.id ?? "";
      const session = store.getState().sessions.at(-1);
      if (!session) throw new Error("fixture session missing");
      // Reproduces the pre-migration shape: an old session with no activity
      // row, which the 012 migration seeds with the deploy timestamp.
      await store.reset({
        ...store.getState(),
        sessions: [{ ...session, createdAt: "2026-10-02T11:00:00.000Z" }],
        users: store.getState().users
      });
      vi.setSystemTime(new Date("2026-10-02T12:00:00.500Z"));

      const actor = await authenticateRequest(store, new Request("http://localhost", { headers: { cookie: `cvg_session=${login.sessionToken}` } }));

      expect(actor.sessionId).toBe(sessionId);
      expect(await store.readSessionActivity(sessionId)).toMatchObject({ sessionId, userId: "user-vet" });
    } finally {
      vi.useRealTimers();
      delete process.env.SESSION_IDLE_TIMEOUT_MS;
    }
  });

  it("requires the double-submit CSRF token for cookie-authenticated mutations", async () => {
    const store = new MemoryStore(createDemoState("test-password"));
    const login = await loginUser(store, "vet@cvg.local", "test-password");
    const request = new Request("http://localhost/api/v1/diagnostic-requests", {
      headers: { cookie: `cvg_session=${login.sessionToken}; cvg_csrf=${login.csrfToken}`, "x-csrf-token": "csrf-header" }
    });

    await expect(authenticateRequest(store, request, { requireCsrf: true })).rejects.toMatchObject({ code: "CSRF_INVALID" });
    const validRequest = new Request("http://localhost/api/v1/diagnostic-requests", {
      headers: { cookie: `cvg_session=${login.sessionToken}; cvg_csrf=${login.csrfToken}`, "x-csrf-token": login.csrfToken }
    });
    await expect(authenticateRequest(store, validRequest, { requireCsrf: true })).resolves.toMatchObject({ id: "user-vet" });
  });

  it("treats an invalidly encoded session cookie as an absent session", async () => {
    const store = new MemoryStore(createDemoState("malformed-cookie-password"));

    await expect(authenticateRequest(store, new Request("http://localhost", {
      headers: { cookie: "cvg_session=%E0%A4%A" }
    }))).rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
  });

  it("rejects matching CSRF cookie and header tokens that belong to another session", async () => {
    const store = new MemoryStore(createDemoState("test-password"));
    const authenticatedSession = await loginUser(store, "vet@cvg.local", "test-password");
    const otherSession = await loginUser(store, "admin@cvg.local", "test-password");
    const request = new Request("http://localhost/api/v1/diagnostic-requests", {
      headers: {
        cookie: `cvg_session=${authenticatedSession.sessionToken}; cvg_csrf=${otherSession.csrfToken}`,
        "x-csrf-token": otherSession.csrfToken
      }
    });

    await expect(authenticateRequest(store, request, { requireCsrf: true })).rejects.toMatchObject({
      code: "CSRF_INVALID",
      status: 403
    });
  });

  describe("self-service password change (PROD-201)", () => {
    const PASSWORD = "Current-secret-1234";
    const signedIn = (login: { sessionToken: string; csrfToken: string }) => new Request("http://localhost/api/v1/session/password/change", {
      headers: { cookie: `cvg_session=${login.sessionToken}; cvg_csrf=${login.csrfToken}`, "x-csrf-token": login.csrfToken }
    });

    it("applies the strengthened policy before touching credentials (PROD-203)", async () => {
      resetRateLimits();
      const store = new MemoryStore(createDemoState(PASSWORD));
      const login = await loginUser(store, "vet@cvg.local", PASSWORD);
      for (const weak of ["Qwerty-azul-Lua-4", "Boa-senha-xxxxxx-91", "Password123456", "Marina-azul-Lua-48-xk"]) {
        await expect(changeOwnPassword(store, signedIn(login), PASSWORD, weak, "corr")).rejects.toMatchObject({ code: "PASSWORD_POLICY", status: 400 });
      }
      expect(store.getState().auditEvents.some((event) => event.eventType === "PasswordChanged")).toBe(false);
    });

    it("requires the current password, rotates every session and audits without secrets", async () => {
      resetRateLimits();
      const store = new MemoryStore(createDemoState(PASSWORD));
      const first = await loginUser(store, "vet@cvg.local", PASSWORD);
      const second = await loginUser(store, "vet@cvg.local", PASSWORD);
      const changed = await changeOwnPassword(store, signedIn(first), PASSWORD, "Rotated-secret-5678", "corr-own-change");
      expect(changed.sessionToken).not.toBe(first.sessionToken);
      for (const token of [first.sessionToken, second.sessionToken]) {
        await expect(authenticateRequest(store, new Request("http://localhost", { headers: { cookie: `cvg_session=${token}` } }))).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
      }
      await expect(authenticateRequest(store, new Request("http://localhost", { headers: { cookie: `cvg_session=${changed.sessionToken}` } }))).resolves.toMatchObject({ id: "user-vet" });
      await expect(loginUser(store, "vet@cvg.local", PASSWORD)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
      await expect(loginUser(store, "vet@cvg.local", "Rotated-secret-5678")).resolves.toMatchObject({ user: { id: "user-vet" } });
      const saved = await store.readState();
      expect(saved.auditEvents.find((event) => event.eventType === "PasswordChanged")).toMatchObject({
        actorId: "user-vet", entityId: "user-vet", previousState: "ACTIVE", newState: "ACTIVE", correlationId: "corr-own-change", metadata: { sessionsRotated: true, sessionsRevoked: 2 }
      });
      expect(JSON.stringify(saved)).not.toContain("Rotated-secret-5678");
      expect(JSON.stringify(saved)).not.toContain(PASSWORD);
    });

    it("rejects a wrong current password, a reused or weak password and a missing CSRF token without a transaction", async () => {
      resetRateLimits();
      const store = new MemoryStore(createDemoState(PASSWORD));
      const login = await loginUser(store, "vet@cvg.local", PASSWORD);
      const transaction = vi.spyOn(store, "transaction");
      await expect(changeOwnPassword(store, signedIn(login), "Wrong-secret-0000", "Rotated-secret-5678", "corr")).rejects.toMatchObject({ code: "CURRENT_PASSWORD_INVALID", status: 400 });
      await expect(changeOwnPassword(store, signedIn(login), PASSWORD, PASSWORD, "corr")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      await expect(changeOwnPassword(store, signedIn(login), PASSWORD, "short-1", "corr")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      await expect(changeOwnPassword(store, signedIn(login), PASSWORD, "only-letters-without-digits", "corr")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      await expect(changeOwnPassword(store, new Request("http://localhost", { headers: { cookie: `cvg_session=${login.sessionToken}` } }), PASSWORD, "Rotated-secret-5678", "corr"))
        .rejects.toMatchObject({ code: "CSRF_INVALID" });
      expect(transaction).not.toHaveBeenCalled();
      await expect(authenticateRequest(store, signedIn(login))).resolves.toMatchObject({ id: "user-vet" });
    });

    it("bounds attempts per account and leaves a temporary password to the first-access flow", async () => {
      resetRateLimits();
      const state = createDemoState(PASSWORD);
      state.users.find((user) => user.id === "user-lab")!.mustChangePassword = true;
      const store = new MemoryStore(state);
      const login = await loginUser(store, "vet@cvg.local", PASSWORD);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await expect(changeOwnPassword(store, signedIn(login), "Wrong-secret-0000", "Rotated-secret-5678", "corr")).rejects.toMatchObject({ code: "CURRENT_PASSWORD_INVALID" });
      }
      await expect(changeOwnPassword(store, signedIn(login), PASSWORD, "Rotated-secret-5678", "corr")).rejects.toMatchObject({ code: "RATE_LIMITED", status: 429 });
      const temporary = await loginUser(store, "lab@cvg.local", PASSWORD);
      await expect(changeOwnPassword(store, signedIn(temporary), PASSWORD, "Rotated-secret-5678", "corr")).rejects.toMatchObject({ code: "PASSWORD_CHANGE_REQUIRED" });
      resetRateLimits();
    });

    it("lets one of two concurrent changes win and expires the other", async () => {
      resetRateLimits();
      const store = new MemoryStore(createDemoState(PASSWORD));
      const login = await loginUser(store, "vet@cvg.local", PASSWORD);
      const results = await Promise.allSettled([
        changeOwnPassword(store, signedIn(login), PASSWORD, "Rotated-secret-5678", "corr-a"),
        changeOwnPassword(store, signedIn(login), PASSWORD, "Another-secret-9012", "corr-b")
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "SESSION_EXPIRED" } });
      expect((await store.readState()).auditEvents.filter((event) => event.eventType === "PasswordChanged")).toHaveLength(1);
    });
  });
});
