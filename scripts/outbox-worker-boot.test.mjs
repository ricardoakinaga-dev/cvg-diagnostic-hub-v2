// D-057: the worker must start with its heartbeat path pointing at a file that does not exist yet. On 2026-10-10 the
// secrets loader read every *_FILE variable and refused OUTBOX_HEARTBEAT_FILE (ENOENT), so the production worker of
// docker-compose.prod.yml never came up. This boots the real worker once, in memory mode, with exactly that variable.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

// All state/storage below belong to this disposable child; the real runtime DB is never opened.
function syntheticArchiveProgram({ count, script, args, remove, close }) {
  return `
    const assert = require("node:assert/strict");
    const runtimePath = require.resolve("./src/server/store/runtime.ts");
    const runtime = require(runtimePath);
    const { MemoryStore } = require("./src/server/store/memory-store.ts");
    const { createDemoState } = require("./src/server/store/fixtures.ts");
    const { ARCHIVE_NOW, withCompletedRequest } = require("./src/test/archive-fixtures.ts");
    void (async () => {
      let state = createDemoState("worker-synthetic-archive-password");
      for (let index = 0; index < ${count}; index += 1) state = withCompletedRequest(state, "boot-" + index);
      state.outbox = [{
        id: "outbox-synthetic", eventType: "diagnostic.updated", aggregateType: "DiagnosticRequest",
        aggregateId: "request-synthetic", payload: {}, consumerType: "DOMAIN_EVENT", routingKey: "domain.diagnostic.updated",
        status: "PENDING", attempts: 0, availableAt: new Date().toISOString(), correlationId: "synthetic"
      }];
      const store = new MemoryStore(state);
      await store.archiveClinicalRecords({ now: ARCHIVE_NOW });
      await store.purgeClinicalArchive({ now: new Date("2036-10-09T00:00:00.000Z"), purgeAfterMonths: 120 });
      let storageFinished = false;
      require.cache[runtimePath].exports = {
        ...runtime,
        getRuntimeStoreAsync: async () => store,
        getRuntimeFileStore: () => ({ remove: async () => { ${remove} } }),
        closeRuntimeStore: async () => { ${close} }
      };
      const outboxPath = require.resolve("./src/server/operations/outbox.ts");
      const outbox = require(outboxPath);
      require.cache[outboxPath].exports = {
        ...outbox,
        createOutboxSinkFromEnv: () => ({
          kind: "synthetic-durable", durability: "DURABLE", supportsRoute: () => true,
          publish: async (message) => ({ confirmed: true, durability: "DURABLE", sink: "synthetic-durable", deliveryId: message.id })
        })
      };
      process.argv = ["node", ${JSON.stringify(script)}, ...${JSON.stringify(args)}];
      require(${JSON.stringify(`./${script}`)});
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `;
}

test("storage removal runs alongside delivery and heartbeat, and shutdown acknowledges it before closing", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cvg-worker-storage-"));
  const heartbeat = path.join(dir, "heartbeat.json");
  try {
    const program = syntheticArchiveProgram({
      count: 1, script: "scripts/outbox-worker.ts", args: ["--once"],
      remove: `console.log("test.storage_started"); await new Promise((resolve) => setTimeout(resolve, 150)); storageFinished = true; console.log("test.storage_finished");`,
      close: `assert.equal(storageFinished, true); assert.equal((await store.readArchiveObjectDeletionMetrics()).pending, 0); console.log("test.pool_closed");`
    });
    const result = spawnSync(path.join(root, "node_modules", ".bin", "tsx"), ["--eval", program], {
      cwd: root, encoding: "utf8", timeout: 30_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test", APP_DATA_MODE: "memory", OUTBOX_SINK: "console", ARCHIVE_ACTIVE_MONTHS: "0", OUTBOX_HEARTBEAT_FILE: heartbeat }
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const batchAt = result.stdout.indexOf('"event":"outbox.batch"');
    const completedAt = result.stdout.indexOf("test.storage_finished");
    assert.ok(result.stdout.includes("test.storage_started"), result.stdout);
    assert.ok(batchAt >= 0 && batchAt < completedAt, result.stdout);
    assert.ok(completedAt < result.stdout.indexOf("test.pool_closed"), result.stdout);
    assert.match(result.stdout, /"processed":1/);
    assert.equal(JSON.parse(readFileSync(heartbeat, "utf8")).lastResult, "success");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a bounded archive CLI application reports durable objects still pending", () => {
  const program = syntheticArchiveProgram({
    count: 30, script: "scripts/clinical-archive.ts", args: ["--apply"],
    remove: "storageFinished = true;",
    close: `assert.equal(storageFinished, true); assert.equal((await store.readArchiveObjectDeletionMetrics()).pending, 5);`
  });
  const result = spawnSync(path.join(root, "node_modules", ".bin", "tsx"), ["--eval", program], {
    cwd: root, encoding: "utf8", timeout: 30_000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test", APP_DATA_MODE: "memory" }
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(JSON.parse(result.stdout).objects, { removed: 25, failures: 0, pending: 5 });
});
