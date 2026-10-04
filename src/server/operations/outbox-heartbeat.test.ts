import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertFreshOutboxHeartbeat,
  assertOutboxHeartbeatWithinTolerance,
  assertSuccessfulOutboxHeartbeat,
  checkOutboxHeartbeat,
  DEFAULT_OUTBOX_HEARTBEAT_ERROR_TOLERANCE,
  DEFAULT_OUTBOX_HEARTBEAT_FILE,
  DEFAULT_OUTBOX_HEARTBEAT_MAX_AGE_MS,
  nextOutboxHeartbeatErrorCount,
  outboxCycleHeartbeatResult,
  outboxHeartbeatHealth,
  readOutboxHeartbeat,
  resolveOutboxHeartbeatErrorTolerance,
  resolveOutboxHeartbeatFile,
  resolveOutboxHeartbeatMaxAgeMs,
  writeOutboxHeartbeat,
  type OutboxHeartbeatCheck
} from "./outbox-heartbeat";

const HEARTBEAT_ENV_KEY = "OUTBOX_HEARTBEAT_ERROR_TOLERANCE";

describe("outbox worker heartbeat", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "cvg-outbox-heartbeat-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
    delete process.env[HEARTBEAT_ENV_KEY];
  });

  it("writes an atomic, bounded heartbeat with timestamp and last result", async () => {
    const filePath = join(directory, "heartbeat.json");
    const now = new Date("2026-10-02T12:00:00.000Z");

    await expect(writeOutboxHeartbeat(filePath, "success", now)).resolves.toEqual({
      timestamp: now.toISOString(),
      lastResult: "success",
      consecutiveErrors: 0,
      health: "ok"
    });
    await expect(readFile(filePath, "utf8")).resolves.toBe(
      `${JSON.stringify({ timestamp: now.toISOString(), lastResult: "success", consecutiveErrors: 0, health: "ok" })}\n`
    );
    expect(await checkOutboxHeartbeat(filePath, 5_000, new Date("2026-10-02T12:00:01.000Z"))).toEqual({
      heartbeat: { timestamp: now.toISOString(), lastResult: "success", consecutiveErrors: 0, health: "ok" },
      ageMs: 1_000
    });
  });

  it("stores an error result without exposing error details", async () => {
    const filePath = join(directory, "heartbeat.json");
    await writeOutboxHeartbeat(filePath, "error", new Date("2026-10-02T12:00:00.000Z"));

    const content = await readFile(filePath, "utf8");
    expect(content).toContain('"lastResult":"error"');
    expect(content).not.toContain("password");
    expect(content).not.toContain("secret");
    expect(() => assertSuccessfulOutboxHeartbeat({
      heartbeat: { timestamp: "2026-10-02T12:00:00.000Z", lastResult: "error", consecutiveErrors: 1, health: "degraded" },
      ageMs: 0
    })).toThrowError(expect.objectContaining({ code: "OUTBOX_WORKER_LAST_CYCLE_FAILED" }));
  });

  it("fails closed for a missing heartbeat", async () => {
    const filePath = join(directory, "heartbeat.json");

    await expect(readOutboxHeartbeat(filePath)).rejects.toMatchObject({
      code: "OUTBOX_HEARTBEAT_FILE_MISSING"
    });
  });

  it("rejects invalid content and timestamps with stable failure codes", async () => {
    const filePath = join(directory, "heartbeat.json");
    await writeFile(filePath, "{\"timestamp\":\"bad\",\"lastResult\":\"success\"}", "utf8");
    await expect(readOutboxHeartbeat(filePath)).rejects.toMatchObject({ code: "OUTBOX_HEARTBEAT_INVALID" });
    expect(() => assertFreshOutboxHeartbeat({ timestamp: "not-a-date", lastResult: "success" }, 1_000)).toThrowError(
      expect.objectContaining({ code: "OUTBOX_HEARTBEAT_INVALID" })
    );

    expect(() => assertFreshOutboxHeartbeat({ timestamp: "2026-10-02T12:00:00.000Z", lastResult: "success" }, 0)).toThrowError(
      expect.objectContaining({ code: "OUTBOX_HEARTBEAT_MAX_AGE_INVALID" })
    );
    expect(() => assertFreshOutboxHeartbeat({ timestamp: "2026-10-02T12:00:00.000Z", lastResult: "success" }, 1_000, new Date("2026-10-02T12:00:02.001Z"))).toThrowError(
      expect.objectContaining({ code: "OUTBOX_HEARTBEAT_STALE" })
    );
    expect(() => assertFreshOutboxHeartbeat({ timestamp: "2026-10-02T12:00:02.000Z", lastResult: "success" }, 1_000, new Date("2026-10-02T12:00:01.000Z"))).toThrowError(
      expect.objectContaining({ code: "OUTBOX_HEARTBEAT_FUTURE" })
    );
  });

  it("resolves safe defaults and rejects an invalid configured age", async () => {
    expect(resolveOutboxHeartbeatFile({})).toBe(DEFAULT_OUTBOX_HEARTBEAT_FILE);
    expect(resolveOutboxHeartbeatFile({ OUTBOX_HEARTBEAT_FILE: "   " })).toBe(DEFAULT_OUTBOX_HEARTBEAT_FILE);
    expect(resolveOutboxHeartbeatMaxAgeMs({})).toBe(DEFAULT_OUTBOX_HEARTBEAT_MAX_AGE_MS);
    expect(resolveOutboxHeartbeatMaxAgeMs({ OUTBOX_HEARTBEAT_MAX_AGE_MS: "2500" })).toBe(2_500);
    expect(() => resolveOutboxHeartbeatMaxAgeMs({ OUTBOX_HEARTBEAT_MAX_AGE_MS: "not-a-number" })).toThrowError(
      expect.objectContaining({ code: "OUTBOX_HEARTBEAT_MAX_AGE_INVALID" })
    );
    await expect(writeOutboxHeartbeat("   ", "success")).rejects.toMatchObject({
      code: "OUTBOX_HEARTBEAT_PATH_INVALID"
    });
    await expect(writeOutboxHeartbeat(join(directory, "invalid-result.json"), "unknown" as "success"))
      .rejects.toMatchObject({ code: "OUTBOX_HEARTBEAT_RESULT_INVALID" });
  });

  it("keeps a single failed cycle degraded and only reports unhealthy at the budget", () => {
    expect(resolveOutboxHeartbeatErrorTolerance({})).toBe(DEFAULT_OUTBOX_HEARTBEAT_ERROR_TOLERANCE);
    expect(resolveOutboxHeartbeatErrorTolerance({ OUTBOX_HEARTBEAT_ERROR_TOLERANCE: "2" })).toBe(2);
    expect(() => resolveOutboxHeartbeatErrorTolerance({ OUTBOX_HEARTBEAT_ERROR_TOLERANCE: "0" })).toThrowError(
      expect.objectContaining({ code: "OUTBOX_HEARTBEAT_ERROR_TOLERANCE_INVALID" })
    );
    expect(nextOutboxHeartbeatErrorCount(2, "error")).toBe(3);
    expect(nextOutboxHeartbeatErrorCount(2, "success")).toBe(0);
    expect(outboxHeartbeatHealth("success", 0, 3)).toBe("ok");
    expect(outboxHeartbeatHealth("error", 2, 3)).toBe("degraded");
    expect(outboxHeartbeatHealth("error", 3, 3)).toBe("unhealthy");

    const degraded: OutboxHeartbeatCheck = {
      heartbeat: { timestamp: "2026-10-02T12:00:00.000Z", lastResult: "error", consecutiveErrors: 2, health: "degraded" },
      ageMs: 0
    };
    expect(assertOutboxHeartbeatWithinTolerance(degraded, 3)).toBe(degraded);
    expect(() => assertOutboxHeartbeatWithinTolerance(degraded, 2)).toThrowError(
      expect.objectContaining({ code: "OUTBOX_WORKER_LAST_CYCLE_FAILED" })
    );
  });

  it("writes the tolerance verdict into the heartbeat and honours a configured budget", async () => {
    const filePath = join(directory, "tolerance.json");
    process.env[HEARTBEAT_ENV_KEY] = "2";

    await writeOutboxHeartbeat(filePath, "error", new Date("2026-10-02T12:00:00.000Z"), 1);
    expect(await readOutboxHeartbeat(filePath)).toEqual({
      timestamp: "2026-10-02T12:00:00.000Z",
      lastResult: "error",
      consecutiveErrors: 1,
      health: "degraded"
    });

    await writeOutboxHeartbeat(filePath, "error", new Date("2026-10-02T12:00:05.000Z"), 2);
    expect((await readOutboxHeartbeat(filePath)).health).toBe("unhealthy");

    await writeOutboxHeartbeat(filePath, "success", new Date("2026-10-02T12:00:10.000Z"), 0);
    expect((await readOutboxHeartbeat(filePath)).health).toBe("ok");
  });

  it("reads legacy heartbeats without a counter and rejects unknown or invalid fields", async () => {
    const filePath = join(directory, "legacy.json");
    await writeFile(filePath, JSON.stringify({ timestamp: "2026-10-02T12:00:00.000Z", lastResult: "success" }), "utf8");
    expect(await readOutboxHeartbeat(filePath)).toEqual({
      timestamp: "2026-10-02T12:00:00.000Z",
      lastResult: "success",
      consecutiveErrors: 0,
      health: "ok"
    });

    await writeFile(filePath, JSON.stringify({ timestamp: "2026-10-02T12:00:00.000Z", lastResult: "error" }), "utf8");
    expect((await readOutboxHeartbeat(filePath)).consecutiveErrors).toBe(1);

    for (const payload of [
      JSON.stringify({ timestamp: "2026-10-02T12:00:00.000Z", lastResult: "success", unexpected: true }),
      JSON.stringify({ timestamp: "2026-10-02T12:00:00.000Z", lastResult: "success", consecutiveErrors: -1 }),
      JSON.stringify({ timestamp: "2026-10-02T12:00:00.000Z", lastResult: "success", consecutiveErrors: 1.5 }),
      JSON.stringify({ timestamp: "2026-10-02T12:00:00.000Z", lastResult: "success", health: "unknown" }),
      JSON.stringify({ timestamp: "2026-10-02T12:00:00.000Z", lastResult: "nope" }),
      "[]"
    ]) {
      await writeFile(filePath, payload, "utf8");
      await expect(readOutboxHeartbeat(filePath)).rejects.toMatchObject({ code: "OUTBOX_HEARTBEAT_INVALID" });
    }
  });

  it("reports an unreadable heartbeat file distinctly from a missing one", async () => {
    const directoryPath = join(directory, "as-a-directory");
    await mkdir(directoryPath, { recursive: true });

    await expect(readOutboxHeartbeat(directoryPath)).rejects.toMatchObject({
      code: "OUTBOX_HEARTBEAT_FILE_UNREADABLE"
    });
  });

  it("marks retried and permanently failed batches unhealthy until a clean cycle", () => {
    expect(outboxCycleHeartbeatResult({ failed: 0, retried: 1 })).toBe("error");
    expect(outboxCycleHeartbeatResult({ failed: 1, retried: 0 })).toBe("error");
    expect(outboxCycleHeartbeatResult({ failed: 0, retried: 0 })).toBe("success");
  });
});
