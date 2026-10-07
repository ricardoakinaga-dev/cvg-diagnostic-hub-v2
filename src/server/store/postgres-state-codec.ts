import type { StoreState } from "../domain/models";

/**
 * Codec for the transitional JSONB aggregate: the row is one JSONB document,
 * so every read validates its shape and every write re-validates the
 * append-only audit prefix. Keeping this in one module makes the invariants
 * reviewable without wading through the store's transaction mechanics.
 */
export const CURRENT_STATE_SQL = "SELECT state, version FROM cvg_runtime_state WHERE id = 1";
export const CURRENT_VERSION_SQL = "SELECT version FROM cvg_runtime_state WHERE id = 1";
export const LOCKED_STATE_SQL = `${CURRENT_STATE_SQL} FOR UPDATE`;

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

export function cloneState(state: StoreState): StoreState {
  return structuredClone(state);
}

export function stateFromRow(value: unknown): StoreState {
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

export function versionFromRow(value: unknown): number {
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

export function runtimeStateFromRow(row: { state: unknown; version: unknown } | undefined): StoreState {
  if (!row) throw new Error("PostgreSQL runtime state row is missing.");
  versionFromRow(row.version);
  return stateFromRow(row.state);
}

export function assertAuditEventsAppendOnly(before: StoreState, after: StoreState): void {
  const eventsById = new Map(after.auditEvents.map((event) => [event.id, event]));
  if (eventsById.size !== after.auditEvents.length || after.auditEvents.length < before.auditEvents.length) {
    throw new Error("POSTGRES_AUDIT_LOG_MUTATION");
  }
  for (const [index, previousEvent] of before.auditEvents.entries()) {
    const currentEvent = after.auditEvents[index];
    if (!currentEvent || currentEvent.id !== previousEvent.id || JSON.stringify(currentEvent) !== JSON.stringify(previousEvent)) {
      throw new Error("POSTGRES_AUDIT_LOG_MUTATION");
    }
  }
}
