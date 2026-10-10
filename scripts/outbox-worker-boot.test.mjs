// D-057: the worker must start with its heartbeat path pointing at a file that does not exist yet. On 2026-10-10 the
// secrets loader read every *_FILE variable and refused OUTBOX_HEARTBEAT_FILE (ENOENT), so the production worker of
// docker-compose.prod.yml never came up. This boots the real worker once, in memory mode, with exactly that variable.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the outbox worker boots once with OUTBOX_HEARTBEAT_FILE pointing at a file that does not exist yet", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cvg-worker-boot-"));
  const heartbeat = path.join(dir, "outbox-worker-heartbeat.json");
  try {
    assert.equal(existsSync(heartbeat), false);
    const result = spawnSync(path.join(root, "node_modules", ".bin", "tsx"), [path.join(root, "scripts", "outbox-worker.ts"), "--once"], {
      cwd: root, encoding: "utf8", timeout: 120_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test", APP_DATA_MODE: "memory", OUTBOX_SINK: "console", OUTBOX_HEARTBEAT_FILE: heartbeat }
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.doesNotMatch(result.stderr, /SECRET_FILE_UNREADABLE|OUTBOX_HEARTBEAT/);
    assert.match(result.stdout, /"event":"outbox\.batch"/);
    assert.equal(existsSync(heartbeat), true, "the worker wrote its heartbeat");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
