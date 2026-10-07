import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { AuditEvent, StoreState, User } from "../domain/models";
import { hashPassword } from "../security/password";
import { assertRuntimeSchemaReady } from "./migrations";

export interface ProductionBootstrapInput {
  readonly email: string;
  readonly displayName: string;
  readonly password: string;
  readonly departmentCode?: string;
  readonly timezone?: string;
}

const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const DEPARTMENT_PATTERN = /^[A-Z0-9_-]{1,60}$/;
const PLACEHOLDER_PATTERN = /(replace|configure|change[-_ ]?me|example|senha)/i;

function validatedInput(input: ProductionBootstrapInput): Required<ProductionBootstrapInput> {
  const email = input.email?.trim().toLowerCase() ?? "";
  if (!EMAIL_PATTERN.test(email)) throw new Error("BOOTSTRAP_ADMIN_EMAIL inválido.");
  const displayName = input.displayName?.trim() ?? "";
  if (displayName.length < 1 || displayName.length > 160) throw new Error("BOOTSTRAP_ADMIN_NAME deve ter entre 1 e 160 caracteres.");
  const password = input.password ?? "";
  const length = Array.from(password).length;
  // Stricter than the managed-user rule: this account is the root of trust.
  if (length < 16 || length > 200 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password) || PLACEHOLDER_PATTERN.test(password)) {
    throw new Error("BOOTSTRAP_ADMIN_PASSWORD deve ter pelo menos 16 caracteres, letras e números, e não pode ser um placeholder.");
  }
  const departmentCode = (input.departmentCode?.trim() || "IT").toUpperCase();
  if (!DEPARTMENT_PATTERN.test(departmentCode)) throw new Error("BOOTSTRAP_ADMIN_DEPARTMENT inválido.");
  const timezone = input.timezone?.trim() || "America/Sao_Paulo";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new Error("BOOTSTRAP_ADMIN_TIMEZONE inválido.");
  }
  return { email, displayName, password, departmentCode, timezone };
}

/**
 * Builds the first production state: no clinical data, no synthetic catalog,
 * and a single ADMIN who provisions everything else through the audited API.
 */
export function createProductionBootstrapState(input: ProductionBootstrapInput, now = new Date()): StoreState {
  const validated = validatedInput(input);
  const occurredAt = now.toISOString();
  const admin: User = {
    id: `user-${randomUUID()}`,
    email: validated.email,
    displayName: validated.displayName,
    role: "ADMIN",
    departmentCode: validated.departmentCode,
    passwordHash: hashPassword(validated.password),
    timezone: validated.timezone,
    patientIds: [],
    serviceCodes: [],
    active: true,
    createdAt: occurredAt,
    version: 1
  };
  const audit: AuditEvent = {
    id: `audit-${randomUUID()}`,
    eventType: "ProductionBootstrap",
    entityType: "User",
    entityId: admin.id,
    newState: "ACTIVE",
    correlationId: `corr_bootstrap_${randomUUID()}`,
    metadata: { role: admin.role, departmentCode: admin.departmentCode },
    occurredAt
  };
  return {
    users: [admin],
    sessions: [],
    patients: [],
    encounters: [],
    admissions: [],
    services: [],
    reasonCodes: [],
    requests: [],
    items: [],
    samples: [],
    procedures: [],
    schedules: [],
    results: [],
    resultVersions: [],
    notifications: [],
    auditEvents: [audit],
    outbox: [],
    idempotency: [],
    attachments: [],
    protocolSequence: 1
  };
}

export class ProductionBootstrapAlreadyInitializedError extends Error {
  constructor() {
    super("BOOTSTRAP_ALREADY_INITIALIZED: o estado de runtime já existe; nenhum dado foi alterado.");
  }
}

/**
 * Inserts the first runtime state row. It never overwrites: an existing row
 * aborts the transaction, so re-running the command is always safe.
 */
export async function bootstrapProductionDatabase(connectionString: string, input: ProductionBootstrapInput): Promise<{ adminId: string }> {
  const state = createProductionBootstrapState(input);
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      try {
        const inserted = await client.query(
          "INSERT INTO cvg_runtime_state (id, state) VALUES (1, $1::jsonb) ON CONFLICT (id) DO NOTHING RETURNING id",
          [JSON.stringify({ ...state, auditEvents: [] })]
        );
        if (inserted.rowCount !== 1) throw new ProductionBootstrapAlreadyInitializedError();
        for (const event of state.auditEvents) {
          await client.query(
            "INSERT INTO audit_events (id, event_type, actor_id, entity_type, entity_id, previous_state, new_state, correlation_id, metadata, occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)",
            [event.id, event.eventType, event.actorId ?? null, event.entityType, event.entityId, event.previousState ?? null, event.newState ?? null, event.correlationId, JSON.stringify(event.metadata), event.occurredAt]
          );
        }
        // Runs inside the transaction so a stale schema or a malformed payload
        // rolls the insert back instead of leaving a half-initialized database.
        await assertRuntimeSchemaReady({ query: (text, values) => client.query(text, values) });
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
  return { adminId: state.users[0].id };
}
