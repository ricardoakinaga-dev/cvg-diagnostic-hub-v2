import type { Pool } from "pg";
import type { StoreState } from "../domain/models";
import { cloneState, CURRENT_VERSION_SQL, versionFromRow } from "./postgres-state-codec";
import { loadEntityState, refreshEntityState, type EntityQueryable } from "./postgres-entity-state";
import { freezeState } from "./immutable-state";
import { PostgresStateInvalidation, type InvalidationKind } from "./postgres-state-invalidation";

type Snapshot = { state: StoreState; version: number };

/**
 * Notifications accelerate invalidation; a durable version probe proves every hit.
 * A miss applies only the entities written after the cached version. A lost
 * LISTEN connection may hide anything (a restore can even reuse a version), so
 * the next miss after a reconnect reads every entity again.
 */
export class PostgresStateCache {
  private snapshot: Snapshot;
  private invalidation = 0;
  private validatedInvalidation = 0;
  private reconnects = 0;
  private reloadedReconnects = 0;
  private readonly loads = new Map<number, Promise<Snapshot>>();
  private readonly listener: PostgresStateInvalidation;

  constructor(private readonly pool: Pool, initial: Snapshot, connectionString: string) {
    this.snapshot = { state: freezeState(initial.state), version: initial.version };
    this.listener = new PostgresStateInvalidation(connectionString, (kind: InvalidationKind) => {
      if (kind === "reconnect") this.reconnects += 1;
      this.invalidation += 1;
    });
  }

  /** A mutable copy for tests and diagnostics; runtime reads use read() or current(). */
  getState(): StoreState {
    return cloneState(this.snapshot.state);
  }

  /** The shared frozen aggregate and its version, without touching PostgreSQL. */
  current(): Snapshot {
    return this.snapshot;
  }

  observe(state: StoreState, version: number): void {
    // A slow read begun before COMMIT must never replace a newer cache entry.
    if (version < this.snapshot.version) return;
    this.snapshot = { state: freezeState(state), version };
  }

  async read(): Promise<Snapshot> {
    const result = await this.pool.query<{ version: unknown }>(CURRENT_VERSION_SQL);
    if (result.rowCount !== 1) throw new Error("PostgreSQL runtime state row is missing.");
    const version = versionFromRow(result.rows[0].version);
    if (this.snapshot.version === version && this.validatedInvalidation === this.invalidation) {
      return this.snapshot;
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
    return snapshot;
  }

  /**
   * Brings the cache to the version visible to `client` and returns it. The
   * caller supplies the consistent view: a REPEATABLE READ transaction, or the
   * writer's transaction holding the cvg_runtime_state row lock. `exact`
   * returns precisely that version; otherwise a cache already advanced by a
   * local commit is returned as is.
   */
  async refreshWith(client: EntityQueryable, options: { exact?: boolean } = {}): Promise<Snapshot> {
    const reconnects = this.reconnects;
    const full = reconnects !== this.reloadedReconnects;
    const next = full
      ? await loadEntityState(client)
      : await refreshEntityState(client, this.snapshot, { keepNewerBase: options.exact !== true });
    if (full) this.reloadedReconnects = Math.max(this.reloadedReconnects, reconnects);
    const snapshot = { state: freezeState(next.state), version: next.version };
    this.observe(snapshot.state, snapshot.version);
    return snapshot;
  }

  close(): Promise<void> {
    return this.listener.close();
  }

  private async load(minimumVersion: number): Promise<Snapshot> {
    const invalidation = this.invalidation;
    const client = await this.pool.connect();
    let snapshot: Snapshot;
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      snapshot = await this.refreshWith(client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    if (snapshot.version < minimumVersion) throw new Error("PostgreSQL runtime state version regressed during read.");
    // Do not acknowledge a notification received while the refresh was in flight.
    if (snapshot.version === this.snapshot.version) this.validatedInvalidation = invalidation;
    return snapshot;
  }
}
