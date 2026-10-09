import type { StoreState } from "../domain/models";
import { stateFromRow, versionFromRow } from "./postgres-state-codec";

/**
 * Entity-row persistence for the runtime aggregate (migration 015).
 *
 * The aggregate used to be one JSONB document, rewritten whole on every write
 * and re-parsed whole after every external change. Each entity is now one row
 * of cvg_runtime_entities, ordered by `position` inside its collection:
 *
 * - a write persists only the entities whose object identity changed (the
 *   application replaces what it changes and shares the rest), plus removals;
 * - a cache at version V applies only rows written after V and the removals
 *   recorded after V, instead of reading every entity again.
 *
 * Array order is part of the StoreState contract (first-match lookups,
 * insertion-order listings), so positions mirror it exactly. The application
 * appends and replaces in place; anything else renumbers that collection.
 */
export const ENTITY_COLLECTIONS = [
  "users",
  "sessions",
  "patients",
  "encounters",
  "admissions",
  "services",
  "reasonCodes",
  "requests",
  "items",
  "samples",
  "procedures",
  "schedules",
  "results",
  "resultVersions",
  "notifications",
  "idempotency",
  "attachments"
] as const satisfies readonly (keyof StoreState)[];

export type EntityCollection = (typeof ENTITY_COLLECTIONS)[number];

export interface EntityQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

export interface EntitySnapshot {
  readonly state: StoreState;
  readonly version: number;
}

interface Layout {
  readonly keys: readonly string[];
  readonly positions: readonly number[];
}

interface EntityRow {
  readonly collection: string;
  readonly entity_key: string;
  readonly position: string | number;
  readonly data: Record<string, unknown>;
}

interface HeaderRow {
  readonly state: unknown;
  readonly version: unknown;
  readonly entity_removal_floor: unknown;
}

const UPSERT_BATCH_SIZE = 2_000;
const layouts = new WeakMap<readonly unknown[], Layout>();
const entityKeys = new WeakMap<object, string>();
// key -> index of a layout, built only when a write appends to that collection and handed over to the next layout.
const keyIndexes = new WeakMap<Layout, Map<string, number>>();

const HEADER_SQL = "SELECT state, version, entity_removal_floor FROM cvg_runtime_state WHERE id = 1";
const LOCKED_HEADER_SQL = `${HEADER_SQL} FOR UPDATE`;
const ALL_ENTITIES_SQL = "SELECT collection, entity_key, position, data FROM cvg_runtime_entities ORDER BY collection, position";
const CHANGED_ENTITIES_SQL = "SELECT collection, entity_key, position, data FROM cvg_runtime_entities WHERE written_version > $1 ORDER BY collection, position";
const REMOVALS_SQL = "SELECT collection, entity_key FROM cvg_runtime_entity_removals WHERE removed_version > $1";
const COLLECTION_LAYOUT_SQL = "SELECT entity_key, position FROM cvg_runtime_entities WHERE collection = $1";
const UPSERT_SQL = `INSERT INTO cvg_runtime_entities (collection, entity_key, position, data, written_version)
  SELECT entry.collection, entry.entity_key, entry.position, entry.data, $2
    FROM jsonb_to_recordset($1::jsonb) AS entry(collection text, entity_key text, position bigint, data jsonb)
  ON CONFLICT (collection, entity_key) DO UPDATE
    SET position = EXCLUDED.position, data = EXCLUDED.data, written_version = EXCLUDED.written_version`;
const DELETE_SQL = `WITH removed AS (
    DELETE FROM cvg_runtime_entities entity
     USING jsonb_to_recordset($1::jsonb) AS entry(collection text, entity_key text)
     WHERE entity.collection = entry.collection AND entity.entity_key = entry.entity_key
    RETURNING entity.collection, entity.entity_key
  )
  INSERT INTO cvg_runtime_entity_removals (removed_version, collection, entity_key)
  SELECT $2, collection, entity_key FROM removed`;

/** Must stay byte-identical to cvg_runtime_entity_key() in migration 015. */
export function entityKey(collection: EntityCollection, entity: unknown): string {
  if (entity !== null && typeof entity === "object") {
    const cached = entityKeys.get(entity);
    if (cached !== undefined) return cached;
  }
  const record = entity as Record<string, unknown> | null;
  const key = collection === "idempotency"
    ? JSON.stringify([record?.actorId, record?.scope, record?.key])
    : record?.id;
  if (typeof key !== "string" || key === "") throw new Error(`POSTGRES_ENTITY_KEY_INVALID:${collection}`);
  if (record) entityKeys.set(record, key);
  return key;
}

/** The persisted header: every entity collection, the audit and the outbox are empty. */
export function stateHeader(state: StoreState): StoreState {
  const header: Record<string, unknown> = { ...state, auditEvents: [], outbox: [] };
  for (const collection of ENTITY_COLLECTIONS) header[collection] = [];
  return header as unknown as StoreState;
}

function position(value: string | number): number {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 1) throw new Error("POSTGRES_ENTITY_POSITION_INVALID");
  return numeric;
}

function isEntityCollection(value: string): value is EntityCollection {
  return (ENTITY_COLLECTIONS as readonly string[]).includes(value);
}

function remember<T>(entries: T[], keys: string[], positions: number[]): T[] {
  layouts.set(entries, { keys, positions });
  return entries;
}

async function header(client: EntityQueryable, lock: boolean) {
  const result = await client.query(lock ? LOCKED_HEADER_SQL : HEADER_SQL);
  if (result.rowCount !== 1) throw new Error("PostgreSQL runtime state row is missing.");
  const row = result.rows[0] as HeaderRow;
  const removalFloor = Number(row.entity_removal_floor);
  if (!Number.isSafeInteger(removalFloor) || removalFloor < 0) throw new Error("PostgreSQL runtime removal floor is invalid.");
  return { header: stateFromRow(row.state), version: versionFromRow(row.version), removalFloor };
}

function assemble(headerState: StoreState, collections: Map<EntityCollection, { entries: unknown[]; keys: string[]; positions: number[] }>): StoreState {
  const state: Record<string, unknown> = { ...headerState };
  for (const collection of ENTITY_COLLECTIONS) {
    const loaded = collections.get(collection) ?? { entries: [], keys: [], positions: [] };
    state[collection] = remember(loaded.entries, loaded.keys, loaded.positions);
  }
  return stateFromRow(state);
}

/**
 * Reads every entity. The caller provides a consistent view: a REPEATABLE READ
 * transaction, or the cvg_runtime_state row lock held by the writer.
 */
export async function loadEntityState(client: EntityQueryable, options: { lock?: boolean } = {}): Promise<EntitySnapshot> {
  const current = await header(client, options.lock === true);
  const rows = (await client.query(ALL_ENTITIES_SQL)).rows as EntityRow[];
  const collections = new Map<EntityCollection, { entries: unknown[]; keys: string[]; positions: number[] }>();
  for (const row of rows) {
    if (!isEntityCollection(row.collection)) throw new Error(`POSTGRES_ENTITY_COLLECTION_INVALID:${row.collection}`);
    let target = collections.get(row.collection);
    if (!target) {
      target = { entries: [], keys: [], positions: [] };
      collections.set(row.collection, target);
    }
    target.entries.push(row.data);
    target.keys.push(row.entity_key);
    target.positions.push(position(row.position));
    entityKeys.set(row.data, row.entity_key);
  }
  return { state: assemble(current.header, collections), version: current.version };
}

/**
 * Brings `base` to the current version by applying only what changed after it.
 * Falls back to a full load when the removals it needs were pruned or when
 * `base` was not produced by this module. A view older than `base` is either a
 * reader that started before a local commit (`keepNewerBase` returns `base`)
 * or a restored database (full load). Same consistency contract as
 * loadEntityState.
 */
export async function refreshEntityState(client: EntityQueryable, base: EntitySnapshot, options: { keepNewerBase?: boolean } = {}): Promise<EntitySnapshot> {
  const current = await header(client, false);
  if (current.version === base.version) return base;
  if (current.version < base.version && options.keepNewerBase) return base;
  if (current.version < base.version || base.version < current.removalFloor) return loadEntityState(client);
  const changed = (await client.query(CHANGED_ENTITIES_SQL, [base.version])).rows as EntityRow[];
  const removed = (await client.query(REMOVALS_SQL, [base.version])).rows as Pick<EntityRow, "collection" | "entity_key">[];
  const dropped = new Map<EntityCollection, Set<string>>();
  const added = new Map<EntityCollection, EntityRow[]>();
  const drop = (collection: EntityCollection, key: string) => {
    const keys = dropped.get(collection) ?? new Set<string>();
    keys.add(key);
    dropped.set(collection, keys);
  };
  for (const row of removed) {
    if (!isEntityCollection(row.collection)) throw new Error(`POSTGRES_ENTITY_COLLECTION_INVALID:${row.collection}`);
    drop(row.collection, row.entity_key);
  }
  for (const row of changed) {
    if (!isEntityCollection(row.collection)) throw new Error(`POSTGRES_ENTITY_COLLECTION_INVALID:${row.collection}`);
    drop(row.collection, row.entity_key);
    const rows = added.get(row.collection) ?? [];
    rows.push(row);
    added.set(row.collection, rows);
  }
  const state: Record<string, unknown> = { ...current.header };
  for (const collection of ENTITY_COLLECTIONS) {
    const previous = base.state[collection] as readonly unknown[];
    const keys = dropped.get(collection);
    if (!keys) {
      state[collection] = previous;
      continue;
    }
    const layout = layouts.get(previous);
    if (!layout) return loadEntityState(client);
    // Both sides are ordered by position: merge the survivors with the rows written after `base`.
    const incoming = added.get(collection) ?? [];
    const entries: unknown[] = [];
    const nextKeys: string[] = [];
    const nextPositions: number[] = [];
    let cursor = 0;
    const takeIncomingUpTo = (limit: number) => {
      while (cursor < incoming.length && position(incoming[cursor].position) < limit) {
        const row = incoming[cursor];
        entries.push(row.data);
        nextKeys.push(row.entity_key);
        nextPositions.push(position(row.position));
        entityKeys.set(row.data, row.entity_key);
        cursor += 1;
      }
    };
    for (let index = 0; index < previous.length; index += 1) {
      if (keys.has(layout.keys[index])) continue;
      takeIncomingUpTo(layout.positions[index]);
      entries.push(previous[index]);
      nextKeys.push(layout.keys[index]);
      nextPositions.push(layout.positions[index]);
    }
    takeIncomingUpTo(Number.POSITIVE_INFINITY);
    state[collection] = remember(entries, nextKeys, nextPositions);
  }
  return { state: stateFromRow(state), version: current.version };
}

async function layoutFor(client: EntityQueryable, collection: EntityCollection, entries: readonly unknown[]): Promise<Layout> {
  const known = layouts.get(entries);
  if (known) return known;
  // Defensive: a state that did not come from this module. Read the persisted positions.
  const rows = (await client.query(COLLECTION_LAYOUT_SQL, [collection])).rows as Pick<EntityRow, "entity_key" | "position">[];
  const persisted = new Map(rows.map((row) => [row.entity_key, position(row.position)]));
  const keys = entries.map((entry) => entityKey(collection, entry));
  const positions = keys.map((key) => persisted.get(key) ?? Number.NaN);
  if (positions.some((value) => Number.isNaN(value)) || persisted.size !== keys.length) throw new Error(`POSTGRES_ENTITY_STATE_DIVERGED:${collection}`);
  return { keys, positions };
}

function keyIndexOf(layout: Layout): Map<string, number> {
  let index = keyIndexes.get(layout);
  if (!index) {
    index = new Map();
    for (let position = 0; position < layout.keys.length; position += 1) index.set(layout.keys[position], position);
    keyIndexes.set(layout, index);
  }
  return index;
}

interface AppendOrReplace {
  readonly layout: Layout;
  readonly changed: readonly number[];
}

/**
 * The application only appends new entities and replaces existing ones in place, so a write normally compares
 * object identities slot by slot and keys only the replaced and appended entities, instead of re-keying and
 * re-indexing the whole collection (about seven hash passes over 55 thousand exams at 12 months of D2 volume,
 * PROD-110). Anything else (a shorter array, a slot holding another entity, an appended key that already
 * exists) returns undefined and the general diff below handles it, including its errors.
 */
function appendOrReplace(collection: EntityCollection, previous: readonly unknown[], next: readonly unknown[], layout: Layout): AppendOrReplace | undefined {
  if (next.length < previous.length || layout.keys.length !== previous.length) return undefined;
  const changed: number[] = [];
  for (let index = 0; index < previous.length; index += 1) {
    if (next[index] === previous[index]) continue;
    if (entityKey(collection, next[index]) !== layout.keys[index]) return undefined;
    changed.push(index);
  }
  if (next.length === previous.length) return { layout, changed };
  const known = keyIndexOf(layout);
  const appended: string[] = [];
  const fresh = new Set<string>();
  for (let index = previous.length; index < next.length; index += 1) {
    const key = entityKey(collection, next[index]);
    if (known.has(key) || fresh.has(key)) return undefined;
    fresh.add(key);
    appended.push(key);
    changed.push(index);
  }
  // Positions are increasing in array order (load, refresh and the general diff all keep them so).
  const highest = layout.positions.length > 0 ? layout.positions[layout.positions.length - 1] : 0;
  const nextLayout: Layout = {
    keys: layout.keys.concat(appended),
    positions: layout.positions.concat(appended.map((_, offset) => highest + offset + 1))
  };
  // Hand the index over: the old layout rebuilds its own if it is ever written from again.
  keyIndexes.delete(layout);
  appended.forEach((key, offset) => known.set(key, previous.length + offset));
  keyIndexes.set(nextLayout, known);
  return { layout: nextLayout, changed };
}

/**
 * Persists the difference between `before` (what the database holds) and
 * `after`, stamping every written row and removal with `version`. Runs inside
 * the writer's transaction, under the cvg_runtime_state row lock.
 */
export async function writeEntityState(client: EntityQueryable, before: StoreState, after: StoreState, version: number): Promise<void> {
  const upserts: { collection: EntityCollection; entity_key: string; position: number; data: unknown }[] = [];
  const removals: { collection: EntityCollection; entity_key: string }[] = [];
  for (const collection of ENTITY_COLLECTIONS) {
    const previous = before[collection] as readonly unknown[];
    const next = after[collection] as unknown[];
    if (previous === next) continue;
    const layout = await layoutFor(client, collection, previous);
    const fast = appendOrReplace(collection, previous, next, layout);
    if (fast) {
      for (const index of fast.changed) {
        upserts.push({ collection, entity_key: fast.layout.keys[index], position: fast.layout.positions[index], data: next[index] });
      }
      layouts.set(next, fast.layout);
      continue;
    }
    const previousIndex = new Map<string, number>();
    layout.keys.forEach((key, index) => previousIndex.set(key, index));
    const keys = next.map((entry) => entityKey(collection, entry));
    if (new Set(keys).size !== keys.length) throw new Error(`POSTGRES_ENTITY_KEY_DUPLICATE:${collection}`);
    let highest = layout.positions.reduce((max, value) => Math.max(max, value), 0);
    let last = 0;
    let reordered = false;
    const positions: number[] = [];
    for (let index = 0; index < next.length; index += 1) {
      const existing = previousIndex.get(keys[index]);
      const assigned = existing === undefined ? (highest += 1) : layout.positions[existing];
      if (assigned <= last) {
        reordered = true;
        break;
      }
      positions.push(assigned);
      last = assigned;
    }
    if (reordered) {
      // Not produced by the application today; kept correct rather than fast.
      positions.length = 0;
      next.forEach((entry, index) => {
        positions.push(index + 1);
        upserts.push({ collection, entity_key: keys[index], position: index + 1, data: entry });
      });
    } else {
      next.forEach((entry, index) => {
        const existing = previousIndex.get(keys[index]);
        if (existing === undefined || previous[existing] !== entry) {
          upserts.push({ collection, entity_key: keys[index], position: positions[index], data: entry });
        }
      });
    }
    const retained = new Set(keys);
    for (const key of layout.keys) if (!retained.has(key)) removals.push({ collection, entity_key: key });
    remember(next, keys, positions);
  }
  if (removals.length > 0) {
    const removed = await client.query(DELETE_SQL, [JSON.stringify(removals), version]);
    if (removed.rowCount !== removals.length) throw new Error("POSTGRES_ENTITY_STATE_DIVERGED:removal");
  }
  for (let start = 0; start < upserts.length; start += UPSERT_BATCH_SIZE) {
    const batch = upserts.slice(start, start + UPSERT_BATCH_SIZE);
    const written = await client.query(UPSERT_SQL, [JSON.stringify(batch), version]);
    if (written.rowCount !== batch.length) throw new Error("POSTGRES_ENTITY_STATE_DIVERGED:upsert");
  }
}
