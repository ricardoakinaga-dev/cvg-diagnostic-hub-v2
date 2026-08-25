import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import type { StateStore, StoreState } from "../domain/models";
import { assertRuntimeSchemaReady } from "./migrations";

const CURRENT_STATE_SQL = "SELECT state, version FROM cvg_runtime_state WHERE id = 1";
const LOCKED_STATE_SQL = `${CURRENT_STATE_SQL} FOR UPDATE`;
type DatabaseOperationAuthorization =
  | "ALLOW_SYNTHETIC_SEED"
  | "ALLOW_DB_SMOKE_RESET"
  | "ALLOW_POSTGRES_INTEGRATION_TESTS";

const ADMINISTRATIVE_RESET_AUTHORIZATIONS: ReadonlySet<DatabaseOperationAuthorization> = new Set([
  "ALLOW_SYNTHETIC_SEED",
  "ALLOW_DB_SMOKE_RESET"
]);
const INITIALIZATION_AUTHORIZATIONS: ReadonlySet<DatabaseOperationAuthorization> = new Set([
  "ALLOW_SYNTHETIC_SEED",
  "ALLOW_DB_SMOKE_RESET",
  "ALLOW_POSTGRES_INTEGRATION_TESTS"
]);
const LOOPBACK_DATABASE_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const STATE_COLLECTIONS = [
  "users",
  "sessions",
  "patients",
  "encounters",
  "admissions",
  "services",
  "reasonCodes",
  "requests",
  "items",
  "samples",
  "procedures",
  "schedules",
  "results",
  "resultVersions",
  "notifications",
  "auditEvents",
  "outbox",
  "idempotency",
  "attachments"
] as const satisfies readonly (keyof StoreState)[];

export interface PostgresAdministrativeResetOptions {
  authorization: "ALLOW_SYNTHETIC_SEED" | "ALLOW_DB_SMOKE_RESET";
}

export interface PostgresInitializationOptions {
  authorization: DatabaseOperationAuthorization;
}

interface AuthorizedAdministrativeResetTarget {
  authorization: DatabaseOperationAuthorization;
  databaseHost: string;
  databaseName: string;
}

interface DatabaseAuthorizationErrors {
  forbiddenInProduction: string;
  requiresAuthorization: string;
  targetNotAllowed: string;
}

function cloneState(state: StoreState): StoreState {
  return structuredClone(state);
}

function stateFromRow(value: unknown): StoreState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("PostgreSQL runtime state is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  if (!Number.isSafeInteger(candidate.protocolSequence) || Number(candidate.protocolSequence) < 0) {
    throw new Error("PostgreSQL runtime state protocol sequence is invalid.");
  }
  if (STATE_COLLECTIONS.some((key) => !Array.isArray(candidate[key]))) {
    throw new Error("PostgreSQL runtime state collections are invalid.");
  }
  return cloneState(candidate as unknown as StoreState);
}

function versionFromRow(value: unknown): number {
  const numeric = typeof value === "bigint"
    ? Number(value)
    : typeof value === "string" && /^\d+$/.test(value)
      ? Number(value)
      : value;
  if (!Number.isSafeInteger(numeric) || Number(numeric) < 1) {
    throw new Error("PostgreSQL runtime state version is invalid.");
  }
  return Number(numeric);
}

function runtimeStateFromRow(row: { state: unknown; version: unknown } | undefined): StoreState {
  if (!row) throw new Error("PostgreSQL runtime state row is missing.");
  versionFromRow(row.version);
  return stateFromRow(row.state);
}

function assertAuditEventsAppendOnly(before: StoreState, after: StoreState): void {
  const eventsById = new Map(after.auditEvents.map((event) => [event.id, event]));
  if (eventsById.size !== after.auditEvents.length || after.auditEvents.length < before.auditEvents.length) {
    throw new Error("POSTGRES_AUDIT_LOG_MUTATION");
  }
  for (const previousEvent of before.auditEvents) {
    const currentEvent = eventsById.get(previousEvent.id);
    if (!currentEvent || JSON.stringify(currentEvent) !== JSON.stringify(previousEvent)) {
      throw new Error("POSTGRES_AUDIT_LOG_MUTATION");
    }
  }
}

function assertDatabaseOperationAuthorized(
  connectionString: string,
  authorization: DatabaseOperationAuthorization | undefined,
  allowedAuthorizations: ReadonlySet<DatabaseOperationAuthorization>,
  errors: DatabaseAuthorizationErrors
): AuthorizedAdministrativeResetTarget {
  if (!authorization || !allowedAuthorizations.has(authorization)) {
    throw new Error(errors.requiresAuthorization);
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(errors.forbiddenInProduction);
  }
  if (process.env[authorization] !== "true") {
    throw new Error(errors.requiresAuthorization);
  }

  let databaseUrl: URL;
  try {
    databaseUrl = new URL(connectionString);
  } catch {
    throw new Error(errors.targetNotAllowed);
  }
  const databaseName = decodeURIComponent(databaseUrl.pathname.replace(/^\//, ""));
  const databaseNamePattern = authorization === "ALLOW_SYNTHETIC_SEED"
    ? /^cvg_(?:diagnostics|seed|synthetic|test)(?:[a-z0-9_-]*)$/i
    : authorization === "ALLOW_DB_SMOKE_RESET"
      ? /^cvg_(?:smoke|test)(?:[a-z0-9_-]*)$/i
      : /^cvg_test_[1-9][0-9]*_[a-f0-9]{32}$/;
  if (
    !["postgres:", "postgresql:"].includes(databaseUrl.protocol)
    || !LOOPBACK_DATABASE_HOSTS.has(databaseUrl.hostname.toLowerCase())
    || !databaseNamePattern.test(databaseName)
  ) {
    throw new Error(errors.targetNotAllowed);
  }
  return {
    authorization,
    databaseHost: databaseUrl.hostname.toLowerCase(),
    databaseName
  };
}

function assertAdministrativeResetAuthorized(
  connectionString: string,
  options: PostgresAdministrativeResetOptions | undefined
): AuthorizedAdministrativeResetTarget {
  return assertDatabaseOperationAuthorized(
    connectionString,
    options?.authorization,
    ADMINISTRATIVE_RESET_AUTHORIZATIONS,
    {
      forbiddenInProduction: "POSTGRES_ADMIN_RESET_FORBIDDEN_IN_PRODUCTION",
      requiresAuthorization: "POSTGRES_ADMIN_RESET_REQUIRES_AUTHORIZATION",
      targetNotAllowed: "POSTGRES_ADMIN_RESET_TARGET_NOT_ALLOWED"
    }
  );
}

function assertInitializationAuthorized(
  connectionString: string,
  options: PostgresInitializationOptions | undefined
): void {
  assertDatabaseOperationAuthorized(
    connectionString,
    options?.authorization,
    INITIALIZATION_AUTHORIZATIONS,
    {
      forbiddenInProduction: "POSTGRES_INITIALIZATION_FORBIDDEN_IN_PRODUCTION",
      requiresAuthorization: "POSTGRES_INITIALIZATION_REQUIRES_AUTHORIZATION",
      targetNotAllowed: "POSTGRES_INITIALIZATION_TARGET_NOT_ALLOWED"
    }
  );
}

function administrativeResetAuditEvent(
  target: AuthorizedAdministrativeResetTarget
): StoreState["auditEvents"][number] {
  return {
    id: `audit-postgres-reset-${randomUUID()}`,
    eventType: "PostgresAdministrativeReset",
    entityType: "RuntimeState",
    entityId: "cvg-runtime-state",
    previousState: "ACTIVE",
    newState: "RESET",
    correlationId: `corr-postgres-reset-${randomUUID()}`,
    metadata: {
      authorization: target.authorization,
      databaseHost: target.databaseHost,
      databaseName: target.databaseName
    },
    occurredAt: new Date().toISOString()
  };
}

function stateForAdministrativeReset(
  before: StoreState,
  target: StoreState,
  resetAuditEvent: StoreState["auditEvents"][number]
): StoreState {
  const targetAuditEventsById = new Map(target.auditEvents.map((event) => [event.id, event]));
  if (targetAuditEventsById.size !== target.auditEvents.length) {
    throw new Error("POSTGRES_AUDIT_LOG_MUTATION");
  }
  const previousAuditEventsById = new Map(before.auditEvents.map((event) => [event.id, event]));
  for (const previousEvent of before.auditEvents) {
    const targetEvent = targetAuditEventsById.get(previousEvent.id);
    if (targetEvent && JSON.stringify(targetEvent) !== JSON.stringify(previousEvent)) {
      throw new Error("POSTGRES_AUDIT_LOG_MUTATION");
    }
  }
  return {
    ...target,
    auditEvents: [
      ...before.auditEvents,
      ...target.auditEvents.filter((event) => !previousAuditEventsById.has(event.id)),
      resetAuditEvent
    ]
  };
}

export class PostgresStore implements StateStore {
  private readonly pool: Pool;
  private readonly connectionString: string;
  private state: StoreState;
  private queue: Promise<unknown> = Promise.resolve();
  private isClosing = false;
  private closePromise?: Promise<void>;

  private constructor(pool: Pool, connectionString: string, state: StoreState) {
    this.pool = pool;
    this.connectionString = connectionString;
    this.state = cloneState(state);
  }

  static create(connectionString: string): Promise<PostgresStore>;
  static create(
    connectionString: string,
    fallbackState: StoreState,
    initialization: PostgresInitializationOptions
  ): Promise<PostgresStore>;
  static async create(
    connectionString: string,
    fallbackState?: StoreState,
    initialization?: PostgresInitializationOptions
  ): Promise<PostgresStore> {
    const pool = new Pool({ connectionString, max: Number(process.env.DB_POOL_MAX ?? 10), idleTimeoutMillis: 30_000 });
    if (typeof pool.on === "function") {
      pool.on("error", () => {
        // Idle-client failures are surfaced by the next readiness/transaction call;
        // keep them from becoming process-level unhandled errors during failover.
      });
    }
    try {
      const result = await pool.query<{ state: unknown; version: unknown }>(CURRENT_STATE_SQL);
      let initialState: StoreState;
      if (result.rowCount === 0) {
        if (!fallbackState) throw new Error("PostgreSQL runtime state row is missing. Execute the explicit synthetic seed when appropriate.");
        assertInitializationAuthorized(connectionString, initialization);
        const validatedFallbackState = stateFromRow(fallbackState);
        await pool.query(
          "INSERT INTO cvg_runtime_state (id, state) VALUES (1, $1::jsonb) ON CONFLICT (id) DO NOTHING",
          [JSON.stringify(validatedFallbackState)]
        );
        const seeded = await pool.query<{ state: unknown; version: unknown }>(CURRENT_STATE_SQL);
        if (seeded.rowCount !== 1) throw new Error("PostgreSQL runtime state row is missing after seed initialization.");
        initialState = runtimeStateFromRow(seeded.rows[0]);
      } else {
        if (result.rowCount !== 1) throw new Error("PostgreSQL runtime state cardinality is invalid.");
        initialState = runtimeStateFromRow(result.rows[0]);
      }
      await assertRuntimeSchemaReady({ query: (text, values) => pool.query(text, values) });
      return new PostgresStore(pool, connectionString, initialState);
    } catch (error) {
      await pool.end();
      throw new Error(`Não foi possível abrir o estado PostgreSQL. Execute npm run db:migrate antes de iniciar. ${(error as Error).message}`);
    }
  }

  getState(): StoreState {
    return cloneState(this.state);
  }

  async readState(): Promise<StoreState> {
    return this.enqueue(async () => {
      const result = await this.pool.query<{ state: unknown; version: unknown }>(CURRENT_STATE_SQL);
      if (result.rowCount !== 1) throw new Error("PostgreSQL runtime state row is missing.");
      const currentState = runtimeStateFromRow(result.rows[0]);
      this.state = cloneState(currentState);
      return cloneState(currentState);
    });
  }

  async transaction<T>(operation: (state: StoreState) => Promise<{ state: StoreState; result: T }> | { state: StoreState; result: T }): Promise<T> {
    return this.runTransaction(operation);
  }

  async reset(state: StoreState, options?: PostgresAdministrativeResetOptions): Promise<void> {
    const authorizedTarget = assertAdministrativeResetAuthorized(this.connectionString, options);
    const target = stateFromRow(state);
    await this.runTransaction((current) => ({
      state: stateForAdministrativeReset(current, target, administrativeResetAuditEvent(authorizedTarget)),
      result: undefined
    }), { replaceOutboxProjection: true });
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.isClosing = true;
    const pendingWork = this.queue;
    this.closePromise = (async () => {
      await pendingWork;
      await this.pool.end();
    })();
    return this.closePromise;
  }

  async healthcheck(): Promise<void> {
    await this.enqueue(async () => {
      await assertRuntimeSchemaReady({ query: (text, values) => this.pool.query(text, values) });
    });
  }

  private async runTransaction<T>(
    operation: (state: StoreState) => Promise<{ state: StoreState; result: T }> | { state: StoreState; result: T },
    options: { replaceOutboxProjection?: boolean } = {}
  ): Promise<T> {
    return this.enqueue(async () => {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const locked = await client.query<{ state: unknown; version: unknown }>(LOCKED_STATE_SQL);
        if (locked.rowCount !== 1) throw new Error("PostgreSQL runtime state row is missing.");
        const currentState = runtimeStateFromRow(locked.rows[0]);
        const outcome = await operation(currentState);
        const nextState = stateFromRow(outcome.state);
        assertAuditEventsAppendOnly(currentState, nextState);
        const updated = await client.query<{ version: unknown }>(
          "UPDATE cvg_runtime_state SET state = $1::jsonb, version = version + 1, updated_at = now() WHERE id = 1 RETURNING version",
          [JSON.stringify(nextState)]
        );
        if (updated.rowCount !== 1) throw new Error("PostgreSQL runtime state update failed.");
        versionFromRow(updated.rows[0]?.version);
        const projectionBefore = options.replaceOutboxProjection
          ? { ...currentState, outbox: [] }
          : currentState;
        if (options.replaceOutboxProjection) {
          await client.query("DELETE FROM outbox_messages");
        }
        await this.projectCommittedEvents(client, projectionBefore, nextState);
        await client.query("COMMIT");
        this.state = cloneState(nextState);
        return outcome.result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    });
  }

  private enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
    if (this.isClosing) return Promise.reject(new Error("PostgreSQL store is closing or closed."));
    const run = this.queue.then(operation);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async projectCommittedEvents(client: PoolClient, before: StoreState, after: StoreState): Promise<void> {
    const previousAuditIds = new Set(before.auditEvents.map((event) => event.id));
    for (const event of after.auditEvents.filter((entry) => !previousAuditIds.has(entry.id))) {
      const inserted = await client.query(
        "INSERT INTO audit_events (id, event_type, actor_id, entity_type, entity_id, previous_state, new_state, correlation_id, metadata, occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) ON CONFLICT (id) DO NOTHING RETURNING id",
        [event.id, event.eventType, event.actorId ?? null, event.entityType, event.entityId, event.previousState ?? null, event.newState ?? null, event.correlationId, JSON.stringify(event.metadata), event.occurredAt]
      );
      if (inserted.rowCount !== 1) throw new Error(`POSTGRES_AUDIT_PROJECTION_DIVERGED:${event.id}`);
    }
    const previousOutbox = new Map(before.outbox.map((event) => [event.id, event]));
    for (const message of after.outbox.filter((entry) => !previousOutbox.has(entry.id))) {
      const inserted = await client.query(
        "INSERT INTO outbox_messages (id, event_type, aggregate_type, aggregate_id, payload, status, attempts, available_at, correlation_id, locked_at, worker_id, claim_token, last_error) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (id) DO NOTHING RETURNING id",
        [message.id, message.eventType, message.aggregateType, message.aggregateId, JSON.stringify(message.payload), message.status, message.attempts, message.availableAt, message.correlationId, message.lockedAt ?? null, message.workerId ?? null, message.claimToken ?? null, message.lastError ?? null]
      );
      if (inserted.rowCount !== 1) throw new Error(`POSTGRES_OUTBOX_PROJECTION_DIVERGED:${message.id}`);
    }
    for (const message of after.outbox) {
      const previous = previousOutbox.get(message.id);
      if (!previous || JSON.stringify(previous) === JSON.stringify(message)) continue;
      const updated = await client.query(
        "UPDATE outbox_messages SET status = $2, attempts = $3, available_at = $4, locked_at = $5, worker_id = $6, claim_token = $7, last_error = $8 WHERE id = $1",
        [message.id, message.status, message.attempts, message.availableAt, message.lockedAt ?? null, message.workerId ?? null, message.claimToken ?? null, message.lastError ?? null]
      );
      if (updated.rowCount !== 1) throw new Error(`POSTGRES_OUTBOX_PROJECTION_DIVERGED:${message.id}`);
    }
  }
}
