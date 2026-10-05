import { afterEach, describe, expect, it, vi } from "vitest";
import { createFileStoreFromEnv } from "./file-store";

const transport = vi.hoisted(() => ({
  options: [] as Array<Record<string, unknown>>,
  send: vi.fn().mockResolvedValue({})
}));

vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const sdk = await importOriginal<typeof import("@aws-sdk/client-s3")>();
  return {
    ...sdk,
    S3Client: class {
      constructor(options: Record<string, unknown>) {
        transport.options.push(options);
      }

      send = transport.send;
    }
  };
});

const s3Environment: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  STORAGE_MODE: "s3",
  STORAGE_ENDPOINT: " https://storage.example.test ",
  STORAGE_BUCKET: " private-reports ",
  STORAGE_ACCESS_KEY: " test-access ",
  STORAGE_SECRET_KEY: " test-secret "
};

afterEach(() => {
  transport.options.length = 0;
  transport.send.mockClear();
});

describe("file store environment boundary", () => {
  it.each(["STORAGE_ENDPOINT", "STORAGE_BUCKET", "STORAGE_ACCESS_KEY", "STORAGE_SECRET_KEY"] as const)(
    "rejects absent or blank %s before constructing a transport",
    (key) => {
      for (const value of [undefined, "", " \t "]) {
        expect(() => createFileStoreFromEnv({ ...s3Environment, [key]: value })).toThrow(`${key} é obrigatório quando STORAGE_MODE=s3.`);
      }
      expect(transport.options).toHaveLength(0);
      expect(transport.send).not.toHaveBeenCalled();
    }
  );

  it.each([
    { environment: {}, region: "us-east-1", forcePathStyle: true },
    { environment: { STORAGE_REGION: "sa-east-1", STORAGE_FORCE_PATH_STYLE: "false" }, region: "sa-east-1", forcePathStyle: false }
  ])("uses the configured S3 transport for readiness and uploads: $region", async ({ environment, region, forcePathStyle }) => {
    const store = createFileStoreFromEnv({ ...s3Environment, ...environment });
    if (!store.healthcheck) throw new Error("S3 readiness check missing");
    await store.healthcheck();
    const content = Uint8Array.from([7, 8, 9]);
    await store.put("tenant/report.bin", content);

    expect(transport.options).toEqual([{
      endpoint: "https://storage.example.test",
      region,
      forcePathStyle,
      credentials: { accessKeyId: "test-access", secretAccessKey: "test-secret" }
    }]);
    expect(transport.send).toHaveBeenCalledTimes(2);
    expect(transport.send.mock.calls[0][0]).toMatchObject({ input: { Bucket: "private-reports" } });
    expect(transport.send.mock.calls[1][0]).toMatchObject({ input: {
      Bucket: "private-reports", Key: "tenant/report.bin", Body: content
    } });
  });
});
