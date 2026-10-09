import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const TAG = `sha-${COMMIT.slice(0, 12)}`;
const PREFIX = "registry.example/cvg/cvg-hub";

// A docker stand-in: records every call (with the image variables Compose would see) and answers from FAKE_*;
// FAKE_FAIL lists the calls that fail, with "_" for spaces.
const FAKE_DOCKER = `#!/usr/bin/env bash
printf '%s|%s\\n' "\${IMAGE_PREFIX:-}:\${IMAGE_TAG:-}" "$*" >> "$FAKE_LOG"
args=" $* "
for failing in \${FAKE_FAIL:-}; do
  [[ "$args" == *" \${failing//_/ } "* ]] && exit 1
done
case "$1" in
  compose)
    [[ "$args" == *" pull "* ]] && echo "minio=\${MINIO_IMAGE_TAG:-}" >> "$FAKE_LOG.env"
    [[ "$args" == *" ps -q app "* ]] && echo app-container
    [[ "$args" == *" ps -q worker "* ]] && echo worker-container
    exit 0 ;;
  pull) exit 0 ;;
  image)
    image="\${@: -1}"
    if [[ "$image" == *-ops:* ]]; then revision="\${FAKE_REVISION_OPS:-\${FAKE_REVISION:-${COMMIT}}}"; else revision="\${FAKE_REVISION:-${COMMIT}}"; fi
    # "none" stands for an image without the revision label.
    [[ "$revision" == none ]] || echo "$revision"
    exit 0 ;;
  inspect)
    [[ "$args" == *State.Running* ]] && { echo "\${FAKE_RUNNING:-true}"; exit 0; }
    echo "\${FAKE_HEALTH:-healthy}"; exit 0 ;;
esac
exit 0
`;

function workspace() {
  const dir = mkdtempSync(path.join(tmpdir(), "cvg-release-test-"));
  const docker = path.join(dir, "docker");
  writeFileSync(docker, FAKE_DOCKER);
  chmodSync(docker, 0o755);
  writeFileSync(path.join(dir, ".env.test"), "POSTGRES_DB=cvg\n");
  writeFileSync(path.join(dir, "docker-compose.prod.yml"), "services: {}\n");
  return { dir, docker, log: path.join(dir, "docker.log"), state: path.join(dir, "state") };
}

function run(script, ws, args, env = {}) {
  return spawnSync("bash", [path.join(root, script), ...args], {
    cwd: ws.dir,
    encoding: "utf8",
    env: { PATH: process.env.PATH, DOCKER: ws.docker, FAKE_LOG: ws.log, RELEASE_HEALTH_POLL_SECONDS: "0", ...env }
  });
}

const deploy = (ws, extra = [], env = {}) =>
  run("deploy/release/deploy.sh", ws, ["--project", "cvg-hml", "--env-file", ".env.test", "--tag", TAG, "--prefix", PREFIX, "--state-dir", ws.state, ...extra], env);
const calls = (ws) => (existsSync(ws.log) ? readFileSync(ws.log, "utf8").trim().split("\n") : []);
const commandOf = (line) => line.split("|")[1];
const events = (output) => output.trim().split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));

test("both release scripts parse and document their contract", () => {
  for (const script of ["deploy/release/deploy.sh", "deploy/release/pull-release.sh"]) {
    assert.equal(spawnSync("bash", ["-n", path.join(root, script)]).status, 0, script);
    const help = spawnSync("bash", [path.join(root, script), "--help"], { encoding: "utf8" });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /--project NAME/);
  }
});

test("deploy.sh refuses mutable tags, bad names and missing files before calling docker", () => {
  const ws = workspace();
  for (const [args, message] of [
    [["--tag", "latest"], /--tag/],
    [["--tag", "production"], /--tag/],
    [["--project", "Prod!"], /--project/],
    [["--prefix", "UPPER/Case"], /--prefix/],
    [["--env-file", "missing.env"], /--env-file/],
    [["--compose-file", "missing.yml"], /--compose-file/],
    [["--health-timeout", "0"], /--health-timeout/],
    [["--unknown"], /Usage/]
  ]) {
    const result = deploy(ws, args);
    assert.equal(result.status, 2, args.join(" "));
    assert.match(result.stderr, message);
  }
  assert.deepEqual(calls(ws), []);
});

test("a rolling deploy pulls, checks the commit, backs up, starts and records the release", () => {
  const ws = workspace();
  const result = deploy(ws);
  assert.equal(result.status, 0, result.stderr);
  const log = calls(ws);
  // Compose sees the release, not whatever IMAGE_TAG the env file had.
  assert.ok(log.every((line) => line.startsWith(`${PREFIX}:${TAG}|`)));
  assert.deepEqual(log.map(commandOf), [
    "compose -p cvg-hml -f docker-compose.prod.yml --env-file .env.test pull",
    `image inspect --format {{index .Config.Labels "org.opencontainers.image.revision"}} ${PREFIX}:${TAG}`,
    `image inspect --format {{index .Config.Labels "org.opencontainers.image.revision"}} ${PREFIX}-ops:${TAG}`,
    "compose -p cvg-hml -f docker-compose.prod.yml --env-file .env.test run --rm --no-deps backup --once",
    "compose -p cvg-hml -f docker-compose.prod.yml --env-file .env.test up -d --no-build",
    "compose -p cvg-hml -f docker-compose.prod.yml --env-file .env.test ps -q app",
    "inspect --format {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} app-container",
    "compose -p cvg-hml -f docker-compose.prod.yml --env-file .env.test ps -q worker",
    "inspect --format {{.State.Running}} worker-container"
  ]);
  assert.equal(readFileSync(path.join(ws.state, "cvg-hml.current"), "utf8"), `${TAG}\n`);
  assert.match(readFileSync(path.join(ws.state, "cvg-hml.history"), "utf8"), new RegExp(`^\\d{4}-\\d\\d-\\d\\dT\\S+Z ${TAG}\\n$`));
  assert.deepEqual(events(result.stdout).map((entry) => entry.event), ["release.started", "release.deployed"]);
  // The on-prem object storage image is pulled with the release tag too.
  assert.equal(readFileSync(`${ws.log}.env`, "utf8"), `minio=${TAG}\n`);
  assert.equal(events(result.stdout)[1].previous, "none");

  const again = deploy(ws, ["--compose-file", "docker-compose.prod.yml", "--compose-file", "docker-compose.prod.yml"]);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(events(again.stdout)[1].previous, TAG);
  assert.match(calls(ws).filter((line) => line.includes("|compose ")).at(-1), / -f docker-compose.prod.yml -f docker-compose.prod.yml --env-file/);
});

test("--maintenance stops the runtime before the backup and migrates alone before starting", () => {
  const ws = workspace();
  const result = deploy(ws, ["--maintenance"]);
  assert.equal(result.status, 0, result.stderr);
  const steps = calls(ws).map(commandOf).filter((line) => line.startsWith("compose")).map((line) => line.split(" --env-file .env.test ")[1]);
  assert.deepEqual(steps.slice(0, 5), ["pull", "stop proxy app worker backup", "run --rm --no-deps backup --once", "run --rm migrate", "up -d --no-build"]);
});

test("an image built from another commit stops the deploy before the backup", () => {
  for (const env of [{ FAKE_REVISION: "fedcba9876543210fedcba9876543210fedcba98" }, { FAKE_REVISION_OPS: "none" }]) {
    const ws = workspace();
    const result = deploy(ws, [], env);
    assert.equal(result.status, 1);
    assert.equal(events(result.stderr)[0].event, "release.revision_mismatch");
    assert.ok(!calls(ws).some((line) => / backup | up /.test(line)));
    assert.ok(!existsSync(path.join(ws.state, "cvg-hml.current")));
  }
});

test("no backup, no migrate: each failing step stops the deploy with its own event", () => {
  for (const [failing, event, notCalled] of [
    [".env.test_pull", "release.pull_failed", / backup /],
    ["backup_--once", "release.backup_failed", / up /],
    ["up_-d", "release.up_failed", / ps /]
  ]) {
    const ws = workspace();
    const result = deploy(ws, [], { FAKE_FAIL: failing });
    assert.equal(result.status, 1, failing);
    assert.equal(events(result.stderr)[0].event, event);
    assert.ok(!calls(ws).some((line) => notCalled.test(line)), failing);
  }
  const ws = workspace();
  const result = deploy(ws, ["--maintenance"], { FAKE_FAIL: "run_--rm_migrate" });
  assert.equal(events(result.stderr)[0].event, "release.migrate_failed");
  assert.ok(!calls(ws).some((line) => / up /.test(line)));
});

test("an app that never turns healthy or a stopped worker fails the release without recording it", () => {
  const unhealthy = workspace();
  const result = deploy(unhealthy, ["--health-timeout", "1"], { FAKE_HEALTH: "starting", RELEASE_HEALTH_POLL_SECONDS: "1" });
  assert.equal(result.status, 1);
  assert.equal(events(result.stderr)[0].event, "release.unhealthy");
  assert.match(events(result.stderr)[0].reason, /last: starting/);
  assert.ok(!existsSync(path.join(unhealthy.state, "cvg-hml.current")));

  const stopped = workspace();
  const worker = deploy(stopped, [], { FAKE_RUNNING: "false" });
  assert.equal(events(worker.stderr)[0].event, "release.worker_down");
});

function fakeDeploy(ws, status = 0) {
  const script = path.join(ws.dir, "fake-deploy.sh");
  writeFileSync(script, `#!/usr/bin/env bash\nprintf 'deploy|%s\\n' "$*" >> "$FAKE_LOG"\nexit ${status}\n`);
  chmodSync(script, 0o755);
  return script;
}

const follow = (ws, deployScript, env = {}) =>
  run("deploy/release/pull-release.sh", ws, ["--channel", "staging", "--project", "cvg-hml", "--env-file", ".env.test", "--prefix", PREFIX, "--state-dir", ws.state, "--compose-file", "docker-compose.prod.yml"], { RELEASE_DEPLOY_SCRIPT: deployScript, ...env });

test("pull-release.sh deploys the commit a channel points to, once", () => {
  const ws = workspace();
  const first = follow(ws, fakeDeploy(ws));
  assert.equal(first.status, 0, first.stderr);
  const deployed = calls(ws).filter((line) => line.startsWith("deploy|"));
  assert.deepEqual(deployed, [`deploy|--project cvg-hml --env-file .env.test --compose-file docker-compose.prod.yml --prefix ${PREFIX} --tag ${TAG} --state-dir ${ws.state}`]);
  assert.ok(calls(ws).some((line) => line.endsWith(`pull --quiet ${PREFIX}:staging`)) && calls(ws).some((line) => line.endsWith(`pull --quiet ${PREFIX}-ops:staging`)));

  // Already running this commit: nothing to do.
  writeFileSync(path.join(ws.state, "cvg-hml.current"), `${TAG}\n`);
  const second = follow(ws, fakeDeploy(ws));
  assert.equal(second.status, 0);
  assert.equal(calls(ws).filter((line) => line.startsWith("deploy|")).length, 1);
});

test("pull-release.sh refuses a channel whose images disagree and does not retry a failed release", () => {
  const ws = workspace();
  const mixed = follow(ws, fakeDeploy(ws), { FAKE_REVISION_OPS: "fedcba9876543210fedcba9876543210fedcba98" });
  assert.equal(mixed.status, 1);
  assert.equal(events(mixed.stderr)[0].event, "release.channel_inconsistent");
  const unlabelled = follow(ws, fakeDeploy(ws), { FAKE_REVISION: "none" });
  assert.equal(events(unlabelled.stderr)[0].event, "release.channel_inconsistent");
  assert.equal(follow(ws, fakeDeploy(ws), { FAKE_FAIL: "pull_--quiet" }).status, 1);

  const failed = follow(ws, fakeDeploy(ws, 1));
  assert.equal(failed.status, 1);
  assert.equal(events(failed.stderr)[0].event, "release.failed");
  assert.equal(readFileSync(path.join(ws.state, "cvg-hml.failed"), "utf8"), `${TAG}\n`);
  const skipped = follow(ws, fakeDeploy(ws));
  assert.equal(skipped.status, 0);
  assert.equal(events(skipped.stdout)[0].event, "release.skipped_failed");
  assert.equal(calls(ws).filter((line) => line.startsWith("deploy|")).length, 1);

  for (const args of [["--channel", "latest"], ["--project", "X"], ["--prefix", "-bad"]]) {
    const invalid = run("deploy/release/pull-release.sh", ws, ["--channel", "staging", "--project", "cvg-hml", "--prefix", PREFIX, ...args]);
    assert.equal(invalid.status, 2, args.join(" "));
  }
});
