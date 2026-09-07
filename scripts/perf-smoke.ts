import { percentile, round, summarize } from "./perf-report";

const baseUrl = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const totalRequests = positiveInteger(process.env.PERF_REQUESTS, 100);
const concurrency = positiveInteger(process.env.PERF_CONCURRENCY, 10);
const warmupRequests = positiveInteger(process.env.PERF_WARMUP, 10);
const targetP95Ms = positiveNumber(process.env.PERF_TARGET_P95_MS, 500);
const enforce = process.env.PERF_ENFORCE !== "false";
const workloads = [
  { endpoint: "/api/v1/diagnostic-services", path: "/api/v1/diagnostic-services" },
  { endpoint: "/api/v1/diagnostic-requests?limit=25", path: "/api/v1/diagnostic-requests?limit=25" },
  { endpoint: "/api/v1/search?q=HEMOGRAM&limit=25", path: "/api/v1/search?q=HEMOGRAM&limit=25" },
  { endpoint: "/api/v1/dashboard", path: "/api/v1/dashboard" }
] as const;

async function main(): Promise<void> {
  const cookie = await login();
  await Promise.all(workloads.map((workload) => runBatch(workload.path, warmupRequests, concurrency, cookie)));
  const reports = await Promise.all(workloads.map(async (workload) => summarize(workload.endpoint, await runBatch(workload.path, totalRequests, concurrency, cookie))));
  const errors = reports.reduce((total, report) => total + report.errors, 0);
  const requests = reports.reduce((total, report) => total + report.requests, 0);
  const report = {
    workloads: reports,
    requests,
    concurrency,
    errors,
    errorRate: Number((errors / Math.max(1, requests)).toFixed(4)),
    maxP95Ms: Math.max(...reports.map((entry) => entry.p95Ms)),
    targetP95Ms
  };
  console.log(JSON.stringify(report, null, 2));
  if (enforce && (report.errors > 0 || report.maxP95Ms > targetP95Ms)) throw new Error("Performance smoke não atingiu o alvo configurado.");
}

async function login(): Promise<string> {
  const password = process.env.PERF_PASSWORD ?? process.env.DEMO_PASSWORD;
  if (!password) throw new Error("PERF_PASSWORD ou DEMO_PASSWORD é obrigatório para o smoke de performance.");
  const response = await fetch(`${baseUrl}/api/v1/session/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: process.env.PERF_EMAIL ?? "vet@cvg.local", password })
  });
  if (!response.ok) throw new Error(`Login de performance falhou com HTTP ${response.status}.`);
  const setCookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [response.headers.get("set-cookie") ?? ""];
  const cookies = setCookies.map((value) => value.split(";", 1)[0]).filter((value) => value.startsWith("cvg_session=") || value.startsWith("cvg_csrf=")).join("; ");
  if (!cookies.includes("cvg_session=") || !cookies.includes("cvg_csrf=")) throw new Error("Login de performance não retornou cookies esperados.");
  return cookies;
}

async function runBatch(path: string, count: number, workers: number, cookie: string): Promise<Array<{ status: number; durationMs: number }>> {
  const results: Array<{ status: number; durationMs: number }> = [];
  await Promise.all(Array.from({ length: Math.min(workers, count) }, async (_, worker) => {
    for (let index = worker; index < count; index += workers) {
      const started = performance.now();
      const response = await fetch(`${baseUrl}${path}`, { headers: { cookie } });
      results.push({ status: response.status, durationMs: round(performance.now() - started) });
      await response.arrayBuffer();
    }
  }));
  return results;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Performance smoke falhou.");
  process.exitCode = 1;
});
