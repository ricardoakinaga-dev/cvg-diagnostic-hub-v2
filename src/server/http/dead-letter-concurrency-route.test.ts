import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../../app/api/v1/[...path]/route";
import type { StateStore, StoreState } from "../domain/models";
import { resetRateLimits } from "../security/rate-limit";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { getRuntimeStoreAsync } from "../store/runtime";

const AUTH_PASSWORD = "dead-letter-route-test-password-1234";
const MESSAGE_ID = "outbox-authorization-race";
const NOTIFICATION_ID = "notification-authorization-race";
const context = (path: string[]) => ({ params: Promise.resolve({ path }) });

function post(path: string[], headers: Record<string, string>, body: object) {
  return POST(new Request(`http://localhost/api/v1/${path.join("/")}`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body)
  }), context(path));
}

async function loginAdmin() {
  const response = await post(["session", "login"], {}, { email: "admin@cvg.local", password: AUTH_PASSWORD });
  expect(response.status).toBe(200);
  const cookies = response.headers.get("set-cookie") ?? "";
  const token = cookies.match(/cvg_session=([^;]+)/)?.[1];
  const csrf = cookies.match(/cvg_csrf=([^;]+)/)?.[1];
  if (!token || !csrf) throw new Error("Admin login cookies absent");
  return { cookie: `cvg_session=${token}; cvg_csrf=${csrf}`, "x-csrf-token": csrf, "idempotency-key": "dead-letter-race-command" };
}

async function prepareDeadLetter(store: MemoryStore) {
  const now = new Date().toISOString();
  await store.transaction((state) => ({
    state: {
      ...state,
      notifications: [...state.notifications, {
        id: NOTIFICATION_ID, category: "ACTIONABLE", priority: "HIGH", recipientUserId: "user-vet",
        entityType: "REQUEST", entityId: "request-race", deepLink: "/requests/request-race", title: "Ação necessária",
        body: "Atualização disponível.", dedupeKey: "request-race:failed", state: "FAILED", createdAt: now,
        attempts: 5, version: 2
      }],
      outbox: [...state.outbox, {
        id: MESSAGE_ID, eventType: "NotificationCreated", aggregateType: "Notification", aggregateId: NOTIFICATION_ID,
        payload: { notificationId: NOTIFICATION_ID }, consumerType: "NOTIFICATION_DELIVERY", routingKey: "notification.in_app",
        status: "FAILED", attempts: 5, availableAt: now, correlationId: "corr-dead-letter-race",
        deadLetteredAt: now, lastError: "delivery unavailable"
      }]
    },
    result: undefined
  }));
}

describe("public dead-letter commands revalidate transaction authorization", () => {
  let store: MemoryStore;
  let previousStore: StateStore | undefined;

  beforeEach(() => {
    vi.stubEnv("APP_DATA_MODE", "memory");
    vi.stubEnv("RATE_LIMIT_MODE", "memory");
    vi.stubEnv("DEMO_PASSWORD", AUTH_PASSWORD);
    vi.stubEnv("LOGIN_RATE_LIMIT", "100");
    previousStore = globalThis.__cvgDiagnosticsStore;
    store = new MemoryStore(createDemoState(AUTH_PASSWORD));
    globalThis.__cvgDiagnosticsStore = store;
    resetRateLimits();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetRateLimits();
    globalThis.__cvgDiagnosticsStore = previousStore;
    vi.unstubAllEnvs();
  });

  describe.each(["reprocess", "discard"] as const)("POST /outbox/dead-letters/:id/%s", (action) => {
    it("allows an active ADMIN without password or reason and audits the default reason once on replay", async () => {
      const headers = await loginAdmin();
      await prepareDeadLetter(store);
      expect(await getRuntimeStoreAsync()).toBe(store);
      expect(store.getState().sessions[0].reauthenticatedAt).toBeUndefined();
      const path = ["outbox", "dead-letters", MESSAGE_ID, action];
      const response = await post(path, headers, {});
      expect(response.status).toBe(200);
      const result = (await response.json()).data;
      expect(result).toMatchObject({
        action: action === "reprocess" ? "REPROCESSED" : "DISCARDED",
        message: { id: MESSAGE_ID, status: action === "reprocess" ? "PENDING" : "DISCARDED" }
      });
      const after = store.getState();
      expect(after.auditEvents).toContainEqual(expect.objectContaining({
        actorId: "user-admin", entityId: MESSAGE_ID,
        metadata: expect.objectContaining({ reason: action === "reprocess" ? "Reprocessamento solicitado na aba Sistema" : "Descarte solicitado na aba Sistema" })
      }));
      const replay = await post(path, headers, {});
      expect(replay.status).toBe(200);
      expect((await replay.json()).data).toEqual(result);
      expect(store.getState()).toEqual(after);
    });

    describe.each([false, true])("authorization changes just before transaction (replay: %s)", (replay) => {
      it.each(["revocation", "deactivation", "demotion"] as const)("rejects ADMIN %s with no operational writes", async (change) => {
        const headers = await loginAdmin();
        await prepareDeadLetter(store);
        expect(await getRuntimeStoreAsync()).toBe(store);
        const path = ["outbox", "dead-letters", MESSAGE_ID, action];
        if (replay) expect((await post(path, headers, {})).status).toBe(200);
        const before = store.getState();
        const session = before.sessions.find((entry) => entry.userId === "user-admin");
        if (!session) throw new Error("Active admin session absent");
        expect(session.revokedAt).toBeUndefined();
        expect(before.users.find((user) => user.id === "user-admin")).toMatchObject({ active: true, role: "ADMIN" });
        const originalTransaction = store.transaction.bind(store);
        let authorizationState: StoreState | undefined;
        // Persist the racing change through the real store before delegating the
        // command. The bound original avoids recursively invoking this spy.
        const transaction = vi.spyOn(store, "transaction").mockImplementationOnce(async (operation) => {
          await originalTransaction((state) => ({
            state: {
              ...state,
              sessions: state.sessions.map((entry) => change === "revocation" && entry.id === session.id
                ? { ...entry, revokedAt: new Date().toISOString(), version: entry.version + 1 } : entry),
              users: state.users.map((user) => user.id !== session.userId ? user
                : change === "deactivation" ? { ...user, active: false, version: user.version + 1 }
                  : change === "demotion" ? { ...user, role: "MANAGER", version: user.version + 1 } : user)
            },
            result: undefined
          }));
          authorizationState = store.getState();
          return originalTransaction(operation);
        });

        const response = await post(path, headers, {});

        expect(transaction).toHaveBeenCalledTimes(1);
        expect(authorizationState).toBeDefined();
        expect([401, 404]).toContain(response.status);
        expect((await response.json()).error.code).toMatch(/^(UNAUTHENTICATED|SESSION_EXPIRED|SCOPE_DENIED|NOT_FOUND)$/);
        const after = store.getState();
        expect(after).toEqual(authorizationState);
        expect(after.outbox).toEqual(before.outbox);
        expect(after.notifications).toEqual(before.notifications);
        expect(after.auditEvents).toEqual(before.auditEvents);
        expect(after.idempotency).toEqual(before.idempotency);
      });
    });
  });
});
