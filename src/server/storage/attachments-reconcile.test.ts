import { describe, expect, it } from "vitest";
import { reconcileAttachments } from "./attachments-reconcile";

const finalized = (id: string, storageKey: string) => ({ id, storageKey, uploadStatus: "FINALIZED" as const });
const pending = (id: string, storageKey: string, uploadClaimToken?: string) => ({ id, storageKey, uploadStatus: "UPLOADED" as const, uploadClaimToken });

describe("attachments reconciliation (PROD-514, D-057)", () => {
  it("accepts a bucket that holds exactly the finalized and archived objects, ignoring the hardening probe", () => {
    const report = reconcileAttachments(
      [finalized("att-1", "attachments/a"), finalized("att-2", "attachments/b"), pending("att-3", "attachments/c", "tok")],
      [{ requestId: "req-old", storageKey: "attachments/old" }],
      ["attachments/a", "attachments/b", "attachments/old", ".cvg-bucket-probe/x", "attachments/c.claim-tok"]
    );
    expect(report.ok).toBe(true);
    expect(report.counts).toEqual({ active: 3, finalized: 2, pending: 1, archived: 1, objects: 4, expectedObjects: 3 });
    expect(report.pendingWithoutObject).toBe(0);
  });

  it("reports missing objects of finalized and archived attachments, sorted, and orphan objects", () => {
    const report = reconcileAttachments(
      [finalized("att-b", "attachments/b"), finalized("att-a", "attachments/a"), pending("att-p", "attachments/p")],
      [{ requestId: "req-old", storageKey: "attachments/old-key-123456" }],
      ["attachments/a", "attachments/stray"]
    );
    expect(report.ok).toBe(false);
    expect(report.missingObjects).toEqual([{ id: "att-b", source: "active" }, { id: "req-old:attachments/old-key-123456", source: "archive" }]);
    expect(report.orphanObjects).toBe(1);
    // A pending upload without an object is a normal state, counted but never a failure by itself.
    expect(report.pendingWithoutObject).toBe(1);
    expect(reconcileAttachments([pending("att-p", "attachments/p")], [], []).ok).toBe(true);
  });

  it("counts an archived key once even when several archive rows repeat it", () => {
    const report = reconcileAttachments([], [{ requestId: "r1", storageKey: "k" }, { requestId: "r1", storageKey: "k" }], ["k"]);
    expect(report.counts.archived).toBe(1);
    expect(report.ok).toBe(true);
  });
});
