import type { StoreState } from "../../src/server/domain/models";
import { describe, expect, it, vi } from "vitest";
import { createApplicationService } from "../../src/server/application/service";
import { assertRateLimit, closeRateLimitBackend } from "../../src/server/security/rate-limit";
import { authenticateRequest, authorizationSnapshotIsCurrent, loginUser, revokeSession } from "../../src/server/security/session";
import { createDemoState } from "../../src/server/store/fixtures";
import type { PostgresStore } from "../../src/server/store/postgres-store";
import { withDisposablePostgresDatabase } from "../support/postgres-test-harness";

const TEST_PASSWORD = "postgres-integration-password";

type FreshReadablePostgresStore = PostgresStore & {
  readState(): Promise<StoreState>;
};

function asFreshReadable(store: PostgresStore): FreshReadablePostgresStore {
  return store as FreshReadablePostgresStore;
}

describe("PostgresStore multi-instance integration", () => {
  it("observes a commit from another store through a fresh read", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const first = await database.createStore(createDemoState(TEST_PASSWORD));
      const second = await database.createStore();
      const initialSequence = second.getState().protocolSequence;

      await first.transaction((state) => ({
        state: { ...state, protocolSequence: state.protocolSequence + 1 },
        result: undefined
      }));

      const freshState = await asFreshReadable(second).readState();
      expect(freshState.protocolSequence).toBe(initialSequence + 1);
    });
  });

  it("authenticates a cross-instance login and rejects its cross-instance revocation", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const sessionWriter = await database.createStore(createDemoState(TEST_PASSWORD));
      const requestReader = await database.createStore();
      const login = await loginUser(sessionWriter, "vet@cvg.local", TEST_PASSWORD);
      const authenticatedRequest = new Request("http://localhost/api/v1/me", {
        headers: { cookie: `cvg_session=${login.sessionToken}` }
      });

      const actorBeforeRevocation = await authenticateRequest(requestReader, authenticatedRequest);
      expect(actorBeforeRevocation).toMatchObject({ email: "vet@cvg.local" });

      await revokeSession(sessionWriter, login.sessionToken);

      const revokedSnapshot = await asFreshReadable(requestReader).readState();
      expect(authorizationSnapshotIsCurrent(revokedSnapshot, actorBeforeRevocation)).toBe(false);

      await expect(authenticateRequest(requestReader, authenticatedRequest)).rejects.toMatchObject({
        code: "SESSION_EXPIRED",
        status: 401
      });
    });
  });

  it("rejects an actor in another instance immediately after a persisted role change", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const writer = await database.createStore(createDemoState(TEST_PASSWORD));
      const reader = await database.createStore();
      const login = await loginUser(writer, "vet@cvg.local", TEST_PASSWORD);
      const request = new Request("http://localhost/api/v1/patients", {
        headers: { cookie: `cvg_session=${login.sessionToken}` }
      });
      const staleActor = await authenticateRequest(reader, request);

      await writer.transaction((state) => ({
        state: {
          ...state,
          users: state.users.map((user) => user.id === staleActor.id
            ? { ...user, role: "VIEWER", version: user.version + 1 }
            : user)
        },
        result: undefined
      }));

      await expect(createApplicationService(reader).listPatients(staleActor)).rejects.toMatchObject({
        code: "UNAUTHENTICATED",
        status: 401
      });
    });
  });

  it("serializes concurrent transactions from two stores without losing an update", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const first = await database.createStore(createDemoState(TEST_PASSWORD));
      const second = await database.createStore();
      const initialSequence = first.getState().protocolSequence;

      const committedSequences = await Promise.all([
        first.transaction((state) => ({
          state: { ...state, protocolSequence: state.protocolSequence + 1 },
          result: state.protocolSequence + 1
        })),
        second.transaction((state) => ({
          state: { ...state, protocolSequence: state.protocolSequence + 1 },
          result: state.protocolSequence + 1
        }))
      ]);

      const verifier = await database.createStore();
      const durableState = await asFreshReadable(verifier).readState();
      expect([...committedSequences].sort((left, right) => left - right)).toEqual([
        initialSequence + 1,
        initialSequence + 2
      ]);
      expect(durableState.protocolSequence).toBe(initialSequence + 2);
    });
  });

  it("keeps one canonical result lineage when two instances create a draft concurrently", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const first = await database.createStore(createDemoState(TEST_PASSWORD));
      const second = await database.createStore();
      const writer = createApplicationService(first);
      const competingWriter = createApplicationService(second);
      const requester = first.getState().users.find((user) => user.email === "vet@cvg.local");
      const actor = first.getState().users.find((user) => user.email === "lab@cvg.local");
      const competingActor = second.getState().users.find((user) => user.email === "lab@cvg.local");
      if (!requester || !actor || !competingActor) throw new Error("Synthetic fixture actor is missing.");

      const request = await writer.createRequest(requester, {
        patientId: "patient-thor",
        encounterId: "encounter-thor",
        priority: "ROUTINE",
        items: [{ serviceId: "service-hemogram" }]
      }, { idempotencyKey: "postgres-result-lineage-request" });
      const received = await writer.receiveSample(actor, [request.items[0].id], {
        accessionCode: "ACC-PG-LINEAGE",
        sampleType: "EDTA",
        expectedVersion: request.items[0].version,
        idempotencyKey: "postgres-result-lineage-receive"
      });
      const processing = await writer.startProcessing(actor, request.items[0].id, {
        expectedVersion: received.items[0].version,
        idempotencyKey: "postgres-result-lineage-process"
      });
      const input = (key: string) => ({
        narrative: "Resultado concorrente persistido.",
        content: { value: 7 },
        expectedVersion: processing.item.version,
        idempotencyKey: key
      });

      const attempts = await Promise.allSettled([
        writer.createResultDraft(actor, request.items[0].id, input("postgres-result-lineage-first")),
        competingWriter.createResultDraft(competingActor, request.items[0].id, input("postgres-result-lineage-second"))
      ]);

      expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
      expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
      const durableState = await asFreshReadable(second).readState();
      const item = durableState.items.find((entry) => entry.id === request.items[0].id);
      const results = durableState.results.filter((entry) => entry.itemId === request.items[0].id);
      expect(item?.currentResultId).toBe(results[0]?.id);
      expect(results).toHaveLength(1);
      expect(durableState.resultVersions.filter((version) => version.resultId === results[0]?.id)).toHaveLength(1);
      expect(durableState.auditEvents.filter((event) => event.eventType === "ResultDraftCreated")).toHaveLength(1);
      expect(durableState.outbox.filter((message) => message.eventType === "ResultDraftCreated")).toHaveLength(0);
    });
  });

  it("reloads committed domain state, audit events, and outbox messages after close", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const writer = await database.createStore(createDemoState(TEST_PASSWORD));
      const service = createApplicationService(writer);
      const actor = writer.getState().users.find((user) => user.email === "vet@cvg.local");
      if (!actor) throw new Error("Synthetic fixture actor is missing.");

      const created = await service.createRequest(
        actor,
        {
          patientId: "patient-thor",
          encounterId: "encounter-thor",
          priority: "ROUTINE",
          items: [{ serviceId: "service-hemogram" }]
        },
        { idempotencyKey: "postgres-durable-reload" }
      );
      await database.closeStore(writer);

      const reopened = await database.createStore();
      const durableState = await asFreshReadable(reopened).readState();
      expect(durableState.requests.some((request) => request.id === created.id)).toBe(true);
      expect(durableState.auditEvents.some((event) => event.entityId === created.id)).toBe(true);
      expect(durableState.outbox.some((message) => message.aggregateId === created.id)).toBe(true);
      const auditProjection = await database.query("SELECT id FROM audit_events WHERE entity_id = $1", [created.id]);
      const outboxProjection = await database.query("SELECT id FROM outbox_messages WHERE aggregate_id = $1", [created.id]);
      expect(auditProjection.rowCount).toBeGreaterThan(0);
      expect(outboxProjection.rowCount).toBeGreaterThan(0);
    });
  });

  it("repeats an authorized reset while retaining audit history and replacing the outbox projection", async () => {
    vi.stubEnv("ALLOW_DB_SMOKE_RESET", "true");
    try {
      await withDisposablePostgresDatabase(async (database) => {
        const fixture = createDemoState(TEST_PASSWORD);
        const store = await database.createStore(fixture);
        const service = createApplicationService(store);
        const actor = store.getState().users.find((user) => user.email === "vet@cvg.local");
        if (!actor) throw new Error("Synthetic fixture actor is missing.");

        const created = await service.createRequest(
          actor,
          {
            patientId: "patient-thor",
            encounterId: "encounter-thor",
            priority: "ROUTINE",
            items: [{ serviceId: "service-hemogram" }]
          },
          { idempotencyKey: "postgres-repeatable-reset" }
        );
        const auditIdsBeforeReset = store.getState().auditEvents.map((event) => event.id);
        expect(store.getState().outbox.length).toBeGreaterThan(0);

        await store.reset(fixture, { authorization: "ALLOW_DB_SMOKE_RESET" });
        await store.reset(fixture, { authorization: "ALLOW_DB_SMOKE_RESET" });

        const durableState = await asFreshReadable(store).readState();
        expect(durableState.requests.some((request) => request.id === created.id)).toBe(false);
        expect(durableState.auditEvents.slice(0, auditIdsBeforeReset.length).map((event) => event.id)).toEqual(auditIdsBeforeReset);
        const resetAuditEvents = durableState.auditEvents.filter((event) => event.eventType === "PostgresAdministrativeReset");
        expect(resetAuditEvents).toHaveLength(2);
        expect(resetAuditEvents.every((event) => event.actorId === undefined)).toBe(true);
        expect(resetAuditEvents.every((event) => event.metadata.authorization === "ALLOW_DB_SMOKE_RESET")).toBe(true);
        expect(durableState.outbox).toEqual([]);
        const auditProjection = await database.query("SELECT id FROM audit_events ORDER BY occurred_at, id");
        const outboxProjection = await database.query("SELECT id FROM outbox_messages");
        expect(auditProjection.rows).toHaveLength(auditIdsBeforeReset.length + 2);
        expect(outboxProjection.rows).toHaveLength(0);
        await expect(store.healthcheck()).resolves.toBeUndefined();
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rolls back the JSON snapshot when a relational audit projection conflicts", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const store = await database.createStore(createDemoState(TEST_PASSWORD));
      const initialSequence = store.getState().protocolSequence;
      const eventId = "audit-projection-conflict";
      await database.query(
        "INSERT INTO audit_events (id, event_type, entity_type, entity_id, correlation_id, metadata, occurred_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)",
        [eventId, "ConflictingAudit", "DiagnosticRequest", "request-conflict", "correlation-conflict", "{}", "2026-08-22T00:00:00.000Z"]
      );

      await expect(store.transaction((state) => ({
        state: {
          ...state,
          protocolSequence: state.protocolSequence + 1,
          auditEvents: [...state.auditEvents, {
            id: eventId,
            eventType: "AttemptedAudit",
            entityType: "DiagnosticRequest",
            entityId: "request-attempted",
            correlationId: "correlation-attempted",
            metadata: {},
            occurredAt: "2026-08-22T00:00:01.000Z"
          }]
        },
        result: undefined
      }))).rejects.toThrow(`POSTGRES_AUDIT_PROJECTION_DIVERGED:${eventId}`);

      const durableState = await asFreshReadable(store).readState();
      expect(durableState.protocolSequence).toBe(initialSequence);
      expect(durableState.auditEvents.some((event) => event.id === eventId)).toBe(false);
    });
  });

  it("blocks TRUNCATE against the relational audit projection", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      await database.createStore(createDemoState(TEST_PASSWORD));
      await expect(database.query("TRUNCATE audit_events")).rejects.toThrow("AUDIT_EVENTS_ARE_APPEND_ONLY");
      const boundary = await database.query("SELECT boundary_key, authoritative_store, status, reconciliation_mode FROM runtime_storage_boundaries");
      expect(boundary.rows).toEqual([expect.objectContaining({
        boundary_key: "runtime-jsonb-snapshot-v1",
        authoritative_store: "cvg_runtime_state",
        status: "TRANSITIONAL",
        reconciliation_mode: "CONTINUOUS"
      })]);
    });
  });

  it("enforces an atomic distributed rate-limit bucket in PostgreSQL", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      await database.createStore(createDemoState(TEST_PASSWORD));
      vi.stubEnv("DATABASE_URL", database.connectionString());
      vi.stubEnv("RATE_LIMIT_MODE", "postgres");
      try {
        const timestamp = Date.parse("2026-08-23T12:00:00.000Z");
        await assertRateLimit("integration-rate-limit", 2, 60_000, timestamp);
        await assertRateLimit("integration-rate-limit", 2, 60_000, timestamp + 1);
        await expect(assertRateLimit("integration-rate-limit", 2, 60_000, timestamp + 2)).rejects.toMatchObject({ code: "RATE_LIMITED", status: 429 });
        const bucket = await database.query("SELECT request_count FROM rate_limit_buckets WHERE bucket_key = $1", ["integration-rate-limit"]);
        expect(bucket.rows).toEqual([{ request_count: 3 }]);
      } finally {
        await closeRateLimitBackend();
        vi.unstubAllEnvs();
      }
    });
  });
});
