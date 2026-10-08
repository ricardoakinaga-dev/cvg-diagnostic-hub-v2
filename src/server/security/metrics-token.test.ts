import { describe, expect, it } from "vitest";
import { assertMetricsTokenConfiguration, metricsScrapeAuthorized } from "./metrics-token";

const TOKEN = "prometheus-scrape-token-0123456789abcdef";
const scrape = (authorization?: string) => new Request("http://localhost/api/v1/metrics", authorization ? { headers: { authorization } } : {});

describe("Prometheus scrape token", () => {
  it("is optional, and refuses a configured value shorter than 32 characters", () => {
    expect(() => assertMetricsTokenConfiguration({})).not.toThrow();
    expect(() => assertMetricsTokenConfiguration({ METRICS_SCRAPE_TOKEN: "" })).not.toThrow();
    expect(() => assertMetricsTokenConfiguration({ METRICS_SCRAPE_TOKEN: TOKEN })).not.toThrow();
    expect(() => assertMetricsTokenConfiguration({ METRICS_SCRAPE_TOKEN: "short-token" })).toThrow("METRICS_SCRAPE_TOKEN");
    expect(() => assertMetricsTokenConfiguration({ METRICS_SCRAPE_TOKEN: `   ${"x".repeat(20)}   ` })).toThrow("METRICS_SCRAPE_TOKEN");
  });

  it("accepts only the exact bearer token", () => {
    const environment = { METRICS_SCRAPE_TOKEN: TOKEN };
    expect(metricsScrapeAuthorized(scrape(`Bearer ${TOKEN}`), environment)).toBe(true);
    expect(metricsScrapeAuthorized(scrape(`Bearer  ${TOKEN}`), environment)).toBe(true);
    for (const header of [undefined, TOKEN, `bearer ${TOKEN}`, `Basic ${TOKEN}`, `Bearer ${TOKEN} extra`, `Bearer ${TOKEN.slice(0, -1)}`, "Bearer "]) {
      expect(metricsScrapeAuthorized(scrape(header), environment), String(header)).toBe(false);
    }
  });

  it("is disabled when no valid token is configured", () => {
    expect(metricsScrapeAuthorized(scrape(`Bearer ${TOKEN}`), {})).toBe(false);
    expect(metricsScrapeAuthorized(scrape("Bearer short"), { METRICS_SCRAPE_TOKEN: "short" })).toBe(false);
  });
});
