import type { HospitalCareExecution, HospitalTask, HospitalTaskView } from "@cvg/contracts";
import type { ApplicationServiceContext } from "./service-context";
import type { User } from "../domain/models";
import { ApiError } from "../http/envelope";
import { hospitalCareExecuteSchema, type HospitalCareExecuteInput } from "../http/hospital-care-schemas";
import { commandBody, validateCommand } from "./hospital-service-policy";
import { ensureExpectedVersion, id, now, requireActiveUser, requireIdempotencyKey, saveIdempotency, withIdempotency } from "./service-common";
import { dependencyTarget, mayExecuteTask, requireHospitalTaskAccess, requirePublishedHospitalTask, validateNewTaskContext } from "./hospital-task-policy";
import { hospitalTaskView, recordTaskChange } from "./hospital-task-common";
import { requireChecklistComplete } from "./hospital-checklist-policy";
import { validateReservationResources } from "./hospital-resource-policy";

export function createHospitalCareService({ store }: ApplicationServiceContext) {
  return {
    async executeHospitalCare(actor: User, taskId: string, input: HospitalCareExecuteInput): Promise<HospitalTaskView> {
      return store.transaction((state) => {
        const current = requireActiveUser(state, actor); const task = state.hospitalTasks.find((entry) => entry.id === taskId);
        if (!task) throw new ApiError("NOT_FOUND", "A atividade assistencial não está disponível.", 404);
        requireHospitalTaskAccess(state, current, "hospital_task.view", task); requireHospitalTaskAccess(state, current, "care.execute", task);
        requirePublishedHospitalTask(task);
        if (!mayExecuteTask(state, current, task)) throw new ApiError("SCOPE_DENIED", "O executor não está habilitado e atribuído a esta atividade.", 404);
        const body = validateCommand(hospitalCareExecuteSchema, commandBody(input)); requireIdempotencyKey(input.idempotencyKey);
        const scope = `POST:/hospital-tasks/${taskId}/care-execution`; const replay = withIdempotency<HospitalTaskView>(state, current.id, scope, input.idempotencyKey, { input });
        if (replay.found) return { state, result: hospitalTaskView(state, current, task) };
        ensureExpectedVersion(task.version, body.expectedVersion);
        const snapshot = task.checklistSnapshot; const process = snapshot?.clinicalProcess;
        if (!snapshot || !process || !snapshot.approvedBy || !Number.isFinite(Date.parse(snapshot.approvedAt)) || !snapshot.careContextRequired) throw new ApiError("CARE_PROCESS_NOT_APPROVED", "Esta atividade não possui processo clínico aprovado e congelado.", 409);
        if (!task.patientId || !task.encounterId) throw new ApiError("CARE_CONTEXT_REQUIRED", "O processo exige paciente e atendimento vinculados.", 400);
        validateNewTaskContext(state, task, true);
        if (!process.allowedExecutorRoles.includes(current.role)) throw new ApiError("CARE_EXECUTOR_NOT_ELIGIBLE", "O perfil do executor não pertence à modalidade aprovada deste processo.", 422);
        if (task.serviceSnapshot && (task.serviceSnapshot.source !== "HOSPITAL_SERVICE" || task.serviceSnapshot.kind !== process.modality)) throw new ApiError("CARE_MODALITY_MISMATCH", "A modalidade do processo não corresponde ao serviço congelado nesta atividade.", 422);
        if (task.phase !== "IN_PROGRESS" || task.careExecution) throw new ApiError("INVALID_STATE_TRANSITION", "Inicie a atividade antes de confirmar uma única execução assistencial.", 409);
        requireChecklistComplete(task);
        for (const dependency of state.hospitalTaskDependencies.filter((entry) => entry.taskId === task.id && entry.active && entry.blocks === "COMPLETE")) {
          let satisfied = false; try { satisfied = dependencyTarget(state, current, dependency.targetType, dependency.targetId).satisfied; } catch { /* Opaque refusal for dependencies whose access was withdrawn. */ }
          if (!satisfied) throw new ApiError("DEPENDENCY_PENDING", "Uma dependência de conclusão ainda está pendente.", 409);
        }
        const timestamp = now(); const schedule = state.schedules.find((entry) => entry.hospitalTaskId === task.id && entry.status === "SCHEDULED");
        if (!task.startedAt || timestamp < task.startedAt) throw new ApiError("INVALID_STATE_TRANSITION", "O horário atual antecede o início registrado.", 409);
        let resourceSnapshots: HospitalCareExecution["resourceSnapshots"] = [];
        if (schedule) {
          if (!schedule.resourceIds?.length || task.startedAt < schedule.startsAt || task.startedAt >= schedule.endsAt) throw new ApiError("CARE_RESERVATION_UNAVAILABLE", "A execução exige ter iniciado dentro da reserva vinculada vigente.", 409);
          const binding = validateReservationResources(state, task, schedule.resourceIds, schedule, timestamp, schedule.id);
          const professionals = binding.resourceSnapshots.filter((resource) => resource.kind === "PROFESSIONAL");
          if (professionals.length && !professionals.some((resource) => resource.userId === current.id)) throw new ApiError("CARE_EXECUTOR_NOT_RESERVED", "O executor não é um dos profissionais desta reserva.", 422);
          resourceSnapshots = binding.resourceSnapshots;
        }
        const execution: HospitalCareExecution = { id: id("care-execution"), performedAt: timestamp, performedBy: current.id, modality: process.modality, templateId: snapshot.templateId, templateVersion: snapshot.templateVersion, approvedBy: snapshot.approvedBy, approvedAt: snapshot.approvedAt, clinicalRecordReference: body.clinicalRecordReference, clinicalSystemReference: process.clinicalSystemReference, confirmationPolicyReference: process.confirmationPolicyReference, resourceSnapshots, ...(body.note ? { note: body.note } : {}), recordEvidence: "EXECUTOR_REFERENCE" };
        const target = task.typeSnapshot.states.find((entry) => entry.phase === "COMPLETED"); if (!target) throw new ApiError("INVALID_STATE_TRANSITION", "O tipo congelado da tarefa não contém estado de conclusão.", 409);
        const completed: HospitalTask = { ...task, phase: "COMPLETED", status: target.code, completedAt: timestamp, completedBy: current.id, completionNote: body.note, careExecution: execution, version: task.version + 1, updatedAt: timestamp };
        let next = recordTaskChange(state, current, task, completed, "HospitalCareExecuted", input.correlationId, { executorId: current.id, templateId: snapshot.templateId, templateVersion: snapshot.templateVersion, modality: process.modality, clinicalRecordReference: body.clinicalRecordReference, clinicalSystemReference: process.clinicalSystemReference, confirmationPolicyReference: process.confirmationPolicyReference, recordEvidence: "EXECUTOR_REFERENCE", resourceIds: resourceSnapshots.map((resource) => resource.resourceId).join(",") });
        next = { ...next, schedules: next.schedules.map((entry) => entry.hospitalTaskId === task.id && entry.status === "SCHEDULED" ? { ...entry, status: "COMPLETED", version: entry.version + 1 } : entry) };
        const result = hospitalTaskView(next, current, completed); return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, result, { input }), result };
      });
    }
  };
}
