import { fileURLToPath } from "node:url";
import path from "node:path";
import { Pool } from "pg";
import {
  applyMigrations,
  readMigrationSet,
  RUNTIME_MIGRATION_VERSIONS,
  validateRuntimeMigrationSet
} from "../src/server/store/migrations";

interface RunMigrationsOptions {
  readonly connectionString: string;
  readonly migrationDirectory?: string;
  readonly logger?: { info(message: string): void };
  readonly cutoverAcknowledged?: boolean;
}

export async function runMigrations(options: RunMigrationsOptions): Promise<void> {
  const migrationDirectory = options.migrationDirectory ?? path.resolve(process.cwd(), "db/migrations");
  validateRuntimeMigrationSet(await readMigrationSet(migrationDirectory, RUNTIME_MIGRATION_VERSIONS));
  const pool = new Pool({ connectionString: options.connectionString });
  try {
    const client = await pool.connect();
    try {
      await applyMigrations(
        { query: (text, values) => client.query(text, values) },
        {
          migrationDirectory,
          logger: options.logger,
          cutoverAcknowledged: options.cutoverAcknowledged
        }
      );
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  // MIGRATION_DATABASE_URL carries the DDL role; DATABASE_URL is the runtime
  // role and is deliberately not enough on its own to change the schema.
  const connectionString = process.env.MIGRATION_DATABASE_URL?.trim() ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error("MIGRATION_DATABASE_URL (ou DATABASE_URL) é obrigatório para executar as migrations.");
  // A "Coordinated cutover" migration refuses to run while the previous app or worker is still
  // connected. MIGRATION_CUTOVER_ACKNOWLEDGED=true is for an operator who has confirmed the
  // remaining sessions are harmless (for example a read-only console); never set it in compose.
  await runMigrations({ connectionString, cutoverAcknowledged: process.env.MIGRATION_CUTOVER_ACKNOWLEDGED === "true" });
}

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (entrypoint === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
