import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
function loadConfig(origins) {
  const env = { ...process.env };
  delete env.NEXT_ALLOWED_DEV_ORIGINS;
  if (origins !== undefined) env.NEXT_ALLOWED_DEV_ORIGINS = origins;
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e",
    "import config from './next.config.mjs'; console.log(JSON.stringify({ origins: config.allowedDevOrigins, headers: await config.headers() }));"
  ], { cwd: root, env, encoding: "utf8" }));
}

test("dev origins default to loopback without a machine-specific LAN address", () => {
  assert.deepEqual(loadConfig().origins, ["localhost", "127.0.0.1"]);
});

test("blank dev-origin entries do not broaden the default allowlist", () => {
  assert.deepEqual(loadConfig(" , , ").origins, ["localhost", "127.0.0.1"]);
});

test("configured dev hostnames and scoped wildcards are trimmed and appended", () => {
  assert.deepEqual(loadConfig(" diagnostics.example.test, , *.tunnel.example.test ").origins,
    ["localhost", "127.0.0.1", "diagnostics.example.test", "*.tunnel.example.test"]);
});

test("dev-origin configuration does not change security response headers", () => {
  const baseline = loadConfig();
  const configured = loadConfig("diagnostics.example.test");
  assert.deepEqual(configured.headers, baseline.headers);
  const headers = Object.fromEntries(configured.headers[0].headers.map(({ key, value }) => [key, value]));
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
  assert.equal(headers["X-Frame-Options"], "DENY");
  assert.match(headers["Strict-Transport-Security"], /max-age=31536000/);
});
