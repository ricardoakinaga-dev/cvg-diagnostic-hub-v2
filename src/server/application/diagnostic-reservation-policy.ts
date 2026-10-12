import type { HospitalResourceSnapshot } from "@cvg/contracts";
import type { DiagnosticItem, StoreState } from "../domain/models";
import type { ScheduleInput } from "./service-types";
import { ApiError } from "../http/envelope";
import { hasScheduleConflict, requestFor, scheduleWindow } from "./service-common";
import { validateReservationResources } from "./hospital-resource-policy";

export function diagnosticReservationWindow(state: StoreState, item: DiagnosticItem, input: ScheduleInput, capturedAt: string, excludeScheduleId?: string): { startsAt: string; endsAt: string; resource: string; resourceIds?: string[]; resourceSnapshots?: HospitalResourceSnapshot[] } {
  const window = scheduleWindow(input);
  if (input.resourceIds !== undefined) {
    const request = requestFor(state, item.requestId);
    return { ...window, ...validateReservationResources(state, { departmentCode: item.departmentCode, patientId: request.patientId, encounterId: request.encounterId }, input.resourceIds, window, capturedAt, excludeScheduleId, item) };
  }
  if (process.env.NODE_ENV === "production" || state.hospitalResources.some((resource) => resource.active && resource.kind !== "BED" && resource.departmentCode === item.departmentCode)) throw new ApiError("RESOURCE_INVENTORY_REQUIRED", "Selecione os recursos cadastrados por ID. Configure o inventário e a disponibilidade antes de reservar.", 422, { nextAction: "Cadastrar profissional, sala ou equipamento e suas janelas de disponibilidade." });
  const excluded = excludeScheduleId ? state.schedules.find((schedule) => schedule.id === excludeScheduleId)?.procedureId : undefined;
  if (hasScheduleConflict(state, window, excluded)) throw new ApiError("SCHEDULE_CONFLICT", "O recurso legado já está reservado neste intervalo.", 409);
  return window;
}
export function validateDiagnosticReservationStart(state: StoreState, item: DiagnosticItem, procedureId: string, at: string): void {
  const schedule = state.schedules.find((entry) => entry.procedureId === procedureId && entry.status === "SCHEDULED");
  const linkedHistory = state.schedules.some((entry) => entry.procedureId === procedureId && entry.resourceIds?.length);
  if (!schedule) {
    if (linkedHistory) throw new ApiError("RESERVATION_NOT_CURRENT", "O procedimento não possui reserva vinculada vigente.", 409);
    return;
  }
  if (!schedule.resourceIds?.length) return;
  if (at < schedule.startsAt || at >= schedule.endsAt) throw new ApiError("RESERVATION_NOT_CURRENT", "Inicie o procedimento dentro da janela da reserva ou remarque explicitamente.", 409);
  const request = requestFor(state, item.requestId);
  validateReservationResources(state, { departmentCode: item.departmentCode, patientId: request.patientId, encounterId: request.encounterId }, schedule.resourceIds, schedule, at, schedule.id, item);
}
