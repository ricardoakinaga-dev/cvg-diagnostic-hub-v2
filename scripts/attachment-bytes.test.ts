import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifySelectedAttachmentBytes } from "./attachment-bytes";

function reference(storageKey: string, content: string) {
  return { storageKey, checksum: createHash("sha256").update(content).digest("hex"), sizeBytes: Buffer.byteLength(content), uploadStatus: "FINALIZED" };
}

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
