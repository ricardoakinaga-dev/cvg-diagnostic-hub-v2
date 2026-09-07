import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { S3FileStore, type S3FileStoreConfig } from "./s3-file-store";

const config: S3FileStoreConfig = {
  endpoint: "http://s3.mock.invalid",
  region: "us-east-1",
  bucket: "cvg-private-attachments",
  accessKeyId: "test-access-key",
  secretAccessKey: "test-secret-key",
  forcePathStyle: true
};

function makeStore(send: ReturnType<typeof vi.fn>) {
  return {
    store: new S3FileStore(config, { send } as unknown as S3Client),
    send
  };
}

describe("S3FileStore behavior coverage", () => {
  it("puts, gets, and deletes content using the configured bucket and object prefix", async () => {
    const content = Uint8Array.from([0, 1, 2, 255]);
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof GetObjectCommand) {
        return { Body: { transformToByteArray: async () => content } };
      }
      return {};
    });
    const { store } = makeStore(send);

    await store.put("private\\tenant\\report.pdf", content);
    await expect(store.get("private/tenant/report.pdf")).resolves.toEqual(Buffer.from(content));
    await store.delete("private\\tenant\\report.pdf");

    expect(send).toHaveBeenCalledTimes(3);
    const [putCommand, getCommand, deleteCommand] = send.mock.calls.map(([command]) => command);

    expect(putCommand).toBeInstanceOf(PutObjectCommand);
    expect(putCommand).toMatchObject({
      input: {
        Bucket: config.bucket,
        Key: "private/tenant/report.pdf",
        Body: content
      }
    });
    expect(getCommand).toMatchObject({
      input: {
        Bucket: config.bucket,
        Key: "private/tenant/report.pdf"
      }
    });
    expect(deleteCommand).toBeInstanceOf(DeleteObjectCommand);
    expect(deleteCommand).toMatchObject({
      input: {
        Bucket: config.bucket,
        Key: "private/tenant/report.pdf"
      }
    });
  });

  it("rejects a successful SDK response without a body with a stable storage error", async () => {
    const send = vi.fn(async () => ({ Body: undefined }));
    const { store } = makeStore(send);

    await expect(store.get("private/tenant/missing.pdf")).rejects.toThrow("STORAGE_OBJECT_MISSING");
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({
        Bucket: config.bucket,
        Key: "private/tenant/missing.pdf"
      })
    }));
  });

  it("does not expose SDK error details when checking object existence", async () => {
    const providerError = new Error("AccessDenied: arn:aws:iam::123456789012:role/internal-storage-role");
    const send = vi.fn(async () => {
      throw providerError;
    });
    const { store } = makeStore(send);

    await expect(store.exists("private/tenant/secret.pdf")).resolves.toBe(false);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({
        Bucket: config.bucket,
        Key: "private/tenant/secret.pdf"
      })
    }));
  });

  it("normalizes backslashes while preserving a valid nested key prefix", async () => {
    const send = vi.fn(async () => ({}));
    const { store } = makeStore(send);

    await store.put("private\\tenant\\2026\\report.pdf", Uint8Array.from([7]));

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({
        Bucket: config.bucket,
        Key: "private/tenant/2026/report.pdf"
      })
    }));
  });
});
