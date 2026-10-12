import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hospitalOperationFixture } from "../../test/hospital-operation-fixtures";
import { createWorkNotificationSchedule, runScheduledWorkNotifications } from "./work-notification-job";
import { appendDueTaskNotifications } from "./work-notification-policy";
import { createHospitalReportSchedule, runScheduledHospitalReports } from "./hospital-report-job";

const at = Date.parse("2026-10-11T15:00:00.000Z");
describe("scheduled convenience notifications and report generation", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(at); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("honors cadence, deduplicates due notices and keeps task and critical state unchanged", async () => {
    const f = hospitalOperationFixture(); const task = await f.task("scheduled");
    await f.service.updateHospitalTask(f.user("user-us"), task.task.id, { plannedEndAt: "2026-10-11T14:00:00.000Z", expectedVersion: 1, idempotencyKey: "due" });
    const before = structuredClone({ tasks: f.store.getState().hospitalTasks, critical: f.store.getState().notifications, handoffs: f.store.getState().hospitalHandoffs });
    const log = vi.spyOn(console, "log").mockImplementation(() => {}); const schedule = createWorkNotificationSchedule();
    expect(await runScheduledWorkNotifications(f.store, schedule, at)).toBe(1);
    expect(await runScheduledWorkNotifications(f.store, schedule, at + 59_999)).toBeUndefined();
    vi.setSystemTime(at + 60_000); expect(await runScheduledWorkNotifications(f.store, schedule, at + 60_000)).toBe(0);
    expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ event: "work.notification_batch", appended: 1 }));
    expect(f.store.getState().workNotifications[0]).toMatchObject({ userId: "user-us", targetId: task.task.id, eventType: "TASK_DUE" });
    expect({ tasks: f.store.getState().hospitalTasks, critical: f.store.getState().notifications, handoffs: f.store.getState().hospitalHandoffs }).toEqual(before);
  });

  it("does not deliver to inactive, password-pending, muted or newly revoked recipients; later restoration can deliver", async () => {
    const f = hospitalOperationFixture(); const task = await f.task("recipient");
    await f.service.updateHospitalTask(f.user("user-us"), task.task.id, { plannedEndAt: "2026-10-11T14:00:00Z", expectedVersion: 1, idempotencyKey: "recipient-due" });
    const original = f.user("user-us"); const group = f.store.getState().accessGroups.find((entry) => entry.id === original.accessGroupId)!;
    const schedule = createWorkNotificationSchedule(1); vi.spyOn(console, "log").mockImplementation(() => {});
    for (const change of [{ active: false }, { active: true, mustChangePassword: true }, { active: true, mustChangePassword: false }]) {
      await f.store.transaction((state) => ({ state: { ...state, users: state.users.map((entry) => entry.id === original.id ? { ...entry, ...change } : entry), accessGroups: state.accessGroups.map((entry) => entry.id === group.id && change.active && !change.mustChangePassword ? { ...entry, permissions: entry.permissions.filter((permission) => permission !== "work_notification.view") } : entry) }, result: undefined }));
      expect(await runScheduledWorkNotifications(f.store, schedule, Date.now())).toBe(0); vi.setSystemTime(Date.now() + 1);
    }
    await f.store.transaction((state) => ({ state: { ...state, users: state.users.map((entry) => entry.id === original.id ? original : entry), accessGroups: state.accessGroups.map((entry) => entry.id === group.id ? group : entry) }, result: undefined }));
    await f.service.putWorkNotificationPreferences(original, { mutedEvents: ["TASK_DUE"], expectedVersion: 0, idempotencyKey: "mute-due" });
    expect(await runScheduledWorkNotifications(f.store, schedule, Date.now())).toBe(0); vi.setSystemTime(Date.now() + 1);
    await f.service.putWorkNotificationPreferences(original, { mutedEvents: [], expectedVersion: 1, idempotencyKey: "restore-due" });
    expect(await runScheduledWorkNotifications(f.store, schedule, Date.now())).toBe(1);
    expect(f.store.getState().hospitalTasks[0].phase).toBe("PENDING");
  });

  it("propagates storage failure and retries only on the next bounded cadence", async () => {
    const f = hospitalOperationFixture(); const schedule = createWorkNotificationSchedule();
    const transaction = vi.spyOn(f.store, "transaction").mockRejectedValueOnce(new Error("SYNTHETIC_STORAGE_UNAVAILABLE"));
    await expect(runScheduledWorkNotifications(f.store, schedule, at)).rejects.toThrow("SYNTHETIC_STORAGE_UNAVAILABLE");
    expect(await runScheduledWorkNotifications(f.store, schedule, at + 1)).toBeUndefined(); expect(transaction).toHaveBeenCalledTimes(1);
    vi.setSystemTime(at + 60_000); expect(await runScheduledWorkNotifications(f.store, schedule, at + 60_000)).toBe(0); expect(transaction).toHaveBeenCalledTimes(2);
    expect(f.store.getState().workNotifications).toEqual([]);
  });

  it("rejects invalid or future windows and unbounded batch sizes before producing notices", () => {
    const state = hospitalOperationFixture().store.getState(); const before = structuredClone(state);
    for (const [asOf, limit] of [["invalid", 100], [new Date(at + 1).toISOString(), 100], [new Date(at).toISOString(), 0], [new Date(at).toISOString(), 101], [new Date(at).toISOString(), 1.5]] as const) {
      expect(() => appendDueTaskNotifications(state, asOf, limit)).toThrow("INVALID_WORK_NOTIFICATION_WINDOW");
    }
    expect(state).toEqual(before);
  });

  it("runs report workers once per cadence without treating empty batches as successful exports", async () => {
    const f = hospitalOperationFixture(); const schedule = createHospitalReportSchedule(); const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await runScheduledHospitalReports(f.store, schedule, at)).toEqual({ succeeded: 0, failed: 0 });
    expect(await runScheduledHospitalReports(f.store, schedule, at + 1)).toBeUndefined(); expect(log).not.toHaveBeenCalled();
    const report = await f.service.createHospitalReport(f.user("user-us"), { name: "Trabalho sintético", metricCode: "TASK_PENDING", filters: { from: "2026-10-11T00:00:00Z", to: "2026-10-12T00:00:00Z" }, format: "CSV", idempotencyKey: "scheduled-report" });
    const job = await f.service.createHospitalReportJob(f.user("user-us"), { reportId: report.id, expectedReportVersion: 1, idempotencyKey: "scheduled-export" });
    vi.setSystemTime(at + 60_000); expect(await runScheduledHospitalReports(f.store, schedule, at + 60_000)).toEqual({ succeeded: 1, failed: 0 });
    expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ event: "hospital.report_batch", succeeded: 1, failed: 0 }));
    expect(f.store.getState().hospitalReportJobs.find((entry) => entry.id === job.job.id)?.status).toBe("SUCCEEDED");
  });
});
