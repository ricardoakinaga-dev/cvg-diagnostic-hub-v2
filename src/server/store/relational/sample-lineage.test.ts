import { describe, expect, it } from "vitest";
import type { DiagnosticItem, Sample, StoreState } from "../../domain/models";
import { createDemoState } from "../fixtures";
import { sampleItemLink, sampleLinkProjections, sampleLinkStatus, sampleTimestamp } from "./sample-lineage";

const requestedAt = "2026-09-06T10:00:00.000Z";
const collectedAt = "2026-09-06T11:00:00.000Z";
const receivedAt = "2026-09-06T12:00:00.000Z";
const base = createDemoState("sample-lineage-unit-password");
const item: DiagnosticItem = {
  id: "item-a", requestId: "request-a", serviceId: "service-cbc", departmentCode: "LABORATORY",
  workflowType: "LABORATORY", priority: "ROUTINE", status: "REQUESTED", requestedAt,
  slaStartedAt: requestedAt, dueAt: receivedAt, slaPolicyVersion: 1, version: 1
};
const sample: Sample = {
  id: "sample-a", requestId: "request-a", accessionCode: "ACC-A", sampleType: "EDTA",
  status: "EXPECTED", itemIds: [item.id], version: 1
};

function state(samples: Sample[], items: DiagnosticItem[] = [item]): StoreState {
  return { ...structuredClone(base), samples, items };
}

describe("relational sample lineage boundaries", () => {
  it.each([
    ["EXPECTED", "ACTIVE"], ["RECEIVED", "ACTIVE"], ["REJECTED", "REJECTED"], ["REPLACED", "REPLACED"]
  ] as const)("maps sample status %s to link status %s", (status, expected) => {
    expect(sampleLinkStatus(status)).toBe(expected);
  });

  it("uses receipt before collection before the first resolvable item's request time", () => {
    const withMissingItem = { ...sample, itemIds: ["missing", item.id] };
    expect(sampleTimestamp(withMissingItem, { items: [item] })).toBe(requestedAt);
    expect(sampleTimestamp({ ...withMissingItem, collectedAt }, { items: [item] })).toBe(collectedAt);
    expect(sampleTimestamp({ ...withMissingItem, collectedAt, receivedAt }, { items: [item] })).toBe(receivedAt);
    expect(sampleTimestamp({ ...sample, itemIds: [], receivedAt }, { items: [] })).toBe(receivedAt);
    expect(() => sampleTimestamp(withMissingItem, { items: [] }))
      .toThrow("POSTGRES_RELATIONAL_UNMAPPABLE_STATE:samples.created_at:sample-a");
  });

  it("retains linkage identity, actor and rejection evidence while timestamps follow receipt priority", () => {
    expect(sampleItemLink(sample, item)).toEqual({
      id: "sample-item-link:sample-a:item-a", sample_id: sample.id, item_id: item.id,
      request_id: sample.requestId, link_status: "ACTIVE", linked_at: requestedAt,
      linked_by: null, rejection_note: null, version: 1
    });
    expect(sampleItemLink({ ...sample, collectedAt }, item).linked_at).toBe(collectedAt);
    expect(sampleItemLink({ ...sample, status: "REJECTED", collectedAt, receivedAt,
      receivedBy: "user-lab", rejectionNote: "Insufficient volume", version: 2 }, item)).toMatchObject({
      link_status: "REJECTED", linked_at: receivedAt, linked_by: "user-lab",
      rejection_note: "Insufficient volume", version: 2
    });
  });

  it("inserts new memberships, emits no write for unchanged links and uses the prior version for rejection updates", () => {
    const inserted = sampleLinkProjections(state([]), state([sample]));
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ table: "sample_item_links", id: "sample-item-link:sample-a:item-a", version: 1, expectedVersion: undefined });
    expect(inserted[0].insertValues).toEqual([
      "sample-item-link:sample-a:item-a", "sample-a", "item-a", "request-a", "ACTIVE", requestedAt, null, null, 1
    ]);
    expect(sampleLinkProjections(state([sample]), state([structuredClone(sample)]))).toEqual([]);

    const rejected: Sample = { ...sample, status: "REJECTED", receivedAt, receivedBy: "user-lab", rejectionNote: "Hemolysis", version: 2 };
    const updates = sampleLinkProjections(state([sample]), state([rejected]));
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ version: 2, expectedVersion: 1 });
    expect(updates[0].updateSql).toContain("WHERE id = $1 AND version = $10");
    expect(updates[0].updateValues).toEqual([
      "sample-item-link:sample-a:item-a", "sample-a", "item-a", "request-a", "REJECTED", receivedAt, "user-lab", "Hemolysis", 2, 1
    ]);
  });

  it.each(["missing", "other request"])("rejects a %s item instead of projecting a foreign membership", (failure) => {
    const items = failure === "missing" ? [] : [{ ...item, requestId: "request-b" }];
    expect(() => sampleLinkProjections(state([]), state([sample], items)))
      .toThrow("POSTGRES_RELATIONAL_UNMAPPABLE_STATE:sample_item_links:sample-a");
    expect(sampleLinkProjections(state([]), state([sample]))).toHaveLength(1);
  });

  it("rejects additions and removals on an existing sample while permitting new samples", () => {
    const secondItem = { ...item, id: "item-b" };
    expect(() => sampleLinkProjections(state([sample]), state([{ ...sample, itemIds: [item.id, secondItem.id] }], [item, secondItem])))
      .toThrow("POSTGRES_RELATIONAL_LINK_ADDITION_UNSUPPORTED:sample-a:item-b");
    expect(() => sampleLinkProjections(state([sample]), state([{ ...sample, itemIds: [] }])))
      .toThrow("POSTGRES_RELATIONAL_LINK_REMOVAL_UNSUPPORTED:sample-a:item-a");
    expect(() => sampleLinkProjections(state([sample]), state([])))
      .toThrow("POSTGRES_RELATIONAL_DELETION_UNSUPPORTED:samples:sample-a");
    expect(sampleLinkProjections(state([]), state([{ ...sample, itemIds: [item.id, secondItem.id] }], [item, secondItem])))
      .toHaveLength(2);
  });

  it("can update an existing link from the current item when the prior snapshot lacks that item", () => {
    const updates = sampleLinkProjections(state([sample], []), state([{ ...sample, status: "REPLACED", version: 2 }]));
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ expectedVersion: 1, version: 2 });
    expect(updates[0].updateValues).toEqual([
      "sample-item-link:sample-a:item-a", "sample-a", "item-a", "request-a", "REPLACED", requestedAt, null, null, 2, 1
    ]);
  });
});
