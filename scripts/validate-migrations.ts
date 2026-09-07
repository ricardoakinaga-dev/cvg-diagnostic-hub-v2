import path from "node:path";
import {
  readMigrationSet,
  RUNTIME_MIGRATION_VERSIONS,
  validateRuntimeMigrationSet
} from "../src/server/store/migrations";

async function main(): Promise<void> {
  const migrationDirectory = path.resolve(process.cwd(), "db/migrations");
  const migrations = validateRuntimeMigrationSet(
    await readMigrationSet(migrationDirectory, RUNTIME_MIGRATION_VERSIONS)
  );

  console.log(JSON.stringify({
    migrationDirectory,
    versions: migrations.map((migration) => migration.version),
    checksums: Object.fromEntries(migrations.map((migration) => [migration.version, migration.checksum]))
  }, null, 2));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "MIGRATION_VALIDATION_FAILED");
  process.exitCode = 1;
});
