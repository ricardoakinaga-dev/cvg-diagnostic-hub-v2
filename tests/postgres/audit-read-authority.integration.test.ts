import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createApplicationService } from "../../src/server/application/service";
import type { AuditEvent, AuditReadQuery, DiagnosticItem, StateStore, StoreState } from "../../src/server/domain/models";
import { createDemoState, syntheticHemogramContent } from "../../src/server/store/fixtures";
import { MemoryStore } from "../../src/server/store/memory-store";
import { applyMigrations, RUNTIME_MIGRATION_VERSIONS, type SqlQueryable } from "../../src/server/store/migrations";
import { readPostgresAuditEvents } from "../../src/server/store/postgres-audit-read";
import { withDisposablePostgresDatabase, type DisposablePostgresDatabase } from "../support/postgres-test-harness";

const TEST_PASSWORD = "postgres-audit-authority-synthetic-password";
const OCCURRED_AT = "2026-09-15T12:00:00.000Z";
const MIGRATION_DIRECTORY = path.resolve(process.cwd(), "db/migrations");
const CUTOVER_VERSION = "013_audit_read_authority";
const ALL_AUDITS: AuditReadQuery = { scope: { entities: [], unresolved: { resolvedEntities: [] } }, order: "asc", limit: 1000 };

function auditEvent(id: string, overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id, eventType: "SyntheticAuditEvidence", actorId: "user-lab",
    entityType: "DiagnosticRequestItem", entityId: "item-audit-lab",
    previousState: "", newState: "REQUESTED", correlationId: `correlation-${id}`,
    metadata: { synthetic: true, value: 1 }, occurredAt: OCCURRED_AT,
    ...overrides
  };
}

function scopedFixture(): StoreState {
  const state = createDemoState(TEST_PASSWORD);
  state.users = state.users.map((user) => user.id === "user-manager"
    ? { ...user, departmentCode: "LABORATORY", managedDepartmentCodes: ["LABORATORY"] }
    : user.id === "user-vet" ? { ...user, patientIds: ["patient-thor"] } : user);
  state.users.push({ ...state.users.find((user) => user.id === "user-vet")!, id: "user-audit-reviewer", email: "audit-reviewer@cvg.local", displayName: "Synthetic Reviewer Zeta" });
  const itemDefinitions = [
    ["item-audit-lab", "request-audit-mixed", "service-hemogram"],
    ["item-audit-rx", "request-audit-mixed", "service-xray"],
    ["item-audit-crp", "request-audit-lab", "service-crp"],
    ["item-audit-other", "request-audit-other", "service-ultrasound"]
  ];
  state.items = itemDefinitions.map(([id, requestId, serviceId]): DiagnosticItem => {
    const service = state.services.find((entry) => entry.id === serviceId)!;
    return { id, requestId, serviceId, departmentCode: service.departmentCode, workflowType: service.workflowType,
      priority: "ROUTINE", status: "REQUESTED", requestedAt: OCCURRED_AT, slaStartedAt: OCCURRED_AT,
      dueAt: "2026-09-16T12:00:00.000Z", slaPolicyVersion: 1, version: 1 };
  });
  state.requests = ["request-audit-mixed", "request-audit-lab", "request-audit-other"].map((id, index) => ({
    id, requestCode: `AUDIT-00${index + 1}`, patientId: index === 2 ? "patient-mel" : "patient-thor",
    encounterId: index === 2 ? "encounter-mel" : "encounter-thor", requesterId: "user-vet",
    requestingDepartmentCode: "INPATIENT", priority: "ROUTINE", aggregateStatus: "REQUESTED",
    itemIds: state.items.filter((item) => item.requestId === id).map((item) => item.id),
    createdAt: OCCURRED_AT, updatedAt: OCCURRED_AT, version: 1
  }));
  state.samples = [
    { id: "sample-audit-lab", requestId: "request-audit-mixed", accessionCode: "AUDIT-SAMPLE-001", sampleType: "EDTA", status: "RECEIVED", itemIds: ["item-audit-lab"], version: 1 },
    { id: "sample-audit-shared", requestId: "request-audit-mixed", accessionCode: "AUDIT-SAMPLE-002", sampleType: "EDTA", status: "RECEIVED", itemIds: ["item-audit-lab", "item-audit-rx"], version: 1 }
  ];
  state.auditEvents = [
    ...Array.from({ length: 105 }, (_, index) => auditEvent(`audit-lab-${String(index).padStart(3, "0")}`)),
    ...["audit!", "audit-", "audit.A", "audit.AA", "audit.Z", "audit_a", "audit_z"].map((id) => auditEvent(id)),
    auditEvent("audit-rx", { entityId: "item-audit-rx", actorId: "user-rx" }),
    auditEvent("audit-other-patient", { entityId: "item-audit-other", actorId: "user-us" }),
    auditEvent("audit-crp", { entityId: "item-audit-crp" }),
    auditEvent("audit-request", { entityType: "DiagnosticRequest", entityId: "request-audit-mixed" }),
    auditEvent("audit-sample", { entityType: "Sample", entityId: "sample-audit-lab" }),
    auditEvent("audit-shared-sample", { entityType: "Sample", entityId: "sample-audit-shared" }),
    // Reviewer lookup intentionally matches the ID even for a legacy entity type.
    auditEvent("audit-reviewer-legacy", { entityType: "LegacyItem", entityId: "item-audit-lab", actorId: "user-audit-reviewer" }),
    auditEvent("audit-reviewer-duplicate", { entityType: "LegacyItem", entityId: "item-audit-lab", actorId: "user-audit-reviewer" }),
    auditEvent("audit-user", { entityType: "User", entityId: "user-lab" }),
    auditEvent("audit-service", { entityType: "DiagnosticService", entityId: "service-hemogram" }),
    auditEvent("audit-rx-service", { entityType: "DiagnosticService", entityId: "service-xray" }),
    auditEvent("audit-reason", { entityType: "ReasonCode", entityId: "reason-cancel" }),
    auditEvent("audit-orphan", { entityType: "DiagnosticRequest", entityId: "request-no-longer-in-state", actorId: undefined })
  ];
  return state;
}

async function assertStorePaginationParity(postgres: StateStore, memory: StateStore, query: AuditReadQuery): Promise<void> {
  const seen: string[] = [];
  let cursor: AuditReadQuery["cursor"];
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const page = await postgres.readAuditEvents({ ...query, cursor });
    expect(page).toEqual(await memory.readAuditEvents({ ...query, cursor }));
    seen.push(...page.items.map((event) => event.id));
    if (!page.hasMore) {
      expect(seen).toHaveLength(page.total);
      expect(new Set(seen).size).toBe(page.total);
      return;
    }
    const last = page.items.at(-1)!;
    cursor = { occurredAt: last.occurredAt, id: last.id };
  }
  throw new Error("Audit cursor failed to exhaust the fixture.");
}

async function assertApplicationPaginationParity(
  postgres: (cursor?: string) => Promise<{ items: AuditEvent[]; total: number; nextCursor?: string }>,
  memory: (cursor?: string) => Promise<{ items: AuditEvent[]; total: number; nextCursor?: string }>
): Promise<AuditEvent[]> {
  const events: AuditEvent[] = [];
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const page = await postgres(cursor);
    expect(page).toEqual(await memory(cursor));
    events.push(...page.items);
    if (!page.nextCursor) {
      expect(events).toHaveLength(page.total);
      expect(new Set(events.map((event) => event.id)).size).toBe(page.total);
      return events;
    }
    expect(page.nextCursor).not.toBe(cursor);
    cursor = page.nextCursor;
  }
  throw new Error("Application audit cursor failed to exhaust the fixture.");
}

async function createReleasedResult(store: StateStore) {
  const service = createApplicationService(store);
  const state = await store.readState();
  const vet = state.users.find((user) => user.id === "user-vet")!;
  const lab = state.users.find((user) => user.id === "user-lab")!;
  const request = await service.createRequest(vet, {
    patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-hemogram" }]
  }, { idempotencyKey: "audit-review-request" });
  const item = request.items[0];
  const received = await service.receiveSample(lab, [item.id], {
    accessionCode: request.samples[0].accessionCode, sampleType: "EDTA", expectedVersion: item.version, idempotencyKey: "audit-review-receive"
  });
  const processing = await service.startProcessing(lab, item.id, {
    expectedVersion: received.items[0].version, idempotencyKey: "audit-review-process"
  });
  const draft = await service.createResultDraft(lab, item.id, {
    narrative: "Synthetic audit review result.", content: syntheticHemogramContent("audit authority"),
    expectedVersion: processing.item.version, idempotencyKey: "audit-review-draft"
  });
  const released = await service.releaseResult(lab, draft.result.id, {
    expectedVersion: draft.result.version, idempotencyKey: "audit-review-release"
  });
  return { service, vet, lab, released };
}

interface MigrationProbe {
  sql: SqlQueryable;
  query: SqlQueryable["query"];
  upgrade(): ReturnType<typeof applyMigrations>;
}

// Like the relational upgrade suite, use a fresh schema inside a disposable
// database so 012 fixtures cannot contaminate the latest public schema.
async function with012Probe(database: DisposablePostgresDatabase, operation: (probe: MigrationProbe) => Promise<void>): Promise<void> {
  const schema = `audit_upgrade_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  if (!/^audit_upgrade_[0-9]+_[a-f0-9]{32}$/.test(schema)) throw new Error("Invalid audit upgrade schema.");
  const directory = await mkdtemp(path.join(os.tmpdir(), "cvg-audit-upgrade-"));
  const pool = new Pool({ connectionString: database.connectionString(), max: 1 });
  try {
    await Promise.all(RUNTIME_MIGRATION_VERSIONS.filter((version) => version < CUTOVER_VERSION).map((version) =>
      copyFile(path.join(MIGRATION_DIRECTORY, `${version}.sql`), path.join(directory, `${version}.sql`))));
    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}", public`);
      const sql: SqlQueryable = { query: (text, values) => client.query(text, values) };
      await applyMigrations(sql, { migrationDirectory: directory, logger: { info: () => undefined } });
      // These fixtures exercise 013 alone, including its exact version delta.
      await copyFile(path.join(MIGRATION_DIRECTORY, `${CUTOVER_VERSION}.sql`), path.join(directory, `${CUTOVER_VERSION}.sql`));
      await operation({ sql, query: sql.query, upgrade: () => applyMigrations(sql, { migrationDirectory: directory, logger: { info: () => undefined } }) });
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
    await rm(directory, { recursive: true, force: true });
    await database.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  }
}

async function insertAudit(probe: MigrationProbe, event: AuditEvent): Promise<void> {
  await probe.query("INSERT INTO audit_events (id, event_type, actor_id, entity_type, entity_id, previous_state, new_state, correlation_id, metadata, occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)",
    [event.id, event.eventType, event.actorId ?? null, event.entityType, event.entityId, event.previousState ?? null, event.newState ?? null, event.correlationId, JSON.stringify(event.metadata), event.occurredAt]);
}

async function snapshot(probe: MigrationProbe) {
  return (await probe.query("SELECT state, state::text AS bytes, version::text, updated_at FROM cvg_runtime_state WHERE id = 1")).rows;
}

async function cutoverArtifacts(probe: MigrationProbe) {
  return (await probe.query(`SELECT
    (SELECT count(*)::int FROM schema_migrations WHERE version = '013_audit_read_authority') AS ledger,
    (SELECT count(*)::int FROM pg_constraint WHERE conrelid = 'cvg_runtime_state'::regclass AND conname = 'runtime_audit_is_transient') AS guard,
    (SELECT count(*)::int FROM pg_indexes WHERE schemaname = current_schema() AND indexname IN ('audit_events_page_idx', 'audit_events_entity_page_idx', 'audit_events_view_evidence_idx', 'audit_events_entity_actor_idx')) AS indexes,
    (SELECT count(*)::int FROM runtime_storage_boundaries WHERE boundary_key = 'audit-events-v1') AS boundary`)).rows;
}

describe("PROD-101 PostgreSQL audit read authority", () => {
  it("keeps snapshot bytes fixed during audit-only growth and reloads table history across restarts", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const seeded = auditEvent("audit-seeded");
      const store = await database.createStore({ ...createDemoState(TEST_PASSWORD), auditEvents: [seeded] });
      const observer = await database.createStore();
      const before = await database.query("SELECT state::text AS bytes, pg_column_size(state)::int AS size, version::text FROM cvg_runtime_state WHERE id = 1");
      const beforeVersion = Number((before.rows[0] as { version: string }).version);
      const appended = Array.from({ length: 250 }, (_, index) => auditEvent(`audit-growth-${String(index).padStart(3, "0")}`, {
        occurredAt: new Date(Date.parse(OCCURRED_AT) + index + 1).toISOString(), metadata: { synthetic: true, payload: "audit-growth".repeat(100) }
      }));
      for (let offset = 0; offset < appended.length; offset += 50) {
        await store.transaction((state) => {
          expect(state.auditEvents).toEqual([]);
          return { state: { ...state, auditEvents: appended.slice(offset, offset + 50) }, result: undefined };
        });
        expect(store.getState().auditEvents).toEqual([]);
      }
      const after = await database.query("SELECT state::text AS bytes, pg_column_size(state)::int AS size, version::text FROM cvg_runtime_state WHERE id = 1");
      expect(after.rows).toEqual([{ ...(before.rows[0] as object), version: String(beforeVersion + 5) }]);
      expect((await observer.readState()).auditEvents).toEqual([]);
      expect((await observer.readAuditEvents(ALL_AUDITS)).items).toEqual([seeded, ...appended]);
      await database.closeStore(store);
      await database.closeStore(observer);
      const reopened = await database.createStore();
      expect(reopened.getState().auditEvents).toEqual([]);
      expect((await reopened.readAuditEvents(ALL_AUDITS)).items).toEqual([seeded, ...appended]);
      expect(await database.query("SELECT count(*)::int AS count FROM audit_events")).toEqual({ rows: [{ count: 251 }], rowCount: 1 });
      await expect(reopened.healthcheck()).resolves.toBeUndefined();
    });
  });

  it("matches memory for scoped keyset pages, audit/timeline RBAC, patient history and ID-only reviewer search", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const fixture = scopedFixture();
      const postgres = await database.createStore(fixture);
      const memory = new MemoryStore(fixture);
      const pgService = createApplicationService(postgres);
      const memoryService = createApplicationService(memory);
      const scope = { entities: [{ entityType: "DiagnosticRequestItem", entityId: "item-audit-lab" }] };
      for (const order of ["asc", "desc"] as const) {
        await assertStorePaginationParity(postgres, memory, { scope, order, limit: 7 });
      }
      const binaryIds = ["audit!", "audit-", "audit.A", "audit.AA", "audit.Z", "audit_a", "audit_z"];
      const ordered = (await postgres.readAuditEvents({ scope, order: "asc", limit: 1000 })).items.map((event) => event.id).filter((id) => binaryIds.includes(id));
      expect(ordered).toEqual(binaryIds);
      expect(await postgres.readAuditEvents({ scope: { entities: [] }, order: "asc", limit: 7 })).toEqual({ items: [], total: 0, hasMore: false });

      for (const actorId of ["user-admin", "user-manager"]) {
        const actor = fixture.users.find((user) => user.id === actorId)!;
        const events = await assertApplicationPaginationParity(
          (cursor) => pgService.listAuditEvents(actor, { limit: 7, cursor }),
          (cursor) => memoryService.listAuditEvents(actor, { limit: 7, cursor })
        );
        expect(events.some((event) => event.id === "audit-reason")).toBe(true);
        expect(events.some((event) => event.id === "audit-service")).toBe(true);
        expect(events.some((event) => event.id === "audit-rx")).toBe(false);
        expect(events.some((event) => event.id === "audit-shared-sample")).toBe(false);
        expect(events.some((event) => event.id === "audit-orphan")).toBe(actorId === "user-admin");
        expect(events.some((event) => event.id === "audit-rx-service")).toBe(actorId === "user-admin");
      }
      const lab = fixture.users.find((user) => user.id === "user-lab")!;
      const vet = fixture.users.find((user) => user.id === "user-vet")!;
      await expect(pgService.listAuditEvents(lab)).rejects.toMatchObject({ status: 404, code: "SCOPE_DENIED" });
      for (const actor of [lab, vet]) {
        const events = await assertApplicationPaginationParity(
          (cursor) => pgService.timeline(actor, "request-audit-mixed", undefined, { limit: 7, cursor }),
          (cursor) => memoryService.timeline(actor, "request-audit-mixed", undefined, { limit: 7, cursor })
        );
        expect(events.some((event) => event.id === "audit-sample")).toBe(true);
        expect(events.some((event) => event.id === "audit-rx")).toBe(actor.id === vet.id);
        expect(events.some((event) => event.id === "audit-shared-sample")).toBe(actor.id === vet.id);
        expect(events.some((event) => event.id === "audit-other-patient")).toBe(false);
        const workspace = await pgService.getPatientDiagnostics(actor, "patient-thor", { limit: 1 });
        const expectedWorkspace = await memoryService.getPatientDiagnostics(actor, "patient-thor", { limit: 1 });
        expect(workspace.events).toEqual(expectedWorkspace.events);
        expect(workspace.events.length).toBeGreaterThan(100);
        expect(workspace.items).toHaveLength(1);
        expect(workspace.total).toBe(2);
        expect(workspace.events.some((event) => event.id === "audit-crp")).toBe(true);
        expect(workspace.events.some((event) => event.id === "audit-rx")).toBe(actor.id === vet.id);
        expect(workspace.events.some((event) => event.id === "audit-shared-sample")).toBe(actor.id === vet.id);
        const search = await pgService.search(actor, "Synthetic Reviewer Zeta");
        expect(search).toEqual(await memoryService.search(actor, "Synthetic Reviewer Zeta"));
        expect(search.items.map((entry) => entry.id)).toEqual(["request-audit-mixed"]);
      }
      await expect(pgService.timeline(lab, "request-audit-other")).rejects.toMatchObject({ status: 404, code: "SCOPE_DENIED" });
      await expect(pgService.timeline(lab, "request-audit-mixed", "item-audit-rx")).rejects.toMatchObject({ status: 404, code: "SCOPE_DENIED" });
      await expect(pgService.getPatientDiagnostics(vet, "patient-mel")).rejects.toMatchObject({ status: 404, code: "SCOPE_DENIED" });
      const pairs = await postgres.readAuditActors([{ entityType: "DiagnosticRequestItem", entityId: "item-audit-lab" }]);
      expect(pairs).toContainEqual({ entityId: "item-audit-lab", actorId: "user-audit-reviewer" });
      expect(pairs.filter((pair) => pair.actorId === "user-audit-reviewer")).toHaveLength(1);
      expect(pairs.every((pair) => pair.entityId === "item-audit-lab")).toBe(true);
      expect([...pairs].sort((a, b) => a.actorId.localeCompare(b.actorId))).toEqual((await memory.readAuditActors(scope.entities)).sort((a, b) => a.actorId.localeCompare(b.actorId)));
      // The search's restricted form: only the actors it passes, the same answer as memory.
      const restricted = await postgres.readAuditActors([{ entityType: "DiagnosticRequestItem", entityId: "item-audit-lab" }], ["user-audit-reviewer", "user-nobody"]);
      expect(restricted).toEqual([{ entityId: "item-audit-lab", actorId: "user-audit-reviewer" }]);
      expect(await postgres.readAuditActors([{ entityType: "DiagnosticRequestItem", entityId: "item-audit-lab" }], [])).toEqual([]);
      expect(postgres.getState().auditEvents).toEqual([]);
    });
  });

  it("requires this actor's real ResultViewed evidence and retains it after reopening with a single-client pool", async () => {
    vi.stubEnv("DB_POOL_MAX", "1");
    try {
      await withDisposablePostgresDatabase(async (database) => {
        const store = await database.createStore(createDemoState(TEST_PASSWORD));
        const { service, vet, lab, released } = await createReleasedResult(store);
        const reviewInput = { versionId: released.version.id, expectedVersion: released.item.version, idempotencyKey: "audit-real-review" };
        // A read by another actor must never satisfy the veterinarian's prerequisite.
        await service.getResult(lab, released.result.id);
        const beforeRejectedReview = await store.readStateSnapshot();
        await expect(service.reviewResult(vet, released.result.id, reviewInput)).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 });
        expect(await store.readStateSnapshot()).toEqual(beforeRejectedReview);
        await service.viewResult(vet, released.version.id, { expectedVersion: released.item.version, idempotencyKey: "audit-real-view" });
        expect(store.getState().auditEvents).toEqual([]);
        await database.closeStore(store);
        const reopened = await database.createStore();
        const evidence = { eventType: "ResultViewed", entityType: "ResultVersion", entityId: released.version.id, actorId: vet.id };
        await reopened.transaction(async (state, audit) => {
          expect(state.auditEvents).toEqual([]);
          expect(audit).toBeDefined();
          expect(await audit!.hasAuditEvent(evidence)).toBe(true);
          expect(await audit!.hasAuditEvent({ ...evidence, actorId: "unknown-actor" })).toBe(false);
          expect(await audit!.hasAuditEvent({ ...evidence, entityType: "Result" })).toBe(false);
          expect(await audit!.hasAuditEvent({ ...evidence, eventType: "ResultReviewed" })).toBe(false);
          return { state, result: undefined };
        });
        const reopenedService = createApplicationService(reopened);
        await expect(reopenedService.reviewResult(vet, released.result.id, reviewInput)).resolves.toMatchObject({ item: { status: "REVIEWED" } });
        const history = await reopened.readAuditEvents({ scope: { entities: [{ entityType: "ResultVersion", entityId: released.version.id }] }, order: "asc", limit: 1000 });
        expect(history.items.filter((event) => event.eventType === "ResultViewed" && event.actorId === vet.id)).toHaveLength(1);
        expect(history.items.filter((event) => event.eventType === "ResultReviewed" && event.actorId === vet.id)).toHaveLength(1);
        expect((await reopened.readState()).auditEvents).toEqual([]);
        expect((await reopenedService.timeline(vet, released.request.id)).items).toEqual(expect.arrayContaining(history.items));
        expect((await reopenedService.getPatientDiagnostics(vet, "patient-thor")).events).toEqual(expect.arrayContaining(history.items));
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rolls back clinical rows, snapshot version and prior inserts for both changed and identical duplicate audits", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const store = await database.createRelationalStore(createDemoState(TEST_PASSWORD));
      // Shadow transactions require reference rows, as in the sample-lineage suite.
      await database.query("INSERT INTO departments (id, code, name, kind) VALUES ('INPATIENT','INPATIENT','Synthetic inpatient','CLINICAL'),('LABORATORY','LABORATORY','Synthetic laboratory','DIAGNOSTICS')");
      await database.query("INSERT INTO users (id, email, display_name, password_hash, timezone) VALUES ('user-vet','vet@cvg.local','Synthetic vet','synthetic-hash','UTC')");
      await database.query("INSERT INTO patients (id, display_name, species, breed, sex, external_id) VALUES ('patient-thor','Synthetic Thor','Canino','SRD','Macho','AUDIT-THOR-001')");
      await database.query("INSERT INTO encounters (id, patient_id, type, status, opened_at) VALUES ('encounter-thor','patient-thor','INPATIENT','OPEN',$1)", [OCCURRED_AT]);
      await database.query("INSERT INTO diagnostic_services (id, code, name, category, department_id, workflow_type, requires_sample, result_schema) VALUES ('service-crp','CRP','Synthetic CRP','LABORATORY','LABORATORY','LABORATORY',true,'NARRATIVE')");
      const vet = store.getState().users.find((user) => user.id === "user-vet")!;
      const request = await createApplicationService(store).createRequest(vet, {
        patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-crp" }]
      }, { idempotencyKey: "audit-conflict-request" });
      const before = await store.readStateSnapshot();
      const beforeClinical = await database.query("SELECT id, priority, version FROM diagnostic_requests ORDER BY id");
      const beforeItems = await database.query("SELECT id, priority, version FROM diagnostic_request_items ORDER BY id");
      const beforeAudits = await store.readAuditEvents(ALL_AUDITS);
      const duplicate = beforeAudits.items[0];
      expect(duplicate).toBeDefined();
      const pending = auditEvent("audit-before-conflict", { entityId: request.items[0].id });
      for (const attempted of [{ ...duplicate, metadata: { attemptedRewrite: true } }, duplicate]) {
        await expect(store.transaction((state) => ({
          state: { ...state,
            requests: state.requests.map((entry) => entry.id === request.id ? { ...entry, priority: "URGENT", version: entry.version + 1 } : entry),
            items: state.items.map((entry) => entry.id === request.items[0].id ? { ...entry, priority: "URGENT", version: entry.version + 1 } : entry),
            auditEvents: [pending, attempted]
          }, result: undefined
        }))).rejects.toThrow(`POSTGRES_AUDIT_PROJECTION_DIVERGED:${duplicate.id}`);
        expect(await store.readStateSnapshot()).toEqual(before);
        expect(store.getState()).toEqual(before.state);
        expect(await database.query("SELECT id, priority, version FROM diagnostic_requests ORDER BY id")).toEqual(beforeClinical);
        expect(await database.query("SELECT id, priority, version FROM diagnostic_request_items ORDER BY id")).toEqual(beforeItems);
        expect(await store.readAuditEvents(ALL_AUDITS)).toEqual(beforeAudits);
        expect(await database.query("SELECT id FROM audit_events WHERE id = $1", [pending.id])).toEqual({ rows: [], rowCount: 0 });
      }
    });
  });

  it("reconciles matching, missing and table-only audits from 012, clears only snapshot history, rejects stale writers and reruns safely", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      await with012Probe(database, async (probe) => {
        const matching = auditEvent("audit-upgrade-matching");
        const missing = auditEvent("audit-upgrade-missing", { actorId: undefined, previousState: undefined, newState: undefined });
        const tableOnly = auditEvent("audit-upgrade-table-only");
        const state = { ...createDemoState(TEST_PASSWORD), auditEvents: [matching, missing] };
        await probe.query("INSERT INTO cvg_runtime_state (id, state, version) VALUES (1, $1::jsonb, 7)", [JSON.stringify(state)]);
        await insertAudit(probe, matching);
        await insertAudit(probe, tableOnly);
        const matchingBefore = await probe.query("SELECT * FROM audit_events WHERE id = $1", [matching.id]);
        expect((await probe.upgrade()).applied).toEqual([CUTOVER_VERSION]);
        expect(await probe.query("SELECT state, version::text FROM cvg_runtime_state WHERE id = 1")).toMatchObject({ rows: [{ state: { ...state, auditEvents: [] }, version: "8" }] });
        expect(await probe.query("SELECT * FROM audit_events WHERE id = $1", [matching.id])).toEqual(matchingBefore);
        const history = await readPostgresAuditEvents(probe.sql, ALL_AUDITS);
        expect(history.items).toEqual([matching, missing, tableOnly]);
        expect(history.total).toBe(3);
        expect(await probe.query("SELECT schema_version FROM relational_schema_markers")).toMatchObject({ rows: [{ schema_version: CUTOVER_VERSION }] });
        expect(await cutoverArtifacts(probe)).toEqual([{ ledger: 1, guard: 1, indexes: 4, boundary: 1 }]);
        const beforeStaleWriter = await snapshot(probe);
        await expect(probe.query("UPDATE cvg_runtime_state SET state = $1::jsonb, version = version + 1 WHERE id = 1", [JSON.stringify({ ...state, protocolSequence: 999 })])).rejects.toMatchObject({ code: "23514", constraint: "runtime_audit_is_transient" });
        expect(await snapshot(probe)).toEqual(beforeStaleWriter);
        await expect(probe.upgrade()).resolves.toEqual({ applied: [], alreadyApplied: RUNTIME_MIGRATION_VERSIONS.filter((version) => version <= CUTOVER_VERSION) });
        expect(await snapshot(probe)).toEqual(beforeStaleWriter);
        expect(await readPostgresAuditEvents(probe.sql, ALL_AUDITS)).toEqual(history);
        await expect(probe.query("UPDATE audit_events SET event_type = 'Rewritten' WHERE id = $1", [matching.id])).rejects.toThrow("AUDIT_EVENTS_ARE_APPEND_ONLY");
        await expect(probe.query("DELETE FROM audit_events WHERE id = $1", [matching.id])).rejects.toThrow("AUDIT_EVENTS_ARE_APPEND_ONLY");

        // With writers stopped in this isolated schema, reconstruct the legacy
        // payload from table authority, including events committed after 013.
        const afterCutover = auditEvent("audit-upgrade-after-cutover", { metadata: { synthetic: true, nullable: null }, occurredAt: "2026-09-15T12:01:00.000Z" });
        await insertAudit(probe, afterCutover);
        const rollbackHistory = await readPostgresAuditEvents(probe.sql, ALL_AUDITS);
        await probe.query("BEGIN");
        try {
          await probe.query("SELECT id FROM cvg_runtime_state WHERE id = 1 FOR UPDATE");
          await probe.query("ALTER TABLE cvg_runtime_state DROP CONSTRAINT runtime_audit_is_transient");
          await probe.query(`WITH history AS (
            SELECT COALESCE(jsonb_agg(
              jsonb_build_object('id', id, 'eventType', event_type, 'entityType', entity_type, 'entityId', entity_id,
                'correlationId', correlation_id, 'metadata', metadata,
                'occurredAt', to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
              || CASE WHEN actor_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('actorId', actor_id) END
              || CASE WHEN previous_state IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('previousState', previous_state) END
              || CASE WHEN new_state IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('newState', new_state) END
              ORDER BY occurred_at, id COLLATE "C"), '[]'::jsonb) AS events FROM audit_events
          ) UPDATE cvg_runtime_state SET state = jsonb_set(state, '{auditEvents}', history.events), version = version + 1 FROM history WHERE id = 1`);
          await probe.query("COMMIT");
        } catch (error) {
          await probe.query("ROLLBACK");
          throw error;
        }
        expect(await probe.query("SELECT state, version::text FROM cvg_runtime_state WHERE id = 1")).toMatchObject({ rows: [{ state: { ...state, auditEvents: rollbackHistory.items }, version: "9" }] });
        expect(await readPostgresAuditEvents(probe.sql, ALL_AUDITS)).toEqual(rollbackHistory);
      });
    });
  });

  it("fails closed for every persisted field mismatch and duplicate ID, rolls back a late cutover failure, then recovers", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      await with012Probe(database, async (probe) => {
        const persisted = auditEvent("audit-upgrade-persisted");
        const missing = auditEvent("audit-upgrade-not-yet-projected");
        const state = { ...createDemoState(TEST_PASSWORD), auditEvents: [missing, persisted] };
        await probe.query("INSERT INTO cvg_runtime_state (id, state, version) VALUES (1, $1::jsonb, 7)", [JSON.stringify(state)]);
        await insertAudit(probe, persisted);
        const beforeTable = await probe.query("SELECT * FROM audit_events ORDER BY id");
        // Subset upgrades may have a future marker; compare the actual baseline.
        const beforeMarker = await probe.query("SELECT * FROM relational_schema_markers");
        const beforeBoundary = await probe.query("SELECT * FROM runtime_storage_boundaries ORDER BY boundary_key");
        const beforeLedger = await probe.query("SELECT * FROM schema_migrations ORDER BY version");
        const assertUnchanged = async (beforeSnapshot: Awaited<ReturnType<typeof snapshot>>) => {
          expect(await snapshot(probe)).toEqual(beforeSnapshot);
          expect(await probe.query("SELECT * FROM audit_events ORDER BY id")).toEqual(beforeTable);
          expect(await probe.query("SELECT * FROM relational_schema_markers")).toEqual(beforeMarker);
          expect(await probe.query("SELECT * FROM runtime_storage_boundaries ORDER BY boundary_key")).toEqual(beforeBoundary);
          expect(await probe.query("SELECT * FROM schema_migrations ORDER BY version")).toEqual(beforeLedger);
          expect(await cutoverArtifacts(probe)).toEqual([{ ledger: 0, guard: 0, indexes: 0, boundary: 0 }]);
        };
        const mismatches: Partial<AuditEvent>[] = [
          { eventType: "DifferentType" }, { actorId: undefined }, { entityType: "ResultVersion" },
          { entityId: "different-entity" }, { previousState: undefined }, { newState: "DIFFERENT" },
          { correlationId: "different-correlation" }, { metadata: { synthetic: true, value: 2 } },
          { occurredAt: "2026-09-15T12:00:00.001Z" }
        ];
        for (const mismatch of mismatches) {
          await probe.query("UPDATE cvg_runtime_state SET state = $1::jsonb WHERE id = 1", [JSON.stringify({ ...state, auditEvents: [missing, { ...persisted, ...mismatch }] })]);
          const beforeSnapshot = await snapshot(probe);
          await expect(probe.upgrade(), `mismatch: ${Object.keys(mismatch)[0]}`).rejects.toThrow("AUDIT_CUTOVER_PROJECTION_DIVERGED");
          await assertUnchanged(beforeSnapshot);
        }
        await probe.query("UPDATE cvg_runtime_state SET state = $1::jsonb WHERE id = 1", [JSON.stringify({ ...state, auditEvents: [missing, persisted, persisted] })]);
        const beforeDuplicate = await snapshot(probe);
        await expect(probe.upgrade()).rejects.toThrow("AUDIT_CUTOVER_DUPLICATE_ID");
        await assertUnchanged(beforeDuplicate);

        await probe.query("UPDATE cvg_runtime_state SET state = $1::jsonb WHERE id = 1", [JSON.stringify(state)]);
        await probe.query(`CREATE FUNCTION reject_audit_cutover_boundary() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.boundary_key = 'audit-events-v1' THEN RAISE EXCEPTION 'LATE_AUDIT_CUTOVER_TEST_FAILURE'; END IF; RETURN NEW; END; $$`);
        await probe.query("CREATE TRIGGER reject_audit_cutover_boundary BEFORE INSERT ON runtime_storage_boundaries FOR EACH ROW EXECUTE FUNCTION reject_audit_cutover_boundary()");
        const beforeLateFailure = await snapshot(probe);
        await expect(probe.upgrade()).rejects.toThrow("LATE_AUDIT_CUTOVER_TEST_FAILURE");
        await assertUnchanged(beforeLateFailure);
        await probe.query("DROP TRIGGER reject_audit_cutover_boundary ON runtime_storage_boundaries");
        await expect(probe.upgrade()).resolves.toEqual({ applied: [CUTOVER_VERSION], alreadyApplied: RUNTIME_MIGRATION_VERSIONS.filter((version) => version < CUTOVER_VERSION) });
        expect((await readPostgresAuditEvents(probe.sql, ALL_AUDITS)).items).toEqual([missing, persisted]);
        expect(await probe.query("SELECT state, version::text FROM cvg_runtime_state WHERE id = 1")).toMatchObject({ rows: [{ state: { ...state, auditEvents: [] }, version: "8" }] });
        await expect(probe.upgrade()).resolves.toEqual({ applied: [], alreadyApplied: RUNTIME_MIGRATION_VERSIONS.filter((version) => version <= CUTOVER_VERSION) });
      });
    });
  });
});
