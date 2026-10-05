import { createHash, randomUUID } from "node:crypto";
import { outboxEnvelopeFor, OUTBOX_NOTIFICATION_ROUTING_KEY, type Notification, type OutboxMessage, type StateStore, type StoreState } from "../domain/models";

class OutboxApiError extends Error {
  public readonly code: string;
  public readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

export interface PublishedEvent {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  consumerType: OutboxMessage["consumerType"];
  routingKey: string;
  availableAt: string;
  correlationId: string;
}

export type OutboxSinkDurability = "DURABLE" | "SYNTHETIC";

export interface OutboxDeliveryConfirmation {
  confirmed: true;
  durability: OutboxSinkDurability;
  sink: string;
  deliveryId: string;
}

export interface OutboxSink {
  /** Selection hint only; a positive result never confirms delivery. */
  supportsRoute?: (message: OutboxMessage) => boolean;
  publish(message: OutboxMessage): Promise<OutboxDeliveryConfirmation>;
}

export interface ConfiguredOutboxSink extends OutboxSink {
  kind: "console" | "in-process" | "postgres";
  durability: OutboxSinkDurability;
}

export interface OutboxSqlResult {
  rows: readonly Record<string, unknown>[];
  rowCount?: number | null;
}

export interface OutboxSqlExecutor {
  query(text: string, values?: readonly unknown[]): Promise<OutboxSqlResult>;
}

export interface OutboxSinkConfiguration {
  mode: "console" | "postgres";
  databaseUrl?: string;
  channel?: string;
}

export interface OutboxSinkFactoryOptions {
  logger?: (line: string) => void;
  sql?: OutboxSqlExecutor;
}

export interface PostgresOutboxSinkOptions {
  channel?: string;
}

export interface OutboxProcessOptions {
  now?: () => Date;
  workerId?: string;
  leaseMs?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  batchSize?: number;
  /** Local/test-only escape hatch; production workers must use durable confirmation. */
  allowSyntheticDelivery?: boolean;
}

export interface OutboxProcessSummary {
  claimed: number;
  processed: number;
  retried: number;
  failed: number;
}

export interface DeadLetterMessage {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  status: Extract<OutboxMessage["status"], "PENDING" | "FAILED" | "DISCARDED">;
  attempts: number;
  availableAt: string;
  correlationId: string;
  lastError?: string;
  deadLetteredAt?: string;
  discardedAt?: string;
  discardedBy?: string;
  discardReason?: string;
}

export interface DeadLetterCommand {
  authorize: (state: StoreState) => void;
  actorId: string;
  correlationId: string;
  idempotencyKey: string;
  reason: string;
  now?: () => Date;
}

export interface DeadLetterMutationResult {
  message: DeadLetterMessage;
  action: "REPROCESSED" | "DISCARDED";
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

export const POSTGRES_NOTIFICATION_DELIVERY_SQL = `
  INSERT INTO notification_deliveries (
    id,
    notification_id,
    channel,
    status,
    attempts,
    last_error,
    sent_at,
    delivered_at,
    updated_at,
    version
  )
  VALUES ($1, $2, $3, 'DELIVERED', 1, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1)
  ON CONFLICT (notification_id, channel) DO UPDATE
    SET status = 'DELIVERED',
        attempts = notification_deliveries.attempts
          + CASE WHEN notification_deliveries.status = 'DELIVERED' THEN 0 ELSE 1 END,
        last_error = NULL,
        sent_at = COALESCE(notification_deliveries.sent_at, CURRENT_TIMESTAMP),
        delivered_at = COALESCE(notification_deliveries.delivered_at, CURRENT_TIMESTAMP),
        updated_at = CURRENT_TIMESTAMP,
        version = notification_deliveries.version
          + CASE WHEN notification_deliveries.status = 'DELIVERED' THEN 0 ELSE 1 END
  RETURNING id, status
`;

export class InProcessEventBus implements OutboxSink {
  private readonly events: PublishedEvent[] = [];

  readonly kind = "in-process" as const;
  readonly durability = "SYNTHETIC" as const;

  constructor(private readonly maxEvents = 1_000) {}

  async publish(message: OutboxMessage): Promise<OutboxDeliveryConfirmation> {
    const route = outboxEnvelopeFor(message.eventType, message.payload, message.consumerType, message.routingKey);
    const existing = this.events.find((event) => event.id === message.id);
    if (existing) {
      return {
        confirmed: true,
        durability: "SYNTHETIC",
        sink: this.kind,
        deliveryId: `in-process:${message.id}`
      };
    }
    const event: PublishedEvent = {
      id: message.id,
      eventType: message.eventType,
      aggregateType: message.aggregateType,
      aggregateId: message.aggregateId,
      consumerType: route.consumerType,
      routingKey: route.routingKey,
      availableAt: message.availableAt,
      correlationId: message.correlationId
    };
    this.events.push(event);
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
    return {
      confirmed: true,
      durability: "SYNTHETIC",
      sink: this.kind,
      deliveryId: `in-process:${message.id}`
    };
  }

  read(): PublishedEvent[] {
    return this.events.map((event) => ({ ...event }));
  }
}

export function createSafeConsoleSink(
  logger: (line: string) => void = console.log,
  environment: Partial<NodeJS.ProcessEnv> = process.env
): ConfiguredOutboxSink {
  assertSyntheticEnvironment(environment);
  return {
    kind: "console",
    durability: "SYNTHETIC",
    async publish(message): Promise<OutboxDeliveryConfirmation> {
      const route = outboxEnvelopeFor(message.eventType, message.payload, message.consumerType, message.routingKey);
      logger(JSON.stringify({ event: "outbox.publish", id: message.id, type: message.eventType, aggregateType: message.aggregateType, consumerType: route.consumerType, routingKey: route.routingKey, correlationId: message.correlationId }));
      return {
        confirmed: true,
        durability: "SYNTHETIC",
        sink: "console",
        deliveryId: `console:${message.id}`
      };
    }
  };
}

export function assertOutboxSinkConfiguration(environment: Partial<NodeJS.ProcessEnv> = process.env): OutboxSinkConfiguration {
  const configuredMode = environment.OUTBOX_SINK?.trim().toLowerCase();
  if (!configuredMode) {
    throw new Error("OUTBOX_SINK_REQUIRED: configure explicitamente um sink; não existe seleção implícita do console sink.");
  }
  if (configuredMode === "console") {
    assertSyntheticEnvironment(environment);
    return { mode: "console" };
  }
  if (configuredMode !== "postgres") {
    throw new Error("OUTBOX_SINK_INVALID: OUTBOX_SINK deve ser console ou postgres.");
  }

  const databaseUrl = environment.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL_REQUIRED_FOR_OUTBOX_POSTGRES: DATABASE_URL é obrigatório para o sink PostgreSQL.");
  assertPostgresDatabaseUrl(databaseUrl);
  const channel = normalizeDeliveryChannel(environment.OUTBOX_DELIVERY_CHANNEL);
  return { mode: "postgres", databaseUrl, channel };
}

export function createOutboxSinkFromEnv(
  environment: Partial<NodeJS.ProcessEnv> = process.env,
  options: OutboxSinkFactoryOptions = {}
): ConfiguredOutboxSink {
  const configuration = assertOutboxSinkConfiguration(environment);
  if (configuration.mode === "console") {
    return createSafeConsoleSink(options.logger, environment);
  }
  if (!options.sql) throw new Error("OUTBOX_POSTGRES_EXECUTOR_REQUIRED: o sink PostgreSQL exige um executor SQL conectado.");
  return createPostgresOutboxSink(options.sql, { channel: configuration.channel });
}

export function createPostgresOutboxSink(
  sql: OutboxSqlExecutor,
  options: PostgresOutboxSinkOptions = {}
): ConfiguredOutboxSink {
  const channel = normalizeDeliveryChannel(options.channel);
  // This adapter is intentionally limited to the relational in-app delivery
  // projection. Other outbox events require a separately approved durable sink.
  return {
    kind: "postgres",
    durability: "DURABLE",
    supportsRoute: postgresSupportsRoute,
    async publish(message): Promise<OutboxDeliveryConfirmation> {
      const route = outboxEnvelopeFor(message.eventType, message.payload, message.consumerType, message.routingKey);
      if (route.consumerType !== "NOTIFICATION_DELIVERY" || route.routingKey !== OUTBOX_NOTIFICATION_ROUTING_KEY) {
        throw new Error(`OUTBOX_ROUTE_UNSUPPORTED: PostgreSQL notification sink cannot consume ${route.consumerType}:${route.routingKey}.`);
      }
      const notificationId = notificationIdFrom(message);
      const deliveryId = `delivery-${channel.toLowerCase()}-${notificationId}`;
      const result = await sql.query(POSTGRES_NOTIFICATION_DELIVERY_SQL, [deliveryId, notificationId, channel]);
      const row = result.rowCount !== undefined && result.rowCount !== null && result.rowCount !== 1
        ? undefined
        : Array.isArray(result.rows) ? result.rows[0] : undefined;
      if (!row || typeof row.id !== "string" || !row.id || row.status !== "DELIVERED") {
        throw new Error("OUTBOX_DELIVERY_CONFIRMATION_MISSING: PostgreSQL não confirmou a entrega durável.");
      }
      return {
        confirmed: true,
        durability: "DURABLE",
        sink: "postgres",
        deliveryId: row.id
      };
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
  const allowSyntheticDelivery = options.allowSyntheticDelivery === true;
  if (allowSyntheticDelivery && process.env.NODE_ENV === "production") {
    throw new Error("OUTBOX_SYNTHETIC_DELIVERY_FORBIDDEN_IN_PRODUCTION: confirmação sintética só pode ser habilitada em development/test.");
  }
  const summary: OutboxProcessSummary = { claimed: 0, processed: 0, retried: 0, failed: 0 };

  for (let index = 0; index < batchSize; index += 1) {
    const claimed = await claimNext(store, now(), workerId, leaseMs, sink);
    if (!claimed) break;
    summary.claimed += 1;
    let routedMessage = claimed.message;
    try {
      routedMessage = { ...claimed.message, ...outboxEnvelopeFor(claimed.message.eventType, claimed.message.payload, claimed.message.consumerType, claimed.message.routingKey) };
      const confirmation = await sink.publish(routedMessage);
      assertDeliveryConfirmation(confirmation, allowSyntheticDelivery);
      const finished = await finishMessage(store, routedMessage, claimed.leaseMs, (message) => ({ ...message, status: "PROCESSED", lockedAt: undefined, workerId: undefined, claimToken: undefined, lastError: undefined }), now());
      if (finished) summary.processed += 1;
    } catch (error) {
      const permanentlyFailed = claimed.message.attempts >= maxAttempts;
      const retryDelay = baseDelayMs * (2 ** Math.max(0, claimed.message.attempts - 1));
      const nextAvailableAt = new Date(now().getTime() + Math.min(retryDelay, 15 * 60_000)).toISOString();
      const safeMessage = normalizeError(error);
      const failedAt = now().toISOString();
      const finished = await finishMessage(store, routedMessage, claimed.leaseMs, (message) => ({
        ...message,
        status: permanentlyFailed ? "FAILED" : "PENDING",
        availableAt: nextAvailableAt,
        lockedAt: undefined,
        workerId: undefined,
        claimToken: undefined,
        lastError: safeMessage,
        deadLetteredAt: permanentlyFailed ? failedAt : undefined,
        discardedAt: undefined,
        discardedBy: undefined,
        discardReason: undefined
      }), now());
      if (!finished) continue;
      if (permanentlyFailed) summary.failed += 1;
      else summary.retried += 1;
    }
  }

  return summary;
}

export async function listDeadLetterMessages(store: StateStore, limit = 100): Promise<DeadLetterMessage[]> {
  const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
  if (Number.isNaN(boundedLimit)) return [];
  const messages = await store.readOutbox({ kind: "dead-letter", limit: boundedLimit });
  return messages
    .filter((message): message is OutboxMessage & { status: "FAILED" | "DISCARDED" } => message.status === "FAILED" || message.status === "DISCARDED")
    .sort((left, right) => (right.deadLetteredAt ?? right.availableAt).localeCompare(left.deadLetteredAt ?? left.availableAt))
    .slice(0, boundedLimit)
    .map(deadLetterProjection);
}

export async function reprocessDeadLetterMessage(store: StateStore, messageId: string, command: DeadLetterCommand): Promise<DeadLetterMutationResult> {
  return mutateDeadLetter(store, messageId, command, "REPROCESSED");
}

export async function discardDeadLetterMessage(store: StateStore, messageId: string, command: DeadLetterCommand): Promise<DeadLetterMutationResult> {
  return mutateDeadLetter(store, messageId, command, "DISCARDED");
}

async function mutateDeadLetter(
  store: StateStore,
  messageId: string,
  command: DeadLetterCommand,
  action: DeadLetterMutationResult["action"]
): Promise<DeadLetterMutationResult> {
  const now = command.now ?? (() => new Date());
  const normalizedReason = command.reason.trim();
  if (!messageId || messageId.length > 200) throw new OutboxApiError("VALIDATION_ERROR", "A mensagem do outbox é inválida.", 400);
  if (!normalizedReason || normalizedReason.length > 500) throw new OutboxApiError("VALIDATION_ERROR", "Informe um motivo operacional válido.", 400);
  if (!command.actorId || !command.correlationId || !command.idempotencyKey) throw new OutboxApiError("VALIDATION_ERROR", "Metadados de auditoria são obrigatórios.", 400);
  const payloadHash = createHash("sha256").update(JSON.stringify({ messageId, reason: normalizedReason })).digest("hex");
  const scope = `POST:/outbox/dead-letters/${action.toLowerCase()}`;

  return store.outboxTransaction({ kind: "message", id: messageId }, (state) => {
    if (typeof command.authorize !== "function") throw new OutboxApiError("UNAUTHENTICATED", "Autorização necessária para alterar a dead-letter queue.", 401);
    command.authorize(state);
    const existing = state.idempotency.find((entry) => entry.actorId === command.actorId && entry.scope === scope && entry.key === command.idempotencyKey);
    if (existing) {
      if (existing.payloadHash !== payloadHash) throw new OutboxApiError("IDEMPOTENCY_KEY_REUSED", "A chave de idempotência já foi usada com outro comando.", 409);
      return { state, result: existing.response as DeadLetterMutationResult };
    }

    const current = state.outbox.find((message) => message.id === messageId);
    if (!current) throw new OutboxApiError("NOT_FOUND", "Mensagem do outbox não encontrada.", 404);
    if (current.status === "DISCARDED") throw new OutboxApiError("OUTBOX_DEAD_LETTER_ALREADY_DISCARDED", "A mensagem já foi descartada.", 409);
    if (current.status !== "FAILED") throw new OutboxApiError("OUTBOX_NOT_DEAD_LETTERED", "A mensagem não está disponível na dead-letter queue.", 409);

    const occurredAt = now().toISOString();
    const updatedMessage: OutboxMessage = action === "REPROCESSED"
      ? {
          ...current,
          status: "PENDING",
          attempts: 0,
          availableAt: occurredAt,
          lockedAt: undefined,
          workerId: undefined,
          claimToken: undefined,
          lastError: undefined,
          deadLetteredAt: undefined,
          discardedAt: undefined,
          discardedBy: undefined,
          discardReason: undefined
        }
      : {
          ...current,
          status: "DISCARDED",
          lockedAt: undefined,
          workerId: undefined,
          claimToken: undefined,
          discardedAt: occurredAt,
          discardedBy: command.actorId,
          discardReason: normalizedReason
        };
    const notificationId = typeof current.payload.notificationId === "string" ? current.payload.notificationId : undefined;
    const notification = notificationId ? state.notifications.find((entry) => entry.id === notificationId) : undefined;
    const notifications = action === "REPROCESSED" && notification?.state === "FAILED"
      ? state.notifications.map((entry) => entry.id === notification.id ? { ...entry, state: "PENDING" as const, version: entry.version + 1 } : entry)
      : state.notifications;
    const auditEvents = [
      ...state.auditEvents,
      {
        id: `audit-outbox-${action.toLowerCase()}-${randomUUID()}`,
        eventType: action === "REPROCESSED" ? "OutboxDeadLetterReprocessed" : "OutboxDeadLetterDiscarded",
        actorId: command.actorId,
        entityType: "OutboxMessage",
        entityId: current.id,
        previousState: current.status,
        newState: updatedMessage.status,
        correlationId: command.correlationId,
        metadata: { reason: normalizedReason, attempts: current.attempts, ...(notificationId ? { notificationId } : {}) },
        occurredAt
      },
      ...(action === "REPROCESSED" && notification?.state === "FAILED" ? [{
        id: `audit-notification-requeued-${randomUUID()}`,
        eventType: "NotificationDeliveryRequeued",
        actorId: command.actorId,
        entityType: "Notification",
        entityId: notification.id,
        previousState: "FAILED",
        newState: "PENDING",
        correlationId: command.correlationId,
        metadata: { outboxId: current.id },
        occurredAt
      }] : [])
    ];
    const result: DeadLetterMutationResult = { message: deadLetterProjection(updatedMessage), action };
    const idempotency = [...state.idempotency, { actorId: command.actorId, scope, key: command.idempotencyKey, payloadHash, response: result, createdAt: occurredAt }];
    return {
      state: {
        ...state,
        outbox: state.outbox.map((message) => message.id === current.id ? updatedMessage : message),
        notifications,
        auditEvents,
        idempotency
      },
      result
    };
  });
}

function deadLetterProjection(message: OutboxMessage): DeadLetterMessage {
  if (message.status !== "PENDING" && message.status !== "FAILED" && message.status !== "DISCARDED") {
    throw new Error("OUTBOX_DEAD_LETTER_PROJECTION_INVALID_STATUS");
  }
  return {
    id: message.id,
    eventType: message.eventType,
    aggregateType: message.aggregateType,
    aggregateId: message.aggregateId,
    status: message.status,
    attempts: message.attempts,
    availableAt: message.availableAt,
    correlationId: message.correlationId,
    ...(message.lastError ? { lastError: message.lastError } : {}),
    ...(message.deadLetteredAt ? { deadLetteredAt: message.deadLetteredAt } : {}),
    ...(message.discardedAt ? { discardedAt: message.discardedAt } : {}),
    ...(message.discardedBy ? { discardedBy: message.discardedBy } : {}),
    ...(message.discardReason ? { discardReason: message.discardReason } : {})
  };
}

async function claimNext(store: StateStore, currentTime: Date, workerId: string, leaseMs: number, sink: OutboxSink): Promise<ClaimedMessage | undefined> {
  const nowIso = currentTime.toISOString();
  const nowMs = currentTime.getTime();
  return store.outboxTransaction({ kind: "claim", now: nowIso, leaseMs, accepts: (message) => safelySupportsRoute(sink, message) }, (state) => {
    const index = state.outbox.findIndex((message) => {
      if (message.status === "PENDING") {
        if (message.availableAt > nowIso) return false;
      } else {
        if (message.status !== "PROCESSING") return false;
        if (message.lockedAt) {
          const lockedAtMs = Date.parse(message.lockedAt);
          if (Number.isFinite(lockedAtMs) && nowMs - lockedAtMs < leaseMs) return false;
        }
      }
      return safelySupportsRoute(sink, message);
    });
    if (index < 0) return { state, result: undefined };
    const selected = state.outbox[index];
    const claimed: OutboxMessage = { ...selected, status: "PROCESSING", attempts: selected.attempts + 1, lockedAt: nowIso, workerId, claimToken: randomUUID(), lastError: undefined };
    const outbox = state.outbox.map((message, messageIndex) => messageIndex === index ? claimed : message);
    return { state: { ...state, outbox }, result: { message: claimed, leaseMs } };
  });
}

async function finishMessage(store: StateStore, claimed: OutboxMessage, leaseMs: number, update: (message: OutboxMessage) => OutboxMessage, currentTime: Date): Promise<boolean> {
  return store.outboxTransaction({ kind: "message", id: claimed.id }, (state) => {
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
      ? [...state.auditEvents, { id: `audit-${claimed.id}-notification-${nextNotificationState.toLowerCase()}-${randomUUID()}`, eventType: nextNotificationState === "DELIVERED" ? "NotificationDelivered" : "NotificationDeliveryFailed", entityType: "Notification", entityId: deliveryNotification.id, previousState: "PENDING", newState: nextNotificationState, correlationId: claimed.correlationId, metadata: { outboxId: claimed.id, channel: "IN_APP" }, occurredAt: currentTime.toISOString() }]
      : state.auditEvents;
    return { state: { ...state, outbox, notifications, auditEvents }, result: true };
  });
}

function normalizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "OUTBOX_SINK_FAILED";
  return message.replaceAll(/[\r\n\t]+/g, " ").slice(0, MAX_ERROR_LENGTH) || "OUTBOX_SINK_FAILED";
}

function safelySupportsRoute(sink: OutboxSink, message: OutboxMessage): boolean {
  try {
    const supportsRoute = sink.supportsRoute;
    return supportsRoute === undefined || supportsRoute.call(sink, message) === true;
  } catch {
    // A capability probe is only a pre-claim optimization. If it fails, let
    // publish/confirmation decide the outcome so malformed routes cannot sit
    // pending forever without retry, metrics, or a dead-letter transition.
    return true;
  }
}

function assertDeliveryConfirmation(value: unknown, allowSyntheticDelivery: boolean): asserts value is OutboxDeliveryConfirmation {
  if (!value || typeof value !== "object") {
    throw new Error("OUTBOX_SINK_UNCONFIRMED: o sink não retornou uma confirmação válida.");
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.confirmed !== true
    || (candidate.durability !== "DURABLE" && candidate.durability !== "SYNTHETIC")
    || typeof candidate.sink !== "string"
    || !candidate.sink
    || typeof candidate.deliveryId !== "string"
    || !candidate.deliveryId
  ) {
    throw new Error("OUTBOX_SINK_UNCONFIRMED: o sink não retornou uma confirmação válida.");
  }
  if (candidate.durability === "SYNTHETIC" && !allowSyntheticDelivery) {
    throw new Error("OUTBOX_DURABILITY_REQUIRED: somente confirmação DURABLE pode marcar uma mensagem como processada; use allowSyntheticDelivery apenas em development/test.");
  }
}

function notificationIdFrom(message: OutboxMessage): string {
  const value = message.payload.notificationId;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("OUTBOX_NOTIFICATION_ID_REQUIRED: o sink PostgreSQL de notificações exige payload.notificationId.");
  }
  return value.trim();
}

function postgresSupportsRoute(message: OutboxMessage): boolean {
  try {
    const route = outboxEnvelopeFor(message.eventType, message.payload, message.consumerType, message.routingKey);
    return route.consumerType === "NOTIFICATION_DELIVERY" && route.routingKey === OUTBOX_NOTIFICATION_ROUTING_KEY;
  } catch {
    return false;
  }
}

function normalizeDeliveryChannel(value: string | undefined): string {
  const channel = (value?.trim() || "IN_APP").toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{0,31}$/.test(channel)) {
    throw new Error("OUTBOX_DELIVERY_CHANNEL_INVALID: use um canal alfanumérico em maiúsculas, como IN_APP.");
  }
  if (channel !== "IN_APP") {
    throw new Error("OUTBOX_DELIVERY_CHANNEL_UNSUPPORTED: o sink PostgreSQL atual só confirma o canal IN_APP.");
  }
  return channel;
}

function assertPostgresDatabaseUrl(value: string): void {
  try {
    const parsed = new URL(value);
    if (!(parsed.protocol === "postgres:" || parsed.protocol === "postgresql:") || !parsed.hostname) throw new Error("invalid");
  } catch {
    throw new Error("DATABASE_URL_INVALID_FOR_OUTBOX_POSTGRES: DATABASE_URL deve ser uma URL PostgreSQL válida.");
  }
}

function assertSyntheticEnvironment(environment: Partial<NodeJS.ProcessEnv>): void {
  const nodeEnv = environment.NODE_ENV?.trim().toLowerCase();
  if (nodeEnv !== "development" && nodeEnv !== "test") {
    throw new Error("OUTBOX_CONSOLE_SINK_FORBIDDEN_IN_PRODUCTION: o console sink é sintético; só pode ser usado em development ou test, nunca em produção.");
  }
}
