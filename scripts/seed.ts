import { PostgresStore } from "../src/server/store/postgres-store";
import { createDemoState } from "../src/server/store/fixtures";
import { assertE2eLaboratoryPreparationAllowed, prepareE2eLaboratoryPolicy } from "../src/test/e2e-laboratory-policy";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL é obrigatório para executar o seed.");
const demoPassword = process.env.DEMO_PASSWORD;
if (!demoPassword) throw new Error("DEMO_PASSWORD é obrigatório para executar o seed sintético.");
if (process.env.NODE_ENV === "production") throw new Error("O seed sintético é proibido em produção.");
if (process.env.ALLOW_SYNTHETIC_SEED !== "true") throw new Error("ALLOW_SYNTHETIC_SEED=true é obrigatório para confirmar a substituição por dados sintéticos.");
// Refuse a CI-only laboratory approval target before any database connection or reset.
const prepareLaboratory = assertE2eLaboratoryPreparationAllowed(connectionString);
async function main(databaseUrl: string): Promise<void> {
  const demoState = createDemoState(demoPassword);
  const store = await PostgresStore.create(
    databaseUrl,
    demoState,
    { authorization: "ALLOW_SYNTHETIC_SEED" }
  );
  try {
    await store.reset(demoState, { authorization: "ALLOW_SYNTHETIC_SEED" });
    if (prepareLaboratory) {
      await prepareE2eLaboratoryPolicy(store, databaseUrl);
      console.log("Política laboratorial artificial preparada por comandos nativos para o ensaio E2E descartável; não representa homologação hospitalar.");
    }
    console.log("Seed sintético aplicado. Nenhum dado clínico real deve ser usado neste ambiente.");
  } finally {
    await store.close();
  }
}

void main(connectionString).catch((error: unknown) => { console.error(error); process.exitCode = 1; });
