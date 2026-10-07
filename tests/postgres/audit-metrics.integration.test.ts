import { describe, expect, it } from "vitest";
import type { AuditEvent } from "../../src/server/domain/models";
import { operationalAuditQuery, refreshOperationalMetrics, renderPrometheus, resetMetrics } from "../../src/server/observability/metrics";
import { createDemoState } from "../../src/server/store/fixtures";
import { MemoryStore } from "../../src/server/store/memory-store";
import { withDisposablePostgresDatabase } from "../support/postgres-test-harness";

describe("authoritative PostgreSQL audit metrics", () => {
  it("preserves recollection rates and view latency across restart without loading historical events", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const state = createDemoState("audit-metrics-synthetic");
      const time = "2026-10-04T00:00:00.000Z";
      state.requests = [{ id: "request-metrics", requestCode: "METRICS-001", patientId: "patient-thor", encounterId: "encounter-thor", requesterId: "user-vet", requestingDepartmentCode: "INPATIENT", priority: "ROUTINE", aggregateStatus: "REQUESTED", itemIds: [], createdAt: time, updatedAt: time, version: 1 }];
      state.samples = [{ id: "sample-metrics", requestId: state.requests[0].id, accessionCode: "METRICS-SAMPLE-001", sampleType: "EDTA", status: "EXPECTED", itemIds: [], version: 1 }];
      state.resultVersions = [{ id: "version-metrics", resultId: "result-metrics", sequence: 1, status: "RELEASED", content: {}, narrative: "", authorId: "user-lab", createdAt: time, releasedAt: time, critical: false, needsReReview: false, version: 1 }];
      const event = (id: string, eventType: string, entityId: string, occurredAt = time): AuditEvent => ({ id, eventType, entityType: "SyntheticMetrics", entityId, correlationId: "correlation-metrics", metadata: {}, occurredAt });
      state.auditEvents = [event("recollection-a", "RecollectionRequested", "sample-metrics"), event("recollection-b", "RecollectionRequested", "sample-metrics"), event("recollection-orphan", "RecollectionRequested", "missing"),
        event("view-normal", "ResultViewed", "version-metrics", "2026-10-04T00:30:00.000Z"), event("view-before", "ResultViewed", "version-metrics", "2026-10-03T23:59:59.000Z"), event("view-orphan", "ResultViewed", "missing")];
      const store = await database.createStore(state);
      await database.closeStore(store);
      const reopened = await database.createStore();
      const snapshot = await reopened.readState();
      expect(snapshot.auditEvents).toEqual([]);
      const query = operationalAuditQuery(snapshot);
      const actual = await reopened.readAuditMetrics(query);
      expect(actual).toEqual({ recollectionRate: 1, resultViewLatencySeconds: 900 });
      expect(actual).toEqual(await new MemoryStore(state).readAuditMetrics(query));
      resetMetrics();
      refreshOperationalMetrics(snapshot, new Date(time), actual);
      expect(renderPrometheus()).toContain("cvg_recollection_rate 1");
      expect(renderPrometheus()).toContain("cvg_result_view_latency_seconds 900");
      expect(await reopened.readAuditMetrics({ requestCount: 0, samples: [], releasedVersions: [] })).toEqual({ recollectionRate: undefined, resultViewLatencySeconds: undefined });
      expect(await reopened.readAuditMetrics({ ...query, releasedVersions: [{ id: "version-metrics", releasedAtMs: Number.NaN }] })).toEqual({ recollectionRate: 1, resultViewLatencySeconds: undefined });
      resetMetrics();
      refreshOperationalMetrics(snapshot, new Date(time), { recollectionRate: undefined, resultViewLatencySeconds: undefined });
      expect(renderPrometheus()).not.toMatch(/^cvg_result_view_latency_seconds /m);
      expect(renderPrometheus()).not.toMatch(/^cvg_recollection_rate /m);
    });
  });
});
