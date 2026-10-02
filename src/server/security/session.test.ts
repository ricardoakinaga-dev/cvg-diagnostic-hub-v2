import { describe, expect, it, vi } from "vitest";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { authenticateRequest, authorizationSnapshotIsCurrent, getCsrfCookieName, getSessionCookieName, loginUser, reauthenticateUser, revokeSession } from "./session";
import * as passwordSecurity from "./password";

describe("secure server sessions", () => {
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
    const freshnessBoundary = {
      getState: () => structuredClone(staleState),
      readState: () => store.readState(),
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
});
