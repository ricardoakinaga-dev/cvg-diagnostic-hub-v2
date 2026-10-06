import { Readable } from "node:stream";
import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { safeStorageKey } from "./storage-key";
import type { FileStore } from "./file-store-contract";

export interface S3FileStoreConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  /** TCP connect ceiling. The SDK default waits forever. */
  connectionTimeoutMs?: number;
  /** Socket idle ceiling per request; a black-holed endpoint otherwise pins uploads, downloads and readiness. */
  requestTimeoutMs?: number;
}

const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class S3FileStore implements FileStore {
  private readonly client: S3Client;
  private readonly requestTimeoutMs: number;

  constructor(private readonly config: S3FileStoreConfig, client?: S3Client) {
    this.requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.client = client ?? new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      requestHandler: {
        connectionTimeout: config.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
        requestTimeout: this.requestTimeoutMs,
        // Without this the handler only logs a warning when requestTimeout elapses and keeps waiting.
        throwOnRequestTimeout: true
      }
    });
  }

  async put(key: string, content: Uint8Array): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.config.bucket, Key: safeStorageKey(key), Body: content }));
  }

  async get(key: string): Promise<Buffer> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: safeStorageKey(key) }));
    if (!response.Body) throw new Error("STORAGE_OBJECT_MISSING");
    return readBodyWithIdleTimeout(response.Body, this.requestTimeoutMs);
  }

  async remove(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: safeStorageKey(key) }));
  }

  async delete(key: string): Promise<void> {
    await this.remove(key);
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: safeStorageKey(key) }));
      return true;
    } catch {
      return false;
    }
  }

  async healthcheck(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.config.bucket }));
  }
}

/**
 * The SDK's requestTimeout stops guarding once the response headers arrive, so an
 * endpoint that sends part of the body and goes silent kept the download pending.
 * The body read gets the same idle ceiling: every chunk re-arms it.
 */
function readBodyWithIdleTimeout(body: unknown, idleTimeoutMs: number): Promise<Buffer> {
  if (!(body instanceof Readable)) {
    // Non-Node runtimes and test doubles expose only the whole-body transform; bound it as a whole.
    const transform = (body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("STORAGE_TIMEOUT")), idleTimeoutMs); });
    return Promise.race([transform.then((bytes) => Buffer.from(bytes)), timeout]).finally(() => clearTimeout(timer));
  }
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        body.destroy();
        reject(error);
      } else {
        resolve(Buffer.concat(chunks));
      }
    };
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => settle(new Error("STORAGE_TIMEOUT")), idleTimeoutMs);
    };
    body.on("data", (chunk: Buffer | string) => { chunks.push(Buffer.from(chunk)); arm(); });
    body.once("end", () => settle());
    body.once("error", (error: Error) => settle(error));
    arm();
  });
}
