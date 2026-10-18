import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { classifyMutation, inspectTestRun, isStageInput, prepareStage, runnerEnvironment } from "./mutation-controls-support.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fakeStage = "/tmp/mutation-synthetic-stage";
const selected = ["src/control.test.ts"];

function resultReport(failed = false) {
  return {
    numTotalTests: 1, numPassedTests: failed ? 0 : 1, numFailedTests: failed ? 1 : 0,
    numPendingTests: 0, numTodoTests: 0, numPendingTestSuites: 0, success: !failed,
    mutationControls: { schemaVersion: 1, lifecycleFailureCount: 0, retryCount: 0, unhandledErrorCount: 0, interrupted: false },
    testResults: [{ name: `${fakeStage}/${selected[0]}`, message: "", assertionResults: [{ fullName: "permission ceiling denies clinical action", status: failed ? "failed" : "passed", failureMessages: failed ? ["AssertionError: expected true to be false"] : [] }] }]
  };
}

test("stage excludes real environments, generated/data/secret/vendor files and all origin symlinks", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cvg-mutation-stage-test-"));
  const root = path.join(directory, "source"); const stage = path.join(directory, "stage");
  await mkdir(root); await mkdir(stage);
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    const allowed = ["package.json", "package-lock.json", "tsconfig.json", "vitest.config.ts", ".env.example", ".env.production.example", ".env.monitoring.example", "src/control.test.ts", "src/test/producer-source.json", "packages/contracts/src/index.ts", "scripts/safe.mjs", "db/migrations/001_initial.sql"];
    const denied = [".env", ".env.local", ".env.production", ".next-hpl/server.js", ".data/patient.json", "vendor/dependency.js", "node_modules/extra.js", "coverage/results.json", "src/.env.test", "src/secrets/password.json", "src/credentials.json", "src/data/patient.json", "src/generated/output.ts", "src/native.generated.ts", "src/key.pem", "db/backup.sql", "db/migrations/untrusted.sql"];
    for (const relative of [...allowed, ...denied]) {
      await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await writeFile(path.join(root, relative), allowed.includes(relative) ? "synthetic source" : "DO_NOT_COPY_SYNTHETIC_SECRET");
    }
    await writeFile(path.join(root, ".gitignore"), "src/ignored.ts\n");
    await writeFile(path.join(root, "src/ignored.ts"), "DO_NOT_COPY_SYNTHETIC_SECRET");
    await writeFile(path.join(directory, "outside.ts"), "DO_NOT_COPY_SYNTHETIC_SECRET");
    await symlink(path.join(directory, "outside.ts"), path.join(root, "src/link.ts"));
    await symlink(directory, path.join(root, "src/linked-directory"), "dir");
    // Forced tracked/ignored env/secret files must still be rejected.
    execFileSync("git", ["add", "--force", ".env", "src/secrets/password.json", "src/ignored.ts", "src/link.ts", "src/linked-directory"], { cwd: root });
    const inventory = await prepareStage(root, stage, { linkDependencies: false });
    assert.deepEqual(inventory.map((entry) => entry.path), allowed.sort());
    for (const entry of inventory) assert.equal((await readFile(path.join(stage, entry.path), "utf8")).includes("DO_NOT_COPY"), false);
    assert.equal((await readdir(stage)).includes("node_modules"), false);
    for (const relative of denied) assert.equal(isStageInput(relative), false, relative);
    assert.equal(isStageInput("../src/control.ts"), false);
    assert.equal(isStageInput("src\\control.ts"), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("runner environment carries no application credentials, PG opt-ins or env injection", () => {
  const input = { PATH: "/synthetic/bin", LANG: "C", DATABASE_URL: "synthetic-secret", SESSION_SECRET: "synthetic-secret", DATA_SOURCE_URI_FILE: "/synthetic/secret", ALLOW_POSTGRES_INTEGRATION_TESTS: "true", NODE_OPTIONS: "--import=untrusted.mjs", CI: "false" };
  assert.deepEqual(runnerEnvironment(input), { CI: "1", NODE_ENV: "test", TZ: "UTC", PATH: "/synthetic/bin", LANG: "C" });
});

test("only failed assertions with a complete identical green baseline kill a mutant", () => {
  const baseline = inspectTestRun({ status: 0 }, resultReport(), selected, fakeStage);
  const mutant = inspectTestRun({ status: 1 }, resultReport(true), selected, fakeStage);
  assert.deepEqual(classifyMutation(baseline, mutant), { detected: true, outcome: "KILLED_BY_TEST_ASSERTION" });
  assert.equal(classifyMutation(baseline, baseline).outcome, "SURVIVED");
  assert.equal(classifyMutation(mutant, mutant).outcome, "BASELINE_INVALID");
  assert.equal(classifyMutation(baseline, { ...mutant, identities: ["different test"] }).outcome, "MUTANT_RUN_INVALID");
  for (const execution of [{ status: null, error: { code: "ETIMEDOUT" } }, { status: null, error: { code: "ENOENT" } }, { status: 1, signal: "SIGTERM" }, { status: 2 }, { status: 0 }]) {
    assert.equal(classifyMutation(baseline, inspectTestRun(execution, resultReport(true), selected, fakeStage)).detected, false);
  }
  for (const report of [undefined, { ...resultReport(true), numTotalTests: 0 }, { ...resultReport(true), numPendingTests: 1 }, { ...resultReport(true), numFailedTests: 2 }, { ...resultReport(true), success: true }]) {
    assert.equal(classifyMutation(baseline, inspectTestRun({ status: 1 }, report, selected, fakeStage)).detected, false);
  }
  for (const lifecycle of [undefined, { ...resultReport().mutationControls, lifecycleFailureCount: 1 }, { ...resultReport().mutationControls, unhandledErrorCount: 1 }, { ...resultReport().mutationControls, retryCount: 1 }, { ...resultReport().mutationControls, interrupted: true }]) {
    assert.equal(classifyMutation(baseline, inspectTestRun({ status: 1 }, { ...resultReport(true), mutationControls: lifecycle }, selected, fakeStage)).detected, false);
  }
  for (const message of ["Error: beforeAll hook setup failed", "Error: Test timed out in 5000ms", "Error: dependency could not initialize", "Error: expected environment to be configured", "Error: promise resolved x instead of rejecting __VITEST_REJECTS__"]) {
    const report = resultReport(true); report.testResults[0].assertionResults[0].failureMessages = [message];
    assert.equal(inspectTestRun({ status: 1 }, report, selected, fakeStage).valid, false);
  }
  const setup = resultReport(true); setup.testResults[0].message = "setup module failed";
  assert.equal(inspectTestRun({ status: 1 }, setup, selected, fakeStage).valid, false);
  assert.equal(inspectTestRun({ status: 1, stderr: "Unhandled Errors" }, resultReport(true), selected, fakeStage).valid, false);
  assert.equal(inspectTestRun({ status: 1 }, resultReport(true), ["src/other.test.ts"], fakeStage).valid, false);
});

test("actual Vitest reports distinguish assertion failures from setup failure and zero tests", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cvg-mutation-reporter-test-"));
  try {
    await mkdir(path.join(directory, "src"));
    await writeFile(path.join(directory, "package.json"), '{"type":"module"}');
    await writeFile(path.join(directory, "vitest.config.ts"), 'export default { test: { environment: "node", fileParallelism: false, maxWorkers: 1 } };');
    await symlink(path.join(repository, "node_modules"), path.join(directory, "node_modules"), "dir");
    const source = path.join(directory, selected[0]);
    const run = async (body, phase) => {
      await writeFile(source, body);
      const reportPath = path.join(directory, `${phase}.json`);
      const execution = spawnSync(process.execPath, [path.join(repository, "node_modules/vitest/vitest.mjs"), "run", selected[0], "--retry=0", `--reporter=${path.join(repository, "scripts/mutation-controls-reporter.mjs")}`, `--outputFile=${reportPath}`], { cwd: directory, env: runnerEnvironment(), encoding: "utf8", timeout: 30_000 });
      let report; try { report = JSON.parse(await readFile(reportPath, "utf8")); } catch { /* zero-test/setup may omit reporter */ }
      return inspectTestRun(execution, report, selected, directory);
    };
    const baseline = await run('import { test, expect } from "vitest"; test("control", () => expect(false).toBe(false));', "baseline");
    const mutant = await run('import { test, expect } from "vitest"; test("control", () => expect(true).toBe(false));', "mutant");
    assert.equal(classifyMutation(baseline, mutant).detected, true);
    const asyncBaseline = await run('import { test, expect } from "vitest"; test("control", async () => { await expect(Promise.reject(new Error("denied"))).rejects.toThrow("denied"); });', "async-baseline");
    const asyncMutant = await run('import { test, expect } from "vitest"; test("control", async () => { await expect(Promise.resolve(true)).rejects.toThrow("denied"); });', "async-mutant");
    assert.equal(classifyMutation(asyncBaseline, asyncMutant).detected, true);
    const setup = await run('import { test, beforeAll } from "vitest"; beforeAll(() => { throw new Error("synthetic setup failed"); }); test("control", () => {});', "setup");
    assert.equal(classifyMutation(baseline, setup).detected, false);
    const runtime = await run('import { test } from "vitest"; test("control", () => { throw new Error("expected environment to be configured"); });', "runtime");
    assert.equal(classifyMutation(baseline, runtime).detected, false);
    const fakeMatcher = await run('import { test } from "vitest"; test("control", () => { throw new Error("promise resolved x instead of rejecting __VITEST_REJECTS__"); });', "fake-matcher");
    assert.equal(classifyMutation(baseline, fakeMatcher).detected, false);
    const setupAssertion = await run('import { test, beforeAll, expect } from "vitest"; beforeAll(() => expect(true).toBe(false)); test("control", () => {});', "setup-assertion");
    assert.equal(classifyMutation(baseline, setupAssertion).detected, false);
    const eachSetupAssertion = await run('import { test, beforeEach, expect } from "vitest"; beforeEach(() => expect(true).toBe(false)); test("control", () => {});', "each-setup-assertion");
    assert.equal(classifyMutation(baseline, eachSetupAssertion).detected, false);
    const empty = await run('export const noTests = true;', "empty");
    assert.equal(classifyMutation(baseline, empty).detected, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("authorization mutation removes only the role ceiling and preserves active/effective-group guards", async () => {
  const source = await readFile(path.join(repository, "src/server/security/authorization.ts"), "utf8");
  const needle = " || !hasPermission(actor.role, permission)";
  assert.equal(source.split(needle).length - 1, 1);
  const mutant = source.replace(needle, "");
  assert.ok(mutant.includes("if (actor.active === false || (actor.permissions !== undefined && !actor.permissions.includes(permission))) {"));
  assert.ok(source.includes("if (actor.active === false || !hasPermission(actor.role, permission) || (actor.permissions !== undefined && !actor.permissions.includes(permission))) {"));
});
