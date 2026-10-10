import { getHeapStatistics } from "node:v8";
import type { AuditMetrics, AuditMetricsQuery, StoreState } from "../domain/models";
import { auditMetrics } from "../domain/audit-metrics";
import { outboxMetrics } from "../domain/outbox-read";
import { buildRevision } from "./build-info";

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
const realtimeSharedReads = new Map<string, number>();
const realtimeAuthorizationStaleness = new Map<string, number>();
const attachmentScans = new Map<string, number>();
// Every verdict renders from the start (zero), so alerts and dashboards can reference the series before the first upload.
function seedAttachmentScans(): void {
  for (const status of ["CLEAN", "QUARANTINED", "FAILED"]) attachmentScans.set(status, 0);
}
seedAttachmentScans();
const gauges = new Map<string, number>();
// D-056: readiness of the critical-result flow, one 0/1 series per check, rendered from the first scrape.
const criticalReadinessChecks = new Map<string, number>([["policy", 0], ["redundant_channel", 0], ["on_call", 0]]);
let loginDistributedAttemptSignals = 0;
const allowedGauges = new Set([
  "outbox_pending",
  "outbox_oldest_age_seconds",
  "outbox_dead_letters",
  "process_resident_memory_bytes",
  "process_heap_used_bytes",
  "process_heap_limit_bytes",
  "process_uptime_seconds",
  "readiness_failures",
  "sse_connections",
  "realtime_shared_reads_total",
  "diagnostic_requests_created",
  "diagnostic_items_completed",
  "diagnostic_turnaround_time_seconds",
  "recollection_rate",
  "critical_results",
  "critical_unacknowledged",
  "critical_unreachable",
  "overdue_items",
  "result_view_latency_seconds"
]);
const gaugeHelp = new Map([
  ["outbox_pending", "Pending outbox messages."],
  ["outbox_oldest_age_seconds", "Age in seconds of the oldest pending outbox message."],
  ["outbox_dead_letters", "Outbox messages that failed delivery and wait for an operator (reprocess or discard)."],
  ["process_resident_memory_bytes", "Resident set size of the application process."],
  ["process_heap_used_bytes", "V8 heap in use by the application process."],
  ["process_heap_limit_bytes", "V8 heap limit (--max-old-space-size); the runtime aggregate lives in this heap."],
  ["process_uptime_seconds", "Seconds since the application process started."],
  ["readiness_failures", "Readiness checks that failed."],
  ["sse_connections", "Active realtime stream connections."],
  ["realtime_shared_reads_total", "Full runtime-state aggregate reads performed by the shared realtime reader."],
  ["diagnostic_requests_created", "Current snapshot count of diagnostic requests."],
  ["diagnostic_items_completed", "Current snapshot count of completed diagnostic items."],
  ["critical_unacknowledged", "Critical results that reached at least one escalation level and nobody has acknowledged yet."],
  ["critical_unreachable", "Unacknowledged critical results whose escalation found nobody clinical to notify (administrators alerted, D-056)."],
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
const allowedAttachmentScanStatuses = new Set(["CLEAN", "QUARANTINED", "FAILED"]);
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

/** Counts one per-account distributed login attempt signal (PROD-203); never blocks anything. */
export function recordLoginDistributedAttemptSignal(): void {
  loginDistributedAttemptSignals += 1;
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

/**
 * Counts full aggregate reads performed by the shared realtime reader and the
 * times an open stream had to revalidate authorization against a newer version.
 * Together they are the PROD-104 evidence: reads must stay near one per second
 * per process and stale revalidations must be rare.
 */
export function recordRealtimeSharedRead(mode: RealtimePollMode): void {
  const safeMode = normalizeAllowedLabel(mode, allowedRealtimePollModes, "stream");
  incrementCounter(realtimeSharedReads, safeMode);
}

export function recordRealtimeAuthorizationStaleness(): void {
  incrementCounter(realtimeAuthorizationStaleness, "stream");
}

/** PROD-308: one count per upload scanned; QUARANTINED is the signal the quarantine owner watches (OBSERVABILITY.md). */
export function recordAttachmentScan(status: string): void {
  incrementCounter(attachmentScans, normalizeAllowedLabel(status, allowedAttachmentScanStatuses, "FAILED"));
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

export function operationalAuditQuery(state: StoreState): AuditMetricsQuery {
  return { requestCount: state.requests.length, samples: state.samples.map(({ id, requestId }) => ({ id, requestId })),
    releasedVersions: state.resultVersions.filter((version) => version.releasedAt).map((version) => ({ id: version.id, releasedAtMs: Date.parse(version.releasedAt!) })) };
}

export function refreshOperationalMetrics(
  state: StoreState,
  now = new Date(),
  history: AuditMetrics = auditMetrics(state.auditEvents, operationalAuditQuery(state)),
  outbox: ReturnType<typeof outboxMetrics> = outboxMetrics(state.outbox)
): void {
  setGauge("outbox_pending", outbox.pending);
  const oldestAvailableAt = outbox.oldestAvailableAt === undefined ? undefined : Date.parse(outbox.oldestAvailableAt);
  const oldestAgeSeconds = oldestAvailableAt === undefined || !Number.isFinite(oldestAvailableAt)
    ? 0 : Math.max(0, (now.getTime() - oldestAvailableAt) / 1_000);
  setGauge("outbox_oldest_age_seconds", oldestAgeSeconds);
  setGauge("outbox_dead_letters", outbox.deadLetters ?? 0);
  refreshProcessMetrics();

  // Business measures are bounded snapshot gauges; rates and latency need event policy and timestamps.
  setGauge("diagnostic_requests_created", state.requests.length);
  setGauge("diagnostic_items_completed", state.items.filter((item) => item.status === "COMPLETED").length);
  const currentVersionIds = new Set(state.results.map((result) => result.currentVersionId).filter((id): id is string => Boolean(id)));
  setGauge("critical_results", state.resultVersions.filter((version) => version.status === "RELEASED" && version.critical && currentVersionIds.has(version.id)).length);
  refreshCriticalMetrics(state);
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

  setOptionalGauge("recollection_rate", history.recollectionRate);
  setOptionalGauge("result_view_latency_seconds", history.resultViewLatencySeconds);
}

/**
 * PROD-401/402 (D-056): an unacknowledged critical result is a clinical signal, not an outbox one. Roots are
 * the requester's critical notifications; a result acknowledged by anyone leaves both gauges.
 */
function refreshCriticalMetrics(state: StoreState): void {
  const acknowledged = new Set(state.notifications.filter((entry) => entry.category === "CRITICAL" && entry.state === "ACKNOWLEDGED").map((entry) => entry.entityId));
  const openRoots = state.notifications.filter((entry) =>
    entry.category === "CRITICAL" && entry.entityType === "RESULT_VERSION" && entry.escalationOf === undefined
    && entry.state !== "SUPERSEDED" && entry.state !== "ACKNOWLEDGED" && !acknowledged.has(entry.entityId));
  setGauge("critical_unacknowledged", openRoots.filter((entry) => (entry.escalation?.level ?? 0) >= 1).length);
  setGauge("critical_unreachable", openRoots.filter((entry) => entry.escalation?.unreachableAt !== undefined).length);
}

export type CriticalReadinessCheck = "policy" | "redundant_channel" | "on_call";

/** The 0/1 readiness checks are computed by the application layer (critical-readiness.ts) and recorded here on each scrape. */
export function recordCriticalReadiness(checks: Readonly<Record<CriticalReadinessCheck, 0 | 1>>): void {
  for (const [check, value] of Object.entries(checks)) {
    if (criticalReadinessChecks.has(check)) criticalReadinessChecks.set(check, value === 1 ? 1 : 0);
  }
}

/** Memory against the heap limit is the capacity signal of the in-memory aggregate (DEPLOYMENT §6.6). */
export function refreshProcessMetrics(): void {
  const memory = process.memoryUsage();
  setGauge("process_resident_memory_bytes", memory.rss);
  setGauge("process_heap_used_bytes", memory.heapUsed);
  setGauge("process_heap_limit_bytes", getHeapStatistics().heap_size_limit);
  setGauge("process_uptime_seconds", Math.round(process.uptime()));
}

export function renderPrometheus(): string {
  const lines = [
    "# HELP cvg_build_info Commit the running image was built from (\"unknown\" for an unstamped build).",
    "# TYPE cvg_build_info gauge",
    `cvg_build_info{revision="${escapeLabel(buildRevision())}"} 1`,
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
  appendCounter(lines, "cvg_realtime_shared_reads_total", "Full aggregate reads performed by the shared realtime reader.", realtimeSharedReads, ["mode"]);
  appendCounter(lines, "cvg_realtime_authorization_staleness_total", "Realtime authorizations revalidated against a newer runtime-state version.", realtimeAuthorizationStaleness, ["mode"]);
  appendCounter(lines, "cvg_attachment_scans_total", "Attachment uploads scanned by the malware scanner, by verdict (QUARANTINED needs the quarantine owner).", attachmentScans, ["status"]);
  lines.push(
    "# HELP cvg_login_distributed_attempt_signals_total Accounts whose failed logins crossed the aggregated per-account threshold (monitoring only, no blocking).",
    "# TYPE cvg_login_distributed_attempt_signals_total counter",
    `cvg_login_distributed_attempt_signals_total ${loginDistributedAttemptSignals}`
  );
  for (const [name, value] of [...gauges.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const metricName = `cvg_${name}`;
    lines.push(`# HELP ${metricName} ${gaugeHelp.get(name) ?? "Bounded application gauge."}`, `# TYPE ${metricName} gauge`, `${metricName} ${value}`);
  }
  lines.push("# HELP cvg_critical_readiness Critical-result flow readiness by check (1 = ready): approved policy, redundant channel, on-call coverage of every requesting department.", "# TYPE cvg_critical_readiness gauge");
  for (const [check, value] of [...criticalReadinessChecks.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`cvg_critical_readiness{check="${check}"} ${value}`);
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
  realtimeSharedReads.clear();
  realtimeAuthorizationStaleness.clear();
  attachmentScans.clear();
  seedAttachmentScans();
  gauges.clear();
  for (const check of criticalReadinessChecks.keys()) criticalReadinessChecks.set(check, 0);
  loginDistributedAttemptSignals = 0;
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
