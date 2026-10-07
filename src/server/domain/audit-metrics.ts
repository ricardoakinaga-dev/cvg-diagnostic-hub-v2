import type { AuditEvent, AuditMetrics, AuditMetricsQuery } from "./models";

export function auditMetrics(events: AuditEvent[], query: AuditMetricsQuery): AuditMetrics {
  const samples = new Map(query.samples.map((sample) => [sample.id, sample.requestId]));
  const releasedVersions = new Map(query.releasedVersions.map((version) => [version.id, version.releasedAtMs]));
  const recollections = new Set<string>();
  const latencies: number[] = [];
  for (const event of events) {
    const requestId = samples.get(event.entityId);
    if (event.eventType === "RecollectionRequested" && requestId) recollections.add(requestId);
    if (event.eventType === "ResultViewed") {
      const start = releasedVersions.get(event.entityId);
      const latency = start === undefined ? Number.NaN : (Date.parse(event.occurredAt) - start) / 1000;
      if (Number.isFinite(latency)) latencies.push(Math.max(0, latency));
    }
  }
  return { recollectionRate: query.requestCount > 0 ? recollections.size / query.requestCount : undefined,
    resultViewLatencySeconds: latencies.length ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : undefined };
}
