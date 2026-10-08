import { describe, expect, it } from "vitest";
import type { StoreState } from "./models";
import { createDemoState } from "../store/fixtures";
import { ARCHIVE_NOW, OLD, RECENT, withCompletedRequest, type CompletedRequestOptions } from "../../test/archive-fixtures";
import { archiveCutoff, partitionArchive, selectArchivableRequests } from "./clinical-archive-policy";

const options = { now: ARCHIVE_NOW, activeMonths: 24 };

function baseState(): StoreState {
  return createDemoState("archive-policy-password");
}

function selected(state: StoreState): string[] {
  return selectArchivableRequests(state, options);
}

function single(override: CompletedRequestOptions = {}): StoreState {
  return withCompletedRequest(baseState(), "a", override);
}

describe("archiveCutoff", () => {
  it("subtracts calendar months in UTC", () => {
    expect(archiveCutoff(ARCHIVE_NOW, 24).toISOString()).toBe("2024-10-08T12:00:00.000Z");
    expect(archiveCutoff(new Date("2026-03-31T00:00:00.000Z"), 1).getUTCMonth()).toBe(2);
  });
});

describe("selectArchivableRequests", () => {
  it("selects completed and cancelled requests older than the active window", () => {
    expect(selected(single())).toEqual(["request-a"]);
    expect(selected(single({ aggregateStatus: "CANCELLED", itemStatus: "CANCELLED" }))).toEqual(["request-a"]);
  });

  it("keeps requests inside the window, including the exact cutoff instant", () => {
    expect(selected(single({ at: RECENT }))).toEqual([]);
    expect(selected(single({ at: "2024-10-08T12:00:00.000Z" }))).toEqual([]);
    expect(selected(single({ at: "2024-10-08T11:59:59.000Z" }))).toEqual(["request-a"]);
  });

  it("never archives anything when archiving is disabled or misconfigured", () => {
    expect(selectArchivableRequests(single(), { now: ARCHIVE_NOW, activeMonths: 0 })).toEqual([]);
    expect(selectArchivableRequests(single(), { now: ARCHIVE_NOW, activeMonths: -3 })).toEqual([]);
    expect(selectArchivableRequests(single(), { now: ARCHIVE_NOW, activeMonths: 1.5 })).toEqual([]);
  });

  it("requires a final aggregate status", () => {
    expect(selected(single({ aggregateStatus: "IN_PROGRESS" }))).toEqual([]);
    expect(selected(single({ aggregateStatus: "RESULTS_AVAILABLE" }))).toEqual([]);
  });

  it("requires every item to be terminal", () => {
    expect(selected(single({ itemStatus: "RESULT_AVAILABLE" }))).toEqual([]);
    const state = single();
    const mixed = { ...state, items: state.items.map((item, index) => (index === 1 ? { ...item, status: "IN_PROGRESS" as const } : item)) };
    expect(selected(mixed)).toEqual([]);
  });

  it("archives a voided item whose every result is voided and has no draft", () => {
    const state = single();
    const voidedItem = state.items[0];
    const tweaked: StoreState = {
      ...state,
      items: state.items.map((item) => (item.id === voidedItem.id ? { ...item, status: "RESULT_VOIDED" as const } : item)),
      results: state.results.map((result) => ({ ...result, lifecycleStatus: "VOIDED" as const }))
    };
    expect(selected(tweaked)).toEqual(["request-a"]);
    // A newer draft means the item will be worked again.
    const withDraft: StoreState = { ...tweaked, resultVersions: [...tweaked.resultVersions, { ...tweaked.resultVersions[0], id: "version-a-3", status: "DRAFT", sequence: 3, releasedAt: undefined }] };
    expect(selected(withDraft)).toEqual([]);
    // A voided item without any result record is inconsistent: keep it.
    expect(selected({ ...tweaked, results: [] })).toEqual([]);
    // A result that is not voided keeps the item active.
    expect(selected({ ...tweaked, results: tweaked.results.map((result) => ({ ...result, lifecycleStatus: "RELEASED" as const })) })).toEqual([]);
  });

  it("uses every timestamp it can rely on", () => {
    const state = single();
    expect(selected({ ...state, requests: state.requests.map((request) => ({ ...request, updatedAt: RECENT })) })).toEqual([]);
    expect(selected({ ...state, requests: state.requests.map((request) => ({ ...request, updatedAt: "not-a-date" })) })).toEqual([]);
    expect(selected({ ...state, items: state.items.map((item) => ({ ...item, completedAt: RECENT })) })).toEqual([]);
    expect(selected({ ...state, items: state.items.map((item) => ({ ...item, completedAt: "garbage" })) })).toEqual([]);
    // Cancelled items carry no completedAt; the request timestamp decides.
    expect(selected({ ...state, items: state.items.map((item) => ({ ...item, completedAt: undefined })) })).toEqual(["request-a"]);
  });

  it("keeps a request with a recent amendment or an unreadable version date", () => {
    const state = single();
    const amended = (patch: object) => ({ ...state, resultVersions: state.resultVersions.map((version, index) => (index === 1 ? { ...version, ...patch } : version)) });
    expect(selected(amended({ releasedAt: RECENT }))).toEqual([]);
    expect(selected(amended({ createdAt: RECENT }))).toEqual([]);
    expect(selected(amended({ createdAt: "garbage" }))).toEqual([]);
    expect(selected(amended({ releasedAt: "garbage" }))).toEqual([]);
    expect(selected(amended({ releasedAt: undefined }))).toEqual(["request-a"]);
  });

  it("is blocked by open notifications reaching the request through any entity type", () => {
    for (const notificationState of ["PENDING", "DELIVERED", "SEEN", "ESCALATED"] as const) {
      expect(selected(single({ notificationState }))).toEqual([]);
    }
    for (const notificationState of ["ACKNOWLEDGED", "FAILED", "SUPERSEDED"] as const) {
      expect(selected(single({ notificationState }))).toEqual(["request-a"]);
    }
    const state = single({ notificationState: "PENDING" });
    const pointing = (entityType: "REQUEST" | "ITEM" | "SAMPLE", entityId: string) => ({ ...state, notifications: state.notifications.map((notification) => ({ ...notification, entityType, entityId })) });
    expect(selected(pointing("REQUEST", "request-a"))).toEqual([]);
    expect(selected(pointing("ITEM", "item-lab-a"))).toEqual([]);
    expect(selected(pointing("SAMPLE", "sample-a"))).toEqual([]);
    // An open notification about something unknown blocks nothing.
    expect(selected(pointing("ITEM", "item-missing"))).toEqual(["request-a"]);
  });

  it("is blocked by attachments that are not finalized", () => {
    expect(selected(single({ attachmentStatus: "INITIATED" }))).toEqual([]);
    expect(selected(single({ attachmentStatus: "UPLOADED" }))).toEqual([]);
    expect(selected(single({ attachmentStatus: "FINALIZED" }))).toEqual(["request-a"]);
  });

  it("rejects requests whose item list is inconsistent with the items collection", () => {
    const state = single();
    expect(selected({ ...state, requests: state.requests.map((request) => ({ ...request, itemIds: [] })) })).toEqual([]);
    expect(selected({ ...state, requests: state.requests.map((request) => ({ ...request, itemIds: ["item-lab-a", "item-ghost"] })) })).toEqual([]);
    expect(selected({ ...state, requests: state.requests.map((request) => ({ ...request, itemIds: ["item-lab-a", "item-lab-a"] })) })).toEqual([]);
    expect(selected({ ...state, items: [] })).toEqual([]);
  });

  it("selects independently per request", () => {
    let state = withCompletedRequest(baseState(), "old");
    state = withCompletedRequest(state, "new", { at: RECENT });
    state = withCompletedRequest(state, "open", { aggregateStatus: "IN_PROGRESS" });
    expect(selected(state)).toEqual(["request-old"]);
  });
});

describe("partitionArchive", () => {
  it("moves a request with everything that hangs off it and shares untouched arrays", () => {
    let state = withCompletedRequest(baseState(), "old");
    state = withCompletedRequest(state, "new", { at: RECENT });
    const partition = partitionArchive(state, ["request-old"]);

    expect(partition.requestIds).toEqual(["request-old"]);
    const byCollection = (name: string) => partition.entities.filter((entry) => entry.collection === name).map((entry) => entry.entityKey);
    expect(byCollection("requests")).toEqual(["request-old"]);
    expect(byCollection("items")).toEqual(["item-lab-old", "item-rx-old"]);
    expect(byCollection("samples")).toEqual(["sample-old"]);
    expect(byCollection("procedures")).toEqual(["procedure-old"]);
    expect(byCollection("schedules")).toEqual(["schedule-old"]);
    expect(byCollection("results")).toEqual(["result-old"]);
    expect(byCollection("resultVersions")).toEqual(["version-old-1", "version-old-2"]);
    expect(byCollection("notifications")).toEqual(["notification-old"]);
    expect(byCollection("attachments")).toEqual(["attachment-old"]);
    expect(partition.attachmentCount).toBe(1);
    expect(partition.entities.every((entry) => entry.requestId === "request-old")).toBe(true);

    expect(partition.state.requests.map((request) => request.id)).toEqual(["request-new"]);
    expect(partition.state.items.map((item) => item.id)).toEqual(["item-lab-new", "item-rx-new"]);
    expect(partition.state.resultVersions.map((version) => version.id)).toEqual(["version-new-1", "version-new-2"]);
    // Collections that never move keep their identity.
    for (const name of ["users", "patients", "encounters", "admissions", "services", "reasonCodes", "sessions", "idempotency", "auditEvents", "outbox"] as const) {
      expect(partition.state[name]).toBe(state[name]);
    }
  });

  it("records the original 1-based position of each moved entity", () => {
    let state = withCompletedRequest(baseState(), "first", { at: RECENT });
    state = withCompletedRequest(state, "second");
    const partition = partitionArchive(state, ["request-second"]);
    expect(partition.entities.find((entry) => entry.entityKey === "item-lab-second")?.position).toBe(3);
    expect(partition.entities.find((entry) => entry.entityKey === "request-second")?.position).toBe(2);
  });

  it("leaves the state untouched for unknown or empty selections", () => {
    const state = withCompletedRequest(baseState(), "old");
    for (const ids of [[], ["request-missing"]]) {
      const partition = partitionArchive(state, ids);
      expect(partition.entities).toEqual([]);
      expect(partition.requestIds).toEqual([]);
      expect(partition.state.requests).toBe(state.requests);
      expect(partition.state.items).toBe(state.items);
    }
  });

  it("keeps entities that cannot be tied to a selected request", () => {
    const state = withCompletedRequest(baseState(), "old");
    const orphan = { ...state.notifications[0], id: "notification-orphan", entityId: "unknown", entityType: "ITEM" as const };
    const stray = { ...state.attachments[0], id: "attachment-stray", resultVersionId: "version-unknown" };
    const partition = partitionArchive({ ...state, notifications: [...state.notifications, orphan], attachments: [...state.attachments, stray] }, ["request-old"]);
    expect(partition.state.notifications.map((notification) => notification.id)).toEqual(["notification-orphan"]);
    expect(partition.state.attachments.map((attachment) => attachment.id)).toEqual(["attachment-stray"]);
  });

  it("is deterministic with the OLD fixture date", () => {
    expect(Date.parse(OLD)).toBeLessThan(archiveCutoff(ARCHIVE_NOW, 24).getTime());
  });
});
