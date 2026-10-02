import { copyFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import type { DiagnosticItem, DiagnosticRequest, Sample, StoreState } from "../../src/server/domain/models";
import { createDemoState } from "../../src/server/store/fixtures";
import {
  applyMigrations,
  LATEST_RUNTIME_SCHEMA_VERSION,
  RUNTIME_MIGRATION_CHECKSUMS,
  RUNTIME_MIGRATION_VERSIONS,
  type MigrationRunResult,
  type SqlQueryable
} from "../../src/server/store/migrations";
import { RelationalClinicalCoreAdapter } from "../../src/server/store/relational/clinical-core-adapter";
import { assertReconciliationClean, reconcileRelationalRequest } from "../../src/server/store/relational/cutover";
import { withDisposablePostgresDatabase, type DisposablePostgresDatabase } from "../support/postgres-test-harness";

const MIGRATION_DIRECTORY = path.resolve(process.cwd(), "db/migrations");
const TEST_PASSWORD = "aaa3-migration-upgrade-synthetic-password";
const REQUEST_ID = "request-aaa3-upgrade";
const ITEM_IDS = ["item-aaa3-upgrade-a", "item-aaa3-upgrade-b"] as const;
const ORIGINAL_SAMPLE_ID = "sample-aaa3-upgrade-original";
const REPLACEMENT_SAMPLE_ID = "sample-aaa3-upgrade-replacement";
const ORIGINAL_ACCESSION = "AAA3-UPGRADE-001";
const REPLACEMENT_ACCESSION = "AAA3-UPGRADE-002";
const REQUESTED_AT = "2026-09-07T10:00:00.000Z";
const RECEIVED_AT = "2026-09-07T10:30:00.000Z";

type UpgradeQuery = (
  text: string,
  values?: readonly unknown[]
) => Promise<{ readonly rows: readonly Record<string, unknown>[]; readonly rowCount: number | null }>;

interface UpgradeProbe {
  readonly schema: string;
  readonly client: PoolClient;
  readonly query: UpgradeQuery;
  readonly sql: SqlQueryable;
  applySubset(versions: readonly string[]): Promise<MigrationRunResult>;
  applyProductionMigrations(): Promise<MigrationRunResult>;
}

type InvalidLegacyCase = "accession" | "replacement" | "link-status";

function quoteIdentifier(identifier: string): string {
  if (!/^aaa3_upgrade_[0-9]+_[a-f0-9]+$/.test(identifier)) {
    throw new Error(`Unexpected migration probe identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function sourceState(): StoreState {
  const base = createDemoState(TEST_PASSWORD);
  const request: DiagnosticRequest = {
    id: REQUEST_ID,
    requestCode: "AAA3-UPG-001",
    patientId: "patient-thor",
    encounterId: "encounter-thor",
    requesterId: "user-vet",
    requestingDepartmentCode: "INPATIENT",
    priority: "ROUTINE",
    aggregateStatus: "IN_PROGRESS",
    itemIds: [...ITEM_IDS],
    createdAt: REQUESTED_AT,
    updatedAt: RECEIVED_AT,
    version: 1
  };
  const items: DiagnosticItem[] = ITEM_IDS.map((id, index) => ({
    id,
    requestId: REQUEST_ID,
    serviceId: "service-hemogram",
    departmentCode: "LABORATORY",
    workflowType: "LABORATORY",
    priority: "ROUTINE",
    status: "RECEIVED",
    requestedAt: REQUESTED_AT,
    receivedAt: RECEIVED_AT,
    slaStartedAt: REQUESTED_AT,
    dueAt: "2026-09-07T18:00:00.000Z",
    slaPolicyVersion: index + 1,
    currentSampleId: REPLACEMENT_SAMPLE_ID,
    version: 1
  }));
  const samples: Sample[] = [
    {
      id: ORIGINAL_SAMPLE_ID,
      requestId: REQUEST_ID,
      accessionCode: ORIGINAL_ACCESSION,
      sampleType: "EDTA",
      status: "REJECTED",
      rejectionCode: "HEMOLYZED",
      rejectionNote: "Synthetic migration fixture; no clinical interpretation.",
      itemIds: [...ITEM_IDS],
      collectedAt: REQUESTED_AT,
      receivedAt: RECEIVED_AT,
      receivedBy: "user-lab",
      version: 1
    },
    {
      id: REPLACEMENT_SAMPLE_ID,
      requestId: REQUEST_ID,
      accessionCode: REPLACEMENT_ACCESSION,
      sampleType: "EDTA",
      status: "REPLACED",
      replacesSampleId: ORIGINAL_SAMPLE_ID,
      rejectionCode: "HEMOLYZED",
      rejectionNote: "Synthetic migration fixture; no clinical interpretation.",
      itemIds: [...ITEM_IDS],
      collectedAt: RECEIVED_AT,
      receivedAt: RECEIVED_AT,
      receivedBy: "user-lab",
      version: 1
    }
  ];
  const auditEvent = {
    id: "audit-aaa3-upgrade-001",
    eventType: "SyntheticMigrationFixture",
    actorId: "user-lab",
    entityType: "REQUEST",
    entityId: REQUEST_ID,
    previousState: "",
    newState: "seeded",
    correlationId: "correlation-aaa3-upgrade-001",
    metadata: { purpose: "SAA-022", synthetic: true },
    occurredAt: RECEIVED_AT
  };
  const outboxMessage = {
    id: "outbox-aaa3-upgrade-001",
    eventType: "ResultReleased",
    aggregateType: "Request",
    aggregateId: REQUEST_ID,
    payload: { notificationId: "notification-aaa3-upgrade-001" },
    consumerType: "NOTIFICATION_DELIVERY" as const,
    routingKey: "notification.in_app",
    status: "PENDING" as const,
    attempts: 0,
    availableAt: RECEIVED_AT,
    correlationId: "correlation-aaa3-upgrade-001"
  };

  return {
    ...base,
    requests: [request],
    items,
    samples,
    auditEvents: [auditEvent],
    outbox: [outboxMessage],
    protocolSequence: 2
  };
}

async function createMigrationSubset(versions: readonly string[]): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cvg-aaa3-migration-upgrade-"));
  try {
    await Promise.all(versions.map(async (version) => {
      await copyFile(
        path.join(MIGRATION_DIRECTORY, `${version}.sql`),
        path.join(directory, `${version}.sql`)
      );
    }));
    return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function withUpgradeProbe<T>(
  database: DisposablePostgresDatabase,
  operation: (probe: UpgradeProbe) => Promise<T>
): Promise<T> {
  const schema = `aaa3_upgrade_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const quotedSchema = quoteIdentifier(schema);
  const pool = new Pool({ connectionString: database.connectionString(), max: 1 });
  const client = await pool.connect();
  const temporaryDirectories: string[] = [];

  try {
    await client.query(`CREATE SCHEMA ${quotedSchema}`);
    await client.query(`SET search_path TO ${quotedSchema}, public`);
    const query: UpgradeQuery = async (text, values = []) => {
      const result = await client.query(text, [...values]);
      return {
        rows: result.rows as readonly Record<string, unknown>[],
        rowCount: result.rowCount
      };
    };
    const sql: SqlQueryable = { query };
    const applySubset = async (versions: readonly string[]): Promise<MigrationRunResult> => {
      const directory = await createMigrationSubset(versions);
      temporaryDirectories.push(directory);
      return applyMigrations(sql, { migrationDirectory: directory, logger: { info: () => undefined } });
    };
    const probe: UpgradeProbe = {
      schema,
      client,
      query,
      sql,
      applySubset,
      applyProductionMigrations: () => applyMigrations(sql, {
        migrationDirectory: MIGRATION_DIRECTORY,
        logger: { info: () => undefined }
      })
    };
    return await operation(probe);
  } finally {
    client.release();
    await pool.end();
    for (const directory of temporaryDirectories) {
      await rm(directory, { recursive: true, force: true });
    }
    await database.query(`DROP SCHEMA ${quotedSchema} CASCADE`);
  }
}

async function seed001Baseline(probe: UpgradeProbe, state: StoreState): Promise<void> {
  await probe.query(
    "INSERT INTO cvg_runtime_state (id, state, version) VALUES (1, $1::jsonb, $2)",
    [JSON.stringify(state), 1]
  );
  const event = state.auditEvents[0];
  if (!event) throw new Error("Synthetic migration audit event is missing.");
  await probe.query(
    "INSERT INTO audit_events (id, event_type, actor_id, entity_type, entity_id, previous_state, new_state, correlation_id, metadata, occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)",
    [
      event.id,
      event.eventType,
      event.actorId,
      event.entityType,
      event.entityId,
      event.previousState,
      event.newState,
      event.correlationId,
      JSON.stringify(event.metadata),
      event.occurredAt
    ]
  );
  const outbox = state.outbox[0];
  if (!outbox) throw new Error("Synthetic migration outbox event is missing.");
  await probe.query(
    "INSERT INTO outbox_messages (id, event_type, aggregate_type, aggregate_id, payload, status, attempts, available_at, correlation_id) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)",
    [
      outbox.id,
      outbox.eventType,
      outbox.aggregateType,
      outbox.aggregateId,
      JSON.stringify(outbox.payload),
      outbox.status,
      outbox.attempts,
      outbox.availableAt,
      outbox.correlationId
    ]
  );
}

async function seed008RelationalRows(
  probe: UpgradeProbe,
  state: StoreState,
  invalidCase?: InvalidLegacyCase
): Promise<void> {
  const request = state.requests[0];
  const items = state.items;
  const original = state.samples.find((sample) => sample.id === ORIGINAL_SAMPLE_ID);
  const replacement = state.samples.find((sample) => sample.id === REPLACEMENT_SAMPLE_ID);
  if (!request || !original || !replacement || items.length !== ITEM_IDS.length) {
    throw new Error("Synthetic migration relational fixture is incomplete.");
  }

  await probe.query(
    "INSERT INTO departments (id, code, name, kind) VALUES ($1,$2,$3,$4)",
    ["INPATIENT", "INPATIENT", "Synthetic department", "CLINICAL"]
  );
  await probe.query(
    "INSERT INTO departments (id, code, name, kind) VALUES ($1,$2,$3,$4)",
    ["LABORATORY", "LABORATORY", "Synthetic laboratory", "DIAGNOSTICS"]
  );
  await probe.query(
    "INSERT INTO users (id, email, display_name, password_hash, timezone) VALUES ($1,$2,$3,$4,$5)",
    ["user-vet", "vet@aaa3.local", "Synthetic requester", "synthetic-hash", "UTC"]
  );
  await probe.query(
    "INSERT INTO users (id, email, display_name, password_hash, timezone) VALUES ($1,$2,$3,$4,$5)",
    ["user-lab", "lab@aaa3.local", "Synthetic laboratory user", "synthetic-hash", "UTC"]
  );
  await probe.query(
    "INSERT INTO patients (id, display_name, species, breed, sex, external_id) VALUES ($1,$2,$3,$4,$5,$6)",
    ["patient-thor", "Synthetic patient", "Canino", "SRD", "Não informado", "AAA3-PATIENT-001"]
  );
  await probe.query(
    "INSERT INTO encounters (id, patient_id, type, status, opened_at) VALUES ($1,$2,$3,$4,$5)",
    ["encounter-thor", "patient-thor", "INPATIENT", "OPEN", REQUESTED_AT]
  );
  await probe.query(
    "INSERT INTO diagnostic_services (id, code, name, category, department_id, workflow_type, requires_sample, result_schema) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    ["service-hemogram", "AAA3_HEMOGRAM", "Synthetic service", "LABORATORY", "LABORATORY", "LABORATORY", true, "NUMERIC_PANEL"]
  );
  await probe.query(
    "INSERT INTO reason_codes (id, type, code, label) VALUES ($1,$2,$3,$4)",
    ["reason-hemolyzed", "RECOLLECTION", "HEMOLYZED", "Synthetic rejection reason"]
  );
  await probe.query(
    "INSERT INTO diagnostic_requests (id, request_code, patient_id, encounter_id, requester_id, requesting_department_id, priority, aggregate_status, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
    [REQUEST_ID, request.requestCode, request.patientId, request.encounterId, request.requesterId, "INPATIENT", request.priority, request.aggregateStatus, request.createdAt, request.updatedAt]
  );
  for (const item of items) {
    await probe.query(
      "INSERT INTO diagnostic_request_items (id, request_id, service_id, department_id, workflow_type, priority, status, requested_at, received_at, sla_started_at, due_at, sla_policy_version, version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
      [item.id, item.requestId, item.serviceId, item.departmentCode, item.workflowType, item.priority, item.status, item.requestedAt, item.receivedAt, item.slaStartedAt, item.dueAt, item.slaPolicyVersion, item.version]
    );
  }

  const originalAccession = invalidCase === "accession" ? "bad" : original.accessionCode;
  const replacementReason = invalidCase === "replacement" ? null : "reason-hemolyzed";
  await probe.query(
    "INSERT INTO samples (id, request_id, accession_code, sample_type, status, rejection_reason_id, rejection_note, collected_at, received_at, received_by, version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
    [original.id, original.requestId, originalAccession, original.sampleType, original.status, "reason-hemolyzed", original.rejectionNote, original.collectedAt, original.receivedAt, original.receivedBy, original.version]
  );
  await probe.query(
    "INSERT INTO samples (id, request_id, accession_code, sample_type, status, replaces_sample_id, rejection_reason_id, rejection_note, collected_at, received_at, received_by, version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
    [replacement.id, replacement.requestId, replacement.accessionCode, replacement.sampleType, replacement.status, replacement.replacesSampleId, replacementReason, replacement.rejectionNote, replacement.collectedAt, replacement.receivedAt, replacement.receivedBy, replacement.version]
  );
  for (const sample of [original, replacement]) {
    for (const itemId of ITEM_IDS) {
      const linkStatus = invalidCase === "link-status" && sample.id === REPLACEMENT_SAMPLE_ID && itemId === ITEM_IDS[0]
        ? "UNKNOWN"
        : sample.status === "REPLACED" ? "REPLACED" : "REJECTED";
      await probe.query(
        "INSERT INTO sample_item_links (id, sample_id, item_id, request_id, link_status, linked_at, linked_by, rejection_note, version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [`sample-item-link:${sample.id}:${itemId}`, sample.id, itemId, sample.requestId, linkStatus, RECEIVED_AT, "user-lab", sample.rejectionNote ?? null, sample.version]
      );
    }
  }
  await probe.query(
    "UPDATE diagnostic_request_items SET current_sample_id = $2 WHERE id = ANY($1::text[])",
    [[...ITEM_IDS], REPLACEMENT_SAMPLE_ID]
  );
}

async function prepare001To008(
  probe: UpgradeProbe,
  state: StoreState,
  invalidCase?: InvalidLegacyCase
): Promise<void> {
  await probe.applySubset(["001_initial"]);
  await seed001Baseline(probe, state);
  await probe.applySubset(RUNTIME_MIGRATION_VERSIONS.slice(0, 8));
  await seed008RelationalRows(probe, state, invalidCase);
}

async function schemaMigrationVersions(probe: UpgradeProbe): Promise<readonly string[]> {
  const result = await probe.query("SELECT version FROM schema_migrations ORDER BY version");
  return result.rows.map((row) => String(row.version));
}

async function validMigrationProbe(
  database: DisposablePostgresDatabase,
  operation: (probe: UpgradeProbe, state: StoreState) => Promise<void>
): Promise<void> {
  await withUpgradeProbe(database, async (probe) => {
    const state = sourceState();
    await prepare001To008(probe, state);
    await operation(probe, state);
  });
}

describe("SAA-022 relational migration upgrade safety on disposable PostgreSQL", () => {
  it("upgrades a populated 001 baseline to 011, preserves valid rows, repairs membership losslessly, and retries by checksum", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      await validMigrationProbe(database, async (probe, state) => {
        const beforeState = (await probe.query("SELECT state FROM cvg_runtime_state WHERE id = 1")).rows[0]?.state;
        const result = await probe.applyProductionMigrations();
        expect(result.applied).toEqual([...RUNTIME_MIGRATION_VERSIONS.slice(8)]);
        expect(await schemaMigrationVersions(probe)).toEqual([...RUNTIME_MIGRATION_VERSIONS]);

        const ledger = await probe.query("SELECT version, checksum FROM schema_migrations ORDER BY version");
        expect(ledger.rows).toEqual(RUNTIME_MIGRATION_VERSIONS.map((version) => ({
          version,
          checksum: RUNTIME_MIGRATION_CHECKSUMS[version]
        })));

        const validRows = await probe.query(
          "SELECT (SELECT count(*) FROM diagnostic_requests)::int AS requests, (SELECT count(*) FROM diagnostic_request_items)::int AS items, (SELECT count(*) FROM samples)::int AS samples, (SELECT count(*) FROM sample_item_links)::int AS links"
        );
        expect(validRows.rows).toEqual([{ requests: 1, items: 2, samples: 2, links: 4 }]);
        expect(await probe.query("SELECT item_ids FROM samples ORDER BY id")).toEqual({
          rows: [{ item_ids: [...ITEM_IDS] }, { item_ids: [...ITEM_IDS] }],
          rowCount: 2
        });
        expect(await probe.query("SELECT consumer_type, routing_key FROM outbox_messages")).toEqual({
          rows: [{ consumer_type: "NOTIFICATION_DELIVERY", routing_key: "notification.in_app" }],
          rowCount: 1
        });
        expect(await probe.query("SELECT schema_version FROM relational_schema_markers")).toEqual({
          rows: [{ schema_version: LATEST_RUNTIME_SCHEMA_VERSION }],
          rowCount: 1
        });
        expect((await probe.query("SELECT state FROM cvg_runtime_state WHERE id = 1")).rows[0]?.state).toEqual(beforeState);

        const adapter = new RelationalClinicalCoreAdapter();
        await expect(adapter.assertReady(probe.sql)).resolves.toBeUndefined();
        const relational = await adapter.readRequest(probe.sql, REQUEST_ID);
        const reconciliation = reconcileRelationalRequest(state, REQUEST_ID, relational);
        expect(reconciliation.mismatches).toEqual([]);
        expect(() => assertReconciliationClean(reconciliation)).not.toThrow();

        await probe.query("ALTER TABLE samples DROP CONSTRAINT samples_item_ids_nonempty");
        await probe.query("UPDATE samples SET item_ids = ARRAY[]::text[] WHERE id = $1", [ORIGINAL_SAMPLE_ID]);
        await probe.query("ALTER TABLE samples ADD CONSTRAINT samples_item_ids_nonempty CHECK (cardinality(item_ids) > 0 AND array_position(item_ids, '') IS NULL) NOT VALID");
        await expect(adapter.assertReady(probe.sql)).rejects.toThrow("POSTGRES_RELATIONAL_CLINICAL_CORE_NOT_READY");
        await expect(adapter.assertReady(probe.sql, { allowUnvalidatedSampleMembership: true })).resolves.toBeUndefined();
        await adapter.repairSampleMembership(probe.sql, state);
        await adapter.validateSampleMembership(probe.sql);
        await expect(adapter.assertReady(probe.sql)).resolves.toBeUndefined();
        expect(await probe.query("SELECT item_ids FROM samples WHERE id = $1", [ORIGINAL_SAMPLE_ID])).toEqual({
          rows: [{ item_ids: [...ITEM_IDS] }],
          rowCount: 1
        });

        const duplicateAccessionState: StoreState = {
          ...state,
          samples: state.samples.map((sample) => sample.id === REPLACEMENT_SAMPLE_ID
            ? { ...sample, accessionCode: ORIGINAL_ACCESSION }
            : sample)
        };
        const rowCountBeforeDuplicate = await probe.query("SELECT count(*)::int AS count FROM samples");
        await expect(adapter.projectStateDelta(probe.sql, state, duplicateAccessionState)).rejects.toThrow(
          `POSTGRES_RELATIONAL_DUPLICATE_STATE_VALUE:samples.accession_code:${ORIGINAL_ACCESSION}`
        );
        expect(await probe.query("SELECT count(*)::int AS count FROM samples")).toEqual(rowCountBeforeDuplicate);

        await probe.query("DELETE FROM sample_item_links WHERE sample_id = $1 AND item_id = $2", [REPLACEMENT_SAMPLE_ID, ITEM_IDS[1]]);
        await expect(adapter.readRequest(probe.sql, REQUEST_ID)).rejects.toThrow(
          `POSTGRES_RELATIONAL_READ_LINEAGE_MISMATCH:${REPLACEMENT_SAMPLE_ID}:sample_item_links:${ITEM_IDS[1]}`
        );

        const retry = await probe.applyProductionMigrations();
        expect(retry).toEqual({ applied: [], alreadyApplied: [...RUNTIME_MIGRATION_VERSIONS] });

        await probe.query(
          "UPDATE schema_migrations SET checksum = $1 WHERE version = $2",
          ["0".repeat(64), "010_relational_backfill_control"]
        );
        await expect(probe.applyProductionMigrations()).rejects.toThrow("MIGRATION_CHECKSUM_MISMATCH:010_relational_backfill_control");
        await probe.query(
          "UPDATE schema_migrations SET checksum = $1 WHERE version = $2",
          [RUNTIME_MIGRATION_CHECKSUMS["010_relational_backfill_control"], "010_relational_backfill_control"]
        );
        await expect(probe.applyProductionMigrations()).resolves.toEqual({
          applied: [],
          alreadyApplied: [...RUNTIME_MIGRATION_VERSIONS]
        });
      });
    });
  }, 120_000);

  it("resumes after 009 is already committed and repairs an inconsistent preexisting membership", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      await withUpgradeProbe(database, async (probe) => {
        const state = sourceState();
        await prepare001To008(probe, state);
        await expect(probe.applySubset(RUNTIME_MIGRATION_VERSIONS.slice(0, 9))).resolves.toEqual({
          applied: ["009_relational_sample_lineage"],
          alreadyApplied: [...RUNTIME_MIGRATION_VERSIONS.slice(0, 8)]
        });
        await probe.query(
          "UPDATE samples SET item_ids = $1::text[] WHERE id = $2",
          [[ITEM_IDS[0], "item-aaa3-upgrade-missing"], REPLACEMENT_SAMPLE_ID]
        );

        const resumed = await probe.applyProductionMigrations();
        expect(resumed).toEqual({
          applied: [...RUNTIME_MIGRATION_VERSIONS.slice(9)],
          alreadyApplied: [...RUNTIME_MIGRATION_VERSIONS.slice(0, 9)]
        });

        const adapter = new RelationalClinicalCoreAdapter();
        await expect(adapter.readRequest(probe.sql, REQUEST_ID)).rejects.toThrow(
          `POSTGRES_RELATIONAL_READ_LINEAGE_MISMATCH:${REPLACEMENT_SAMPLE_ID}:item_ids:item-aaa3-upgrade-missing`
        );
        await probe.query("ALTER TABLE samples DROP CONSTRAINT samples_item_ids_nonempty");
        await probe.query("UPDATE samples SET item_ids = ARRAY[]::text[] WHERE id = $1", [REPLACEMENT_SAMPLE_ID]);
        await probe.query("ALTER TABLE samples ADD CONSTRAINT samples_item_ids_nonempty CHECK (cardinality(item_ids) > 0 AND array_position(item_ids, '') IS NULL) NOT VALID");
        await adapter.repairSampleMembership(probe.sql, state);
        await adapter.validateSampleMembership(probe.sql);
        await expect(adapter.readRequest(probe.sql, REQUEST_ID)).resolves.toEqual(expect.objectContaining({
          samples: expect.arrayContaining([expect.objectContaining({ id: REPLACEMENT_SAMPLE_ID, item_ids: [...ITEM_IDS] })])
        }));
        await expect(probe.applyProductionMigrations()).resolves.toEqual({
          applied: [],
          alreadyApplied: [...RUNTIME_MIGRATION_VERSIONS]
        });
      });
    });
  }, 120_000);

  it.each([
    { invalidCase: "accession" as const, constraint: "samples_accession_format", repairSql: "UPDATE samples SET accession_code = $1 WHERE id = $2", repairValues: [ORIGINAL_ACCESSION, ORIGINAL_SAMPLE_ID] },
    { invalidCase: "replacement" as const, constraint: "samples_replacement_reason_required", repairSql: "UPDATE samples SET rejection_reason_id = $1 WHERE id = $2", repairValues: ["reason-hemolyzed", REPLACEMENT_SAMPLE_ID] },
    { invalidCase: "link-status" as const, constraint: "sample_item_links_status_check", repairSql: "UPDATE sample_item_links SET link_status = $1 WHERE sample_id = $2", repairValues: ["REPLACED", REPLACEMENT_SAMPLE_ID] }
  ])("fails closed and rolls back 009 for invalid $invalidCase legacy data, then permits a corrected retry", async ({ invalidCase, constraint, repairSql, repairValues }) => {
    await withDisposablePostgresDatabase(async (database) => {
      await withUpgradeProbe(database, async (probe) => {
        const state = sourceState();
        await prepare001To008(probe, state, invalidCase);
        await expect(probe.applyProductionMigrations()).rejects.toThrow(constraint);

        expect(await schemaMigrationVersions(probe)).toEqual(RUNTIME_MIGRATION_VERSIONS.slice(0, 8));
        expect(await probe.query(
          "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'samples' AND column_name = 'item_ids'"
        )).toEqual({ rows: [], rowCount: 0 });
        expect(await probe.query(
          "SELECT constraint_info.conname FROM pg_constraint constraint_info JOIN pg_class relation ON relation.oid = constraint_info.conrelid JOIN pg_namespace relation_schema ON relation_schema.oid = relation.relnamespace WHERE relation_schema.nspname = current_schema() AND relation.relname IN ('samples', 'sample_item_links') AND constraint_info.conname = ANY($1::text[]) ORDER BY constraint_info.conname",
          [["samples_accession_format", "samples_replacement_reason_required", "sample_item_links_status_check", "samples_item_ids_nonempty"]]
        )).toEqual({ rows: [], rowCount: 0 });
        expect(await probe.query("SELECT count(*)::int AS count FROM samples")).toEqual({ rows: [{ count: 2 }], rowCount: 1 });

        await probe.query(repairSql, repairValues);
        const retry = await probe.applyProductionMigrations();
        expect(retry.applied).toEqual([...RUNTIME_MIGRATION_VERSIONS.slice(8)]);
        expect(await schemaMigrationVersions(probe)).toEqual([...RUNTIME_MIGRATION_VERSIONS]);
      });
    });
  }, 120_000);
});
