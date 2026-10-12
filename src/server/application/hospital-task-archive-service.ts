import type { HospitalTaskView, Permission } from "@cvg/contracts";
import type { User } from "../domain/models";
import type { ApplicationServiceContext } from "./service-context";
import type { CommandMeta } from "./service-types";
import type { z } from "zod";
import { ApiError } from "../http/envelope";
import { hospitalTaskArchiveSchema, hospitalTaskBatchSchema } from "../http/hospital-task-archive-schemas";
import { ensureExpectedVersion, findOrThrowScoped, hashPayload, now, requireActiveUser, requireIdempotencyKey, requirePermission, saveIdempotency, withIdempotency } from "./service-common";
import { hospitalTaskView, recordTaskChange, validateTaskBody } from "./hospital-task-common";
import { requireHospitalTaskAccess, requireHospitalTaskArchiveAuthority } from "./hospital-task-policy";
import { createHospitalTaskService } from "./hospital-task-service";
export type HospitalTaskArchiveInput = CommandMeta & z.infer<typeof hospitalTaskArchiveSchema>;
export type HospitalTaskBatchInput = CommandMeta & z.infer<typeof hospitalTaskBatchSchema>;
type BatchItem = { taskId: string; ok: true; result: HospitalTaskView } | { taskId: string; ok: false; error: { code: string; status: number } };
export interface HospitalTaskBatchResult { items: BatchItem[]; successCount: number; failureCount: number }
type BatchReceipt = HospitalTaskBatchResult & { inProgress?: true };
export function createHospitalTaskArchiveService(context: ApplicationServiceContext) {
  const { store } = context; const taskService = createHospitalTaskService(context);
  async function setHospitalTaskArchived(actor: User, taskId: string, input: HospitalTaskArchiveInput): Promise<HospitalTaskView> {
    return store.transaction((state) => {
      const current = requireActiveUser(state, actor); validateTaskBody(hospitalTaskArchiveSchema, input); requireIdempotencyKey(input.idempotencyKey); const previous = findOrThrowScoped(state.hospitalTasks.find((entry) => entry.id === taskId)); requireHospitalTaskArchiveAuthority(state, current, previous, input.archived ? "hospital_task.archive" : "hospital_task.restore");
      const scope = `POST:/hospital-tasks/${taskId}/archive`; const replay = withIdempotency<HospitalTaskView>(state, current.id, scope, input.idempotencyKey, { input }); if (replay.found) return { state, result: hospitalTaskView(state, current, previous) };
      ensureExpectedVersion(previous.version, input.expectedVersion); if (Boolean(previous.archivedAt) === input.archived) throw new ApiError("INVALID_STATE_TRANSITION", "A tarefa já está no estado de arquivo solicitado.", 409);
      const timestamp = now(); const task = { ...previous, archivedAt: input.archived ? timestamp : undefined, archivedBy: input.archived ? current.id : undefined, version: previous.version + 1, updatedAt: timestamp }; const next = recordTaskChange(state, current, previous, task, input.archived ? "HospitalTaskArchived" : "HospitalTaskRestored", input.correlationId, { archived: input.archived, executionChanged: false, retentionChanged: false }); const result = hospitalTaskView(next, current, task);
      return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, result, { input }), result };
    });
  }
  const actionPermission = (operation: HospitalTaskBatchInput["operations"][number]): Permission => operation.action === "ARCHIVE" ? operation.archived ? "hospital_task.archive" : "hospital_task.restore" : operation.action === "ASSIGN" ? "hospital_task.assign" : operation.action === "PRIORITY" ? "hospital_task.priority.update" : "hospital_task.execute";
  return {
    setHospitalTaskArchived,
    async batchHospitalTasks(actor: User, input: HospitalTaskBatchInput): Promise<HospitalTaskBatchResult> {
      validateTaskBody(hospitalTaskBatchSchema, input); requireIdempotencyKey(input.idempotencyKey); const scope = "POST:/hospital-tasks/batch";
      const replay = await store.transaction((state) => { const current = requireActiveUser(state, actor); requirePermission(current, "hospital_task.view", {}); const receipt = withIdempotency<BatchReceipt>(state, current.id, scope, input.idempotencyKey, { input }); return { state: receipt.found ? state : saveIdempotency(state, current.id, scope, input.idempotencyKey, { items: [], successCount: 0, failureCount: 0, inProgress: true }, { input }), result: receipt }; });
      const completedReplay = replay.found && !replay.existing!.inProgress;
      const items: BatchItem[] = [];
      if (!completedReplay) for (const operation of input.operations) {
        const { taskId, action, ...body } = operation; const command = { ...body, idempotencyKey: `batch:${hashPayload({ key: input.idempotencyKey, input, taskId }).slice(0, 64)}`, correlationId: input.correlationId };
        try { const result = action === "ARCHIVE" ? await setHospitalTaskArchived(actor, taskId, command as HospitalTaskArchiveInput) : action === "ASSIGN" ? await taskService.assignHospitalTask(actor, taskId, command as Parameters<typeof taskService.assignHospitalTask>[2]) : action === "PRIORITY" ? await taskService.reprioritizeHospitalTask(actor, taskId, command as Parameters<typeof taskService.reprioritizeHospitalTask>[2]) : await taskService.commandHospitalTask(actor, taskId, command as Parameters<typeof taskService.commandHospitalTask>[2]); items.push({ taskId, ok: true, result }); }
        catch (error) { if (!(error instanceof ApiError)) throw error; items.push({ taskId, ok: false, error: { code: error.code, status: error.status } }); }
      }
      return store.transaction((state) => {
        const current = requireActiveUser(state, actor); requirePermission(current, "hospital_task.view", {});
        const refreshed = (completedReplay ? replay.existing!.items : items).map((item): BatchItem => { if (!item.ok) return item; try { const task = findOrThrowScoped(state.hospitalTasks.find((entry) => entry.id === item.taskId)); const operation = input.operations.find((entry) => entry.taskId === item.taskId)!; requireHospitalTaskAccess(state, current, actionPermission(operation), task); if (operation.action === "ARCHIVE") requireHospitalTaskArchiveAuthority(state, current, task, actionPermission(operation) as "hospital_task.archive" | "hospital_task.restore"); return { taskId: item.taskId, ok: true, result: hospitalTaskView(state, current, task) }; } catch (error) { if (!(error instanceof ApiError)) throw error; return { taskId: item.taskId, ok: false, error: { code: error.code, status: error.status } }; } });
        const result = { items: refreshed, successCount: refreshed.filter((item) => item.ok).length, failureCount: refreshed.filter((item) => !item.ok).length };
        return { state: completedReplay ? state : saveIdempotency(state, current.id, scope, input.idempotencyKey, result, { input }), result };
      });
    }
  };
}
