import type { StateStore } from "../domain/models";
import { appendDueTaskNotifications } from "./work-notification-policy";
import { createHospitalRecurrenceSchedule } from "./hospital-recurrence-job";
export const createWorkNotificationSchedule = createHospitalRecurrenceSchedule;
export async function runScheduledWorkNotifications(store: StateStore, schedule: ReturnType<typeof createWorkNotificationSchedule>, nowMs = Date.now()) {
  if (!schedule.shouldRun(nowMs)) return;
  schedule.record(nowMs);
  const appended = await store.transaction((state) => { const next = appendDueTaskNotifications(state, new Date(nowMs).toISOString(), 100); return { state: next, result: next.workNotifications.length - state.workNotifications.length }; });
  if (appended) console.log(JSON.stringify({ event: "work.notification_batch", appended }));
  return appended;
}
