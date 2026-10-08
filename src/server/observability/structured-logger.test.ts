import { describe, expect, it } from "vitest";
import { createStructuredLogger, logHttpRequest } from "./structured-logger";

describe("structured observability logger", () => {
  it("emits only bounded allowlisted fields and never request secrets or clinical payloads", () => {
    const lines: string[] = [];
    const logger = createStructuredLogger({
      enabled: true,
      now: () => new Date("2026-09-07T12:00:00.000Z"),
      write: (line) => lines.push(line)
    });

    logger.info("http.request", {
      method: "get\n",
      route: "/api/v1/requests/[id]",
      status: 200,
      durationMs: 12.5,
      correlationId: "corr_123e4567-e89b-12d3-a456-426614174000",
      password: "must-not-appear",
      authorization: "Bearer secret",
      body: JSON.stringify({ patientName: "Luna" }),
      clinicalValue: "hidden",
      unboundedExtra: "ignored"
    });

    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(record).toMatchObject({
      timestamp: "2026-09-07T12:00:00.000Z",
      level: "info",
      event: "http.request",
      method: "get",
      route: "/api/v1/requests/[id]",
      status: 200,
      durationMs: 12.5,
      correlationId: "corr_123e4567-e89b-12d3-a456-426614174000"
    });
    expect(JSON.stringify(record)).not.toContain("must-not-appear");
    expect(JSON.stringify(record)).not.toContain("Bearer secret");
    expect(JSON.stringify(record)).not.toContain("Luna");
    expect(record.unboundedExtra).toBeUndefined();

    logger.info("http.request", { correlationId: "patient-Luna" });
    const redactedCorrelation = JSON.parse(lines[1]!);
    expect(redactedCorrelation.correlationId).toBe("external");
    expect(JSON.stringify(redactedCorrelation)).not.toContain("patient-Luna");
  });

  it("normalizes invalid status and duration values without throwing", () => {
    const lines: string[] = [];
    logHttpRequest(
      { method: "POST", route: "/api/v1/diagnostic-requests", status: 999, durationMs: Number.POSITIVE_INFINITY, correlationId: "corr" },
      { enabled: true, write: (line) => lines.push(line) }
    );

    expect(JSON.parse(lines[0]!)).toMatchObject({ status: 500, durationMs: 0, component: "http" });
  });

  it("can be disabled in tests or during a deliberate quiet window", () => {
    const lines: string[] = [];
    const logger = createStructuredLogger({ enabled: false, write: (line) => lines.push(line) });
    logger.error("http.failure", { errorCode: "INTERNAL" });
    expect(() => logger.error("http.failure", { errorCode: "INTERNAL" })).not.toThrow();
    expect(lines).toEqual([]);
  });

  it("does not let a failing log writer change the request outcome", () => {
    const logger = createStructuredLogger({ enabled: true, write: () => { throw new Error("sink unavailable"); } });
    expect(() => logger.warn("http.degraded", { route: "/api/v1/readyz" })).not.toThrow();
  });

  it("keeps the pseudonymous account signal fields and drops anything identifying", () => {
    const lines: string[] = [];
    const logger = createStructuredLogger({ enabled: true, write: (line) => lines.push(line) });
    logger.warn("security.login_distributed_attempts", { component: "security", accountId: "0123456789abcdef", attempts: 20, distinctClients: 7, windowMs: 900000, threshold: 20, reason: "x", email: "vet@cvg.local" });
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: "warn", accountId: "0123456789abcdef", attempts: 20, distinctClients: 7, windowMs: 900000, threshold: 20 });
    expect(lines[0]).not.toContain("vet@cvg.local");
  });
});
