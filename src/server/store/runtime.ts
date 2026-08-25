import { MemoryStore } from "./memory-store";
import { createDemoState } from "./fixtures";
import type { StateStore } from "../domain/models";
import { PostgresStore } from "./postgres-store";
import { createFileStoreFromEnv, type FileStore } from "../storage/file-store";
import { createMalwareScannerFromEnv } from "../storage/malware-scanner";
import { assertRateLimitConfiguration } from "../security/rate-limit";

declare global {
  var __cvgDiagnosticsStore: StateStore | undefined;
  var __cvgDiagnosticsStorePromise: Promise<StateStore> | undefined;
  var __cvgDiagnosticsFileStore: FileStore | undefined;
}

type RuntimeDataMode = "memory" | "postgres";

function runtimeDataMode(): RuntimeDataMode {
  const configured = process.env.APP_DATA_MODE;
  if (configured !== "memory" && configured !== "postgres") {
    throw new Error("APP_DATA_MODE deve ser configurado explicitamente como memory ou postgres.");
  }
  if (configured === "memory" && process.env.NODE_ENV === "production") {
    throw new Error("APP_DATA_MODE=memory não é permitido em produção.");
  }
  return configured;
}

export function getRuntimeStore(): StateStore {
  const dataMode = runtimeDataMode();
  if (!globalThis.__cvgDiagnosticsStore) {
    if (dataMode === "postgres") {
      throw new Error("APP_DATA_MODE=postgres exige getRuntimeStoreAsync para inicializar a conexão.");
    }
    globalThis.__cvgDiagnosticsStore = new MemoryStore(createDemoState());
  }
  return globalThis.__cvgDiagnosticsStore;
}

export async function getRuntimeStoreAsync(): Promise<StateStore> {
  const dataMode = runtimeDataMode();
  if (dataMode !== "postgres") return getRuntimeStore();
  if (!globalThis.__cvgDiagnosticsStorePromise) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL é obrigatório quando APP_DATA_MODE=postgres.");
    globalThis.__cvgDiagnosticsStorePromise = PostgresStore.create(connectionString);
  }
  try {
    globalThis.__cvgDiagnosticsStore = await globalThis.__cvgDiagnosticsStorePromise;
  } catch (error) {
    globalThis.__cvgDiagnosticsStorePromise = undefined;
    throw error;
  }
  return globalThis.__cvgDiagnosticsStore;
}

export function getRuntimeFileStore(): FileStore {
  if (!globalThis.__cvgDiagnosticsFileStore) globalThis.__cvgDiagnosticsFileStore = createFileStoreFromEnv();
  return globalThis.__cvgDiagnosticsFileStore;
}

export async function getRuntimeReadiness(): Promise<{ dataMode: string; storageMode: string }> {
  const dataMode = runtimeDataMode();
  const store = await getRuntimeStoreAsync();
  await store.healthcheck?.();
  const storage = getRuntimeFileStore();
  await storage.healthcheck?.();
  createMalwareScannerFromEnv();
  assertRateLimitConfiguration();
  return { dataMode, storageMode: process.env.STORAGE_MODE ?? "local" };
}

export function resetRuntimeStore(): void {
  if (process.env.NODE_ENV !== "test") throw new Error("resetRuntimeStore só pode ser usado em testes.");
  globalThis.__cvgDiagnosticsStore = new MemoryStore(createDemoState());
  globalThis.__cvgDiagnosticsStorePromise = undefined;
  globalThis.__cvgDiagnosticsFileStore = undefined;
}
