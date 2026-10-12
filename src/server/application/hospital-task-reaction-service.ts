import type { HospitalTask, HospitalTaskComment, HospitalTaskReaction } from "@cvg/contracts";
import type { User } from "../domain/models";
import type { ApplicationServiceContext } from "./service-context";
import type { CommandMeta } from "./service-types";
import { ApiError } from "../http/envelope";
import { createAudit, createOutbox, ensureExpectedVersion, findOrThrowScoped, id, now, requireActiveUser, requireIdempotencyKey, saveIdempotency, withIdempotency } from "./service-common";
import { requireHospitalTaskAccess } from "./hospital-task-policy";
import { hospitalTaskView, validateTaskBody } from "./hospital-task-common";
import { hospitalTaskCommentView } from "./hospital-task-comment-service";
import { hospitalTaskReactionSchema } from "../http/hospital-task-reaction-schemas";
export type HospitalTaskReactionInput = CommandMeta & { code: HospitalTaskReaction["code"]; active: boolean };
export function createHospitalTaskReactionService({ store }: ApplicationServiceContext) {
  function change(actor: User, taskId: string, commentId: string | undefined, input: HospitalTaskReactionInput) {
    return store.transaction((state) => {
      const current = requireActiveUser(state, actor); const task = findOrThrowScoped(state.hospitalTasks.find((entry) => entry.id === taskId)); requireHospitalTaskAccess(state, current, "hospital_task.view", task); requireHospitalTaskAccess(state, current, "hospital_task.comment.view", task); requireHospitalTaskAccess(state, current, "hospital_task.comment.create", task);
      if (task.archivedAt) throw new ApiError("INVALID_STATE_TRANSITION", "A tarefa arquivada mantém seu histórico de reações.", 409);
      validateTaskBody(hospitalTaskReactionSchema, input); requireIdempotencyKey(input.idempotencyKey); const previous = commentId ? findOrThrowScoped(state.hospitalTaskComments.find((entry) => entry.id === commentId && entry.taskId === taskId && !entry.deletedAt)) : task;
      const view = (target: HospitalTask | HospitalTaskComment) => commentId ? hospitalTaskCommentView(current, task, target as HospitalTaskComment, state) : hospitalTaskView(state, current, target as HospitalTask);
      const scope = `PUT:/hospital-tasks/${taskId}${commentId ? `/comments/${commentId}` : ""}/reactions`; const replay = withIdempotency(state, current.id, scope, input.idempotencyKey, { input }); if (replay.found) return { state, result: view(previous) };
      ensureExpectedVersion(previous.version, input.expectedVersion); const reactions = (previous.reactions ?? []).filter((entry) => entry.userId !== current.id || entry.code !== input.code); const timestamp = now(); if (input.active) reactions.push({ userId: current.id, code: input.code, createdAt: previous.reactions?.find((entry) => entry.userId === current.id && entry.code === input.code)?.createdAt ?? timestamp });
      const changed = { ...previous, reactions, version: previous.version + 1, updatedAt: timestamp }; const correlation = input.correlationId ?? id("corr"); const entityType = commentId ? "HospitalTaskComment" : "HospitalTask";
      const next = { ...state, hospitalTasks: commentId ? state.hospitalTasks : state.hospitalTasks.map((entry) => entry.id === taskId ? changed as HospitalTask : entry), hospitalTaskComments: commentId ? state.hospitalTaskComments.map((entry) => entry.id === commentId ? changed as HospitalTaskComment : entry) : state.hospitalTaskComments, auditEvents: [...state.auditEvents, createAudit("HospitalTaskReactionChanged", current.id, entityType, previous.id, correlation, String(previous.version), String(changed.version), { taskId, code: input.code, active: input.active, clinicalAcknowledgement: false })], outbox: [...state.outbox, createOutbox("HospitalTaskReactionChanged", entityType, previous.id, correlation, { taskId, version: changed.version })] }; const result = view(changed);
      return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, result, { input }), result };
    });
  }
  return {
    setHospitalTaskReaction: (actor: User, taskId: string, input: HospitalTaskReactionInput) => change(actor, taskId, undefined, input),
    setHospitalTaskCommentReaction: (actor: User, taskId: string, commentId: string, input: HospitalTaskReactionInput) => change(actor, taskId, commentId, input)
  };
}
