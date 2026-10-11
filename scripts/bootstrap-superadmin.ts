import "./load-file-secrets";
import { PostgresStore } from "../src/server/store/postgres-store";
import { bootstrapSuperadmin } from "../src/server/store/superadmin-bootstrap";

async function main(): Promise<void> {
  if (process.env.ALLOW_SUPERADMIN_BOOTSTRAP !== "true") throw new Error("SUPERADMIN_BOOTSTRAP_REQUIRES_AUTHORIZATION");
  if (!process.env.DATABASE_URL) throw new Error("SUPERADMIN_BOOTSTRAP_DATABASE_REQUIRED");
  const store = await PostgresStore.create(process.env.DATABASE_URL);
  try {
    const result = await bootstrapSuperadmin(store, {
      email: process.env.BOOTSTRAP_SUPERADMIN_EMAIL ?? "",
      displayName: process.env.BOOTSTRAP_SUPERADMIN_NAME ?? "Superadmin",
      password: process.env.BOOTSTRAP_SUPERADMIN_PASSWORD ?? "",
      departmentCode: "IT",
      timezone: "America/Sao_Paulo"
    }, { authorization: "ALLOW_SUPERADMIN_BOOTSTRAP" });
    console.log(JSON.stringify({ event: "superadmin.bootstrap.completed", ...result }));
  } finally { await store.close(); }
}

void main().catch((error: unknown) => {
  const code = error instanceof Error && /^SUPERADMIN_[A-Z_]+$/.test(error.message) ? error.message : "SUPERADMIN_BOOTSTRAP_FAILED";
  console.error(JSON.stringify({ event: "superadmin.bootstrap.failed", code }));
  process.exitCode = 1;
});
