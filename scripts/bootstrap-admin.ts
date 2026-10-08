import { bootstrapProductionDatabase } from "../src/server/store/production-bootstrap";

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL é obrigatório para o bootstrap.");
  const { adminId, resetUrl, expiresAt } = await bootstrapProductionDatabase(connectionString, {
    email: process.env.BOOTSTRAP_ADMIN_EMAIL ?? "",
    displayName: process.env.BOOTSTRAP_ADMIN_NAME ?? "Administração",
    password: process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "",
    departmentCode: process.env.BOOTSTRAP_ADMIN_DEPARTMENT,
    timezone: process.env.BOOTSTRAP_ADMIN_TIMEZONE
  });
  if (resetUrl) {
    // The link is the only way in; it is printed once, expires and works a single time.
    console.log(JSON.stringify({ event: "bootstrap.completed", adminId, resetUrl, expiresAt }));
    console.log("Abra o link para definir a senha do administrador antes que ele expire; ele funciona uma única vez.");
  } else {
    console.log(JSON.stringify({ event: "bootstrap.completed", adminId }));
    console.log("Remova BOOTSTRAP_ADMIN_PASSWORD do ambiente e do secret store após o primeiro login.");
  }
}

void main().catch((error: unknown) => {
  console.error(JSON.stringify({ event: "bootstrap.failed", message: error instanceof Error ? error.message : "BOOTSTRAP_FAILED" }));
  process.exitCode = 1;
});
