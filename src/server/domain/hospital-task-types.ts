import type { HospitalTaskState, HospitalTaskType } from "@cvg/contracts";

export function initialHospitalTaskTypes(timestamp: string): HospitalTaskType[] {
  const states: HospitalTaskState[] = [{ code: "PENDING", label: "Pendente", phase: "PENDING" }, { code: "IN_PROGRESS", label: "Em execução", phase: "IN_PROGRESS" }, { code: "COMPLETED", label: "Concluída", phase: "COMPLETED" }, { code: "CANCELLED", label: "Cancelada", phase: "CANCELLED" }];
  return [{ code: "ROUTINE", name: "Rotina operacional", careContextRequired: false }, { code: "CARE", name: "Cuidado assistencial", careContextRequired: true }].map((entry) => ({ ...entry, id: `hospital-task-type-${entry.code.toLowerCase()}`, states: structuredClone(states), active: true, version: 1, createdAt: timestamp, updatedAt: timestamp }));
}
