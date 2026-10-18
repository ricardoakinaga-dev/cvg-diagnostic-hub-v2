import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifySelectedAttachmentBytes } from "./attachment-bytes";
import { activeAttachmentReferences } from "./attachment-references";
import { planAttachmentRestore } from "../src/server/storage/attachments-restore-plan";
import { reconcileAttachments } from "../src/server/storage/attachments-reconcile";
import type { Attachment } from "../src/server/domain/models";
import type { HospitalTaskAttachment } from "@cvg/contracts";

function reference(storageKey: string, content: string) {
  return { storageKey, checksum: createHash("sha256").update(content).digest("hex"), sizeBytes: Buffer.byteLength(content), uploadStatus: "FINALIZED" };
}

function recoveryLedgers() {
  const diagnostic: Attachment = { ...reference("attachments/diagnostic", "diagnostic bytes"), id: "diagnostic", resultVersionId: "version", safeName: "diagnostic.pdf", detectedMime: "application/pdf", scanStatus: "CLEAN", uploadStatus: "FINALIZED", createdBy: "synthetic-user", createdAt: "2026-10-11T00:00:00Z" };
  const task: HospitalTaskAttachment = { ...reference("hospital-tasks/task/final.pdf", "task bytes"), id: "task-file", taskId: "task", safeName: "final.pdf", declaredMime: "application/pdf", scanStatus: "CLEAN", uploadStatus: "FINALIZED", expiresAt: "2026-10-12T00:00:00Z", createdBy: "synthetic-user", createdAt: "2026-10-11T00:00:00Z", updatedAt: "2026-10-11T00:00:00Z", version: 3 };
  return { attachments: [diagnostic], hospitalTaskAttachments: [task] };
}

test("restore combines native diagnostic, task and archive authorities and keeps unreferenced off-site history outside the live bucket", async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), "cvg-hospital-ledger-bytes-"));
  try {
    const state = recoveryLedgers(); const before = structuredClone(state);
    const archived = { ...reference("attachments/archive", "archive bytes"), requestId: "archived-request" };
    const references = activeAttachmentReferences(state);
    const available = [...references.map((entry) => entry.storageKey), archived.storageKey, "deleted-evidence"];
    const plan = planAttachmentRestore(references, [archived], available);
    assert.equal(plan.ok, true); assert.deepEqual(plan.selectedObjectKeys, available.slice(0, -1).sort());
    assert.deepEqual(plan.excludedObjectKeys, ["deleted-evidence"]);
    for (const [key, content] of [[references[0].storageKey, "diagnostic bytes"], [references[1].storageKey, "task bytes"], [archived.storageKey, "archive bytes"]]) {
      await mkdir(path.dirname(path.join(source, key)), { recursive: true }); await writeFile(path.join(source, key), content);
    }
    assert.deepEqual(await verifySelectedAttachmentBytes(source, plan.selectedObjectKeys, [...references, archived]), { ok: true, verifiedObjects: 3, failures: [] });
    assert.deepEqual(reconcileAttachments(references, [archived], plan.selectedObjectKeys).counts, { active: 2, finalized: 2, pending: 0, archived: 1, objects: 3, expectedObjects: 3 });
    assert.deepEqual(state, before);
  } finally { await rm(source, { recursive: true, force: true }); }
});

test("a task row is ready only after clean finalization; legitimate unapproved and in-flight bytes remain optional references", () => {
  const state = recoveryLedgers(); state.attachments = [];
  const task = state.hospitalTaskAttachments[0];
  state.hospitalTaskAttachments = [
    { ...task, id: "quarantine", storageKey: "hospital-tasks/quarantine", scanStatus: "QUARANTINED", uploadStatus: "UPLOADED" },
    { ...task, id: "failed", storageKey: "hospital-tasks/failed", scanStatus: "FAILED", uploadStatus: "UPLOADED" },
    { ...task, id: "inconsistent", storageKey: "hospital-tasks/inconsistent", scanStatus: "QUARANTINED", uploadStatus: "FINALIZED" },
    { ...task, id: "claim", storageKey: "hospital-tasks/pending", scanStatus: "PENDING", uploadStatus: "INITIATED", uploadClaimToken: "synthetic-claim" }
  ];
  const before = structuredClone(state); const references = activeAttachmentReferences(state);
  const available = ["hospital-tasks/quarantine", "hospital-tasks/failed", "hospital-tasks/inconsistent", "hospital-tasks/pending.claim-synthetic-claim"];
  const plan = planAttachmentRestore(references, [], available);
  assert.equal(plan.ok, true); assert.deepEqual(plan.selectedObjectKeys, [...available].sort());
  assert.deepEqual(reconcileAttachments(references, [], available).counts, { active: 4, finalized: 0, pending: 4, archived: 0, objects: 4, expectedObjects: 0 });
  assert.equal(reconcileAttachments(references, [], []).pendingWithoutObject, 4);
  assert.equal(planAttachmentRestore(references, [], []).ok, true);
  assert.deepEqual(state, before); // Even inconsistent recovered metadata is never approved by restoration.
});

test("restore validates every active and archived selected object against recovered metadata", async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), "cvg-attachment-bytes-"));
  try {
    await mkdir(path.join(source, "attachments"));
    await writeFile(path.join(source, "attachments/active"), "active bytes");
    await writeFile(path.join(source, "attachments/archive"), "archive bytes");
    await writeFile(path.join(source, "attachments/deleted"), "retained evidence");
    assert.deepEqual(await verifySelectedAttachmentBytes(source, ["attachments/active", "attachments/archive"], [
      reference("attachments/active", "active bytes"), reference("attachments/archive", "archive bytes")
    ]), { ok: true, verifiedObjects: 2, failures: [] });
  } finally { await rm(source, { recursive: true, force: true }); }
});

test("same-key wrong bytes, truncation and missing/conflicting metadata fail closed", async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), "cvg-attachment-bytes-"));
  try {
    await writeFile(path.join(source, "wrong"), "altered bytes!");
    await writeFile(path.join(source, "short"), "short");
    await writeFile(path.join(source, "invalid"), "bytes");
    await writeFile(path.join(source, "conflict"), "one");
    const result = await verifySelectedAttachmentBytes(source, ["wrong", "short", "invalid", "conflict"], [
      reference("wrong", "expected bytes"), reference("short", "expected bytes"),
      { storageKey: "invalid", checksum: undefined, sizeBytes: undefined },
      reference("conflict", "one"), reference("conflict", "two")
    ]);
    assert.deepEqual(result, { ok: false, verifiedObjects: 0, failures: [
      { storageKey: "wrong", reason: "CHECKSUM_MISMATCH" }, { storageKey: "short", reason: "SIZE_MISMATCH" },
      { storageKey: "invalid", reason: "INVALID_OR_MISSING_METADATA" }, { storageKey: "conflict", reason: "METADATA_CONFLICT" }
    ] });
  } finally { await rm(source, { recursive: true, force: true }); }
});

test("pending claim bytes are verified if selected; absent pending uploads remain optional", async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), "cvg-attachment-bytes-"));
  try {
    await writeFile(path.join(source, "pending.claim-token"), "pending bytes");
    const pending = { ...reference("pending", "pending bytes"), uploadStatus: "INITIATED", uploadClaimToken: "token" };
    assert.deepEqual(await verifySelectedAttachmentBytes(source, ["pending.claim-token"], [pending]), { ok: true, verifiedObjects: 1, failures: [] });
    assert.deepEqual(await verifySelectedAttachmentBytes(source, [], [pending]), { ok: true, verifiedObjects: 0, failures: [] });
  } finally { await rm(source, { recursive: true, force: true }); }
});

test("unreferenced objects, symlinks and path escapes cannot pass byte verification", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "cvg-attachment-bytes-"));
  const source = path.join(base, "evidence");
  try {
    await mkdir(source);
    await writeFile(path.join(base, "outside"), "outside bytes");
    await symlink(path.join(base, "outside"), path.join(source, "link"));
    await symlink(base, path.join(source, "nested"));
    const result = await verifySelectedAttachmentBytes(source, ["unreferenced", "link", "../outside", "nested/outside"], [
      reference("link", "outside bytes"), reference("../outside", "outside bytes"), reference("nested/outside", "outside bytes")
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.verifiedObjects, 0);
    assert.deepEqual(result.failures.map(failure => failure.reason), ["INVALID_OR_MISSING_METADATA",
      "UNREADABLE_OR_NOT_REGULAR", "UNREADABLE_OR_NOT_REGULAR", "UNREADABLE_OR_NOT_REGULAR"]);
  } finally { await rm(base, { recursive: true, force: true }); }
});
