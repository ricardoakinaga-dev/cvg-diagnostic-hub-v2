import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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

test("environment templates expand one institutional timezone for the server and browser", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cvg-timezone-config-"));
  try {
    for (const name of [".env.example", ".env.production.example"]) for (const timezone of ["America/Sao_Paulo", "America/Manaus"]) {
      const template = readFileSync(path.join(root, name), "utf8").replace(/^APP_TIMEZONE=.*$/m, `APP_TIMEZONE=${timezone}`);
      writeFileSync(path.join(dir, ".env"), template);
      const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", "import nextEnv from '@next/env'; nextEnv.loadEnvConfig(process.argv[1], false, {info(){},error(){}}, true); console.log(JSON.stringify({server:process.env.APP_TIMEZONE,browser:process.env.NEXT_PUBLIC_HOSPITAL_TIMEZONE}));", dir], { cwd: root, env: { PATH: process.env.PATH }, encoding: "utf8" }));
      assert.deepEqual(result, { server: timezone, browser: timezone }, name);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Docker freezes the same timezone in the browser and both images and rejects an invalid timezone", () => {
  const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");
  for (const stage of ["builder", "runner", "ops"]) {
    const block = dockerfile.split(new RegExp(`^FROM .* AS ${stage}\\s*$`, "m"))[1]?.split(/^FROM /m)[0];
    assert.ok(block, stage);
    assert.match(block, /ARG APP_TIMEZONE=America\/Sao_Paulo/);
    assert.match(block, /APP_TIMEZONE=\$APP_TIMEZONE/);
    assert.match(block, /NEXT_PUBLIC_HOSPITAL_TIMEZONE=\$APP_TIMEZONE/);
    if (stage !== "builder") assert.match(block, /LABEL org\.cvg\.hospital\.timezone=\$APP_TIMEZONE/);
  }
  const guards = [...dockerfile.matchAll(/^RUN node -e "([^"]+)"/gm)];
  assert.equal(guards.length, 2, "builder and standalone ops validate before publication");
  for (const [, command] of guards) for (const [timezone, valid] of [["America/Sao_Paulo", true], ["America/Manaus", true], ["Invalid/Hospital", false], ["", false]]) {
    const result = spawnSync(process.execPath, ["-e", command], { env: { PATH: process.env.PATH, APP_TIMEZONE: timezone }, encoding: "utf8" });
    assert.equal(result.status === 0, valid, timezone);
  }
  const workflow = readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8");
  assert.match(workflow, /APP_TIMEZONE: \$\{\{ vars\.APP_TIMEZONE \|\| 'America\/Sao_Paulo' \}\}/);
  assert.match(workflow, /stamp=\(.*--build-arg "APP_TIMEZONE=\$APP_TIMEZONE"\)/);
  for (const target of ["--pull", "--target ops"]) assert.ok(workflow.includes(`scripts/ci-docker-build.sh ${target} "\${labels[@]}" "\${stamp[@]}"`));
  assert.match(workflow, /"timezone":"%s"/);
});

test("Compose keeps custom and default timezone build arguments equal to app, worker and one-shot runtime", { skip: spawnSync("docker", ["compose", "version"]).status !== 0 }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cvg-timezone-compose-"));
  try {
    const base = readFileSync(path.join(root, ".env.production.example"), "utf8").replace(/^([A-Z0-9_]+)=$/gm, "$1=synthetic-config-only");
    const local = "POSTGRES_DB=synthetic\nPOSTGRES_ADMIN_PASSWORD=synthetic-admin\nPOSTGRES_RUNTIME_PASSWORD=synthetic-runtime\nPOSTGRES_MIGRATION_PASSWORD=synthetic-migration\nSESSION_SECRET=synthetic-session\nTRUST_PROXY_SHARED_SECRET=synthetic-proxy\nSTORAGE_ACCESS_KEY=synthetic-access\nSTORAGE_SECRET_KEY=synthetic-storage\nMALWARE_SCANNER_API_KEY=synthetic-scanner\n";
    for (const [file, template] of [["docker-compose.prod.yml", base], ["docker-compose.local.yml", local]]) for (const configuredTimezone of [undefined, "America/Sao_Paulo", "America/Manaus"]) {
      const timezone = configuredTimezone ?? "America/Sao_Paulo";
      const envFile = path.join(dir, "env");
      writeFileSync(envFile, `${template.replace(/^APP_TIMEZONE=.*$/m, "")}\n${configuredTimezone ? `APP_TIMEZONE=${configuredTimezone}\n` : ""}NEXT_PUBLIC_HOSPITAL_TIMEZONE=Invalid/IndependentOverride\n`);
      const result = spawnSync("docker", ["compose", "-f", path.join(root, file), "--env-file", envFile, "--profile", "bootstrap", "config", "--format", "json"], { env: { PATH: process.env.PATH }, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      const { services } = JSON.parse(result.stdout);
      for (const name of ["app", "migrate"]) assert.equal(services[name].build.args.APP_TIMEZONE, timezone, `${file}:${name} build`);
      for (const name of ["app", "worker", "migrate", "bootstrap"]) {
        assert.equal(services[name].environment.APP_TIMEZONE, timezone, `${file}:${name} runtime`);
        assert.equal(services[name].environment.NEXT_PUBLIC_HOSPITAL_TIMEZONE, timezone, `${file}:${name} browser build contract`);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
