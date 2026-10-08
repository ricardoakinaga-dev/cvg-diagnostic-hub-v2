import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { ARCHIVE_NOW, withCompletedRequest } from "../../test/archive-fixtures";
import {
  clinicalArchiveConfig,
  createClinicalArchiveSchedule,
  parseArchiveArguments,
  removeArchivedObjects,
  runScheduledClinicalArchive,
  type ClinicalArchiveConfig
} from "./clinical-archive-job";

afterEach(() => vi.restoreAllMocks());

const config: ClinicalArchiveConfig = { enabled: true, activeMonths: 24, intervalMs: 3_600_000 };

function populatedStore(): MemoryStore {
  return new MemoryStore(withCompletedRequest(createDemoState("archive-job-password"), "old"));
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

  it("logs and survives an object removal failure without leaking the file name", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = populatedStore();
    await store.archiveClinicalRecords({ now: ARCHIVE_NOW });
    const remove = vi.fn(async () => { throw new Error("S3 unavailable"); });
    const later = new Date("2036-10-09T00:00:00.000Z").getTime();
    await expect(runScheduledClinicalArchive(store, createClinicalArchiveSchedule(), { config: { ...config, purgeAfterMonths: 120 }, now: () => later, fileStore: { remove } })).resolves.toBe(true);
    expect(JSON.parse(log.mock.calls[0][0] as string)).toMatchObject({ objectsRemoved: 0, objectRemovalFailures: 1 });
    expect(error.mock.calls[0][0]).toContain('"keyPrefix":"attachments/result-old"');
    expect(error.mock.calls[0][0]).not.toContain("laudo.pdf");
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
