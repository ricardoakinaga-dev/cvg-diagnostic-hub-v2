import type { StoreState } from "../server/domain/models";
import { ENTITY_COLLECTIONS, entityKey, stateHeader, type EntityCollection } from "../server/store/postgres-entity-state";

/**
 * In-memory stand-in for cvg_runtime_state + cvg_runtime_entities(+removals),
 * answering exactly the statements postgres-entity-state and PostgresStore
 * issue. Unit tests use it where a pg mock must behave like the real tables.
 */
interface Row {
  collection: EntityCollection;
  entity_key: string;
  position: number;
  data: Record<string, unknown>;
  written_version: number;
}

export interface FakeQueryResult {
  rows: unknown[];
  rowCount: number;
}

const rowId = (collection: string, key: string) => `${collection}\u0000${key}`;

export class FakeEntityDatabase {
  version: number;
  removalFloor = 0;
  header: StoreState;
  readonly rows = new Map<string, Row>();
  readonly removals: { removed_version: number; collection: string; entity_key: string; removed_at: number }[] = [];
  readonly statements: string[] = [];

  constructor(state: StoreState, version = 1) {
    this.version = version;
    this.header = stateHeader(state);
    for (const collection of ENTITY_COLLECTIONS) {
      (state[collection] as unknown[]).forEach((entry, index) => {
        const key = entityKey(collection, entry);
        this.rows.set(rowId(collection, key), { collection, entity_key: key, position: index + 1, data: structuredClone(entry) as Record<string, unknown>, written_version: version });
      });
    }
  }

  /** The aggregate the tables currently describe, as a full load would assemble it. */
  state(): StoreState {
    const state: Record<string, unknown> = { ...structuredClone(this.header) };
    for (const collection of ENTITY_COLLECTIONS) {
      state[collection] = this.ordered().filter((row) => row.collection === collection).map((row) => structuredClone(row.data));
    }
    return state as unknown as StoreState;
  }

  /** Returns undefined for statements outside the entity storage contract. */
  handle(text: string, values: readonly unknown[] = []): FakeQueryResult | undefined {
    const sql = text.replace(/\s+/g, " ").trim();
    if (sql.startsWith("SELECT state, version, entity_removal_floor FROM cvg_runtime_state")) {
      this.statements.push(sql.endsWith("FOR UPDATE") ? "header:lock" : "header");
      return { rowCount: 1, rows: [{ state: structuredClone(this.header), version: String(this.version), entity_removal_floor: String(this.removalFloor) }] };
    }
    if (sql.startsWith("SELECT collection, entity_key, position, data FROM cvg_runtime_entities ORDER BY")) {
      this.statements.push("entities:all");
      return this.result(this.ordered());
    }
    if (sql.startsWith("SELECT collection, entity_key, position, data FROM cvg_runtime_entities WHERE written_version >")) {
      this.statements.push("entities:changed");
      return this.result(this.ordered().filter((row) => row.written_version > Number(values[0])));
    }
    if (sql.startsWith("SELECT collection, entity_key FROM cvg_runtime_entity_removals")) {
      this.statements.push("removals");
      const rows = this.removals.filter((removal) => removal.removed_version > Number(values[0])).map(({ collection, entity_key }) => ({ collection, entity_key }));
      return { rowCount: rows.length, rows };
    }
    if (sql.startsWith("SELECT entity_key, position FROM cvg_runtime_entities WHERE collection =")) {
      this.statements.push("layout");
      const rows = this.ordered().filter((row) => row.collection === values[0]).map(({ entity_key, position }) => ({ entity_key, position: String(position) }));
      return { rowCount: rows.length, rows };
    }
    if (sql.startsWith("INSERT INTO cvg_runtime_entities")) {
      this.statements.push("upsert");
      const batch = JSON.parse(String(values[0])) as { collection: EntityCollection; entity_key: string; position: number; data: Record<string, unknown> }[];
      for (const entry of batch) {
        this.rows.set(rowId(entry.collection, entry.entity_key), { ...entry, written_version: Number(values[1]) });
      }
      return { rowCount: batch.length, rows: [] };
    }
    if (sql.startsWith("WITH removed AS ( DELETE FROM cvg_runtime_entities")) {
      this.statements.push("delete");
      const batch = JSON.parse(String(values[0])) as { collection: string; entity_key: string }[];
      let removed = 0;
      for (const entry of batch) {
        if (this.rows.delete(rowId(entry.collection, entry.entity_key))) {
          removed += 1;
          this.removals.push({ removed_version: Number(values[1]), collection: entry.collection, entity_key: entry.entity_key, removed_at: Date.now() });
        }
      }
      return { rowCount: removed, rows: [] };
    }
    if (sql.startsWith("UPDATE cvg_runtime_state SET state = $1::jsonb, version = version + 1")) {
      this.statements.push("header:update");
      this.header = JSON.parse(String(values[0])) as StoreState;
      this.version += 1;
      return { rowCount: 1, rows: [{ version: String(this.version) }] };
    }
    if (sql.startsWith("WITH pruned AS ( DELETE FROM cvg_runtime_entity_removals")) {
      this.statements.push("prune");
      const cutoff = Date.parse(String(values[0]));
      const pruned = this.removals.filter((removal) => removal.removed_at < cutoff);
      for (const removal of pruned) this.removals.splice(this.removals.indexOf(removal), 1);
      this.removalFloor = Math.max(this.removalFloor, ...pruned.map((removal) => removal.removed_version));
      return { rowCount: 1, rows: [] };
    }
    return undefined;
  }

  private ordered(): Row[] {
    return [...this.rows.values()].sort((left, right) => left.collection.localeCompare(right.collection) || left.position - right.position);
  }

  private result(rows: Row[]): FakeQueryResult {
    return { rowCount: rows.length, rows: rows.map(({ collection, entity_key, position, data }) => ({ collection, entity_key, position: String(position), data: structuredClone(data) })) };
  }
}
