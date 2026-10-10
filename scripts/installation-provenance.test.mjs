import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

// A docker stand-in: FAKE_PS is the `docker ps` output; FAKE_<container> is the revision label of that container.
const FAKE_DOCKER = `#!/usr/bin/env bash
case "$1" in
  ps) printf '%b' "\${FAKE_PS:-}" ;;
  inspect) name="FAKE_\${@: -1}"; name="\${name//-/_}"; printf '%s\\n' "\${!name:-}" ;;
esac
`;

function provenance(args, env) {
  const dir = mkdtempSync(path.join(tmpdir(), "cvg-provenance-test-"));
  const docker = path.join(dir, "docker");
  writeFileSync(docker, FAKE_DOCKER);
  chmodSync(docker, 0o755);
  const result = spawnSync("bash", [path.join(root, "deploy/release/installation-provenance.sh"), ...args], {
    encoding: "utf8", env: { PATH: process.env.PATH, DOCKER: docker, ...env }
  });
  const lines = (output) => output.trim().split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
  return { status: result.status, out: lines(result.stdout), err: lines(result.stderr), stderr: result.stderr };
}

const PS = "c-app app cvg-hub:sha-0123456789ab\\nc-worker worker cvg-hub-ops:sha-0123456789ab\\nc-proxy proxy caddy:2-alpine\\nc-pg postgres postgres:16-alpine\\n";

test("an installation whose app and worker carry the same commit passes, with one line per container", () => {
  const result = provenance(["--project", "cvg-prod", "--expect", COMMIT.slice(0, 12)], { FAKE_PS: PS, FAKE_c_app: COMMIT, FAKE_c_worker: COMMIT, FAKE_c_proxy: "x" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.out.map((line) => [line.event, line.service, line.revision]), [
    ["installation.provenance", "app", COMMIT], ["installation.provenance", "worker", COMMIT], ["installation.provenance_ok", undefined, COMMIT]
  ]);
});

test("unstamped, mixed, missing or other-commit installations fail with the reason", () => {
  for (const [env, args, reason] of [
    [{ FAKE_c_app: "", FAKE_c_worker: COMMIT }, [], /app runs an image without a commit/],
    [{ FAKE_c_app: "20261003", FAKE_c_worker: COMMIT }, [], /app runs an image without a commit/],
    [{ FAKE_c_app: COMMIT, FAKE_c_worker: "fedcba9876543210fedcba9876543210fedcba98" }, [], /different commits/],
    [{ FAKE_c_app: COMMIT, FAKE_c_worker: COMMIT }, ["--expect", "fedcba98"], /not fedcba98/],
    [{ FAKE_PS: "c-app app cvg-hub:x\\n", FAKE_c_app: COMMIT }, [], /worker is not running/]
  ]) {
    const result = provenance(["--project", "cvg-prod", ...args], { FAKE_PS: PS, ...env });
    assert.equal(result.status, 1, String(reason));
    assert.equal(result.err[0].event, "installation.provenance_failed");
    assert.match(result.err[0].reason, reason);
  }
});

test("bad arguments are refused before calling docker", () => {
  for (const args of [["--project", "Prod!"], ["--project", "cvg-prod", "--expect", "latest"], ["--bogus"]]) {
    assert.equal(provenance(args, {}).status, 2, args.join(" "));
  }
  assert.equal(spawnSync("bash", ["-n", path.join(root, "deploy/release/installation-provenance.sh")]).status, 0);
});
