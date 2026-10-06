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

  constructor(private readonly config: S3FileStoreConfig, client?: S3Client) {
    this.client = client ?? new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      requestHandler: {
        connectionTimeout: config.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
        requestTimeout: config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
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
    return Buffer.from(await response.Body.transformToByteArray());
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
