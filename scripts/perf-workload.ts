import { fileURLToPath } from "node:url";
import { round, summarize, type PerfSummary } from "./perf-report";

/**
 * This benchmark is deliberately a local synthetic model. Its virtual clock
 * makes the report reproducible while the dataset exercises the same classes
 * of operational reads and searches that the production workload must later
 * validate with PostgreSQL and an approved pilot profile.
 */
export const SYNTHETIC_WORKLOAD_VERSION = "aaa2-synthetic-v1";
export const DEFAULT_SEED = 0x0c0ffee;
export const DEFAULT_RECORD_COUNT = 2400;
export const DEFAULT_REQUESTS_PER_WORKLOAD = 120;

const DEPARTMENTS = ["LAB", "RX", "US", "CARDIO", "ONCO", "ER", "WARD", "ICU"] as const;
const STATUSES = ["QUEUED", "IN_PROGRESS", "COMPLETED", "CANCELLED"] as const;
const PATIENT_NAMES = ["Luna Silva", "Thor Almeida", "Pérola Costa", "Amora Souza", "Bento Lima", "Nina Rocha"] as const;
const RARE_PROTOCOL = "CVG-2026-RARE-0001";
const HOMONYM = "Thor Almeida";

export type SyntheticDepartment = (typeof DEPARTMENTS)[number];
export type SyntheticStatus = (typeof STATUSES)[number];
export type SyntheticOperation = "queue-read" | "search-exact" | "search-text" | "invalid-search";

export interface SyntheticRecord {
  id: string;
  protocol: string;
  patientName: string;
  departmentCode: SyntheticDepartment;
  status: SyntheticStatus;
  createdAt: string;
  historyEvents: number;
  searchableTerms: string[];
}

export interface SyntheticDatasetManifest {
  version: string;
  seed: number;
  records: number;
  historyEvents: number;
  departments: number;
  departmentCounts: Record<SyntheticDepartment, number>;
  maxQueueDepth: number;
  scopedDepartments: SyntheticDepartment[];
  homonym: string;
  rareProtocol: string;
  emptyQuery: string;
  digest: string;
}

export interface SyntheticDataset {
  manifest: SyntheticDatasetManifest;
  records: SyntheticRecord[];
  byProtocol: ReadonlyMap<string, SyntheticRecord[]>;
  byTerm: ReadonlyMap<string, SyntheticRecord[]>;
}

export interface SyntheticDatasetOptions {
  seed?: number;
  recordCount?: number;
  scopedDepartments?: SyntheticDepartment[];
}

export interface SyntheticWorkloadDefinition {
  id: string;
  endpoint: string;
  operation: SyntheticOperation;
  requests: number;
  concurrency: number;
}

export interface SyntheticWorkloadOptions {
  dataset?: SyntheticDataset;
  seed?: number;
  requestsPerWorkload?: number;
  concurrency?: number;
  workloads?: SyntheticWorkloadDefinition[];
}

export interface SyntheticSample {
  status: number;
  durationMs: number;
  expectedError: boolean;
  startedAtMs: number;
  completedAtMs: number;
  resultCount: number;
  scannedRecords: number;
}

export interface SyntheticWorkloadReport extends PerfSummary {
  id: string;
  operation: SyntheticOperation;
  concurrency: number;
  maxInFlight: number;
  virtualDurationMs: number;
  throughputRps: number;
  expectedErrors: number;
  unexpectedErrors: number;
  resultCount: number;
  scannedRecords: number;
}

export interface SyntheticBenchmarkReport {
  benchmark: string;
  result: "PASS" | "CONDITIONAL";
  measurement: "deterministic-virtual-clock";
  dataset: SyntheticDatasetManifest;
  workloads: SyntheticWorkloadReport[];
  aggregate: {
    requests: number;
    errors: number;
    expectedErrors: number;
    unexpectedErrors: number;
    errorRate: number;
    maxP95Ms: number;
    maxP99Ms: number;
    maxConcurrency: number;
    virtualDurationMs: number;
    throughputRps: number;
  };
  localGates: {
    readP95Ms: number;
    exactSearchP95Ms: number;
    textualSearchP95Ms: number;
    unexpectedErrors: number;
    thresholds: {
      readP95Ms: number;
      exactSearchP95Ms: number;
      textualSearchP95Ms: number;
    };
    pass: boolean;
  };
  limitations: string[];
}

const DEFAULT_WORKLOADS: SyntheticWorkloadDefinition[] = [
  {
    id: "operational-queue-read",
    endpoint: "/api/v1/diagnostic-requests?limit=25",
    operation: "queue-read",
    requests: DEFAULT_REQUESTS_PER_WORKLOAD,
    concurrency: 12
  },
  {
    id: "search-exact-protocol",
    endpoint: `/api/v1/search?q=${RARE_PROTOCOL}&limit=25`,
    operation: "search-exact",
    requests: DEFAULT_REQUESTS_PER_WORKLOAD,
    concurrency: 12
  },
  {
    id: "search-textual-homonym",
    endpoint: "/api/v1/search?q=Thor%20Almeida&limit=25",
    operation: "search-text",
    requests: DEFAULT_REQUESTS_PER_WORKLOAD,
    concurrency: 12
  },
  {
    id: "search-validation-error",
    endpoint: "/api/v1/search?q=",
    operation: "invalid-search",
    requests: 12,
    concurrency: 4
  }
];

export function buildSyntheticDataset(options: SyntheticDatasetOptions = {}): SyntheticDataset {
  const seed = normalizeSeed(options.seed ?? DEFAULT_SEED);
  const recordCount = positiveInteger(options.recordCount ?? DEFAULT_RECORD_COUNT, DEFAULT_RECORD_COUNT);
  const scopedDepartments = normalizeDepartments(options.scopedDepartments ?? ["LAB", "RX", "US"]);
  const random = mulberry32(seed);
  const records: SyntheticRecord[] = [];
  const departmentCounts = Object.fromEntries(DEPARTMENTS.map((department) => [department, 0])) as Record<SyntheticDepartment, number>;

  for (let index = 0; index < recordCount; index += 1) {
    const protocol = index === 0 ? RARE_PROTOCOL : `CVG-2026-${String(index).padStart(6, "0")}`;
    const patientName = index % 2 === 0 ? HOMONYM : PATIENT_NAMES[index % PATIENT_NAMES.length];
    const departmentCode = syntheticDepartment(index, recordCount, random);
    const status = syntheticStatus(index);
    departmentCounts[departmentCode] += 1;
    const historyEvents = 1 + Math.floor(random() * 8);
    const createdAt = new Date(Date.UTC(2026, 0, 1 + (index % 365), index % 24, index % 60, index % 60)).toISOString();
    const searchableTerms = tokenize(`${protocol} ${patientName} ${departmentCode} ${status}`);
    records.push({ id: `request-${String(index + 1).padStart(6, "0")}`, protocol, patientName, departmentCode, status, createdAt, historyEvents, searchableTerms });
  }

  const byProtocol = new Map<string, SyntheticRecord[]>();
  const byTerm = new Map<string, SyntheticRecord[]>();
  for (const record of records) {
    const protocolRecords = byProtocol.get(record.protocol) ?? [];
    protocolRecords.push(record);
    byProtocol.set(record.protocol, protocolRecords);
    for (const term of record.searchableTerms) {
      const termRecords = byTerm.get(term) ?? [];
      termRecords.push(record);
      byTerm.set(term, termRecords);
    }
  }

  const historyEvents = records.reduce((total, record) => total + record.historyEvents, 0);
  const queueDepths = DEPARTMENTS.map((department) => records.filter((record) => record.departmentCode === department && record.status === "QUEUED").length);
  const manifestWithoutDigest = {
    version: SYNTHETIC_WORKLOAD_VERSION,
    seed,
    records: records.length,
    historyEvents,
    departments: DEPARTMENTS.length,
    departmentCounts,
    maxQueueDepth: Math.max(...queueDepths, 0),
    scopedDepartments,
    homonym: HOMONYM,
    rareProtocol: RARE_PROTOCOL,
    emptyQuery: ""
  } satisfies Omit<SyntheticDatasetManifest, "digest">;
  const digest = digestRecords(records, scopedDepartments);
  return { manifest: { ...manifestWithoutDigest, digest }, records, byProtocol, byTerm };
}

export function defaultSyntheticWorkloads(options: Pick<SyntheticWorkloadOptions, "requestsPerWorkload" | "concurrency"> = {}): SyntheticWorkloadDefinition[] {
  const requests = positiveInteger(options.requestsPerWorkload ?? DEFAULT_REQUESTS_PER_WORKLOAD, DEFAULT_REQUESTS_PER_WORKLOAD);
  const concurrency = positiveInteger(options.concurrency ?? 12, 12);
  return DEFAULT_WORKLOADS.map((workload) => ({ ...workload, requests: workload.operation === "invalid-search" ? Math.max(4, Math.floor(requests / 10)) : requests, concurrency: workload.operation === "invalid-search" ? Math.min(4, concurrency) : concurrency }));
}

export function runSyntheticWorkload(dataset: SyntheticDataset, workload: SyntheticWorkloadDefinition, seed = DEFAULT_SEED): SyntheticWorkloadReport {
  const requestCount = positiveInteger(workload.requests, DEFAULT_REQUESTS_PER_WORKLOAD);
  const workerCount = Math.min(positiveInteger(workload.concurrency, 1), requestCount);
  const availableAt = Array.from({ length: workerCount }, () => 0);
  const samples: SyntheticSample[] = [];

  for (let requestIndex = 0; requestIndex < requestCount; requestIndex += 1) {
    const worker = requestIndex % workerCount;
    const startedAtMs = availableAt[worker] ?? 0;
    const execution = executeSyntheticRequest(dataset, workload.operation, requestIndex, seed);
    const completedAtMs = round(startedAtMs + execution.durationMs);
    availableAt[worker] = completedAtMs;
    samples.push({ ...execution, startedAtMs: round(startedAtMs), completedAtMs });
  }

  const summary = summarize(workload.endpoint, samples);
  const virtualDurationMs = Math.max(...availableAt, 0);
  const expectedErrors = samples.filter((sample) => sample.expectedError).length;
  const unexpectedErrors = samples.filter((sample) => sample.status < 200 || sample.status >= 300).length - expectedErrors;
  return {
    ...summary,
    id: workload.id,
    operation: workload.operation,
    concurrency: workerCount,
    maxInFlight: workerCount,
    virtualDurationMs,
    throughputRps: round((requestCount / Math.max(1, virtualDurationMs)) * 1000),
    expectedErrors,
    unexpectedErrors,
    resultCount: samples.reduce((total, sample) => total + sample.resultCount, 0),
    scannedRecords: samples.reduce((total, sample) => total + sample.scannedRecords, 0)
  };
}

export function runSyntheticBenchmark(options: SyntheticWorkloadOptions = {}): SyntheticBenchmarkReport {
  const seed = normalizeSeed(options.seed ?? DEFAULT_SEED);
  const dataset = options.dataset ?? buildSyntheticDataset({ seed });
  const workloads = options.workloads ?? defaultSyntheticWorkloads({ requestsPerWorkload: options.requestsPerWorkload, concurrency: options.concurrency });
  const reports = workloads.map((workload, index) => runSyntheticWorkload(dataset, workload, seed + index * 7919));
  const readReports = reports.filter((report) => report.operation === "queue-read");
  const exactReports = reports.filter((report) => report.operation === "search-exact");
  const textReports = reports.filter((report) => report.operation === "search-text");
  const requests = reports.reduce((total, report) => total + report.requests, 0);
  const errors = reports.reduce((total, report) => total + report.errors, 0);
  const expectedErrors = reports.reduce((total, report) => total + report.expectedErrors, 0);
  const unexpectedErrors = reports.reduce((total, report) => total + report.unexpectedErrors, 0);
  // Workloads are measured independently by the CLI, so aggregate duration is
  // the sum of their virtual windows rather than an implied parallel run.
  const virtualDurationMs = reports.reduce((total, report) => total + report.virtualDurationMs, 0);
  const aggregate = {
    requests,
    errors,
    expectedErrors,
    unexpectedErrors,
    errorRate: Number((errors / Math.max(1, requests)).toFixed(4)),
    maxP95Ms: Math.max(...reports.map((report) => report.p95Ms), 0),
    maxP99Ms: Math.max(...reports.map((report) => report.p99Ms), 0),
    maxConcurrency: Math.max(...reports.map((report) => report.maxInFlight), 0),
    virtualDurationMs,
    throughputRps: round((requests / Math.max(1, virtualDurationMs)) * 1000)
  };
  const localGates = {
    readP95Ms: Math.max(...readReports.map((report) => report.p95Ms), 0),
    exactSearchP95Ms: Math.max(...exactReports.map((report) => report.p95Ms), 0),
    textualSearchP95Ms: Math.max(...textReports.map((report) => report.p95Ms), 0),
    unexpectedErrors,
    thresholds: { readP95Ms: 500, exactSearchP95Ms: 300, textualSearchP95Ms: 800 },
    pass: false
  };
  localGates.pass = localGates.readP95Ms <= localGates.thresholds.readP95Ms &&
    localGates.exactSearchP95Ms <= localGates.thresholds.exactSearchP95Ms &&
    localGates.textualSearchP95Ms <= localGates.thresholds.textualSearchP95Ms &&
    localGates.unexpectedErrors === 0;

  return {
    benchmark: "AAA2-042/043 local synthetic performance harness",
    result: localGates.pass ? "PASS" : "CONDITIONAL",
    measurement: "deterministic-virtual-clock",
    dataset: dataset.manifest,
    workloads: reports,
    aggregate,
    localGates,
    limitations: [
      "The dataset and latency model are deterministic synthetic fixtures; they are not a hospital or pilot workload.",
      "The virtual clock does not measure wall-clock latency, CPU, memory, network, PostgreSQL locks, query plans or EXPLAIN output.",
      "No two-instance fanout, durable PostgreSQL, soak run, object storage, resource saturation or approved SLO was exercised.",
      "NFR-PERF-001/002 remain conditional until D-05, a representative pilot manifest and target-environment evidence are approved."
    ]
  };
}

export function executeSyntheticRequest(dataset: SyntheticDataset, operation: SyntheticOperation, requestIndex: number, seed = DEFAULT_SEED): Omit<SyntheticSample, "startedAtMs" | "completedAtMs"> {
  if (operation === "invalid-search") return { status: 400, durationMs: 5, expectedError: true, resultCount: 0, scannedRecords: 0 };

  const scoped = (record: SyntheticRecord): boolean => dataset.manifest.scopedDepartments.includes(record.departmentCode);
  let resultCount = 0;
  let scannedRecords = 0;
  if (operation === "queue-read") {
    const status = STATUSES[requestIndex % STATUSES.length];
    const department = dataset.manifest.scopedDepartments[requestIndex % dataset.manifest.scopedDepartments.length];
    const candidates = dataset.records.filter((record) => record.departmentCode === department && record.status === status);
    scannedRecords = candidates.length;
    resultCount = candidates.filter(scoped).slice(0, 25).length;
  } else if (operation === "search-exact") {
    const candidates = dataset.byProtocol.get(RARE_PROTOCOL) ?? [];
    scannedRecords = candidates.length;
    resultCount = candidates.filter(scoped).slice(0, 25).length;
  } else {
    const firstTerm = dataset.byTerm.get("thor") ?? [];
    const secondTermIds = new Set((dataset.byTerm.get("almeida") ?? []).map((record) => record.id));
    const candidates = firstTerm.filter((record) => secondTermIds.has(record.id));
    scannedRecords = candidates.length;
    resultCount = candidates.filter(scoped).slice(0, 25).length;
  }

  const baseDuration = operation === "queue-read" ? 72 : operation === "search-exact" ? 44 : 128;
  const scanCost = operation === "search-text" ? Math.ceil(scannedRecords / 60) : Math.ceil(scannedRecords / 25);
  const jitter = deterministicJitter(seed, requestIndex, operation);
  const durationMs = round(baseDuration + scanCost + jitter);
  return { status: 200, durationMs, expectedError: false, resultCount, scannedRecords };
}

function tokenize(value: string): string[] {
  return [...new Set(value.toLocaleLowerCase("pt-BR").normalize("NFD").replace(/[\u0300-\u036f]/g, "").match(/[a-z0-9-]+/g) ?? [])];
}

function syntheticDepartment(index: number, recordCount: number, random: () => number): SyntheticDepartment {
  const share = index / Math.max(1, recordCount);
  if (share < 0.55) return "LAB";
  if (share < 0.72) return "RX";
  if (share < 0.84) return "US";
  return DEPARTMENTS[3 + Math.floor(random() * (DEPARTMENTS.length - 3))] ?? "CARDIO";
}

function syntheticStatus(index: number): SyntheticStatus {
  if (index % 10 < 5) return "QUEUED";
  if (index % 10 < 7) return "IN_PROGRESS";
  if (index % 10 < 9) return "COMPLETED";
  return "CANCELLED";
}

function deterministicJitter(seed: number, requestIndex: number, operation: SyntheticOperation): number {
  let value = normalizeSeed(seed ^ Math.imul(requestIndex + 1, 0x45d9f3b) ^ hashString(operation));
  value ^= value >>> 16;
  value = Math.imul(value, 0x45d9f3b);
  value ^= value >>> 16;
  return (value >>> 0) % 17;
}

function digestRecords(records: SyntheticRecord[], scopedDepartments: SyntheticDepartment[]): string {
  const serialized = records.map((record) => `${record.id}|${record.protocol}|${record.patientName}|${record.departmentCode}|${record.status}|${record.historyEvents}`).join("\n") + `|scope=${scopedDepartments.join(",")}`;
  return hashString(serialized).toString(16).padStart(8, "0");
}

function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = normalizeSeed(seed);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function normalizeSeed(value: number): number {
  if (!Number.isSafeInteger(value)) return DEFAULT_SEED;
  return value >>> 0;
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function normalizeDepartments(departments: SyntheticDepartment[]): SyntheticDepartment[] {
  const selected = [...new Set(departments)].filter((department): department is SyntheticDepartment => DEPARTMENTS.includes(department));
  return selected.length > 0 ? selected : ["LAB", "RX", "US"];
}

async function main(): Promise<void> {
  const report = runSyntheticBenchmark({
    seed: parseInteger(process.env.PERF_SYNTHETIC_SEED, DEFAULT_SEED),
    requestsPerWorkload: parseInteger(process.env.PERF_SYNTHETIC_REQUESTS, DEFAULT_REQUESTS_PER_WORKLOAD),
    concurrency: parseInteger(process.env.PERF_SYNTHETIC_CONCURRENCY, 12)
  });
  console.log(JSON.stringify(report, null, 2));
  if (process.env.PERF_SYNTHETIC_ENFORCE !== "false" && !report.localGates.pass) throw new Error("O benchmark sintético não atingiu os limites locais configurados.");
}

function parseInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Benchmark sintético falhou.");
  process.exitCode = 1;
});
