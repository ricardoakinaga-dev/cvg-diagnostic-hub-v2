import { describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { DiagnosticItem, DiagnosticRequest, Sample, StoreState } from "../../src/server/domain/models";
import { createApplicationService } from "../../src/server/application/service";
import { createDemoState } from "../../src/server/store/fixtures";
import {
  RelationalClinicalCoreAdapter,
  RELATIONAL_REQUEST_READ_SQL,
  type RelationalSqlClient
} from "../../src/server/store/relational/clinical-core-adapter";
import {
  RELATIONAL_CLINICAL_CORE_BACKFILL_TRANSFORM_VERSION,
  relationalClinicalCoreSourceHash
} from "../../src/server/store/relational/clinical-core-backfill";
import { assertReconciliationClean, reconcileRelationalRequest } from "../../src/server/store/relational/cutover";
import {
  withDisposablePostgresDatabase,
  type DisposablePostgresDatabase
} from "../support/postgres-test-harness";

const TEST_PASSWORD = "postgres-lineage-integration-password";
const REQUEST_ID = "request-pg-sample-lineage";
const ITEM_ID = "item-pg-sample-lineage";
const SAMPLE_ID = "sample-pg-sample-lineage";
const REQUESTED_AT = "2026-09-06T02:00:00.000Z";
const RECEIVED_AT = "2026-09-06T02:30:00.000Z";

function relationalClient(database: DisposablePostgresDatabase): RelationalSqlClient {
  return {
    query: (text, values = []) => database.query(text, values)
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForActiveDatabaseQuery(
  database: DisposablePostgresDatabase,
  queryPattern: string
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await database.query(
      "SELECT count(*)::int AS active FROM pg_stat_activity WHERE datname = current_database() AND state = 'active' AND query ILIKE $1",
      [`%${queryPattern}%`]
    );
    const active = Number((result.rows[0] as { active?: unknown } | undefined)?.active ?? 0);
    if (active > 0) return;
    await delay(20);
  }
  throw new Error(`database query did not become active: ${queryPattern}`);
}

function planNodes(value: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap((entry) => planNodes(entry));
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const current = typeof record["Node Type"] === "string" ? [record] : [];
  return [
    ...current,
    ...planNodes(record.Plan),
    ...planNodes(record.Plans)
  ];
}

async function seedPrerequisites(database: DisposablePostgresDatabase): Promise<void> {
  await database.query(
    "INSERT INTO departments (id, code, name, kind) VALUES ($1,$2,$3,$4),($5,$6,$7,$8)",
    [
      "INPATIENT", "INPATIENT", "Internação", "CLINICAL",
      "LABORATORY", "LABORATORY", "Laboratório", "DIAGNOSTICS"
    ]
  );
  await database.query(
    "INSERT INTO users (id, email, display_name, password_hash, timezone) VALUES ($1,$2,$3,$4,$5),($6,$7,$8,$9,$10)",
    [
      "user-vet", "vet@pg.local", "Veterinária de integração", "synthetic-hash-vet", "UTC",
      "user-lab", "lab@pg.local", "Técnica de integração", "synthetic-hash-lab", "UTC"
    ]
  );
  await database.query(
    "INSERT INTO patients (id, display_name, species, breed, sex, external_id) VALUES ($1,$2,$3,$4,$5,$6)",
    ["patient-pg-lineage", "Paciente sintético", "Canino", "SRD", "Não informado", "PG-LINEAGE-001"]
  );
  await database.query(
    "INSERT INTO encounters (id, patient_id, type, status, opened_at) VALUES ($1,$2,$3,$4,$5)",
    ["encounter-pg-lineage", "patient-pg-lineage", "INPATIENT", "OPEN", REQUESTED_AT]
  );
  await database.query(
    "INSERT INTO diagnostic_services (id, code, name, category, department_id, workflow_type, requires_sample, result_schema) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    ["service-pg-hemogram", "PG_HEMOGRAM", "Hemograma de integração", "LABORATORY", "LABORATORY", "LABORATORY", true, "NUMERIC_PANEL"]
  );
  await database.query(
    "INSERT INTO reason_codes (id, type, code, label) VALUES ($1,$2,$3,$4)",
    ["reason-hemolyzed", "RECOLLECTION", "HEMOLYZED", "Amostra hemolisada"]
  );
}

function lineageState(): { readonly empty: StoreState; readonly populated: StoreState; readonly request: DiagnosticRequest; readonly item: DiagnosticItem; readonly sample: Sample } {
  const base = createDemoState(TEST_PASSWORD);
  const baseService = base.services.find((service) => service.id === "service-hemogram");
  if (!baseService) throw new Error("missing hemogram fixture service");
  const integrationService = {
    ...baseService,
    id: "service-pg-hemogram",
    code: "HEMOGRAM",
    name: "Hemograma de integração"
  };
  const integrationPatient = {
    ...base.patients[0],
    id: "patient-pg-lineage",
    displayName: "Paciente sintético",
    breed: "SRD",
    ownerLabel: "Responsável sintético",
    externalId: "PG-LINEAGE-001"
  };
  const integrationEncounter = {
    ...base.encounters[0],
    id: "encounter-pg-lineage",
    patientId: integrationPatient.id,
    externalId: "PG-ENCOUNTER-001",
    openedAt: REQUESTED_AT
  };
  const request: DiagnosticRequest = {
    id: REQUEST_ID,
    requestCode: "PG-REL-0001",
    patientId: "patient-pg-lineage",
    encounterId: "encounter-pg-lineage",
    requesterId: "user-vet",
    requestingDepartmentCode: "INPATIENT",
    priority: "ROUTINE",
    aggregateStatus: "IN_PROGRESS",
    itemIds: [ITEM_ID],
    createdAt: REQUESTED_AT,
    updatedAt: RECEIVED_AT,
    version: 1
  };
  const item: DiagnosticItem = {
    id: ITEM_ID,
    requestId: REQUEST_ID,
    serviceId: "service-pg-hemogram",
    departmentCode: "LABORATORY",
    workflowType: "LABORATORY",
    priority: "ROUTINE",
    status: "RECEIVED",
    requestedAt: REQUESTED_AT,
    receivedAt: RECEIVED_AT,
    slaStartedAt: REQUESTED_AT,
    dueAt: "2026-09-06T10:00:00.000Z",
    slaPolicyVersion: 1,
    version: 1
  };
  const sample: Sample = {
    id: SAMPLE_ID,
    requestId: REQUEST_ID,
    accessionCode: "PG-REL-001",
    sampleType: "EDTA",
    status: "RECEIVED",
    itemIds: [ITEM_ID],
    collectedAt: REQUESTED_AT,
    receivedAt: RECEIVED_AT,
    receivedBy: "user-lab",
    version: 1
  };
  return {
    empty: {
      ...base,
      patients: [...base.patients, integrationPatient],
      encounters: [...base.encounters, integrationEncounter],
      services: [...base.services.filter((service) => service.id !== "service-hemogram"), integrationService],
      requests: [],
      items: [],
      samples: []
    },
    populated: {
      ...base,
      patients: [...base.patients, integrationPatient],
      encounters: [...base.encounters, integrationEncounter],
      services: [...base.services.filter((service) => service.id !== "service-hemogram"), integrationService],
      requests: [request],
      items: [item],
      samples: [sample]
    },
    request,
    item,
    sample
  };
}

function twoRequestLineageState(): { readonly empty: StoreState; readonly populated: StoreState; readonly first: ReturnType<typeof lineageState>; readonly second: { readonly request: DiagnosticRequest; readonly item: DiagnosticItem; readonly sample: Sample } } {
  const first = lineageState();
  const request: DiagnosticRequest = {
    ...first.request,
    id: "request-pg-sample-lineage-2",
    requestCode: "PG-REL-0002",
    itemIds: ["item-pg-sample-lineage-2"],
    createdAt: "2026-09-06T03:00:00.000Z",
    updatedAt: "2026-09-06T03:30:00.000Z"
  };
  const item: DiagnosticItem = {
    ...first.item,
    id: "item-pg-sample-lineage-2",
    requestId: request.id,
    requestedAt: request.createdAt,
    receivedAt: request.updatedAt,
    slaStartedAt: request.createdAt,
    dueAt: "2026-09-06T11:00:00.000Z"
  };
  const sample: Sample = {
    ...first.sample,
    id: "sample-pg-sample-lineage-2",
    requestId: request.id,
    accessionCode: "PG-REL-002",
    itemIds: [item.id],
    collectedAt: request.createdAt,
    receivedAt: request.updatedAt
  };
  return {
    empty: first.empty,
    populated: {
      ...first.populated,
      requests: [first.request, request],
      items: [first.item, item],
      samples: [first.sample, sample]
    },
    first,
    second: { request, item, sample }
  };
}

function requestedWorkflowState(): { readonly populated: StoreState; readonly request: DiagnosticRequest; readonly item: DiagnosticItem } {
  const base = lineageState();
  const request: DiagnosticRequest = {
    ...base.request,
    aggregateStatus: "REQUESTED",
    updatedAt: REQUESTED_AT
  };
  const item: DiagnosticItem = {
    ...base.item,
    status: "REQUESTED",
    receivedAt: undefined,
    currentSampleId: undefined,
    version: 1
  };
  return {
    populated: { ...base.empty, requests: [request], items: [item] },
    request,
    item
  };
}

describe("Relational sample/accession lineage on disposable PostgreSQL", () => {
  it("requires migration 009 constraints in live readiness and validates them", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const constraintNames = [
        "samples_accession_format",
        "samples_replacement_reason_required",
        "samples_item_ids_nonempty",
        "sample_item_links_status_check"
      ];
      const constraints = await database.query(
        "SELECT relation.relname AS table_name, constraint_info.conname, constraint_info.contype, constraint_info.convalidated FROM pg_constraint constraint_info JOIN pg_class relation ON relation.oid = constraint_info.conrelid JOIN pg_namespace relation_schema ON relation_schema.oid = relation.relnamespace WHERE relation_schema.nspname = current_schema() AND constraint_info.conname = ANY($1::text[]) ORDER BY relation.relname, constraint_info.conname",
        [constraintNames]
      );

      expect(constraints.rows).toEqual([
        { table_name: "sample_item_links", conname: "sample_item_links_status_check", contype: "c", convalidated: true },
        { table_name: "samples", conname: "samples_accession_format", contype: "c", convalidated: true },
        { table_name: "samples", conname: "samples_item_ids_nonempty", contype: "c", convalidated: true },
        { table_name: "samples", conname: "samples_replacement_reason_required", contype: "c", convalidated: true }
      ]);
      const adapter = new RelationalClinicalCoreAdapter();
      await expect(adapter.assertReady(relationalClient(database))).resolves.toBeUndefined();

      await database.query("ALTER TABLE samples DROP CONSTRAINT samples_accession_format");
      await database.query("ALTER TABLE departments ADD CONSTRAINT samples_accession_format CHECK (true)");
      await expect(adapter.assertReady(relationalClient(database))).rejects.toThrow("POSTGRES_RELATIONAL_CLINICAL_CORE_NOT_READY");
    });
  });

  it("repairs a populated legacy sample row only through explicit backfill readiness", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      await seedPrerequisites(database);
      const { empty, populated, request } = lineageState();
      const adapter = new RelationalClinicalCoreAdapter();

      // Seed the authoritative snapshot and create the relational rows as a
      // valid deployment would have done before an upgrade left a legacy row
      // without source membership.
      const bootstrap = await database.createRelationalStore(populated, adapter);
      await database.closeStore(bootstrap);
      await adapter.projectStateDelta(relationalClient(database), empty, populated);
      await database.query("ALTER TABLE samples DROP CONSTRAINT samples_item_ids_nonempty");
      await database.query("UPDATE samples SET item_ids = ARRAY[]::text[] WHERE id = $1", [SAMPLE_ID]);
      await database.query(
        "ALTER TABLE samples ADD CONSTRAINT samples_item_ids_nonempty CHECK (cardinality(item_ids) > 0 AND array_position(item_ids, '') IS NULL) NOT VALID"
      );

      await expect(database.createRelationalStore(populated, adapter)).rejects.toThrow("POSTGRES_RELATIONAL_CLINICAL_CORE_NOT_READY");

      const store = await database.createRelationalStore(populated, adapter, "BACKFILL");
      try {
        await expect(store.backfillRelationalClinicalCore({
          runId: "run-pg-clinical-core-legacy-repair",
          batchSize: 1
        })).resolves.toMatchObject({
          requestCount: 1,
          requestsProcessed: 1,
          rowsProjected: 4,
          requestsReconciled: 1
        });

        const repaired = await database.query(
          "SELECT item_ids FROM samples WHERE id = $1",
          [SAMPLE_ID]
        );
        expect(repaired.rows).toEqual([{ item_ids: [ITEM_ID] }]);
        const readiness = await database.query(
          "SELECT convalidated FROM pg_constraint WHERE conrelid = 'samples'::regclass AND conname = 'samples_item_ids_nonempty'"
        );
        expect(readiness.rows).toEqual([{ convalidated: true }]);
        await expect(store.readRelationalClinicalRequest(request.id)).resolves.toEqual(
          expect.objectContaining({ request: expect.objectContaining({ id: request.id }) })
        );
      } finally {
        await database.closeStore(store);
      }
    });
  });

  it("projects, reads and reconciles a scoped sample lineage through real relational tables", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      await seedPrerequisites(database);
      const { empty, populated, request, sample } = lineageState();
      const adapter = new RelationalClinicalCoreAdapter();
      const client = relationalClient(database);

      await adapter.assertReady(client);
      await adapter.projectStateDelta(client, empty, populated);
      await adapter.projectStateDelta(client, empty, populated);
      const aggregate = await adapter.readRequest(client, request.id);

      expect(aggregate).toMatchObject({
        request: { id: request.id, request_code: request.requestCode },
        items: [expect.objectContaining({ id: populated.items[0]?.id, request_id: request.id })],
        samples: [expect.objectContaining({ id: sample.id, accession_code: sample.accessionCode, item_ids: [ITEM_ID], status: "RECEIVED", version: 1 })],
        sampleItemLinks: [expect.objectContaining({
          sample_id: sample.id,
          item_id: populated.items[0]?.id,
          link_status: "ACTIVE",
          version: 1
        })]
      });
      if (!aggregate) throw new Error("Relational aggregate was not returned.");

      const reconciliation = reconcileRelationalRequest(populated, request.id, aggregate);
      expect(reconciliation.mismatches).toEqual([]);
      expect(reconciliation.sourceHash).toBe(reconciliation.targetHash);
      expect(reconciliation.comparedEntities).toBe(4);
      expect(() => assertReconciliationClean(reconciliation)).not.toThrow();
    });
  });

  it("backfills a populated snapshot by request, checkpoints durably and remains idempotent", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      await seedPrerequisites(database);
      const { populated, request } = lineageState();
      const store = await database.createRelationalStore(populated);
      try {
        const report = await store.backfillRelationalClinicalCore({
          runId: "run-pg-clinical-core-backfill",
          batchSize: 1
        });

        expect(report).toMatchObject({
          runId: "run-pg-clinical-core-backfill",
          scope: "CLINICAL_CORE_REQUESTS",
          sourceAuthority: "SNAPSHOT",
          targetAuthority: "RELATIONAL_SHADOW",
          requestCount: 1,
          requestsProcessed: 1,
          rowsProjected: 4,
          requestsReconciled: 1
        });
        expect(store.getState()).toEqual(populated);

        const run = await database.query(
          "SELECT run_id, scope, source_authority, target_authority, status, last_request_id, requests_processed, rows_projected, requests_reconciled FROM relational_backfill_runs WHERE run_id = $1",
          [report.runId]
        );
        expect(run.rows).toEqual([{
          run_id: report.runId,
          scope: "CLINICAL_CORE_REQUESTS",
          source_authority: "SNAPSHOT",
          target_authority: "RELATIONAL_SHADOW",
          status: "COMPLETED",
          last_request_id: request.id,
          requests_processed: "1",
          rows_projected: "4",
          requests_reconciled: "1"
        }]);

        const replay = await store.backfillRelationalClinicalCore({
          runId: report.runId,
          batchSize: 1
        });
        expect(replay).toMatchObject({
          runId: report.runId,
          requestsProcessed: 1,
          rowsProjected: 4,
          requestsReconciled: 1,
          resumedFromRequestId: request.id
        });
        await expect(store.readRelationalClinicalRequest(request.id)).resolves.toEqual(
          expect.objectContaining({ request: expect.objectContaining({ id: request.id }) })
        );

        await database.query(
          "UPDATE diagnostic_requests SET aggregate_status = $1 WHERE id = $2",
          ["REQUESTED", request.id]
        );
        await expect(store.backfillRelationalClinicalCore({ runId: report.runId, batchSize: 1 }))
          .rejects.toThrow("POSTGRES_RELATIONAL_RECONCILIATION_DIVERGED");
        const targetCorruptionRun = await database.query(
          "SELECT status, failure_code FROM relational_backfill_runs WHERE run_id = $1",
          [report.runId]
        );
        expect(targetCorruptionRun.rows).toEqual([{
          status: "COMPLETED",
          failure_code: null
        }]);

        await database.query(
          "UPDATE cvg_runtime_state SET state = jsonb_set(state, '{requests,0,updatedAt}', $1::jsonb), version = version + 1 WHERE id = 1",
          [JSON.stringify("2026-09-06T03:00:00.000Z")]
        );
        await expect(store.backfillRelationalClinicalCore({ runId: report.runId, batchSize: 1 }))
          .rejects.toThrow("POSTGRES_RELATIONAL_BACKFILL_SOURCE_CHANGED");
        const failedRun = await database.query(
          "SELECT status FROM relational_backfill_runs WHERE run_id = $1",
          [report.runId]
        );
        expect(failedRun.rows).toEqual([{ status: "COMPLETED" }]);
      } finally {
        await database.closeStore(store);
      }
    });
  });

  it("keeps a real workflow mutation atomic with the relational shadow after backfill", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      await seedPrerequisites(database);
      const { populated, request, item } = requestedWorkflowState();
      const store = await database.createRelationalStore(populated);
      const service = createApplicationService(store);
      const labActor = store.getState().users.find((user) => user.id === "user-lab");
      if (!labActor) throw new Error("missing laboratory integration actor");

      try {
        await expect(store.backfillRelationalClinicalCore({
          runId: "run-pg-clinical-core-workflow",
          batchSize: 1
        })).resolves.toMatchObject({
          requestCount: 1,
          requestsProcessed: 1,
          rowsProjected: 2,
          requestsReconciled: 1
        });

        const assertClean = async () => {
          const report = await store.reconcileRelationalClinicalRequest(request.id);
          expect(report.mismatches).toEqual([]);
          expect(() => assertReconciliationClean(report)).not.toThrow();
        };

        await assertClean();
        const received = await service.receiveSample(labActor, [item.id], {
          accessionCode: "PG-WORKFLOW-001",
          sampleType: "EDTA",
          expectedVersion: item.version,
          idempotencyKey: "pg-workflow-receive"
        });
        await assertClean();

        const recollection = await service.requestRecollection(labActor, received.sample.id, {
          reasonCode: "HEMOLYZED",
          note: "Amostra hemolisada",
          expectedVersion: received.items[0].version,
          idempotencyKey: "pg-workflow-recollect"
        });
        await assertClean();

        const replacement = await service.receiveReplacement(labActor, recollection.replacement.id, {
          accessionCode: "PG-WORKFLOW-002",
          sampleType: "EDTA",
          expectedVersion: recollection.items[0].version,
          idempotencyKey: "pg-workflow-replacement"
        });
        await assertClean();

        expect(store.getState().samples).toEqual(expect.arrayContaining([
          expect.objectContaining({
            id: received.sample.id,
            status: "REPLACED",
            version: 2,
            rejectionCode: "HEMOLYZED"
          }),
          expect.objectContaining({
            id: replacement.sample.id,
            status: "RECEIVED",
            version: 2,
            accessionCode: "PG-WORKFLOW-002",
            replacesSampleId: received.sample.id
          })
        ]));

        const relationalLineage = await database.query(
          "SELECT sample.id, sample.status, sample.replaces_sample_id, sample.version, link.item_id, link.link_status, link.version AS link_version FROM samples sample JOIN sample_item_links link ON link.sample_id = sample.id WHERE sample.request_id = $1 ORDER BY sample.replaces_sample_id NULLS FIRST, sample.id",
          [request.id]
        );
        expect(relationalLineage.rows).toEqual([
          expect.objectContaining({
            id: received.sample.id,
            status: "REPLACED",
            replaces_sample_id: null,
            version: 2,
            item_id: item.id,
            link_status: "REPLACED",
            link_version: 2
          }),
          expect.objectContaining({
            id: replacement.sample.id,
            status: "RECEIVED",
            replaces_sample_id: received.sample.id,
            version: 2,
            item_id: item.id,
            link_status: "ACTIVE",
            link_version: 2
          })
        ]);
      } finally {
        await database.closeStore(store);
      }
    });
  });

  it("rolls back JSONB and relational workflow state when the real projection fails", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      await seedPrerequisites(database);
      const { populated, request, item } = requestedWorkflowState();
      const store = await database.createRelationalStore(populated);
      const service = createApplicationService(store);
      const labActor = store.getState().users.find((user) => user.id === "user-lab");
      if (!labActor) throw new Error("missing laboratory integration actor");

      try {
        await store.backfillRelationalClinicalCore({
          runId: "run-pg-clinical-core-rollback",
          batchSize: 1
        });
        await database.query(`
          CREATE FUNCTION test_relational_projection_failure() RETURNS trigger
          LANGUAGE plpgsql AS $$
          BEGIN
            RAISE EXCEPTION 'POSTGRES_RELATIONAL_PROJECTION_FAILURE';
          END
          $$
        `);
        await database.query(`
          CREATE TRIGGER test_relational_projection_failure
          BEFORE INSERT OR UPDATE ON samples
          FOR EACH ROW EXECUTE FUNCTION test_relational_projection_failure()
        `);

        await expect(service.receiveSample(labActor, [item.id], {
          accessionCode: "PG-ROLLBACK-001",
          sampleType: "EDTA",
          expectedVersion: item.version,
          idempotencyKey: "pg-workflow-rollback"
        })).rejects.toThrow("POSTGRES_RELATIONAL_PROJECTION_FAILURE");

        expect(store.getState()).toEqual(populated);
        const counts = await database.query(
          "SELECT (SELECT count(*) FROM samples WHERE request_id = $1) AS samples, (SELECT count(*) FROM sample_item_links WHERE request_id = $1) AS links, (SELECT version FROM cvg_runtime_state WHERE id = 1) AS runtime_version",
          [request.id]
        );
        expect(counts.rows).toEqual([{ samples: "0", links: "0", runtime_version: "1" }]);
        await expect(store.reconcileRelationalClinicalRequest(request.id)).resolves.toMatchObject({ mismatches: [] });
      } finally {
        await database.query("DROP TRIGGER IF EXISTS test_relational_projection_failure ON samples").catch(() => undefined);
        await database.query("DROP FUNCTION IF EXISTS test_relational_projection_failure()").catch(() => undefined);
        await database.closeStore(store);
      }
    });
  });

  it("resumes a failed run from its durable request cursor", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      await seedPrerequisites(database);
      const { empty, populated, first, second } = twoRequestLineageState();
      const adapter = new RelationalClinicalCoreAdapter();
      const client = relationalClient(database);
      const firstOnly = {
        ...populated,
        requests: [first.request],
        items: [first.item],
        samples: [first.sample]
      };
      await adapter.projectStateDelta(client, empty, firstOnly);
      await database.query(
        `INSERT INTO relational_backfill_runs
          (run_id, scope, source_authority, target_authority, transform_version, source_snapshot_version, source_snapshot_hash, status, last_request_id, requests_processed, rows_projected, requests_reconciled, failure_code)
         VALUES ($1,'CLINICAL_CORE_REQUESTS','SNAPSHOT','RELATIONAL_SHADOW',$2,$3,$4,'FAILED',$5,1,4,1,'POSTGRES_RELATIONAL_BACKFILL_ABORTED')`,
        [
          "run-pg-clinical-core-resume",
          RELATIONAL_CLINICAL_CORE_BACKFILL_TRANSFORM_VERSION,
          1,
          relationalClinicalCoreSourceHash(populated),
          first.request.id
        ]
      );

      const store = await database.createRelationalStore(populated);
      try {
        const report = await store.backfillRelationalClinicalCore({
          runId: "run-pg-clinical-core-resume",
          batchSize: 1
        });
        expect(report).toMatchObject({
          requestCount: 2,
          requestsProcessed: 2,
          rowsProjected: 8,
          requestsReconciled: 2,
          resumedFromRequestId: first.request.id
        });
        const secondRead = await store.readRelationalClinicalRequest(second.request.id);
        expect(secondRead).toMatchObject({ request: { id: second.request.id } });
      } finally {
        await database.closeStore(store);
      }
    });
  });

  it("holds the source row lock through the checkpoint and fails closed on a concurrent writer", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      await seedPrerequisites(database);
      const { populated } = lineageState();
      const store = await database.createRelationalStore(populated);
      const writerPool = new Pool({ connectionString: database.connectionString(), max: 1 });
      writerPool.on("error", () => undefined);
      const writer = await writerPool.connect();
      let backfillPromise: Promise<unknown> | undefined;
      try {
        await database.query(
          `CREATE FUNCTION test_backfill_checkpoint_pause() RETURNS trigger
           LANGUAGE plpgsql AS $$
             BEGIN
             IF NEW.status = 'RUNNING' AND NEW.last_request_id IS NOT NULL THEN
               PERFORM pg_sleep(2.0);
             END IF;
             RETURN NEW;
           END
           $$`
        );
        await database.query(
          "CREATE TRIGGER test_backfill_checkpoint_pause BEFORE UPDATE ON relational_backfill_runs FOR EACH ROW EXECUTE FUNCTION test_backfill_checkpoint_pause()"
        );
        backfillPromise = store.backfillRelationalClinicalCore({
          runId: "run-pg-clinical-core-lock-race",
          batchSize: 1
        });
        await waitForActiveDatabaseQuery(database, "UPDATE relational_backfill_runs");

        const driftedState = {
          ...populated,
          requests: [{ ...populated.requests[0], updatedAt: "2026-09-06T04:00:00.000Z" }]
        };
        const writerMutation = (async () => {
          await writer.query("BEGIN");
          await writer.query(
            "UPDATE cvg_runtime_state SET state = $1::jsonb, version = version + 1 WHERE id = 1",
            [JSON.stringify(driftedState)]
          );
          await writer.query("COMMIT");
        })();
        await delay(100);
        await expect(Promise.race([
          writerMutation.then(() => true),
          delay(100).then(() => false)
        ])).resolves.toBe(false);
        // The writer can commit before or after the final transaction takes its
        // snapshot. Both interleavings must reject and persist SOURCE_CHANGED.
        await expect(backfillPromise).rejects.toThrow(
          /^(?:could not serialize access due to concurrent update|POSTGRES_RELATIONAL_BACKFILL_SOURCE_CHANGED)$/
        );
        await expect(writerMutation).resolves.toBeUndefined();

        const failed = await database.query(
          "SELECT status, failure_code FROM relational_backfill_runs WHERE run_id = $1",
          ["run-pg-clinical-core-lock-race"]
        );
        expect(failed.rows).toEqual([{
          status: "FAILED",
          failure_code: "POSTGRES_RELATIONAL_BACKFILL_SOURCE_CHANGED"
        }]);
      } finally {
        await backfillPromise?.catch(() => undefined);
        await writer.query("ROLLBACK").catch(() => undefined);
        writer.release();
        await writerPool.end();
        await database.query("DROP TRIGGER IF EXISTS test_backfill_checkpoint_pause ON relational_backfill_runs");
        await database.query("DROP FUNCTION IF EXISTS test_backfill_checkpoint_pause()");
        await database.closeStore(store);
      }
    });
  });

  it("serializes the same run across independent PostgreSQL pools", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      await seedPrerequisites(database);
      const { populated, request } = lineageState();
      const firstStore = await database.createRelationalStore(populated);
      const secondStore = await database.createRelationalStore(populated);
      try {
        const [first, second] = await Promise.all([
          firstStore.backfillRelationalClinicalCore({ runId: "run-pg-clinical-core-same-run", batchSize: 1 }),
          secondStore.backfillRelationalClinicalCore({ runId: "run-pg-clinical-core-same-run", batchSize: 1 })
        ]);
        expect(first).toMatchObject({ requestsProcessed: 1, rowsProjected: 4, requestsReconciled: 1 });
        expect(second).toMatchObject({ requestsProcessed: 1, rowsProjected: 4, requestsReconciled: 1 });
        const counts = await database.query(
          "SELECT (SELECT count(*) FROM diagnostic_requests) AS requests, (SELECT count(*) FROM sample_item_links) AS links"
        );
        expect(counts.rows).toEqual([{ requests: "1", links: "1" }]);
        await expect(firstStore.readRelationalClinicalRequest(request.id)).resolves.toEqual(
          expect.objectContaining({ request: expect.objectContaining({ id: request.id }) })
        );
      } finally {
        await database.closeStore(secondStore);
        await database.closeStore(firstStore);
      }
    });
  });

  it("rejects a target key-set divergence instead of accepting compensating counts", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      await seedPrerequisites(database);
      const { populated } = lineageState();
      const store = await database.createRelationalStore(populated);
      try {
        await database.query(
          `INSERT INTO diagnostic_requests
            (id, request_code, patient_id, encounter_id, requester_id, requesting_department_id, priority, aggregate_status, created_at, updated_at, version)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            "request-pg-extra-target", "PG-REL-EXTRA", "patient-pg-lineage", "encounter-pg-lineage", "user-vet",
            "INPATIENT", "ROUTINE", "REQUESTED", REQUESTED_AT, REQUESTED_AT, 1
          ]
        );
        await expect(store.backfillRelationalClinicalCore({
          runId: "run-pg-clinical-core-extra-target",
          batchSize: 1
        })).rejects.toThrow("POSTGRES_RELATIONAL_BACKFILL_COMPLETENESS_MISMATCH:diagnostic_requests");
        const failed = await database.query(
          "SELECT status, failure_code FROM relational_backfill_runs WHERE run_id = $1",
          ["run-pg-clinical-core-extra-target"]
        );
        expect(failed.rows).toEqual([{
          status: "FAILED",
          failure_code: "POSTGRES_RELATIONAL_BACKFILL_COMPLETENESS_MISMATCH"
        }]);
      } finally {
        await database.closeStore(store);
      }
    });
  });

  it("keeps the relational aggregate read on indexed access paths under representative fan-out", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      await seedPrerequisites(database);
      const { empty, populated, request } = lineageState();
      const adapter = new RelationalClinicalCoreAdapter();
      const client = relationalClient(database);
      await adapter.projectStateDelta(client, empty, populated);

      await database.query(
        `INSERT INTO diagnostic_requests (id, request_code, patient_id, encounter_id, requester_id, requesting_department_id, priority, aggregate_status, created_at, updated_at, version)
         SELECT 'request-plan-' || series::text, 'PG-PLAN-' || lpad(series::text, 4, '0'), 'patient-pg-lineage', 'encounter-pg-lineage', 'user-vet', 'INPATIENT', 'ROUTINE', 'REQUESTED', now(), now(), 1
           FROM generate_series(1, 512) AS generated(series)`,
      );
      await database.query(
        `INSERT INTO diagnostic_request_items (id, request_id, service_id, department_id, workflow_type, priority, status, requested_at, sla_started_at, due_at, sla_policy_version, created_at, updated_at, version)
         SELECT 'item-plan-' || series::text, 'request-plan-' || series::text, 'service-pg-hemogram', 'LABORATORY', 'LABORATORY', 'ROUTINE', 'REQUESTED', now(), now(), now() + interval '8 hours', 1, now(), now(), 1
           FROM generate_series(1, 512) AS generated(series)`,
      );

      const explained = await database.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${RELATIONAL_REQUEST_READ_SQL}`,
        [request.id]
      );
      const firstPlanRow = explained.rows[0];
      const plan = firstPlanRow && typeof firstPlanRow === "object" && !Array.isArray(firstPlanRow)
        ? (firstPlanRow as Record<string, unknown>)["QUERY PLAN"]
        : undefined;
      expect(plan).toBeDefined();
      const planText = JSON.stringify(plan);
      expect(planText).toContain("diagnostic_requests");
      expect(planText).toContain("diagnostic_request_items");
      expect(planText).toMatch(/Index Scan|Bitmap Index Scan/);
      const indexedClinicalRelations = new Set([
        "diagnostic_requests",
        "diagnostic_request_items",
        "samples",
        "sample_item_links"
      ]);
      const sequentialClinicalScans = planNodes(plan).filter((node) =>
        node["Node Type"] === "Seq Scan" && indexedClinicalRelations.has(String(node["Relation Name"] ?? ""))
      );
      expect(sequentialClinicalScans).toEqual([]);
    });
  });

  it("rejects invalid accession, missing replacement reason and unknown link status in PostgreSQL", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      await seedPrerequisites(database);
      const { empty, populated, request, item } = lineageState();
      const adapter = new RelationalClinicalCoreAdapter();
      const client = relationalClient(database);
      await adapter.projectStateDelta(client, empty, populated);

      await expect(database.query(
        "INSERT INTO samples (id, request_id, accession_code, sample_type, status, item_ids, version) VALUES ($1,$2,$3,$4,$5,ARRAY[$6]::text[],$7)",
        ["sample-pg-invalid-accession", request.id, "bad", "EDTA", "EXPECTED", item.id, 1]
      )).rejects.toThrow(/samples_accession_format/);

      await expect(database.query(
        "INSERT INTO samples (id, request_id, accession_code, sample_type, status, item_ids, version) VALUES ($1,$2,$3,$4,$5,ARRAY[$6]::text[],$7)",
        ["sample-pg-missing-reason", request.id, "PG-REL-002", "EDTA", "REPLACED", item.id, 1]
      )).rejects.toThrow(/samples_replacement_reason_required/);

      await database.query(
        "INSERT INTO samples (id, request_id, accession_code, sample_type, status, item_ids, version) VALUES ($1,$2,$3,$4,$5,ARRAY[$6]::text[],$7)",
        ["sample-pg-link-target", request.id, "PG-REL-003", "EDTA", "EXPECTED", item.id, 1]
      );
      await expect(database.query(
        "INSERT INTO sample_item_links (id, sample_id, item_id, request_id, link_status, version) VALUES ($1,$2,$3,$4,$5,$6)",
        ["link-pg-invalid-status", "sample-pg-link-target", item.id, request.id, "UNKNOWN", 1]
      )).rejects.toThrow(/sample_item_links_status_check/);
    });
  });
});
