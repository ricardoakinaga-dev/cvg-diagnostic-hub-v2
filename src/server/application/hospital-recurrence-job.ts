import type { StateStore } from "../domain/models";
import { generateDueHospitalRecurrences } from "./hospital-recurrence-service";

export function createHospitalRecurrenceSchedule(intervalMs = 60_000) {
  let attemptedAt: number | undefined;
  return {
    shouldRun(nowMs: number) { return attemptedAt === undefined || nowMs - attemptedAt >= intervalMs; },
    record(nowMs: number) { attemptedAt = nowMs; }
  };
}
export async function runScheduledHospitalRecurrences(store: StateStore, schedule: ReturnType<typeof createHospitalRecurrenceSchedule>, nowMs = Date.now()) {
  if (!schedule.shouldRun(nowMs)) return;
  schedule.record(nowMs);
  const summary = await generateDueHospitalRecurrences(store, { asOf: new Date(nowMs).toISOString(), limit: 100 });
  if (summary.generated || summary.alreadyGenerated || summary.blocked || summary.pending) console.log(JSON.stringify({ event: "hospital.recurrence_batch", ...summary }));
  if (summary.blocked) console.error(JSON.stringify({ event: "hospital.recurrence_blocked", errorCode: "HOSPITAL_RECURRENCE_CONTEXT_INVALID", blocked: summary.blocked }));
  return summary;
}
