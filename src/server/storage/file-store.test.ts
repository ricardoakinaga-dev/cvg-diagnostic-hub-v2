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

  it("rejects a filesystem root that cannot provide a private storage boundary", async () => {
    const store = new LocalFileStore(path.parse(process.cwd()).root);
    await expect(store.put("cvg-root-boundary-test/report.bin", new Uint8Array([1]))).rejects.toThrow("INVALID_STORAGE_KEY");
  });

  it("deletes a stored object and tolerates repeated deletion of the missing key", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cvg-file-store-delete-"));
    try {
      const store = new LocalFileStore(root);
      await store.put("tenant/delete.bin", Uint8Array.from([42]));
      expect(await store.exists("tenant/delete.bin")).toBe(true);
      await store.delete("tenant/delete.bin");
      expect(await store.exists("tenant/delete.bin")).toBe(false);
      await expect(store.get("tenant/delete.bin")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(store.delete("tenant/delete.bin")).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
