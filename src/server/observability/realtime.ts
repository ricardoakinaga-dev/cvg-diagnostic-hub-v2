import { Pool } from "pg";
import {
  configuredRealtimeNotificationAdapter,
  isPostgresConnectionString,
  realtimeNotificationChannel
} from "../domain/realtime-configuration";
export { assertRealtimeNotificationConfiguration } from "../domain/realtime-configuration";
export type { RealtimeNotificationAdapterName } from "../domain/realtime-configuration";

export type RealtimeNotificationScope = "process-local" | "multi-instance";

export interface RealtimeNotificationMessage {
  channel: string;
  payload?: string;
}

export interface RealtimeNotificationClient {
  query(text: string): Promise<unknown>;
  on(event: "notification", listener: (message: RealtimeNotificationMessage) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  release(): void;
}

export interface RealtimeNotificationPool {
  connect(): Promise<RealtimeNotificationClient>;
  query(text: string, values?: ReadonlyArray<unknown>): Promise<unknown>;
  end(): Promise<void>;
}

/**
 * A notification is only a wake-up hint. Consumers must reread durable state
 * and recheck authorization before sending anything to a client.
 *
 * The process-local adapter is the safe default for synthetic development;
 * PostgreSQL LISTEN/NOTIFY is opt-in for a real multi-instance deployment.
 */
export interface RealtimeNotificationAdapter {
  readonly name: string;
  readonly scope: RealtimeNotificationScope;
  subscribe(listener: () => void): () => void;
  notify(): void;
  close?(): Promise<void>;
}

class ProcessLocalRealtimeNotificationAdapter implements RealtimeNotificationAdapter {
  readonly name = "process-local";
  readonly scope = "process-local" as const;
  private readonly listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.listeners.delete(listener);
    };
  }

  notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // A wake-up listener must never make the committing request fail.
      }
    }
  }
}

const processLocalAdapter = new ProcessLocalRealtimeNotificationAdapter();

const POSTGRES_REALTIME_RETRY_MS = 5_000;

/**
 * PostgreSQL LISTEN/NOTIFY is deliberately only a wake-up channel. A
 * notification contains no clinical payload; every stream rereads the
 * durable outbox and rechecks authorization before enqueueing an event.
 */
export class PostgresListenRealtimeNotificationAdapter implements RealtimeNotificationAdapter {
  readonly name = "postgres-listen";
  readonly scope = "multi-instance" as const;
  private readonly listeners = new Set<() => void>();
  private listenerClient: RealtimeNotificationClient | undefined;
  private connectPromise: Promise<void> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(
    private readonly pool: RealtimeNotificationPool,
    private readonly channel: string
  ) {}

  subscribe(listener: () => void): () => void {
    if (this.closed) return () => undefined;
    this.listeners.add(listener);
    this.ensureListener();
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.listeners.delete(listener);
    };
  }

  notify(): void {
    if (this.closed) return;
    void this.pool.query("SELECT pg_notify($1, $2)", [this.channel, "mutation"]).catch(() => {
      // A wake-up failure never invalidates the committed transaction. The
      // stream's bounded durable polling remains the correctness fallback.
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    await this.connectPromise?.catch(() => undefined);
    this.releaseListener();
    await this.pool.end();
  }

  private ensureListener(): void {
    if (this.closed || this.listenerClient || this.connectPromise || this.listeners.size === 0) return;
    const connection = this.connectListener();
    this.connectPromise = connection;
    void connection.finally(() => {
      if (this.connectPromise === connection) this.connectPromise = undefined;
    }).catch(() => undefined);
  }

  private async connectListener(): Promise<void> {
    let client: RealtimeNotificationClient | undefined;
    try {
      client = await this.pool.connect();
      if (this.closed) {
        client.release();
        return;
      }
      const connectedClient = client;
      this.listenerClient = connectedClient;
      connectedClient.on("notification", (message) => {
        if (message.channel !== this.channel) return;
        for (const listener of [...this.listeners]) {
          try {
            listener();
          } catch {
            // One stream must never prevent another stream from waking.
          }
        }
      });
      connectedClient.on("error", () => this.handleListenerFailure(connectedClient));
      await connectedClient.query(`LISTEN ${quotePostgresIdentifier(this.channel)}`);
    } catch {
      if (client && this.listenerClient === client) this.releaseListener();
      else client?.release();
      this.scheduleRetry();
    }
  }

  private handleListenerFailure(client: RealtimeNotificationClient): void {
    if (this.listenerClient !== client || this.closed) return;
    this.releaseListener();
    this.scheduleRetry();
  }

  private releaseListener(): void {
    const client = this.listenerClient;
    this.listenerClient = undefined;
    client?.release();
  }

  private scheduleRetry(): void {
    if (this.closed || this.retryTimer || this.listeners.size === 0) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.ensureListener();
    }, POSTGRES_REALTIME_RETRY_MS);
    this.retryTimer.unref?.();
  }
}

function quotePostgresIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function postgresRealtimePool(environment: NodeJS.ProcessEnv): RealtimeNotificationPool | undefined {
  const databaseUrl = environment.DATABASE_URL?.trim();
  if (!isPostgresConnectionString(databaseUrl)) return undefined;
  const configuredMax = Number(environment.REALTIME_LISTEN_POOL_MAX);
  const max = Number.isSafeInteger(configuredMax) && configuredMax > 0 ? Math.min(configuredMax, 10) : 2;
  const pool = new Pool({ connectionString: databaseUrl, max, idleTimeoutMillis: 30_000 });
  pool.on("error", () => {
    // Listener/publisher failures are contained by the adapter; durable poll
    // and the next reconnect attempt remain authoritative.
  });
  return pool as unknown as RealtimeNotificationPool;
}

let postgresAdapterCache: { key: string; adapter: PostgresListenRealtimeNotificationAdapter } | undefined;

/**
 * `REALTIME_NOTIFICATION_ADAPTER=postgres-listen` enables a real
 * LISTEN/NOTIFY wake-up when a valid PostgreSQL URL is configured. Values
 * other than the two supported adapters select no adapter. Polling remains
 * the durable fallback even when the wake-up connection is unavailable.
 */
export function getRealtimeNotificationAdapter(environment: NodeJS.ProcessEnv = process.env): RealtimeNotificationAdapter | undefined {
  const configured = configuredRealtimeNotificationAdapter(environment);
  if (configured === "process-local") {
    if (environment.NODE_ENV === "production") return undefined;
    return processLocalAdapter;
  }
  if (configured !== "postgres-listen") return undefined;
  const databaseUrl = environment.DATABASE_URL?.trim();
  const channel = realtimeNotificationChannel(environment);
  if (!databaseUrl || !channel) return undefined;
  const key = `${databaseUrl}\u0000${channel}\u0000${environment.REALTIME_LISTEN_POOL_MAX ?? ""}`;
  if (postgresAdapterCache?.key === key) return postgresAdapterCache.adapter;
  const pool = postgresRealtimePool(environment);
  if (!pool) return undefined;
  const adapter = new PostgresListenRealtimeNotificationAdapter(pool, channel);
  postgresAdapterCache = { key, adapter };
  return adapter;
}

export function notifyRealtimeMutation(environment: NodeJS.ProcessEnv = process.env): void {
  getRealtimeNotificationAdapter(environment)?.notify();
}

export async function closeRealtimeNotificationAdapter(): Promise<void> {
  const cached = postgresAdapterCache;
  postgresAdapterCache = undefined;
  if (cached) await cached.adapter.close?.();
}
