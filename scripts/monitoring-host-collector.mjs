// Privileged local timer only. Reads Docker status, existing backup artifacts and heartbeat; publishes counts/times,
// never config/environment values or clinical content. The exporter has NO Docker socket and cannot run this script.
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const services = ["app", "worker", "postgres", "backup", "offsite", "storage", "clamav", "scanner"];
const number = value => Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0;

export async function collectHostMetrics({ project, docker, now = Date.now() / 1000 }) {
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project)) throw new Error("CVG_MONITOR_PROJECT is required and must be a Compose project name");
  const lines = [];
  const metric = (name, value, labels = "") => lines.push(`${name}${labels} ${number(value)}`);
  let failures = 0;
  const ids = {};
  for (const service of services) {
    let running = 0, healthy = 0;
    try {
      const matching = docker(["ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`, "--filter", `label=com.docker.compose.service=${service}`]).trim().split(/\s+/).filter(Boolean);
      if (matching.length !== 1) throw new Error("missing or ambiguous service");
      ids[service] = matching[0];
      const state = JSON.parse(docker(["inspect", "--format", "{{json .State}}", ids[service]]));
      running = state.Running === true ? 1 : 0;
      healthy = running && state.Health?.Status === "healthy" ? 1 : 0;
    } catch { failures += 1; }
    metric("cvg_container_running", running, `{service="${service}"}`);
    metric("cvg_container_healthy", healthy, `{service="${service}"}`);
  }
  let dumpTimestamp = 0, baseTimestamp = 0, offsiteTimestamp = 0, offsiteOk = 0;
  try {
    const directory = docker(["volume", "inspect", "--format", "{{.Mountpoint}}", `${project}_cvg-backups`]).trim();
    if (!path.isAbsolute(directory)) throw new Error("backup volume is missing");
    for (const file of await readdir(directory)) {
      if (/^cvg-[0-9]+T[0-9]+Z\.dump$/.test(file)) {
        const info = await stat(path.join(directory, file));
        if (info.isFile() && info.size > 0) dumpTimestamp = Math.max(dumpTimestamp, info.mtimeMs / 1000);
      }
    }
    for (const stamp of await readdir(path.join(directory, "base"))) {
      if (!/^\d{8}T\d{6}Z$/.test(stamp)) continue;
      const info = await stat(path.join(directory, "base", stamp, "base.tar.gz"));
      if (info.isFile() && info.size > 0) baseTimestamp = Math.max(baseTimestamp, info.mtimeMs / 1000);
    }
    const status = JSON.parse(await readFile(path.join(directory, "offsite-status.json"), "utf8"));
    offsiteTimestamp = number(status.lastShippedEpoch);
    offsiteOk = status.lastResult === "ok" && offsiteTimestamp > 0 && offsiteTimestamp <= now ? 1 : 0;
  } catch { failures += 1; }
  metric("cvg_backup_dump_timestamp_seconds", dumpTimestamp <= now ? dumpTimestamp : 0);
  metric("cvg_backup_base_timestamp_seconds", baseTimestamp <= now ? baseTimestamp : 0);
  metric("cvg_offsite_success_timestamp_seconds", offsiteTimestamp <= now ? offsiteTimestamp : 0);
  metric("cvg_offsite_last_attempt_ok", offsiteOk);
  let heartbeatTimestamp = 0, heartbeatOk = 0;
  try {
    const heartbeat = JSON.parse(docker(["exec", ids.worker, "node", "-e", "process.stdout.write(require('fs').readFileSync(process.env.OUTBOX_HEARTBEAT_FILE || '/tmp/outbox-worker-heartbeat.json','utf8'))"]));
    heartbeatTimestamp = Date.parse(heartbeat.timestamp) / 1000;
    heartbeatOk = ["ok", "degraded"].includes(heartbeat.health) && Number.isFinite(heartbeatTimestamp) && heartbeatTimestamp <= now ? 1 : 0;
  } catch { failures += 1; }
  metric("cvg_worker_heartbeat_timestamp_seconds", heartbeatTimestamp <= now ? heartbeatTimestamp : 0);
  metric("cvg_worker_heartbeat_ok", heartbeatOk);
  let walPending = 0, walOldest = 0, walFailures = 0, walCheckOk = 0;
  try {
    // The container-local PostgreSQL socket is administrative and trusted (deploy/backup/pg_hba.conf). No password is
    // exported, logged or read. The SQL sees only archive metadata, never patient rows.
    const sql = "SELECT json_build_object('failed',failed_count,'pending',(SELECT count(*) FROM pg_ls_dir('pg_wal/archive_status') f WHERE f LIKE '%.ready'),'oldest',COALESCE((SELECT max(EXTRACT(EPOCH FROM now()-(pg_stat_file('pg_wal/archive_status/'||f)).modification)) FROM pg_ls_dir('pg_wal/archive_status') f WHERE f LIKE '%.ready'),0)) FROM pg_stat_archiver";
    const wal = JSON.parse(docker(["exec", ids.postgres, "sh", "-c", 'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atq -v ON_ERROR_STOP=1 -c "$1"', "collector", sql]));
    if (![wal.pending, wal.oldest, wal.failed].every(value => Number.isFinite(Number(value)) && Number(value) >= 0)) throw new Error("invalid WAL metadata");
    walPending = number(wal.pending); walOldest = number(wal.oldest); walFailures = number(wal.failed); walCheckOk = 1;
  } catch { failures += 1; }
  metric("cvg_postgres_wal_archive_pending_segments", walPending);
  metric("cvg_postgres_wal_archive_oldest_pending_seconds", walOldest);
  metric("cvg_postgres_wal_archive_failures_total", walFailures);
  metric("cvg_postgres_wal_archive_check_ok", walCheckOk);
  metric("cvg_host_collector_failures", failures);
  metric("cvg_host_collector_timestamp_seconds", now);
  return `${lines.join("\n")}\n`;
}

async function main() {
  const output = process.env.CVG_MONITOR_TEXTFILE_DIR;
  if (!output || !path.isAbsolute(output)) throw new Error("CVG_MONITOR_TEXTFILE_DIR must be an absolute directory");
  const docker = args => execFileSync(process.env.DOCKER ?? "docker", args, { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
  const metrics = await collectHostMetrics({ project: process.env.CVG_MONITOR_PROJECT, docker });
  await mkdir(output, { recursive: true, mode: 0o755 });
  const temp = path.join(output, `cvg.prom.${process.pid}.tmp`);
  await writeFile(temp, metrics, { mode: 0o644 });
  await rename(temp, path.join(output, "cvg.prom"));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => {
  console.error('{"event":"monitoring.collector_failed"}'); process.exitCode = 1;
});
