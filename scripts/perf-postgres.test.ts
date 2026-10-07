import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import test from "node:test";
import { spawn } from "node:child_process";
import { terminateChild } from "../tests/support/next-http-test-server";
import { measureHttpRequest, runPostgresPerf } from "./perf-postgres";

const client = { cookie: "synthetic-cookie", csrf: "synthetic-csrf" };

async function withServer(handler: RequestListener, operation: (url: string) => Promise<void>): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try { await operation(`http://127.0.0.1:${address.port}`); }
  finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("records HTTP latency only after the complete JSON response body", async () => {
  let completed = false;
  await withServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"data":');
    setTimeout(() => { completed = true; response.end('{"id":"request-synthetic"}}'); }, 30);
  }, async (url) => {
    const measured = await measureHttpRequest(url, client);
    assert.equal(completed, true);
    assert.equal(measured.status, 200);
    assert.equal(measured.id, "request-synthetic");
  });
});

test("a truncated HTTP 200 body is recorded as a failed transport sample", async () => {
  await withServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"data":');
    setImmediate(() => response.destroy());
  }, async (url) => { assert.equal((await measureHttpRequest(url, client)).status, 0); });
});

test("malformed or missing API data cannot pass on HTTP 200 headers", async () => {
  for (const body of ["not-json", "null", '{"error":{"code":"UNEXPECTED"}}']) {
    await withServer((_request, response) => { response.writeHead(200); response.end(body); }, async (url) => {
      assert.equal((await measureHttpRequest(url, client)).status, 0);
    });
  }
});

test("records the actual status and safe error code for a rejected clinical command", async () => {
  await withServer((_request, response) => { response.writeHead(409); response.end('{"error":{"code":"DUPLICATE_WARNING"}}'); }, async (url) => {
    const measured = await measureHttpRequest(url, client);
    assert.equal(measured.status, 409);
    assert.equal(measured.errorCode, "DUPLICATE_WARNING");
  });
});

test("benchmark refuses a database without explicit disposable integration opt-in", async () => {
  const previous = process.env.ALLOW_POSTGRES_INTEGRATION_TESTS;
  delete process.env.ALLOW_POSTGRES_INTEGRATION_TESTS;
  try { await assert.rejects(runPostgresPerf(), /require ALLOW_POSTGRES_INTEGRATION_TESTS=true/); }
  finally {
    if (previous === undefined) delete process.env.ALLOW_POSTGRES_INTEGRATION_TESTS;
    else process.env.ALLOW_POSTGRES_INTEGRATION_TESTS = previous;
  }
});

test("build cleanup waits for a cooperative child to exit", async () => {
  const child = spawn(process.execPath, ["-e", 'process.stdout.write("ready");setInterval(()=>{},1000)'], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  await new Promise<void>((resolve, reject) => { child.stdout!.once("data", () => resolve()); child.once("error", reject); });
  try {
    await terminateChild(child);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
  } finally { child.kill("SIGKILL"); }
});

test("build cleanup kills and awaits a child that ignores SIGTERM", async () => {
  const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM",()=>{});process.stdout.write("ready");setInterval(()=>{},1000)'], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  await new Promise<void>((resolve, reject) => { child.stdout!.once("data", () => resolve()); child.once("error", reject); });
  try {
    await terminateChild(child);
    assert.equal(child.signalCode, "SIGKILL");
  } finally { child.kill("SIGKILL"); }
});
