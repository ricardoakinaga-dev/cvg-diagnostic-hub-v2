export interface FileStore {
  put(key: string, content: Uint8Array): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete?(key: string): Promise<void>;
  remove(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  healthcheck?(): Promise<void>;
}
