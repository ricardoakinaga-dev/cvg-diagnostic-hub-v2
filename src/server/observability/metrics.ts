import type { StoreState } from "../domain/models";

type HttpMetric = { count: number; totalDurationMs: number; maxDurationMs: number };
export type RealtimePollMode = "stream" | "snapshot";
export type RealtimePollOutcome = "success" | "failure";

const httpMetrics = new Map<string, HttpMetric>();
const durationMetrics = new Map<string, HttpMetric>();
const realtimePollDurationMetrics = new Map<string, HttpMetric>();
const realtimePollFailures = new Map<string, number>();
const realtimeStreamClosures = new Map<string, number>();
const realtimeResyncs = new Map<string, number>();
const realtimeConnectionRejections = new Map<string, number>();
const gauges = new Map<string, number>();
const allowedGauges = new Set([
  "outbox_pending",
  "outbox_oldest_age_seconds",
  "readiness_failures",
  "sse_connections",
  "diagnostic_requests_created",
  "diagnostic_items_completed",
  "diagnostic_turnaround_time_seconds",
  "recollection_rate",
  "critical_results",
  "overdue_items",
  "result_view_latency_seconds"
]);
const gaugeHelp = new Map([
  ["outbox_pending", "Pending outbox messages."],
  ["outbox_oldest_age_seconds", "Age in seconds of the oldest pending outbox message."],
  ["readiness_failures", "Readiness checks that failed."],
  ["sse_connections", "Active realtime stream connections."],
  ["diagnostic_requests_created", "Current snapshot count of diagnostic requests."],
  ["diagnostic_items_completed", "Current snapshot count of completed diagnostic items."],
  ["diagnostic_turnaround_time_seconds", "Average seconds from item request to release or completion."],
  ["recollection_rate", "Fraction of requests with at least one recollection request."],
  ["critical_results", "Current released critical result versions."],
  ["overdue_items", "Current active diagnostic items past their due time."],
  ["result_view_latency_seconds", "Average seconds from result release to recorded view."]
]);
const terminalItemStates = new Set(["COMPLETED", "CANCELLED", "REJECTED"]);
const allowedRealtimePollModes = new Set<RealtimePollMode>(["stream", "snapshot"]);
const allowedRealtimePollOutcomes = new Set<RealtimePollOutcome>(["success", "failure"]);
const allowedRealtimePollFailureReasons = new Set([
  "state_read_failed",
  "poll_timeout",
  "enqueue_failed",
  "client_aborted",
  "stream_closed",
  "unknown"
]);
const allowedRealtimeClosureReasons = new Set([
  "authorization_revoked",
  "client_abort",
  "consumer_cancel",
  "poll_failure",
  "poll_timeout",
  "max_duration",
  "backpressure",
  "adapter_unavailable",
  "unknown"
]);
const allowedRealtimeResyncReasons = new Set(["event_window_expired", "unknown"]);
const allowedRealtimeConnectionRejectionReasons = new Set(["connection_limit", "unknown"]);

export function recordHttpRequest(method: string, route: string, status: number, durationMs: number): void {
  const safeMethod = method.toUpperCase().replaceAll(/[^A-Z]/g, "").slice(0, 12) || "UNKNOWN";
  const safeRoute = normalizeRoute(route);
  const safeStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? String(status) : "500";
  const safeDuration = Number.isFinite(durationMs) ? Math.max(0, Math.min(durationMs, 600_000)) : 0;
  addMetric(httpMetrics, `${safeMethod}|${safeRoute}|${safeStatus}`, safeDuration);
  addMetric(durationMetrics, `${safeMethod}|${safeRoute}`, safeDuration);
}

export function setGauge(name: string, value: number): void {
  if (!allowedGauges.has(name) || !Number.isFinite(value)) return;
  gauges.set(name, Math.max(0, Math.min(value, Number.MAX_SAFE_INTEGER)));
}

export function incrementGauge(name: string, delta = 1): void {
  if (!Number.isFinite(delta)) return;
  setGauge(name, (gauges.get(name) ?? 0) + delta);
}

export function recordReadinessFailure(): void {
  incrementGauge("readiness_failures");
}

export function recordRealtimePoll(
  mode: RealtimePollMode,
  outcome: RealtimePollOutcome,
  durationMs: number,
  failureReason?: string
): void {
  const safeMode = normalizeAllowedLabel(mode, allowedRealtimePollModes, "snapshot");
  const safeOutcome = normalizeAllowedLabel(outcome, allowedRealtimePollOutcomes, "failure");
  const safeDuration = safeDurationMs(durationMs);
  addMetric(realtimePollDurationMetrics, `${safeMode}|${safeOutcome}`, safeDuration);
  if (safeOutcome === "failure") recordRealtimePollFailure(failureReason, safeMode);
}

export function recordRealtimePollFailure(reason = "unknown", mode: RealtimePollMode = "stream"): void {
  const safeMode = normalizeAllowedLabel(mode, allowedRealtimePollModes, "snapshot");
  const safeReason = normalizeAllowedLabel(reason, allowedRealtimePollFailureReasons, "unknown");
  incrementCounter(realtimePollFailures, `${safeMode}|${safeReason}`);
}

export function recordRealtimeStreamClosure(reason = "unknown"): void {
  incrementCounter(realtimeStreamClosures, normalizeAllowedLabel(reason, allowedRealtimeClosureReasons, "unknown"));
}

export function recordRealtimeResync(reason = "unknown"): void {
  incrementCounter(realtimeResyncs, normalizeAllowedLabel(reason, allowedRealtimeResyncReasons, "unknown"));
}

export function recordRealtimeConnectionRejected(reason = "unknown"): void {
  incrementCounter(realtimeConnectionRejections, normalizeAllowedLabel(reason, allowedRealtimeConnectionRejectionReasons, "unknown"));
}

export function tryAcquireRealtimeConnection(maxConnections: number): boolean {
  const current = Math.max(0, gauges.get("sse_connections") ?? 0);
  if (!Number.isSafeInteger(maxConnections) || maxConnections < 1 || current >= maxConnections) {
    recordRealtimeConnectionRejected("connection_limit");
    return false;
  }
  setGauge("sse_connections", current + 1);
  return true;
}

export function releaseRealtimeConnection(): void {
  incrementGauge("sse_connections", -1);
}

export function refreshOperationalMetrics(state: StoreState, now = new Date()): void {
  const pending = state.outbox.filter((message) => message.status === "PENDING" || message.status === "PROCESSING");
  setGauge("outbox_pending", pending.length);
  const oldestAvailableAt = pending
    .map((message) => Date.parse(message.availableAt))
    .filter((timestamp) => Number.isFinite(timestamp))
    .sort((left, right) => left - right)[0];
  const oldestAgeSeconds = oldestAvailableAt === undefined ? 0 : Math.max(0, (now.getTime() - oldestAvailableAt) / 1_000);
  setGauge("outbox_oldest_age_seconds", oldestAgeSeconds);

  // Business measures are bounded snapshot gauges; rates and latency need event policy and timestamps.
  setGauge("diagnostic_requests_created", state.requests.length);
  setGauge("diagnostic_items_completed", state.items.filter((item) => item.status === "COMPLETED").length);
  const currentVersionIds = new Set(state.results.map((result) => result.currentVersionId).filter((id): id is string => Boolean(id)));
  setGauge("critical_results", state.resultVersions.filter((version) => version.status === "RELEASED" && version.critical && currentVersionIds.has(version.id)).length);
  const nowMs = now.getTime();
  const overdueItems = state.items.filter((item) => {
    if (terminalItemStates.has(item.status)) return false;
    const dueAtMs = Date.parse(item.dueAt);
    return Number.isFinite(dueAtMs) && dueAtMs < nowMs;
  });
  setGauge("overdue_items", overdueItems.length);

  const turnaroundSamples = state.items
    .map((item) => elapsedSeconds(item.requestedAt, item.completedAt ?? item.releasedAt))
    .filter((value): value is number => value !== undefined);
  setOptionalGauge("diagnostic_turnaround_time_seconds", average(turnaroundSamples));

  const recollectedRequestIds = new Set(
    state.auditEvents
      .filter((event) => event.eventType === "RecollectionRequested")
      .map((event) => state.samples.find((sample) => sample.id === event.entityId)?.requestId)
      .filter((requestId): requestId is string => Boolean(requestId))
  );
  setOptionalGauge(
    "recollection_rate",
    state.requests.length > 0 ? recollectedRequestIds.size / state.requests.length : undefined
  );

  const releasedAtByVersionId = new Map(
    state.resultVersions
      .filter((version) => version.releasedAt)
      .map((version) => [version.id, version.releasedAt as string])
  );
  const viewLatencySamples = state.auditEvents
    .filter((event) => event.eventType === "ResultViewed")
    .map((event) => elapsedSeconds(releasedAtByVersionId.get(event.entityId), event.occurredAt))
    .filter((value): value is number => value !== undefined);
  setOptionalGauge("result_view_latency_seconds", average(viewLatencySamples));
}

export function renderPrometheus(): string {
  const lines = [
    "# HELP http_requests_total Total HTTP requests handled by the application.",
    "# TYPE http_requests_total counter"
  ];
  for (const [key, metric] of [...httpMetrics.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const [method, route, status] = key.split("|");
    lines.push(`http_requests_total{method="${escapeLabel(method)}",route="${escapeLabel(route)}",status="${status}"} ${metric.count}`);
  }
  lines.push("# HELP http_request_duration_ms HTTP request duration summary counters.", "# TYPE http_request_duration_ms summary");
  for (const [key, metric] of [...durationMetrics.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const [method, route] = key.split("|");
    const labels = `method="${escapeLabel(method)}",route="${escapeLabel(route)}"`;
    lines.push(`http_request_duration_ms_sum{${labels}} ${metric.totalDurationMs.toFixed(3)}`);
    lines.push(`http_request_duration_ms_count{${labels}} ${metric.count}`);
    lines.push(`http_request_duration_ms_max{${labels}} ${metric.maxDurationMs.toFixed(3)}`);
  }
  lines.push(
    "# HELP cvg_realtime_poll_duration_ms Duration of bounded realtime state polls.",
    "# TYPE cvg_realtime_poll_duration_ms summary"
  );
  for (const [key, metric] of [...realtimePollDurationMetrics.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const [mode, outcome] = key.split("|");
    const labels = `mode="${escapeLabel(mode)}",outcome="${escapeLabel(outcome)}"`;
    lines.push(`cvg_realtime_poll_duration_ms_sum{${labels}} ${metric.totalDurationMs.toFixed(3)}`);
    lines.push(`cvg_realtime_poll_duration_ms_count{${labels}} ${metric.count}`);
    lines.push(`cvg_realtime_poll_duration_ms_max{${labels}} ${metric.maxDurationMs.toFixed(3)}`);
  }
  appendCounter(lines, "cvg_realtime_poll_failures_total", "Realtime poll failures.", realtimePollFailures, ["mode", "reason"]);
  appendCounter(lines, "cvg_realtime_stream_closures_total", "Realtime stream closures by bounded reason.", realtimeStreamClosures, ["reason"]);
  appendCounter(lines, "cvg_realtime_resyncs_total", "Realtime resync signals emitted.", realtimeResyncs, ["reason"]);
  appendCounter(lines, "cvg_realtime_connection_rejections_total", "Realtime connection attempts rejected by bounded capacity.", realtimeConnectionRejections, ["reason"]);
  for (const [name, value] of [...gauges.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const metricName = `cvg_${name}`;
    lines.push(`# HELP ${metricName} ${gaugeHelp.get(name) ?? "Bounded application gauge."}`, `# TYPE ${metricName} gauge`, `${metricName} ${value}`);
  }
  return `${lines.join("\n")}\n`;
}

export function resetMetrics(): void {
  httpMetrics.clear();
  durationMetrics.clear();
  realtimePollDurationMetrics.clear();
  realtimePollFailures.clear();
  realtimeStreamClosures.clear();
  realtimeResyncs.clear();
  realtimeConnectionRejections.clear();
  gauges.clear();
}

export function routeMetricLabel(path: readonly string[]): string {
  const first = path[0]?.replaceAll(/[^A-Za-z0-9_-]/g, "").slice(0, 60) || "root";
  return `/api/v1/${first}`;
}

function addMetric(target: Map<string, HttpMetric>, key: string, durationMs: number): void {
  const current = target.get(key) ?? { count: 0, totalDurationMs: 0, maxDurationMs: 0 };
  target.set(key, { count: current.count + 1, totalDurationMs: current.totalDurationMs + durationMs, maxDurationMs: Math.max(current.maxDurationMs, durationMs) });
}

function setOptionalGauge(name: string, value: number | undefined): void {
  if (value === undefined) {
    gauges.delete(name);
    return;
  }
  setGauge(name, value);
}

function elapsedSeconds(start: string | undefined, end: string | undefined): number | undefined {
  if (!start || !end) return undefined;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return undefined;
  return Math.max(0, (endMs - startMs) / 1_000);
}

function average(values: readonly number[]): number | undefined {
  return values.length === 0 ? undefined : values.reduce((total, value) => total + value, 0) / values.length;
}

function incrementCounter(target: Map<string, number>, key: string): void {
  target.set(key, (target.get(key) ?? 0) + 1);
}

function appendCounter(lines: string[], name: string, help: string, values: Map<string, number>, labelNames: readonly string[]): void {
  lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} counter`);
  for (const [key, value] of [...values.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const labelValues = key.split("|");
    const labels = labelNames.map((label, index) => `${label}="${escapeLabel(labelValues[index] ?? "unknown")}"`).join(",");
    lines.push(`${name}{${labels}} ${value}`);
  }
}

function normalizeAllowedLabel<T extends string>(value: string, allowed: ReadonlySet<T>, fallback: T): T {
  return allowed.has(value as T) ? value as T : fallback;
}

function safeDurationMs(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(value, 600_000)) : 0;
}

function normalizeRoute(route: string): string {
  const candidate = route.split("?")[0].trim();
  if (!candidate || candidate.length > 120) return "/unknown";
  return candidate.replaceAll(/\b(?:patient|encounter|admission|request|item|sample|procedure|result|attachment|session|outbox|corr|req|EX)-[A-Za-z0-9_-]+\b/g, "[id]");
}

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}
