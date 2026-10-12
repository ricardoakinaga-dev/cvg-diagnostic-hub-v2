import { appendFileSync, readFileSync, readdirSync, readlinkSync, statfsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const read = (filename) => { try { return readFileSync(filename, "utf8"); } catch { return null; } };
const number = (value) => value !== undefined && /^\d+$/.test(value.trim()) ? Number(value) : null;
const counters = (value) => value === null ? null : Object.fromEntries(value.trim().split("\n").flatMap(line => {
  const [key, count] = line.trim().split(/\s+/);
  return /^[a-z_]+$/.test(key) && number(count) !== null ? [[key, number(count)]] : [];
}));

function processRecord(procRoot, pid) {
  const status = read(path.join(procRoot, String(pid), "status"));
  if (!status) return null;
  const fields = Object.fromEntries(status.trim().split("\n").map(line => {
    const colon = line.indexOf(":"); return [line.slice(0, colon), line.slice(colon + 1).trim()];
  }));
  const command = read(path.join(procRoot, String(pid), "cmdline")) ?? "";
  // Command lines are used only to classify a private harness process. Never emit
  // argv, environment, socket peers, URLs, credentials or application payloads.
  const category = /(?:chromium|chrome|headless_shell)/i.test(command)
    ? command.includes("--type=renderer") ? "CHROMIUM_RENDERER" : "CHROMIUM_OTHER"
    : /next(?:-server|\/dist\/| dev)/.test(command) ? "NEXT" : /(?:node|npm)/.test(command) ? "NODE" : "OTHER";
  const kb = (key) => number(fields[key]?.split(/\s+/)[0]);
  return { pid, parentPid: number(fields.PPid), state: fields.State?.split(/\s+/)[0] ?? null,
    category, rssKiB: kb("VmRSS"), peakRssKiB: kb("VmHWM"), threads: number(fields.Threads) };
}

function serverSockets(procRoot) {
  const result = new Map();
  for (const name of ["tcp", "tcp6"]) {
    for (const line of (read(path.join(procRoot, "net", name)) ?? "").split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/); const port = Number.parseInt(fields[1]?.split(":")[1], 16);
      if (fields[3] === "0A" && [3100, 3101, 3102].includes(port) && /^\d+$/.test(fields[9] ?? "")) result.set(fields[9], port);
    }
  }
  return result;
}

export function sampleRuntimeTelemetry({ procRoot = "/proc", cgroupRoot = "/sys/fs/cgroup", sharedMemoryRoot = "/dev/shm", rootPid = process.ppid, observedAt = new Date().toISOString() } = {}) {
  let entries = [];
  try { entries = readdirSync(procRoot).filter(value => /^\d+$/.test(value)).map(Number).slice(0, 4096); } catch { /* Missing proc is explicitly unknown. */ }
  const records = entries.map(pid => processRecord(procRoot, pid)).filter(Boolean);
  const descendants = new Set([rootPid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const record of records) if (descendants.has(record.parentPid) && !descendants.has(record.pid)) { descendants.add(record.pid); changed = true; }
  }
  const sockets = serverSockets(procRoot);
  const processes = records.filter(record => descendants.has(record.pid)).map(record => {
    const ports = new Set();
    try {
      for (const descriptor of readdirSync(path.join(procRoot, String(record.pid), "fd"))) {
        try { const inode = /^socket:\[(\d+)\]$/.exec(readlinkSync(path.join(procRoot, String(record.pid), "fd", descriptor)))?.[1]; if (sockets.has(inode)) ports.add(sockets.get(inode)); } catch { /* Process may exit during sampling. */ }
      }
    } catch { /* Descriptor access unavailable. */ }
    return { ...record, serverPorts: [...ports].sort() };
  }).sort((a, b) => a.pid - b.pid);
  const current = read(path.join(cgroupRoot, "memory.current"));
  const legacyCurrent = read(path.join(cgroupRoot, "memory", "memory.usage_in_bytes"));
  const maximum = read(path.join(cgroupRoot, "memory.max"));
  const cgroup = { source: current !== null ? "CGROUP_V2" : legacyCurrent !== null ? "CGROUP_V1" : "UNKNOWN",
    memoryCurrentBytes: number((current ?? legacyCurrent)?.trim()),
    memoryMaxBytes: maximum?.trim() === "max" ? "max" : number((maximum ?? read(path.join(cgroupRoot, "memory", "memory.limit_in_bytes")))?.trim()),
    memoryEvents: counters(read(path.join(cgroupRoot, "memory.events"))),
    memoryEventsLocal: counters(read(path.join(cgroupRoot, "memory.events.local"))),
    memoryFailCount: number(read(path.join(cgroupRoot, "memory", "memory.failcnt"))?.trim()),
    pidsCurrent: number(read(path.join(cgroupRoot, "pids.current"))?.trim()),
    pidsMax: read(path.join(cgroupRoot, "pids.max"))?.trim() === "max" ? "max" : number(read(path.join(cgroupRoot, "pids.max"))?.trim()),
    pidsEvents: counters(read(path.join(cgroupRoot, "pids.events"))), cpu: counters(read(path.join(cgroupRoot, "cpu.stat"))) };
  let sharedMemory = null;
  try { const stats = statfsSync(sharedMemoryRoot); sharedMemory = { capacityBytes: stats.bsize * stats.blocks, availableBytes: stats.bsize * stats.bavail }; } catch { /* Explicit null, never an invented zero. */ }
  return { schemaVersion: 1, type: "SAMPLE", observedAt, rootPid, cgroup, sharedMemory, processes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arguments_ = process.argv.slice(2);
  const output = arguments_[arguments_.indexOf("--output") + 1];
  const rootPid = Number(arguments_[arguments_.indexOf("--root-pid") + 1]);
  if (!arguments_.includes("--output") || !output || !arguments_.includes("--root-pid") || !Number.isInteger(rootPid) || rootPid <= 0) {
    process.stderr.write("Telemetry requires --output and a positive --root-pid.\n"); process.exit(2);
  }
  appendFileSync(output, `${JSON.stringify({ schemaVersion: 1, type: "START", observedAt: new Date().toISOString(), intervalMilliseconds: 2000, scope: "CONTAINER_HARNESS_DESCENDANTS", note: "Per-process RSS includes shared pages; do not treat its sum as unique memory. Missing counters remain null." })}\n`);
  const sample = () => { try { appendFileSync(output, `${JSON.stringify(sampleRuntimeTelemetry({ rootPid }))}\n`); } catch { process.stderr.write("Runtime telemetry sample unavailable.\n"); } };
  sample();
  const timer = setInterval(sample, 2000);
  const stop = () => { clearInterval(timer); sample(); appendFileSync(output, `${JSON.stringify({ schemaVersion: 1, type: "STOP", observedAt: new Date().toISOString(), reason: "GRACEFUL_SIGNAL" })}\n`); process.exit(0); };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
}
