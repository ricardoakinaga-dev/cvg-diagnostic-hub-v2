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
const allowedGauges = new Set(["outbox_pending", "outbox_oldest_age_seconds", "readiness_failures", "sse_connections"]);
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
  for (const [name, value] of [...gauges.entries()].sort(([left], [right]) => left.localeCompare(right))) lines.push(`cvg_${name} ${value}`);
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
