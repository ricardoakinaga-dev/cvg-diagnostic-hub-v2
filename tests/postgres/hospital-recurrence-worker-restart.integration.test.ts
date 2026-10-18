import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clearTimeout as clearDeadline, setTimeout as scheduleDeadline } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createApplicationService } from "../../src/server/application/service";
import { createDemoState } from "../../src/server/store/fixtures";
import { withDisposablePostgresDatabase, type DisposablePostgresDatabase } from "../support/postgres-test-harness";

type WorkerEvent = { event: string; generated?: number; alreadyGenerated?: number; blocked?: number; pending?: number; heartbeat?: { lastResult?: string } };

function startWorker(database: DisposablePostgresDatabase, directory: string, sequence: number) {
  const heartbeat = path.join(directory, `heartbeat-${sequence}.json`);
  // Only this disposable database and temporary storage are available to the child.
  // Do not inherit application credentials, .env values, file secrets or external endpoints.
  const child = spawn(process.execPath, ["--import", "tsx", path.resolve("scripts/outbox-worker.ts")], {
    cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, NODE_ENV: "test", APP_DATA_MODE: "postgres", DATABASE_URL: database.connectionString(), DB_POOL_MAX: "2", OUTBOX_DB_POOL_MAX: "1", OUTBOX_SINK: "postgres", OUTBOX_INTERVAL_MS: "100", OUTBOX_WORKER_ID: `synthetic-recurrence-${sequence}`, OUTBOX_HEARTBEAT_FILE: heartbeat, STORAGE_MODE: "local", STORAGE_ROOT: path.join(directory, "objects"), ARCHIVE_ACTIVE_MONTHS: "0" }
  });
  const events: WorkerEvent[] = []; let spawnFailed = false;
  const consume = (stream: NonNullable<typeof child.stdout>) => {
    let pending = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      pending += chunk;
      let newline: number;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        try { const event = JSON.parse(line) as WorkerEvent; if (typeof event.event === "string") events.push(event); } catch { /* Non-JSON diagnostics cannot contain a batch confirmation. */ }
      }
    });
  };
  consume(child.stdout); consume(child.stderr);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("error", () => { spawnFailed = true; resolve({ code: 1, signal: null }); });
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  async function waitForEvent(predicate: (event: WorkerEvent) => boolean) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const found = events.find(predicate); if (found) return found;
      if (spawnFailed || child.exitCode !== null || child.signalCode !== null) break;
      await delay(25);
    }
    throw new Error(`Real worker did not confirm the expected batch; observed event names: ${events.map((event) => event.event).join(",")}`);
  }
  async function stop() {
    if (child.exitCode === null && child.signalCode === null && !spawnFailed) child.kill("SIGTERM");
    let timeout: Parameters<typeof clearDeadline>[0];
    try {
      const result = await Promise.race([exited, new Promise<undefined>((resolve) => { timeout = scheduleDeadline(resolve, 5_000); })]);
      if (!result) { child.kill("SIGKILL"); await exited; throw new Error("Real recurrence worker did not stop within the shutdown budget."); }
      expect(result).toEqual({ code: 0, signal: null });
    } finally { clearDeadline(timeout); }
  }
  return { pid: child.pid, heartbeat, events, waitForEvent, stop };
}

describe("BLD-HPL-034 actual worker downtime and restart", () => {
  it("recovers occurrences that became due while stopped, commits each once and preserves a blocked cursor across another restart", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const base = createDemoState("synthetic-recurrence-worker-only");
      const store = await database.createStore(base);
      const directory = await mkdtemp(path.join(os.tmpdir(), "cvg-recurrence-worker-"));
      const workers: ReturnType<typeof startWorker>[] = [];
      try {
        const idle = startWorker(database, directory, 1); workers.push(idle);
        await idle.waitForEvent((event) => event.event === "outbox.batch" && event.heartbeat?.lastResult === "success");
        await idle.stop(); // The real process is absent before the configured times arrive.
        const service = createApplicationService(store);
        const admin = base.users.find((user) => user.id === "user-admin")!;
        const vet = base.users.find((user) => user.id === "user-vet")!;
        const approved = [];
        for (const code of ["WORKER_OPERATIONAL", "WORKER_WILL_RETIRE"]) {
          const draft = await service.createHospitalChecklistTemplate(admin, { code, name: "Modelo operacional sintético, sem protocolo clínico", departmentCode: "INPATIENT", careContextRequired: false, steps: [{ code: "VERIFY", label: "Conferência operacional sintética", required: true, evidenceRequired: false }], idempotencyKey: `create-${code}` });
          approved.push(await service.approveHospitalChecklistTemplate(vet, draft.template.id, { expectedVersion: draft.template.version, idempotencyKey: `approve-${code}` }));
        }
        const dueAt = Date.now() + 2_000;
        const startAt = new Date(dueAt).toISOString(); const endAt = new Date(dueAt + 1).toISOString();
        const recurrences = [];
        for (let index = 0; index < 3; index += 1) {
          recurrences.push(await service.createHospitalRecurrence(vet, { templateId: approved[index < 2 ? 0 : 1].template.id, departmentCode: "INPATIENT", title: `Ocorrência operacional sintética ${index}`, priority: "ROUTINE", responsibleUserId: vet.id, startAt, endAt, intervalMinutes: 1, idempotencyKey: `recurrence-${index}` }));
        }
        await service.retireHospitalChecklistTemplate(admin, approved[1].template.id, { expectedVersion: approved[1].template.version, idempotencyKey: "retire-before-due" });
        expect(Date.now()).toBeLessThan(dueAt);
        await delay(Math.max(0, dueAt - Date.now()) + 50);
        const stopped = await store.readState();
        expect(stopped.hospitalTasks).toHaveLength(0);
        expect(stopped.hospitalRecurrences.map((row) => row.nextOccurrenceAt)).toEqual([startAt, startAt, startAt]);

        const recoveredWorker = startWorker(database, directory, 2); workers.push(recoveredWorker);
        const recoveredBatch = await recoveredWorker.waitForEvent((event) => event.event === "hospital.recurrence_batch");
        expect(recoveredBatch).toMatchObject({ generated: 2, alreadyGenerated: 0, blocked: 1, pending: 1 });
        await recoveredWorker.waitForEvent((event) => event.event === "outbox.batch" && event.heartbeat?.lastResult === "success");
        await recoveredWorker.stop();
        expect(JSON.parse(await readFile(recoveredWorker.heartbeat, "utf8"))).toMatchObject({ lastResult: "success", consecutiveErrors: 0 });
        const persisted = await store.readState();
        expect(persisted.hospitalTasks).toHaveLength(2);
        for (const recurrence of recurrences.slice(0, 2)) {
          const tasks = persisted.hospitalTasks.filter((task) => task.recurrenceId === recurrence.recurrence.id);
          expect(tasks).toEqual([expect.objectContaining({ occurrenceAt: startAt, phase: "PENDING", checklistSnapshot: expect.objectContaining({ templateId: approved[0].template.id, templateVersion: approved[0].template.version }) })]);
          expect(tasks[0].checklistSnapshot?.clinicalProcess).toBeUndefined(); expect(tasks[0].careExecution).toBeUndefined();
          expect(persisted.hospitalRecurrences.find((row) => row.id === recurrence.recurrence.id)).toMatchObject({ nextOccurrenceAt: new Date(dueAt + 60_000).toISOString(), version: recurrence.recurrence.version + 1 });
        }
        const blockedId = recurrences[2].recurrence.id;
        expect(persisted.hospitalTasks.some((task) => task.recurrenceId === blockedId)).toBe(false);
        expect(persisted.hospitalRecurrences.find((row) => row.id === blockedId)).toMatchObject({ nextOccurrenceAt: startAt, lastError: "CHECKLIST_NOT_APPROVED" });
        // Audit authority is the relational ledger, not readState's runtime projection.
        const auditSql = "SELECT event_type,COUNT(*)::integer AS count FROM audit_events WHERE event_type IN ('HospitalTaskRecurrenceGenerated','HospitalRecurrenceGenerationBlocked') GROUP BY event_type ORDER BY event_type";
        const auditBeforeRestart = await database.query(auditSql);
        expect(auditBeforeRestart.rows).toEqual([{ event_type: "HospitalRecurrenceGenerationBlocked", count: 1 }, { event_type: "HospitalTaskRecurrenceGenerated", count: 2 }]);
        expect(persisted.items).toEqual(base.items); expect(persisted.results).toEqual(base.results); expect(persisted.patientGrants).toEqual(base.patientGrants);

        await database.closeStore(store);
        const restarted = startWorker(database, directory, 3); workers.push(restarted);
        expect(restarted.pid).not.toBe(recoveredWorker.pid);
        expect(await restarted.waitForEvent((event) => event.event === "hospital.recurrence_batch")).toMatchObject({ generated: 0, alreadyGenerated: 0, blocked: 1, pending: 1 });
        await restarted.waitForEvent((event) => event.event === "outbox.batch" && event.heartbeat?.lastResult === "success");
        await restarted.stop();
        const reopened = await database.createStore();
        try {
          const afterRestart = await reopened.readState();
          expect(afterRestart.hospitalTasks).toEqual(persisted.hospitalTasks);
          expect(afterRestart.hospitalRecurrences).toEqual(persisted.hospitalRecurrences);
          expect((await database.query(auditSql)).rows).toEqual(auditBeforeRestart.rows);
          expect(afterRestart.items).toEqual(base.items); expect(afterRestart.results).toEqual(base.results); expect(afterRestart.patientGrants).toEqual(base.patientGrants);
        } finally { await database.closeStore(reopened); }
      } finally {
        try { await Promise.all(workers.map((worker) => worker.stop())); }
        finally { await database.closeStore(store); await rm(directory, { recursive: true, force: true }); }
      }
    });
  });
});
