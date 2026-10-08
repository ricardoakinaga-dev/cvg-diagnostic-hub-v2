import { describe, expect, it } from "vitest";
import { API_HANDLER_GROUPS, API_HANDLER_REGISTRY } from "../../app/api/v1/[...path]/operation-handlers";
import { API_OPERATIONS } from "./api-operation-manifest";
import { createApiHandlerRegistry, type ApiHandlerEntry } from "./api-handler-registry";

type PublicContext = { correlationId: string };
type SessionContext = PublicContext & { userId: string };
type Entry = ApiHandlerEntry<PublicContext, SessionContext>;
const publicEntry: Entry = { authentication: "public", handle: ({ correlationId }) => new Response(correlationId) };
const sessionEntry: Entry = { authentication: "session", handle: async ({ userId }) => new Response(userId, { status: 201 }) };
const operations = [
  { operationId: "live", authentication: "public" },
  { operationId: "read", authentication: "session" }
] as const;
const create = (groups: ReadonlyArray<Record<string, Entry>>) => createApiHandlerRegistry<PublicContext, SessionContext>(operations, groups);

describe("pure API handler registry", () => {
  it("resolves sync public and async session handlers with their respective contexts", async () => {
    const registry = create([{ live: publicEntry }, { read: sessionEntry }]);
    const live = registry.resolve("live");
    const read = registry.resolve("read");
    expect(live.authentication).toBe("public");
    expect(read.authentication).toBe("session");
    if (live.authentication !== "public" || read.authentication !== "session") throw new Error("incorrect authentication");
    expect(await (await live.handle({ correlationId: "corr-live" })).text()).toBe("corr-live");
    const response = await read.handle({ correlationId: "corr-read", userId: "actor-1" });
    expect(response.status).toBe(201);
    expect(await response.text()).toBe("actor-1");
  });

  it("freezes registry, key list and copied descriptors independently of caller-owned groups", () => {
    const original = { ...publicEntry };
    const group: Record<string, Entry> = { live: original, read: sessionEntry };
    const registry = create([group]);
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.operationIds)).toBe(true);
    expect(Object.isFrozen(registry.resolve("live"))).toBe(true);
    expect(Object.isFrozen(registry.resolve("read"))).toBe(true);
    expect(registry.resolve("live")).not.toBe(original);
    original.handle = () => new Response("replacement");
    group.read = publicEntry;
    expect(registry.resolve("live").handle).toBe(publicEntry.handle);
    expect(registry.resolve("read").authentication).toBe("session");
    expect(() => Object.defineProperty(registry.resolve("live"), "handle", { value: original.handle })).toThrow(TypeError);
    expect(() => Object.defineProperty(registry.operationIds, "0", { value: "replacement" })).toThrow(TypeError);
  });

  it("rejects missing, duplicate, unknown and authentication-mismatched entries with exact safe errors", () => {
    expect(() => create([{ live: publicEntry }])).toThrow("API_HANDLER_MISSING:read");
    expect(() => create([{ live: publicEntry, read: sessionEntry }, { live: publicEntry }])).toThrow("API_HANDLER_DUPLICATE:live");
    expect(() => create([{ live: publicEntry, read: sessionEntry, extra: publicEntry }])).toThrow("API_HANDLER_UNKNOWN:extra");
    expect(() => create([{ live: sessionEntry, read: sessionEntry }])).toThrow("API_HANDLER_AUTHENTICATION:live");
    expect(() => create([{ live: publicEntry, read: publicEntry }])).toThrow("API_HANDLER_AUTHENTICATION:read");
    expect(() => createApiHandlerRegistry([...operations, operations[0]], [{ live: publicEntry, read: sessionEntry }])).toThrow("API_OPERATION_DUPLICATE:live");
  });

  it.each([null, undefined, {}, { handle: "secret-noncallable" }, { handle: 7 }])("rejects malformed descriptors without serializing their contents (%j)", (invalid) => {
    const group = { live: invalid, read: sessionEntry } as unknown as Record<string, Entry>;
    expect(() => create([group])).toThrow(new Error("API_HANDLER_INVALID:live"));
  });

  it("supports an empty manifest while rejecting every undeclared resolution", () => {
    const registry = createApiHandlerRegistry<PublicContext, SessionContext>([], []);
    expect(registry.operationIds).toEqual([]);
    expect(() => registry.resolve("live")).toThrow(new Error("API_HANDLER_MISSING:live"));
  });

  it("ignores inherited handlers when checking manifest completeness", () => {
    const group = Object.create({ live: publicEntry }) as Record<string, Entry>;
    group.read = sessionEntry;
    expect(() => create([group])).toThrow(new Error("API_HANDLER_MISSING:live"));
  });

  it.each(["constructor", "__proto__", "toString"])("rejects inherited lookup key %s unless explicitly registered in the manifest", (operationId) => {
    const registry = create([{ live: publicEntry, read: sessionEntry }]);
    expect(() => registry.resolve(operationId)).toThrow(new Error(`API_HANDLER_MISSING:${operationId}`));
    const group = { [operationId]: publicEntry };
    const explicit = createApiHandlerRegistry([{ operationId, authentication: "public" }], [group]);
    expect(explicit.operationIds).toEqual([operationId]);
    expect(explicit.resolve(operationId).handle).toBe(publicEntry.handle);
    expect(() => createApiHandlerRegistry([], [group])).toThrow(new Error(`API_HANDLER_UNKNOWN:${operationId}`));
  });
});

describe("production operation handler registry", () => {
  it("contains exactly all 78 manifest operations without duplicate group entries", () => {
    const expected = API_OPERATIONS.map(({ operationId }) => operationId).sort();
    const actual = API_HANDLER_GROUPS.flatMap((group) => Object.keys(group));
    expect(expected).toHaveLength(78);
    expect(new Set(actual).size).toBe(78);
    expect([...actual].sort()).toEqual(expected);
    expect([...API_HANDLER_REGISTRY.operationIds].sort()).toEqual(expected);
    expect(Object.isFrozen(API_HANDLER_REGISTRY)).toBe(true);
    expect(Object.isFrozen(API_HANDLER_REGISTRY.operationIds)).toBe(true);
  });

  it.each(API_OPERATIONS)("resolves $operationId to a frozen callable $authentication descriptor", ({ operationId, authentication }) => {
    const descriptor = API_HANDLER_REGISTRY.resolve(operationId);
    expect(descriptor.authentication).toBe(authentication);
    expect(typeof descriptor.handle).toBe("function");
    expect(Object.isFrozen(descriptor)).toBe(true);
  });

  it("fails startup when a real manifest operation is removed from production groups", () => {
    const removedId = "createDiagnosticRequest";
    const incomplete = API_HANDLER_GROUPS.map((group) => Object.fromEntries(Object.entries(group).filter(([id]) => id !== removedId)));
    expect(() => createApiHandlerRegistry(API_OPERATIONS, incomplete)).toThrow(new Error(`API_HANDLER_MISSING:${removedId}`));
  });
});
