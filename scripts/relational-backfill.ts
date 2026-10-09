import { backfillFailureCode } from "../src/server/store/relational/clinical-core-backfill";
import { PostgresStore } from "../src/server/store/postgres-store";
import { loadFileSecrets } from "../src/server/security/file-secrets";
// PROD-302: secrets mounted as files (NAME_FILE) are read before anything touches process.env.
loadFileSecrets();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL é obrigatório para executar o backfill relacional.");
if (process.env.NODE_ENV === "production") throw new Error("O backfill relacional local é proibido em produção.");
if (process.env.ALLOW_RELATIONAL_BACKFILL !== "true") {
  throw new Error("ALLOW_RELATIONAL_BACKFILL=true é obrigatório para confirmar o backfill shadow sintético.");
}
if (process.env.RELATIONAL_BACKFILL_TARGET !== "RELATIONAL_SHADOW") {
  throw new Error("RELATIONAL_BACKFILL_TARGET=RELATIONAL_SHADOW é obrigatório; nenhum cutover é executado por este comando.");
}

async function main(connectionString: string): Promise<void> {
  const store = await PostgresStore.createWithRelationalClinicalCore(connectionString, {
    relationalReadiness: "BACKFILL"
  });
  try {
    const batchSize = process.env.RELATIONAL_BACKFILL_BATCH_SIZE === undefined
      ? undefined
      : Number(process.env.RELATIONAL_BACKFILL_BATCH_SIZE);
    const report = await store.backfillRelationalClinicalCore({
      runId: process.env.RELATIONAL_BACKFILL_RUN_ID,
      batchSize
    });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await store.close();
  }
}

void main(databaseUrl).catch((error: unknown) => {
  console.error(backfillFailureCode(error));
  process.exitCode = 1;
});
