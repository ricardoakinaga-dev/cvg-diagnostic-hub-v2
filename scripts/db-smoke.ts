import { randomBytes } from "node:crypto";
import { PostgresStore } from "../src/server/store/postgres-store";
import { createDemoState } from "../src/server/store/fixtures";
import { createApplicationService } from "../src/server/application/service";
import { InProcessEventBus, processOutboxBatch } from "../src/server/operations/outbox";
import { loadFileSecrets } from "../src/server/security/file-secrets";
// PROD-302: secrets mounted as files (NAME_FILE) are read before anything touches process.env.
loadFileSecrets();

function databaseUrlForDestructiveSmoke(): string {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL é obrigatório para o smoke test.");
  if (process.env.NODE_ENV === "production") {
    throw new Error("O smoke test destrutivo de banco de dados é proibido em produção.");
  }
  if (process.env.ALLOW_DB_SMOKE_RESET !== "true") {
    throw new Error("Defina ALLOW_DB_SMOKE_RESET=true para autorizar explicitamente o reset do banco de smoke.");
  }

  const parsed = new URL(connectionString);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("DATABASE_URL deve usar o protocolo PostgreSQL.");
  }
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  if (!loopbackHosts.has(parsed.hostname)) {
    throw new Error("O smoke test destrutivo aceita somente um banco local em loopback.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!/^cvg_(?:smoke|test)(?:[a-z0-9_-]*)$/i.test(databaseName)) {
    throw new Error("O banco destrutivo deve ter nome dedicado iniciado por cvg_smoke ou cvg_test.");
  }
  return connectionString;
}

async function main(databaseUrl: string): Promise<void> {
  const smokePassword = randomBytes(32).toString("base64url");
  const fixture = createDemoState(smokePassword);
  const first = await PostgresStore.create(
    databaseUrl,
    fixture,
    { authorization: "ALLOW_DB_SMOKE_RESET" }
  );
  let requestId = "";
  try {
    await first.reset(fixture, { authorization: "ALLOW_DB_SMOKE_RESET" });
    const service = createApplicationService(first);
    const actor = first.getState().users.find((user) => user.email === "vet@cvg.local");
    if (!actor) throw new Error("Fixture actor ausente.");
    const request = await service.createRequest(actor, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-hemogram" }] }, { idempotencyKey: "db-smoke-request" });
    requestId = request.id;
  } finally {
    await first.close();
  }
  const second = await PostgresStore.create(databaseUrl);
  try {
    if (!second.getState().requests.some((request) => request.id === requestId)) throw new Error("Estado não persistiu após reabrir a conexão.");
    const audit = await second.readAuditEvents({ scope: { entities: [{ entityType: "DiagnosticRequest", entityId: requestId }] }, order: "asc", limit: 100 });
    if (!audit.items.some((event) => event.entityId === requestId)) throw new Error("Auditoria não foi projetada no PostgreSQL.");
    const bus = new InProcessEventBus();
    const summary = await processOutboxBatch(second, bus, { workerId: "db-smoke-worker", batchSize: 10, allowSyntheticDelivery: true });
    if (summary.processed < 1 || bus.read().length < 1) throw new Error("Outbox não foi processado após reabrir o PostgreSQL.");
    if ((await second.readState()).outbox.length !== 0) throw new Error("Histórico de entrega retornou ao snapshot PostgreSQL.");
    if (!(await second.readOutbox({ kind: "replay", limit: 100 })).some((message) => message.aggregateId === requestId && message.status === "PROCESSED")) {
      throw new Error("Outbox processado não persistiu na autoridade relacional.");
    }
    console.log("PostgreSQL smoke test passou: estado, lock transacional, auditoria e outbox persistem.");
  } finally {
    await second.close();
  }
}

void main(databaseUrlForDestructiveSmoke()).catch((error: unknown) => { console.error(error); process.exitCode = 1; });
