import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { S3FileStore } from "./s3-file-store";

describe("S3-compatible private file store", () => {
  it("uses opaque keys for put/get/remove/exists and readiness", async () => {
    const client = { send: vi.fn(async (command: unknown) => {
      if (command instanceof GetObjectCommand) return { Body: { transformToByteArray: async () => new Uint8Array([4, 5]) } };
      return {};
    }) } as unknown as S3Client;
    const store = new S3FileStore({ endpoint: "http://minio.local", region: "us-east-1", bucket: "attachments", accessKeyId: "access", secretAccessKey: "secret", forcePathStyle: true }, client);

    await store.put("tenant/report.bin", new Uint8Array([1, 2]));
    expect([...await store.get("tenant/report.bin")]).toEqual([4, 5]);
    await expect(store.exists("tenant/report.bin")).resolves.toBe(true);
    await store.remove("tenant/report.bin");
    await store.healthcheck();

    const commands = (client.send as ReturnType<typeof vi.fn>).mock.calls.map(([command]) => command);
    expect(commands.some((command) => command instanceof PutObjectCommand && command.input.Key === "tenant/report.bin")).toBe(true);
    expect(commands.some((command) => command instanceof HeadObjectCommand)).toBe(true);
    expect(commands.some((command) => command instanceof DeleteObjectCommand)).toBe(true);
    expect(commands.some((command) => command instanceof HeadBucketCommand)).toBe(true);
  });

  it("rejects unsafe keys before talking to S3", async () => {
    const client = { send: vi.fn() } as unknown as S3Client;
    const store = new S3FileStore({ endpoint: "http://minio.local", region: "us-east-1", bucket: "attachments", accessKeyId: "access", secretAccessKey: "secret", forcePathStyle: true }, client);

    await expect(store.put("../escape", new Uint8Array([1]))).rejects.toThrow("INVALID_STORAGE_KEY");
    expect(client.send).not.toHaveBeenCalled();
  });

  it("treats a missing S3 object as unavailable without leaking provider details", async () => {
    const client = { send: vi.fn(async () => { throw new Error("NoSuchKey: internal bucket detail"); }) } as unknown as S3Client;
    const store = new S3FileStore({ endpoint: "http://minio.local", region: "us-east-1", bucket: "attachments", accessKeyId: "access", secretAccessKey: "secret", forcePathStyle: true }, client);

    await expect(store.exists("tenant/missing.bin")).resolves.toBe(false);
  });

  it("supports the contract delete alias", async () => {
    const client = { send: vi.fn(async () => ({})) } as unknown as S3Client;
    const store = new S3FileStore({ endpoint: "http://minio.local", region: "us-east-1", bucket: "attachments", accessKeyId: "access", secretAccessKey: "secret", forcePathStyle: true }, client);

    await store.delete("tenant/delete-alias.bin");
    expect(client.send).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({ Key: "tenant/delete-alias.bin" }) }));
  });
});

describe("S3-compatible store timeouts", () => {
  it("fails readiness instead of hanging when the endpoint accepts but never answers", async () => {
    const { createServer } = await import("node:net");
    const sockets: import("node:net").Socket[] = [];
    const server = createServer((socket) => { sockets.push(socket); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as import("node:net").AddressInfo;
    try {
      const store = new S3FileStore({ endpoint: `http://127.0.0.1:${port}`, region: "us-east-1", bucket: "attachments", accessKeyId: "access", secretAccessKey: "secret", forcePathStyle: true, requestTimeoutMs: 200, connectionTimeoutMs: 200 });
      const startedAt = Date.now();
      await expect(store.healthcheck()).rejects.toThrow();
      // Default SDK retries (3 attempts) stay bounded by the per-attempt timeout.
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
