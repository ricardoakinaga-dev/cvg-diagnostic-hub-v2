import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const manifestPath = ".orchestrate/aaa3-execution-20260907/evidence-manifest.json";
const manifest = readJson(manifestPath);
const { buildCoverageReport, readCoverageSummary } = await import("./coverage-report.mjs");

assert(manifest.status === "BLOCKED_REVIEW_REQUIRED", "manifest status must remain BLOCKED_REVIEW_REQUIRED");
assert(manifest.local_automated_status === "PASS_WITH_CONDITIONS", "local automated status must remain PASS_WITH_CONDITIONS");
assert(manifest.aaa3_verdict === "BLOCKED_REVIEW_REQUIRED", "AAA-3 verdict must remain BLOCKED_REVIEW_REQUIRED");
assert(manifest.release_claim === false, "release_claim must remain false until external gates close");
assert(manifest.quality_bar?.required_criteria === 11, "AAA-3 quality bar must contain 11 canonical criteria");
assert(manifest.independent_review?.fresh_recheck_status === "BLOCKED", "fresh review must remain explicitly blocked");
assert(
  manifest.independent_review?.fresh_recheck_path === ".orchestrate/aaa3-execution-20260907/independent-critic-report-round8.md",
  "manifest must point to the current fresh independent review packet"
);
assert(
  !manifest.independent_review.fresh_recheck_path.endsWith("round3.md"),
  "stale round3 packet cannot remain the current fresh review"
);

const requiredArtifacts = [
  "docs/RELATORIO_AUDITORIA_2026-09-07.md",
  "docs/build/STATE_OF_ART_TRIPLE_AAA_EXECUTIVE_PLAN.md",
  "docs/build/STATE_OF_ART_TRIPLE_AAA_ROADMAP.md",
  "docs/build/STATE_OF_ART_TRIPLE_AAA_BACKLOG.md",
  "docs/spec/REALTIME.md",
  "docs/security/KNOWN_BAD_CONTROL_MATRIX.md",
  "docs/security/MUTATION_CONTROLS.md",
  ".orchestrate/aaa3-execution-20260907/quality-bar.json",
  ".orchestrate/aaa3-execution-20260907/independent-critic-report-round8.md",
  ".orchestrate/aaa3-execution-20260907/node22-current-revalidation-a11y-20260907.md",
  ".orchestrate/aaa3-execution-20260907/browser-e2e-node22-accessibility-20260907.md"
];
for (const artifact of requiredArtifacts) assert(isFile(artifact), `required evidence artifact is missing: ${artifact}`);

const coverage = buildCoverageReport(await readCoverageSummary());
const branchCoverage = Number(coverage.totals?.branches?.pct);
assert(Number(coverage.totals?.lines?.pct) === 92.72, "coverage lines no longer matches the current candidate");
assert(Number.isFinite(branchCoverage) && branchCoverage >= 85 && branchCoverage <= 100, "coverage branches is below the frozen AAA-3 threshold or malformed");
assert(Number(coverage.totals?.functions?.pct) === 94.31, "coverage functions no longer matches the current candidate");

const validationEvidence = manifest.verification?.find((entry) => entry.command?.endsWith("npm run validate"))?.evidence ?? "";
assert(validationEvidence.includes("725 tests pass"), "manifest validation evidence no longer records 725 tests");
assert(validationEvidence.includes("92.72% statements/lines"), "manifest validation evidence has stale lines coverage");
assert(validationEvidence.includes(`${branchCoverage.toFixed(2)}% branches`), "manifest validation evidence has stale branch coverage");
assert(validationEvidence.includes("94.31% functions"), "manifest validation evidence has stale function coverage");

const accessibilityEvidence = manifest.verification?.find((entry) => entry.command?.includes("tests/e2e/accessibility.spec.ts"))?.evidence ?? "";
assert(accessibilityEvidence.includes("12/12"), "manifest accessibility evidence no longer records 12/12");
const browserEvidence = manifest.verification?.find((entry) => entry.command?.includes("npm run test:e2e -- --retries=0"))?.evidence ?? "";
assert(browserEvidence.includes("60/60"), "manifest browser evidence no longer records 60/60");
assert(manifest.visual_evidence?.file_count === 20, "visual evidence file count is not 20");
assert(manifest.visual_evidence?.hash_manifest_sha256 === "e74167ff49ae2e165e039de8fef003948ed37271a0304c6629e2a19da43f2f95", "visual hash manifest is stale");

const freshReview = readFileSync(path.join(root, manifest.independent_review.fresh_recheck_path), "utf8");
assert(/\*\*Status:\*\* `BLOCKED`/.test(freshReview), "fresh independent review must explicitly remain BLOCKED");
assert(freshReview.includes("725 testes"), "fresh review must use current test count");
assert(/\d+,\d+% linhas/.test(freshReview), "fresh review must record its observed line coverage");
assert(/\d+,\d\d% branches/.test(freshReview), "fresh review must include a branch coverage observation");
assert(freshReview.includes("94,31%"), "fresh review must use current function coverage");

const expectedFingerprint = manifest.candidate_fingerprint?.status_and_tracked_diff_sha256;
assert(typeof expectedFingerprint === "string" && /^[a-f0-9]{64}$/.test(expectedFingerprint), "candidate fingerprint is missing or malformed");
const computedFingerprint = calculateCandidateFingerprint();
assert(computedFingerprint === expectedFingerprint, "candidate fingerprint does not match the current working tree");

console.log(JSON.stringify({
  status: "PASS",
  candidate: manifest.candidate,
  tests: 725,
  coverage: { lines: 92.72, branches: branchCoverage, functions: 94.31 },
  freshReview: manifest.independent_review.fresh_recheck_path,
  releaseClaim: manifest.release_claim,
  fingerprint: computedFingerprint
}, null, 2));

function calculateCandidateFingerprint() {
  const status = git(["status", "--porcelain=v1", "--untracked-files=all"])
    .split("\n")
    .filter((line) => line && !line.includes(manifestPath))
    .join("\n") + "\n";
  const diff = execFileSync("git", ["diff", "--binary"], { cwd: root, maxBuffer: 128 * 1024 * 1024 });
  const files = git(["ls-files", "--others", "--exclude-standard"])
    .split("\n")
    .filter((file) => file && file !== manifestPath)
    .sort();
  const hashes = files.map((file) => `${sha256(readFileSync(path.join(root, file)))}  ${file}\n`).join("");
  return sha256(Buffer.concat([Buffer.from(status), diff, Buffer.from(hashes)]));
}

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
}

function isFile(relativePath) {
  try {
    return statSync(path.join(root, relativePath)).isFile();
  } catch {
    return false;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(`AAA3_EVIDENCE_INVALID: ${message}`);
}
