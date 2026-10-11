import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("canonical E2E preserves failure evidence and baselines and returns the browser exit code", () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "cvg-canonical-test-"));
  try {
    mkdirSync(path.join(fixture, "scripts"), { recursive: true });
    mkdirSync(path.join(fixture, ".github/workflows"), { recursive: true });
    mkdirSync(path.join(fixture, "tests/e2e/visual.spec.ts-snapshots"), { recursive: true });
    mkdirSync(path.join(fixture, "bin"));
    copyFileSync(path.join(repo, "scripts/test-e2e-canonical.sh"), path.join(fixture, "scripts/test-e2e-canonical.sh"));
    copyFileSync(path.join(repo, ".github/workflows/ci.yml"), path.join(fixture, ".github/workflows/ci.yml"));
    const baseline = path.join(fixture, "tests/e2e/visual.spec.ts-snapshots/dashboard.png");
    writeFileSync(baseline, "existing baseline");
    execFileSync("git", ["init", "--quiet"], { cwd: fixture });
    execFileSync("git", ["add", "."], { cwd: fixture });
    execFileSync("git", ["-c", "user.name=Canonical test", "-c", "user.email=canonical@example.test", "commit", "--quiet", "-m", "fixture"], { cwd: fixture });
    const capture = path.join(fixture, "runner-call.json");
    writeFileSync(path.join(fixture, "bin/docker"), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const work = args[args.indexOf('-v') + 1].split(':')[0];
fs.writeFileSync(process.env.CVG_CANONICAL_CALL, JSON.stringify({args, work}));
fs.mkdirSync(path.join(work, 'canonical-artifacts/main/test-results'), {recursive:true});
fs.writeFileSync(path.join(work, 'canonical-artifacts/main/test-results/failure.png'), 'synthetic capture');
fs.writeFileSync(path.join(work, 'canonical-artifacts/main/report.html'), 'synthetic failure report');
console.log('synthetic browser failure');
process.exit(7);
`, { mode: 0o755 });
    const environment = { ...process.env, PATH: `${path.join(fixture, "bin")}${path.delimiter}${process.env.PATH}`, CVG_CANONICAL_CALL: capture, CVG_E2E_CONTAINER_RUNTIME: "docker" };
    const outcome = spawnSync("bash", ["scripts/test-e2e-canonical.sh", "tests/e2e/visual.spec.ts"], { cwd: fixture, env: environment, encoding: "utf8" });
    assert.equal(outcome.status, 7, outcome.stderr);
    const called = JSON.parse(readFileSync(capture, "utf8"));
    assert.equal(existsSync(called.work), false, "temporary source tree must be cleaned after failure");
    assert.equal(readFileSync(baseline, "utf8"), "existing baseline");
    const [directory] = readdirSync(path.join(fixture, "test-results"));
    const artifacts = path.join(fixture, "test-results", directory);
    assert.equal(readFileSync(path.join(artifacts, "exit-code.txt"), "utf8"), "7\n");
    assert.equal(readFileSync(path.join(artifacts, "main/test-results/failure.png"), "utf8"), "synthetic capture");
    assert.match(readFileSync(path.join(artifacts, "run.log"), "utf8"), /synthetic browser failure/);
    assert.match(readFileSync(path.join(artifacts, "image.txt"), "utf8"), /@sha256:[a-f0-9]{64}/);

    // A caller cannot turn a verification run into an update of golden images.
    rmSync(capture);
    const update = spawnSync("bash", ["scripts/test-e2e-canonical.sh", "--update-snapshots"], { cwd: fixture, env: environment, encoding: "utf8" });
    assert.equal(update.status, 2);
    assert.equal(existsSync(capture), false);
    assert.equal(readFileSync(baseline, "utf8"), "existing baseline");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
