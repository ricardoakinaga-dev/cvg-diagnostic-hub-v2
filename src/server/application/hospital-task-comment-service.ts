import type { HospitalTask, HospitalTaskComment, HospitalTaskCommentView } from "@cvg/contracts";
import type { StoreState, User } from "../domain/models";
import type { ApplicationServiceContext } from "./service-context";
import type { HospitalTaskCommentCreateInput, HospitalTaskCommentDeleteInput, HospitalTaskCommentFilters, HospitalTaskCommentPatchInput } from "./hospital-task-comment-types";
import { ApiError } from "../http/envelope";
import { canAccessResource } from "../security/authorization";
import { createAudit, createOutbox, ensureExpectedVersion, findOrThrowScoped, id, now, requireActiveUser, requireIdempotencyKey, requirePermission, requireText, saveIdempotency, withIdempotency } from "./service-common";
import { canAccessHospitalTask, requireHospitalTaskAccess } from "./hospital-task-policy";
import { pagePlannerObjects, validateTaskBody } from "./hospital-task-common";
import { hospitalTaskCommentCreateSchema, hospitalTaskCommentDeleteSchema, hospitalTaskCommentFiltersSchema, hospitalTaskCommentPatchSchema } from "../http/hospital-task-comment-schemas";
import { appendWorkNotifications, workActivityFollowers } from "./work-notification-policy";

function taskForComments(state: StoreState, actor: User, taskId: string, permission: "hospital_task.comment.view" | "hospital_task.comment.create") {
  const task = findOrThrowScoped(state.hospitalTasks.find((entry) => entry.id === taskId)); requireHospitalTaskAccess(state, actor, "hospital_task.view", task); requireHospitalTaskAccess(state, actor, permission, task); return task;
}
export function hospitalTaskCommentView(actor: User, task: HospitalTask, comment: HospitalTaskComment, state: StoreState): HospitalTaskCommentView {
  const mayEdit = !comment.deletedAt && canAccessResource(actor, "hospital_task.comment.edit_own", { departmentCode: task.departmentCode, ownerId: comment.authorId });
  const mayModerate = !comment.deletedAt && canAccessResource(actor, "hospital_task.comment.moderate", { departmentCode: task.departmentCode });
  const visible = comment.deletedAt ? { ...comment, body: "", mentionedUserIds: [], revisions: [], deleteReason: undefined } : comment;
  return { comment: visible, permissions: ["hospital_task.comment.view", ...(mayEdit ? ["hospital_task.comment.edit_own" as const] : []), ...(mayModerate ? ["hospital_task.comment.moderate" as const] : [])], author: { id: comment.authorId, displayName: state.users.find((entry) => entry.id === comment.authorId)?.displayName ?? "Profissional" } };
}
function validateMentions(state: StoreState, task: HospitalTask, userIds: string[]): void {
  for (const userId of userIds) {
    const user = findOrThrowScoped(state.users.find((entry) => entry.id === userId && entry.active && !entry.mustChangePassword)); const actor = requireActiveUser(state, user);
    if (!canAccessHospitalTask(state, actor, "hospital_task.view", task) || !canAccessHospitalTask(state, actor, "hospital_task.comment.view", task)) throw new ApiError("SCOPE_DENIED", "Uma menção não está autorizada para esta tarefa.", 404);
  }
}
export function createHospitalTaskCommentService({ store }: ApplicationServiceContext) {
  async function change(actor: User, taskId: string, commentId: string | undefined, action: "CREATE" | "PATCH" | "DELETE", input: HospitalTaskCommentCreateInput | HospitalTaskCommentPatchInput | HospitalTaskCommentDeleteInput): Promise<HospitalTaskCommentView> {
    return store.transaction((state) => {
      const current = requireActiveUser(state, actor); const task = taskForComments(state, current, taskId, action === "CREATE" ? "hospital_task.comment.create" : "hospital_task.comment.view");
      if (task.archivedAt) throw new ApiError("INVALID_STATE_TRANSITION", "Restaure a tarefa antes de alterar sua conversa.", 409);
      validateTaskBody(action === "CREATE" ? hospitalTaskCommentCreateSchema : action === "PATCH" ? hospitalTaskCommentPatchSchema : hospitalTaskCommentDeleteSchema, input); requireIdempotencyKey(input.idempotencyKey);
      const previous = commentId ? findOrThrowScoped(state.hospitalTaskComments.find((entry) => entry.id === commentId && entry.taskId === taskId)) : undefined;
      if (previous) {
        if (action === "PATCH" || previous.authorId === current.id) requirePermission(current, "hospital_task.comment.edit_own", { departmentCode: task.departmentCode, ownerId: previous.authorId });
        else { requireHospitalTaskAccess(state, current, "hospital_task.comment.moderate", task); requireText((input as HospitalTaskCommentDeleteInput).reason ?? "", "motivo da moderação", 500); }
      }
      const scope = `${action}:/hospital-tasks/${taskId}/comments${commentId ? `/${commentId}` : ""}`; const replay = withIdempotency<HospitalTaskCommentView>(state, current.id, scope, input.idempotencyKey, { input });
      if (replay.found) return { state, result: hospitalTaskCommentView(current, task, findOrThrowScoped(state.hospitalTaskComments.find((entry) => entry.id === replay.existing!.comment.id && entry.taskId === taskId)), state) };
      ensureExpectedVersion(previous?.version ?? task.version, input.expectedVersion); if (previous?.deletedAt) throw new ApiError("INVALID_STATE_TRANSITION", "O comentário foi removido.", 409);
      const timestamp = now(); const edit = input as HospitalTaskCommentCreateInput; const mentionedUserIds = action === "DELETE" ? previous!.mentionedUserIds : edit.mentionedUserIds ?? (action === "PATCH" ? previous!.mentionedUserIds : []); if (action !== "DELETE") validateMentions(state, task, mentionedUserIds);
      const comment: HospitalTaskComment = { ...(previous ?? { id: id("task-comment"), taskId, authorId: current.id, revisions: [], createdAt: timestamp }), body: action === "DELETE" ? previous!.body : requireText(edit.body, "comentário", 4000), mentionedUserIds: [...mentionedUserIds], revisions: previous ? [...previous.revisions, { version: previous.version, body: previous.body, mentionedUserIds: [...previous.mentionedUserIds], editedBy: current.id, editedAt: timestamp }] : [], ...(action === "DELETE" ? { deletedAt: timestamp, deletedBy: current.id, deleteReason: (input as HospitalTaskCommentDeleteInput).reason?.trim() } : {}), version: (previous?.version ?? 0) + 1, updatedAt: timestamp };
      const correlation = input.correlationId ?? id("corr"); let next = { ...state, hospitalTaskComments: previous ? state.hospitalTaskComments.map((entry) => entry.id === comment.id ? comment : entry) : [...state.hospitalTaskComments, comment], auditEvents: [...state.auditEvents, createAudit(`HospitalTaskComment${action === "CREATE" ? "Created" : action === "PATCH" ? "Edited" : "Deleted"}`, current.id, "HospitalTaskComment", comment.id, correlation, String(previous?.version ?? 0), String(comment.version), { taskId, authorId: comment.authorId, moderated: action === "DELETE" && comment.authorId !== current.id, reason: action === "DELETE" ? comment.deleteReason ?? null : null })], outbox: [...state.outbox, createOutbox("HospitalTaskCommentChanged", "HospitalTaskComment", comment.id, correlation, { taskId, version: comment.version })] };
      if (action !== "DELETE") { next = appendWorkNotifications(next, { sourceKey: `comment:${comment.id}:${comment.version}`, targetType: "HOSPITAL_TASK", targetId: taskId, eventType: "TASK_COMMENTED", recipientUserIds: workActivityFollowers(next, "HOSPITAL_TASK", taskId).filter((entry) => entry !== current.id && !mentionedUserIds.includes(entry)), createdAt: timestamp }); next = appendWorkNotifications(next, { sourceKey: `mention:${comment.id}:${comment.version}`, targetType: "HOSPITAL_TASK", targetId: taskId, eventType: "TASK_MENTIONED", recipientUserIds: mentionedUserIds.filter((entry) => entry !== current.id), createdAt: timestamp }); }
      const result = hospitalTaskCommentView(current, task, comment, next); return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, result, { input }), result };
    });
  }
  return {
    async listHospitalTaskComments(actor: User, taskId: string, filters: HospitalTaskCommentFilters = {}) { validateTaskBody(hospitalTaskCommentFiltersSchema, filters); const state = await store.readState(); const current = requireActiveUser(state, actor); const task = taskForComments(state, current, taskId, "hospital_task.comment.view"); const page = pagePlannerObjects(state.hospitalTaskComments.filter((entry) => entry.taskId === taskId), filters); return { ...page, items: page.items.map((entry) => hospitalTaskCommentView(current, task, entry, state)) }; },
    createHospitalTaskComment: (actor: User, taskId: string, input: HospitalTaskCommentCreateInput) => change(actor, taskId, undefined, "CREATE", input),
    updateHospitalTaskComment: (actor: User, taskId: string, commentId: string, input: HospitalTaskCommentPatchInput) => change(actor, taskId, commentId, "PATCH", input),
    deleteHospitalTaskComment: (actor: User, taskId: string, commentId: string, input: HospitalTaskCommentDeleteInput) => change(actor, taskId, commentId, "DELETE", input)
  };
}
