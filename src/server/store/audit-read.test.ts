import { describe, expect, it, vi } from "vitest";
import type { AuditEvent, AuditReadQuery } from "../domain/models";
import { createDemoState } from "./fixtures";
import { MemoryStore } from "./memory-store";
import { auditEventsForReset, readPostgresAuditEvents } from "./postgres-audit-read";

const event = (id: string, entityType = "DiagnosticRequest", entityId = "request-visible"): AuditEvent => ({
  id, eventType: "RequestCreated", entityType, entityId, correlationId: "correlation", metadata: { first: true, second: 2 }, occurredAt: "2026-10-04T00:00:00.000Z"
});
const query: AuditReadQuery = { scope: { entities: [{ entityType: "DiagnosticRequest", entityId: "request-visible" }] }, order: "desc", limit: 1 };

describe("audit read contract", () => {
  it("paginates tied timestamps without missing mixed-case IDs, and isolates returned metadata", async () => {
    const store = new MemoryStore({ ...createDemoState("audit-contract"), auditEvents: [event("a"), event("A"), event("hidden", "DiagnosticRequest", "other")] });
    const first = await store.readAuditEvents(query);
    expect(first).toEqual({ items: [event("A")], total: 2, hasMore: true });
    first.items[0].metadata.first = false;
    const second = await store.readAuditEvents({ ...query, cursor: { occurredAt: first.items[0].occurredAt, id: first.items[0].id } });
    expect(second).toEqual({ items: [event("a")], total: 2, hasMore: false });
    expect((await store.readAuditEvents(query)).items[0].metadata.first).toBe(true);
    expect(await store.readAuditEvents({ ...query, cursor: { occurredAt: second.items[0].occurredAt, id: "z" } })).toEqual({ items: [], total: 2, hasMore: false });
  });

  it("keeps unresolved ADMIN and management type scopes distinct from resolved clinical resources", async () => {
    const store = new MemoryStore({ ...createDemoState("audit-scopes"), auditEvents: [event("clinical"), event("reason", "ReasonCode", "missing"), event("system", "RuntimeState", "runtime")] });
    expect((await store.readAuditEvents({ ...query, scope: { entities: [], entityTypes: ["ReasonCode"] }, limit: 100 })).items.map(({ id }) => id)).toEqual(["reason"]);
    expect((await store.readAuditEvents({ ...query, scope: { entities: [], unresolved: { resolvedEntities: query.scope.entities } }, limit: 100 })).items.map(({ id }) => id)).toEqual(["reason", "system"]);
    expect((await store.readAuditEvents({ ...query, scope: { entities: [] } })).total).toBe(0);
  });

  it("rejects invalid read budgets and timestamps before contacting PostgreSQL", async () => {
    const sql = { query: vi.fn() };
    for (const limit of [0, 1001, 1.5, Number.NaN]) await expect(readPostgresAuditEvents(sql, { ...query, limit })).rejects.toThrow("AUDIT_READ_QUERY_INVALID");
    await expect(readPostgresAuditEvents(sql, { ...query, cursor: { occurredAt: "invalid", id: "a" } })).rejects.toThrow("AUDIT_READ_CURSOR_INVALID");
    expect(sql.query).not.toHaveBeenCalled();
  });

  it("deduplicates reviewer actors across event types using the existing entity-ID search contract", async () => {
    const store = new MemoryStore({ ...createDemoState("audit-actors"), auditEvents: [event("no-actor"), { ...event("a"), actorId: "reviewer" }, { ...event("b", "Other"), actorId: "reviewer" }, { ...event("c", "Other", "other"), actorId: "hidden" }] });
    expect(await store.readAuditActors(query.scope.entities)).toEqual([{ entityId: "request-visible", actorId: "reviewer" }]);
    expect(await store.readAuditActors([])).toEqual([]);
    // Restricted to the actors the search passes; an empty list reads nothing.
    expect(await store.readAuditActors(query.scope.entities, ["reviewer"])).toEqual([{ entityId: "request-visible", actorId: "reviewer" }]);
    expect(await store.readAuditActors(query.scope.entities, ["hidden", "nobody"])).toEqual([]);
    expect(await store.readAuditActors(query.scope.entities, [])).toEqual([]);
  });

  it("aggregates clinical metrics with duplicate recollections, unknown versions and invalid clocks", async () => {
    const events = [
      { ...event("recollect-a"), eventType: "RecollectionRequested", entityId: "sample" },
      { ...event("recollect-b"), eventType: "RecollectionRequested", entityId: "sample" },
      { ...event("normal"), eventType: "ResultViewed", entityId: "version", occurredAt: "2026-10-04T00:30:00.000Z" },
      { ...event("early"), eventType: "ResultViewed", entityId: "version", occurredAt: "2026-10-03T23:59:59.000Z" },
      { ...event("missing"), eventType: "ResultViewed", entityId: "missing" },
      { ...event("invalid"), eventType: "ResultViewed", entityId: "version", occurredAt: "invalid" }
    ];
    const store = new MemoryStore({ ...createDemoState("audit-metrics-unit"), auditEvents: events });
    expect(await store.readAuditMetrics({ requestCount: 2, samples: [{ id: "sample", requestId: "request" }], releasedVersions: [{ id: "version", releasedAtMs: Date.parse(event("base").occurredAt) }] })).toEqual({ recollectionRate: 0.5, resultViewLatencySeconds: 900 });
    expect(await store.readAuditMetrics({ requestCount: 0, samples: [], releasedVersions: [] })).toEqual({ recollectionRate: undefined, resultViewLatencySeconds: undefined });
  });

  it("resets with identical durable events despite metadata order/timestamp encoding and rejects mutations", async () => {
    const saved = event("existing");
    const sql = { query: vi.fn().mockResolvedValue({ rows: [saved] }) };
    const replay = { ...saved, metadata: { second: 2, first: true }, occurredAt: "2026-10-03T21:00:00-03:00" };
    expect(await auditEventsForReset(sql, [replay, event("new")])).toEqual([event("new")]);
    await expect(auditEventsForReset(sql, [{ ...saved, metadata: { first: false } }])).rejects.toThrow("POSTGRES_AUDIT_LOG_MUTATION");
    sql.query.mockClear();
    expect(await auditEventsForReset(sql, [])).toEqual([]);
    expect(sql.query).not.toHaveBeenCalled();
  });
});
