// PROD-514 (D-057): static and behavioural checks of the full restore rehearsal and of the reconciliation CLI, without
// Docker: refusal of production project names, restore from the off-site copy only, write-once copy, host-side
// reconciliation as the runtime user, and the scripts wired in package.json.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const drill = path.join(root, "scripts", "full-restore-drill.sh");
const source = readFileSync(drill, "utf8");
const outage = path.join(root, "scripts", "outage-drill.sh");
const outageSource = readFileSync(outage, "utf8");

test("the full restore drill refuses production and local Compose projects before touching Docker", () => {
  for (const project of ["cvg-hub", "cvg-diagnostic-hub-v2", "cvg-diagnostic-local", "cvg-prod", "cvg-hml", "Bad Project"]) {
    const result = spawnSync("bash", [drill], { env: { ...process.env, DRILL_PROJECT: project }, encoding: "utf8" });
    assert.equal(result.status, 2, `${project}: ${result.stderr}`);
  }
  const help = spawnSync("bash", [drill, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /RPO 15 min, RTO 4 h/);
});

test("the drill restores database and bucket from the off-site copy only, after destroying the local volumes", () => {
  // Every local copy is destroyed before the restore: the fetched copy is the only source.
  for (const volume of ["cvg-postgres", "cvg-backups", "cvg-wal-archive", "cvg-storage"]) assert.match(source, new RegExp(volume));
  assert.match(source, /storage-restore copy "offsitecrypt:" \/out/);
  assert.match(source, /restore-pitr\.sh" --base "\$base_dir" --wal "\$offsite_dir\/wal" --latest/);
  assert.match(source, /copy "offsitecrypt:objects" "minio:\$bucket" --ignore-existing/);
  // The reconciliation runs as the runtime role with the password from the secret file, never interpolated.
  assert.match(source, /DATABASE_URL="postgresql:\/\/\$\{runtime_user\}:\\\$\{POSTGRES_RUNTIME_PASSWORD\}@127\.0\.0\.1/);
  assert.match(source, /POSTGRES_RUNTIME_PASSWORD_FILE=/);
  assert.match(source, /STORAGE_SECRET_KEY_FILE=/);
  assert.doesNotMatch(source, /STORAGE_SECRET_KEY=[^_]/);
  // Negative controls: a missing object and a stray object must both be detected.
  assert.match(source, /deletefile "minio:\$bucket\/attachments\/drill-\$batch\/1\.bin"/);
  assert.match(source, /orphanObjects\)" == "1"/);
  assert.match(source, /"budgetSeconds":900/);
  assert.match(source, /"budgetSeconds":14400/);
});

test("package.json exposes the drill and the reconciliation, and the CLI refuses to run without its environment", () => {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.scripts["restore:drill"], "bash scripts/full-restore-drill.sh");
  assert.equal(pkg.scripts["attachments:reconcile"], "tsx scripts/attachments-reconcile.ts");
  const result = spawnSync(path.join(root, "node_modules", ".bin", "tsx"), [path.join(root, "scripts", "attachments-reconcile.ts")], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, APP_DATA_MODE: "memory", STORAGE_MODE: "s3" }, encoding: "utf8", timeout: 60_000
  });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /attachments\.reconcile_error/);
  assert.match(result.stderr, /STORAGE_ENDPOINT/);
});

test("the outage drill refuses production projects and proves each outage against the Prometheus rules", () => {
  for (const project of ["cvg-hub", "cvg-prod", "cvg-hml", "cvg-diagnostic-local"]) {
    const result = spawnSync("bash", [outage], { env: { ...process.env, DRILL_PROJECT: project }, encoding: "utf8" });
    assert.equal(result.status, 2, `${project}: ${result.stderr}`);
  }
  assert.equal(spawnSync("bash", [outage, "--help"], { encoding: "utf8" }).status, 0);
  // The Prometheus of the drill evaluates the repository's own rules against the real metrics endpoint.
  assert.match(outageSource, /rule_files:\n  - \/etc\/prometheus\/alerts\.yml/);
  assert.match(readFileSync(path.join(root, "docker-compose.outage-drill.yml"), "utf8"), /deploy\/observability\/alerts\.yml:\/etc\/prometheus\/alerts\.yml:ro/);
  // Every scenario stops a real component, waits for the owning rule to fire and for the recovery.
  for (const [service, alert] of [["worker", "CvgOutboxStalled"], ["storage", "CvgHubReadinessFailing"], ["postgres", "CvgHubReadinessFailing"], ["app", "CvgHubScrapeDown"]]) {
    assert.match(outageSource, new RegExp(`stop ${service}`));
    assert.match(outageSource, new RegExp(`start ${service}`));
    assert.match(outageSource, new RegExp(`alert_is ${alert} firing`));
  }
  assert.match(outageSource, /stop clamav/);
  assert.match(outageSource, /health_is scanner unhealthy/);
  // The edge still injects the proxy secret and the client address, as deploy/Caddyfile does.
  assert.match(outageSource, /header_up X-Cvg-Proxy-Secret \{\$TRUST_PROXY_SHARED_SECRET\}/);
  assert.match(outageSource, /header_up X-Real-IP \{remote_host\}/);
  assert.equal(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).scripts["outage:drill"], "bash scripts/outage-drill.sh");
});
