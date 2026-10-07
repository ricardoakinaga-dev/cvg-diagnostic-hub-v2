import { randomUUID } from "node:crypto";
import type { StoreState } from "../domain/models";

export type DatabaseOperationAuthorization =
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

export function assertAdministrativeResetAuthorized(
  connectionString: string,
  authorization: "ALLOW_SYNTHETIC_SEED" | "ALLOW_DB_SMOKE_RESET" | undefined
): AuthorizedAdministrativeResetTarget {
  return assertDatabaseOperationAuthorized(
    connectionString,
    authorization,
    ADMINISTRATIVE_RESET_AUTHORIZATIONS,
    {
      forbiddenInProduction: "POSTGRES_ADMIN_RESET_FORBIDDEN_IN_PRODUCTION",
      requiresAuthorization: "POSTGRES_ADMIN_RESET_REQUIRES_AUTHORIZATION",
      targetNotAllowed: "POSTGRES_ADMIN_RESET_TARGET_NOT_ALLOWED"
    }
  );
}

export function assertInitializationAuthorized(
  connectionString: string,
  authorization: DatabaseOperationAuthorization | undefined
): void {
  assertDatabaseOperationAuthorized(
    connectionString,
    authorization,
    INITIALIZATION_AUTHORIZATIONS,
    {
      forbiddenInProduction: "POSTGRES_INITIALIZATION_FORBIDDEN_IN_PRODUCTION",
      requiresAuthorization: "POSTGRES_INITIALIZATION_REQUIRES_AUTHORIZATION",
      targetNotAllowed: "POSTGRES_INITIALIZATION_TARGET_NOT_ALLOWED"
    }
  );
}

export function administrativeResetAuditEvent(
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

export function stateForAdministrativeReset(
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
