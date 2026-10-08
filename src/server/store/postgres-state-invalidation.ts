import { Pool, type PoolClient } from "pg";
import { runtimePoolTimeouts } from "../domain/database-timeouts";

const CHANNEL = "cvg_runtime_state_changed";
const RETRY_MS = 5_000;

/** One dedicated connection per store, independent of DB_POOL_MAX and write locks. */
export class PostgresStateInvalidation {
  private readonly pool: Pool;
  private client?: PoolClient;
  private connecting?: Promise<void>;
  private retry?: ReturnType<typeof setTimeout>;
  private closed = false;
  private closing?: Promise<void>;

  constructor(connectionString: string, private readonly invalidate: () => void) {
    this.pool = new Pool({ connectionString, max: 1, application_name: "cvg-runtime-state-cache", ...runtimePoolTimeouts() });
    this.pool.on("error", () => this.invalidate());
    this.connect();
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    this.closing = (async () => {
      await this.connecting;
      this.release();
      await this.pool.end();
    })();
    return this.closing;
  }

  private connect(): void {
    if (this.closed) return;
    this.connecting = this.listen();
  }

  private async listen(): Promise<void> {
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      if (this.closed) { client.release(); return; }
      this.client = client;
      client.on("notification", (message) => { if (message.channel === CHANNEL) this.invalidate(); });
      const connected = client;
      client.on("error", () => {
        if (this.closed || this.client !== connected) return;
        this.release();
        this.recover();
      });
      client.on("end", () => {
        if (this.closed || this.client !== connected) return;
        this.release();
        this.recover();
      });
      await client.query(`LISTEN ${CHANNEL}`);
      // Changes during connection/reconnection are covered by the next version probe.
      if (!this.closed) this.invalidate();
    } catch {
      if (client && this.client === client) this.release();
      this.recover();
    }
  }

  private release(): void {
    const client = this.client;
    this.client = undefined;
    client?.release(true);
  }

  private recover(): void {
    if (this.closed) return;
    this.invalidate();
    if (this.retry) return;
    this.retry = setTimeout(() => { this.retry = undefined; this.connect(); }, RETRY_MS);
    this.retry.unref?.();
  }
}
