import type { StateStore } from "../domain/models";
import { createHospitalRecurrenceSchedule } from "./hospital-recurrence-job";
import { processPendingHospitalReportJobs } from "./hospital-report-service";
export const createHospitalReportSchedule = createHospitalRecurrenceSchedule;
export async function runScheduledHospitalReports(store: StateStore, schedule: ReturnType<typeof createHospitalReportSchedule>, nowMs = Date.now()) {
  if (!schedule.shouldRun(nowMs)) return;
  schedule.record(nowMs);
  const result = await processPendingHospitalReportJobs(store, 10, new Date(nowMs).toISOString());
  if (result.succeeded || result.failed) console.log(JSON.stringify({ event: "hospital.report_batch", ...result }));
  return result;
}
