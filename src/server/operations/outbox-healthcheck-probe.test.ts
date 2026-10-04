import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeOutboxHeartbeat } from "./outbox-heartbeat";

const run = promisify(execFile);
const PROBE = join(process.cwd(), "scripts/outbox-healthcheck.mjs");

/**
 * The compose healthcheck runs plain node without a TypeScript toolchain, so
 * the probe is exercised here as a child process exactly as the container runs
 * it: a stale or degraded worker has to fail the probe with a stable code.
 */
describe("outbox worker liveness probe", () => {
  let directory: string;
  let filePath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "cvg-outbox-probe-"));
    filePath = join(directory, "heartbeat.json");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("accepts a fresh successful heartbeat", async () => {
    await writeOutboxHeartbeat(filePath, "success");
    const { stdout } = await run(process.execPath, [PROBE], { env: { ...process.env, OUTBOX_HEARTBEAT_FILE: filePath } });

    expect(JSON.parse(stdout.trim())).toMatchObject({ event: "outbox.healthcheck", status: "ok", lastResult: "success" });
  });

  it("fails with a stable reason for a missing, invalid or stale heartbeat", async () => {
    await expect(run(process.execPath, [PROBE], { env: { ...process.env, OUTBOX_HEARTBEAT_FILE: filePath } }))
      .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("OUTBOX_HEARTBEAT_FILE_MISSING") });

    await writeFile(filePath, "{not-json", "utf8");
    await expect(run(process.execPath, [PROBE], { env: { ...process.env, OUTBOX_HEARTBEAT_FILE: filePath } }))
      .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("OUTBOX_HEARTBEAT_INVALID") });

    await writeOutboxHeartbeat(filePath, "success", new Date(Date.now() - 120_000));
    await expect(run(process.execPath, [PROBE], { env: { ...process.env, OUTBOX_HEARTBEAT_FILE: filePath, OUTBOX_HEARTBEAT_MAX_AGE_MS: "30000" } }))
      .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("OUTBOX_HEARTBEAT_STALE") });

    await writeOutboxHeartbeat(filePath, "success", new Date(Date.now() + 60_000));
    await expect(run(process.execPath, [PROBE], { env: { ...process.env, OUTBOX_HEARTBEAT_FILE: filePath } }))
      .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("OUTBOX_HEARTBEAT_FUTURE") });

    await writeOutboxHeartbeat(filePath, "success");
    await expect(run(process.execPath, [PROBE], { env: { ...process.env, OUTBOX_HEARTBEAT_FILE: filePath, OUTBOX_HEARTBEAT_MAX_AGE_MS: "nope" } }))
      .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("OUTBOX_HEARTBEAT_MAX_AGE_INVALID") });
  });

  it("tolerates a transient failure and fails once the error budget is spent", async () => {
    await writeOutboxHeartbeat(filePath, "error", new Date(), 1);
    const { stdout } = await run(process.execPath, [PROBE], { env: { ...process.env, OUTBOX_HEARTBEAT_FILE: filePath, OUTBOX_HEARTBEAT_ERROR_TOLERANCE: "3" } });
    expect(JSON.parse(stdout.trim())).toMatchObject({ status: "ok", lastResult: "error", consecutiveErrors: 1 });

    await writeOutboxHeartbeat(filePath, "error", new Date(), 3);
    await expect(run(process.execPath, [PROBE], { env: { ...process.env, OUTBOX_HEARTBEAT_FILE: filePath, OUTBOX_HEARTBEAT_ERROR_TOLERANCE: "3" } }))
      .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("OUTBOX_WORKER_LAST_CYCLE_FAILED") });
  });
});