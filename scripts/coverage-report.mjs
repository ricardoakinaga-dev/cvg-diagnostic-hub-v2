import { readFile } from "node:fs/promises";
import path from "node:path";

export const COVERAGE_THRESHOLDS = Object.freeze({ lines: 90, functions: 90, branches: 85 });

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
  console.log(JSON.stringify(buildCoverageReport(summary), null, 2));
}
