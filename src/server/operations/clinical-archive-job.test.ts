import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { ARCHIVE_NOW, withCompletedRequest } from "../../test/archive-fixtures";
import {
  clinicalArchiveConfig,
  createArchiveObjectRemovalSchedule,
  createClinicalArchiveMaintenance,
  createClinicalArchiveSchedule,
  parseArchiveArguments,
  removeArchivedObjects,
  removePendingArchiveObjects,
  runScheduledClinicalArchive,
  type ClinicalArchiveConfig
} from "./clinical-archive-job";

afterEach(() => vi.restoreAllMocks());

const config: ClinicalArchiveConfig = { enabled: true, activeMonths: 24, intervalMs: 3_600_000 };

function populatedStore(): MemoryStore {
  return new MemoryStore(withCompletedRequest(createDemoState("archive-job-password"), "old"));
}

async function pendingObjectStore(count = 3): Promise<MemoryStore> {
  let state = createDemoState("archive-object-drain-password");
  for (let index = 0; index < count; index += 1) state = withCompletedRequest(state, `pending-${index}`);
  const store = new MemoryStore(state);
  await store.archiveClinicalRecords({ now: ARCHIVE_NOW });
  await store.purgeClinicalArchive({ now: new Date("2036-10-09T00:00:00.000Z"), purgeAfterMonths: 120 });
  return store;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("clinicalArchiveConfig", () => {
  it("defaults to 24 months, daily, with purge disabled", () => {
    expect(clinicalArchiveConfig({})).toEqual({ enabled: true, activeMonths: 24, intervalMs: 86_400_000 });
  });

  it("parses overrides and bounds the interval to at least one hour", () => {
    expect(clinicalArchiveConfig({ ARCHIVE_ACTIVE_MONTHS: "36", ARCHIVE_INTERVAL_MS: "7200000", ARCHIVE_PURGE_AFTER_MONTHS: "240" }))
      .toEqual({ enabled: true, activeMonths: 36, intervalMs: 7_200_000, purgeAfterMonths: 240 });
    expect(clinicalArchiveConfig({ ARCHIVE_INTERVAL_MS: "1000" }).intervalMs).toBe(3_600_000);
    expect(clinicalArchiveConfig({ ARCHIVE_INTERVAL_MS: "abc" }).intervalMs).toBe(86_400_000);
    expect(clinicalArchiveConfig({ ARCHIVE_INTERVAL_MS: "-5" }).intervalMs).toBe(86_400_000);
  });

  it("treats 0 as disabled and ignores hostile values", () => {
    expect(clinicalArchiveConfig({ ARCHIVE_ACTIVE_MONTHS: "0" })).toMatchObject({ enabled: false, activeMonths: 0 });
    expect(clinicalArchiveConfig({ ARCHIVE_ACTIVE_MONTHS: "-4" }).activeMonths).toBe(24);
    expect(clinicalArchiveConfig({ ARCHIVE_ACTIVE_MONTHS: "1.5" }).activeMonths).toBe(24);
    expect(clinicalArchiveConfig({ ARCHIVE_ACTIVE_MONTHS: "" }).activeMonths).toBe(24);
    expect(clinicalArchiveConfig({ ARCHIVE_ACTIVE_MONTHS: "999999" }).activeMonths).toBe(1200);
  });

  it("keeps purge off for unset, zero, blank and invalid values", () => {
    for (const value of [undefined, "", "  ", "0", "-1", "abc", "2.5"]) {
      expect(clinicalArchiveConfig({ ARCHIVE_PURGE_AFTER_MONTHS: value }).purgeAfterMonths).toBeUndefined();
    }
    expect(clinicalArchiveConfig({ ARCHIVE_PURGE_AFTER_MONTHS: "120" }).purgeAfterMonths).toBe(120);
  });

  it("reads process.env by default", () => {
    vi.stubEnv("ARCHIVE_ACTIVE_MONTHS", "12");
    expect(clinicalArchiveConfig().activeMonths).toBe(12);
    expect(createClinicalArchiveSchedule().shouldRun(0)).toBe(true);
    vi.unstubAllEnvs();
  });
});

describe("clinical archive schedule", () => {
  it("runs once per cadence", () => {
    const schedule = createClinicalArchiveSchedule(1_000);
    expect(schedule.shouldRun(0)).toBe(true);
    schedule.record(0);
    expect(schedule.shouldRun(999)).toBe(false);
    expect(schedule.shouldRun(1_000)).toBe(true);
  });

  it("drains independently every five seconds and backs off a full minute from a failure", () => {
    const archiveSchedule = createClinicalArchiveSchedule(86_400_000);
    const objects = createArchiveObjectRemovalSchedule();
    archiveSchedule.record(0);
    expect(objects.shouldRun(0)).toBe(true);
    objects.record(0);
    expect(objects.shouldRun(4_999)).toBe(false);
    expect(objects.shouldRun(5_000)).toBe(true);
    expect(archiveSchedule.shouldRun(5_000)).toBe(false);
    objects.record(5_000);
    objects.failed(20_000); // A slow provider fails after the batch began.
    expect(objects.shouldRun(79_999)).toBe(false);
    expect(objects.shouldRun(80_000)).toBe(true);
    objects.record(80_000);
    expect(objects.shouldRun(84_999)).toBe(false);
    expect(objects.shouldRun(85_000)).toBe(true);
  });
});

describe("tracked archive maintenance", () => {
  it("lets delivery proceed, prevents overlapping work and waits for the in-flight acknowledgement at shutdown", async () => {
    const store = await pendingObjectStore();
    const started = deferred();
    const storageGate = deferred();
    const remove = vi.fn(async () => { started.resolve(); await storageGate.promise; });
    let stopping = false;
    const onError = vi.fn();
    const maintenance = createClinicalArchiveMaintenance(onError);
    maintenance.start(async () => { await removePendingArchiveObjects(store, { remove }, { shouldStop: () => stopping }); });
    await started.promise;
    const overlapping = vi.fn(async () => undefined);
    maintenance.start(overlapping);
    // The worker can deliver/write its heartbeat while the object provider is blocked.
    const delivery = vi.fn(async () => "heartbeat-written");
    expect(await delivery()).toBe("heartbeat-written");
    stopping = true;
    let closed = false;
    const shutdown = maintenance.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(await store.readArchiveObjectDeletionMetrics()).toMatchObject({ pending: 3 });
    storageGate.resolve();
    await shutdown;
    expect(closed).toBe(true);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(await store.readArchiveObjectDeletionMetrics()).toMatchObject({ pending: 2 });
    expect(onError).not.toHaveBeenCalled();
    maintenance.start(overlapping);
    expect(overlapping).not.toHaveBeenCalled();
  });

  it.each([false, true])("settles background and logger failures without an unhandled rejection (async logger: %s)", async (asyncLogger) => {
    const failure = new Error("storage unavailable");
    const onError = vi.fn((error: unknown) => {
      expect(error).toBe(failure);
      if (asyncLogger) return Promise.reject(new Error("logging unavailable"));
      throw new Error("logging unavailable");
    });
    const maintenance = createClinicalArchiveMaintenance(onError);
    maintenance.start(async () => { throw failure; });
    await expect(maintenance.close()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("allows another run after a failed task settles and closes an idle coordinator", async () => {
    const reported = deferred();
    const maintenance = createClinicalArchiveMaintenance(() => { reported.resolve(); });
    maintenance.start(async () => { throw new Error("first attempt failed"); });
    await reported.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const retry = vi.fn(async () => undefined);
    maintenance.start(retry);
    await maintenance.close();
    expect(retry).toHaveBeenCalledTimes(1);
    const idle = createClinicalArchiveMaintenance(vi.fn());
    await idle.close();
    idle.start(retry);
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

describe("bounded durable object draining", () => {
  it("removes at most 25 objects per run and resumes the remaining intents", async () => {
    const store = await pendingObjectStore(30);
    const remove = vi.fn(async () => undefined);
    expect(await removePendingArchiveObjects(store, { remove })).toEqual({ removed: 25, failures: 0 });
    expect(remove).toHaveBeenCalledTimes(25);
    expect(await store.readArchiveObjectDeletionMetrics()).toMatchObject({ pending: 5 });
    expect(await removePendingArchiveObjects(store, { remove })).toEqual({ removed: 5, failures: 0 });
    expect(await store.readArchiveObjectDeletionMetrics()).toEqual({ pending: 0 });
  });

  it("stops at the first provider failure and leaves every unacknowledged intent for recovery", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = await pendingObjectStore();
    const remove = vi.fn(async (): Promise<void> => { throw new Error("provider outage"); });
    expect(await removePendingArchiveObjects(store, { remove })).toEqual({ removed: 0, failures: 1 });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(await store.readArchiveObjectDeletionMetrics()).toMatchObject({ pending: 3 });
    remove.mockResolvedValue(undefined);
    expect(await removePendingArchiveObjects(store, { remove })).toEqual({ removed: 3, failures: 0 });
    expect(await store.readArchiveObjectDeletionMetrics()).toEqual({ pending: 0 });
  });

  it("repeats idempotent removal after a failed acknowledgement before advancing to other keys", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = await pendingObjectStore();
    vi.spyOn(store, "completeArchiveObjectDeletion").mockRejectedValueOnce(new Error("database disconnected"));
    const remove = vi.fn<(key: string) => Promise<void>>(async () => undefined);
    expect(await removePendingArchiveObjects(store, { remove })).toEqual({ removed: 0, failures: 1 });
    const firstKey = remove.mock.calls[0][0];
    expect(remove).toHaveBeenCalledTimes(1);
    expect(await store.readArchiveObjectDeletionMetrics()).toMatchObject({ pending: 3 });
    expect(await removePendingArchiveObjects(store, { remove })).toEqual({ removed: 3, failures: 0 });
    expect(remove.mock.calls[1][0]).toBe(firstKey);
  });

  it("acknowledges an in-flight removal but starts no next operation after the ten-second budget", async () => {
    const store = await pendingObjectStore();
    let now = 0;
    const remove = vi.fn(async () => { now = 10_000; });
    expect(await removePendingArchiveObjects(store, { remove }, { now: () => now })).toEqual({ removed: 1, failures: 0 });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(await store.readArchiveObjectDeletionMetrics()).toMatchObject({ pending: 2 });
  });

  it("includes queue lookup time in the budget and supports a smaller caller budget", async () => {
    const store = await pendingObjectStore();
    let now = 0;
    const readPending = store.readPendingArchiveObjectDeletions.bind(store);
    vi.spyOn(store, "readPendingArchiveObjectDeletions").mockImplementationOnce(async (limit) => {
      const keys = await readPending(limit);
      now = 10_000;
      return keys;
    });
    const remove = vi.fn(async () => { now += 1; });
    expect(await removePendingArchiveObjects(store, { remove }, { now: () => now })).toEqual({ removed: 0, failures: 0 });
    expect(remove).not.toHaveBeenCalled();
    now = 0;
    expect(await removePendingArchiveObjects(store, { remove }, { now: () => now, maxDurationMs: 2 })).toEqual({ removed: 2, failures: 0 });
    expect(await store.readArchiveObjectDeletionMetrics()).toMatchObject({ pending: 1 });
  });

  it("preserves all intents when shutdown was requested before the first operation", async () => {
    const store = await pendingObjectStore();
    const remove = vi.fn(async () => undefined);
    expect(await removePendingArchiveObjects(store, { remove }, { shouldStop: () => true })).toEqual({ removed: 0, failures: 0 });
    expect(remove).not.toHaveBeenCalled();
    expect(await store.readArchiveObjectDeletionMetrics()).toMatchObject({ pending: 3 });
  });

  it("requires storage only when there are durable pending objects", async () => {
    expect(await removePendingArchiveObjects(new MemoryStore(createDemoState()), undefined)).toEqual({ removed: 0, failures: 0 });
    const store = await pendingObjectStore();
    await expect(removePendingArchiveObjects(store, undefined)).rejects.toThrow("ARCHIVE_OBJECT_STORE_REQUIRED");
    expect(await store.readArchiveObjectDeletionMetrics()).toMatchObject({ pending: 3 });
  });

  it("rejects invalid budgets and batch sizes before starting removal", async () => {
    const store = await pendingObjectStore();
    const remove = vi.fn(async () => undefined);
    for (const maxDurationMs of [0, -1, 1.5, NaN, Infinity]) {
      await expect(removePendingArchiveObjects(store, { remove }, { maxDurationMs })).rejects.toThrow("ARCHIVE_OBJECT_REMOVAL_BUDGET_INVALID");
    }
    for (const batchSize of [0, 5_001, 1.5]) {
      await expect(removePendingArchiveObjects(store, { remove }, { batchSize })).rejects.toThrow("ARCHIVE_OBJECT_DELETION_LIMIT_INVALID");
    }
    expect(remove).not.toHaveBeenCalled();
  });
});

describe("runScheduledClinicalArchive", () => {
  it("archives on the first cycle, logs counts only and then waits for the cadence", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const store = populatedStore();
    const schedule = createClinicalArchiveSchedule(3_600_000);
    const nowMs = ARCHIVE_NOW.getTime();
    expect(await runScheduledClinicalArchive(store, schedule, { config, now: () => nowMs })).toBe(true);
    expect(store.getState().requests).toEqual([]);
    expect(log).toHaveBeenCalledTimes(1);
    const line = JSON.parse(log.mock.calls[0][0] as string);
    expect(line).toMatchObject({ event: "clinical.archive_applied", requestsArchived: 1, entitiesArchived: 11, attachmentsArchived: 1, requestsPurged: 0, objectsRemoved: 0, objectRemovalFailures: 0 });
    expect(JSON.stringify(line)).not.toContain("request-old");
    expect(await runScheduledClinicalArchive(store, schedule, { config, now: () => nowMs + 1_000 })).toBe(false);
  });

  it("stays silent when nothing was archived and uses the wall clock by default", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const store = new MemoryStore(createDemoState("archive-job-silent-password"));
    expect(await runScheduledClinicalArchive(store, createClinicalArchiveSchedule(), { config })).toBe(true);
    expect(log).not.toHaveBeenCalled();
  });

  it("does nothing when archiving is disabled", async () => {
    const store = populatedStore();
    const spy = vi.spyOn(store, "archiveClinicalRecords");
    expect(await runScheduledClinicalArchive(store, createClinicalArchiveSchedule(), { config: { ...config, enabled: false, activeMonths: 0 } })).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("reads the environment when no config is given", async () => {
    vi.stubEnv("ARCHIVE_ACTIVE_MONTHS", "0");
    const store = populatedStore();
    expect(await runScheduledClinicalArchive(store, createClinicalArchiveSchedule())).toBe(false);
    vi.unstubAllEnvs();
  });

  it("records the attempt before running, so a failure retries on the next cadence", async () => {
    const store = populatedStore();
    vi.spyOn(store, "archiveClinicalRecords").mockRejectedValue(new Error("database unavailable"));
    const schedule = createClinicalArchiveSchedule(3_600_000);
    await expect(runScheduledClinicalArchive(store, schedule, { config, now: () => 10 })).rejects.toThrow("database unavailable");
    expect(await runScheduledClinicalArchive(store, schedule, { config, now: () => 20 })).toBe(false);
  });

  it("purges only when the legal period is configured and removes the stored objects", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const store = populatedStore();
    await store.archiveClinicalRecords({ now: ARCHIVE_NOW });
    const remove = vi.fn(async () => undefined);
    const later = new Date("2036-10-09T00:00:00.000Z").getTime();
    // Not configured: the archive is kept.
    await runScheduledClinicalArchive(store, createClinicalArchiveSchedule(), { config, now: () => later, fileStore: { remove } });
    expect(remove).not.toHaveBeenCalled();
    expect(await store.readClinicalArchive({ limit: 5 })).toHaveLength(1);
    // Configured: rows and objects go.
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runScheduledClinicalArchive(store, createClinicalArchiveSchedule(), { config: { ...config, purgeAfterMonths: 120 }, now: () => later, fileStore: { remove } });
    expect(remove).toHaveBeenCalledWith("attachments/result-old/uuid-old/laudo.pdf");
    expect(await store.readClinicalArchive({ limit: 5 })).toEqual([]);
    expect(JSON.parse(log.mock.calls[0][0] as string)).toMatchObject({ requestsPurged: 1, entitiesPurged: 11, objectsRemoved: 1, objectRemovalFailures: 0 });
  });

  it("keeps a durable deletion intent after storage failure and retries without archive rows", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = populatedStore();
    await store.archiveClinicalRecords({ now: ARCHIVE_NOW });
    const remove = vi.fn(async (): Promise<void> => { throw new Error("S3 unavailable"); });
    const later = new Date("2036-10-09T00:00:00.000Z").getTime();
    await expect(runScheduledClinicalArchive(store, createClinicalArchiveSchedule(), { config: { ...config, purgeAfterMonths: 120 }, now: () => later, fileStore: { remove } })).rejects.toThrow("ARCHIVE_OBJECT_REMOVAL_PENDING");
    expect(JSON.parse(log.mock.calls[0][0] as string)).toMatchObject({ objectsRemoved: 0, objectRemovalFailures: 1 });
    expect(error.mock.calls[0][0]).toContain('"keyPrefix":"attachments/result-old"');
    expect(error.mock.calls[0][0]).not.toContain("laudo.pdf");
    expect(await store.readClinicalArchive({ limit: 5 })).toEqual([]);
    expect(await store.readArchiveObjectDeletionMetrics()).toMatchObject({ pending: 1 });
    remove.mockResolvedValueOnce(undefined);
    await expect(runScheduledClinicalArchive(store, createClinicalArchiveSchedule(), { config, now: () => later + 1, fileStore: { remove } })).resolves.toBe(true);
    expect(remove).toHaveBeenCalledTimes(2);
    expect(await store.readArchiveObjectDeletionMetrics()).toEqual({ pending: 0 });
  });

  it("keeps the intent after object deletion succeeds but the acknowledgement fails", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = populatedStore();
    await store.archiveClinicalRecords({ now: ARCHIVE_NOW });
    const later = new Date("2036-10-09T00:00:00.000Z").getTime();
    const remove = vi.fn(async () => undefined);
    const acknowledge = vi.spyOn(store, "completeArchiveObjectDeletion").mockRejectedValueOnce(new Error("connection lost"));
    await expect(runScheduledClinicalArchive(store, createClinicalArchiveSchedule(), { config: { ...config, purgeAfterMonths: 120 }, now: () => later, fileStore: { remove } })).rejects.toThrow("ARCHIVE_OBJECT_REMOVAL_PENDING");
    expect(await store.readPendingArchiveObjectDeletions(5)).toHaveLength(1);
    await runScheduledClinicalArchive(store, createClinicalArchiveSchedule(), { config: { ...config, enabled: false }, now: () => later + 1, fileStore: { remove } });
    expect(remove).toHaveBeenCalledTimes(2);
    expect(acknowledge).toHaveBeenCalledTimes(2);
    expect(await store.readPendingArchiveObjectDeletions(5)).toEqual([]);
  });

  it("refuses to purge when an object store is unavailable", async () => {
    const store = populatedStore();
    await store.archiveClinicalRecords({ now: ARCHIVE_NOW });
    await expect(runScheduledClinicalArchive(store, createClinicalArchiveSchedule(), { config: { ...config, purgeAfterMonths: 120 } })).rejects.toThrow("ARCHIVE_OBJECT_STORE_REQUIRED");
    expect(await store.readClinicalArchive({ limit: 5 })).toHaveLength(1);
  });

  it("can commit purge intents without awaiting storage, then drain even with archiving disabled", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const store = populatedStore();
    await store.archiveClinicalRecords({ now: ARCHIVE_NOW });
    const remove = vi.fn(async () => undefined);
    const later = new Date("2036-10-09T00:00:00.000Z").getTime();
    await runScheduledClinicalArchive(store, createClinicalArchiveSchedule(), {
      config: { ...config, purgeAfterMonths: 120 }, now: () => later, fileStore: { remove }, deferObjectRemoval: true
    });
    expect(remove).not.toHaveBeenCalled();
    expect(await store.readClinicalArchive({ limit: 5 })).toEqual([]);
    expect(await store.readArchiveObjectDeletionMetrics()).toMatchObject({ pending: 1 });
    expect(await runScheduledClinicalArchive(store, createClinicalArchiveSchedule(), {
      config: { ...config, enabled: false }, now: () => later + 5_000, fileStore: { remove }, deferObjectRemoval: true
    })).toBe(false);
    expect(remove).not.toHaveBeenCalled();
    expect(await removePendingArchiveObjects(store, { remove })).toEqual({ removed: 1, failures: 0 });
    expect(await store.readArchiveObjectDeletionMetrics()).toEqual({ pending: 0 });
  });
});

describe("removeArchivedObjects", () => {
  it("counts removals and failures, and ignores keys without a file store", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const remove = vi.fn(async (key: string) => { if (key === "bad") throw new Error("nope"); });
    expect(await removeArchivedObjects({ remove }, ["a", "bad", "b"])).toEqual({ removed: 2, failures: 1 });
    expect(await removeArchivedObjects(undefined, ["a"])).toEqual({ removed: 0, failures: 0 });
  });
});

describe("parseArchiveArguments", () => {
  it("defaults to a dry run", () => {
    expect(parseArchiveArguments([])).toEqual({ apply: false, purge: false, months: undefined });
    expect(parseArchiveArguments(["--dry-run"]).apply).toBe(false);
  });

  it("reads --apply, --purge and --months", () => {
    expect(parseArchiveArguments(["--apply", "--purge", "--months", "36"])).toEqual({ apply: true, purge: true, months: 36 });
  });

  it("rejects invalid combinations and months", () => {
    expect(() => parseArchiveArguments(["--apply", "--dry-run"])).toThrow("--dry-run");
    for (const value of ["0", "-1", "abc", "1.5", undefined]) {
      expect(() => parseArchiveArguments(value === undefined ? ["--months"] : ["--months", value])).toThrow("--months");
    }
  });
});
