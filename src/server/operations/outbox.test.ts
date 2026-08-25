import { describe, expect, it } from "vitest";
import { createDemoState } from "../store/fixtures";
import type { StoreState } from "../domain/models";
import { MemoryStore } from "../store/memory-store";
import { createSafeConsoleSink, InProcessEventBus, processOutboxBatch } from "./outbox";

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
      status: "PENDING" as const,
      attempts: 0,
      availableAt: "2026-08-20T10:00:00.000Z",
      correlationId: "corr-1"
    }]
  };
}

describe("durable outbox processing", () => {
  it("claims, publishes and marks a message as processed", async () => {
    const store = new MemoryStore(stateWithMessage());
    const bus = new InProcessEventBus();

    const summary = await processOutboxBatch(store, bus, {
      now: () => new Date("2026-08-20T10:01:00.000Z"),
      workerId: "worker-test",
      batchSize: 1
    });

    expect(summary).toMatchObject({ claimed: 1, processed: 1, retried: 0, failed: 0 });
    expect(store.getState().outbox[0]).toMatchObject({ status: "PROCESSED", attempts: 1 });
    expect(store.getState().outbox[0].lockedAt).toBeUndefined();
    expect(bus.read()).toEqual([expect.objectContaining({ id: "outbox-1", eventType: "diagnostic.updated" })]);
  });

  it("marks a pending notification delivered only after the sink confirms publish", async () => {
    const state = stateWithMessage();
    state.notifications = [{ id: "notification-1", category: "ACTIONABLE", priority: "HIGH", recipientUserId: "user-vet", entityType: "REQUEST", entityId: "request-1", deepLink: "/requests/request-1", title: "Ação necessária", body: "Atualização disponível.", dedupeKey: "request-1:update", state: "PENDING", createdAt: "2026-08-20T10:00:00.000Z", attempts: 0, version: 1 }];
    state.outbox[0] = { ...state.outbox[0], payload: { requestId: "request-1", notificationId: "notification-1" } };
    const store = new MemoryStore(state);

    await processOutboxBatch(store, new InProcessEventBus(), { now: () => new Date("2026-08-20T10:01:00.000Z"), workerId: "worker-notification", batchSize: 1 });

    expect(store.getState().notifications[0]).toMatchObject({ state: "DELIVERED", version: 2 });
    expect(store.getState().auditEvents).toContainEqual(expect.objectContaining({ eventType: "NotificationDelivered", entityId: "notification-1", previousState: "PENDING", newState: "DELIVERED" }));
  });

  it("keeps a notification pending when the sink fails", async () => {
    const state = stateWithMessage();
    state.notifications = [{ id: "notification-1", category: "CRITICAL", priority: "URGENT", recipientUserId: "user-vet", entityType: "REQUEST", entityId: "request-1", deepLink: "/requests/request-1", title: "Resultado crítico", body: "Confirmação necessária.", dedupeKey: "request-1:critical", state: "PENDING", createdAt: "2026-08-20T10:00:00.000Z", attempts: 0, version: 1 }];
    state.outbox[0] = { ...state.outbox[0], payload: { requestId: "request-1", notificationId: "notification-1" } };
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
    state.outbox[0] = { ...state.outbox[0], payload: { notificationId: "notification-dead" } };
    const store = new MemoryStore(state);
    const sink = { publish: async () => { throw new Error("sink indisponível"); } };

    await processOutboxBatch(store, sink, { now: () => new Date("2026-08-20T10:01:00.000Z"), maxAttempts: 1, batchSize: 1 });

    expect(store.getState().notifications[0]).toMatchObject({ state: "FAILED", version: 2 });
    expect(store.getState().auditEvents).toContainEqual(expect.objectContaining({ eventType: "NotificationDeliveryFailed", entityId: "notification-dead", newState: "FAILED" }));
  });

  it("reclaims an expired processing lease but not an active lease", async () => {
    const state = stateWithMessage();
    state.outbox = [{ ...state.outbox[0], status: "PROCESSING", attempts: 1, lockedAt: "2026-08-20T09:59:00.000Z", workerId: "old-worker" }];
    const store = new MemoryStore(state);
    const bus = new InProcessEventBus();

    const summary = await processOutboxBatch(store, bus, { now: () => new Date("2026-08-20T10:01:00.000Z"), leaseMs: 60_000, batchSize: 1 });

    expect(summary.processed).toBe(1);
    expect(store.getState().outbox[0]).toMatchObject({ status: "PROCESSED", attempts: 2 });
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

  it("returns an empty summary when no message is available and keeps console output safe", async () => {
    const lines: string[] = [];
    const sink = createSafeConsoleSink((line) => lines.push(line));
    const store = new MemoryStore(createDemoState());
    const summary = await processOutboxBatch(store, sink, { batchSize: 1 });

    expect(summary).toEqual({ claimed: 0, processed: 0, retried: 0, failed: 0 });
    await sink.publish({ id: "outbox-safe", eventType: "diagnostic.updated", aggregateType: "Patient", aggregateId: "patient-secret", payload: { displayName: "não deve logar" }, status: "PROCESSED", attempts: 1, availableAt: "2026-08-20T10:00:00.000Z", correlationId: "corr-safe" });
    expect(lines[0]).not.toContain("patient-secret");
    expect(lines[0]).not.toContain("não deve logar");
  });
});
