import { constants } from "node:fs";
import { lstat, mkdir, open, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";

const rootInputs = new Set(["package.json", "package-lock.json", "tsconfig.json", "vitest.config.ts", ".env.example", ".env.production.example", ".env.monitoring.example"]);
const sourceRoots = new Set(["src", "packages", "scripts"]);
const excludedDirectories = /^(?:\..*|node_modules|vendor|data|secrets?|credentials?|certs?|artifacts?|coverage|dist|build|generated|test-results|playwright-report|tmp)$/i;

export function isStageInput(relative) {
  const parts = relative.split("/");
  if (parts.some((part) => !part || part === "." || part === "..") || relative.includes("\\")) return false;
  if (rootInputs.has(relative)) return true;
  if (parts.some((part) => part.startsWith(".env") || excludedDirectories.test(part))) return false;
  if (/^(?:credentials?|secrets?|id_rsa|id_ed25519)(?:[.-]|$)/i.test(parts.at(-1))) return false;
  if (parts[0] === "db") return parts[1] === "migrations" && /^\d{3}_[a-z0-9_]+\.sql$/.test(parts.at(-1)) && parts.length === 3;
  return sourceRoots.has(parts[0]) && /\.(?:ts|tsx|mjs|cjs|js|json|css)$/.test(relative) && !/\.generated\./i.test(relative);
}

// The inventory is Git's tracked/nonignored source list, not a recursive copy
// of the working directory. Origin symlinks are rejected before opening bytes.
export async function prepareStage(root, stage, { linkDependencies = true } = {}) {
  const listing = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" });
  if (listing.error || listing.status !== 0) throw new Error("mutation_stage_source_inventory_failed");
  const candidates = [...new Set(listing.stdout.split("\0").filter(isStageInput))].sort();
  const ignored = spawnSync("git", ["check-ignore", "--no-index", "--stdin", "-z"], { cwd: root, input: `${candidates.join("\0")}\0`, encoding: "utf8" });
  if (ignored.error || ![0, 1].includes(ignored.status)) throw new Error("mutation_stage_ignore_check_failed");
  const excluded = new Set(ignored.stdout.split("\0"));
  const inventory = [];
  for (const relative of candidates.filter((candidate) => !excluded.has(candidate))) {
    const parts = relative.split("/");
    let regular = true;
    for (let index = 1; index <= parts.length; index += 1) {
      const stat = await lstat(path.join(root, ...parts.slice(0, index)));
      if (stat.isSymbolicLink() || (index === parts.length ? !stat.isFile() : !stat.isDirectory())) { regular = false; break; }
    }
    if (!regular) continue;
    const handle = await open(path.join(root, relative), constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes;
    try {
      if (!(await handle.stat()).isFile()) throw new Error("mutation_stage_nonregular_input");
      bytes = await handle.readFile();
    } finally { await handle.close(); }
    const target = path.join(stage, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: "wx" });
    inventory.push({ path: relative, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  if (linkDependencies) {
    // This explicit dependency link is the sole allowed stage symlink. Source
    // links and vendor directories are never copied or followed.
    const dependencies = path.join(root, "node_modules");
    if (!(await lstat(dependencies)).isDirectory()) throw new Error("mutation_dependencies_not_regular_directory");
    await symlink(dependencies, path.join(stage, "node_modules"), "dir");
  }
  return inventory;
}

export function runnerEnvironment(environment = process.env) {
  const result = { CI: "1", NODE_ENV: "test", TZ: "UTC" };
  for (const name of ["PATH", "SystemRoot", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL"]) {
    if (environment[name] !== undefined) result[name] = environment[name];
  }
  return result;
}

export function inspectTestRun(execution, report, tests, stage) {
  if (execution.error || execution.signal || ![0, 1].includes(execution.status)) return { valid: false, reason: "process_error_signal_or_exit" };
  if (!report || !Array.isArray(report.testResults) || !Number.isInteger(report.numTotalTests) || report.numTotalTests <= 0) return { valid: false, reason: "missing_or_empty_test_report" };
  const lifecycle = report.mutationControls;
  if (lifecycle?.schemaVersion !== 1 || lifecycle.lifecycleFailureCount !== 0 || lifecycle.unhandledErrorCount !== 0 || lifecycle.retryCount !== 0 || lifecycle.interrupted !== false) return { valid: false, reason: "native_lifecycle_or_runtime_error" };
  const files = report.testResults.map((file) => path.relative(stage, file.name ?? "").replaceAll(path.sep, "/")).sort();
  if (JSON.stringify(files) !== JSON.stringify([...tests].sort())) return { valid: false, reason: "test_file_inventory_mismatch" };
  if (report.testResults.some((file) => file.message || !Array.isArray(file.assertionResults) || file.assertionResults.length === 0)) return { valid: false, reason: "suite_setup_or_collection_error" };
  const assertions = report.testResults.flatMap((file) => file.assertionResults.map((assertion) => ({ ...assertion, file: path.relative(stage, file.name).replaceAll(path.sep, "/") })));
  const passed = assertions.filter((assertion) => assertion.status === "passed");
  const failed = assertions.filter((assertion) => assertion.status === "failed");
  if (assertions.length !== report.numTotalTests || passed.length + failed.length !== assertions.length || passed.length !== report.numPassedTests || failed.length !== report.numFailedTests || report.numPendingTests !== 0 || report.numTodoTests !== 0 || report.numPendingTestSuites !== 0) return { valid: false, reason: "incomplete_or_inconsistent_test_report" };
  const failureMessages = failed.flatMap((assertion) => assertion.failureMessages ?? []);
  const output = `${execution.stdout ?? ""}\n${execution.stderr ?? ""}\n${failureMessages.join("\n")}`;
  if (/Unhandled Errors?|unhandled rejection|Test timed out|Hook timed out|Failed to load|failed to resolve|globalSetup|beforeAll hook|beforeEach hook/i.test(output)) return { valid: false, reason: "test_runtime_or_setup_error" };
  if (failed.some((assertion) => !Array.isArray(assertion.failureMessages) || !assertion.failureMessages.some((message) => /^AssertionError:/.test(message) || (/^Error: promise (?:resolved|rejected) .* instead of (?:rejecting|resolving)/s.test(message) && /\n\s+at [^\n]*\.__VITEST_(?:REJECTS|RESOLVES)__ \(file:\/\/[^\n]*\/node_modules\/@vitest\/expect\/dist\/index\.js:\d+:\d+\)/.test(message))))) return { valid: false, reason: "failure_is_not_test_assertion" };
  if ((failed.length === 0 && (execution.status !== 0 || report.success !== true)) || (failed.length > 0 && (execution.status !== 1 || report.success !== false))) return { valid: false, reason: "test_outcome_exit_mismatch" };
  return { valid: true, passed: passed.length, failed: failed.length, total: assertions.length, identities: assertions.map((assertion) => `${assertion.file}::${assertion.fullName}`).sort(), failedTests: failed.map((assertion) => `${assertion.file}::${assertion.fullName}`) };
}

export function classifyMutation(baseline, mutant) {
  if (!baseline.valid || baseline.failed !== 0) return { detected: false, outcome: "BASELINE_INVALID" };
  if (!mutant.valid || JSON.stringify(mutant.identities) !== JSON.stringify(baseline.identities)) return { detected: false, outcome: "MUTANT_RUN_INVALID" };
  return mutant.failed > 0 ? { detected: true, outcome: "KILLED_BY_TEST_ASSERTION" } : { detected: false, outcome: "SURVIVED" };
}
