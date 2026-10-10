import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoState } from "../store/fixtures";
import {
  recordHttpRequest, recordReadinessFailure, recordRealtimeConnectionRejected, recordWriteQueue, refreshOperationalMetrics,
  releaseRealtimeConnection, renderPrometheus, resetMetrics, tryAcquireRealtimeConnection
} from "./metrics";

const OBSERVABILITY = path.resolve(process.cwd(), "deploy/observability");
// Prometheus' own series and PromQL functions/keywords; everything else must come from the application.
const PROMETHEUS_SERIES = new Set(["up"]);
const PROMQL_WORDS = new Set(["clamp_min", "on", "by", "sum", "rate", "increase", "delta"]);

function metricNames(expression: string): string[] {
  return [...expression.matchAll(/\b([a-z_][a-z0-9_]*)(?=\s*[{[\s)/<>]|$)/g)]
    .map(([, name]) => name)
    .filter((name) => (name.includes("_") || PROMETHEUS_SERIES.has(name)) && !PROMQL_WORDS.has(name));
}

function renderedMetricNames(): Set<string> {
  recordHttpRequest("GET", "/api/v1/diagnostic-requests", 500, 12);
  recordReadinessFailure();
  recordRealtimeConnectionRejected("connection_limit");
  tryAcquireRealtimeConnection(10);
  refreshOperationalMetrics(createDemoState("alert-contract-password"), new Date(), { recollectionRate: undefined, resultViewLatencySeconds: undefined }, { pending: 0, deadLetters: 1 });
  // What the metrics handler records from a PostgreSQL store (D-061).
  recordWriteQueue({ inFlight: 0, completed: 1, waitMsTotal: 1, holdMsTotal: 1 });
  const rendered = renderPrometheus();
  releaseRealtimeConnection();
  return new Set(rendered.split("\n").filter((line) => line && !line.startsWith("#")).map((line) => line.split(/[{ ]/)[0]));
}

describe("observability contract", () => {
  afterEach(() => resetMetrics());

  it("alert rules reference only metrics that GET /metrics renders", async () => {
    const rules = await readFile(path.join(OBSERVABILITY, "alerts.yml"), "utf8");
    const referenced = new Set([...rules.matchAll(/expr:\s*(\|\n(?:\s{10,}.*\n)+|.*)/g)].flatMap(([, expression]) => metricNames(expression)));
    const rendered = renderedMetricNames();
    expect(referenced.size).toBeGreaterThan(5);
    for (const name of referenced) {
      if (!PROMETHEUS_SERIES.has(name)) expect(rendered.has(name), `${name} is used by an alert but not rendered`).toBe(true);
    }
  });

  it("dashboard panels query only rendered metrics", async () => {
    const dashboard = JSON.parse(await readFile(path.join(OBSERVABILITY, "grafana-dashboard.json"), "utf8")) as { panels: { targets: { expr: string }[] }[] };
    const referenced = new Set(dashboard.panels.flatMap((panel) => panel.targets.flatMap((target) => metricNames(target.expr))));
    const rendered = renderedMetricNames();
    expect(referenced.size).toBeGreaterThan(8);
    for (const name of referenced) expect(rendered.has(name), `${name} is on the dashboard but not rendered`).toBe(true);
  });
});
