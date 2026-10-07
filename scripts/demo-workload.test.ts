import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

const run = promisify(execFile);
const script = fileURLToPath(new URL("./demo-workload.ts", import.meta.url));
const environment = { ...process.env, ALLOW_SYNTHETIC_SEED: "true", DEMO_PASSWORD: "synthetic-redirect-test" };

test("demo workload refuses redirects before forwarding login credentials", async () => {
  let redirectedRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === "/redirected-login") { redirectedRequests++; response.writeHead(500).end(); return; }
    response.writeHead(307, { location: "/redirected-login" }).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await assert.rejects(run(process.execPath, ["--import", "tsx", script, `http://127.0.0.1:${address.port}`], { env: environment }), /fetch failed/);
    assert.equal(redirectedRequests, 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("demo workload requires explicit synthetic seed opt-in", async () => {
  await assert.rejects(run(process.execPath, ["--import", "tsx", script], { env: { ...environment, ALLOW_SYNTHETIC_SEED: "false" } }), /ALLOW_SYNTHETIC_SEED=true/);
});

test("demo workload refuses a remote target before login", async () => {
  await assert.rejects(run(process.execPath, ["--import", "tsx", script, "https://example.invalid"], { env: environment }), /só roda contra uma instância local/);
});

test("demo workload reports zero new patients when all synthetic cases already exist", async () => {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const data = url.pathname === "/api/v1/patients" ? [{ displayName: url.searchParams.get("q") }] : url.pathname === "/api/v1/clinical-reasons" ? [] : {};
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const result = await run(process.execPath, ["--import", "tsx", script, `http://127.0.0.1:${address.port}`], { env: environment });
    assert.match(result.stdout, /0 pacientes novos, 0 exames novos, 0 falhas de avanço/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
