import type { HospitalTaskView } from "@cvg/contracts";
import type { User } from "../domain/models";
import type { ApplicationServiceContext } from "./service-context";
import type { CommandMeta } from "./service-types";
import type { HospitalTaskCreateInput } from "./hospital-task-types";
import { ApiError } from "../http/envelope";
import { ensureExpectedVersion, findOrThrowScoped, now, requireActiveUser, requireIdempotencyKey, saveIdempotency, withIdempotency } from "./service-common";
import { buildHospitalTask, hospitalTaskView, recordTaskChange, validateTaskBody } from "./hospital-task-common";
import { requireHospitalTaskAccess } from "./hospital-task-policy";
import { hospitalTaskDraftCommandSchema, hospitalTaskDraftCreateSchema } from "../http/hospital-task-draft-schemas";
export type HospitalTaskDraftCommandInput = CommandMeta & { command: "PUBLISH" | "DISCARD" };
export function createHospitalTaskDraftService({ store }: ApplicationServiceContext) {
  return {
    async createHospitalTaskDraft(actor: User, input: HospitalTaskCreateInput): Promise<HospitalTaskView> {
      return store.transaction((state) => {
        const current = requireActiveUser(state, actor); validateTaskBody(hospitalTaskDraftCreateSchema, input); requireIdempotencyKey(input.idempotencyKey); requireHospitalTaskAccess(state, current, "hospital_task.create", input);
        const scope = "POST:/hospital-task-drafts"; const replay = withIdempotency<HospitalTaskView>(state, current.id, scope, input.idempotencyKey, { input }); if (replay.found) return { state, result: hospitalTaskView(state, current, findOrThrowScoped(state.hospitalTasks.find((entry) => entry.id === replay.existing!.task.id)), "hospital_task.create") };
        if (input.parentTaskId) throw new ApiError("VALIDATION_ERROR", "Vincule a subtarefa depois de publicar o rascunho.", 400);
        const task = { ...buildHospitalTask(state, current, input), isDraft: true }; const next = recordTaskChange(state, current, undefined, task, "HospitalTaskDraftCreated", input.correlationId, { executionCreated: false }); const result = hospitalTaskView(next, current, task, "hospital_task.create"); return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, result, { input }), result };
      });
    },
    async commandHospitalTaskDraft(actor: User, taskId: string, input: HospitalTaskDraftCommandInput): Promise<HospitalTaskView> {
      return store.transaction((state) => {
        const current = requireActiveUser(state, actor); const previous = findOrThrowScoped(state.hospitalTasks.find((entry) => entry.id === taskId)); requireHospitalTaskAccess(state, current, "hospital_task.view", previous); requireHospitalTaskAccess(state, current, "hospital_task.update", previous); if (input.command === "PUBLISH") requireHospitalTaskAccess(state, current, "hospital_task.create", previous); validateTaskBody(hospitalTaskDraftCommandSchema, input); requireIdempotencyKey(input.idempotencyKey);
        const scope = `POST:/hospital-task-drafts/${taskId}/commands`; const replay = withIdempotency<HospitalTaskView>(state, current.id, scope, input.idempotencyKey, { input }); if (replay.found) return { state, result: hospitalTaskView(state, current, previous) };
        ensureExpectedVersion(previous.version, input.expectedVersion); if (!previous.isDraft || previous.draftCancelledAt) throw new ApiError("INVALID_STATE_TRANSITION", "Este rascunho já foi publicado ou descartado.", 409); const timestamp = now();
        const published = input.command === "PUBLISH" ? buildHospitalTask(state, current, { title: previous.title, description: previous.description, descriptionContent: previous.descriptionContent, typeId: previous.typeId, departmentCode: previous.departmentCode, patientId: previous.patientId, encounterId: previous.encounterId, priority: previous.priority, responsibleUserId: previous.responsibleUserId, executorTeamUserIds: previous.executorTeamUserIds, participantUserIds: previous.participantUserIds, plannedStartAt: previous.plannedStartAt, plannedEndAt: previous.plannedEndAt, serviceId: previous.serviceSnapshot?.serviceId, checklistTemplateId: previous.checklistSnapshot?.templateId, documentIds: previous.documentSnapshots?.map((entry) => entry.documentId), estimatedMinutes: previous.estimatedMinutes, labels: previous.labels, externalReferences: previous.externalReferences }) : undefined;
        const task = published ? { ...previous, ...published, id: previous.id, taskCode: previous.taskCode, authorId: previous.authorId, createdAt: previous.createdAt, isDraft: false, version: previous.version + 1, updatedAt: timestamp } : { ...previous, draftCancelledAt: timestamp, draftCancelledBy: current.id, version: previous.version + 1, updatedAt: timestamp }; const next = recordTaskChange(state, current, previous, task, published ? "HospitalTaskDraftPublished" : "HospitalTaskDraftDiscarded", input.correlationId, { executionStarted: false, clinicalStateChanged: false }); const result = hospitalTaskView(next, current, task); return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, result, { input }), result };
      });
    }
  };
}
