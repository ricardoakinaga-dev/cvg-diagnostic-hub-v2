/**
 * Hospital load benchmark (audit of 2026-10-10, blocker 4): every clinical write still takes the single runtime
 * row lock, so how much does that serialization cost at the hospital's volume? This replays complete clinical
 * journeys (request → sample or procedure → result → release → the requester reads it and acknowledges the
 * notification) over HTTP against the production Next build and the real outbox worker, on a disposable
 * PostgreSQL seeded with months of D2 history, while every simulated professional keeps polling their screen.
 *
 *  - levels: arrivals at multiples of the D2 peak hour, to find how far above the hospital's demand the p95
 *    stays within the PRD targets (the headroom);
 *  - soak (PERF_HOSPITAL_SOAK_MINUTES): a long run at one level, watching latency drift and memory;
 *  - faults (PERF_HOSPITAL_FAULTS=app,worker,postgres): the app killed with SIGKILL, the worker killed, and
 *    PostgreSQL restarted under load; journeys retry with the same idempotency key, and the run proves that no
 *    acknowledged write was lost, none was applied twice and every released result was delivered once.
 *
 *   ALLOW_POSTGRES_INTEGRATION_TESTS=true POSTGRES_TEST_ADMIN_URL=postgresql://... npm run perf:hospital
 *
 * Everything is synthetic. Not a staging or production capacity acceptance: one host, loopback network.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withDisposablePostgresDatabase, type DisposablePostgresDatabase } from "../tests/support/postgres-test-harness";
import { buildNextHttpTestBundle, NEXT_HTTP_TEST_PROXY_HEADERS, NEXT_HTTP_TEST_SESSION_SECRET, nextHttpEnvironment, startNextHttpTestServer, withApplicationName, type NextHttpTestServer } from "../tests/support/next-http-test-server";
import { hashSessionToken } from "../src/server/security/session";
import { addClinicalVolume, D2_EXAMS_PER_DAY } from "./perf-clinical-volume";
import { buildAuditHeavyState } from "./perf-snapshot";
import { round } from "./perf-report";
import {
  d2PeakJourneysPerSecond, headroom, integrityHolds, isError, levelVerdict, poissonArrivals, seededRandom, soakVerdict, summarizeOperations,
  type FaultOutcome, type IntegrityCheck, type LevelVerdict, type OperationSample, type SoakWindow
} from "./perf-hospital-model";

const READ_P95_TARGET_MS = 500;
const WRITE_P95_TARGET_MS = 800;
const REQUEST_TIMEOUT_MS = 60_000;
/** A journey step keeps retrying a lost or failed command (same idempotency key) this long. */
const RETRY_DEADLINE_MS = 240_000;

interface Settings {
  months: number; examsPerDay: number; auditEvents: number; operatingHours: number; peakFactor: number;
  levels: number[]; levelSeconds: number; vets: number; labTechs: number; radiology: number; managers: number;
  pollSeconds: number; sse: number; thinkMinMs: number; thinkMaxMs: number; seed: number;
  appHeapMb: number; workerHeapMb: number;
  soakMinutes: number; soakLevel: number; faults: Array<"app" | "worker" | "postgres">; faultLevel: number; faultIntervalSeconds: number; postgresContainer?: string;
}

function integer(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`Invalid ${name}; expected an integer from ${minimum} to ${maximum}.`);
  return parsed;
}

function settings(): Settings {
  const levels = (process.env.PERF_HOSPITAL_LEVELS ?? "1,10,25,50").split(",").map((entry) => Number(entry.trim()));
  if (levels.length === 0 || levels.some((level) => !Number.isFinite(level) || level <= 0 || level > 1000)) throw new Error("Invalid PERF_HOSPITAL_LEVELS; expected multiples of the D2 peak, e.g. 1,10,25.");
  const faults = (process.env.PERF_HOSPITAL_FAULTS ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  if (faults.some((fault) => !["app", "worker", "postgres"].includes(fault))) throw new Error("Invalid PERF_HOSPITAL_FAULTS; expected app, worker and/or postgres.");
  const postgresContainer = process.env.PERF_HOSPITAL_PG_CONTAINER?.trim() || undefined;
  if (faults.includes("postgres") && (!postgresContainer || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(postgresContainer))) {
    throw new Error("The postgres fault restarts a container: set PERF_HOSPITAL_PG_CONTAINER to the disposable PostgreSQL container name.");
  }
  const thinkMinMs = integer("PERF_HOSPITAL_THINK_MIN_MS", 1_000, 0, 600_000);
  return {
    months: integer("PERF_HOSPITAL_MONTHS", 12, 1, 36),
    examsPerDay: integer("PERF_HOSPITAL_EXAMS_PER_DAY", D2_EXAMS_PER_DAY, 2, 2_000),
    auditEvents: integer("PERF_HOSPITAL_AUDIT_EVENTS", 100_000, 0, 1_000_000),
    operatingHours: integer("PERF_HOSPITAL_OPERATING_HOURS", 12, 1, 24),
    peakFactor: integer("PERF_HOSPITAL_PEAK_FACTOR", 3, 1, 24),
    levels, levelSeconds: integer("PERF_HOSPITAL_LEVEL_SECONDS", 120, 10, 3_600),
    vets: integer("PERF_HOSPITAL_VETS", 30, 1, 500), labTechs: integer("PERF_HOSPITAL_LAB_TECHS", 6, 1, 100),
    radiology: integer("PERF_HOSPITAL_RADIOLOGY", 3, 1, 100), managers: integer("PERF_HOSPITAL_MANAGERS", 3, 0, 50),
    pollSeconds: integer("PERF_HOSPITAL_POLL_SECONDS", 20, 1, 600), sse: integer("PERF_HOSPITAL_SSE", 30, 0, 500),
    thinkMinMs, thinkMaxMs: Math.max(thinkMinMs, integer("PERF_HOSPITAL_THINK_MAX_MS", 4_000, 0, 600_000)),
    seed: integer("PERF_HOSPITAL_SEED", 20_261_010, 0, 2 ** 31 - 1),
    // The heap limits of docker-compose.prod.yml (APP_HEAP_MB, WORKER_HEAP_MB): without them V8 grows lazily and hides GC cost.
    appHeapMb: integer("PERF_HOSPITAL_APP_HEAP_MB", 1_280, 256, 16_384), workerHeapMb: integer("PERF_HOSPITAL_WORKER_HEAP_MB", 768, 256, 16_384),
    soakMinutes: integer("PERF_HOSPITAL_SOAK_MINUTES", 0, 0, 24 * 60), soakLevel: integer("PERF_HOSPITAL_SOAK_LEVEL", 2, 1, 1_000),
    faults: faults as Settings["faults"], faultLevel: integer("PERF_HOSPITAL_FAULT_LEVEL", 10, 1, 1_000),
    faultIntervalSeconds: integer("PERF_HOSPITAL_FAULT_INTERVAL_SECONDS", 60, 10, 3_600), postgresContainer
  };
}

interface Client { readonly label: string; readonly cookie: string; readonly csrf: string }
interface Actors { vets: Client[]; labTechs: Client[]; radiology: Client[]; managers: Client[]; admin: Client }

/** Professionals and sessions on top of the D2 history, and one fresh patient per journey (no duplicate-request refusals). */
function fixture(config: Settings, journeyCapacity: number) {
  const state = buildAuditHeavyState(config.auditEvents);
  const volume = addClinicalVolume(state, { months: config.months, examsPerDay: config.examsPerDay });
  const template = (id: string) => {
    const user = state.users.find((entry) => entry.id === id);
    if (!user) throw new Error(`Missing ${id} template.`);
    return user;
  };
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const session = (userId: string, label: string): Client => {
    const token = randomBytes(32).toString("base64url");
    const csrf = randomBytes(32).toString("base64url");
    state.sessions.push({ id: randomUUID(), userId, tokenHash: hashSessionToken(token, { SESSION_SECRET: NEXT_HTTP_TEST_SESSION_SECRET }), csrfTokenHash: hash(csrf), createdAt, expiresAt, version: 1 });
    return { label, cookie: `cvg_session=${token}; cvg_csrf=${csrf}`, csrf };
  };
  const patients: string[] = [];
  const vetPatients = Array.from({ length: config.vets }, () => [] as string[]);
  for (let index = 0; index < journeyCapacity; index++) {
    const patientId = `patient-hosp-${index}`;
    state.patients.push({ id: patientId, displayName: `Paciente carga ${index}`, species: "Canino", breed: "SRD", sex: "Macho", ownerLabel: `Tutor carga ${index}`, externalId: `HOSP-PATIENT-${index}`, active: true });
    state.encounters.push({ id: `encounter-hosp-${index}`, patientId, externalId: `HOSP-ENCOUNTER-${index}`, type: "OUTPATIENT", status: "OPEN", openedAt: createdAt });
    patients.push(patientId);
    vetPatients[index % config.vets]!.push(patientId);
  }
  const clone = (id: string, role: string, index: number, extra: Record<string, unknown> = {}) => {
    const user = { ...template(id), id: `user-hosp-${role}-${index}`, email: `hosp-${role}-${index}@example.test`, createdAt, ...extra };
    state.users.push(user);
    return session(user.id, `${role}-${index}`);
  };
  const actors: Actors = {
    vets: vetPatients.map((ids, index) => clone("user-vet", "vet", index, { patientIds: ids })),
    labTechs: Array.from({ length: config.labTechs }, (_, index) => clone("user-lab", "lab", index)),
    radiology: Array.from({ length: config.radiology }, (_, index) => clone("user-rx", "rx", index)),
    // The heaviest readers of PROD-110: managers of the requesting and of both executing departments.
    managers: Array.from({ length: config.managers }, (_, index) => clone("user-manager", "manager", index, { managedDepartmentCodes: ["INPATIENT", "LABORATORY", "RADIOLOGY"] })),
    admin: session(template("user-admin").id, "admin")
  };
  return { state, volume, actors, patients };
}

interface CallResult { status: number; durationMs: number; data?: unknown; errorCode?: string }

class Recorder {
  readonly samples: Array<OperationSample & { phase: string }> = [];
  phase = "warmup";
  constructor(private readonly origin: number) {}
  now(): number { return performance.now() - this.origin; }
  record(operation: string, kind: OperationSample["kind"], result: CallResult, startedAtMs: number): void {
    this.samples.push({ operation, kind, status: result.status, durationMs: result.durationMs, startedAtMs: round(startedAtMs), phase: this.phase, ...(result.errorCode ? { errorCode: result.errorCode } : {}) });
  }
}

class Target {
  constructor(public baseUrl: string) {}
  async call(client: Client, method: string, route: string, body?: unknown, idempotencyKey?: string): Promise<CallResult> {
    const started = performance.now();
    const headers: Record<string, string> = { ...NEXT_HTTP_TEST_PROXY_HEADERS, cookie: client.cookie, accept: "application/json" };
    if (method !== "GET") {
      headers["content-type"] = "application/json";
      headers["x-csrf-token"] = client.csrf;
      headers["idempotency-key"] = idempotencyKey ?? randomUUID();
    }
    try {
      const response = await fetch(`${this.baseUrl}/api/v1${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      const payload = await response.json().catch(() => undefined) as { data?: unknown; error?: { code?: string } } | undefined;
      const durationMs = round(performance.now() - started);
      return response.ok ? { status: response.status, durationMs, data: payload?.data } : { status: response.status, durationMs, errorCode: payload?.error?.code };
    } catch {
      return { status: 0, durationMs: round(performance.now() - started) };
    }
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
type Json = Record<string, unknown>;
const field = (value: unknown, ...keys: string[]): unknown => keys.reduce<unknown>((current, key) => current && typeof current === "object" ? (current as Json)[key] : undefined, value);

interface JourneyOutcome { requestId?: string; versionId?: string; completed: boolean; failure?: string }

interface JourneyContext {
  target: Target; recorder: Recorder; actors: Actors; random: () => number; config: Settings;
}

/**
 * One exam from request to acknowledgement. A step that fails with no answer or a 5xx is retried with the same
 * idempotency key until RETRY_DEADLINE_MS (a crash or restart in between must neither lose nor repeat it); a
 * version conflict re-reads the item and tries again with a new key.
 */
async function runJourney(index: number, patientId: string, imaging: boolean, context: JourneyContext): Promise<JourneyOutcome> {
  const { target, recorder, actors, random, config } = context;
  const vet = actors.vets[index % actors.vets.length]!;
  const executor = imaging ? actors.radiology[index % actors.radiology.length]! : actors.labTechs[index % actors.labTechs.length]!;
  const think = () => sleep(config.thinkMinMs + random() * (config.thinkMaxMs - config.thinkMinMs));
  const outcome: JourneyOutcome = { completed: false };
  const command = async (operation: string, client: Client, route: string, body: () => Json): Promise<unknown> => {
    let key = randomUUID();
    const deadline = performance.now() + RETRY_DEADLINE_MS;
    for (;;) {
      const startedAt = recorder.now();
      const result = await target.call(client, "POST", route, body(), key);
      recorder.record(operation, "write", result, startedAt);
      if (!isError(result)) return result.data;
      if (performance.now() > deadline) throw new Error(`${operation}: ${result.errorCode ?? result.status}`);
      if (result.status === 409 && result.errorCode === "VERSION_CONFLICT") { key = randomUUID(); await refresh(); continue; }
      if (result.status !== 0 && result.status < 500 && result.status !== 429) throw new Error(`${operation}: ${result.errorCode ?? result.status}`);
      await sleep(1_000 + random() * 2_000);
    }
  };
  const read = async (operation: string, client: Client, route: string): Promise<unknown> => {
    const deadline = performance.now() + RETRY_DEADLINE_MS;
    for (;;) {
      const startedAt = recorder.now();
      const result = await target.call(client, "GET", route);
      recorder.record(operation, "read", result, startedAt);
      if (!isError(result)) return result.data;
      if (performance.now() > deadline || (result.status !== 0 && result.status < 500 && result.status !== 429)) throw new Error(`${operation}: ${result.errorCode ?? result.status}`);
      await sleep(1_000 + random() * 2_000);
    }
  };
  let itemId = "";
  let itemVersion = 0;
  const refresh = async () => { itemVersion = Number(field(await read("GET item", executor, `/diagnostic-items/${itemId}`), "item", "version")); };
  const versionFrom = (data: unknown) => {
    const version = Number(field(data, "item", "version") ?? field(data, "items", "0", "version"));
    if (Number.isSafeInteger(version)) itemVersion = version;
  };
  try {
    const encounterId = patientId.replace("patient-", "encounter-");
    const created = await command("POST create request", vet, "/diagnostic-requests", () => ({ patientId, encounterId, priority: index % 7 === 0 ? "URGENT" : "ROUTINE", items: [{ serviceId: imaging ? "service-xray" : "service-crp" }] }));
    outcome.requestId = String(field(created, "id"));
    itemId = String(field(created, "items", "0", "id"));
    itemVersion = Number(field(created, "items", "0", "version"));
    await think();
    if (imaging) {
      versionFrom(await command("POST start procedure", executor, `/diagnostic-items/${itemId}/start-procedure`, () => ({ expectedVersion: itemVersion })));
      await think();
      versionFrom(await command("POST mark performed", executor, `/diagnostic-items/${itemId}/mark-performed`, () => ({ expectedVersion: itemVersion })));
    } else {
      versionFrom(await command("POST receive sample", executor, `/diagnostic-items/${itemId}/receive-sample`, () => ({ sampleType: "EDTA", expectedVersion: itemVersion })));
      await think();
      versionFrom(await command("POST start processing", executor, `/diagnostic-items/${itemId}/start-processing`, () => ({ expectedVersion: itemVersion })));
    }
    await think();
    const draft = await command("POST result draft", executor, `/diagnostic-items/${itemId}/results`, () => ({ narrative: imaging ? "Campos pulmonares sem alterações." : "Proteína C reativa dentro da referência.", content: {}, expectedVersion: itemVersion }));
    const resultId = String(field(draft, "result", "id"));
    const resultVersion = Number(field(draft, "result", "version"));
    await think();
    await command("POST release result", executor, `/results/${resultId}/release`, () => ({ expectedVersion: resultVersion }));
    await think();
    const released = await read("GET result", vet, `/results/${resultId}`);
    const versionId = String(field(released, "version", "id"));
    outcome.versionId = versionId;
    await command("POST view result", vet, `/results/${resultId}/view`, () => ({ versionId, expectedVersion: Number(field(released, "item", "version")) }));
    // The notification is delivered by the worker (every 5 s): the requester looks again until it shows up.
    const deadline = performance.now() + RETRY_DEADLINE_MS;
    for (;;) {
      const inbox = await read("GET notifications", vet, "/notifications?filter=UNREAD&limit=100");
      const notification = (Array.isArray(inbox) ? inbox : []).find((entry) => field(entry, "entityId") === versionId && field(entry, "state") === "DELIVERED");
      if (notification) {
        await command("POST acknowledge notification", vet, `/notifications/${String(field(notification, "id"))}/acknowledge`, () => ({ confirm: true, reason: "Resultado lido.", expectedVersion: Number(field(notification, "version")) }));
        break;
      }
      if (performance.now() > deadline) throw new Error("notification never delivered");
      await sleep(3_000);
    }
    outcome.completed = true;
  } catch (error) {
    outcome.failure = error instanceof Error ? error.message : String(error);
  }
  return outcome;
}

/** Each professional refreshes their own screen, as the UI does, for as long as `running()` holds. */
async function pollScreens(context: JourneyContext, running: () => boolean): Promise<void> {
  const { target, recorder, actors, random, config } = context;
  const screens: Array<[Client, string[]]> = [
    ...actors.vets.map((client): [Client, string[]] => [client, ["/dashboard", "/notifications?filter=UNREAD&limit=25", "/diagnostic-requests?limit=25"]]),
    ...actors.labTechs.map((client): [Client, string[]] => [client, ["/queues/LABORATORY/items?limit=25"]]),
    ...actors.radiology.map((client): [Client, string[]] => [client, ["/queues/RADIOLOGY/items?limit=25"]]),
    ...actors.managers.map((client): [Client, string[]] => [client, ["/management/overview", "/dashboard"]])
  ];
  await Promise.all(screens.map(async ([client, routes]) => {
    await sleep(random() * config.pollSeconds * 1000);
    while (running()) {
      for (const route of routes) {
        if (!running()) return;
        const startedAt = recorder.now();
        recorder.record(`GET ${route.split("?")[0]!.replace(/\/(LABORATORY|RADIOLOGY)\//, "/{department}/")}`, "read", await target.call(client, "GET", route), startedAt);
      }
      await sleep(config.pollSeconds * 1000 * (0.75 + random() * 0.5));
    }
  }));
}

async function openStreams(target: Target, clients: Client[], controller: AbortController): Promise<number> {
  let open = 0;
  await Promise.all(clients.map(async (client) => {
    try {
      const response = await fetch(`${target.baseUrl}/api/v1/realtime/events`, { headers: { ...NEXT_HTTP_TEST_PROXY_HEADERS, cookie: client.cookie, accept: "text/event-stream" }, signal: controller.signal });
      if (response.status !== 200 || !response.body) { await response.body?.cancel(); return; }
      open += 1;
      const reader = response.body.getReader();
      void (async () => { try { while (!(await reader.read()).done) { /* drained */ } } catch { /* aborted or server gone */ } })();
    } catch { /* counted as not open */ }
  }));
  return open;
}

async function storageProbe(): Promise<{ url: string; stop(): Promise<void> }> {
  const server = createServer((_request, response) => { response.writeHead(200); response.end(); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Storage probe port unavailable.");
  return { url: `http://127.0.0.1:${address.port}`, stop: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

interface Worker { process: ChildProcess; exited: Promise<void> }

function startWorker(environment: NodeJS.ProcessEnv, output: string[]): Worker {
  // Its own process group: tsx runs the worker in a child process, and a crash must take both (like `docker kill`).
  const child = spawn(path.resolve("node_modules/.bin/tsx"), ["scripts/outbox-worker.ts"], { cwd: process.cwd(), env: environment, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const keep = (chunk: Buffer) => { output.push(chunk.toString()); if (output.length > 200) output.splice(0, output.length - 200); };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  return { process: child, exited: new Promise((resolve) => child.once("exit", () => resolve())) };
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try { if (child.pid) process.kill(-child.pid, signal); } catch { /* already gone */ }
}

async function stopWorker(worker: Worker | undefined, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  if (!worker) return;
  if (worker.process.exitCode === null && worker.process.signalCode === null) {
    signalGroup(worker.process, signal);
    await Promise.race([worker.exited, sleep(15_000)]);
  }
  // The group, not only tsx: its node child must not outlive a crash.
  signalGroup(worker.process, "SIGKILL");
  await Promise.race([worker.exited, sleep(5_000)]);
}

async function backlog(database: DisposablePostgresDatabase): Promise<number> {
  const result = await database.query("SELECT count(*)::int AS pending FROM outbox_messages WHERE consumer_type = 'NOTIFICATION_DELIVERY' AND status IN ('PENDING', 'PROCESSING')");
  return Number((result.rows[0] as { pending: number }).pending);
}

async function integrity(database: DisposablePostgresDatabase, outcomes: JourneyOutcome[]): Promise<IntegrityCheck> {
  const requestIds = outcomes.flatMap((outcome) => outcome.requestId ? [outcome.requestId] : []);
  const versionIds = outcomes.flatMap((outcome) => outcome.versionId ? [outcome.versionId] : []);
  const durable = await database.query("SELECT count(*)::int AS count FROM cvg_runtime_entities WHERE collection = 'requests' AND entity_key = ANY($1::text[])", [requestIds]);
  const duplicated = await database.query(`SELECT count(*)::int AS count FROM (SELECT data->>'patientId' FROM cvg_runtime_entities
    WHERE collection = 'requests' AND data->>'patientId' LIKE 'patient-hosp-%' GROUP BY 1 HAVING count(*) > 1) duplicates`);
  const delivered = await database.query(`SELECT count(DISTINCT data->>'entityId')::int AS count FROM cvg_runtime_entities
    WHERE collection = 'notifications' AND data->>'entityId' = ANY($1::text[]) AND data->>'escalationOf' IS NULL AND data->>'state' IN ('DELIVERED', 'SEEN', 'ACKNOWLEDGED')`, [versionIds]);
  const deliveries = await database.query("SELECT count(*)::int AS count FROM (SELECT notification_id FROM notification_deliveries GROUP BY 1 HAVING count(*) > 1) duplicates");
  const count = (result: { rows: readonly unknown[] }) => Number((result.rows[0] as { count: number }).count);
  return { acknowledgedRequests: requestIds.length, durableRequests: count(durable), duplicatedRequests: count(duplicated),
    releasedResults: versionIds.length, deliveredNotifications: count(delivered), duplicatedDeliveries: count(deliveries) };
}

export async function runHospitalPerf(log: (message: string) => void = (message) => console.error(message)) {
  const config = settings();
  const peak = d2PeakJourneysPerSecond({ examsPerDay: config.examsPerDay, operatingHours: config.operatingHours, peakFactor: config.peakFactor, examsPerJourney: 1 });
  // Steady load before the first fault, then each fault, its outage and a steady interval after it.
  const faultSeconds = config.faultIntervalSeconds + config.faults.length * (config.faultIntervalSeconds + 20);
  const plannedJourneys = config.levels.reduce((sum, level) => sum + peak * level * config.levelSeconds, 0) + peak * config.soakLevel * config.soakMinutes * 60 + (config.faults.length ? peak * config.faultLevel * faultSeconds : 0);
  const capacity = Math.ceil(plannedJourneys * 2 + 50);
  const random = seededRandom(config.seed);
  const started = Date.now();
  return withDisposablePostgresDatabase(async (database) => {
    log(`perf:hospital: seeding ${config.months} months at ${config.examsPerDay} exams/day and ${capacity} journey patients.`);
    const workload = fixture(config, capacity);
    const seedStarted = performance.now();
    const seeded = await database.createStore({ ...workload.state, auditEvents: [] });
    await database.closeStore(seeded);
    await database.query(`WITH source AS (SELECT $1::jsonb AS events), seeded AS (UPDATE cvg_runtime_state SET version = version + 1 WHERE id = 1 RETURNING id)
      INSERT INTO audit_events (id, event_type, actor_id, entity_type, entity_id, correlation_id, metadata, occurred_at)
      SELECT e->>'id', e->>'eventType', e->>'actorId', e->>'entityType', e->>'entityId', e->>'correlationId', e->'metadata', (e->>'occurredAt')::timestamptz
      FROM source, seeded, jsonb_array_elements(source.events) e`, [JSON.stringify(workload.state.auditEvents)]);
    const seedMs = round(performance.now() - seedStarted);
    const probe = await storageProbe();
    const applicationName = `cvg-hosp-${process.pid}`;
    const realtimeChannel = `cvg_hosp_${process.pid}`;
    const serverOptions = { databaseUrl: database.connectionString(), realtimeChannel, applicationName, storageEndpoint: probe.url,
      realtime: { connections: Math.max(10, config.sse + 10), intervalMs: 5_000, pollTimeoutMs: 10_000, maxStreamMs: 900_000 } };
    const heartbeatDir = await mkdtemp(path.join(os.tmpdir(), "cvg-hosp-worker-"));
    const workerEnvironment: NodeJS.ProcessEnv = {
      ...nextHttpEnvironment({ databaseUrl: withApplicationName(database.connectionString(), `${applicationName}-worker`), mode: "start", port: 0, realtimeChannel,
        storageRoot: heartbeatDir, distDir: ".next-unused", storageEndpoint: probe.url }),
      // The default heartbeat path: any *_FILE variable is read as a secret at boot until the loader takes an
      // allowlist (fix in progress), and the heartbeat does not exist before the first cycle.
      OUTBOX_SINK: "postgres", OUTBOX_INTERVAL_MS: "5000", NODE_OPTIONS: `--max-old-space-size=${config.workerHeapMb}`
    };
    const workerOutput: string[] = [];
    let build: Awaited<ReturnType<typeof buildNextHttpTestBundle>> | undefined;
    let server: NextHttpTestServer | undefined;
    let worker: Worker | undefined;
    const streams = new AbortController();
    let polling = false;
    let sampling = false;
    const pollers: Promise<void>[] = [];
    const postgresSamples: Array<{ atMs: number; active: number; lockWaiting: number; databaseBytes: number }> = [];
    const memorySamples: Array<{ atMs: number; rssBytes: number; heapUsedBytes: number }> = [];
    const recorder = new Recorder(performance.now());
    try {
      log("perf:hospital: building the production Next server.");
      build = await buildNextHttpTestBundle(serverOptions);
      // Only the server started from here on inherits it (the build and this process already run).
      process.env.NODE_OPTIONS = `--max-old-space-size=${config.appHeapMb}`;
      server = await startNextHttpTestServer({ ...serverOptions, mode: "start", distDir: build.distDir });
      const target = new Target(server.baseUrl);
      worker = startWorker(workerEnvironment, workerOutput);
      const context: JourneyContext = { target, recorder, actors: workload.actors, random, config };
      const openStreamsCount = await openStreams(target, workload.actors.vets.slice(0, config.sse), streams);
      polling = true;
      pollers.push(pollScreens(context, () => polling));
      sampling = true;
      pollers.push((async () => {
        while (sampling) {
          try {
            const observation = await database.query(`SELECT
              (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database() AND application_name LIKE $1 AND state = 'active') AS active,
              (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database() AND application_name LIKE $1 AND wait_event_type = 'Lock') AS "lockWaiting",
              pg_database_size(current_database())::bigint AS "databaseBytes"`, [`${applicationName}%`]);
            const row = observation.rows[0] as { active: number; lockWaiting: number; databaseBytes: string };
            postgresSamples.push({ atMs: round(recorder.now()), active: row.active, lockWaiting: row.lockWaiting, databaseBytes: Number(row.databaseBytes) });
          } catch { /* PostgreSQL restarting */ }
          await sleep(2_000);
        }
      })());
      pollers.push((async () => {
        while (sampling) {
          try {
            const response = await fetch(`${target.baseUrl}/api/v1/metrics`, { headers: { ...NEXT_HTTP_TEST_PROXY_HEADERS, cookie: workload.actors.admin.cookie } });
            const body = await response.text();
            const rss = body.match(/^cvg_process_resident_memory_bytes\s+(\d+)/m);
            const heap = body.match(/^cvg_process_heap_used_bytes\s+(\d+)/m);
            if (rss && heap) memorySamples.push({ atMs: round(recorder.now()), rssBytes: Number(rss[1]), heapUsedBytes: Number(heap[1]) });
          } catch { /* app restarting */ }
          await sleep(30_000);
        }
      })());
      // Warm-up: one journey and a full round of screens before measuring.
      log("perf:hospital: warming up.");
      await runJourney(-1, workload.patients[0]!, false, context);
      let nextPatient = 1;
      const outcomes: JourneyOutcome[] = [];
      const journeyAt = async (multiple: number, durationMs: number, phase: string): Promise<{ started: number; durationMs: number }> => {
        recorder.phase = phase;
        const arrivals = poissonArrivals(peak * multiple, durationMs, random);
        const phaseStart = performance.now();
        const journeys = arrivals.map(async (offset) => {
          await sleep(offset);
          const index = nextPatient++;
          if (index >= workload.patients.length) throw new Error("Journey patient pool exhausted; raise the capacity.");
          outcomes.push(await runJourney(index, workload.patients[index]!, random() < 0.3, context));
        });
        await sleep(durationMs);
        await Promise.all(journeys);
        return { started: arrivals.length, durationMs: performance.now() - phaseStart };
      };

      const levels: Array<LevelVerdict & { journeys: number; operations: ReturnType<typeof summarizeOperations> }> = [];
      for (const multiple of config.levels) {
        log(`perf:hospital: level ${multiple}x D2 peak (${round(peak * multiple * 3600)} journeys/h) for ${config.levelSeconds}s.`);
        const phase = `level-${multiple}`;
        const run = await journeyAt(multiple, config.levelSeconds * 1000, phase);
        const samples = recorder.samples.filter((sample) => sample.phase === phase);
        levels.push({ ...levelVerdict(multiple, samples, run.durationMs, { readP95Ms: READ_P95_TARGET_MS, writeP95Ms: WRITE_P95_TARGET_MS, maxErrorRate: 0.01 }), journeys: run.started, operations: summarizeOperations(samples) });
      }

      let soak: (ReturnType<typeof soakVerdict> & { level: number; minutes: number; windowsDetail: SoakWindow[] }) | undefined;
      if (config.soakMinutes > 0) {
        log(`perf:hospital: soak at ${config.soakLevel}x for ${config.soakMinutes} min.`);
        const soakStart = recorder.now();
        await journeyAt(config.soakLevel, config.soakMinutes * 60_000, "soak");
        const windows: SoakWindow[] = [];
        for (let minute = 0; minute < config.soakMinutes; minute++) {
          const from = soakStart + minute * 60_000;
          const inWindow = recorder.samples.filter((sample) => sample.phase === "soak" && sample.startedAtMs >= from && sample.startedAtMs < from + 60_000);
          const memory = memorySamples.filter((sample) => sample.atMs >= from && sample.atMs < from + 60_000).at(-1);
          const database_ = postgresSamples.filter((sample) => sample.atMs >= from && sample.atMs < from + 60_000).at(-1);
          const p95 = (kind: OperationSample["kind"]) => levelVerdict(0, inWindow.filter((sample) => sample.kind === kind), 60_000, { readP95Ms: Infinity, writeP95Ms: Infinity, maxErrorRate: 1 });
          windows.push({ minute, readP95Ms: p95("read").readP95Ms, writeP95Ms: p95("write").writeP95Ms, errors: inWindow.filter(isError).length, requests: inWindow.length,
            ...(memory ? { rssBytes: memory.rssBytes } : {}), ...(database_ ? { databaseBytes: database_.databaseBytes } : {}) });
        }
        soak = { ...soakVerdict(windows, { maxDrift: 1.5, maxRssGrowthBytesPerHour: 200 * 1024 * 1024, maxErrorRate: 0.01 }), level: config.soakLevel, minutes: config.soakMinutes, windowsDetail: windows };
      }

      const faults: FaultOutcome[] = [];
      const supervisorRestarts: Array<{ process: "app" | "worker"; afterFault: string; outputTail: string }> = [];
      if (config.faults.length > 0) {
        log(`perf:hospital: faults ${config.faults.join(", ")} at ${config.faultLevel}x.`);
        const firstSuccessAfter = async (atMs: number, deadlineMs: number) => {
          while (recorder.now() < atMs + deadlineMs) {
            const success = recorder.samples.find((sample) => sample.startedAtMs > atMs && !isError(sample));
            if (success) return round(success.startedAtMs + success.durationMs - atMs);
            await sleep(500);
          }
          return -1;
        };
        const faultRun = journeyAt(config.faultLevel, faultSeconds * 1000, "faults");
        await sleep(config.faultIntervalSeconds * 1000);
        for (const fault of config.faults) {
          const at = recorder.now();
          const failedBefore = recorder.samples.filter(isError).length;
          if (fault === "app") {
            log("perf:hospital: SIGKILL app.");
            await server.crash();
            await sleep(5_000);
            server = await startNextHttpTestServer({ ...serverOptions, mode: "start", distDir: build.distDir, port: server.port });
            target.baseUrl = server.baseUrl;
            faults.push({ fault, recoveryMs: await firstSuccessAfter(at, 120_000), failedDuringOutage: recorder.samples.filter(isError).length - failedBefore });
          } else if (fault === "worker") {
            log("perf:hospital: SIGKILL worker.");
            await stopWorker(worker, "SIGKILL");
            await sleep(15_000);
            worker = startWorker(workerEnvironment, workerOutput);
            const deadline = recorder.now() + 180_000;
            while (await backlog(database).catch(() => 1) > 0 && recorder.now() < deadline) await sleep(1_000);
            faults.push({ fault, recoveryMs: round(recorder.now() - at), failedDuringOutage: recorder.samples.filter(isError).length - failedBefore });
          } else {
            log(`perf:hospital: restarting PostgreSQL container ${config.postgresContainer}.`);
            await new Promise<void>((resolve, reject) => {
              const restart = spawn("docker", ["restart", "--time", "5", config.postgresContainer!], { stdio: "ignore" });
              restart.once("error", reject);
              restart.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`docker restart exited ${String(code)}`)));
            });
            // Production runs both with `restart: unless-stopped`: a process that exits because the database went
            // away is started again by Docker. Do the same here, and record that it had to happen.
            await sleep(10_000);
            if (server.exited()) {
              supervisorRestarts.push({ process: "app", afterFault: fault, outputTail: server.output().slice(-1_500) });
              server = await startNextHttpTestServer({ ...serverOptions, mode: "start", distDir: build.distDir, port: server.port });
              target.baseUrl = server.baseUrl;
            }
            if (worker && (worker.process.exitCode !== null || worker.process.signalCode !== null)) {
              supervisorRestarts.push({ process: "worker", afterFault: fault, outputTail: workerOutput.join("").slice(-1_500) });
              worker = startWorker(workerEnvironment, workerOutput);
            }
            faults.push({ fault, recoveryMs: await firstSuccessAfter(at, 180_000), failedDuringOutage: recorder.samples.filter(isError).length - failedBefore });
          }
          await sleep(config.faultIntervalSeconds * 1000);
        }
        await faultRun;
      }

      polling = false;
      // Every released result must reach its requester once the worker caught up.
      const drainDeadline = performance.now() + 180_000;
      while (await backlog(database) > 0 && performance.now() < drainDeadline) await sleep(1_000);
      const check = await integrity(database, outcomes);
      const failures = outcomes.filter((outcome) => !outcome.completed).map((outcome) => outcome.failure ?? "unknown");
      const lockWaits = postgresSamples.map((sample) => sample.lockWaiting);
      return {
        benchmark: "Hospital load (audit 2026-10-10, blocker 4)", schemaVersion: 1, measuredAt: new Date().toISOString(),
        environment: { node: process.version, platform: process.platform, arch: process.arch, cpus: os.availableParallelism(), memoryBytes: os.totalmem(), nextMode: "production", dbPoolMax: 4, worker: "scripts/outbox-worker.ts (postgres sink, 5 s)" },
        workload: { months: config.months, examsPerDay: config.examsPerDay, clinicalVolume: workload.volume, auditEvents: config.auditEvents, seedMs,
          d2PeakJourneysPerHour: round(peak * 3600), operatingHours: config.operatingHours, peakFactor: config.peakFactor,
          users: { vets: config.vets, labTechs: config.labTechs, radiology: config.radiology, managers: config.managers }, pollSeconds: config.pollSeconds,
          sseRequested: config.sse, sseOpen: openStreamsCount, thinkMs: [config.thinkMinMs, config.thinkMaxMs], imagingShare: 0.3, seed: config.seed,
          heapMb: { app: config.appHeapMb, worker: config.workerHeapMb } },
        targets: { readP95Ms: READ_P95_TARGET_MS, writeP95Ms: WRITE_P95_TARGET_MS, maxErrorRate: 0.01 },
        levels, headroom: headroom(levels), soak, faults, supervisorRestarts,
        journeys: { total: outcomes.length, completed: outcomes.length - failures.length, failures: failures.slice(0, 20) },
        integrity: { ...check, holds: integrityHolds(check) },
        postgres: { maxLockWaiting: Math.max(0, ...lockWaits), meanLockWaiting: round(lockWaits.reduce((sum, value) => sum + value, 0) / Math.max(1, lockWaits.length)), samples: postgresSamples.length,
          databaseBytes: { first: postgresSamples[0]?.databaseBytes, last: postgresSamples.at(-1)?.databaseBytes } },
        memory: { first: memorySamples[0], last: memorySamples.at(-1), maxRssBytes: Math.max(0, ...memorySamples.map((sample) => sample.rssBytes)) },
        totalDurationMs: Date.now() - started,
        // Raw evidence for the report file (left out of the console summary).
        samples: recorder.samples, postgresSamples, memorySamples,
        limitations: [
          "One host and loopback network: the app, the worker, PostgreSQL and the load generator share the same CPUs.",
          "The D2 peak (operating hours and peak factor) is an assumption until the hospital states its peak of simultaneous users.",
          "Synthetic data and sessions; no login hashing, attachments or antivirus in the journeys.",
          "Not a staging, multi-instance or production capacity acceptance."
        ]
      };
    } finally {
      polling = false;
      sampling = false;
      streams.abort();
      await Promise.allSettled(pollers);
      await stopWorker(worker);
      await Promise.allSettled([server?.stop(), probe.stop()]);
      await Promise.allSettled([build?.cleanup(), rm(heartbeatDir, { recursive: true, force: true })]);
      if (process.env.PERF_HOSPITAL_WORKER_LOG) await writeFile(process.env.PERF_HOSPITAL_WORKER_LOG, workerOutput.join(""), { mode: 0o600 }).catch(() => undefined);
    }
  });
}

async function main(): Promise<void> {
  const report = await runHospitalPerf();
  if (process.env.PERF_HOSPITAL_REPORT) {
    const target = path.resolve(process.env.PERF_HOSPITAL_REPORT);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  }
  const { levels, samples: _samples, postgresSamples: _postgresSamples, memorySamples: _memorySamples, ...rest } = report;
  console.log(JSON.stringify({ ...rest, levels: levels.map(({ operations: _operations, ...level }) => level), soak: report.soak && { ...report.soak, windowsDetail: undefined } }, null, 2));
  // The gate: nothing acknowledged was lost or applied twice, and every journey finished, faults included.
  if (!report.integrity.holds || report.journeys.completed !== report.journeys.total) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error((error instanceof Error ? error.message : "Hospital load benchmark failed.").replace(/(?:postgres(?:ql)?|https?):\/\/[^\s]+/g, "[redacted-url]"));
    process.exitCode = 1;
  });
}
