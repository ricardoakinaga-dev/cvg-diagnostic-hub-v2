import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { StoreState } from "../src/server/domain/models";
import { withDisposablePostgresDatabase } from "../tests/support/postgres-test-harness";
import { buildNextHttpTestBundle, NEXT_HTTP_TEST_PROXY_HEADERS, startNextHttpTestServer } from "../tests/support/next-http-test-server";
import { buildAuditHeavyState } from "./perf-snapshot";
import { summarize, round, type PerfSample } from "./perf-report";
import { assessPostgresPerf } from "./perf-postgres-report";
import { isHealthySse, observeSse, type SseObservation } from "./perf-postgres-sse";

const ROUTES = ["/api/v1/diagnostic-services", "/api/v1/diagnostic-requests?limit=25", "/api/v1/search?q=HEMOGRAM&limit=25", "/api/v1/dashboard"];
const REQUEST_TIMEOUT_MS = 120_000;
// PRD NFR-PERF-001/002 proposed p95 targets (still pending the D2 workload approval).
const READ_P95_TARGET_MS = 500;
const SEARCH_P95_TARGET_MS = 800;
const WRITE_P95_TARGET_MS = 800;
// The gate fails above the target times this factor. 2 leaves ~3x headroom over the 2026-10-04 local
// measurement (GET 305 ms, POST 463 ms) so a shared runner does not flake, yet a gross regression fails.
// PERF_POSTGRES_P95_CEILING_FACTOR=0 turns the timing gate off (latency becomes informational again).
function ceilingFactor(): number {
  const value = process.env.PERF_POSTGRES_P95_CEILING_FACTOR;
  if (value === undefined) return 2;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 20) throw new Error("Invalid PERF_POSTGRES_P95_CEILING_FACTOR; expected a number from 0 to 20.");
  return parsed;
}
interface Client { cookie: string; csrf: string; }
interface HttpSample extends PerfSample { id?: string; errorCode?: string; }

function setting(name: string, fallback: number, maximum: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`Invalid ${name}; expected an integer from 1 to ${maximum}.`);
  return parsed;
}

/** Authentication is exercised by HTTP using synthetic persisted sessions;
 * password hashing/login throughput is deliberately outside this workload. */
function fixture(auditEvents: number, clients: number, writes: number): { state: StoreState; clients: Client[]; admin: Client } {
  const state = buildAuditHeavyState(auditEvents);
  const veterinarian = state.users.find((user) => user.role === "VETERINARIAN");
  const administrator = state.users.find((user) => user.role === "ADMIN");
  if (!veterinarian || !administrator) throw new Error("Missing workload actors.");
  const patient = state.patients.find((entry) => entry.id === "patient-thor");
  const encounter = state.encounters.find((entry) => entry.id === "encounter-thor");
  if (!patient || !encounter) throw new Error("Missing workload patient/encounter.");
  // Each command uses a distinct encounter so duplicate-request prevention is
  // exercised normally, without turning intentional conflicts into load errors.
  for (let index = 0; index < writes; index++) {
    state.patients.push({ ...patient, id: `patient-perf-${index}`, externalId: `PERF-PATIENT-${index}` });
    state.encounters.push({ ...encounter, id: `encounter-perf-${index}`, patientId: `patient-perf-${index}`, externalId: `PERF-ENCOUNTER-${index}` });
    const admission = state.admissions.find((entry) => entry.encounterId === encounter.id);
    if (admission) state.admissions.push({ ...admission, id: `admission-perf-${index}`, encounterId: `encounter-perf-${index}`, bed: `Perf ${index}` });
  }
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const session = (userId: string): Client => {
    const token = randomBytes(32).toString("base64url");
    const csrf = randomBytes(32).toString("base64url");
    state.sessions.push({ id: randomUUID(), userId, tokenHash: hash(token), csrfTokenHash: hash(csrf), createdAt, expiresAt, version: 1 });
    return { cookie: `cvg_session=${token}; cvg_csrf=${csrf}`, csrf };
  };
  const syntheticClients = Array.from({ length: clients }, (_, index) => {
    const user = { ...veterinarian, id: `user-perf-${index}`, email: `perf-${index}@example.test`, createdAt,
      patientIds: [...(veterinarian.patientIds ?? []), ...Array.from({ length: writes }, (_, offset) => `patient-perf-${offset}`)] };
    state.users.push(user);
    return session(user.id);
  });
  return { state, clients: syntheticClients, admin: session(administrator.id) };
}

async function parallel<T>(count: number, concurrency: number, operation: (index: number) => Promise<T>): Promise<T[]> {
  const results = new Array<T>(count);
  let cursor = 0;
  const settled = await Promise.allSettled(Array.from({ length: Math.min(count, concurrency) }, async () => {
    while (cursor < count) {
      const index = cursor++;
      try { results[index] = await operation(index); }
      catch (error) { cursor = count; throw error; }
    }
  }));
  const failures = settled.flatMap((entry) => entry.status === "rejected" ? [entry.reason as unknown] : []);
  if (failures.length) throw new AggregateError(failures, "Concurrent workload failed.");
  return results;
}

function headers(client: Client): Record<string, string> {
  return { ...NEXT_HTTP_TEST_PROXY_HEADERS, cookie: client.cookie, accept: "application/json" };
}

export async function measureHttpRequest(url: string, client: Client, init?: RequestInit): Promise<HttpSample> {
  const started = performance.now();
  try {
    const response = await fetch(url, { ...init, headers: { ...headers(client), ...init?.headers }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    // Measure through the entire payload, not just response headers.
    const body: unknown = await response.json();
    if (!body || typeof body !== "object") return { status: 0, durationMs: round(performance.now() - started), errorCode: "INVALID_ENVELOPE" };
    if (!("data" in body)) {
      const error: unknown = "error" in body ? body.error : undefined;
      const errorCode = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "INVALID_ENVELOPE";
      return { status: response.ok ? 0 : response.status, durationMs: round(performance.now() - started), errorCode };
    }
    const data: unknown = body.data;
    const id = data && typeof data === "object" && "id" in data && typeof data.id === "string" ? data.id : undefined;
    return { status: response.status, durationMs: round(performance.now() - started), id };
  } catch {
    return { status: 0, durationMs: round(performance.now() - started) };
  }
}

/** Only a storage readiness probe is substituted. No attachment operations
 * are measured or represented as S3/antivirus evidence. */
async function storageProbe(): Promise<{ url: string; stop(): Promise<void> }> {
  const server = createServer((_request, response) => { response.writeHead(200); response.end(); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Storage probe port unavailable.");
  return { url: `http://127.0.0.1:${address.port}`, stop: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

async function openStream(baseUrl: string, client: Client, controller: AbortController): Promise<SseObservation> {
  const response = await fetch(`${baseUrl}/api/v1/realtime/events`, { headers: { ...headers(client), accept: "text/event-stream" }, signal: controller.signal });
  if (response.status !== 200 || !response.headers.get("content-type")?.includes("text/event-stream") || !response.body) {
    await response.body?.cancel();
    throw new Error(`SSE admission failed: HTTP ${response.status}.`);
  }
  const observation = observeSse(response.body, controller.signal);
  await observation.ready;
  return observation;
}

async function metric(baseUrl: string, client: Client): Promise<{ sharedReads: number; activeConnections: number; closureReasons: Record<string, number> }> {
  const response = await fetch(`${baseUrl}/api/v1/metrics`, { headers: headers(client), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const body = await response.text();
  if (!response.ok) throw new Error(`Metrics failed: HTTP ${response.status}.`);
  const reads = [...body.matchAll(/^cvg_realtime_shared_reads_total\{[^\n]*\}\s+(\d+)$/gm)];
  const active = body.match(/^cvg_sse_connections\s+(\d+)$/m);
  if (!reads.length || !active) throw new Error("Required realtime metrics are missing.");
  const closureReasons = Object.fromEntries([...body.matchAll(/^cvg_realtime_stream_closures_total\{reason="([a-z_]+)"\}\s+(\d+)$/gm)].map((match) => [match[1], Number(match[2])]));
  return { sharedReads: reads.reduce((sum, match) => sum + Number(match[1]), 0), activeConnections: Number(active[1]), closureReasons };
}

export async function runPostgresPerf(record: (phase: string, evidence?: Record<string, unknown>) => void = () => undefined) {
  record("configuration");
  const auditEvents = setting("PERF_POSTGRES_AUDIT_EVENTS", 100_000, 1_000_000);
  const connectionCount = setting("PERF_POSTGRES_SSE_CONNECTIONS", 100, 500);
  const p95CeilingFactor = ceilingFactor();
  const requestsPerRoute = setting("PERF_POSTGRES_REQUESTS", 20, 10_000);
  const concurrency = setting("PERF_POSTGRES_CONCURRENCY", 4, 100);
  const writeCount = setting("PERF_POSTGRES_WRITES", 10, 1_000);
  const idleMs = setting("PERF_POSTGRES_IDLE_MS", 6_000, 60_000);
  const started = Date.now();
  return withDisposablePostgresDatabase(async (database) => {
    record("seed", { auditEvents, connectionCount, requestsPerRoute, concurrency, writeCount });
    console.error("PROD-110: preparing disposable PostgreSQL workload.");
    const workload = fixture(auditEvents, connectionCount, writeCount);
    const seeded = await database.createStore({ ...workload.state, auditEvents: [] });
    await database.closeStore(seeded);
    // Keep the same durable event volume as the legacy baseline. The entities
    // were seeded above; the runtime row holds only the header (PROD-101, 015).
    await database.query(`WITH source AS (SELECT $1::jsonb AS state), seeded AS (
      UPDATE cvg_runtime_state SET version=version+1 WHERE id=1 RETURNING cvg_runtime_state.id
    ) INSERT INTO audit_events (id,event_type,entity_type,entity_id,correlation_id,metadata,occurred_at)
      SELECT e->>'id',e->>'eventType',e->>'entityType',e->>'entityId',e->>'correlationId',e->'metadata',(e->>'occurredAt')::timestamptz
      FROM source, seeded, jsonb_array_elements(source.state->'auditEvents') e`, [JSON.stringify(workload.state)]);
    const initial = await database.query(`SELECT (SELECT count(*)::int FROM audit_events) AS events,
      pg_column_size(state) + (SELECT COALESCE(sum(pg_column_size(data)), 0)::int FROM cvg_runtime_entities) AS bytes FROM cvg_runtime_state WHERE id=1`);
    const initialRow = initial.rows[0] as { events: number; bytes: number };
    const probe = await storageProbe();
    const applicationName = `cvg-perf-${process.pid}`;
    const options = { databaseUrl: database.connectionString(), realtimeChannel: `cvg_perf_${process.pid}`, applicationName, storageEndpoint: probe.url,
      // Match production's default cadence/deadline, rather than the shorter
      // timings used by integration tests to exercise reconnects quickly.
      realtime: { connections: connectionCount, intervalMs: 5_000, pollTimeoutMs: 10_000, maxStreamMs: 900_000 } };
    let build: Awaited<ReturnType<typeof buildNextHttpTestBundle>> | undefined;
    let server: Awaited<ReturnType<typeof startNextHttpTestServer>> | undefined;
    const controllers: AbortController[] = [];
    const streams: SseObservation[] = [];
    let monitor: Promise<void> | undefined;
    let monitoring = false;
    const resourceSamples: Array<{ elapsedMs: number; active: number; waiting: number; lockWaiting: number; snapshotBytes: number }> = [];
    try {
      console.error("PROD-110: building isolated production Next server.");
      record("build");
      build = await buildNextHttpTestBundle(options);
      server = await startNextHttpTestServer({ ...options, mode: "start", distDir: build.distDir });
      record("warmup");
      const baseUrl = server.baseUrl;
      for (const route of ROUTES) {
        const warmup = await measureHttpRequest(`${baseUrl}${route}`, workload.clients[0]);
        if (warmup.status !== 200) throw new Error(`Warmup failed for ${route}: HTTP ${warmup.status}.`);
      }
      console.error(`PROD-110: opening ${connectionCount} authenticated SSE clients.`);
      record("sse-admission");
      const admissionStarted = performance.now();
      await parallel(connectionCount, concurrency, async (index) => {
        const controller = new AbortController();
        controllers.push(controller);
        const deadline = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
          const observation = await openStream(baseUrl, workload.clients[index], controller);
          streams.push(observation);
          record("sse-admission", { admittedConnections: streams.length });
        }
        finally { clearTimeout(deadline); }
      });
      const admissionDurationMs = performance.now() - admissionStarted;
      record("idle", { admittedConnections: streams.length });
      const readsBefore = await metric(baseUrl, workload.admin);
      const idleStarted = performance.now();
      await new Promise((resolve) => setTimeout(resolve, idleMs));
      const readsAfter = await metric(baseUrl, workload.admin);
      const idleDurationMs = performance.now() - idleStarted;
      console.error("PROD-110: measuring concurrent HTTP reads and committed writes with SSE open.");
      record("http-load");
      const measuredStarted = performance.now();
      monitoring = true;
      monitor = (async () => {
        while (monitoring) {
          const observation = await database.query(`SELECT
            (SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 AND state='active') AS active,
            (SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 AND wait_event IS NOT NULL) AS waiting,
            (SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 AND wait_event_type='Lock') AS "lockWaiting",
            pg_column_size(state) + (SELECT COALESCE(sum(pg_column_size(data)), 0)::int FROM cvg_runtime_entities) AS "snapshotBytes"
            FROM cvg_runtime_state WHERE id=1`, [applicationName]);
          resourceSamples.push({ elapsedMs: round(performance.now() - measuredStarted), ...observation.rows[0] as Omit<typeof resourceSamples[number], "elapsedMs"> });
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      })();
      // Consume a sampling failure immediately while retaining it for teardown.
      void monitor.catch(() => undefined);
      const writesStarted = performance.now();
      const runId = randomUUID();
      const [routeSamples, writes] = await Promise.all([
        parallel(ROUTES.length * requestsPerRoute, concurrency, (index) => measureHttpRequest(`${baseUrl}${ROUTES[index % ROUTES.length]}`, workload.clients[index % connectionCount])),
        parallel(writeCount, Math.min(concurrency, writeCount), (index) => measureHttpRequest(`${baseUrl}/api/v1/diagnostic-requests`, workload.clients[index % connectionCount], {
          method: "POST", headers: { "content-type": "application/json", "x-csrf-token": workload.clients[index % connectionCount].csrf, "idempotency-key": `perf-${runId}-${index}` },
          body: JSON.stringify({ patientId: `patient-perf-${index}`, encounterId: `encounter-perf-${index}`, priority: "ROUTINE", items: [{ serviceId: "service-hemogram" }] })
        })).then((samples) => ({ samples, elapsedMs: performance.now() - writesStarted }))
      ]);
      const measurementDurationMs = performance.now() - measuredStarted;
      const measurementFinishedAt = performance.now();
      record("persistence-and-delivery", { routeSamples, writeSamples: writes.samples });
      monitoring = false;
      await monitor;
      const ids = writes.samples.flatMap((entry) => entry.id ? [entry.id] : []);
      const durable = await database.query("SELECT count(*)::int AS count FROM cvg_runtime_entities WHERE collection='requests' AND entity_key=ANY($1::text[])", [ids]);
      const durableWrites = Number((durable.rows[0] as { count: number }).count);
      const deliveryStarted = performance.now();
      while (!streams.every((stream) => stream.unexpectedClosure || isHealthySse(stream, ids, writeCount, measurementFinishedAt)) && performance.now() - deliveryStarted < REQUEST_TIMEOUT_MS) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const endMetrics = await metric(baseUrl, workload.admin);
      const closures = streams.filter((stream) => stream.unexpectedClosure).length;
      const healthyConnections = streams.filter((stream) => isHealthySse(stream, ids, writeCount, measurementFinishedAt)).length;
      const requests = ROUTES.map((route, index) => summarize(route, routeSamples.filter((_sample, offset) => offset % ROUTES.length === index)));
      const writeSummary = summarize("POST /api/v1/diagnostic-requests", writes.samples);
      const timingTargets = requests.map((entry) => ({ endpoint: entry.endpoint, measuredP95Ms: entry.p95Ms,
        proposedP95Ms: entry.endpoint.includes("/search?") ? SEARCH_P95_TARGET_MS : READ_P95_TARGET_MS,
        withinProposedTarget: entry.p95Ms <= (entry.endpoint.includes("/search?") ? SEARCH_P95_TARGET_MS : READ_P95_TARGET_MS) }));
      const gate = assessPostgresPerf({ auditEvents: initialRow.events, expectedAuditEvents: auditEvents,
        sseConnections: Math.min(healthyConnections, readsBefore.activeConnections, readsAfter.activeConnections, endMetrics.activeConnections),
        expectedSseConnections: connectionCount, requests, expectedReads: ROUTES.map((endpoint) => ({ endpoint, requests: requestsPerRoute })),
        writes: writeSummary, durableWrites, expectedWrites: writeCount, unexpectedStreamClosures: closures,
        ...(p95CeilingFactor > 0 ? { p95CeilingsMs: { read: READ_P95_TARGET_MS * p95CeilingFactor, search: SEARCH_P95_TARGET_MS * p95CeilingFactor, write: WRITE_P95_TARGET_MS * p95CeilingFactor } } : {}) });
      return {
        benchmark: "PROD-110 PostgreSQL HTTP/SSE", schemaVersion: 1, measuredAt: new Date().toISOString(),
        environment: { node: process.version, platform: process.platform, arch: process.arch, cpus: os.availableParallelism(), nextMode: "production", dbPoolMax: 4, rateLimitMode: "postgres", database: "disposable-loopback", realtimeIntervalMs: 5_000, realtimePollTimeoutMs: 10_000 },
        workload: { auditEvents: initialRow.events, snapshotBytes: initialRow.bytes, authenticatedUsers: connectionCount, sseConnections: connectionCount, requestsPerRoute, concurrency, writeCount },
        requests, writes: { ...writeSummary, elapsedMs: round(writes.elapsedMs), committedPerSecond: round(durableWrites / (writes.elapsedMs / 1_000)), durableWrites },
        timingAssessment: { source: "docs/prd/PRD.md NFR-PERF-001/002", workloadApproval: "D2_PENDING", enforcedInCi: p95CeilingFactor > 0, p95CeilingFactor,
          reads: timingTargets, writes: { measuredP95Ms: writeSummary.p95Ms, proposedP95Ms: WRITE_P95_TARGET_MS, withinProposedTarget: writeSummary.p95Ms <= WRITE_P95_TARGET_MS },
          withinProposedTargets: timingTargets.every((entry) => entry.withinProposedTarget) && writeSummary.p95Ms <= WRITE_P95_TARGET_MS },
        rawSamples: { reads: routeSamples.map((entry, index) => ({ endpoint: ROUTES[index % ROUTES.length], ...entry })), writes: writes.samples },
        realtime: { admissionDurationMs: round(admissionDurationMs), idleDurationMs: round(idleDurationMs), sharedAggregateReads: readsAfter.sharedReads - readsBefore.sharedReads,
          sharedReadsPerSecond: round((readsAfter.sharedReads - readsBefore.sharedReads) / (idleDurationMs / 1_000)), unexpectedStreamClosures: closures,
          healthyConnections, serverConnections: { before: readsBefore.activeConnections, afterIdle: readsAfter.activeConnections, afterLoad: endMetrics.activeConnections },
          closureReasons: endMetrics.closureReasons,
          deliveryWaitMs: round(performance.now() - deliveryStarted), observations: streams.map((stream) => ({ frames: stream.frames, heartbeats: stream.heartbeats, deliveredWrites: ids.filter((id) => stream.entityIds.has(id)).length, protocolError: stream.protocolError })) },
        postgresSamples: resourceSamples, measurementDurationMs: round(measurementDurationMs), totalDurationMs: Date.now() - started, gate,
        limitations: [`Provisional synthetic ${auditEvents}-audit workload; D2-approved clinical volume, peak and staging topology remain pending.`, "Latency and throughput are measured through HTTP response bodies and PostgreSQL commits; timing is gated only by generous absolute p95 ceilings (PERF_POSTGRES_P95_CEILING_FACTOR, default 2x the PRD targets). A passing correctness gate is not a timing-target acceptance.", "Synthetic sessions exclude password hashing/login throughput. Single instance; storage readiness is a probe, with no attachment workload.", "Idle shared-read telemetry is specific to realtime; HTTP authentication aggregate reads are outside that counter. Sampled waits can miss short locks.", "Not a staging, long soak, failover or production capacity acceptance."]
      };
    } finally {
      monitoring = false;
      for (const controller of controllers) controller.abort();
      // Always release the server, build and probe even if sampling failed.
      const cleanup = await Promise.allSettled([monitor, ...streams.map((stream) => stream.finished), server?.stop(), probe.stop()]);
      const buildCleanup = await Promise.allSettled([build?.cleanup()]);
      cleanup.push(...buildCleanup);
      const errors = cleanup.flatMap((entry) => entry.status === "rejected" ? [entry.reason as unknown] : []);
      if (errors.length) throw new AggregateError(errors, "PostgreSQL performance cleanup failed.");
    }
  });
}

async function saveReport(report: unknown): Promise<void> {
  if (process.env.PERF_POSTGRES_REPORT) {
    const target = path.resolve(process.env.PERF_POSTGRES_REPORT);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  }
}

async function main(): Promise<void> {
  let phase = "configuration";
  const partial: Record<string, unknown> = {};
  let report: Awaited<ReturnType<typeof runPostgresPerf>>;
  try {
    report = await runPostgresPerf((currentPhase, evidence) => { phase = currentPhase; if (evidence) Object.assign(partial, evidence); });
  } catch (error) {
    const message = (error instanceof Error ? error.message : "PostgreSQL performance benchmark failed.").replace(/(?:postgres(?:ql)?|https?):\/\/[^\s]+/g, "[redacted-url]");
    await saveReport({ benchmark: "PROD-110 PostgreSQL HTTP/SSE", schemaVersion: 1, measuredAt: new Date().toISOString(), result: "FAILED", phase, partial,
      gate: { pass: false, failures: [message] }, limitations: ["The benchmark failed before complete measurement; partial observations are not acceptance evidence."] });
    console.error(message);
    process.exitCode = 1;
    return;
  }
  await saveReport(report);
  console.log(JSON.stringify(report, null, 2));
  if (!report.gate.pass) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "PostgreSQL performance benchmark failed."); process.exitCode = 1; });
}
