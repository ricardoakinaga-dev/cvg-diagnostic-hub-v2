import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalFileStore, createFileStoreFromEnv, safeStorageKey } from "./file-store";

describe("local private file store", () => {
  it("writes atomically, reads, checks and removes opaque keys", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cvg-file-store-"));
    try {
      const store = new LocalFileStore(root);
      const content = new Uint8Array([1, 2, 3]);
      await store.put("tenant/item/report.bin", content);
      expect(await store.exists("tenant/item/report.bin")).toBe(true);
      expect([...await store.get("tenant/item/report.bin")]).toEqual([1, 2, 3]);
      await store.remove("tenant/item/report.bin");
      expect(await store.exists("tenant/item/report.bin")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects traversal keys", async () => {
    const store = new LocalFileStore("/tmp/cvg-file-store-test");
    await expect(store.put("../outside", new Uint8Array([1]))).rejects.toThrow("INVALID_STORAGE_KEY");
    await expect(store.get("/absolute",)).rejects.toThrow("INVALID_STORAGE_KEY");
  });

  it("validates local storage readiness and preserves only safe keys", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cvg-file-store-ready-"));
    try {
      const store = new LocalFileStore(path.join(root, "nested"));
      await store.healthcheck();
      expect(safeStorageKey("tenant/item/report.bin")).toBe("tenant/item/report.bin");
      expect(createFileStoreFromEnv({ STORAGE_MODE: "local", STORAGE_ROOT: path.join(root, "factory") })).toBeInstanceOf(LocalFileStore);
      expect(() => createFileStoreFromEnv({ NODE_ENV: "production", STORAGE_MODE: "local", STORAGE_ROOT: root })).toThrow(/local.*produção/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
