import { describe, expect, test } from "vitest";
import { freezeState } from "../store/immutable-state";
import type { DiagnosticItem, DiagnosticRequest, Encounter, IdempotencyRecord, Notification, Result, ResultVersion, Sample, Session, StoreState } from "./models";
import {
  encountersForPatient,
  findById,
  idempotencyRecordFor,
  itemsForRequest,
  notificationForDedupe,
  positionOfId,
  requestsForPatient,
  resultsForItem,
  resultVersionsForResult,
  samplesForItem,
  sessionForTokenHash
} from "./state-index";

// Only the fields the index reads matter here.
const entity = <T>(value: Record<string, unknown>): T => value as T;

function state(): StoreState {
  return entity<StoreState>({
    requests: [
      entity<DiagnosticRequest>({ id: "request-1", patientId: "patient-a" }),
      entity<DiagnosticRequest>({ id: "request-2", patientId: "patient-b" }),
      entity<DiagnosticRequest>({ id: "request-3", patientId: "patient-a" })
    ],
    items: [
      entity<DiagnosticItem>({ id: "item-1", requestId: "request-1", status: "REQUESTED" }),
      entity<DiagnosticItem>({ id: "item-2", requestId: "request-2", status: "REQUESTED" }),
      entity<DiagnosticItem>({ id: "item-3", requestId: "request-1", status: "REQUESTED" }),
      entity<DiagnosticItem>({ id: "item-4", requestId: "request-3", status: "REQUESTED" })
    ],
    encounters: [
      entity<Encounter>({ id: "encounter-1", patientId: "patient-a" }),
      entity<Encounter>({ id: "encounter-2", patientId: "patient-b" })
    ],
    samples: [
      entity<Sample>({ id: "sample-1", itemIds: ["item-1", "item-3"] }),
      entity<Sample>({ id: "sample-2", itemIds: ["item-2", "item-2"] }),
      entity<Sample>({ id: "sample-3", itemIds: ["item-3"] })
    ],
    results: [
      entity<Result>({ id: "result-1", itemId: "item-1" }),
      entity<Result>({ id: "result-2", itemId: "item-1" })
    ],
    resultVersions: [
      entity<ResultVersion>({ id: "version-1", resultId: "result-1" }),
      entity<ResultVersion>({ id: "version-2", resultId: "result-2" }),
      entity<ResultVersion>({ id: "version-3", resultId: "result-1" })
    ],
    notifications: [
      entity<Notification>({ id: "notification-1", recipientUserId: "user-a", dedupeKey: "key-1" }),
      entity<Notification>({ id: "notification-2", recipientUserId: "user-a", dedupeKey: "key-1" })
    ],
    sessions: [entity<Session>({ id: "session-1", userId: "user-a", tokenHash: "hash-1" })],
    idempotency: [
      entity<IdempotencyRecord>({ actorId: "a:b", scope: "c", key: "k" }),
      entity<IdempotencyRecord>({ actorId: "a", scope: "b:c", key: "k" })
    ]
  });
}

describe("state index", () => {
  test("id lookups match a linear scan on frozen and mutable arrays", () => {
    for (const current of [state(), freezeState(state())]) {
      for (const item of current.items) {
        expect(findById(current.items, item.id)).toBe(current.items.find((entry) => entry.id === item.id));
        expect(positionOfId(current.items, item.id)).toBe(current.items.findIndex((entry) => entry.id === item.id));
      }
      expect(findById(current.items, "missing")).toBeUndefined();
      expect(findById(current.items, undefined)).toBeUndefined();
      expect(positionOfId(current.items, "missing")).toBe(-1);
    }
  });

  test("the first entry wins when an id repeats, as with find", () => {
    const first = { id: "dup", label: "first" };
    const second = { id: "dup", label: "second" };
    const entries = Object.freeze([first, second]);
    expect(findById(entries, "dup")).toBe(first);
    expect(positionOfId(entries, "dup")).toBe(0);
  });

  test("groups keep array order and match filter on frozen and mutable arrays", () => {
    for (const current of [state(), freezeState(state())]) {
      expect(requestsForPatient(current, "patient-a").map(({ id }) => id)).toEqual(["request-1", "request-3"]);
      expect(encountersForPatient(current, "patient-b").map(({ id }) => id)).toEqual(["encounter-2"]);
      expect(itemsForRequest(current, "request-1").map(({ id }) => id)).toEqual(["item-1", "item-3"]);
      expect(samplesForItem(current, "item-3").map(({ id }) => id)).toEqual(["sample-1", "sample-3"]);
      expect(resultsForItem(current, "item-1").map(({ id }) => id)).toEqual(["result-1", "result-2"]);
      expect(resultVersionsForResult(current, "result-1").map(({ id }) => id)).toEqual(["version-1", "version-3"]);
      expect(requestsForPatient(current, "missing")).toEqual([]);
    }
  });

  test("an entry listing the same key twice appears once in that group", () => {
    expect(samplesForItem(freezeState(state()), "item-2").map(({ id }) => id)).toEqual(["sample-2"]);
  });

  test("cached groups cannot be mutated by callers", () => {
    const current = freezeState(state());
    expect(() => (requestsForPatient(current, "patient-a") as unknown[]).push({})).toThrow(TypeError);
    expect(() => (requestsForPatient(current, "missing") as unknown[]).push({})).toThrow(TypeError);
  });

  test("composite keys cannot collide through a separator", () => {
    const current = freezeState(state());
    expect(idempotencyRecordFor(current, "a:b", "c", "k")?.scope).toBe("c");
    expect(idempotencyRecordFor(current, "a", "b:c", "k")?.scope).toBe("b:c");
    expect(idempotencyRecordFor(current, "a", "b", "c:k")).toBeUndefined();
  });

  test("dedupe and session lookups return the first match", () => {
    const current = freezeState(state());
    expect(notificationForDedupe(current, "user-a", "key-1")?.id).toBe("notification-1");
    expect(notificationForDedupe(current, "user-b", "key-1")).toBeUndefined();
    expect(sessionForTokenHash(current, "hash-1")?.id).toBe("session-1");
    expect(sessionForTokenHash(current, "hash-2")).toBeUndefined();
  });

  test("a replaced array is indexed afresh while the previous snapshot keeps its own index", () => {
    const before = freezeState(state());
    const original = findById(before.items, "item-1");
    const replaced = entity<DiagnosticItem>({ id: "item-1", requestId: "request-1", status: "CANCELLED" });
    const after = freezeState({ ...before, items: before.items.map((entry) => entry.id === "item-1" ? replaced : entry) });
    expect(findById(after.items, "item-1")).toBe(replaced);
    expect(findById(before.items, "item-1")).toBe(original);
    const appended = entity<DiagnosticItem>({ id: "item-5", requestId: "request-1", status: "REQUESTED" });
    const grown = freezeState({ ...after, items: [...after.items, appended] });
    expect(findById(grown.items, "item-5")).toBe(appended);
    expect(itemsForRequest(grown, "request-1").map(({ id }) => id)).toEqual(["item-1", "item-3", "item-5"]);
    expect(itemsForRequest(after, "request-1").map(({ id }) => id)).toEqual(["item-1", "item-3"]);
  });

  test("arrays still under construction are scanned, never cached", () => {
    const items = [...state().items];
    expect(findById(items, "late")).toBeUndefined();
    items.push(entity<DiagnosticItem>({ id: "late", requestId: "request-1" }));
    expect(findById(items, "late")?.id).toBe("late");
    expect(itemsForRequest({ items }, "request-1").map(({ id }) => id)).toEqual(["item-1", "item-3", "late"]);
  });
});
