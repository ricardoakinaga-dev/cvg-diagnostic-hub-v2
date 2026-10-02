import { describe, expect, it } from "vitest";
import { createDemoState } from "../store/fixtures";
import { incrementGauge, recordHttpRequest, recordReadinessFailure, recordRealtimePoll, recordRealtimeResync, recordRealtimeStreamClosure, refreshOperationalMetrics, releaseRealtimeConnection, renderPrometheus, resetMetrics, routeMetricLabel, setGauge, tryAcquireRealtimeConnection } from "./metrics";

describe("bounded metrics", () => {
  it("renders stable labels without identifiers or request payloads", () => {
    resetMetrics();
    recordHttpRequest("GET", "/api/v1/diagnostic-items/[id]", 200, 12.5);
    setGauge("outbox_pending", 3);

    const output = renderPrometheus();

    expect(output).toContain('http_requests_total{method="GET",route="/api/v1/diagnostic-items/[id]",status="200"} 1');
    expect(output).toContain('http_request_duration_ms_count{method="GET",route="/api/v1/diagnostic-items/[id]"} 1');
    expect(output).toContain("cvg_outbox_pending 3");
    expect(output).not.toContain("patient-");
    expect(output).not.toContain("request-body");
  });

  it("ignores invalid gauges and normalizes malformed request measurements", () => {
    resetMetrics();
    recordHttpRequest("", "", 99, Number.NaN);
    setGauge("unknown_metric", 10);
    setGauge("outbox_pending", Number.NaN);

    const output = renderPrometheus();

    expect(output).toContain('method="UNKNOWN"');
    expect(output).toContain('route="/unknown"');
    expect(output).toContain('status="500"');
    expect(output).not.toContain("unknown_metric");
  });

  it("uses the operation segment for route labels instead of dynamic identifiers", () => {
    resetMetrics();
    recordHttpRequest("GET", routeMetricLabel(["patients", "patient-secret", "encounter-secret"]), 200, 1);

    const output = renderPrometheus();

    expect(output).toContain('route="/api/v1/patients"');
    expect(output).not.toContain("patient-secret");
    expect(output).not.toContain("encounter-secret");
  });

  it("refreshes bounded operational gauges without exposing event identifiers", () => {
    resetMetrics();
    const state = createDemoState();
    state.outbox = [
      { id: "outbox-one", eventType: "one", aggregateType: "Patient", aggregateId: "patient-secret", payload: {}, consumerType: "DOMAIN_EVENT", routingKey: "domain.one", status: "PENDING", attempts: 0, availableAt: "2026-08-20T09:59:00.000Z", correlationId: "corr-one" },
      { id: "outbox-two", eventType: "two", aggregateType: "Patient", aggregateId: "patient-secret", payload: {}, consumerType: "DOMAIN_EVENT", routingKey: "domain.two", status: "PROCESSING", attempts: 1, availableAt: "2026-08-20T09:59:30.000Z", correlationId: "corr-two" },
      { id: "outbox-three", eventType: "three", aggregateType: "Patient", aggregateId: "patient-secret", payload: {}, consumerType: "DOMAIN_EVENT", routingKey: "domain.three", status: "PROCESSED", attempts: 1, availableAt: "2026-08-20T09:58:00.000Z", correlationId: "corr-three" }
    ];

    refreshOperationalMetrics(state, new Date("2026-08-20T10:00:00.000Z"));
    incrementGauge("sse_connections");
    incrementGauge("sse_connections", -1);
    recordReadinessFailure();

    const output = renderPrometheus();
    expect(output).toContain("cvg_outbox_pending 2");
    expect(output).toContain("cvg_outbox_oldest_age_seconds 60");
    expect(output).toContain("cvg_sse_connections 0");
    expect(output).toContain("cvg_readiness_failures 1");
    expect(output).not.toContain("patient-secret");
  });

  it("renders business snapshot gauges without identifiers or clinical content", () => {
    resetMetrics();
    const state = createDemoState();
    state.requests = [{
      id: "request-secret",
      requestCode: "EX-260820-0001",
      patientId: "patient-secret",
      encounterId: "encounter-secret",
      requesterId: "user-secret",
      requestingDepartmentCode: "LABORATORY",
      priority: "ROUTINE",
      aggregateStatus: "IN_PROGRESS",
      itemIds: ["item-completed", "item-overdue", "item-cancelled"],
      createdAt: "2026-08-20T09:00:00.000Z",
      updatedAt: "2026-08-20T09:00:00.000Z",
      version: 1
    }];
    const item = (id: string, status: "COMPLETED" | "REQUESTED" | "CANCELLED", dueAt: string) => ({
      id,
      requestId: "request-secret",
      serviceId: "service-secret",
      departmentCode: "LABORATORY",
      workflowType: "LABORATORY" as const,
      priority: "ROUTINE" as const,
      status,
      requestedAt: "2026-08-20T09:00:00.000Z",
      slaStartedAt: "2026-08-20T09:00:00.000Z",
      dueAt,
      slaPolicyVersion: 1,
      version: 1
    });
    state.items = [
      item("item-completed", "COMPLETED", "2026-08-20T09:30:00.000Z"),
      item("item-overdue", "REQUESTED", "2026-08-20T09:59:00.000Z"),
      item("item-cancelled", "CANCELLED", "2026-08-20T09:00:00.000Z")
    ];
    state.items[0] = { ...state.items[0], completedAt: "2026-08-20T09:30:00.000Z" };
    state.results = [{ id: "result-secret", itemId: "item-completed", currentVersionId: "result-version-critical", lifecycleStatus: "RELEASED", needsReReview: false, version: 1 }];
    state.samples = [{ id: "sample-recollection", requestId: "request-secret", accessionCode: "PENDING-RECOLLECTION", sampleType: "EDTA", status: "EXPECTED", itemIds: ["item-overdue"], version: 1 }];
    state.auditEvents = [
      { id: "audit-recollection", eventType: "RecollectionRequested", actorId: "user-secret", entityType: "Sample", entityId: "sample-recollection", correlationId: "corr-recollection", metadata: {}, occurredAt: "2026-08-20T09:10:00.000Z" },
      { id: "audit-view", eventType: "ResultViewed", actorId: "user-secret", entityType: "ResultVersion", entityId: "result-version-critical", correlationId: "corr-view", metadata: {}, occurredAt: "2026-08-20T10:00:00.000Z" }
    ];
    state.resultVersions = [
      {
        id: "result-version-critical",
        resultId: "result-secret",
        sequence: 1,
        status: "RELEASED",
        content: { patientName: "clinical secret" },
        narrative: "clinical secret",
        authorId: "user-secret",
        createdAt: "2026-08-20T09:00:00.000Z",
        releasedAt: "2026-08-20T09:30:00.000Z",
        releasedBy: "user-secret",
        critical: true,
        needsReReview: false,
        version: 1
      },
      {
        id: "result-version-superseded",
        resultId: "result-secret",
        sequence: 2,
        status: "SUPERSEDED",
        content: {},
        narrative: "superseded",
        authorId: "user-secret",
        createdAt: "2026-08-20T09:00:00.000Z",
        critical: true,
        needsReReview: false,
        version: 1
      }
    ];

    refreshOperationalMetrics(state, new Date("2026-08-20T10:00:00.000Z"));

    const output = renderPrometheus();
    expect(output).toContain("cvg_diagnostic_requests_created 1");
    expect(output).toContain("cvg_diagnostic_items_completed 1");
    expect(output).toContain("cvg_diagnostic_turnaround_time_seconds 1800");
    expect(output).toContain("cvg_recollection_rate 1");
    expect(output).toContain("cvg_critical_results 1");
    expect(output).toContain("cvg_overdue_items 1");
    expect(output).toContain("cvg_result_view_latency_seconds 1800");
    expect(output).toContain("# TYPE cvg_recollection_rate gauge");
    expect(output).not.toContain("request-secret");
    expect(output).not.toContain("patient-secret");
    expect(output).not.toContain("clinical secret");
  });

  it("records realtime poll, failure, closure, resync, and capacity signals with bounded labels", () => {
    resetMetrics();
    recordRealtimePoll("stream", "success", 12.5);
    recordRealtimePoll("stream", "failure", 20, "poll_timeout");
    recordRealtimePoll("stream", "failure", 30, "patient-secret");
    recordRealtimeStreamClosure("poll_timeout");
    recordRealtimeResync("event_window_expired");

    expect(tryAcquireRealtimeConnection(1)).toBe(true);
    expect(tryAcquireRealtimeConnection(1)).toBe(false);
    releaseRealtimeConnection();

    const output = renderPrometheus();
    expect(output).toContain('cvg_realtime_poll_duration_ms_count{mode="stream",outcome="success"} 1');
    expect(output).toContain('cvg_realtime_poll_duration_ms_count{mode="stream",outcome="failure"} 2');
    expect(output).toContain('cvg_realtime_poll_failures_total{mode="stream",reason="poll_timeout"} 1');
    expect(output).toContain('cvg_realtime_poll_failures_total{mode="stream",reason="unknown"} 1');
    expect(output).toContain('cvg_realtime_stream_closures_total{reason="poll_timeout"} 1');
    expect(output).toContain('cvg_realtime_resyncs_total{reason="event_window_expired"} 1');
    expect(output).toContain('cvg_realtime_connection_rejections_total{reason="connection_limit"} 1');
    expect(output).toContain("cvg_sse_connections 0");
    expect(output).not.toContain("patient-secret");
  });
});
