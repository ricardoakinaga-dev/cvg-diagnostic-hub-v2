import { describe, expect, it } from "vitest";
import { createDemoState } from "./fixtures";
import { MemoryStore } from "./memory-store";

describe("memory store narrow seams", () => {
  it("keeps liveness monotonic for stale, replayed and concurrent observations", async () => {
    const store = new MemoryStore(createDemoState("memory-monotonic-password"));
    const before = await store.readStateSnapshot();
    const activity = { sessionId: "session-monotonic", userId: "user-vet", lastSeenAt: "2026-10-03T12:00:02.000Z" };
    expect(await store.touchSessionActivity(activity)).toEqual(activity);
    for (const lastSeenAt of ["2026-10-03T12:00:01.000Z", activity.lastSeenAt, "2026-10-03T08:59:59.000-03:00"]) {
      expect(await store.touchSessionActivity({ ...activity, lastSeenAt })).toEqual(activity);
    }
    await Promise.all([
      store.touchSessionActivity({ ...activity, lastSeenAt: "2026-10-03T12:00:04.000Z" }),
      store.touchSessionActivity({ ...activity, lastSeenAt: "2026-10-03T12:00:03.000Z" })
    ]);
    expect(await store.readSessionActivity(activity.sessionId)).toEqual({ ...activity, lastSeenAt: "2026-10-03T12:00:04.000Z" });
    expect(await store.readStateSnapshot()).toEqual(before);
  });

  it("initializes only new sessions at commit and preserves subsequent activity", async () => {
    const store = new MemoryStore(createDemoState("memory-commit-password"));
    const session = {
      id: "session-commit", userId: "user-vet", tokenHash: "token", csrfTokenHash: "csrf",
      createdAt: "2026-10-03T12:00:00.000Z", expiresAt: "2026-10-03T20:00:00.000Z", version: 1
    };
    await store.transaction(async (state) => {
      expect(await store.readSessionActivity(session.id)).toBeUndefined();
      return { state: { ...state, sessions: [session] }, result: undefined };
    });
    expect(await store.readSessionActivity(session.id)).toEqual({ sessionId: session.id, userId: session.userId, lastSeenAt: session.createdAt });
    const later = "2026-10-03T12:05:00.000Z";
    await store.touchSessionActivity({ sessionId: session.id, userId: session.userId, lastSeenAt: later });
    await store.transaction((state) => ({ state: { ...state, sessions: [{ ...session, createdAt: later, version: 2 }] }, result: undefined }));
    expect((await store.readSessionActivity(session.id))?.lastSeenAt).toBe(later);
    // Updating an existing session cannot restart its idle window.
    await store.transaction((state) => ({ state: { ...state, sessions: [{ ...session, createdAt: "2026-10-03T12:10:00.000Z", version: 3 }] }, result: undefined }));
    expect((await store.readSessionActivity(session.id))?.lastSeenAt).toBe(later);
  });

  it("publishes neither sessions, activity nor version if initialization fails", async () => {
    const store = new MemoryStore(createDemoState("memory-init-failure-password"));
    const before = await store.readStateSnapshot();
    const session = {
      id: "session-staged", userId: "user-vet", tokenHash: "token", csrfTokenHash: "csrf",
      createdAt: "2026-10-03T12:00:00.000Z", expiresAt: "2026-10-03T20:00:00.000Z", version: 1
    };
    await expect(store.transaction((state) => ({
      state: { ...state, sessions: [session, { ...session, id: "session-invalid", createdAt: "not-a-date" }] },
      result: undefined
    }))).rejects.toThrow("MEMORY_SESSION_ACTIVITY_TIMESTAMP_INVALID");
    expect(await store.readStateSnapshot()).toEqual(before);
    expect(await store.readSessionActivity(session.id)).toBeUndefined();
    expect(await store.readSessionActivity("session-invalid")).toBeUndefined();
    await store.transaction((state) => ({ state: { ...state, sessions: [session] }, result: undefined }));
    expect(await store.readStateVersion()).toBe(before.version + 1);
    expect((await store.readSessionActivity(session.id))?.lastSeenAt).toBe(session.createdAt);
  });

  it("answers an authorization read only for the owning session", async () => {
    const state = createDemoState("memory-store-authorization-password");
    const store = new MemoryStore(state);
    const session = {
      id: "session-authorization",
      userId: state.users[0]!.id,
      tokenHash: "token-hash",
      csrfTokenHash: "csrf-hash",
      createdAt: "2026-10-03T12:00:00.000Z",
      expiresAt: "2026-10-03T20:00:00.000Z",
      version: 1
    };
    await store.reset({ ...store.getState(), sessions: [session] });

    expect(await store.readAuthorizationSnapshot({ userId: session.userId, sessionId: session.id })).toEqual({
      user: state.users.find((user) => user.id === session.userId),
      session
    });
    // Another user's session id must never resolve for this user.
    expect((await store.readAuthorizationSnapshot({ userId: "user-admin", sessionId: session.id })).session).toBeUndefined();
    expect((await store.readAuthorizationSnapshot({ userId: "user-unknown" })).user).toBeUndefined();
    expect((await store.readAuthorizationSnapshot({ userId: session.userId })).session).toBeUndefined();

    // The returned objects are copies: mutating them cannot poison the store.
    const snapshot = await store.readAuthorizationSnapshot({ userId: session.userId, sessionId: session.id });
    (snapshot.session as { version: number }).version = 99;
    expect(store.getState().sessions[0]?.version).toBe(session.version);
  });

  it("keeps the write version in step with committed transactions and retention", async () => {
    const store = new MemoryStore(createDemoState("memory-store-version-password"));

    const initial = await store.readStateSnapshot();
    expect(initial.version).toBe(1);
    expect(await store.readStateVersion()).toBe(1);

    await store.transaction((state) => ({ state: { ...state, protocolSequence: state.protocolSequence + 1 }, result: undefined }));
    expect(await store.readStateVersion()).toBe(2);

    await store.reset(createDemoState("memory-store-version-password"));
    expect(await store.readStateVersion()).toBe(3);

    await store.compactRuntimeState();
    expect(await store.readStateVersion()).toBe(4);
  });

  it("fails the healthcheck for an aggregate that lost its shape", async () => {
    const store = new MemoryStore(createDemoState("memory-store-healthcheck-password"));
    await expect(store.healthcheck()).resolves.toBeUndefined();

    const broken = { ...store.getState(), outbox: {} as unknown as StoreStateLike["outbox"] };
    await store.reset(broken as StoreStateLike);
    await expect(store.healthcheck()).rejects.toThrow("MEMORY_RUNTIME_STATE_INVALID");

    const negative = { ...store.getState(), protocolSequence: -1 };
    await store.reset(negative);
    await expect(store.healthcheck()).rejects.toThrow("MEMORY_RUNTIME_STATE_INVALID");
  });
});

type StoreStateLike = ReturnType<MemoryStore["getState"]>;
