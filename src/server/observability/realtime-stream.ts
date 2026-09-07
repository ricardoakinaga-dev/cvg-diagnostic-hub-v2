import type { StateStore, StoreState, User } from "../domain/models";
import { getRealtimeNotificationAdapter, type RealtimeNotificationAdapter } from "./realtime";
import { recordRealtimePoll, recordRealtimeResync, recordRealtimeStreamClosure, releaseRealtimeConnection, tryAcquireRealtimeConnection } from "./metrics";

export interface RealtimeAccessPolicy {
  isAuthorized(state: StoreState, actor: User): boolean;
  eventVisible(state: StoreState, actor: User, entityType: string, entityId: string, payload: Record<string, unknown>): boolean;
  authorizationError(): Error;
}

export class RealtimeUnavailableError extends Error {
  constructor(readonly reason: "adapter_unavailable" | "capacity") {
    super(reason);
    this.name = "RealtimeUnavailableError";
  }
}

const REALTIME_DEFAULT_INTERVAL_MS = 5_000;
const REALTIME_MAX_INTERVAL_MS = 60_000;
const REALTIME_DEFAULT_POLL_TIMEOUT_MS = 10_000;
const REALTIME_MAX_POLL_TIMEOUT_MS = 30_000;
const REALTIME_DEFAULT_CONNECTION_LIMIT = 100;
const REALTIME_MAX_CONNECTION_LIMIT = 1_000;
const REALTIME_DEFAULT_REPLAY_WINDOW = 20;
const REALTIME_MAX_REPLAY_WINDOW = 100;
const REALTIME_MAX_STREAM_MS = 24 * 60 * 60 * 1_000;
const REALTIME_MAX_PAYLOAD_BYTES = 256 * 1_024;

class RealtimePollError extends Error {
  constructor(readonly reason: "poll_timeout" | "client_aborted" | "state_read_failed") {
    super(reason);
    this.name = "RealtimePollError";
  }
}

class RealtimeEnqueueError extends Error {
  constructor() {
    super("enqueue_failed");
    this.name = "RealtimeEnqueueError";
  }
}

class RealtimeAuthorizationError extends Error {
  constructor(readonly responseError: Error) {
    super("authorization_revoked");
    this.name = "RealtimeAuthorizationError";
  }
}

function replayableOutboxMessages(state: StoreState, window: number): StoreState["outbox"] {
  // PENDING is already committed domain evidence and is needed for the
  // process-local wake-up path. PROCESSING/FAILED messages belong to delivery
  // recovery and must not be replayed as if their notification were settled.
  return state.outbox.filter((message) => message.status === "PENDING" || message.status === "PROCESSED").slice(-window);
}

export async function createRealtimeResponse(
  store: StateStore,
  actor: User,
  correlationId: string,
  lastEventId: string | undefined,
  snapshot: boolean,
  request: Request,
  policy: RealtimeAccessPolicy
): Promise<Response> {
  const headers = { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-correlation-id": correlationId };
  // A one-shot snapshot is the durable polling/reconciliation path and does
  // not require a wake-up adapter. The live stream does require one because it
  // subscribes to process-local or cross-instance notifications.
  if (snapshot) return realtimeSnapshotResponse(store, actor, lastEventId, request, headers, policy);

  const adapter = getRealtimeNotificationAdapter();
  if (!adapter) {
    recordRealtimeStreamClosure("adapter_unavailable");
    throw new RealtimeUnavailableError("adapter_unavailable");
  }

  const maxConnections = boundedRealtimeInteger(process.env.REALTIME_MAX_CONNECTIONS, REALTIME_DEFAULT_CONNECTION_LIMIT, REALTIME_MAX_CONNECTION_LIMIT);
  if (!tryAcquireRealtimeConnection(maxConnections)) {
    throw new RealtimeUnavailableError("capacity");
  }

  let connectionReleased = false;
  const releaseConnection = () => {
    if (connectionReleased) return;
    connectionReleased = true;
    releaseRealtimeConnection();
  };

  try {
    const stream = createRealtimeStream(store, actor, lastEventId, request, adapter, releaseConnection, policy);
    return new Response(stream, { headers });
  } catch (error) {
    releaseConnection();
    throw error;
  }
}

async function realtimeSnapshotResponse(
  store: StateStore,
  actor: User,
  lastEventId: string | undefined,
  request: Request,
  headers: Record<string, string>,
  policy: RealtimeAccessPolicy
): Promise<Response> {
  const startedAt = performance.now();
  const pollTimeoutMs = boundedRealtimeInteger(process.env.REALTIME_POLL_TIMEOUT_MS, REALTIME_DEFAULT_POLL_TIMEOUT_MS, REALTIME_MAX_POLL_TIMEOUT_MS);
  try {
    const state = await readRealtimeState(store, pollTimeoutMs, request.signal);
    assertRealtimeAuthorization(state, actor, policy);
    const boundedEvents = replayableOutboxMessages(state, boundedRealtimeInteger(process.env.REALTIME_REPLAY_WINDOW, REALTIME_DEFAULT_REPLAY_WINDOW, REALTIME_MAX_REPLAY_WINDOW));
    const lastIndex = lastEventId ? boundedEvents.findIndex((message) => message.id === lastEventId) : -1;
    const replayExpired = Boolean(lastEventId) && lastIndex < 0;
    const replayWindow = lastEventId && !replayExpired ? boundedEvents.slice(lastIndex + 1) : boundedEvents;
    const events = replayWindow
      .filter((message) => policy.eventVisible(state, actor, message.aggregateType, message.aggregateId, message.payload))
      .map((message) => realtimeEventData(message));
    const resync = replayExpired ? `event: resync_required\ndata: ${JSON.stringify({ reason: "event_window_expired" })}\n\n` : "";
    const payload = `${resync}${events.map((event) => formatRealtimeEvent(event)).join("")}`;
    const authorizationState = await readRealtimeState(store, pollTimeoutMs, request.signal);
    assertRealtimeAuthorization(authorizationState, actor, policy);
    if (replayExpired) recordRealtimeResync("event_window_expired");
    recordRealtimePoll("snapshot", "success", performance.now() - startedAt);
    return new Response(`retry: 5000\n\n${payload || ": heartbeat\n\n"}`, { headers });
  } catch (error) {
    if (error instanceof RealtimeAuthorizationError) {
      recordRealtimePoll("snapshot", "success", performance.now() - startedAt);
      throw error.responseError;
    }
    recordRealtimePoll("snapshot", "failure", performance.now() - startedAt, realtimePollFailureReason(error));
    throw error;
  }
}

function createRealtimeStream(
  store: StateStore,
  actor: User,
  lastEventId: string | undefined,
  request: Request,
  adapter: RealtimeNotificationAdapter,
  releaseConnection: () => void,
  policy: RealtimeAccessPolicy
): ReadableStream<Uint8Array> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expirationTimer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  let abortHandler: (() => void) | undefined;
  let closed = false;
  let cleanupDone = false;
  let pollInFlight = false;
  let pollRequested = false;
  const intervalMs = boundedRealtimeInteger(process.env.REALTIME_STREAM_INTERVAL_MS, REALTIME_DEFAULT_INTERVAL_MS, REALTIME_MAX_INTERVAL_MS);
  const pollTimeoutMs = boundedRealtimeInteger(process.env.REALTIME_POLL_TIMEOUT_MS, REALTIME_DEFAULT_POLL_TIMEOUT_MS, REALTIME_MAX_POLL_TIMEOUT_MS);
  const replayWindow = boundedRealtimeInteger(process.env.REALTIME_REPLAY_WINDOW, REALTIME_DEFAULT_REPLAY_WINDOW, REALTIME_MAX_REPLAY_WINDOW);
  const maxStreamMs = boundedRealtimeDuration(process.env.REALTIME_STREAM_MAX_MS, REALTIME_MAX_STREAM_MS);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let cursor = lastEventId;
      let lastResyncCursor: string | undefined;
      let preamblePending = true;

      const cleanup = (reason: string) => {
        if (cleanupDone) return;
        cleanupDone = true;
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        if (expirationTimer) {
          clearTimeout(expirationTimer);
          expirationTimer = undefined;
        }
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = undefined;
        }
        if (abortHandler) {
          request.signal.removeEventListener("abort", abortHandler);
          abortHandler = undefined;
        }
        releaseConnection();
        recordRealtimeStreamClosure(reason);
      };

      const closeStream = (reason: string) => {
        if (closed) return;
        closed = true;
        cleanup(reason);
        try {
          controller.close();
        } catch {
          // The consumer may have cancelled the stream between the state
          // check and this close; cleanup remains the important invariant.
        }
      };

      const schedulePoll = () => {
        if (closed || timer) return;
        timer = setTimeout(() => {
          timer = undefined;
          requestPoll();
        }, intervalMs);
      };

      const send = async () => {
        if (closed || pollInFlight) return;
        if (controller.desiredSize !== null && controller.desiredSize <= 0) {
          closeStream("backpressure");
          return;
        }
        pollInFlight = true;
        pollRequested = false;
        const startedAt = performance.now();
        let outcome: "success" | "failure" = "success";
        let failureReason: string | undefined;
        try {
          const current = await readRealtimeState(store, pollTimeoutMs, request.signal);
          if (closed) {
            outcome = "failure";
            failureReason = request.signal.aborted ? "client_aborted" : "stream_closed";
            return;
          }
          if (!policy.isAuthorized(current, actor)) {
            closeStream("authorization_revoked");
            return;
          }
          const messages = replayableOutboxMessages(current, replayWindow);
          const cursorIndex = cursor ? messages.findIndex((message) => message.id === cursor) : -1;
          const expired = Boolean(cursor) && cursorIndex < 0;
          const replay = cursor && !expired ? messages.slice(cursorIndex + 1) : messages;
          const visible = replay.filter((message) => policy.eventVisible(current, actor, message.aggregateType, message.aggregateId, message.payload));
          const latestMessageId = messages.at(-1)?.id;
          const shouldResync = expired && lastResyncCursor !== cursor;
          if (latestMessageId) cursor = latestMessageId;
          const events = visible.map((message) => {
            cursor = message.id;
            return realtimeEventData(message);
          });
          const nextPayload = `${preamblePending ? "retry: 5000\n\n" : ""}${shouldResync ? `event: resync_required\ndata: ${JSON.stringify({ reason: "event_window_expired" })}\n\n` : ""}${events.map((event) => formatRealtimeEvent(event)).join("") || ": heartbeat\n\n"}`;
          const authorizationState = await readRealtimeState(store, pollTimeoutMs, request.signal);
          if (closed) {
            outcome = "failure";
            failureReason = request.signal.aborted ? "client_aborted" : "stream_closed";
            return;
          }
          if (!policy.isAuthorized(authorizationState, actor)) {
            closeStream("authorization_revoked");
            return;
          }
          const encoded = encoder.encode(nextPayload);
          if (encoded.byteLength > REALTIME_MAX_PAYLOAD_BYTES) throw new RealtimeEnqueueError();
          if (controller.desiredSize !== null && controller.desiredSize <= 0) {
            closeStream("backpressure");
            return;
          }
          try {
            controller.enqueue(encoded);
          } catch {
            throw new RealtimeEnqueueError();
          }
          if (shouldResync) {
            lastResyncCursor = cursor;
            recordRealtimeResync("event_window_expired");
          }
          preamblePending = false;
        } catch (error) {
          outcome = "failure";
          failureReason = realtimePollFailureReason(error);
          if (!closed) closeStream(error instanceof RealtimeEnqueueError ? "backpressure" : error instanceof RealtimePollError && error.reason === "poll_timeout" ? "poll_timeout" : "poll_failure");
        } finally {
          recordRealtimePoll("stream", outcome, performance.now() - startedAt, failureReason);
          pollInFlight = false;
          if (!closed) {
            if (pollRequested) {
              pollRequested = false;
              void send();
            } else {
              schedulePoll();
            }
          }
        }
      };

      const requestPoll = () => {
        if (closed) return;
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        if (pollInFlight) {
          pollRequested = true;
          return;
        }
        void send();
      };

      abortHandler = () => closeStream("client_abort");
      request.signal.addEventListener("abort", abortHandler, { once: true });
      unsubscribe = adapter.subscribe(requestPoll);
      if (maxStreamMs > 0) expirationTimer = setTimeout(() => closeStream("max_duration"), maxStreamMs);
      if (request.signal.aborted) closeStream("client_abort");
      else requestPoll();
    },
    cancel() {
      if (closed) return;
      closed = true;
      cleanupDone = true;
      if (timer) clearTimeout(timer);
      if (expirationTimer) clearTimeout(expirationTimer);
      if (unsubscribe) unsubscribe();
      if (abortHandler) request.signal.removeEventListener("abort", abortHandler);
      releaseConnection();
      recordRealtimeStreamClosure("consumer_cancel");
    }
  });
  return stream;
}

async function readRealtimeState(store: StateStore, timeoutMs: number, signal: AbortSignal): Promise<StoreState> {
  if (signal.aborted) throw new RealtimePollError("client_aborted");
  const statePromise = Promise.resolve().then(() => store.readState());
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  const timeoutPromise = new Promise<StoreState>((_, reject) => {
    timeout = setTimeout(() => reject(new RealtimePollError("poll_timeout")), timeoutMs);
  });
  const abortPromise = new Promise<StoreState>((_, reject) => {
    abortHandler = () => reject(new RealtimePollError("client_aborted"));
    signal.addEventListener("abort", abortHandler, { once: true });
  });
  try {
    return await Promise.race([statePromise, timeoutPromise, abortPromise]);
  } catch (error) {
    if (error instanceof RealtimePollError) throw error;
    throw new RealtimePollError("state_read_failed");
  } finally {
    if (timeout) clearTimeout(timeout);
    if (abortHandler) signal.removeEventListener("abort", abortHandler);
  }
}

function assertRealtimeAuthorization(state: StoreState, actor: User, policy: RealtimeAccessPolicy): void {
  if (!policy.isAuthorized(state, actor)) throw new RealtimeAuthorizationError(policy.authorizationError());
}

function realtimeEventData(message: StoreState["outbox"][number]) {
  return { eventId: message.id, type: message.eventType, occurredAt: message.availableAt, entityType: message.aggregateType, entityId: message.aggregateId, correlationId: message.correlationId };
}

function formatRealtimeEvent(event: ReturnType<typeof realtimeEventData>): string {
  return `id: ${event.eventId}\nevent: diagnostic.updated\ndata: ${JSON.stringify(event)}\n\n`;
}

function realtimePollFailureReason(error: unknown): string | undefined {
  if (error instanceof RealtimePollError) return error.reason;
  if (error instanceof RealtimeEnqueueError) return "enqueue_failed";
  if (error instanceof RealtimeAuthorizationError) return undefined;
  return "state_read_failed";
}

function boundedRealtimeInteger(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function boundedRealtimeDuration(value: string | undefined, maximum: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? Math.min(parsed, maximum) : 0;
}
