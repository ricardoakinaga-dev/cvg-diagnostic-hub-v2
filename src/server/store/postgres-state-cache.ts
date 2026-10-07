import type { Pool } from "pg";
import type { StoreState } from "../domain/models";
import { cloneState, CURRENT_STATE_SQL, CURRENT_VERSION_SQL, runtimeStateFromRow, versionFromRow } from "./postgres-state-codec";
import { PostgresStateInvalidation } from "./postgres-state-invalidation";

type Snapshot = { state: StoreState; version: number };

/** Notifications accelerate invalidation; a durable version probe proves every hit. */
export class PostgresStateCache {
  private snapshot: Snapshot;
  private invalidation = 0;
  private validatedInvalidation = 0;
  private readonly loads = new Map<number, Promise<Snapshot>>();
  private readonly listener: PostgresStateInvalidation;

  constructor(private readonly pool: Pool, initial: Snapshot, connectionString: string) {
    this.snapshot = { state: cloneState(initial.state), version: initial.version };
    this.listener = new PostgresStateInvalidation(connectionString, () => { this.invalidation += 1; });
  }

  getState(): StoreState {
    return cloneState(this.snapshot.state);
  }

  observe(state: StoreState, version: number): void {
    // A slow read begun before COMMIT must never replace a newer cache entry.
    if (version < this.snapshot.version) return;
    this.snapshot = { state: cloneState(state), version };
  }

  async read(): Promise<Snapshot> {
    const result = await this.pool.query<{ version: unknown }>(CURRENT_VERSION_SQL);
    if (result.rowCount !== 1) throw new Error("PostgreSQL runtime state row is missing.");
    const version = versionFromRow(result.rows[0].version);
    if (this.snapshot.version === version && this.validatedInvalidation === this.invalidation) {
      return { state: this.getState(), version };
    }
    let load = this.loads.get(version);
    if (!load) {
      load = this.load(version);
      this.loads.set(version, load);
      const completed = load;
      const remove = () => { if (this.loads.get(version) === completed) this.loads.delete(version); };
      void load.then(remove, remove);
    }
    const snapshot = await load;
    return { state: cloneState(snapshot.state), version: snapshot.version };
  }

  close(): Promise<void> {
    return this.listener.close();
  }

  private async load(minimumVersion: number): Promise<Snapshot> {
    const invalidation = this.invalidation;
    const result = await this.pool.query<{ state: unknown; version: unknown }>(CURRENT_STATE_SQL);
    if (result.rowCount !== 1) throw new Error("PostgreSQL runtime state row is missing.");
    const state = runtimeStateFromRow(result.rows[0]);
    const version = versionFromRow(result.rows[0].version);
    if (version < minimumVersion) throw new Error("PostgreSQL runtime state version regressed during read.");
    this.observe(state, version);
    // Do not acknowledge a notification received while this SELECT was in flight.
    if (version === this.snapshot.version) this.validatedInvalidation = invalidation;
    return { state, version };
  }
}
