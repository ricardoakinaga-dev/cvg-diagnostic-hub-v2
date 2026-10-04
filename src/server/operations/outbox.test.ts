import { describe, expect, it, vi } from "vitest";
import { createDemoState } from "../store/fixtures";
import type { StoreState, User } from "../domain/models";
import { requireActiveUser, requirePermission } from "../application/service-common";
import { ApiError } from "../http/envelope";
import { MemoryStore } from "../store/memory-store";
import { createOutboxSinkFromEnv, createPostgresOutboxSink, createSafeConsoleSink, discardDeadLetterMessage, InProcessEventBus, listDeadLetterMessages, processOutboxBatch, reprocessDeadLetterMessage } from "./outbox";
import type { DeadLetterCommand, OutboxSink, OutboxSqlExecutor } from "./outbox";

function authorizeAdmin(actor: User) {
  return (state: StoreState): void => {
    const current = requireActiveUser(state, actor);
    requirePermission(current, "outbox.manage", {});
    if (current.role !== "ADMIN") throw new ApiError("NOT_FOUND", "Rota não encontrada.", 404);
  };
}

function adminFrom(state: StoreState): User {
  const actor = state.users.find((user) => user.id === "user-admin");
  if (!actor) throw new Error("Admin fixture absent");
  return actor;
}

function stateWithMessage(): StoreState {
  const state = createDemoState();
  return {
    ...state,
    outbox: [{
      id: "outbox-1",
      eventType: "diagnostic.updated",
      aggregateType: "DiagnosticRequest",
      aggregateId: "request-1",
      payload: { requestId: "request-1" },
      consumerType: "DOMAIN_EVENT",
      routingKey: "domain.diagnostic.updated",
      status: "PENDING" as const,
      attempts: 0,
      availableAt: "2026-08-20T10:00:00.000Z",
      correlationId: "corr-1"
    }]
  };
}

function deadLetterFixture() {
  const state = stateWithMessage();
  const now = new Date().toISOString();
  const actor = { ...adminFrom(state), sessionId: "session-admin" };
  state.sessions = [{
    id: actor.sessionId, userId: actor.id, tokenHash: "test-token-hash", csrfTokenHash: "test-csrf-hash",
    createdAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString(), version: 1
  }];
  state.notifications = [{
    id: "notification-failed", category: "ACTIONABLE", priority: "HIGH", recipientUserId: "user-vet",
    entityType: "REQUEST", entityId: "request-1", deepLink: "/requests/request-1", title: "Ação necessária",
    body: "Atualização disponível.", dedupeKey: "request-1:failed", state: "FAILED", createdAt: now,
    attempts: 5, version: 2
  }];
  state.outbox[0] = {
    ...state.outbox[0], status: "FAILED", attempts: 5, deadLetteredAt: now, lastError: "downstream unavailable",
    payload: { notificationId: "notification-failed" }, consumerType: "NOTIFICATION_DELIVERY", routingKey: "notification.in_app"
  };
  const authorize = vi.fn(authorizeAdmin(actor));
  const command: DeadLetterCommand = {
    authorize, actorId: actor.id, correlationId: "corr-authorization", idempotencyKey: "authorization-command",
    reason: "  Dependência recuperada  "
  };
  return { store: new MemoryStore(state), actor, authorize, command };
}

describe.each([
  { action: "reprocess", mutate: reprocessDeadLetterMessage },
  { action: "discard", mutate: discardDeadLetterMessage }
])("dead-letter $action transaction authorization", ({ mutate }) => {
  it.each([false, true])("fails closed without an authorization callback (replay: %s)", async (replay) => {
    const { store, command } = deadLetterFixture();
    if (replay) await mutate(store, "outbox-1", command);
    const before = store.getState();
    const malformedCommand: Partial<DeadLetterCommand> = { ...command };
    delete malformedCommand.authorize;

    await expect(mutate(store, "outbox-1", malformedCommand as DeadLetterCommand)).rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
    expect(store.getState()).toEqual(before);
  });

  describe.each([false, true])("fresh authorization on replay=%s", (replay) => {
    it.each(["revocation", "deactivation", "demotion"] as const)("rejects %s without changing state or audit", async (change) => {
      const { store, actor, authorize, command } = deadLetterFixture();
      if (replay) await mutate(store, "outbox-1", command);
      await store.transaction((state) => ({
        state: {
          ...state,
          sessions: state.sessions.map((session) => change === "revocation" && session.id === actor.sessionId
            ? { ...session, revokedAt: new Date().toISOString(), version: session.version + 1 } : session),
          users: state.users.map((user) => user.id !== actor.id ? user
            : change === "deactivation" ? { ...user, active: false, version: user.version + 1 }
              : change === "demotion" ? { ...user, role: "MANAGER", version: user.version + 1 } : user)
        },
        result: undefined
      }));
      const before = store.getState();
      authorize.mockClear();

      await expect(mutate(store, "outbox-1", command)).rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
      expect(authorize).toHaveBeenCalledExactlyOnceWith(before);
      expect(store.getState()).toEqual(before);
    });
  });

  it("preserves reason validation, normalization and idempotency conflicts", async () => {
    const { store, command, authorize } = deadLetterFixture();
    const before = store.getState();
    await expect(mutate(store, "outbox-1", { ...command, reason: " " })).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 });
    await expect(mutate(store, "outbox-1", { ...command, reason: "x".repeat(501) })).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 });
    expect(store.getState()).toEqual(before);
    const first = await mutate(store, "outbox-1", command);
    const after = store.getState();
    expect(after.auditEvents).toContainEqual(expect.objectContaining({ entityId: "outbox-1", metadata: expect.objectContaining({ reason: "Dependência recuperada" }) }));
    expect(await mutate(store, "outbox-1", { ...command, reason: "Dependência recuperada" })).toEqual(first);
    await expect(mutate(store, "outbox-1", { ...command, reason: "Outro motivo" })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED", status: 409 });
    expect(authorize).toHaveBeenCalledTimes(3);
    expect(store.getState()).toEqual(after);
  });
});

describe("durable outbox processing", () => {
  it("claims, publishes and marks a message as processed", async () => {
    const store = new MemoryStore(stateWithMessage());
    const bus = new InProcessEventBus();

    const summary = await processOutboxBatch(store, bus, {
      now: () => new Date("2026-08-20T10:01:00.000Z"),
      workerId: "worker-test",
      batchSize: 1,
      allowSyntheticDelivery: true
    });

    expect(summary).toMatchObject({ claimed: 1, processed: 1, retried: 0, failed: 0 });
    expect(store.getState().outbox[0]).toMatchObject({ status: "PROCESSED", attempts: 1 });
    expect(store.getState().outbox[0].lockedAt).toBeUndefined();
    expect(bus.read()).toEqual([expect.objectContaining({ id: "outbox-1", eventType: "diagnostic.updated" })]);
  });

  it("marks a pending notification delivered only after the sink confirms publish", async () => {
    const state = stateWithMessage();
    state.notifications = [{ id: "notification-1", category: "ACTIONABLE", priority: "HIGH", recipientUserId: "user-vet", entityType: "REQUEST", entityId: "request-1", deepLink: "/requests/request-1", title: "Ação necessária", body: "Atualização disponível.", dedupeKey: "request-1:update", state: "PENDING", createdAt: "2026-08-20T10:00:00.000Z", attempts: 0, version: 1 }];
    state.outbox[0] = { ...state.outbox[0], payload: { requestId: "request-1", notificationId: "notification-1" }, consumerType: "NOTIFICATION_DELIVERY", routingKey: "notification.in_app" };
    const store = new MemoryStore(state);

    await processOutboxBatch(store, new InProcessEventBus(), { now: () => new Date("2026-08-20T10:01:00.000Z"), workerId: "worker-notification", batchSize: 1, allowSyntheticDelivery: true });

    expect(store.getState().notifications[0]).toMatchObject({ state: "DELIVERED", version: 2 });
    expect(store.getState().auditEvents).toContainEqual(expect.objectContaining({ eventType: "NotificationDelivered", entityId: "notification-1", previousState: "PENDING", newState: "DELIVERED" }));
  });

  it("never marks a synthetic confirmation as processed without an explicit local opt-in", async () => {
    const store = new MemoryStore(stateWithMessage());
    const summary = await processOutboxBatch(store, new InProcessEventBus(), {
      now: () => new Date("2026-08-20T10:01:00.000Z"),
      workerId: "synthetic-guard-worker",
      batchSize: 1,
      maxAttempts: 2
    });

    expect(summary).toMatchObject({ claimed: 1, processed: 0, retried: 1, failed: 0 });
    expect(store.getState().outbox[0]).toMatchObject({ status: "PENDING", lastError: expect.stringContaining("OUTBOX_DURABILITY_REQUIRED") });
  });

  it("keeps a notification pending when the sink fails", async () => {
    const state = stateWithMessage();
    state.notifications = [{ id: "notification-1", category: "CRITICAL", priority: "URGENT", recipientUserId: "user-vet", entityType: "REQUEST", entityId: "request-1", deepLink: "/requests/request-1", title: "Resultado crítico", body: "Confirmação necessária.", dedupeKey: "request-1:critical", state: "PENDING", createdAt: "2026-08-20T10:00:00.000Z", attempts: 0, version: 1 }];
    state.outbox[0] = { ...state.outbox[0], payload: { requestId: "request-1", notificationId: "notification-1" }, consumerType: "NOTIFICATION_DELIVERY", routingKey: "notification.in_app" };
    const store = new MemoryStore(state);

    await processOutboxBatch(store, { publish: async () => { throw new Error("sink indisponível"); } }, { now: () => new Date("2026-08-20T10:01:00.000Z"), maxAttempts: 2, batchSize: 1 });

    expect(store.getState().notifications[0]).toMatchObject({ state: "PENDING", version: 1 });
  });

  it("releases a failed claim with exponential backoff and dead-letters at the limit", async () => {
    const store = new MemoryStore(stateWithMessage());
    const sink = { publish: async () => { throw new Error("downstream unavailable"); } };

    const first = await processOutboxBatch(store, sink, { now: () => new Date("2026-08-20T10:01:00.000Z"), maxAttempts: 2, batchSize: 1, baseDelayMs: 1000 });
    expect(first).toMatchObject({ claimed: 1, processed: 0, retried: 1, failed: 0 });
    expect(store.getState().outbox[0]).toMatchObject({ status: "PENDING", attempts: 1, lastError: "downstream unavailable" });
    expect(store.getState().outbox[0].availableAt).toBe("2026-08-20T10:01:01.000Z");

    const second = await processOutboxBatch(store, sink, { now: () => new Date("2026-08-20T10:01:02.000Z"), maxAttempts: 2, batchSize: 1, baseDelayMs: 1000 });
    expect(second).toMatchObject({ claimed: 1, processed: 0, retried: 0, failed: 1 });
    expect(store.getState().outbox[0]).toMatchObject({ status: "FAILED", attempts: 2 });
  });

  it("marks a notification failed when its delivery message is dead-lettered", async () => {
    const state = stateWithMessage();
    state.notifications = [{ id: "notification-dead", category: "CRITICAL", priority: "URGENT", recipientUserId: "user-vet", entityType: "REQUEST", entityId: "request-1", deepLink: "/requests/request-1", title: "Resultado crítico", body: "Confirmação necessária.", dedupeKey: "request-1:dead", state: "PENDING", createdAt: "2026-08-20T10:00:00.000Z", attempts: 0, version: 1 }];
    state.outbox[0] = { ...state.outbox[0], payload: { notificationId: "notification-dead" }, consumerType: "NOTIFICATION_DELIVERY", routingKey: "notification.in_app" };
    const store = new MemoryStore(state);
    const sink = { publish: async () => { throw new Error("sink indisponível"); } };

    await processOutboxBatch(store, sink, { now: () => new Date("2026-08-20T10:01:00.000Z"), maxAttempts: 1, batchSize: 1 });

    expect(store.getState().notifications[0]).toMatchObject({ state: "FAILED", version: 2 });
    expect(store.getState().auditEvents).toContainEqual(expect.objectContaining({ eventType: "NotificationDeliveryFailed", entityId: "notification-dead", newState: "FAILED" }));
  });

  it("reprocesses a dead-lettered notification through an audited idempotent command", async () => {
    const state = stateWithMessage();
    state.notifications = [{ id: "notification-reprocess", category: "CRITICAL", priority: "URGENT", recipientUserId: "user-vet", entityType: "REQUEST", entityId: "request-1", deepLink: "/requests/request-1", title: "Resultado crítico", body: "Confirmação necessária.", dedupeKey: "request-1:reprocess", state: "PENDING", createdAt: "2026-08-20T10:00:00.000Z", attempts: 0, version: 1 }];
    state.outbox[0] = { ...state.outbox[0], payload: { notificationId: "notification-reprocess" }, consumerType: "NOTIFICATION_DELIVERY", routingKey: "notification.in_app" };
    const store = new MemoryStore(state);
    await processOutboxBatch(store, { publish: async () => { throw new Error("downstream unavailable"); } }, { now: () => new Date("2026-08-20T10:01:00.000Z"), maxAttempts: 1, batchSize: 1 });

    const authorize = vi.fn(authorizeAdmin(adminFrom(state)));
    const command = { authorize, actorId: "user-admin", correlationId: "corr-reprocess", idempotencyKey: "reprocess-1", reason: "Dependência recuperada", now: () => new Date("2026-08-20T10:02:00.000Z") };
    const first = await reprocessDeadLetterMessage(store, "outbox-1", command);
    const auditCount = store.getState().auditEvents.length;
    const replay = await reprocessDeadLetterMessage(store, "outbox-1", command);

    expect(first).toEqual(replay);
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(authorize.mock.calls[1][0].outbox[0].status).toBe("PENDING");
    expect(first).toMatchObject({ action: "REPROCESSED", message: { id: "outbox-1", status: "PENDING", attempts: 0 } });
    expect(store.getState().notifications[0]).toMatchObject({ state: "PENDING", version: 3 });
    expect(store.getState().auditEvents.length).toBe(auditCount);
    expect(store.getState().auditEvents).toContainEqual(expect.objectContaining({ eventType: "OutboxDeadLetterReprocessed", actorId: "user-admin", entityId: "outbox-1" }));
  });

  it("lists and explicitly discards dead letters without allowing the worker to reclaim them", async () => {
    const store = new MemoryStore(stateWithMessage());
    await processOutboxBatch(store, { publish: async () => { throw new Error("poison route"); } }, { now: () => new Date("2026-08-20T10:01:00.000Z"), maxAttempts: 1, batchSize: 1 });

    expect(await listDeadLetterMessages(store)).toMatchObject([{ id: "outbox-1", status: "FAILED", attempts: 1 }]);
    const authorize = vi.fn(authorizeAdmin(adminFrom(store.getState())));
    const command = { authorize, actorId: "user-admin", correlationId: "corr-discard", idempotencyKey: "discard-1", reason: "Evento inválido e sem destinatário", now: () => new Date("2026-08-20T10:02:00.000Z") };
    const discarded = await discardDeadLetterMessage(store, "outbox-1", command);
    const afterDiscard = store.getState();
    expect(await discardDeadLetterMessage(store, "outbox-1", command)).toEqual(discarded);
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(authorize.mock.calls[1][0].outbox[0].status).toBe("DISCARDED");
    expect(store.getState()).toEqual(afterDiscard);

    expect(discarded).toMatchObject({ action: "DISCARDED", message: { status: "DISCARDED", discardedBy: "user-admin", discardReason: "Evento inválido e sem destinatário" } });
    expect((await processOutboxBatch(store, { publish: async () => ({ confirmed: true, durability: "DURABLE", sink: "test", deliveryId: "delivery" }) }, { now: () => new Date("2026-08-20T10:03:00.000Z"), batchSize: 1 })).claimed).toBe(0);
  });

  it("reclaims an expired processing lease but not an active lease", async () => {
    const state = stateWithMessage();
    state.outbox = [{ ...state.outbox[0], status: "PROCESSING", attempts: 1, lockedAt: "2026-08-20T09:59:00.000Z", workerId: "old-worker" }];
    const store = new MemoryStore(state);
    const bus = new InProcessEventBus();

    const summary = await processOutboxBatch(store, bus, { now: () => new Date("2026-08-20T10:01:00.000Z"), leaseMs: 60_000, batchSize: 1, allowSyntheticDelivery: true });

    expect(summary.processed).toBe(1);
    expect(store.getState().outbox[0]).toMatchObject({ status: "PROCESSED", attempts: 2 });
  });

  it("does not claim an active processing lease", async () => {
    const state = stateWithMessage();
    state.outbox = [{ ...state.outbox[0], status: "PROCESSING", attempts: 1, lockedAt: "2026-08-20T10:00:30.000Z", workerId: "active-worker", claimToken: "active-token" }];
    const store = new MemoryStore(state);
    const summary = await processOutboxBatch(store, new InProcessEventBus(), {
      now: () => new Date("2026-08-20T10:01:00.000Z"),
      leaseMs: 60_000,
      batchSize: 1,
      allowSyntheticDelivery: true
    });

    expect(summary).toEqual({ claimed: 0, processed: 0, retried: 0, failed: 0 });
    expect(store.getState().outbox[0]).toMatchObject({ status: "PROCESSING", attempts: 1, workerId: "active-worker", claimToken: "active-token" });
  });

  it("filters unsupported domain events before a PostgreSQL claim and processes a later notification", async () => {
    const state = stateWithMessage();
    const domainEvent = state.outbox[0];
    const notificationId = "notification-postgres";
    const notification = {
      ...domainEvent,
      id: "outbox-notification",
      eventType: "ResultReleased",
      payload: { notificationId },
      consumerType: "NOTIFICATION_DELIVERY" as const,
      routingKey: "notification.in_app"
    };
    state.notifications = [{ id: notificationId, category: "ACTIONABLE", priority: "HIGH", recipientUserId: "user-vet", entityType: "REQUEST", entityId: "request-1", deepLink: "/requests/request-1", title: "Ação necessária", body: "Atualização disponível.", dedupeKey: "request-1:postgres", state: "PENDING", createdAt: "2026-08-20T10:00:00.000Z", attempts: 0, version: 1 }];
    state.outbox = [domainEvent, notification];
    const store = new MemoryStore(state);
    const query = vi.fn(async (_text: string, _values?: readonly unknown[]) => ({
      rows: [{ id: `delivery-in_app-${notificationId}`, status: "DELIVERED" }],
      rowCount: 1
    }));
    const sink = createPostgresOutboxSink({ query } satisfies OutboxSqlExecutor);

    const summary = await processOutboxBatch(store, sink, {
      now: () => new Date("2026-08-20T10:01:00.000Z"),
      workerId: "postgres-route-worker",
      batchSize: 2
    });

    expect(summary).toMatchObject({ claimed: 1, processed: 1, retried: 0, failed: 0 });
    expect(store.getState().outbox).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: domainEvent.id, status: "PENDING", attempts: 0 }),
      expect.objectContaining({ id: notification.id, status: "PROCESSED", attempts: 1 })
    ]));
    expect(store.getState().notifications[0]).toMatchObject({ id: notificationId, state: "DELIVERED", version: 2 });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("assigns domain and notification routes before a worker can acknowledge them", async () => {
    const state = stateWithMessage();
    state.outbox[0] = {
      ...state.outbox[0],
      eventType: "ResultReleased",
      payload: { notificationId: "notification-route" },
      consumerType: "NOTIFICATION_DELIVERY",
      routingKey: "notification.in_app"
    };
    const store = new MemoryStore(state);
    const bus = new InProcessEventBus();

    await processOutboxBatch(store, bus, {
      now: () => new Date("2026-08-20T10:01:00.000Z"),
      workerId: "route-worker",
      batchSize: 1,
      allowSyntheticDelivery: true
    });

    expect(bus.read()[0]).toMatchObject({
      consumerType: "NOTIFICATION_DELIVERY",
      routingKey: "notification.in_app"
    });
    expect(store.getState().outbox[0]).toMatchObject({ status: "PROCESSED", consumerType: "NOTIFICATION_DELIVERY", routingKey: "notification.in_app" });
  });

  it("does not complete a message after another worker replaces its lease", async () => {
    const store = new MemoryStore(stateWithMessage());
    const sink = {
      publish: async () => {
        await store.transaction((state) => ({
          state: {
            ...state,
            outbox: state.outbox.map((message) => message.id === "outbox-1"
              ? { ...message, workerId: "replacement-worker", claimToken: "replacement-token", lockedAt: "2026-08-20T10:01:30.000Z" }
              : message)
          },
          result: undefined
        }));
        return {
          confirmed: true,
          durability: "SYNTHETIC",
          sink: "test",
          deliveryId: "test:outbox-1"
        } as const;
      }
    };

    const summary = await processOutboxBatch(store, sink, {
      now: () => new Date("2026-08-20T10:01:00.000Z"),
      workerId: "original-worker",
      leaseMs: 60_000,
      batchSize: 1
    });

    expect(summary).toMatchObject({ claimed: 1, processed: 0, retried: 0, failed: 0 });
    expect(store.getState().outbox[0]).toMatchObject({ status: "PROCESSING", workerId: "replacement-worker", claimToken: "replacement-token" });
  });

  it("restarts from the durable pending state after a crash following sink publication", async () => {
    const effects = new Set<string>();
    let publishCalls = 0;
    const crashAfterPublish: OutboxSink = {
      publish: async (message) => {
        publishCalls += 1;
        effects.add(message.id);
        if (publishCalls === 1) throw new Error("worker crashed after publish");
        return { confirmed: true, durability: "DURABLE", sink: "test-durable", deliveryId: `delivery:${message.id}` };
      }
    };
    const firstStore = new MemoryStore(stateWithMessage());
    const first = await processOutboxBatch(firstStore, crashAfterPublish, {
      now: () => new Date("2026-08-20T10:01:00.000Z"),
      workerId: "worker-before-restart",
      maxAttempts: 3,
      baseDelayMs: 1_000,
      batchSize: 1
    });

    expect(first).toMatchObject({ claimed: 1, processed: 0, retried: 1 });
    expect(firstStore.getState().outbox[0]).toMatchObject({ status: "PENDING", attempts: 1 });

    const restartedStore = new MemoryStore(firstStore.getState());
    const second = await processOutboxBatch(restartedStore, crashAfterPublish, {
      now: () => new Date("2026-08-20T10:01:02.000Z"),
      workerId: "worker-after-restart",
      maxAttempts: 3,
      baseDelayMs: 1_000,
      batchSize: 1
    });

    expect(second).toMatchObject({ claimed: 1, processed: 1, retried: 0, failed: 0 });
    expect(restartedStore.getState().outbox[0]).toMatchObject({ status: "PROCESSED", attempts: 2 });
    expect(publishCalls).toBe(2);
    expect(effects).toEqual(new Set(["outbox-1"]));
  });

  it("does not let a poison route block the next message in the batch", async () => {
    const state = stateWithMessage();
    const poison = {
      ...state.outbox[0],
      id: "outbox-poison",
      consumerType: "DOMAIN_EVENT" as const,
      routingKey: "notification.in_app"
    };
    const healthy = {
      ...state.outbox[0],
      id: "outbox-healthy",
      eventType: "SampleReceived",
      aggregateType: "Sample",
      aggregateId: "sample-1",
      routingKey: "domain.SampleReceived"
    };
    state.outbox = [poison, healthy];
    const store = new MemoryStore(state);
    const sink: OutboxSink = {
      publish: vi.fn(async (message) => ({
        confirmed: true as const,
        durability: "SYNTHETIC" as const,
        sink: "healthy-consumer",
        deliveryId: `delivery:${message.id}`
      }))
    };

    const summary = await processOutboxBatch(store, sink, {
      now: () => new Date("2026-08-20T10:01:00.000Z"),
      workerId: "poison-worker",
      maxAttempts: 1,
      batchSize: 2,
      allowSyntheticDelivery: true
    });

    expect(summary).toMatchObject({ claimed: 2, processed: 1, retried: 0, failed: 1 });
    expect(store.getState().outbox).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "outbox-poison", status: "FAILED", attempts: 1, lastError: expect.stringContaining("OUTBOX_ROUTE_MISMATCH") }),
      expect.objectContaining({ id: "outbox-healthy", status: "PROCESSED", attempts: 1 })
    ]));
    expect(sink.publish).toHaveBeenCalledTimes(1);
    expect(sink.publish).toHaveBeenCalledWith(expect.objectContaining({ id: "outbox-healthy" }));
  });

  it("does not leave a route-probe exception silently pending", async () => {
    const store = new MemoryStore(stateWithMessage());
    const sink: OutboxSink = {
      supportsRoute: () => { throw new Error("route registry unavailable"); },
      publish: async () => ({ confirmed: true, durability: "DURABLE", sink: "durable-test", deliveryId: "delivery:outbox-1" })
    };

    const summary = await processOutboxBatch(store, sink, {
      now: () => new Date("2026-08-20T10:01:00.000Z"),
      workerId: "route-probe-worker",
      batchSize: 1
    });

    expect(summary).toMatchObject({ claimed: 1, processed: 1, retried: 0, failed: 0 });
    expect(store.getState().outbox[0]).toMatchObject({ status: "PROCESSED", attempts: 1 });
  });

  it("keeps the previous claim behavior for a generic sink without route capability", async () => {
    const state = stateWithMessage();
    const store = new MemoryStore(state);
    const sink: OutboxSink = {
      publish: vi.fn(async (message) => ({
        confirmed: true as const,
        durability: "SYNTHETIC" as const,
        sink: "generic-consumer",
        deliveryId: `delivery:${message.id}`
      }))
    };

    const summary = await processOutboxBatch(store, sink, {
      now: () => new Date("2026-08-20T10:01:00.000Z"),
      workerId: "generic-worker",
      batchSize: 1,
      allowSyntheticDelivery: true
    });

    expect(summary).toMatchObject({ claimed: 1, processed: 1, retried: 0, failed: 0 });
    expect(store.getState().outbox[0]).toMatchObject({ status: "PROCESSED", attempts: 1 });
    expect(sink.supportsRoute).toBeUndefined();
    expect(sink.publish).toHaveBeenCalledWith(expect.objectContaining({ id: "outbox-1", consumerType: "DOMAIN_EVENT" }));
  });

  it("returns an empty summary when no message is available and keeps console output safe", async () => {
    const lines: string[] = [];
    const sink = createSafeConsoleSink((line) => lines.push(line));
    const store = new MemoryStore(createDemoState());
    const summary = await processOutboxBatch(store, sink, { batchSize: 1 });

    expect(summary).toEqual({ claimed: 0, processed: 0, retried: 0, failed: 0 });
    await sink.publish({ id: "outbox-safe", eventType: "diagnostic.updated", aggregateType: "Patient", aggregateId: "patient-secret", payload: { displayName: "não deve logar" }, consumerType: "DOMAIN_EVENT", routingKey: "domain.diagnostic.updated", status: "PROCESSED", attempts: 1, availableAt: "2026-08-20T10:00:00.000Z", correlationId: "corr-safe" });
    expect(lines[0]).not.toContain("patient-secret");
    expect(lines[0]).not.toContain("não deve logar");
  });

  it("requires an explicit sink and never allows the synthetic console sink in production", () => {
    expect(() => createOutboxSinkFromEnv({ NODE_ENV: "production" })).toThrow(/OUTBOX_SINK_REQUIRED/);
    expect(() => createOutboxSinkFromEnv({ NODE_ENV: "production", OUTBOX_SINK: "console" })).toThrow(/console.*produção/i);

    const sink = createOutboxSinkFromEnv({ NODE_ENV: "development", OUTBOX_SINK: "console" });
    expect(sink).toMatchObject({ kind: "console", durability: "SYNTHETIC" });
  });

  it("requires a PostgreSQL URL and connected SQL executor for the durable sink", () => {
    expect(() => createOutboxSinkFromEnv({ NODE_ENV: "production", OUTBOX_SINK: "postgres" })).toThrow(/DATABASE_URL/);
    expect(() => createOutboxSinkFromEnv({ NODE_ENV: "production", OUTBOX_SINK: "postgres", DATABASE_URL: "postgresql://db.example/cvg" })).toThrow(/executor/i);
    expect(() => createOutboxSinkFromEnv({ NODE_ENV: "production", OUTBOX_SINK: "postgres", DATABASE_URL: "https://db.example/cvg" }, { sql: { query: vi.fn() } })).toThrow(/DATABASE_URL/);
  });

  it("confirms PostgreSQL notification delivery only after the durable row is returned", async () => {
    const query = vi.fn(async (_text: string, _values?: readonly unknown[]) => ({
      rows: [{ id: "delivery-in_app-notification-1", status: "DELIVERED" }],
      rowCount: 1
    }));
    const sink = createPostgresOutboxSink({ query } satisfies OutboxSqlExecutor, { channel: "in_app" });
    const configuredSink = createOutboxSinkFromEnv(
      { NODE_ENV: "production", OUTBOX_SINK: "postgres", DATABASE_URL: "postgresql://db.example/cvg" },
      { sql: { query } }
    );
    expect(configuredSink).toMatchObject({ kind: "postgres", durability: "DURABLE" });

    await expect(sink.publish({ ...stateWithMessage().outbox[0], payload: { notificationId: "notification-1" }, consumerType: "NOTIFICATION_DELIVERY", routingKey: "notification.in_app" })).resolves.toEqual({
      confirmed: true,
      durability: "DURABLE",
      sink: "postgres",
      deliveryId: "delivery-in_app-notification-1"
    });
    await expect(sink.publish({ ...stateWithMessage().outbox[0], payload: { notificationId: "notification-1" }, consumerType: "NOTIFICATION_DELIVERY", routingKey: "notification.in_app" })).resolves.toEqual({
      confirmed: true,
      durability: "DURABLE",
      sink: "postgres",
      deliveryId: "delivery-in_app-notification-1"
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO notification_deliveries"), ["delivery-in_app-notification-1", "notification-1", "IN_APP"]);
    expect(query.mock.calls[0]?.[0]).toMatch(/ON CONFLICT \(notification_id, channel\)/);
    expect(query.mock.calls[0]?.[0]).toMatch(/RETURNING id, status/);
  });

  it("fails closed when the PostgreSQL sink cannot prove delivery or receives a non-notification event", async () => {
    const sink = createPostgresOutboxSink({ query: vi.fn(async (_text: string, _values?: readonly unknown[]) => ({ rows: [], rowCount: 0 })) } satisfies OutboxSqlExecutor);
    await expect(sink.publish({ ...stateWithMessage().outbox[0], payload: { notificationId: "notification-1" }, consumerType: "NOTIFICATION_DELIVERY", routingKey: "notification.in_app" })).rejects.toThrow(/CONFIRMATION_MISSING/);
    await expect(sink.publish(stateWithMessage().outbox[0])).rejects.toThrow(/OUTBOX_ROUTE_UNSUPPORTED/);
  });

  it("does not process a claimed message when a sink omits confirmation", async () => {
    const store = new MemoryStore(stateWithMessage());
    const unconfirmedSink = { publish: async () => undefined } as unknown as OutboxSink;

    const summary = await processOutboxBatch(store, unconfirmedSink, {
      now: () => new Date("2026-08-20T10:01:00.000Z"),
      workerId: "unconfirmed-worker",
      batchSize: 1,
      maxAttempts: 2,
      baseDelayMs: 1_000
    });

    expect(summary).toMatchObject({ claimed: 1, processed: 0, retried: 1, failed: 0 });
    expect(store.getState().outbox[0]).toMatchObject({ status: "PENDING", lastError: expect.stringContaining("OUTBOX_SINK_UNCONFIRMED") });
  });
});
