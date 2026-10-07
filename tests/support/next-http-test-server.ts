import { ensureScratchTsconfig } from "../../scripts/scratch-tsconfig";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";

export interface NextHttpTestServerOptions {
  databaseUrl: string;
  realtimeChannel: string;
  applicationName: string;
  port?: number;
  mode?: "dev" | "start";
  distDir?: string;
  storageEndpoint?: string;
  realtime?: { connections: number; intervalMs: number; maxStreamMs: number; pollTimeoutMs?: number };
}

export interface NextHttpTestServer {
  readonly baseUrl: string;
  readonly port: number;
  readonly applicationName: string;
  stop(): Promise<void>;
}

export interface NextHttpTestBuild {
  readonly distDir: string;
  cleanup(): Promise<void>;
}

export const NEXT_HTTP_TEST_PROXY_HEADERS = Object.freeze({
  "x-cvg-proxy-secret": "cvg-http-test-proxy-secret-0123456789abcdef",
  "x-forwarded-for": "127.0.0.1"
});

const STARTUP_TIMEOUT_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const BUILD_TIMEOUT_MS = 120_000;
const MAX_CAPTURED_OUTPUT = 16_000;

export async function findAvailableHttpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close();
        reject(new Error("Could not determine an available HTTP port."));
        return;
      }
      probe.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

export async function startNextHttpTestServer(options: NextHttpTestServerOptions): Promise<NextHttpTestServer> {
  const port = options.port ?? await findAvailableHttpPort();
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), `cvg-http-storage-${port}-`));
  const mode = options.mode ?? "dev";
  const distDir = options.distDir ?? `.next-postgres-http-${process.pid}-${port}`;
  const nextBinary = path.resolve(process.cwd(), "node_modules/next/dist/bin/next");
  const databaseUrl = withApplicationName(options.databaseUrl, options.applicationName);
  const environment = nextHttpEnvironment({
    databaseUrl,
    mode,
    port,
    realtimeChannel: options.realtimeChannel,
    storageRoot,
    distDir,
    storageEndpoint: options.storageEndpoint,
    realtime: options.realtime
  });
  const command = mode === "start"
    ? [nextBinary, "start", "--hostname", "127.0.0.1"]
    : [nextBinary, "dev", "--turbopack", "--hostname", "127.0.0.1"];
  const child = spawn(process.execPath, command, {
    cwd: process.cwd(),
    env: environment,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"]
  });

  let exited = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let capturedOutput = "";
  const appendOutput = (chunk: Buffer | string) => {
    capturedOutput = `${capturedOutput}${chunk.toString()}`.slice(-MAX_CAPTURED_OUTPUT);
  };
  child.stdout?.on("data", appendOutput);
  child.stderr?.on("data", appendOutput);
  const exitPromise = new Promise<void>((resolve) => {
    const finishExit = (code: number | null, signal: NodeJS.Signals | null, detail?: string) => {
      if (exited) return;
      exited = true;
      exitCode = code;
      exitSignal = signal;
      if (detail) appendOutput(detail);
      resolve();
    };
    child.once("error", (error) => finishExit(null, null, `\nNext process error: ${error.message}`));
    child.once("exit", (code, signal) => finishExit(code, signal));
  });
  let stopped = false;

  const signalChild = (signal: NodeJS.Signals) => {
    if (exited) return;
    try {
      if (process.platform === "win32" || !child.pid) child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // The process may have exited between the liveness check and signal.
      }
    }
  };

  const waitForExit = async (timeoutMs: number): Promise<boolean> => {
    if (exited) return true;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), timeoutMs);
    });
    try {
      await Promise.race([exitPromise.then(() => true as const), deadline]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    return exited;
  };

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    signalChild("SIGTERM");
    if (!await waitForExit(SHUTDOWN_TIMEOUT_MS)) {
      signalChild("SIGKILL");
      await waitForExit(SHUTDOWN_TIMEOUT_MS);
    }
    await rm(path.resolve(process.cwd(), distDir), { recursive: true, force: true });
    await rm(storageRoot, { recursive: true, force: true });
  };

  try {
    await waitForLiveness(`http://127.0.0.1:${port}`, child, () => exited, () => capturedOutput);
  } catch (error) {
    await stop();
    const detail = capturedOutput ? `\nNext output:\n${capturedOutput}` : "";
    throw new Error(`Next HTTP test server failed to start on port ${port}.${detail}`, { cause: error });
  }

  return { baseUrl: `http://127.0.0.1:${port}`, port, applicationName: options.applicationName, stop };
}

export async function buildNextHttpTestBundle(options: Omit<NextHttpTestServerOptions, "mode" | "port" | "distDir"> & { distDir?: string }): Promise<NextHttpTestBuild> {
  const distDir = options.distDir ?? `.next-postgres-http-build-${process.pid}-${options.applicationName}`;
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), `cvg-http-build-storage-${process.pid}-`));
  const nextBinary = path.resolve(process.cwd(), "node_modules/next/dist/bin/next");
  const environment = nextHttpEnvironment({
    databaseUrl: withApplicationName(options.databaseUrl, options.applicationName),
    mode: "start",
    port: 0,
    realtimeChannel: options.realtimeChannel,
    storageRoot,
    distDir,
    storageEndpoint: options.storageEndpoint,
    realtime: options.realtime
  });
  const child = spawn(process.execPath, [nextBinary, "build"], {
    cwd: process.cwd(),
    env: environment,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"]
  });
  let capturedOutput = "";
  const appendOutput = (chunk: Buffer | string) => {
    capturedOutput = `${capturedOutput}${chunk.toString()}`.slice(-MAX_CAPTURED_OUTPUT);
  };
  child.stdout?.on("data", appendOutput);
  child.stderr?.on("data", appendOutput);
  const result = await waitForChild(child, BUILD_TIMEOUT_MS, appendOutput);
  if (!result.exited || result.code !== 0) {
    await terminateChild(child);
    await removeNextHttpArtifacts(distDir, storageRoot);
    throw new Error(`Next production build failed for ${distDir} (code ${String(result.code)}, signal ${String(result.signal)}).${capturedOutput ? `\nNext output:\n${capturedOutput}` : ""}`);
  }
  return {
    distDir,
    cleanup: () => removeNextHttpArtifacts(distDir, storageRoot)
  };
}

function withApplicationName(databaseUrl: string, applicationName: string): string {
  const parsed = new URL(databaseUrl);
  parsed.searchParams.set("application_name", applicationName);
  return parsed.toString();
}

function nextHttpEnvironment(options: {
  databaseUrl: string;
  mode: "dev" | "start";
  port: number;
  realtimeChannel: string;
  storageRoot: string;
  distDir: string;
  storageEndpoint?: string;
  realtime?: NextHttpTestServerOptions["realtime"];
}): NodeJS.ProcessEnv {
  const productionStorage = options.mode === "start";
  if (productionStorage && !options.storageEndpoint) {
    throw new Error("A production-like Next HTTP test process requires a storageEndpoint health probe.");
  }
  return {
    ...process.env,
    NODE_ENV: options.mode === "start" ? "production" : "development",
    NEXT_TELEMETRY_DISABLED: "1",
    PORT: String(options.port),
    NEXT_DIST_DIR: options.distDir,
    NEXT_TSCONFIG_PATH: ensureScratchTsconfig(),
    APP_DATA_MODE: "postgres",
    DATABASE_URL: options.databaseUrl,
    DB_POOL_MAX: "4",
    RATE_LIMIT_MODE: "postgres",
    RATE_LIMIT_DB_POOL_MAX: "2",
    LOGIN_RATE_LIMIT: "100",
    REALTIME_NOTIFICATION_ADAPTER: "postgres-listen",
    REALTIME_NOTIFICATION_CHANNEL: options.realtimeChannel,
    REALTIME_LISTEN_POOL_MAX: "2",
    REALTIME_STREAM_INTERVAL_MS: String(options.realtime?.intervalMs ?? 60000),
    REALTIME_POLL_TIMEOUT_MS: String(options.realtime?.pollTimeoutMs ?? 5000),
    REALTIME_STREAM_MAX_MS: String(options.realtime?.maxStreamMs ?? 60000),
    REALTIME_MAX_CONNECTIONS: String(options.realtime?.connections ?? 10),
    STORAGE_MODE: productionStorage ? "s3" : "local",
    STORAGE_ROOT: options.storageRoot,
    ...(productionStorage ? {
      STORAGE_ENDPOINT: options.storageEndpoint,
      STORAGE_REGION: "us-east-1",
      STORAGE_BUCKET: "cvg-http-test",
      STORAGE_ACCESS_KEY: "cvg-http-test-access",
      STORAGE_SECRET_KEY: "cvg-http-test-secret",
      STORAGE_FORCE_PATH_STYLE: "true",
      STORAGE_SCAN_MODE: "external",
      MALWARE_SCANNER_ENDPOINT: "https://scanner.example.test/scan",
      MALWARE_SCANNER_API_KEY: "cvg-http-test-scanner-key",
      MALWARE_SCANNER_ALLOWED_HOSTS: "scanner.example.test"
    } : {
      STORAGE_SCAN_MODE: "local"
    }),
    SESSION_SECRET: "cvg-http-test-session-secret-012345678901234567890123",
    OUTBOX_INLINE_LOCAL: "false",
    TRUST_PROXY: "true",
    TRUST_PROXY_SHARED_SECRET: NEXT_HTTP_TEST_PROXY_HEADERS["x-cvg-proxy-secret"]
  };
}

async function waitForChild(
  child: ChildProcess,
  timeoutMs: number,
  appendOutput: (chunk: Buffer | string) => void
): Promise<{ exited: boolean; code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) return { exited: true, code: child.exitCode, signal: child.signalCode };
  let exited = false;
  let code: number | null = null;
  let signal: NodeJS.Signals | null = null;
  const exitPromise = new Promise<void>((resolve) => {
    const finish = (nextCode: number | null, nextSignal: NodeJS.Signals | null, error?: Error) => {
      if (exited) return;
      exited = true;
      code = nextCode;
      signal = nextSignal;
      if (error) appendOutput(`\nNext process error: ${error.message}`);
      resolve();
    };
    child.once("error", (error) => finish(null, null, error));
    child.once("exit", (nextCode, nextSignal) => finish(nextCode, nextSignal));
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  await Promise.race([exitPromise, timeout]);
  if (timer) clearTimeout(timer);
  return { exited, code, signal };
}

export async function terminateChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const signal = (value: NodeJS.Signals) => {
    try {
      if (process.platform === "win32" || !child.pid) child.kill(value);
      else process.kill(-child.pid, value);
    } catch { child.kill(value); }
  };
  signal("SIGTERM");
  const terminated = await waitForChild(child, SHUTDOWN_TIMEOUT_MS, () => undefined);
  if (!terminated.exited && child.exitCode === null && child.signalCode === null) {
    signal("SIGKILL");
    const killed = await waitForChild(child, SHUTDOWN_TIMEOUT_MS, () => undefined);
    if (!killed.exited && child.exitCode === null && child.signalCode === null) throw new Error("Next build process did not exit during cleanup.");
  }
}

async function removeNextHttpArtifacts(distDir: string, storageRoot: string): Promise<void> {
  await rm(path.resolve(process.cwd(), distDir), { recursive: true, force: true });
  await rm(storageRoot, { recursive: true, force: true });
}

async function waitForLiveness(
  baseUrl: string,
  child: ChildProcess,
  hasExited: () => boolean,
  output: () => string
): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (hasExited()) throw new Error(`Next exited before liveness was ready. ${output()}`);
    try {
      const response = await fetch(`${baseUrl}/api/v1/livez`, { headers: NEXT_HTTP_TEST_PROXY_HEADERS, signal: AbortSignal.timeout(1_000) });
      if (response.status === 200) return;
      lastError = new Error(`liveness returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for Next liveness: ${String(lastError ?? "unknown error")}`);
}
