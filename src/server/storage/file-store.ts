import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { S3FileStore, type S3FileStoreConfig } from "./s3-file-store";
import { safeStorageKey } from "./storage-key";
import type { FileStore } from "./file-store-contract";

export { safeStorageKey } from "./storage-key";
export type { FileStore } from "./file-store-contract";

export class LocalFileStore implements FileStore {
  constructor(private readonly root: string) {}

  async put(key: string, content: Uint8Array): Promise<void> {
    const destination = path.resolve(this.root, safeStorageKey(key));
    const root = path.resolve(this.root);
    if (!destination.startsWith(`${root}${path.sep}`)) throw new Error("INVALID_STORAGE_KEY");
    await mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.uploading-${process.pid}-${Date.now()}`;
    await writeFile(temporary, content, { flag: "wx" });
    await rename(temporary, destination);
  }

  async get(key: string): Promise<Buffer> {
    return readFile(path.resolve(this.root, safeStorageKey(key)));
  }

  async remove(key: string): Promise<void> {
    await rm(path.resolve(this.root, safeStorageKey(key)), { force: true });
  }

  async delete(key: string): Promise<void> {
    await this.remove(key);
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(path.resolve(this.root, safeStorageKey(key)));
      return true;
    } catch {
      return false;
    }
  }

  async healthcheck(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const probe = path.join(path.resolve(this.root), `.healthcheck-${process.pid}-${randomUUID()}`);
    await writeFile(probe, "ok", { flag: "wx" });
    await rm(probe, { force: true });
  }
}

export function createFileStoreFromEnv(environment: Partial<NodeJS.ProcessEnv> = process.env): FileStore {
  if (environment.STORAGE_MODE !== "s3") {
    if (environment.NODE_ENV === "production") throw new Error("STORAGE_MODE=local não é permitido em produção.");
    return new LocalFileStore(environment.STORAGE_ROOT ?? ".data/uploads");
  }
  const config: S3FileStoreConfig = {
    endpoint: required(environment.STORAGE_ENDPOINT, "STORAGE_ENDPOINT"),
    region: environment.STORAGE_REGION ?? "us-east-1",
    bucket: required(environment.STORAGE_BUCKET, "STORAGE_BUCKET"),
    accessKeyId: required(environment.STORAGE_ACCESS_KEY, "STORAGE_ACCESS_KEY"),
    secretAccessKey: required(environment.STORAGE_SECRET_KEY, "STORAGE_SECRET_KEY"),
    forcePathStyle: environment.STORAGE_FORCE_PATH_STYLE !== "false"
  };
  return new S3FileStore(config);
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} é obrigatório quando STORAGE_MODE=s3.`);
  return value.trim();
}
