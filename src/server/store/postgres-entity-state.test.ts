import { describe, expect, it } from "vitest";
import type { IdempotencyRecord, StoreState } from "../domain/models";
import { FakeEntityDatabase } from "../../test/fake-entity-database";
import { createDemoState } from "./fixtures";
import { freezeState } from "./immutable-state";
import { ENTITY_COLLECTIONS, entityKey, loadEntityState, refreshEntityState, stateHeader, writeEntityState, type EntityQueryable } from "./postgres-entity-state";

function demo(): StoreState {
  return createDemoState("entity-state-unit-password");
}

function client(database: FakeEntityDatabase): EntityQueryable {
  return {
    query: async (text, values) => {
      const result = database.handle(text, values ?? []);
      if (!result) throw new Error(`Unexpected SQL: ${text}`);
      return result;
    }
  };
}

function record(actorId: string, scope: string, key: string): IdempotencyRecord {
  return { actorId, scope, key, payloadHash: "hash", response: { ok: true }, createdAt: "2026-10-08T00:00:00.000Z" };
}

async function loaded(state: StoreState = demo(), version = 1) {
  const database = new FakeEntityDatabase(state, version);
  const snapshot = await loadEntityState(client(database));
  return { database, snapshot: { state: freezeState(snapshot.state), version: snapshot.version } };
}

/** Applies a write the way PostgresStore does: header first, then the entity diff. */
async function commit(database: FakeEntityDatabase, before: StoreState, after: StoreState): Promise<number> {
  const updated = database.handle("UPDATE cvg_runtime_state SET state = $1::jsonb, version = version + 1, updated_at = now() WHERE id = 1 RETURNING version", [JSON.stringify(stateHeader(after))]);
  const version = Number((updated?.rows[0] as { version: string }).version);
  await writeEntityState(client(database), before, after, version);
  return version;
}

describe("entity keys and the persisted header", () => {
  it("keys idempotency records by the JSON triple and everything else by id", () => {
    expect(entityKey("users", { id: "user-1" })).toBe("user-1");
    expect(entityKey("idempotency", record("a\"b", "scope:x", "k,1"))).toBe(JSON.stringify(["a\"b", "scope:x", "k,1"]));
    const sameRecord = record("actor", "scope", "key");
    expect(entityKey("idempotency", sameRecord)).toBe(entityKey("idempotency", sameRecord));
  });

  it.each([{}, { id: "" }, { id: 7 }, null])("rejects an entity without a usable key (%#)", (entity) => {
    expect(() => entityKey("items", entity)).toThrow("POSTGRES_ENTITY_KEY_INVALID:items");
  });

  it("empties every entity collection, the audit and the outbox and keeps scalars", () => {
    const state = demo();
    const header = stateHeader(state);
    for (const collection of ENTITY_COLLECTIONS) expect(header[collection]).toEqual([]);
    expect(header.auditEvents).toEqual([]);
    expect(header.outbox).toEqual([]);
    expect(header.protocolSequence).toBe(state.protocolSequence);
    expect(state.users.length).toBeGreaterThan(0);
  });
});

describe("loading entity rows", () => {
  it("reassembles the exact aggregate in position order", async () => {
    const state = demo();
    const { snapshot, database } = await loaded(state, 4);
    expect(snapshot).toEqual({ state: { ...state, auditEvents: [], outbox: [] }, version: 4 });
    expect(database.statements).toEqual(["header", "entities:all"]);
  });

  it("takes the header row lock when asked", async () => {
    const database = new FakeEntityDatabase(demo());
    await loadEntityState(client(database), { lock: true });
    expect(database.statements[0]).toBe("header:lock");
  });

  it.each([
    { rows: [], rowCount: 0, message: "row is missing" },
    { rows: [{ state: stateHeader(demo()), version: "1", entity_removal_floor: "-1" }], rowCount: 1, message: "removal floor" },
    { rows: [{ state: stateHeader(demo()), version: "0", entity_removal_floor: "0" }], rowCount: 1, message: "version" }
  ])("fails closed on an invalid header ($message)", async ({ rows, rowCount, message }) => {
    await expect(loadEntityState({ query: async () => ({ rows, rowCount }) })).rejects.toThrow(message);
  });

  it.each([
    [{ collection: "unknown", entity_key: "x", position: "1", data: {} }, "POSTGRES_ENTITY_COLLECTION_INVALID"],
    [{ collection: "users", entity_key: "x", position: "0", data: {} }, "POSTGRES_ENTITY_POSITION_INVALID"]
  ])("rejects an invalid entity row (%#)", async (row, message) => {
    const header = { state: stateHeader(demo()), version: "1", entity_removal_floor: "0" };
    let call = 0;
    const source: EntityQueryable = { query: async () => (call++ === 0 ? { rows: [header], rowCount: 1 } : { rows: [row], rowCount: 1 }) };
    await expect(loadEntityState(source)).rejects.toThrow(message);
  });
});

describe("writing the difference", () => {
  it("writes nothing for collections whose array identity is unchanged", async () => {
    const { database, snapshot } = await loaded();
    const next = { ...snapshot.state, protocolSequence: snapshot.state.protocolSequence + 1 };
    await commit(database, snapshot.state, next);
    expect(database.statements.filter((statement) => statement === "upsert" || statement === "delete")).toEqual([]);
    expect(database.state()).toEqual(next);
  });

  it("rewrites only the replaced entity at its position and stamps the new version", async () => {
    const { database, snapshot } = await loaded();
    const target = snapshot.state.users[1];
    const next = { ...snapshot.state, users: snapshot.state.users.map((user) => user.id === target.id ? { ...user, displayName: "Renamed" } : user) };
    const version = await commit(database, snapshot.state, next);
    expect(database.rows.get(`users\u0000${target.id}`)).toMatchObject({ position: 2, written_version: version, data: { displayName: "Renamed" } });
    expect([...database.rows.values()].filter((row) => row.written_version === version)).toHaveLength(1);
    expect(database.state()).toEqual(next);
  });

  it("appends after the highest position and records removals with their version", async () => {
    const { database, snapshot } = await loaded();
    const [removed, ...kept] = snapshot.state.patients;
    const appended = { ...removed, id: "patient-appended" };
    const next = { ...snapshot.state, patients: [...kept, appended] };
    const version = await commit(database, snapshot.state, next);
    expect(database.rows.get("patients\u0000patient-appended")?.position).toBe(snapshot.state.patients.length + 1);
    expect(database.removals).toEqual([expect.objectContaining({ removed_version: version, collection: "patients", entity_key: removed.id })]);
    expect(database.state()).toEqual(next);
  });

  it("renumbers a collection whose order changed", async () => {
    const { database, snapshot } = await loaded();
    const reversed = [...snapshot.state.services].reverse();
    const next = { ...snapshot.state, services: reversed };
    await commit(database, snapshot.state, next);
    expect(database.state().services.map((service) => service.id)).toEqual(reversed.map((service) => service.id));
    expect([...database.rows.values()].filter((row) => row.collection === "services").map((row) => row.position).sort()).toEqual(reversed.map((_, index) => index + 1));
  });

  it("inserts in the middle by renumbering, never by reusing a position", async () => {
    const { database, snapshot } = await loaded();
    const [first, ...rest] = snapshot.state.reasonCodes;
    const inserted = { ...first, id: "reason-inserted" };
    const next = { ...snapshot.state, reasonCodes: [first, inserted, ...rest] };
    await commit(database, snapshot.state, next);
    expect(database.state().reasonCodes.map((reason) => reason.id)).toEqual(next.reasonCodes.map((reason) => reason.id));
  });

  it("rejects duplicate keys before writing anything", async () => {
    const { database, snapshot } = await loaded();
    const next = { ...snapshot.state, users: [...snapshot.state.users, snapshot.state.users[0]] };
    await expect(writeEntityState(client(database), snapshot.state, next, 2)).rejects.toThrow("POSTGRES_ENTITY_KEY_DUPLICATE:users");
    expect(database.statements).not.toContain("upsert");
  });

  it("reads persisted positions for a base that did not come from a load", async () => {
    const state = demo();
    const database = new FakeEntityDatabase(state);
    const next = { ...state, users: [...state.users, { ...state.users[0], id: "user-new" }] };
    await writeEntityState(client(database), state, next, 2);
    expect(database.statements).toContain("layout");
    expect(database.state().users.map((user) => user.id)).toEqual(next.users.map((user) => user.id));
  });

  it("fails closed when that base disagrees with the persisted rows", async () => {
    const state = demo();
    const database = new FakeEntityDatabase({ ...state, users: state.users.slice(1) });
    await expect(writeEntityState(client(database), state, { ...state, users: [] }, 2)).rejects.toThrow("POSTGRES_ENTITY_STATE_DIVERGED:users");
  });

  it("fails closed when a removal or an upsert does not match the rows it expected", async () => {
    const { database, snapshot } = await loaded();
    database.rows.delete(`users\u0000${snapshot.state.users[0].id}`);
    await expect(writeEntityState(client(database), snapshot.state, { ...snapshot.state, users: snapshot.state.users.slice(1) }, 2))
      .rejects.toThrow("POSTGRES_ENTITY_STATE_DIVERGED:removal");
    const short: EntityQueryable = { query: async () => ({ rows: [], rowCount: 0 }) };
    const fresh = await loaded();
    await expect(writeEntityState(short, fresh.snapshot.state, { ...fresh.snapshot.state, users: [...fresh.snapshot.state.users, { ...fresh.snapshot.state.users[0], id: "user-x" }] }, 2))
      .rejects.toThrow("POSTGRES_ENTITY_STATE_DIVERGED:upsert");
  });

  it("batches large upserts", async () => {
    const { database, snapshot } = await loaded();
    const extra = Array.from({ length: 4_500 }, (_, index) => record("actor", "scope", `key-${index}`));
    const next = { ...snapshot.state, idempotency: extra };
    await commit(database, snapshot.state, next);
    expect(database.statements.filter((statement) => statement === "upsert")).toHaveLength(3);
    expect(database.state().idempotency).toEqual(extra);
  });
});

describe("refreshing incrementally", () => {
  it("returns the same snapshot when the version did not move", async () => {
    const { database, snapshot } = await loaded();
    database.statements.length = 0;
    await expect(refreshEntityState(client(database), snapshot)).resolves.toBe(snapshot);
    expect(database.statements).toEqual(["header"]);
  });

  it("applies replaced, appended, removed and re-added rows and keeps untouched arrays", async () => {
    const { database, snapshot } = await loaded();
    const writer = await loadEntityState(client(database));
    const [gone, renamed, ...rest] = writer.state.users;
    const step1 = { ...writer.state, users: [{ ...renamed, displayName: "Renamed" }, ...rest, { ...gone, id: "user-late" }] };
    await commit(database, writer.state, step1);
    const step2 = { ...step1, users: [...step1.users, gone], protocolSequence: 99 };
    await commit(database, step1, step2);
    database.statements.length = 0;

    const refreshed = await refreshEntityState(client(database), snapshot);
    expect(refreshed).toEqual({ state: database.state(), version: database.version });
    expect(refreshed.state.patients).toBe(snapshot.state.patients);
    expect(refreshed.state.users).not.toBe(snapshot.state.users);
    expect(database.statements).toEqual(["header", "entities:changed", "removals"]);
    // The refreshed arrays carry their layout: the next refresh is incremental too.
    const step3 = { ...step2, users: step2.users.slice(1) };
    await commit(database, step2, step3);
    database.statements.length = 0;
    await expect(refreshEntityState(client(database), refreshed)).resolves.toEqual({ state: database.state(), version: database.version });
    expect(database.statements).not.toContain("entities:all");
  });

  it("reloads everything when the removals it needs were pruned", async () => {
    const { database, snapshot } = await loaded();
    const writer = await loadEntityState(client(database));
    await commit(database, writer.state, { ...writer.state, users: writer.state.users.slice(1) });
    database.removalFloor = database.version;
    database.statements.length = 0;
    await expect(refreshEntityState(client(database), snapshot)).resolves.toEqual({ state: database.state(), version: database.version });
    expect(database.statements).toContain("entities:all");
  });

  it("keeps a newer base for a reader that started before a local commit, and reloads a restored database otherwise", async () => {
    const { database, snapshot } = await loaded(demo(), 5);
    const ahead = { state: snapshot.state, version: 9 };
    await expect(refreshEntityState(client(database), ahead, { keepNewerBase: true })).resolves.toBe(ahead);
    database.statements.length = 0;
    await expect(refreshEntityState(client(database), ahead)).resolves.toEqual({ state: database.state(), version: 5 });
    expect(database.statements).toContain("entities:all");
  });

  it("reloads everything when the base has no recorded layout", async () => {
    const state = demo();
    const database = new FakeEntityDatabase(state, 1);
    const writer = await loadEntityState(client(database));
    await commit(database, writer.state, { ...writer.state, users: writer.state.users.slice(1) });
    database.statements.length = 0;
    await expect(refreshEntityState(client(database), { state, version: 1 })).resolves.toEqual({ state: database.state(), version: 2 });
    expect(database.statements).toContain("entities:all");
  });

  it.each(["entities:changed", "removals"])("rejects an unknown collection in %s", async (statement) => {
    const { database, snapshot } = await loaded();
    const writer = await loadEntityState(client(database));
    await commit(database, writer.state, { ...writer.state, users: writer.state.users.slice(1) });
    const bad: EntityQueryable = {
      query: async (text, values) => {
        const result = database.handle(text, values ?? []);
        const label = database.statements.at(-1);
        if (label === statement) return { rowCount: 1, rows: [{ collection: "unknown", entity_key: "x", position: "1", data: {} }] };
        return result!;
      }
    };
    await expect(refreshEntityState(bad, snapshot)).rejects.toThrow("POSTGRES_ENTITY_COLLECTION_INVALID:unknown");
  });
});
