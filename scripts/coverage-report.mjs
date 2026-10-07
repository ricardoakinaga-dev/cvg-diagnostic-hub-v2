import { readFile } from "node:fs/promises";
import path from "node:path";

export const COVERAGE_THRESHOLDS = Object.freeze({ lines: 90, functions: 90, branches: 85 });
export const COVERAGE_EXCEPTIONS_FILE = "docs/build/COVERAGE_EXCEPTIONS.json";

const LAYERS = [
  ["contracts", "packages/contracts/"],
  ["domain", "packages/domain/"],
  ["services", "packages/services/"],
  ["ui", "packages/ui/"],
  ["app", "src/app/"],
  ["components", "src/components/"],
  ["features", "src/features/"],
  ["application", "src/server/application/"],
  ["domain-server", "src/server/domain/"],
  ["http", "src/server/http/"],
  ["observability", "src/server/observability/"],
  ["operations", "src/server/operations/"],
  ["security", "src/server/security/"],
  ["storage", "src/server/storage/"],
  ["store", "src/server/store/"]
];

export async function readCoverageSummary(file = "coverage/coverage-summary.json") {
  return JSON.parse(await readFile(file, "utf8"));
}

export async function readCoverageExceptions(file = COVERAGE_EXCEPTIONS_FILE) {
  const parsed = JSON.parse(await readFile(file, "utf8"));
  if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.entries)) {
    throw new Error(`Invalid coverage exception registry: ${file}`);
  }
  const entries = parsed.entries.map((entry) => {
    if (!entry || typeof entry.file !== "string" || !entry.file || typeof entry.reason !== "string" || !entry.reason.trim()) {
      throw new Error(`Coverage exception entries require file and reason: ${file}`);
    }
    return { file: entry.file, reason: entry.reason.trim() };
  });
  const duplicateFiles = entries.map((entry) => entry.file).filter((file, index, files) => files.indexOf(file) !== index);
  if (duplicateFiles.length > 0) throw new Error(`Duplicate coverage exception: ${duplicateFiles[0]}`);
  return entries;
}

export function buildCoverageReport(summary, root = process.cwd()) {
  const files = Object.entries(summary)
    .filter(([file]) => file !== "total")
    .map(([file, metrics]) => ({ file: path.relative(root, file) || file, metrics }))
    .sort((left, right) => left.file.localeCompare(right.file));
  const totals = hasCoverageMetrics(summary.total)
    ? normalizeTotals(summary.total)
    : aggregate(files.map(({ metrics }) => metrics));
  const layers = Object.fromEntries(LAYERS.map(([name, prefix]) => [name, aggregate(files.filter(({ file }) => file.startsWith(prefix)).map(({ metrics }) => metrics))]));
  const belowThresholdFiles = files
    .filter(({ metrics }) => Object.entries(COVERAGE_THRESHOLDS).some(([metric, threshold]) => percentage(metrics[metric]) < threshold))
    .map(({ file, metrics }) => ({
      file,
      lines: percentage(metrics.lines),
      functions: percentage(metrics.functions),
      branches: percentage(metrics.branches)
    }));

  return {
    schemaVersion: 1,
    source: "coverage/coverage-summary.json",
    thresholds: COVERAGE_THRESHOLDS,
    totals,
    layers,
    belowThresholdFiles
  };
}

export function evaluateCoverageGate(report, exceptions) {
  const belowThresholdFiles = report.belowThresholdFiles.map(({ file }) => file);
  const exceptionFiles = new Set(exceptions.map(({ file }) => file));
  const uncovered = belowThresholdFiles.filter((file) => !exceptionFiles.has(file));
  const stale = exceptions.map(({ file }) => file).filter((file) => !belowThresholdFiles.includes(file));
  return { passed: uncovered.length === 0 && stale.length === 0, uncovered, stale };
}

function hasCoverageMetrics(metrics) {
  return ["lines", "functions", "branches"].every((metric) => metrics?.[metric]);
}

function normalizeTotals(metrics) {
  return Object.fromEntries(["lines", "functions", "branches"].map((metric) => {
    const value = metrics[metric];
    return [metric, {
      total: Number(value.total ?? 0),
      covered: Number(value.covered ?? 0),
      skipped: Number(value.skipped ?? 0),
      pct: Number(value.pct ?? percentage(value))
    }];
  }));
}

function percentage(metric) {
  const total = Number(metric?.total ?? 0);
  const covered = Number(metric?.covered ?? 0);
  return total === 0 ? 100 : Number(((covered / total) * 100).toFixed(2));
}

function aggregate(metricsList) {
  const result = {};
  for (const metric of ["lines", "functions", "branches"]) {
    const total = metricsList.reduce((sum, entry) => sum + Number(entry?.[metric]?.total ?? 0), 0);
    const covered = metricsList.reduce((sum, entry) => sum + Number(entry?.[metric]?.covered ?? 0), 0);
    const skipped = metricsList.reduce((sum, entry) => sum + Number(entry?.[metric]?.skipped ?? 0), 0);
    result[metric] = { total, covered, skipped, pct: total === 0 ? 100 : Number(((covered / total) * 100).toFixed(2)) };
  }
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const summary = await readCoverageSummary(process.env.COVERAGE_SUMMARY ?? "coverage/coverage-summary.json");
  const report = buildCoverageReport(summary);
  if (!process.argv.includes("--check")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const exceptions = await readCoverageExceptions(process.env.COVERAGE_EXCEPTIONS ?? COVERAGE_EXCEPTIONS_FILE);
    const gate = evaluateCoverageGate(report, exceptions);
    console.log(JSON.stringify({ schemaVersion: 1, status: gate.passed ? "PASS" : "FAIL", belowThresholdFiles: report.belowThresholdFiles.length, exceptions: exceptions.length, ...gate }, null, 2));
    if (!gate.passed) {
      if (gate.uncovered.length > 0) console.error(`Coverage files without a declared exception: ${gate.uncovered.join(", ")}`);
      if (gate.stale.length > 0) console.error(`Stale coverage exceptions: ${gate.stale.join(", ")}`);
      process.exitCode = 1;
    }
  }
}
