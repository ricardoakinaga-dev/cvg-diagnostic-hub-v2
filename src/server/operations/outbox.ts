import { randomUUID } from "node:crypto";
import type { Notification, OutboxMessage, StateStore } from "../domain/models";

export interface PublishedEvent {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  availableAt: string;
  correlationId: string;
}

export interface OutboxSink {
  publish(message: OutboxMessage): Promise<void>;
}

export interface OutboxProcessOptions {
  now?: () => Date;
  workerId?: string;
  leaseMs?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  batchSize?: number;
}

export interface OutboxProcessSummary {
  claimed: number;
  processed: number;
  retried: number;
  failed: number;
}

interface ClaimedMessage {
  message: OutboxMessage;
  leaseMs: number;
}

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_BATCH_SIZE = 25;
const MAX_ERROR_LENGTH = 240;

export class InProcessEventBus implements OutboxSink {
  private readonly events: PublishedEvent[] = [];

  constructor(private readonly maxEvents = 1_000) {}

  async publish(message: OutboxMessage): Promise<void> {
    const event: PublishedEvent = {
      id: message.id,
      eventType: message.eventType,
      aggregateType: message.aggregateType,
      aggregateId: message.aggregateId,
      availableAt: message.availableAt,
      correlationId: message.correlationId
    };
    this.events.push(event);
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
  }

  read(): PublishedEvent[] {
    return this.events.map((event) => ({ ...event }));
  }
}

export function createSafeConsoleSink(logger: (line: string) => void = console.log): OutboxSink {
  return {
    async publish(message) {
      logger(JSON.stringify({ event: "outbox.publish", id: message.id, type: message.eventType, aggregateType: message.aggregateType, correlationId: message.correlationId }));
    }
  };
}

export async function processOutboxBatch(store: StateStore, sink: OutboxSink, options: OutboxProcessOptions = {}): Promise<OutboxProcessSummary> {
  const now = options.now ?? (() => new Date());
  const workerId = options.workerId ?? `worker_${randomUUID()}`;
  const leaseMs = Math.max(1, options.leaseMs ?? DEFAULT_LEASE_MS);
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const baseDelayMs = Math.max(1, options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS);
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
  const summary: OutboxProcessSummary = { claimed: 0, processed: 0, retried: 0, failed: 0 };

  for (let index = 0; index < batchSize; index += 1) {
    const claimed = await claimNext(store, now(), workerId, leaseMs);
    if (!claimed) break;
    summary.claimed += 1;
    try {
      await sink.publish(claimed.message);
      const finished = await finishMessage(store, claimed.message, claimed.leaseMs, (message) => ({ ...message, status: "PROCESSED", lockedAt: undefined, workerId: undefined, claimToken: undefined, lastError: undefined }), now());
      if (finished) summary.processed += 1;
    } catch (error) {
      const permanentlyFailed = claimed.message.attempts >= maxAttempts;
      const retryDelay = baseDelayMs * (2 ** Math.max(0, claimed.message.attempts - 1));
      const nextAvailableAt = new Date(now().getTime() + Math.min(retryDelay, 15 * 60_000)).toISOString();
      const safeMessage = normalizeError(error);
      const finished = await finishMessage(store, claimed.message, claimed.leaseMs, (message) => ({
        ...message,
        status: permanentlyFailed ? "FAILED" : "PENDING",
        availableAt: nextAvailableAt,
        lockedAt: undefined,
        workerId: undefined,
        claimToken: undefined,
        lastError: safeMessage
      }), now());
      if (!finished) continue;
      if (permanentlyFailed) summary.failed += 1;
      else summary.retried += 1;
    }
  }

  return summary;
}

async function claimNext(store: StateStore, currentTime: Date, workerId: string, leaseMs: number): Promise<ClaimedMessage | undefined> {
  const nowIso = currentTime.toISOString();
  const nowMs = currentTime.getTime();
  return store.transaction((state) => {
    const index = state.outbox.findIndex((message) => {
      if (message.status === "PENDING") return message.availableAt <= nowIso;
      if (message.status !== "PROCESSING") return false;
      return !message.lockedAt || nowMs - new Date(message.lockedAt).getTime() >= leaseMs;
    });
    if (index < 0) return { state, result: undefined };
    const selected = state.outbox[index];
    const claimed: OutboxMessage = { ...selected, status: "PROCESSING", attempts: selected.attempts + 1, lockedAt: nowIso, workerId, claimToken: randomUUID(), lastError: undefined };
    const outbox = state.outbox.map((message, messageIndex) => messageIndex === index ? claimed : message);
    return { state: { ...state, outbox }, result: { message: claimed, leaseMs } };
  });
}

async function finishMessage(store: StateStore, claimed: OutboxMessage, leaseMs: number, update: (message: OutboxMessage) => OutboxMessage, currentTime: Date): Promise<boolean> {
  return store.transaction((state) => {
    const current = state.outbox.find((message) => message.id === claimed.id);
    const ownsUnexpiredLease = current
      && current.status === "PROCESSING"
      && current.workerId === claimed.workerId
      && current.claimToken === claimed.claimToken
      && current.lockedAt
      && Date.parse(current.lockedAt) + leaseMs > currentTime.getTime();
    if (!ownsUnexpiredLease) return { state, result: false };
    const updatedMessage = update(claimed);
    const outbox = state.outbox.map((message) => message.id === claimed.id ? updatedMessage : message);
    const notificationId = typeof claimed.payload.notificationId === "string" ? claimed.payload.notificationId : undefined;
    const deliveryNotification = notificationId ? state.notifications.find((notification) => notification.id === notificationId && notification.state === "PENDING") : undefined;
    const nextNotificationState: Notification["state"] | undefined = updatedMessage.status === "PROCESSED" ? "DELIVERED" : updatedMessage.status === "FAILED" ? "FAILED" : undefined;
    const notifications = deliveryNotification && nextNotificationState
      ? state.notifications.map((notification) => notification.id === deliveryNotification.id ? { ...notification, state: nextNotificationState, version: notification.version + 1 } : notification)
      : state.notifications;
    const auditEvents = deliveryNotification && nextNotificationState
      ? [...state.auditEvents, { id: `audit-${claimed.id}-notification-${nextNotificationState.toLowerCase()}`, eventType: nextNotificationState === "DELIVERED" ? "NotificationDelivered" : "NotificationDeliveryFailed", entityType: "Notification", entityId: deliveryNotification.id, previousState: "PENDING", newState: nextNotificationState, correlationId: claimed.correlationId, metadata: { outboxId: claimed.id, channel: "IN_APP" }, occurredAt: currentTime.toISOString() }]
      : state.auditEvents;
    return { state: { ...state, outbox, notifications, auditEvents }, result: true };
  });
}

function normalizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "OUTBOX_SINK_FAILED";
  return message.replaceAll(/[\r\n\t]+/g, " ").slice(0, MAX_ERROR_LENGTH) || "OUTBOX_SINK_FAILED";
}
