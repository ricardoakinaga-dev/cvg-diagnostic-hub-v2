import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bash = (file, args = [], env = {}) =>
  spawnSync("bash", [path.join(root, file), ...args], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
const sh = (file, args = [], env = {}) =>
  spawnSync("sh", [path.join(root, file), ...args], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
const temp = () => mkdtempSync(path.join(tmpdir(), "cvg-wal-test-"));

const shellScripts = [
  "scripts/restore-pitr.sh", "scripts/backup-drill.sh", "scripts/secret-scan.sh",
  "deploy/backup/archive-wal.sh", "deploy/backup/backup-loop.sh", "deploy/backup/check-offsite.sh",
  "deploy/backup/ship-offsite.sh", "deploy/backup/postgres-entrypoint.sh"
];

test("every WAL archiving and PITR script parses", () => {
  for (const file of shellScripts) {
    const result = spawnSync(file.startsWith("deploy") ? "sh" : "bash", ["-n", path.join(root, file)], { encoding: "utf8" });
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
  }
});

test("restore-pitr.sh --help documents the contract and validates its arguments", () => {
  const help = bash("scripts/restore-pitr.sh", ["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--target-time/);
  assert.match(help.stdout, /--latest/);

  const base = temp();
  const wal = path.join(base, "wal");
  const data = path.join(base, "data");
  mkdirSync(wal);
  writeFileSync(path.join(base, "base.tar.gz"), "x");
  const common = ["--base", base, "--wal", wal, "--data", data, "--port", "55399"];
  const fails = (args, pattern) => {
    const result = bash("scripts/restore-pitr.sh", args);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, pattern);
  };
  fails(common, /--target-time <ISO-8601> ou --latest/);
  fails([...common, "--latest", "--target-time", "2026-10-08T10:00:00Z"], /não os dois/);
  fails([...common, "--target-time", "ontem"], /ISO-8601/);
  fails(["--wal", wal, "--data", data, "--port", "55399", "--latest"], /--base é obrigatório/);
  fails([...common.slice(0, -1), "80", "--latest"], /--port/);
  fails([...common, "--latest", "--bogus"], /desconhecido/);
  fails(["--base", path.join(base, "missing"), "--wal", wal, "--data", data, "--port", "55399", "--latest"], /backup base não encontrado/);

  const dry = bash("scripts/restore-pitr.sh", [...common, "--target-time", "2026-10-08T10:00:00-03:00", "--dry-run"]);
  assert.equal(dry.status, 0, dry.stderr);
  const plan = JSON.parse(dry.stdout);
  assert.equal(plan.event, "pitr.dry_run");
  assert.equal(plan.target, "2026-10-08T10:00:00-03:00");
  assert.equal(existsSync(data), false, "a dry run must not create the data directory");

  mkdirSync(data);
  assert.equal(bash("scripts/restore-pitr.sh", [...common, "--latest", "--dry-run"]).status, 0, "an existing empty directory is accepted");
  writeFileSync(path.join(data, "PG_VERSION"), "16");
  fails([...common, "--latest", "--dry-run"], /não está vazio/);
  rmSync(base, { recursive: true, force: true });
});

test("check-offsite.sh is healthy when fresh, disabled or opted out, and fails when stale, missing or unreadable", () => {
  const dir = temp();
  const status = path.join(dir, "offsite-status.json");
  const env = { OFFSITE_RCLONE_REMOTE: "s3:bucket/path", OFFSITE_SHIP_INTERVAL_SECONDS: "300", NOW_EPOCH: "10000" };
  const check = (extra = {}) => sh("deploy/backup/check-offsite.sh", [status], { ...env, ...extra });
  const write = (epoch, result = "ok") =>
    writeFileSync(status, JSON.stringify({ lastShippedAt: "x", lastShippedEpoch: epoch, lastResult: result, walSegments: 3, bytes: 1 }));

  assert.equal(check().status, 1, "missing status file");
  assert.match(check().stderr, /status file missing/);
  writeFileSync(status, "not json");
  assert.equal(check().status, 1);
  assert.match(check().stderr, /unreadable/);
  write(10000 - 899);
  assert.equal(check().status, 0, "899 s old with a 900 s limit");
  write(10000 - 900);
  assert.equal(check().status, 0, "exactly 3 x interval is still fresh");
  write(10000 - 901);
  const stale = check();
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /"reason":"stale"/);
  write(0, "error");
  assert.equal(check().status, 1, "never shipped");
  write(10000 - 400, "error");
  assert.equal(check().status, 0, "a failed attempt keeps the last success timestamp");
  assert.equal(check({ OFFSITE_SHIP_INTERVAL_SECONDS: "100" }).status, 1, "the limit follows the interval");
  assert.equal(check({ OFFSITE_RCLONE_REMOTE: "" }).status, 0, "opt-in feature: disabled is healthy");
  assert.match(check({ OFFSITE_RCLONE_REMOTE: "" }).stdout, /disabled/);
  rmSync(dir, { recursive: true, force: true });
});

test("ship-offsite.sh without a remote logs offsite.disabled and exits cleanly in --once mode", () => {
  const dir = temp();
  const result = sh("deploy/backup/ship-offsite.sh", ["--once"], { OFFSITE_RCLONE_REMOTE: "", BACKUP_DIRECTORY: dir, WAL_ARCHIVE_DIRECTORY: dir });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"event":"offsite.disabled"/);
  const status = JSON.parse(readFileSync(path.join(dir, "offsite-status.json"), "utf8"));
  assert.equal(status.lastResult, "disabled");
  rmSync(dir, { recursive: true, force: true });
});

// Fake rclone: `copy` copies files and logs every call; `sync` is forbidden and fails loudly.
function offsiteFixture() {
  const dir = temp();
  const bin = path.join(dir, "bin");
  const log = path.join(dir, "rclone.log");
  const remote = path.join(dir, "remote");
  const backups = path.join(dir, "backups");
  const wal = path.join(dir, "wal");
  const statusFile = path.join(dir, "status", "offsite-status.json");
  for (const d of [bin, remote, wal, path.dirname(statusFile)]) mkdirSync(d, { recursive: true });
  writeFileSync(path.join(bin, "rclone"), [
    "#!/bin/sh",
    `echo "$*" >> '${log}'`,
    'if [ "$1" = sync ]; then echo "sync is forbidden" >> \'' + log + "'; exit 1; fi",
    'if [ "$1" = listremotes ]; then printf "%s\\n" "${FAKE_REMOTES:-}"; exit 0; fi',
    'if [ "$1" = obscure ]; then printf "obscured-%s" "$(cat)"; exit 0; fi',
    'if [ "$1" = size ]; then [ -d "$2" ] || exit 1; printf \'{"count":%s,"bytes":%s}\n\' "$(find "$2" -type f | wc -l)" "$(cat "$2"/* 2>/dev/null | wc -c)"; exit 0; fi',
    'if [ "$1" != copy ]; then exit 1; fi',
    '[ -d "$2" ] || exit 1',
    'mkdir -p "$3"',
    // Honours the --exclude of partial backups like rclone does.
    'skip_partial=0; case " $* " in *"*.partial"*) skip_partial=1 ;; esac',
    'case " $* " in *" --ignore-existing "*) cd "$2" && find . -type f | while read -r f; do case "$f" in *.partial/*|*.partial) [ "$skip_partial" = 1 ] && continue ;; esac; [ -e "$3/$f" ] || { mkdir -p "$3/$(dirname "$f")"; cp "$f" "$3/$f"; }; done ;;',
    '*) cp -r "$2"/. "$3"/ ;; esac'
  ].join("\n"), { mode: 0o755 });
  writeFileSync(path.join(wal, "000000010000000000000001"), "wal");
  const remoteDest = path.join(remote, "dest");
  const run = (env = {}) => sh("deploy/backup/ship-offsite.sh", ["--once"], {
    PATH: `${bin}:${process.env.PATH}`, OFFSITE_RCLONE_REMOTE: remoteDest, BACKUP_DIRECTORY: backups, WAL_ARCHIVE_DIRECTORY: wal,
    OFFSITE_STATUS_FILE: statusFile, OFFSITE_ALLOW_PLAINTEXT: "true", BACKUP_HELPERS_DIR: path.join(root, "deploy/backup"), ...env
  });
  const seedRemote = () => {
    mkdirSync(path.join(remoteDest, "dumps"), { recursive: true });
    for (const n of ["a.dump", "b.dump", "c.dump"]) writeFileSync(path.join(remoteDest, "dumps", n), "old");
  };
  const remoteFiles = () => (existsSync(path.join(remoteDest, "dumps")) ? readdirSync(path.join(remoteDest, "dumps")).sort() : []);
  const status = () => JSON.parse(readFileSync(statusFile, "utf8"));
  const rcloneLog = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
  const addBackup = (ageSeconds = 0, kinds = ["dump", "base"]) => {
    const when = new Date(Date.now() - ageSeconds * 1000);
    const files = [];
    if (kinds.includes("dump")) files.push(path.join(backups, "cvg-20261008.dump"));
    if (kinds.includes("base")) { mkdirSync(path.join(backups, "base", "20261008T000000Z"), { recursive: true }); files.push(path.join(backups, "base", "20261008T000000Z", "base.tar.gz")); }
    mkdirSync(backups, { recursive: true });
    for (const f of files) { writeFileSync(f, "data"); utimesSync(f, when, when); }
  };
  const bucket = path.join(dir, "bucket");
  const addObject = (name, content = "object") => { mkdirSync(path.dirname(path.join(bucket, name)), { recursive: true }); writeFileSync(path.join(bucket, name), content); };
  const remoteObjects = () => (existsSync(path.join(remoteDest, "objects")) ? readdirSync(path.join(remoteDest, "objects")).sort() : []);
  return { dir, bin, run, seedRemote, remoteFiles, status, rcloneLog, addBackup, backups, statusFile, remote: remoteDest, bucket, addObject, remoteObjects };
}

test("ship-offsite.sh copies the attachments bucket write-once and never deletes or overwrites an object on the remote", () => {
  const f = offsiteFixture();
  f.addBackup(0);
  f.addObject("attachments/a.bin", "a");
  f.addObject("b.bin", "good b");
  const first = f.run({ OFFSITE_BUCKET_SOURCE: f.bucket });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /"event":"offsite.shipped".*"objects":2/);
  assert.deepEqual(readdirSync(path.join(f.remote, "objects"), { recursive: true }).sort(), ["attachments", path.join("attachments", "a.bin"), "b.bin"].sort());
  assert.equal(f.status().objects, 2);
  assert.match(f.rcloneLog(), new RegExp(`copy ${f.bucket.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} .*/objects .*--ignore-existing`));
  // Object deleted at the source (purge, mistake or attacker) and another re-encrypted in place: the remote keeps both originals.
  rmSync(path.join(f.bucket, "attachments", "a.bin"));
  writeFileSync(path.join(f.bucket, "b.bin"), "ENCRYPTED");
  const second = f.run({ OFFSITE_BUCKET_SOURCE: f.bucket });
  assert.equal(second.status, 0, second.stderr);
  assert.ok(existsSync(path.join(f.remote, "objects", "attachments", "a.bin")));
  assert.equal(readFileSync(path.join(f.remote, "objects", "b.bin"), "utf8"), "good b");
  assert.equal(f.status().objects, 1);
  assert.doesNotMatch(f.rcloneLog(), /forbidden|(^|\n)sync |delete|purge/);
  rmSync(f.dir, { recursive: true, force: true });
});

test("ship-offsite.sh refuses the cycle when the bucket source cannot be listed, still ships WAL and dumps, and touches nothing on the remote", () => {
  const f = offsiteFixture();
  f.addBackup(0);
  f.addObject("kept.bin");
  assert.equal(f.run({ OFFSITE_BUCKET_SOURCE: f.bucket }).status, 0);
  const epoch = f.status().lastShippedEpoch;
  assert.deepEqual(f.remoteObjects(), ["kept.bin"]);
  // Wrong bucket name / MinIO down: `rclone size` fails.
  const refused = f.run({ OFFSITE_BUCKET_SOURCE: path.join(f.dir, "missing-bucket") });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /"event":"offsite.refused","reason":"bucket source unreachable/);
  assert.equal(f.status().lastResult, "error");
  assert.equal(f.status().lastShippedEpoch, epoch, "a refused cycle is not a success");
  assert.match(f.status().reason, /bucket source unreachable/);
  assert.deepEqual(f.remoteObjects(), ["kept.bin"]);
  assert.ok(existsSync(path.join(f.remote, "dumps", "cvg-20261008.dump")), "PostgreSQL artifacts still leave the building");
  assert.doesNotMatch(f.rcloneLog(), /copy .*missing-bucket/);
  // Both problems at once are reported together.
  rmSync(f.backups, { recursive: true, force: true }); mkdirSync(f.backups);
  const both = f.run({ OFFSITE_BUCKET_SOURCE: path.join(f.dir, "missing-bucket") });
  assert.notEqual(both.status, 0);
  assert.match(f.status().reason, /no valid backup.*; bucket source unreachable/);
  rmSync(f.dir, { recursive: true, force: true });
});

test("ship-offsite.sh without OFFSITE_BUCKET_SOURCE never calls rclone size and reports objects 0", () => {
  const f = offsiteFixture();
  f.addBackup(0);
  assert.equal(f.run().status, 0);
  assert.equal(f.status().objects, 0);
  assert.doesNotMatch(f.rcloneLog(), /(^|\n)size /);
  rmSync(f.dir, { recursive: true, force: true });
});

test("ship-offsite.sh refuses an existing but empty /backups, keeps the remote and never calls sync", () => {
  const f = offsiteFixture();
  f.seedRemote(); mkdirSync(f.backups);
  writeFileSync(f.statusFile, '{"lastShippedAt":"x","lastShippedEpoch":1700000000,"lastAttemptAt":"x","lastResult":"ok","walSegments":1,"bytes":1}\n');
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /"event":"offsite.refused"/);
  assert.deepEqual(f.remoteFiles(), ["a.dump", "b.dump", "c.dump"]);
  assert.equal(f.status().lastResult, "error");
  assert.equal(f.status().lastShippedEpoch, 1700000000);
  assert.match(f.status().reason, /no valid backup/);
  assert.doesNotMatch(f.rcloneLog(), /(^|\n)sync /);
  assert.doesNotMatch(f.rcloneLog(), /forbidden/);
  rmSync(f.dir, { recursive: true, force: true });
});

test("ship-offsite.sh refuses a missing /backups directory", () => {
  const f = offsiteFixture();
  f.seedRemote();
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /offsite.refused/);
  assert.equal(f.status().lastResult, "error");
  assert.equal(f.status().lastShippedEpoch, 0);
  assert.match(f.status().reason, /missing/);
  assert.deepEqual(f.remoteFiles(), ["a.dump", "b.dump", "c.dump"]);
  rmSync(f.dir, { recursive: true, force: true });
});

test("ship-offsite.sh repeated cycles never delete on the remote, even after the source is emptied", () => {
  const f = offsiteFixture();
  f.addBackup(0);
  for (let i = 0; i < 3; i += 1) assert.equal(f.run().status, 0);
  const shipped = readdirSync(path.join(f.remote, "dumps"), { recursive: true }).sort();
  assert.ok(shipped.some((n) => n.endsWith("base.tar.gz")) && shipped.includes("cvg-20261008.dump"));
  const epoch = f.status().lastShippedEpoch;
  assert.ok(epoch > 0);
  rmSync(f.backups, { recursive: true, force: true }); mkdirSync(f.backups);
  for (let i = 0; i < 2; i += 1) {
    assert.notEqual(f.run().status, 0);
    assert.deepEqual(readdirSync(path.join(f.remote, "dumps"), { recursive: true }).sort(), shipped);
    assert.equal(f.status().lastResult, "error");
    assert.equal(f.status().lastShippedEpoch, epoch);
  }
  assert.doesNotMatch(f.rcloneLog(), /forbidden|(^|\n)sync /);
  rmSync(f.dir, { recursive: true, force: true });
});

test("ship-offsite.sh never overwrites a remote file whose local copy changed in place", () => {
  const f = offsiteFixture();
  f.addBackup(0, ["dump"]);
  const dump = path.join(f.backups, "cvg-20261008.dump");
  writeFileSync(dump, "good dump");
  assert.equal(f.run().status, 0);
  assert.equal(readFileSync(path.join(f.remote, "dumps", "cvg-20261008.dump"), "utf8"), "good dump");
  // Same name, new content, fresh mtime: what in-place encryption looks like.
  writeFileSync(dump, "ENCRYPTED");
  assert.equal(f.run().status, 0);
  assert.equal(readFileSync(path.join(f.remote, "dumps", "cvg-20261008.dump"), "utf8"), "good dump");
  assert.match(f.rcloneLog(), /copy .*backups .*--ignore-existing/);
  rmSync(f.dir, { recursive: true, force: true });
});

test("ship-offsite.sh judges freshness by the newest valid artifact and OFFSITE_MAX_BACKUP_AGE_SECONDS", () => {
  const f = offsiteFixture();
  f.addBackup(10 * 86400, ["base"]);
  const stale = f.run();
  assert.notEqual(stale.status, 0);
  assert.match(f.status().reason, /old/);
  // An empty (0 byte) fresh dump is not a valid artifact.
  writeFileSync(path.join(f.backups, "cvg-empty.dump"), "");
  assert.notEqual(f.run().status, 0);
  // A fresh dump next to the old base is enough.
  f.addBackup(0, ["dump"]);
  assert.equal(f.run().status, 0);
  assert.equal(f.status().lastResult, "ok");
  // A tight limit refuses a dump that is two minutes old.
  f.addBackup(120, ["dump"]);
  rmSync(path.join(f.backups, "base"), { recursive: true, force: true });
  const tight = f.run({ OFFSITE_MAX_BACKUP_AGE_SECONDS: "60" });
  assert.notEqual(tight.status, 0);
  assert.match(f.status().reason, /old \(limit 60 s\)/);
  // Default limit derives from BACKUP_INTERVAL_SECONDS (2 x).
  assert.notEqual(f.run({ BACKUP_INTERVAL_SECONDS: "30" }).status, 0);
  assert.equal(f.run({ BACKUP_INTERVAL_SECONDS: "3600" }).status, 0);
  rmSync(f.dir, { recursive: true, force: true });
});

test("ship-offsite.sh never counts a backup still being written as a fresh one (REM-02)", () => {
  const f = offsiteFixture();
  const partialBase = (stamp) => {
    mkdirSync(path.join(f.backups, "base", `${stamp}.partial`), { recursive: true });
    writeFileSync(path.join(f.backups, "base", `${stamp}.partial`, "base.tar.gz"), "half a base backup");
  };
  // Only a base backup in progress: refused, nothing but WAL leaves, the last success does not move.
  partialBase("20261009T101500Z");
  writeFileSync(path.join(f.backups, "cvg-20261009T101500Z.dump.partial"), "half a dump");
  const onlyPartial = f.run();
  assert.notEqual(onlyPartial.status, 0);
  assert.match(onlyPartial.stderr, /"event":"offsite.refused"/);
  assert.match(f.status().reason, /no valid backup/);
  assert.equal(f.status().lastShippedEpoch, 0);
  assert.deepEqual(f.remoteFiles(), []);
  // A finished dump five days old plus a fresh partial base: still refused as old.
  f.addBackup(5 * 86400, ["dump"]);
  const stale = f.run();
  assert.notEqual(stale.status, 0);
  assert.match(f.status().reason, /old/);
  assert.equal(f.status().lastShippedEpoch, 0);
  // The base backup finishes (renamed out of .partial): fresh, shipped, and the partial leftovers stay home.
  renameSync(path.join(f.backups, "base", "20261009T101500Z.partial"), path.join(f.backups, "base", "20261009T101500Z"));
  partialBase("20261010T101500Z");
  assert.equal(f.run().status, 0);
  assert.equal(f.status().lastResult, "ok");
  const shipped = readdirSync(path.join(f.remote, "dumps"), { recursive: true }).map(String).sort();
  assert.ok(shipped.includes(path.join("base", "20261009T101500Z", "base.tar.gz")));
  assert.ok(!shipped.some((name) => name.includes(".partial")));
  rmSync(f.dir, { recursive: true, force: true });
});

test("ship-offsite.sh still copies WAL in a refused cycle and reports error when the WAL copy fails", () => {
  const f = offsiteFixture();
  mkdirSync(f.backups);
  assert.notEqual(f.run().status, 0);
  assert.ok(existsSync(path.join(f.remote, "wal", "000000010000000000000001")));
  assert.match(f.rcloneLog(), new RegExp(`copy ${f.dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/wal `));
  f.addBackup(0);
  rmSync(path.join(f.dir, "wal"), { recursive: true });
  const failed = f.run();
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /offsite.failed/);
  assert.equal(f.status().lastResult, "error");
  rmSync(f.dir, { recursive: true, force: true });
});

test("archive-wal.sh copies atomically, is idempotent and refuses to overwrite a different segment", () => {
  const dir = temp();
  const archive = path.join(dir, "archive");
  mkdirSync(archive);
  const segment = path.join(dir, "000000010000000000000007");
  writeFileSync(segment, Buffer.alloc(4096, 7));
  const env = { WAL_ARCHIVE_DIRECTORY: archive };
  const name = "000000010000000000000007";

  const first = sh("deploy/backup/archive-wal.sh", [segment, name], env);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(readdirSync(archive), [name], "no temp file is left behind");
  assert.deepEqual(readFileSync(path.join(archive, name)), readFileSync(segment));

  assert.equal(sh("deploy/backup/archive-wal.sh", [segment, name], env).status, 0, "re-archiving the same segment succeeds (crash after rename)");

  writeFileSync(segment, Buffer.alloc(4096, 9));
  const clash = sh("deploy/backup/archive-wal.sh", [segment, name], env);
  assert.equal(clash.status, 1);
  assert.match(clash.stderr, /different_segment_exists/);
  assert.equal(readFileSync(path.join(archive, name))[0], 7, "the archived segment is never replaced");

  const missing = sh("deploy/backup/archive-wal.sh", [path.join(dir, "absent"), "000000010000000000000008"], env);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /source_missing/);
  const noArchive = sh("deploy/backup/archive-wal.sh", [segment, "000000010000000000000009"], { WAL_ARCHIVE_DIRECTORY: path.join(dir, "gone") });
  assert.equal(noArchive.status, 1);
  assert.match(noArchive.stderr, /archive_missing/);
  assert.notEqual(sh("deploy/backup/archive-wal.sh", [], env).status, 0, "missing arguments fail");
  rmSync(dir, { recursive: true, force: true });
});

test("backup-loop.sh prunes old dumps and base backups but never the WAL the oldest retained base backup needs", () => {
  const dir = temp();
  const backups = path.join(dir, "backups");
  const wal = path.join(dir, "wal");
  mkdirSync(path.join(backups, "base"), { recursive: true });
  mkdirSync(wal);
  const day = 86400 * 1000;
  const age = (target, days) => { const when = new Date(Date.now() - days * day); utimesSync(target, when, when); };
  const baseBackup = (stamp, startWal, days) => {
    const folder = path.join(backups, "base", stamp);
    mkdirSync(folder);
    const label = path.join(dir, "backup_label");
    writeFileSync(label, `START WAL LOCATION: 0/3000028 (file ${startWal})\nCHECKPOINT LOCATION: 0/3000060\n`);
    const tar = spawnSync("tar", ["-czf", path.join(folder, "base.tar.gz"), "-C", dir, "backup_label"]);
    assert.equal(tar.status, 0);
    age(folder, days);
  };
  baseBackup("20260920T020000Z", "000000010000000000000003", 18); // expired, but newest-but-one
  baseBackup("20260930T020000Z", "000000010000000000000010", 8);
  baseBackup("20261007T020000Z", "000000010000000000000020", 3);
  for (const n of [1, 2, 3, 15, 16, 17, 31, 32, 40]) writeFileSync(path.join(wal, `0000000100000000000000${n.toString(16).toUpperCase().padStart(2, "0")}`), "w");
  writeFileSync(path.join(wal, "00000002.history"), "h");
  for (const [name, days] of [["cvg-old.dump", 20], ["cvg-new.dump", 1]]) { writeFileSync(path.join(backups, name), "d"); age(path.join(backups, name), days); }

  const run = (retention) => spawnSync("sh", ["-c", `. "${path.join(root, "deploy/backup/backup-loop.sh")}"; prune`], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, BACKUP_LOOP_SOURCE_ONLY: "1", BACKUP_HELPERS_DIR: path.join(root, "deploy/backup"), PGHOST: "x", PGUSER: "x", PGPASSWORD: "x", PGDATABASE: "x", BACKUP_DIRECTORY: backups, WAL_ARCHIVE_DIRECTORY: wal, BACKUP_RETENTION_DAYS: String(retention) }
  });
  const result = run(14);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(path.join(backups, "base")).sort(), ["20260930T020000Z", "20261007T020000Z"]);
  assert.deepEqual(readdirSync(backups).filter((f) => f.endsWith(".dump")), ["cvg-new.dump"]);
  // oldest retained base backup starts at WAL 0x10: everything older goes, everything from 0x10 on and the history file stay
  assert.match(result.stdout, /"boundary":"000000010000000000000010","removed":4/);
  assert.deepEqual(readdirSync(wal).sort(), ["00000001000000000000001F", "000000010000000000000010", "000000010000000000000011", "000000010000000000000020", "000000010000000000000028", "00000002.history"].sort());
  assert.ok(existsSync(path.join(wal, "000000010000000000000010")));
  assert.ok(existsSync(path.join(wal, "000000010000000000000020")));
  assert.ok(existsSync(path.join(wal, "00000002.history")));

  // Retention shorter than every backup: the newest base backup still survives, and so does the WAL from it onward.
  assert.equal(run(0).status, 0);
  assert.deepEqual(readdirSync(path.join(backups, "base")), ["20261007T020000Z"]);
  assert.ok(existsSync(path.join(wal, "000000010000000000000020")));
  assert.ok(!existsSync(path.join(wal, "000000010000000000000010")));
  rmSync(dir, { recursive: true, force: true });
});

test("ship-offsite.sh refuses a destination that is not a crypt remote unless the hospital allowed plaintext (D-051)", () => {
  const f = offsiteFixture();
  f.addBackup(0);
  const refused = f.run({ OFFSITE_ALLOW_PLAINTEXT: "" });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /offsite.refused.*not a crypt remote/);
  assert.equal(f.status().lastResult, "error");
  assert.match(f.status().reason, /not a crypt remote.*D-051/);
  assert.deepEqual(f.remoteFiles(), [], "nothing was shipped");
  assert.equal(f.run({ OFFSITE_ALLOW_PLAINTEXT: "false" }).status, 1);
  assert.equal(f.run({ OFFSITE_ALLOW_PLAINTEXT: "true" }).status, 0);
  // A named remote whose type is crypt is accepted without the plaintext flag; the fake rclone answers listremotes.
  const crypt = f.run({ OFFSITE_ALLOW_PLAINTEXT: "", FAKE_REMOTES: `${f.remote}: crypt` });
  assert.equal(crypt.status, 0, crypt.stderr);
  const s3 = f.run({ OFFSITE_ALLOW_PLAINTEXT: "", FAKE_REMOTES: `${f.remote}: s3` });
  assert.notEqual(s3.status, 0);
  assert.match(f.status().reason, /type s3/);
  rmSync(f.dir, { recursive: true, force: true });
});

test("ship-offsite.sh defines the offsitecrypt remote from the passphrase files, obscured, never on the command line", () => {
  const f = offsiteFixture();
  f.addBackup(0);
  writeFileSync(path.join(f.dir, "crypt_password"), "passphrase-from-the-vault\n");
  writeFileSync(path.join(f.dir, "crypt_salt"), "salt-from-the-vault\n");
  writeFileSync(path.join(f.bin, "env-dump"), "#!/bin/sh\nenv | grep '^RCLONE_CONFIG_OFFSITECRYPT_' | sort\n", { mode: 0o755 });
  const result = sh("deploy/backup/ship-offsite.sh", ["--once"], {
    PATH: `${f.bin}:${process.env.PATH}`, OFFSITE_RCLONE_REMOTE: f.remote, OFFSITE_ALLOW_PLAINTEXT: "true", BACKUP_DIRECTORY: f.backups, WAL_ARCHIVE_DIRECTORY: path.join(f.dir, "wal"),
    OFFSITE_STATUS_FILE: f.statusFile, BACKUP_HELPERS_DIR: path.join(root, "deploy/backup"),
    OFFSITE_CRYPT_REMOTE: "s3:cvg-offsite/hospital", OFFSITE_CRYPT_PASSWORD_FILE: path.join(f.dir, "crypt_password"), OFFSITE_CRYPT_SALT_FILE: path.join(f.dir, "crypt_salt")
  });
  assert.equal(result.status, 0, result.stderr);
  // The variables the script exports are what rclone sees: type crypt over the wrapped remote, obscured passphrases.
  const helpersDir = path.join(root, "deploy/backup");
  const probe = sh("scripts/test-helpers/secrets-env-probe.sh", ["configure"], { PATH: `${f.bin}:${process.env.PATH}`, BACKUP_HELPERS_DIR: helpersDir, OFFSITE_CRYPT_REMOTE: "s3:cvg-offsite/hospital", OFFSITE_CRYPT_PASSWORD_FILE: path.join(f.dir, "crypt_password"), OFFSITE_CRYPT_SALT_FILE: path.join(f.dir, "crypt_salt") });
  assert.equal(probe.status, 0, probe.stderr);
  assert.match(probe.stdout, /RCLONE_CONFIG_OFFSITECRYPT_TYPE=crypt/);
  assert.match(probe.stdout, /RCLONE_CONFIG_OFFSITECRYPT_REMOTE=s3:cvg-offsite\/hospital/);
  assert.match(probe.stdout, /RCLONE_CONFIG_OFFSITECRYPT_PASSWORD=obscured-passphrase-from-the-vault/);
  assert.match(probe.stdout, /RCLONE_CONFIG_OFFSITECRYPT_PASSWORD2=obscured-salt-from-the-vault/);
  assert.doesNotMatch(probe.stdout, /OFFSITE_CRYPT_PASSWORD=passphrase/);
  // Missing wrapped remote or unreadable passphrase file: refused before any copy.
  const missing = sh("scripts/test-helpers/secrets-env-probe.sh", ["configure"], { PATH: `${f.bin}:${process.env.PATH}`, BACKUP_HELPERS_DIR: helpersDir, OFFSITE_CRYPT_PASSWORD_FILE: path.join(f.dir, "crypt_password") });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /OFFSITE_CRYPT_REMOTE missing/);
  const unreadable = sh("scripts/test-helpers/secrets-env-probe.sh", ["configure"], { PATH: `${f.bin}:${process.env.PATH}`, BACKUP_HELPERS_DIR: helpersDir, OFFSITE_CRYPT_REMOTE: "s3:x", OFFSITE_CRYPT_PASSWORD_FILE: path.join(f.dir, "absent") });
  assert.notEqual(unreadable.status, 0);
  assert.match(unreadable.stderr, /SECRET_FILE_UNREADABLE:OFFSITE_CRYPT_PASSWORD/);
  rmSync(f.dir, { recursive: true, force: true });
});

test("backup-loop.sh and ship-offsite.sh read *_FILE secrets and refuse a conflicting pair (PROD-302)", () => {
  const dir = temp();
  writeFileSync(path.join(dir, "pw"), "runtime-password-from-file\n");
  const helpersDir = path.join(root, "deploy/backup");
  const loaded = sh("scripts/test-helpers/secrets-env-probe.sh", ["load", "PGPASSWORD", "PGBACKUP_PASSWORD"], { BACKUP_HELPERS_DIR: helpersDir, PGPASSWORD_FILE: path.join(dir, "pw"), PGBACKUP_PASSWORD_FILE: "" });
  assert.equal(loaded.status, 0, loaded.stderr);
  assert.match(loaded.stdout, /^PGPASSWORD=runtime-password-from-file$/m);
  assert.doesNotMatch(loaded.stdout, /^PGBACKUP_PASSWORD=/m, "an empty NAME_FILE leaves NAME unset");
  const conflict = sh("scripts/test-helpers/secrets-env-probe.sh", ["load", "PGPASSWORD"], { BACKUP_HELPERS_DIR: helpersDir, PGPASSWORD: "other", PGPASSWORD_FILE: path.join(dir, "pw") });
  assert.notEqual(conflict.status, 0);
  assert.match(conflict.stderr, /SECRET_CONFLICT:PGPASSWORD/);
  // backup-loop.sh itself: the password file satisfies the mandatory PGPASSWORD.
  const loop = sh("scripts/test-helpers/secrets-env-probe.sh", ["backup-loop"], { BACKUP_LOOP_SOURCE_ONLY: "1", BACKUP_HELPERS_DIR: helpersDir, PGHOST: "x", PGUSER: "x", PGPASSWORD_FILE: path.join(dir, "pw"), PGDATABASE: "x", BACKUP_DIRECTORY: path.join(dir, "b"), WAL_ARCHIVE_DIRECTORY: path.join(dir, "w") });
  assert.equal(loop.status, 0, loop.stderr);
  assert.match(loop.stdout, /^PGPASSWORD=runtime-password-from-file$/m);
  rmSync(dir, { recursive: true, force: true });
});

test("docker-compose.prod.yml renders with an environment built from .env.production.example", { skip: spawnSync("docker", ["compose", "version"]).status !== 0 }, () => {
  const dir = temp();
  const example = readFileSync(path.join(root, ".env.production.example"), "utf8");
  const filled = example.split("\n").map((line) => {
    const match = /^([A-Z0-9_]+)=$/.exec(line);
    return match ? `${match[1]}=${/REMOTE|ENDPOINT|DOMAIN|EMAIL|VERSION|REF|APPROVED|TOKEN/.test(match[1]) && !/ENDPOINT|DOMAIN/.test(match[1]) ? "" : "value-for-config-check-0123456789abcdef"}` : line;
  }).join("\n");
  const envFile = path.join(dir, "env");
  const secretsDir = path.join(dir, "secrets");
  mkdirSync(secretsDir);
  writeFileSync(path.join(dir, "web.crt"), "cert"); writeFileSync(path.join(dir, "web.key"), "key");
  writeFileSync(envFile, `${filled}\nSECRETS_DIR=${secretsDir}\nONPREM_DIR=${dir}\nTLS_CERT_FILE=${path.join(dir, "web.crt")}\nTLS_KEY_FILE=${path.join(dir, "web.key")}\n`);
  const config = (files) => spawnSync("docker", ["compose", ...files.flatMap((f) => ["-f", path.join(root, f)]), "--env-file", envFile, "config", "--format", "json"], { encoding: "utf8", env: { ...process.env, DRILL_PORT: "55304" } });
  const result = config(["docker-compose.prod.yml"]);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  const postgres = parsed.services.postgres;
  assert.ok(postgres.command.includes("archive_mode=on"));
  assert.ok(postgres.command.includes("wal_level=replica"));
  assert.ok(postgres.command.includes("archive_timeout=300"));
  assert.ok(postgres.command.some((arg) => arg.startsWith("archive_command=") && arg.includes("archive-wal.sh %p %f")));
  assert.ok(postgres.volumes.some((v) => v.target === "/wal-archive" && v.source.endsWith("cvg-wal-archive")));
  assert.ok(parsed.services.offsite.volumes.some((v) => v.target === "/wal-archive" && v.read_only === true));
  assert.ok(parsed.services.offsite.volumes.some((v) => v.target === "/config/rclone/rclone.conf" && v.read_only === true));
  assert.match(parsed.services.offsite.image, /^rclone\/rclone:\d+\.\d+\.\d+$/);
  assert.equal(parsed.services.offsite.healthcheck.test.at(-1), "/opt/backup/check-offsite.sh");
  assert.equal(parsed.services.migrate.environment.POSTGRES_BACKUP_PASSWORD, "value-for-config-check-0123456789abcdef");
  assert.equal(parsed.services.backup.environment.PGBACKUP_PASSWORD, "value-for-config-check-0123456789abcdef");

  const drill = config(["docker-compose.prod.yml", "docker-compose.pitr-drill.yml"]);
  assert.equal(drill.status, 0, drill.stderr);

  // On-prem overlay (PROD-307/308/514): MinIO + ClamAV + scanner, nothing published, bucket hardening before the app.
  const onprem = config(["docker-compose.prod.yml", "docker-compose.onprem.yml"]);
  assert.equal(onprem.status, 0, onprem.stderr);
  const stack = JSON.parse(onprem.stdout);
  for (const name of ["storage", "storage-init", "clamav", "scanner"]) {
    assert.ok(stack.services[name], `${name} service`);
    assert.equal(stack.services[name].ports, undefined, `${name} publishes no port`);
  }
  assert.equal(stack.services.storage.environment.MINIO_KMS_SECRET_KEY_FILE, "/run/secrets/minio-kms-key");
  assert.equal(stack.services.storage.environment.MINIO_KMS_AUTO_ENCRYPTION, "on");
  assert.equal(stack.services.storage.environment.MINIO_BROWSER, "off");
  assert.ok(stack.secrets["minio-kms-key"].file.endsWith("/minio-kms.key"));
  assert.equal(stack.services["storage-init"].environment.STORAGE_HARDEN, "true");
  assert.equal(stack.services["storage-init"].environment.STORAGE_NONCURRENT_VERSION_DAYS, "30");
  assert.equal(stack.services.app.environment.STORAGE_ENDPOINT, "http://storage:9000");
  assert.equal(stack.services.app.environment.MALWARE_SCANNER_ENDPOINT, "https://scanner:9443/scan");
  assert.equal(stack.services.app.environment.MALWARE_SCANNER_ALLOWED_HOSTS, "scanner");
  assert.equal(stack.services.app.environment.NODE_EXTRA_CA_CERTS, "/certs/ca.crt");
  assert.equal(stack.services.worker.environment.NODE_EXTRA_CA_CERTS, "/certs/ca.crt");
  assert.equal(stack.services.app.depends_on["storage-iam"].condition, "service_completed_successfully");
  assert.equal(stack.services["storage-iam"].depends_on["storage-init"].condition, "service_completed_successfully");
  assert.equal(stack.services.app.depends_on.scanner.condition, "service_healthy");
  assert.equal(stack.services.scanner.environment.CLAMD_HOST, "clamav");
  assert.equal(stack.services.scanner.read_only, true);
  assert.equal(stack.services.offsite.environment.OFFSITE_BUCKET_SOURCE, "minio:value-for-config-check-0123456789abcdef");
  assert.equal(stack.services.offsite.environment.RCLONE_CONFIG_MINIO_ENDPOINT, "http://storage:9000");
  // Least privilege (D-051): the root user only in storage, storage-init and storage-iam; app/worker and offsite use their own.
  assert.equal(stack.services.storage.environment.MINIO_ROOT_PASSWORD_FILE, "/run/secrets/storage_root_password");
  assert.equal(stack.services.storage.environment.MINIO_ROOT_PASSWORD, undefined);
  assert.equal(stack.services["storage-iam"].environment.STORAGE_ROOT_PASSWORD_FILE, "/run/secrets/storage_root_password");
  assert.equal(stack.services.app.environment.STORAGE_ACCESS_KEY, "value-for-config-check-0123456789abcdef", "the app user comes from the env file");
  assert.notEqual(stack.services.storage.environment.MINIO_ROOT_USER, stack.services.app.environment.STORAGE_ACCESS_KEY, "the app never runs as the MinIO root");
  assert.equal(stack.services.app.environment.STORAGE_SECRET_KEY_FILE, "/run/secrets/storage_secret_key");
  assert.equal(stack.services.app.environment.STORAGE_ROOT_PASSWORD_FILE, undefined);
  assert.equal(stack.services.offsite.environment.RCLONE_CONFIG_MINIO_ACCESS_KEY_ID, "cvg-offsite");
  assert.equal(stack.services.offsite.environment.RCLONE_CONFIG_MINIO_SECRET_ACCESS_KEY_FILE, "/run/secrets/offsite_storage_secret_key");
  assert.equal(stack.services.scanner.environment.MALWARE_SCANNER_API_KEY_FILE, "/run/secrets/malware_scanner_api_key");
  assert.match(stack.services.scanner.image, /^node:22-bookworm-slim@sha256:[0-9a-f]{64}$/);

  // Secrets overlay (PROD-302): every secret of the base file comes from /run/secrets; the env placeholders are not needed.
  const withSecrets = config(["docker-compose.prod.yml", "docker-compose.onprem.yml", "docker-compose.secrets.yml"]);
  assert.equal(withSecrets.status, 0, withSecrets.stderr);
  const secured = JSON.parse(withSecrets.stdout);
  for (const name of ["postgres_password", "postgres_migration_password", "postgres_runtime_password", "session_secret", "trust_proxy_shared_secret", "storage_root_password", "storage_secret_key", "offsite_storage_secret_key", "malware_scanner_api_key", "offsite_crypt_password", "offsite_crypt_salt"]) {
    assert.ok(secured.secrets[name]?.file?.startsWith(secretsDir), `secret ${name} comes from SECRETS_DIR`);
  }
  assert.equal(secured.services.app.environment.SESSION_SECRET_FILE, "/run/secrets/session_secret");
  // `config` re-escapes the literal `$` as `$$`; the container receives `${POSTGRES_RUNTIME_PASSWORD}`, expanded at process start.
  assert.equal(secured.services.app.environment.DATABASE_URL, "postgresql://cvg_runtime:$${POSTGRES_RUNTIME_PASSWORD}@postgres:5432/cvg_production", "the password is a placeholder expanded at process start, never interpolated by Compose");
  assert.equal(secured.services.migrate.environment.MIGRATION_DATABASE_URL, "postgresql://cvg_migrator:$${POSTGRES_MIGRATION_PASSWORD}@postgres:5432/cvg_production");
  assert.ok(!JSON.stringify(secured).includes("value-for-config-check-0123456789abcdef@"), "no password is interpolated into a connection string");
  assert.equal(secured.services.migrate.environment.POSTGRES_MIGRATION_PASSWORD_FILE, "/run/secrets/postgres_migration_password");
  assert.equal(secured.services.postgres.environment.POSTGRES_PASSWORD_FILE, "/run/secrets/postgres_password");
  assert.equal(secured.services.backup.environment.PGPASSWORD_FILE, "/run/secrets/postgres_runtime_password");
  assert.equal(secured.services.proxy.environment.TRUST_PROXY_SHARED_SECRET_FILE, "/run/secrets/trust_proxy_shared_secret");
  assert.ok(secured.services.proxy.command.join(" ").includes("TRUST_PROXY_SHARED_SECRET_FILE"), "the edge exports the secret from the file");
  assert.equal(secured.services.offsite.environment.OFFSITE_CRYPT_PASSWORD_FILE, "/run/secrets/offsite_crypt_password");
  assert.equal(secured.services.offsite.environment.OFFSITE_ALLOW_PLAINTEXT, "false");
  for (const service of ["backup", "offsite"]) {
    assert.ok(secured.services[service].volumes.some((v) => v.target === "/opt/backup/secrets-env.sh"), `${service} mounts the secrets helper`);
  }
  assert.ok(secured.services.offsite.volumes.some((v) => v.target === "/opt/backup/rclone-with-secrets.sh"), "manual rclone runs in offsite go through the helper");
  assert.equal(secured.services["storage-restore"], undefined, "the restore service only exists under --profile restore");
  const withRestore = spawnSync("docker", ["compose", "--profile", "restore", "-f", path.join(root, "docker-compose.prod.yml"), "-f", path.join(root, "docker-compose.onprem.yml"), "-f", path.join(root, "docker-compose.secrets.yml"), "--env-file", envFile, "config", "--format", "json"], { encoding: "utf8", env: { ...process.env } });
  assert.equal(withRestore.status, 0, withRestore.stderr);
  const restore = JSON.parse(withRestore.stdout).services["storage-restore"];
  assert.ok(restore.volumes.some((v) => v.target === "/opt/backup/secrets-env.sh"), "storage-restore mounts the secrets helper");
  assert.equal(restore.environment.RCLONE_CONFIG_MINIO_SECRET_ACCESS_KEY_FILE, "/run/secrets/storage_secret_key", "the restore writes with the app user");
  assert.equal(restore.ports, undefined);
  // PROD-309: the edge is the only published port, whatever the overlays.
  for (const [name, service] of Object.entries(secured.services)) {
    if (name === "proxy") continue;
    assert.equal(service.ports, undefined, `${name} publishes no port`);
  }
  assert.deepEqual(secured.services.proxy.ports.map((p) => p.published), ["80", "443"]);

  // Internal TLS (PROD-309): the edge serves the hospital's certificate instead of ACME.
  const internal = config(["docker-compose.prod.yml", "docker-compose.secrets.yml", "docker-compose.internal-tls.yml"]);
  assert.equal(internal.status, 0, internal.stderr);
  const edge = JSON.parse(internal.stdout).services.proxy;
  const caddyfile = edge.volumes.find((v) => v.target === "/etc/caddy/Caddyfile");
  assert.ok(caddyfile.source.endsWith("deploy/Caddyfile.internal-tls"), "the overlay replaces the Caddyfile mount");
  assert.ok(edge.volumes.some((v) => v.target === "/certs/web.crt" && v.read_only === true));
  assert.ok(edge.volumes.some((v) => v.target === "/certs/web.key" && v.read_only === true));
  rmSync(dir, { recursive: true, force: true });
});
