import type { HospitalSchedule, HospitalTask } from "@cvg/contracts";
import type { ApplicationServiceContext } from "./service-context";
import type { StoreState, User } from "../domain/models";
import { ApiError } from "../http/envelope";
import { hospitalTaskReserveSchema, hospitalScheduleRescheduleSchema, hospitalScheduleCancelSchema, type HospitalTaskReserveInput, type HospitalScheduleRescheduleInput, type HospitalScheduleCancelInput } from "../http/hospital-resource-schemas";
import { commandBody, validateCommand } from "./hospital-service-policy";
import { createAudit, createOutbox, ensureExpectedVersion, id, now, requireActiveUser, requireIdempotencyKey, saveIdempotency, withIdempotency } from "./service-common";
import { requireHospitalTaskAccess, requirePublishedHospitalTask, taskDate, validateNewTaskContext } from "./hospital-task-policy";
import { requireCalendarPermission, validateReservationResources } from "./hospital-resource-policy";
import { requireHospitalCapability } from "./hospital-institution-policy";

function availableTask(state: StoreState, actor: User, taskId: string, permission: "hospital_calendar.reserve" | "hospital_calendar.reschedule" | "hospital_calendar.cancel"): HospitalTask {
  const task = state.hospitalTasks.find((entry) => entry.id === taskId);
  if (!task) throw new ApiError("NOT_FOUND", "A atividade não está disponível.", 404);
  requireHospitalTaskAccess(state, actor, "hospital_task.view", task); requireHospitalTaskAccess(state, actor, permission, task);
  requirePublishedHospitalTask(task);
  if (["COMPLETED", "CANCELLED"].includes(task.phase)) throw new ApiError("INVALID_STATE_TRANSITION", "A atividade já foi encerrada.", 409);
  return task;
}
function changeRecord(state: StoreState, actor: User, schedule: HospitalSchedule, previous: HospitalSchedule | undefined, eventType: string, correlationId?: string): StoreState {
  const correlation = correlationId ?? id("corr");
  return { ...state, schedules: previous ? state.schedules.map((entry) => entry.id === schedule.id ? schedule : entry) : [...state.schedules, schedule], auditEvents: [...state.auditEvents, createAudit(eventType, actor.id, "HospitalTask", schedule.hospitalTaskId!, correlation, previous?.status, schedule.status, { scheduleId: schedule.id, resourceIds: schedule.resourceIds?.join(",") ?? "", startsAt: schedule.startsAt, endsAt: schedule.endsAt, reason: schedule.reason ?? null, scheduleVersion: schedule.version })], outbox: [...state.outbox, createOutbox(eventType, "HospitalTask", schedule.hospitalTaskId!, correlation, { taskId: schedule.hospitalTaskId!, scheduleId: schedule.id })] };
}

export function createHospitalCalendarCommandService({ store }: ApplicationServiceContext) {
  return {
    async reserveHospitalTaskSchedule(actor: User, taskId: string, input: HospitalTaskReserveInput): Promise<HospitalSchedule> {
      return store.transaction((state) => {
        const current = requireActiveUser(state, actor); const task = availableTask(state, current, taskId, "hospital_calendar.reserve"); const body = validateCommand(hospitalTaskReserveSchema, commandBody(input)); requireIdempotencyKey(input.idempotencyKey);
        const scope = `POST:/hospital-tasks/${taskId}/reservations`; const replay = withIdempotency<HospitalSchedule>(state, current.id, scope, input.idempotencyKey, { input });
        if (replay.found) return { state, result: replay.existing! };
        ensureExpectedVersion(task.version, body.expectedVersion);
        requireHospitalCapability(state, task.departmentCode, "CALENDAR");
        validateNewTaskContext(state, task, task.typeSnapshot.careContextRequired || task.serviceSnapshot?.kind === "CARE");
        if (task.phase !== "PENDING" || state.schedules.some((entry) => entry.hospitalTaskId === taskId && entry.status === "SCHEDULED")) throw new ApiError("INVALID_STATE_TRANSITION", "Remarque a reserva vigente de uma atividade ainda não iniciada.", 409);
        const window = { startsAt: taskDate(body.startsAt)!, endsAt: taskDate(body.endsAt)! }; const timestamp = now();
        const binding = validateReservationResources(state, task, body.resourceIds, window, timestamp);
        if (task.serviceSnapshot?.resourceIds.length && binding.resourceIds.some((resourceId) => !task.serviceSnapshot!.resourceIds.includes(resourceId))) throw new ApiError("VALIDATION_ERROR", "Um recurso não pertence à definição do serviço usada nesta atividade.", 400);
        const schedule: HospitalSchedule = { id: id("schedule"), hospitalTaskId: task.id, ...window, ...binding, status: "SCHEDULED", actorId: current.id, createdAt: timestamp, version: 1 };
        const next = changeRecord(state, current, schedule, undefined, "HospitalTaskReserved", input.correlationId);
        return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, schedule, { input }), result: schedule };
      });
    },
    async rescheduleHospitalTaskSchedule(actor: User, scheduleId: string, input: HospitalScheduleRescheduleInput): Promise<{ schedule: HospitalSchedule; previousSchedule: HospitalSchedule }> {
      return store.transaction((state) => {
        const current = requireActiveUser(state, actor); const previous = state.schedules.find((entry) => entry.id === scheduleId && entry.hospitalTaskId && !entry.procedureId);
        if (!previous) throw new ApiError("NOT_FOUND", "A reserva não está disponível; exames usam o comando de procedimento.", 404);
        const task = availableTask(state, current, previous.hospitalTaskId!, "hospital_calendar.reschedule"); const body = validateCommand(hospitalScheduleRescheduleSchema, commandBody(input)); requireIdempotencyKey(input.idempotencyKey);
        const scope = `POST:/hospital-reservations/${scheduleId}/reschedule`; const replay = withIdempotency<{ schedule: HospitalSchedule; previousSchedule: HospitalSchedule }>(state, current.id, scope, input.idempotencyKey, { input });
        if (replay.found) return { state, result: replay.existing! };
        ensureExpectedVersion(previous.version, body.expectedVersion); if (previous.status !== "SCHEDULED" || task.phase !== "PENDING") throw new ApiError("INVALID_STATE_TRANSITION", "Somente reservas vigentes de atividades ainda não iniciadas podem ser remarcadas.", 409);
        validateNewTaskContext(state, task, task.typeSnapshot.careContextRequired || task.serviceSnapshot?.kind === "CARE");
        const window = { startsAt: taskDate(body.startsAt)!, endsAt: taskDate(body.endsAt)! }; const timestamp = now();
        const binding = validateReservationResources(state, task, body.resourceIds, window, timestamp, previous.id);
        if (task.serviceSnapshot?.resourceIds.length && binding.resourceIds.some((resourceId) => !task.serviceSnapshot!.resourceIds.includes(resourceId))) throw new ApiError("VALIDATION_ERROR", "Um recurso não pertence à definição do serviço usada nesta atividade.", 400);
        const cancelled: HospitalSchedule = { ...previous, status: "CANCELLED", reason: body.reason, version: previous.version + 1 };
        const schedule: HospitalSchedule = { id: id("schedule"), hospitalTaskId: task.id, ...window, ...binding, status: "SCHEDULED", actorId: current.id, createdAt: timestamp, version: 1 };
        const next = changeRecord(changeRecord(state, current, cancelled, previous, "HospitalTaskReservationSuperseded", input.correlationId), current, schedule, undefined, "HospitalTaskRescheduled", input.correlationId);
        const result = { schedule, previousSchedule: cancelled };
        return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, result, { input }), result };
      });
    },
    async cancelHospitalTaskSchedule(actor: User, scheduleId: string, input: HospitalScheduleCancelInput): Promise<HospitalSchedule> {
      return store.transaction((state) => {
        const current = requireActiveUser(state, actor); const previous = state.schedules.find((entry) => entry.id === scheduleId && entry.hospitalTaskId && !entry.procedureId);
        if (!previous) throw new ApiError("NOT_FOUND", "A reserva não está disponível.", 404);
        const task = availableTask(state, current, previous.hospitalTaskId!, "hospital_calendar.cancel"); requireCalendarPermission(current, "hospital_calendar.cancel", task); const body = validateCommand(hospitalScheduleCancelSchema, commandBody(input)); requireIdempotencyKey(input.idempotencyKey);
        const scope = `POST:/hospital-reservations/${scheduleId}/cancel`; const replay = withIdempotency<HospitalSchedule>(state, current.id, scope, input.idempotencyKey, { input }); if (replay.found) return { state, result: replay.existing! };
        ensureExpectedVersion(previous.version, body.expectedVersion); if (previous.status !== "SCHEDULED" || task.phase !== "PENDING") throw new ApiError("INVALID_STATE_TRANSITION", "Cancele a reserva antes de iniciar a atividade; execução já iniciada segue o comando da tarefa.", 409);
        const schedule: HospitalSchedule = { ...previous, status: "CANCELLED", reason: body.reason, version: previous.version + 1 }; const next = changeRecord(state, current, schedule, previous, "HospitalTaskReservationCancelled", input.correlationId);
        return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, schedule, { input }), result: schedule };
      });
    }
  };
}
