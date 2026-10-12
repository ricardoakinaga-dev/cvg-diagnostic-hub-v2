import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { FileStore } from "../../src/server/storage/file-store";
import { createDemoState } from "../../src/server/store/fixtures";
import { createApplicationService } from "../../src/server/application/service";
import { createHospitalTaskAttachmentService } from "../../src/server/application/hospital-task-attachment-service";
import { withDisposablePostgresDatabase, type DisposablePostgresDatabase } from "../support/postgres-test-harness";

const execute = promisify(execFile);
const REPO = process.cwd();
const bytes = Buffer.from("%PDF-1.7\nSynthetic hospital recovery file\n");

async function fixture(database: DisposablePostgresDatabase) {
  const store = await database.createStore(createDemoState("task-recovery-synthetic-password"));
  const files = new Map<string, Buffer>();
  const storage: FileStore = {
    put: async (key, content) => { files.set(key, Buffer.from(content)); },
    get: async (key) => { const content = files.get(key); if (!content) throw new Error("synthetic missing object"); return content; },
    remove: async (key) => { files.delete(key); }, exists: async (key) => files.has(key)
  };
  let scanStatus: "CLEAN" | "QUARANTINED" | "FAILED" = "CLEAN";
  const service = {
    ...createApplicationService(store, { storage }),
    ...createHospitalTaskAttachmentService({ store, storage, scanner: { scan: async () => scanStatus }, patientDiagnosticsAuxiliaryReader: () => ({ samples: [], results: [], attachments: [] }) })
  };
  const actor = (await store.readState()).users.find((user) => user.role === "VETERINARIAN")!;
  const task = await service.createHospitalTask(actor, { title: "Synthetic recovery activity", typeId: "hospital-task-type-routine", departmentCode: "INPATIENT", priority: "ROUTINE", responsibleUserId: actor.id, idempotencyKey: "recovery-task" });
  const upload = async (key: string, status: typeof scanStatus, finalize = false) => {
    scanStatus = status;
    const prepared = await service.createHospitalTaskAttachmentSession(actor, task.task.id, { filename: `${key}.pdf`, mimeType: "application/pdf", sizeBytes: bytes.length, checksum: createHash("sha256").update(bytes).digest("hex"), expectedVersion: 1, idempotencyKey: key });
    await service.uploadHospitalTaskAttachment(actor, prepared.attachment.id, bytes);
    if (finalize) await service.finalizeHospitalTaskAttachment(actor, prepared.attachment.id, { expectedVersion: 2, idempotencyKey: `${key}-finalize` });
    return (await store.readState()).hospitalTaskAttachments.find((entry) => entry.id === prepared.attachment.id)!;
  };
  return { store, service, actor, task, storage, files, upload };
}

function cliEnvironment(database: DisposablePostgresDatabase): NodeJS.ProcessEnv {
  // Explicit synthetic connection only: no inherited .env or secret-file paths.
  return { PATH: process.env.PATH, NODE_ENV: "test", APP_DATA_MODE: "postgres", DATABASE_URL: database.connectionString(), DB_POOL_MAX: "1" };
}
async function runScript(name: string, args: string[], environment: NodeJS.ProcessEnv) {
  try {
    const result = await execute(process.execPath, ["--import", "tsx", path.join(REPO, "scripts", name), ...args], { cwd: REPO, env: environment, timeout: 20_000, maxBuffer: 1024 * 1024 });
    return { code: 0, ...result };
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "number" || !("stdout" in error) || !("stderr" in error)) throw error;
    return { code: error.code, stdout: String(error.stdout), stderr: String(error.stderr) };
  }
}
async function evidenceFiles(directory: string, files: ReadonlyMap<string, Buffer>) {
  for (const [key, content] of files) { await mkdir(path.dirname(path.join(directory, key)), { recursive: true }); await writeFile(path.join(directory, key), content); }
}
async function reconcile(database: DisposablePostgresDatabase, keys: readonly string[]) {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/xml");
    response.end(`<?xml version="1.0"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>synthetic-recovery</Name><IsTruncated>false</IsTruncated>${keys.map((key) => `<Contents><Key>${key.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</Key></Contents>`).join("")}</ListBucketResult>`);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  try {
    const address = server.address(); if (!address || typeof address === "string") throw new Error("synthetic S3 listener missing");
    return await runScript("attachments-reconcile.ts", [], { ...cliEnvironment(database), STORAGE_ENDPOINT: `http://127.0.0.1:${address.port}`, STORAGE_BUCKET: "synthetic-recovery", STORAGE_ACCESS_KEY: "synthetic-only", STORAGE_SECRET_KEY: "synthetic-only", STORAGE_FORCE_PATH_STYLE: "true" });
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

describe("BLD-HPL-011/037 native task attachment recovery scripts", () => {
  it("selects the real finalized object of an archived task and reconciles it, preserving metadata and current download access after copying", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const f = await fixture(database); const directory = await mkdtemp(path.join(os.tmpdir(), "cvg-task-recovery-"));
      try {
        const attachment = await f.upload("ready", "CLEAN", true);
        await f.service.commandHospitalTask(f.actor, f.task.task.id, { command: "START", expectedVersion: 1, idempotencyKey: "start-before-archive" });
        await f.service.commandHospitalTask(f.actor, f.task.task.id, { command: "COMPLETE", expectedVersion: 2, idempotencyKey: "complete-before-archive" });
        const archived = await f.service.setHospitalTaskArchived(f.actor, f.task.task.id, { archived: true, expectedVersion: 3, idempotencyKey: "archive-before-recovery" });
        expect(archived.task.archivedAt).toBeDefined();
        const before = await f.store.readState();
        const source = path.join(directory, "evidence"); await mkdir(source); await evidenceFiles(source, f.files);
        await writeFile(path.join(source, "later-deleted-object"), "retained off-site evidence");
        const output = path.join(directory, "selected.list"); const report = path.join(directory, "plan.json");
        const result = await runScript("attachments-restore-plan.ts", ["--source", source, "--output", output, "--report", report], cliEnvironment(database));
        expect(result.code, result.stderr).toBe(0);
        expect(await readFile(output, "utf8")).toBe(`${attachment.storageKey}\n`);
        const plan = JSON.parse(await readFile(report, "utf8"));
        expect(plan).toMatchObject({ ok: true, selectedObjectKeys: [attachment.storageKey], excludedObjectKeys: ["later-deleted-object"], integrity: { ok: true, verifiedObjects: 1 } });
        expect(await f.store.readState()).toEqual(before);
        f.files.clear(); // loss of the original bucket; copy only the approved selection
        for (const key of plan.selectedObjectKeys) f.files.set(key, await readFile(path.join(source, key)));
        expect((await f.service.downloadHospitalTaskAttachment(f.actor, attachment.id)).content).toEqual(bytes);
        const afterDownload = await f.store.readState();
        const reconciled = await reconcile(database, [...f.files.keys()]);
        expect(reconciled.code, reconciled.stderr).toBe(0);
        expect(JSON.parse(reconciled.stdout)).toMatchObject({ event: "attachments.reconciled", counts: { active: 1, finalized: 1, expectedObjects: 1 }, missingObjects: [], orphanObjects: 0 });
        expect(await f.store.readState()).toEqual(afterDownload);
        expect(await readFile(path.join(source, "later-deleted-object"), "utf8")).toBe("retained off-site evidence");
      } finally { await database.closeStore(f.store); await rm(directory, { recursive: true, force: true }); }
    });
  });

  it("preserves referenced quarantine, failed and unfinished uploads as optional bytes without promoting or exposing them", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const f = await fixture(database); const directory = await mkdtemp(path.join(os.tmpdir(), "cvg-task-pending-recovery-"));
      try {
        const quarantined = await f.upload("quarantine", "QUARANTINED"); const failed = await f.upload("failed", "FAILED"); const uploaded = await f.upload("not-finalized", "CLEAN");
        await f.service.createHospitalTaskAttachmentSession(f.actor, f.task.task.id, { filename: "absent.pdf", mimeType: "application/pdf", sizeBytes: bytes.length, checksum: createHash("sha256").update(bytes).digest("hex"), expectedVersion: 1, idempotencyKey: "absent" });
        const before = await f.store.readState();
        const source = path.join(directory, "evidence"); await mkdir(source); await evidenceFiles(source, f.files);
        const output = path.join(directory, "selected.list"); const report = path.join(directory, "plan.json");
        const result = await runScript("attachments-restore-plan.ts", ["--source", source, "--output", output, "--report", report], cliEnvironment(database));
        expect(result.code, result.stderr).toBe(0);
        expect((await readFile(output, "utf8")).trim().split("\n").sort()).toEqual([...f.files.keys()].sort());
        const reconciled = await reconcile(database, [...f.files.keys()]);
        expect(reconciled.code, reconciled.stderr).toBe(0);
        expect(JSON.parse(reconciled.stdout)).toMatchObject({ counts: { finalized: 0, pending: 4, expectedObjects: 0 }, orphanObjects: 0, pendingWithoutObject: 1 });
        for (const row of [quarantined, failed, uploaded]) await expect(f.service.downloadHospitalTaskAttachment(f.actor, row.id)).rejects.toMatchObject({ status: 404 });
        const absent = await reconcile(database, []);
        expect(absent.code, absent.stderr).toBe(0);
        expect(JSON.parse(absent.stdout)).toMatchObject({ counts: { finalized: 0, pending: 4 }, pendingWithoutObject: 4 });
        expect(await f.store.readState()).toEqual(before);
      } finally { await database.closeStore(f.store); await rm(directory, { recursive: true, force: true }); }
    });
  });

  it("blocks a missing or same-size corrupted finalized task object, and detects an orphan without deleting evidence", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const f = await fixture(database); const directory = await mkdtemp(path.join(os.tmpdir(), "cvg-task-corrupt-recovery-"));
      try {
        const attachment = await f.upload("ready", "CLEAN", true);
        const source = path.join(directory, "evidence"); await mkdir(source);
        const missingOutput = path.join(directory, "missing.list"); const missingReport = path.join(directory, "missing.json");
        const missing = await runScript("attachments-restore-plan.ts", ["--source", source, "--output", missingOutput, "--report", missingReport], cliEnvironment(database));
        expect(missing.code).toBe(2);
        expect(JSON.parse(await readFile(missingReport, "utf8"))).toMatchObject({ ok: false, missingObjects: [{ id: attachment.id, source: "active" }] });
        await expect(access(missingOutput)).rejects.toMatchObject({ code: "ENOENT" });
        const corrupt = Buffer.from(bytes); corrupt[corrupt.length - 2] ^= 1;
        await evidenceFiles(source, new Map([[attachment.storageKey, corrupt]]));
        const corruptOutput = path.join(directory, "corrupt.list"); const corruptReport = path.join(directory, "corrupt.json");
        const result = await runScript("attachments-restore-plan.ts", ["--source", source, "--output", corruptOutput, "--report", corruptReport], cliEnvironment(database));
        expect(result.code).toBe(2);
        expect(JSON.parse(await readFile(corruptReport, "utf8"))).toMatchObject({ ok: false, integrity: { ok: false, failures: [{ storageKey: attachment.storageKey, reason: "CHECKSUM_MISMATCH" }] } });
        await expect(access(corruptOutput)).rejects.toMatchObject({ code: "ENOENT" });
        const reconciled = await reconcile(database, ["unreferenced-synthetic-object"]);
        expect(reconciled.code).toBe(1);
        expect(JSON.parse(reconciled.stdout)).toMatchObject({ event: "attachments.divergent", missingObjects: [{ id: attachment.id, source: "active" }], orphanObjects: 1 });
        expect(await readFile(path.join(source, attachment.storageKey))).toEqual(corrupt);
      } finally { await database.closeStore(f.store); await rm(directory, { recursive: true, force: true }); }
    });
  });
});
