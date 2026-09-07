import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createDemoState } from "../../src/server/store/fixtures";
import { withDisposablePostgresDatabase, type DisposablePostgresDatabase } from "../support/postgres-test-harness";
import {
  buildNextHttpTestBundle,
  findAvailableHttpPort,
  startNextHttpTestServer,
  type NextHttpTestBuild,
  type NextHttpTestServer
} from "../support/next-http-test-server";

const TEST_PASSWORD = "postgres-http-integration-password";
const STARTUP_TIMEOUT_MS = 45_000;
const LISTENER_TIMEOUT_MS = 10_000;
const REALTIME_WAKEUP_TIMEOUT_MS = 5_000;

interface ApiEnvelope<T> {
  data: T;
  error?: { code?: string; message?: string };
}

interface SessionCookies {
  cookie: string;
  csrfToken: string;
}

class SseFrameReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffered = "";

  constructor(response: Response) {
    if (!response.body) throw new Error("The realtime HTTP response did not expose a body.");
    this.reader = response.body.getReader();
  }

  async nextFrame(timeoutMs: number): Promise<string> {
    while (true) {
      const frameEnd = this.buffered.indexOf("\n\n");
      if (frameEnd >= 0) {
        const frame = this.buffered.slice(0, frameEnd + 2);
        this.buffered = this.buffered.slice(frameEnd + 2);
        return frame;
      }
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out waiting for an SSE frame after ${timeoutMs}ms.`)), timeoutMs);
      });
      try {
        const result = await Promise.race([this.reader.read(), timedOut]);
        if (result.done) throw new Error("The realtime SSE stream ended before the expected frame.");
        this.buffered += this.decoder.decode(result.value, { stream: true });
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }
  }

  async cancel(): Promise<void> {
    await this.reader.cancel().catch(() => undefined);
  }

  async waitForEnd(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => resolve(undefined), remaining);
      });
      try {
        const result = await Promise.race([this.reader.read(), timedOut]);
        if (!result) {
          await this.cancel();
          return false;
        }
        if (result.done) return true;
        this.buffered += this.decoder.decode(result.value, { stream: true });
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }
    await this.cancel();
    return false;
  }
}

describe("HTTP multi-instance PostgreSQL integration", () => {
  it("propagates a session and a durable mutation from instance A to an SSE stream on instance B", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const seed = await database.createStore(createDemoState(TEST_PASSWORD));
      await database.closeStore(seed);

      const realtimeChannel = `cvg_http_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
      const applicationNameA = `cvg-http-a-${process.pid}`;
      const applicationNameB = `cvg-http-b-${process.pid}`;
      const [portA, portB] = await Promise.all([findAvailableHttpPort(), findAvailableHttpPort()]);
      expect(portA).not.toBe(portB);

      let instanceA: NextHttpTestServer | undefined;
      let instanceB: NextHttpTestServer | undefined;
      let publisherPool: Pool | undefined;
      let sseController: AbortController | undefined;
      let sseReader: SseFrameReader | undefined;
      try {
        [instanceA, instanceB] = await Promise.all([
          startNextHttpTestServer({ databaseUrl: database.connectionString(), realtimeChannel, applicationName: applicationNameA, port: portA }),
          startNextHttpTestServer({ databaseUrl: database.connectionString(), realtimeChannel, applicationName: applicationNameB, port: portB })
        ]);
        await Promise.all([waitForReadiness(instanceA), waitForReadiness(instanceB)]);

        const loginResponse = await fetch(`${instanceA.baseUrl}/api/v1/session/login`, {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ email: "vet@cvg.local", password: TEST_PASSWORD })
        });
        expect(loginResponse.status).toBe(200);
        const loginBody = await readJson<{ user: { email: string } }>(loginResponse);
        expect(loginBody.data.user.email).toBe("vet@cvg.local");
        const cookies = sessionCookiesFrom(loginResponse);

        const crossInstanceSession = await requestJson<{ user: { email: string } }>(instanceB, "/api/v1/session/me", {
          headers: { accept: "application/json", cookie: cookies.cookie }
        });
        expect(crossInstanceSession.data.user.email).toBe("vet@cvg.local");

        sseController = new AbortController();
        const realtimeResponse = await fetch(`${instanceB.baseUrl}/api/v1/realtime/events`, {
          headers: { accept: "text/event-stream", cookie: cookies.cookie },
          signal: sseController.signal
        });
        expect(realtimeResponse.status).toBe(200);
        expect(realtimeResponse.headers.get("content-type")).toContain("text/event-stream");
        sseReader = new SseFrameReader(realtimeResponse);
        await readUntil(sseReader, (frame) => frame.includes(": heartbeat"), REALTIME_WAKEUP_TIMEOUT_MS);
        await waitForPostgresListener(database, applicationNameB, realtimeChannel);

        publisherPool = new Pool({
          connectionString: database.connectionString(),
          application_name: `cvg-http-publisher-${process.pid}`,
          max: 1
        });
        publisherPool.on("error", () => undefined);
        await publisherPool.query("SELECT pg_notify($1, $2)", [realtimeChannel, "probe"]);
        const probeStartedAt = Date.now();
        const probeFrame = await sseReader.nextFrame(REALTIME_WAKEUP_TIMEOUT_MS);
        expect(Date.now() - probeStartedAt).toBeLessThan(REALTIME_WAKEUP_TIMEOUT_MS);
        expect(probeFrame).toContain(": heartbeat");

        const idempotencyKey = `http-multi-instance-${randomUUID()}`;
        const created = await requestJson<{ id: string; requestCode: string }>(instanceA, "/api/v1/diagnostic-requests", {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            cookie: cookies.cookie,
            "x-csrf-token": cookies.csrfToken,
            "idempotency-key": idempotencyKey
          },
          body: JSON.stringify({
            patientId: "patient-thor",
            encounterId: "encounter-thor",
            priority: "ROUTINE",
            items: [{ serviceId: "service-hemogram" }]
          })
        });
        expect(created.data.id).toMatch(/^request-/);

        const eventFrame = await readUntil(sseReader, (frame) => frame.includes("event: diagnostic.updated"), REALTIME_WAKEUP_TIMEOUT_MS);
        expect(eventFrame).toContain(`entityId`);
        expect(eventFrame).toContain(created.data.id);
        expect(eventFrame).not.toContain("patient-thor");
        expect(eventFrame).not.toContain("Hemograma");
        const eventData = JSON.parse(eventFrame.split("data: ", 2)[1]?.trim() ?? "{}") as { eventId?: string; entityType?: string; entityId?: string };
        expect(eventData).toMatchObject({ entityType: "DiagnosticRequest", entityId: created.data.id });
        expect(eventData.eventId).toEqual(expect.any(String));

        const durableReadOnB = await requestJson<{ id: string; requestCode: string }>(instanceB, `/api/v1/diagnostic-requests/${created.data.id}`, {
          headers: { accept: "application/json", cookie: cookies.cookie }
        });
        expect(durableReadOnB.data).toMatchObject({ id: created.data.id, requestCode: created.data.requestCode });
      } finally {
        sseController?.abort();
        await sseReader?.cancel();
        await publisherPool?.end();
        await Promise.all([instanceB?.stop(), instanceA?.stop()]);
      }
    });
  }, STARTUP_TIMEOUT_MS + 60_000);

  it("replays a durable event after reconnecting a next start instance with Last-Event-ID", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const seed = await database.createStore(createDemoState(TEST_PASSWORD));
      await database.closeStore(seed);

      const realtimeChannel = `cvg_http_start_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
      const applicationNameA = `cvg-http-start-a-${process.pid}`;
      const applicationNameB = `cvg-http-start-b-${process.pid}`;
      const [portA, portB] = await Promise.all([findAvailableHttpPort(), findAvailableHttpPort()]);
      expect(portA).not.toBe(portB);
      const storageHealthServer = await startStorageHealthServer();

      let buildA: NextHttpTestBuild | undefined;
      let buildB: NextHttpTestBuild | undefined;
      let instanceA: NextHttpTestServer | undefined;
      let instanceB: NextHttpTestServer | undefined;
      let firstController: AbortController | undefined;
      let firstReader: SseFrameReader | undefined;
      let secondController: AbortController | undefined;
      let secondReader: SseFrameReader | undefined;
      let revokedController: AbortController | undefined;
      let revokedReader: SseFrameReader | undefined;
      try {
        buildA = await buildNextHttpTestBundle({ databaseUrl: database.connectionString(), realtimeChannel, applicationName: applicationNameA, storageEndpoint: storageHealthServer.endpoint });
        buildB = await buildNextHttpTestBundle({ databaseUrl: database.connectionString(), realtimeChannel, applicationName: applicationNameB, storageEndpoint: storageHealthServer.endpoint });
        [instanceA, instanceB] = await Promise.all([
          startNextHttpTestServer({ databaseUrl: database.connectionString(), realtimeChannel, applicationName: applicationNameA, port: portA, mode: "start", distDir: buildA.distDir, storageEndpoint: storageHealthServer.endpoint }),
          startNextHttpTestServer({ databaseUrl: database.connectionString(), realtimeChannel, applicationName: applicationNameB, port: portB, mode: "start", distDir: buildB.distDir, storageEndpoint: storageHealthServer.endpoint })
        ]);
        await Promise.all([waitForReadiness(instanceA), waitForReadiness(instanceB)]);

        const loginResponse = await fetch(`${instanceA.baseUrl}/api/v1/session/login`, {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ email: "vet@cvg.local", password: TEST_PASSWORD })
        });
        expect(loginResponse.status).toBe(200);
        const loginBody = await readJson<{ user: { email: string } }>(loginResponse);
        expect(loginBody.data.user.email).toBe("vet@cvg.local");
        const cookies = sessionCookiesFrom(loginResponse);

        const crossInstanceSession = await requestJson<{ user: { email: string } }>(instanceB, "/api/v1/session/me", {
          headers: { accept: "application/json", cookie: cookies.cookie }
        });
        expect(crossInstanceSession.data.user.email).toBe("vet@cvg.local");

        firstController = new AbortController();
        const firstResponse = await fetch(`${instanceB.baseUrl}/api/v1/realtime/events`, {
          headers: { accept: "text/event-stream", cookie: cookies.cookie },
          signal: firstController.signal
        });
        expect(firstResponse.status).toBe(200);
        firstReader = new SseFrameReader(firstResponse);
        await readUntil(firstReader, (frame) => frame.includes(": heartbeat"), REALTIME_WAKEUP_TIMEOUT_MS);
        await waitForPostgresListener(database, applicationNameB, realtimeChannel);

        const firstCreated = await requestJson<{ id: string; requestCode: string }>(instanceA, "/api/v1/diagnostic-requests", {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            cookie: cookies.cookie,
            "x-csrf-token": cookies.csrfToken,
            "idempotency-key": `http-next-start-first-${randomUUID()}`
          },
          body: JSON.stringify({
            patientId: "patient-thor",
            encounterId: "encounter-thor",
            priority: "ROUTINE",
            items: [{ serviceId: "service-hemogram" }]
          })
        });
        const firstEventFrame = await readUntil(firstReader, (frame) => frame.includes("event: diagnostic.updated"), REALTIME_WAKEUP_TIMEOUT_MS);
        const firstEvent = eventDataFromFrame(firstEventFrame);
        expect(firstEvent).toMatchObject({ entityType: "DiagnosticRequest", entityId: firstCreated.data.id });
        expect(firstEvent.eventId).toEqual(expect.any(String));

        firstController.abort();
        await firstReader.cancel();
        firstController = undefined;
        firstReader = undefined;

        const secondCreated = await requestJson<{ id: string; requestCode: string }>(instanceA, "/api/v1/diagnostic-requests", {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            cookie: cookies.cookie,
            "x-csrf-token": cookies.csrfToken,
            "x-duplicate-override": "true",
            "idempotency-key": `http-next-start-second-${randomUUID()}`
          },
          body: JSON.stringify({
            patientId: "patient-thor",
            encounterId: "encounter-thor",
            priority: "ROUTINE",
            overrideReason: "Repetir coleta para validar o replay durável do ensaio de integração.",
            items: [{ serviceId: "service-hemogram" }]
          })
        });

        secondController = new AbortController();
        const secondResponse = await fetch(`${instanceB.baseUrl}/api/v1/realtime/events`, {
          headers: {
            accept: "text/event-stream",
            cookie: cookies.cookie,
            "last-event-id": firstEvent.eventId
          },
          signal: secondController.signal
        });
        expect(secondResponse.status).toBe(200);
        secondReader = new SseFrameReader(secondResponse);
        const replayFrame = await readUntil(secondReader, (frame) => frame.includes("event: diagnostic.updated"), REALTIME_WAKEUP_TIMEOUT_MS);
        const replayedEvent = eventDataFromFrame(replayFrame);
        expect(replayedEvent).toMatchObject({ entityType: "DiagnosticRequest", entityId: secondCreated.data.id });
        expect(replayedEvent.entityId).not.toBe(firstCreated.data.id);
        expect(replayFrame).not.toContain(firstCreated.data.id);

        const durableReadOnB = await requestJson<{ id: string; requestCode: string }>(instanceB, `/api/v1/diagnostic-requests/${secondCreated.data.id}`, {
          headers: { accept: "application/json", cookie: cookies.cookie }
        });
        expect(durableReadOnB.data).toMatchObject({ id: secondCreated.data.id, requestCode: secondCreated.data.requestCode });

        revokedController = new AbortController();
        const revokedResponse = await fetch(`${instanceB.baseUrl}/api/v1/realtime/events`, {
          headers: { accept: "text/event-stream", cookie: cookies.cookie, "last-event-id": replayedEvent.eventId },
          signal: revokedController.signal
        });
        expect(revokedResponse.status).toBe(200);
        revokedReader = new SseFrameReader(revokedResponse);
        await readUntil(revokedReader, (frame) => frame.includes(": heartbeat"), REALTIME_WAKEUP_TIMEOUT_MS);
        await waitForPostgresListener(database, applicationNameB, realtimeChannel);

        const logoutResponse = await fetch(`${instanceA.baseUrl}/api/v1/session/logout`, {
          method: "POST",
          headers: { accept: "application/json", cookie: cookies.cookie, "x-csrf-token": cookies.csrfToken }
        });
        expect(logoutResponse.status).toBe(200);
        await readJson<{ loggedOut: boolean }>(logoutResponse);
        expect(await revokedReader.waitForEnd(REALTIME_WAKEUP_TIMEOUT_MS)).toBe(true);
      } finally {
        firstController?.abort();
        secondController?.abort();
        revokedController?.abort();
        await firstReader?.cancel();
        await secondReader?.cancel();
        await revokedReader?.cancel();
        await Promise.all([instanceB?.stop(), instanceA?.stop()]);
        await Promise.all([buildB?.cleanup(), buildA?.cleanup()]);
        await storageHealthServer.close();
      }
    });
  }, STARTUP_TIMEOUT_MS + 180_000);
});

async function waitForReadiness(server: NextHttpTestServer): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastStatus = "unknown";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${server.baseUrl}/api/v1/readyz`, { signal: AbortSignal.timeout(2_000) });
      lastStatus = String(response.status);
      if (response.status === 200) {
        const body = await readJson<{ status: string; dataMode: string }>(response);
        if (body.data.status !== "ready" || body.data.dataMode !== "postgres") throw new Error("Unexpected PostgreSQL readiness payload.");
        return;
      }
    } catch {
      // The development server may still be compiling the route or opening its pool.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${server.baseUrl} readiness; last status ${lastStatus}.`);
}

async function waitForPostgresListener(database: DisposablePostgresDatabase, applicationName: string, channel: string): Promise<void> {
  const deadline = Date.now() + LISTENER_TIMEOUT_MS;
  let lastCount = 0;
  while (Date.now() < deadline) {
    const result = await database.query(
      `SELECT count(*)::int AS count
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND application_name = $1
          AND query LIKE 'LISTEN %'
          AND query LIKE $2`,
      [applicationName, `%${channel}%`]
    );
    lastCount = Number((result.rows[0] as { count?: unknown } | undefined)?.count ?? 0);
    if (lastCount >= 1) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`The B instance did not expose a PostgreSQL LISTEN session for ${channel}; observed ${lastCount}.`);
}

async function readUntil(reader: SseFrameReader, predicate: (frame: string) => boolean, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = await reader.nextFrame(Math.max(1, deadline - Date.now()));
    if (predicate(frame)) return frame;
  }
  throw new Error(`Timed out waiting for the expected SSE frame after ${timeoutMs}ms.`);
}

async function readJson<T>(response: Response): Promise<ApiEnvelope<T>> {
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (error) {
    throw new Error(`Expected JSON response, received: ${text.slice(0, 500)}`, { cause: error });
  }
  if (!body || typeof body !== "object" || !("data" in body)) throw new Error(`Malformed API envelope: ${text.slice(0, 500)}`);
  return body as ApiEnvelope<T>;
}

async function requestJson<T>(server: NextHttpTestServer, path: string, init: RequestInit): Promise<ApiEnvelope<T>> {
  const response = await fetch(`${server.baseUrl}${path}`, init);
  const body = await readJson<T>(response);
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} returned HTTP ${response.status}: ${JSON.stringify(body.error ?? body)}`);
  return body;
}

function sessionCookiesFrom(response: Response): SessionCookies {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const raw = headers.getSetCookie?.().join(",") ?? response.headers.get("set-cookie") ?? "";
  const read = (name: string): string => {
    const match = raw.match(new RegExp(`${name}=([^;,\\s]+)`));
    if (!match?.[1]) throw new Error(`Login did not set ${name}; received: ${raw}`);
    return match[1];
  };
  const session = read("cvg_session");
  const csrfToken = read("cvg_csrf");
  return { cookie: `cvg_session=${session}; cvg_csrf=${csrfToken}`, csrfToken };
}

function eventDataFromFrame(frame: string): { eventId: string; entityType: string; entityId: string } {
  const payload = JSON.parse(frame.split("data: ", 2)[1]?.trim() ?? "{}") as Partial<{ eventId: string; entityType: string; entityId: string }>;
  if (!payload.eventId || !payload.entityType || !payload.entityId) throw new Error(`Malformed realtime event frame: ${frame}`);
  return { eventId: payload.eventId, entityType: payload.entityType, entityId: payload.entityId };
}

async function startStorageHealthServer(): Promise<{ endpoint: string; close(): Promise<void> }> {
  const server: HttpServer = createHttpServer((_request, response) => {
    response.statusCode = 200;
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeHttpServer(server);
    throw new Error("Could not determine the object-storage health server port.");
  }
  return { endpoint: `http://127.0.0.1:${address.port}`, close: () => closeHttpServer(server) };
}

async function closeHttpServer(server: HttpServer): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
