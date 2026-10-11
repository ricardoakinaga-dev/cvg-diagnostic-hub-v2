import { describe, expect, it } from "vitest";
import { planAttachmentRestore } from "./attachments-restore-plan";
import { reconcileAttachments } from "./attachments-reconcile";

const finalized = (id: string, storageKey: string) => ({ id, storageKey, uploadStatus: "FINALIZED" as const });

describe("attachment restore selection at the recovered database instant", () => {
  it("restores a deleted attachment before its deletion and excludes it afterwards without deleting its evidence", () => {
    const offsite = ["attachments/expired", "attachments/current", "attachments/future"];
    const before = [finalized("expired", "attachments/expired"), finalized("current", "attachments/current")];
    const after = [before[1]];
    const early = planAttachmentRestore(before, [], offsite);
    expect(early.ok).toBe(true);
    expect(early.selectedObjectKeys).toEqual(["attachments/current", "attachments/expired"]);
    expect(early.excludedObjectKeys).toEqual(["attachments/future"]);
    const late = planAttachmentRestore(after, [], offsite);
    expect(late.ok).toBe(true);
    expect(late.selectedObjectKeys).toEqual(["attachments/current"]);
    expect(late.excludedObjectKeys).toEqual(["attachments/expired", "attachments/future"]);
    expect(reconcileAttachments(after, [], late.selectedObjectKeys).ok).toBe(true);
    expect(offsite).toEqual(["attachments/expired", "attachments/current", "attachments/future"]);
  });

  it("requires archived content before purge, excludes it after purge, and refuses missing clinical bytes", () => {
    const archived = [{ requestId: "old", storageKey: "attachments/archive" }];
    expect(planAttachmentRestore([], archived, ["attachments/archive"]).selectedObjectKeys).toEqual(["attachments/archive"]);
    expect(planAttachmentRestore([], [], ["attachments/archive"]).excludedObjectKeys).toEqual(["attachments/archive"]);
    const missing = planAttachmentRestore([finalized("current", "attachments/current")], archived, []);
    expect(missing.ok).toBe(false);
    expect(missing.missingObjects).toEqual([{ id: "current", source: "active" }, { id: "old:attachments/archive", source: "archive" }]);
  });

  it("preserves existing pending claim bytes, allows absent pending objects and ignores bucket probes", () => {
    const active = [{ id: "pending", storageKey: "attachments/pending", uploadStatus: "UPLOADED" as const, uploadClaimToken: "token" }];
    expect(planAttachmentRestore(active, [], ["attachments/pending.claim-token", ".cvg-bucket-probe/test"]).selectedObjectKeys)
      .toEqual(["attachments/pending.claim-token"]);
    expect(planAttachmentRestore(active, [], []).ok).toBe(true);
  });

  it.each(["/absolute", "attachments/../escape", "attachments/./same", "attachments//empty", "attachments/bad\nline", "attachments/\\path", "attachments/\u0000key"])
    ("refuses keys that cannot safely be used by rclone: %s", key => {
      expect(() => planAttachmentRestore([finalized("unsafe", key)], [], [key])).toThrow(/insegura/);
      expect(() => planAttachmentRestore([], [], [key])).toThrow(/insegura/);
    });
});
