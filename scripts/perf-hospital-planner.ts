/**
 * Synthetic HPL HTTP load, on a production Next bundle and a disposable PostgreSQL database.
 * Closed-loop journeys measure tasks, plans, documents, inventory, calendar, capacity and metrics.
 * Existing 500/800 ms technical targets apply; this does not establish an institutional workload/SLO.
 * Run in a private source copy without .env files, with the disposable PG opt-in used by integration tests.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { StoreState } from "../src/server/domain/models";
import { createDemoState } from "../src/server/store/fixtures";
import { hashSessionToken } from "../src/server/security/session";
import { systemGroupId } from "../src/server/security/access-group-policy";
import { withDisposablePostgresDatabase } from "../tests/support/postgres-test-harness";
import { buildNextHttpTestBundle, NEXT_HTTP_TEST_PROXY_HEADERS, NEXT_HTTP_TEST_SESSION_SECRET, startNextHttpTestServer } from "../tests/support/next-http-test-server";
import { PlannerRecorder, plannerKey, plannerLoadSettings, provePlannerGuards, provePlannerRevocation, runPlannerLoad, type PlannerActor, type PlannerCall, type PlannerJourneyInput, type PlannerJourneyResult, type PlannerLoadSettings, type PlannerResponse, type PlannerWindow } from "./perf-hospital-planner-model";

interface Client { cookie: string; csrf: string }
const syntheticPassword = "hpl-load-isolated-fixture-password-20261011";
function fixture(config: PlannerLoadSettings) {
  const state = createDemoState(syntheticPassword);
  // Default roles/groups are preserved. Only the synthetic manager's delegation is narrowed.
  state.users = state.users.map((user) => user.id === "user-manager" ? { ...user, managedDepartmentCodes: ["ULTRASOUND"] } : user);
  const createdAt = new Date().toISOString(); const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
  const clients = {} as Record<PlannerActor, Client>;
  for (const [actor, userId] of [["manager", "user-manager"], ["operator", "user-us"], ["outsider", "user-lab"]] as const) {
    const token = randomBytes(32).toString("base64url"); const csrf = randomBytes(32).toString("base64url");
    state.sessions.push({ id: randomUUID(), userId, tokenHash: hashSessionToken(token, { SESSION_SECRET: NEXT_HTTP_TEST_SESSION_SECRET }), csrfTokenHash: createHash("sha256").update(csrf).digest("hex"), createdAt, expiresAt, version: 1 });
    clients[actor] = { cookie: `cvg_session=${token}; cvg_csrf=${csrf}`, csrf };
  }
  for (let index = 0; index < config.journeys; index++) {
    const patientId = `patient-hpl-load-${index}`;
    state.patients.push({ id: patientId, displayName: `Paciente sintético carga ${index}`, species: "Canino", breed: "SRD", sex: "Macho", ownerLabel: "Tutor sintético", externalId: `HPL-LOAD-${index}`, active: true });
    state.encounters.push({ id: `encounter-hpl-load-${index}`, patientId, externalId: `HPL-LOAD-ENCOUNTER-${index}`, type: "INPATIENT", status: "OPEN", openedAt: createdAt });
    state.admissions.push({ ...state.admissions[0], id: `admission-hpl-load-${index}`, encounterId: `encounter-hpl-load-${index}`, admittedAt: createdAt, ward: "Setor sintético da fixture", bed: `Não vinculado ${index}` });
  }
  return { state, clients };
}

/** Hash executable inputs in this source copy, including uncommitted/untracked HPL changes. */
export async function plannerSourceSnapshot(root = process.cwd()) {
  const files: Array<{ path: string; sha256: string }> = [];
  const walk = async (relative: string): Promise<void> => {
    for (const entry of (await readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === "node_modules" || entry.name.startsWith(".next")) continue;
      const filename = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await walk(filename);
      else if (entry.isFile()) files.push({ path: filename, sha256: createHash("sha256").update(await readFile(path.join(root, filename))).digest("hex") });
      else throw new Error("PLANNER_SOURCE_SYMLINK_OR_SPECIAL_FILE");
    }
  };
  for (const relative of ["src", "packages", "db/migrations", "scripts", "tests/support"]) await walk(relative);
  for (const filename of ["package.json", "package-lock.json", "next.config.mjs", "tsconfig.json"]) files.push({ path: filename, sha256: createHash("sha256").update(await readFile(path.join(root, filename))).digest("hex") });
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { method: "SHA256(sorted relative path + NUL + file SHA256 + LF), executable source/config/migrations/test support", fingerprint: createHash("sha256").update(files.map((entry) => `${entry.path}\0${entry.sha256}\n`).join("")).digest("hex"), fileCount: files.length, files };
}

async function isolatedSourceGuard(): Promise<void> {
  if (process.env.PERF_HPL_ALLOW_ISOLATED_RUN !== "true") throw new Error("PLANNER_LOAD_REQUIRES_PERF_HPL_ALLOW_ISOLATED_RUN_TRUE");
  const names = new Set(await readdir(process.cwd()));
  if ([".env", ".env.local", ".env.production", ".env.production.local", ".env.development", ".env.development.local", ".env.test", ".env.test.local"].some((name) => names.has(name))) throw new Error("PLANNER_LOAD_REFUSES_LOCAL_ENV_FILES_USE_PRIVATE_COPY");
}
async function healthProbe() {
  const server = createServer((_request, response) => { response.writeHead(200); response.end("synthetic-storage-health-only"); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("PLANNER_STORAGE_PROBE_ADDRESS");
  return { endpoint: `http://127.0.0.1:${address.port}`, stop: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}
function transport(baseUrl: string, clients: Record<PlannerActor, Client>) {
  return async (request: PlannerCall): Promise<PlannerResponse> => {
    const started = performance.now(); const client = clients[request.actor];
    const headers: Record<string, string> = { ...NEXT_HTTP_TEST_PROXY_HEADERS, cookie: client.cookie, accept: "application/json" };
    if (request.method !== "GET") Object.assign(headers, { "content-type": "application/json", "x-csrf-token": client.csrf, "idempotency-key": plannerKey(request), ...(request.version ? { "if-match": `"${request.version}"` } : {}) });
    try {
      const response = await fetch(`${baseUrl}/api/v1${request.route}`, { method: request.method, headers, ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }), signal: AbortSignal.timeout(60_000) });
      const payload = await response.json() as { data?: unknown; error?: { code?: string } };
      return { status: response.status, durationMs: performance.now() - started, ...(response.ok ? { data: payload.data } : { errorCode: payload.error?.code }) };
    } catch { return { status: 0, durationMs: performance.now() - started, errorCode: "TRANSPORT_OR_INVALID_JSON" }; }
  };
}

export function plannerIntegrity(state: StoreState, journeys: PlannerJourneyResult[], guard: { taskIds: string[]; resourceId: string } | undefined, expectedJourneys: number) {
  const tasks = state.hospitalTasks; const plans = state.hospitalPlans; const documents = state.hospitalDocuments; const resources = state.hospitalResources;
  const taskIds = journeys.map((entry) => entry.taskId).concat(guard?.taskIds ?? []);
  const checks = {
    acknowledgedJourneys: journeys.length === expectedJourneys,
    uniqueTasks: new Set(taskIds).size === taskIds.length && tasks.length === expectedJourneys + 2 && taskIds.every((id) => tasks.some((entry) => entry.id === id && entry.phase === "COMPLETED" && entry.completedBy === "user-us")),
    uniquePlans: plans.length === expectedJourneys && journeys.every((entry) => plans.some((plan) => plan.id === entry.planId && plan.state === "CLOSED" && plan.links.length === 1 && plan.links[0].targetId === entry.taskId)),
    uniqueDocuments: documents.length === expectedJourneys && journeys.every((entry) => documents.some((document) => document.id === entry.documentId && document.currentPublishedRevisionId === entry.revisionId && document.revisions.length === 1 && document.revisions[0].status === "APPROVED" && document.revisions[0].approvedBy === "user-manager")),
    frozenDocumentBytes: journeys.every((entry) => {
      const snapshot = tasks.find((task) => task.id === entry.taskId)?.documentSnapshots?.[0]; const document = documents.find((document) => document.id === entry.documentId); const revision = document?.revisions.find((revision) => revision.id === entry.revisionId);
      return Boolean(snapshot && revision && snapshot.revisionId === revision.id && JSON.stringify(snapshot.content) === JSON.stringify(revision.content));
    }),
    resourceBindings: resources.length === expectedJourneys + 1 && state.schedules.length === expectedJourneys + 1 && state.schedules.every((schedule) => schedule.hospitalTaskId && taskIds.includes(schedule.hospitalTaskId) && schedule.resourceIds?.length === 1 && resources.some((resource) => resource.id === schedule.resourceIds![0]) && schedule.status === "COMPLETED"),
    noDiagnosticMutation: state.requests.length === 0 && state.items.length === 0 && state.resultVersions.length === 0,
    singleContendedReservation: Boolean(guard && state.schedules.filter((schedule) => schedule.resourceIds?.includes(guard.resourceId)).length === 1)
  };
  return { checks, holds: Object.values(checks).every(Boolean), counts: { tasks: tasks.length, plans: plans.length, documents: documents.length, resources: resources.length, schedules: state.schedules.length, auditEvents: state.auditEvents.length, outbox: state.outbox.length } };
}

export async function runHospitalPlannerPerf() {
  await isolatedSourceGuard(); const config = plannerLoadSettings(); const sourceBefore = await plannerSourceSnapshot(); const workload = fixture(config);
  const prefix = randomBytes(4).toString("hex").toUpperCase();
  return withDisposablePostgresDatabase(async (database) => {
    const seed = await database.createStore(workload.state); await database.closeStore(seed);
    const probe = await healthProbe(); const options = { databaseUrl: database.connectionString(), realtimeChannel: `hpl_perf_${randomBytes(8).toString("hex")}`, applicationName: "hpl-planner-load", storageEndpoint: probe.endpoint };
    let build: Awaited<ReturnType<typeof buildNextHttpTestBundle>> | undefined;
    let server: Awaited<ReturnType<typeof startNextHttpTestServer>> | undefined;
    try {
      build = await buildNextHttpTestBundle(options);
      server = await startNextHttpTestServer({ ...options, mode: "start", distDir: build.distDir });
      const call = transport(server.baseUrl, workload.clients); const warmup = new PlannerRecorder(call);
      for (const route of ["/hospital-tasks?limit=1", "/hospital-plans?limit=1", "/hospital-documents?limit=1", "/hospital-resources?limit=1"]) await warmup.call("warmup.read", { actor: "manager", method: "GET", route });
      // The reservation window includes execution now, not an invented early-start tolerance.
      const window: PlannerWindow = { startsAt: new Date(Date.now() - 60_000).toISOString(), endsAt: new Date(Date.now() + 3_600_000).toISOString() };
      const inputs: PlannerJourneyInput[] = Array.from({ length: config.journeys }, (_, index) => ({ index, prefix, patientId: `patient-hpl-load-${index}`, encounterId: `encounter-hpl-load-${index}`, managerId: "user-manager", operatorId: "user-us", window, config }));
      const recorder = new PlannerRecorder(call); const started = performance.now(); const journeys = await runPlannerLoad(recorder, inputs);
      let guard: { taskIds: string[]; resourceId: string } | undefined; let guardFailure: string | undefined;
      if (!journeys.failures.length) {
        try { guard = await provePlannerGuards(recorder, inputs[0]!, journeys.completed[0]!); } catch (error) { guardFailure = error instanceof Error && /^PLANNER_[A-Z_a-z0-9.]+$/.test(error.message) ? error.message : "PLANNER_GUARD_UNEXPECTED_FAILURE"; }
      }
      const finalStore = await database.createStore(); let integrity: ReturnType<typeof plannerIntegrity>;
      try {
        integrity = plannerIntegrity(await finalStore.readState(), journeys.completed, guard, config.journeys);
        if (!journeys.failures.length && !guardFailure) {
          await finalStore.transaction((state) => ({ state: { ...state, accessGroups: state.accessGroups.map((group) => group.id === systemGroupId("ULTRASOUND_TEAM") ? { ...group, permissions: group.permissions.filter((permission) => permission !== "hospital_task.view") } : group.id === systemGroupId("MANAGER") ? { ...group, permissions: group.permissions.filter((permission) => permission !== "hospital_document.view") } : group) }, result: undefined }));
          try { await provePlannerRevocation(recorder, inputs[0]!, journeys.completed[0]!); } catch (error) { guardFailure = error instanceof Error && /^PLANNER_[A-Z_a-z0-9.]+$/.test(error.message) ? error.message : "PLANNER_REVOCATION_UNEXPECTED_FAILURE"; }
        }
      } finally { await database.closeStore(finalStore); }
      const durationMs = performance.now() - started;
      const sourceAfter = await plannerSourceSnapshot(); const sourceStable = sourceBefore.fingerprint === sourceAfter.fingerprint;
      const measured = recorder.summary(durationMs);
      const report = {
        schemaVersion: 1, profile: "HPL_OPERATIONAL_HTTP_V1", observedAt: new Date().toISOString(),
        scope: "synthetic closed-loop technical regression, one host; institutional load/acceptance not established",
        environment: { node: process.version, platform: process.platform, architecture: process.arch, nextMode: "production", database: "disposable PostgreSQL; real migrations", databasePoolMax: 4, session: "synthetic, preseeded", storage: "synthetic health-only HTTP probe; no object/scanner workload", generatorAvailableCpus: os.availableParallelism() },
        source: { ...sourceBefore, unchangedAfterRun: sourceStable },
        workload: { ...config, actors: [{ role: "MANAGER", departmentCode: "INPATIENT", delegatedDepartments: ["ULTRASOUND"] }, { role: "ULTRASOUND_TEAM", departmentCode: "ULTRASOUND" }, { role: "LAB_TECH", departmentCode: "LABORATORY", purpose: "out-of-scope negative" }], fixtureContext: { syntheticPatients: config.journeys, syntheticOpenEncounters: config.journeys, syntheticUnlinkedAdmissions: config.journeys, purpose: "current manager patient authorization; no real admission or care execution" }, expectedObjects: { tasks: config.journeys + 2, plans: config.journeys, documents: config.journeys, resources: config.journeys + 1, reservations: config.journeys + 1 }, resourceWindow: window, arrivalModel: "bounded closed-loop; no institution rate extrapolation", revocationControl: "direct change of synthetic access groups in the disposable database, followed by real HTTP reads/replay; not a benchmark of grant administration" },
        durationMs, durationScope: "from first workload command through last measured HTTP read and synthetic revocation checks; includes disposable database integrity/control time, excludes build/warmup/source hashing", measurements: measured, correctness: { guards: recorder.guards, integrity, ...(guardFailure ? { failure: guardFailure } : {}) },
        journeys: { completed: journeys.completed.length, failures: journeys.failures }, warmup: { requests: warmup.samples.length, measured: false }, samples: recorder.samples,
        passed: sourceStable && measured.withinTargets && measured.correctnessPassed && integrity.holds && !journeys.failures.length && !guardFailure,
        limitations: ["No hospital target, approved volume, network/TLS, multi-instance behavior or nominal SLO acceptance.", "No clinical protocol approval, patient care execution, diagnostic release, AI/provider delivery, attachments, antivirus or offsite recovery is benchmarked.", "Synthetic sessions bypass login hashing; storage readiness is a health-only probe, not real S3/ClamAV proof.", "Expected 404/409 correctness probes are separate from measured success-path latency/error budget; unexpected failures fail the run.", "Container CPU/memory limits and image digest must accompany this report as runner evidence; host totals do not describe container limits."]
      };
      return report;
    } finally { await server?.stop(); await build?.cleanup(); await probe.stop(); }
  });
}

async function main() {
  if (process.argv.slice(2).some((argument) => !argument.startsWith("--output="))) throw new Error("PLANNER_LOAD_UNKNOWN_ARGUMENT");
  const outputArgument = process.argv.slice(2).find((argument) => argument.startsWith("--output="));
  const output = outputArgument ? path.resolve(outputArgument.slice("--output=".length)) : path.join(await mkdtemp(path.join(os.tmpdir(), "cvg-hpl-load-")), "report.json");
  if (outputArgument && !outputArgument.slice("--output=".length)) throw new Error("PLANNER_LOAD_EMPTY_OUTPUT");
  await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  const report = await runHospitalPlannerPerf(); await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  process.stdout.write(`${JSON.stringify({ profile: report.profile, passed: report.passed, sourceFingerprint: report.source.fingerprint, workload: { journeys: report.workload.journeys, concurrency: report.workload.concurrency, readRounds: report.workload.readRounds }, completed: report.journeys.completed, measuredRequests: report.measurements.requests, guards: report.correctness.guards.length, readP95Ms: report.measurements.readP95Ms, writeP95Ms: report.measurements.writeP95Ms, integrity: report.correctness.integrity.holds, output })}\n`);
  if (!report.passed) process.exitCode = 1;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main().catch(() => { process.stderr.write("HPL load execution failed; no target credentials or response payloads are emitted.\n"); process.exitCode = 1; });
