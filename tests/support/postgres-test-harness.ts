import { randomUUID } from "node:crypto";
import path from "node:path";
import { Pool } from "pg";
import type { StoreState } from "../../src/server/domain/models";
import {
  applyMigrations,
  readMigrationSet,
  RUNTIME_MIGRATION_VERSIONS,
  validateRuntimeMigrationSet
} from "../../src/server/store/migrations";
import { PostgresStore, type PostgresRelationalClinicalCoreReadiness } from "../../src/server/store/postgres-store";
import { RelationalClinicalCoreAdapter } from "../../src/server/store/relational/clinical-core-adapter";
import type { RelationalClinicalCoreRuntime } from "../../src/server/store/relational/clinical-core-contracts";

const DATABASE_NAME_PATTERN = /^cvg_test_[1-9][0-9]*_[a-f0-9]{32}$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export interface PostgresIntegrationEnvironment {
  ALLOW_POSTGRES_INTEGRATION_TESTS?: string;
  POSTGRES_TEST_ADMIN_URL?: string;
}

export interface DisposablePostgresDatabase {
  connectionString(): string;
  createStore(fallbackState?: StoreState): Promise<PostgresStore>;
  createRelationalStore(
    fallbackState: StoreState,
    adapter?: RelationalClinicalCoreRuntime,
    relationalReadiness?: PostgresRelationalClinicalCoreReadiness
  ): Promise<PostgresStore>;
  closeStore(store: PostgresStore): Promise<void>;
  query(text: string, values?: readonly unknown[]): Promise<{ rows: readonly unknown[]; rowCount: number | null }>;
}

interface ManagedDisposablePostgresDatabase extends DisposablePostgresDatabase {
  dispose(): Promise<void>;
}

export function validatePostgresIntegrationEnvironment(
  environment: PostgresIntegrationEnvironment
): URL {
  if (environment.ALLOW_POSTGRES_INTEGRATION_TESTS !== "true") {
    throw new Error("PostgreSQL integration tests require ALLOW_POSTGRES_INTEGRATION_TESTS=true.");
  }
  if (!environment.POSTGRES_TEST_ADMIN_URL) {
    throw new Error("POSTGRES_TEST_ADMIN_URL is required for PostgreSQL integration tests.");
  }

  let adminUrl: URL;
  try {
    adminUrl = new URL(environment.POSTGRES_TEST_ADMIN_URL);
  } catch {
    throw new Error("POSTGRES_TEST_ADMIN_URL must be a valid PostgreSQL URL.");
  }
  if (adminUrl.protocol !== "postgresql:" && adminUrl.protocol !== "postgres:") {
    throw new Error("POSTGRES_TEST_ADMIN_URL must use the postgres or postgresql protocol.");
  }
  if (!LOOPBACK_HOSTS.has(adminUrl.hostname.toLowerCase())) {
    throw new Error("POSTGRES_TEST_ADMIN_URL must target a loopback host.");
  }
  if (!adminUrl.pathname || adminUrl.pathname === "/") {
    throw new Error("POSTGRES_TEST_ADMIN_URL must name an existing administrative database.");
  }
  return adminUrl;
}

function createDatabaseName(): string {
  const databaseName = `cvg_test_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  if (!DATABASE_NAME_PATTERN.test(databaseName)) {
    throw new Error("Generated PostgreSQL integration-test database name is invalid.");
  }
  return databaseName;
}

function quotedDatabaseName(databaseName: string): string {
  if (!DATABASE_NAME_PATTERN.test(databaseName)) {
    throw new Error("Refusing to use an unvalidated PostgreSQL integration-test database name.");
  }
  return `"${databaseName}"`;
}

function databaseConnectionString(adminUrl: URL, databaseName: string): string {
  const databaseUrl = new URL(adminUrl.toString());
  databaseUrl.pathname = `/${databaseName}`;
  return databaseUrl.toString();
}

async function applyRealMigrations(connectionString: string): Promise<void> {
  const migrationDirectory = path.resolve(process.cwd(), "db/migrations");
  validateRuntimeMigrationSet(await readMigrationSet(migrationDirectory, RUNTIME_MIGRATION_VERSIONS));

  const migrationPool = new Pool({ connectionString, max: 1 });
  try {
    const client = await migrationPool.connect();
    try {
      await applyMigrations(
        { query: (text, values) => client.query(text, values) },
        { migrationDirectory, logger: { info: () => undefined } }
      );
    } finally {
      client.release();
    }
  } finally {
    await migrationPool.end();
  }
}

async function terminateAndDropDatabase(adminPool: Pool, databaseName: string): Promise<void> {
  await adminPool.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
    [databaseName]
  );
  await adminPool.query(`DROP DATABASE ${quotedDatabaseName(databaseName)}`);
}

async function createDisposablePostgresDatabase(adminUrl: URL): Promise<ManagedDisposablePostgresDatabase> {
  const databaseName = createDatabaseName();
  const adminPool = new Pool({ connectionString: adminUrl.toString(), max: 1 });
  const connectionString = databaseConnectionString(adminUrl, databaseName);
  const verificationPool = new Pool({ connectionString, max: 1 });
  // Disposable-cluster teardown intentionally terminates any last backend after
  // the pools have begun closing. Consume that expected driver-level event so
  // teardown cannot turn a passing integration run into an unhandled error.
  for (const pool of [adminPool, verificationPool]) pool.on("error", () => undefined);
  let databaseCreated = false;
  let openStores: readonly PostgresStore[] = [];

  try {
    await adminPool.query(`CREATE DATABASE ${quotedDatabaseName(databaseName)}`);
    databaseCreated = true;
    await applyRealMigrations(connectionString);
  } catch (setupError) {
    const cleanupErrors: unknown[] = [];
    if (databaseCreated) {
      try {
        await terminateAndDropDatabase(adminPool, databaseName);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    try {
      await adminPool.end();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([setupError, ...cleanupErrors], "PostgreSQL integration database setup and cleanup failed.");
    }
    throw setupError;
  }

  return {
    connectionString(): string {
      return connectionString;
    },

    async createStore(fallbackState?: StoreState): Promise<PostgresStore> {
      const store = fallbackState
        ? await PostgresStore.create(
            connectionString,
            fallbackState,
            { authorization: "ALLOW_POSTGRES_INTEGRATION_TESTS" }
          )
        : await PostgresStore.create(connectionString);
      openStores = [...openStores, store];
      return store;
    },

    async createRelationalStore(
      fallbackState: StoreState,
      adapter: RelationalClinicalCoreRuntime = new RelationalClinicalCoreAdapter(),
      relationalReadiness: PostgresRelationalClinicalCoreReadiness = "STRICT"
    ): Promise<PostgresStore> {
      const store = await PostgresStore.createWithRelationalClinicalCore(connectionString, {
        fallbackState,
        adapter,
        relationalReadiness,
        initialization: { authorization: "ALLOW_POSTGRES_INTEGRATION_TESTS" }
      });
      openStores = [...openStores, store];
      return store;
    },

    async closeStore(store: PostgresStore): Promise<void> {
      if (!openStores.includes(store)) return;
      await store.close();
      openStores = openStores.filter((candidate) => candidate !== store);
    },

    async query(text: string, values: readonly unknown[] = []) {
      const result = await verificationPool.query(text, [...values]);
      return { rows: result.rows as readonly unknown[], rowCount: result.rowCount };
    },

    async dispose(): Promise<void> {
      const storesToClose = [...openStores].reverse();
      openStores = [];
      const cleanupErrors: unknown[] = [];
      const closeResults = await Promise.allSettled(storesToClose.map((store) => store.close()));
      for (const result of closeResults) {
        if (result.status === "rejected") cleanupErrors.push(result.reason);
      }
      try {
        await verificationPool.end();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      try {
        await terminateAndDropDatabase(adminPool, databaseName);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      try {
        await adminPool.end();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, "PostgreSQL integration database cleanup failed.");
      }
    }
  };
}

export async function withDisposablePostgresDatabase<T>(
  operation: (database: DisposablePostgresDatabase) => Promise<T>
): Promise<T> {
  const adminUrl = validatePostgresIntegrationEnvironment({
    ALLOW_POSTGRES_INTEGRATION_TESTS: process.env.ALLOW_POSTGRES_INTEGRATION_TESTS,
    POSTGRES_TEST_ADMIN_URL: process.env.POSTGRES_TEST_ADMIN_URL
  });
  const database = await createDisposablePostgresDatabase(adminUrl);
  let operationResult: T | undefined;
  let operationError: unknown;
  try {
    operationResult = await operation(database);
  } catch (error) {
    operationError = error;
  }

  let cleanupError: unknown;
  try {
    await database.dispose();
  } catch (error) {
    cleanupError = error;
  }

  if (operationError && cleanupError) {
    throw new AggregateError([operationError, cleanupError], "PostgreSQL integration operation and cleanup failed.");
  }
  if (operationError) throw operationError;
  if (cleanupError) throw cleanupError;
  return operationResult as T;
}
