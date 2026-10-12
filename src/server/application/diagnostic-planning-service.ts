import type { DiagnosticPlanning, Permission, Priority } from "@cvg/contracts";
import type { DiagnosticItem, User, StoreState } from "../domain/models";
import type { ApplicationServiceContext } from "./service-context";
import type { CommandMeta, ItemCommandResult } from "./service-types";
import { ApiError } from "../http/envelope";
import { canViewItem, createAudit, createOutbox, ensureExpectedVersion, findOrThrow, id, isExecutorRole, itemFor, now, requireActiveUser, requireIdempotencyKey, requireItemPermission, requireText, requestFor, requestViewForActor, saveIdempotency, serviceFor, withIdempotency } from "./service-common";
import { itemAssignmentSchema, itemPlanningSchema, itemPrioritySchema } from "../http/diagnostic-planning-schemas";

type AssignmentInput = CommandMeta & { userId: string | null };
type PlanningInput = CommandMeta & { plannedStartsAt: string | null; plannedEndsAt: string | null };
type PriorityInput = CommandMeta & { priority: Priority; reason: string };
const terminal = new Set(["COMPLETED", "CANCELLED", "REJECTED", "FAILED", "RESULT_VOIDED"]);
function eligible(state: StoreState, user: User, item: DiagnosticItem) {
  if (user.active === false) return false;
  const current = requireActiveUser(state, user);
  const department = state.departments.find((entry) => entry.code === item.departmentCode);
  return current.active !== false && canViewItem(state, current, item) && (current.role === "SUPERADMIN" || current.role === "MANAGER" || isExecutorRole(current) && current.departmentCode === item.departmentCode && Boolean(department?.active && department.memberUserIds.includes(current.id)));
}
function validateBody(input: AssignmentInput | PlanningInput | PriorityInput, action: "ASSIGN" | "PLAN" | "PRIORITY") {
  const { idempotencyKey: _key, correlationId: _correlation, ...body } = input;
  const schema = action === "ASSIGN" ? itemAssignmentSchema : action === "PLAN" ? itemPlanningSchema : itemPrioritySchema;
  if (!schema.safeParse(body).success) throw new ApiError("VALIDATION_ERROR", "Os dados de planejamento são inválidos.", 400);
}

export function createDiagnosticPlanningService({ store }: ApplicationServiceContext) {
  async function change(actor: User, itemId: string, input: AssignmentInput | PlanningInput | PriorityInput, action: "ASSIGN" | "PLAN" | "PRIORITY"): Promise<ItemCommandResult> {
    return store.transaction((state) => {
      const current = requireActiveUser(state, actor);
      const previous = itemFor(state, itemId);
      const permission: Permission = action === "ASSIGN" ? "item.assignment.update" : action === "PLAN" ? "item.plan.update" : "item.priority.update";
      requireItemPermission(state, current, permission, previous);
      requireIdempotencyKey(input.idempotencyKey);
      const scope = `PUT:/diagnostic-items/${itemId}/planning/${action}`;
      const replay = withIdempotency<ItemCommandResult>(state, current.id, scope, input.idempotencyKey, { input });
      if (replay.found) return { state, result: replay.existing! };
      validateBody(input, action);
      ensureExpectedVersion(previous.version, input.expectedVersion);
      if (terminal.has(previous.status)) throw new ApiError("INVALID_STATE_TRANSITION", "Este exame já foi encerrado.", 409);
      const timestamp = now();
      let patch: Partial<DiagnosticItem> = {};
      let metadata: Record<string, string | number | boolean> = { unit: "ITEM", clinicalStateChanged: false };
      if (action === "ASSIGN") {
        const targetId = (input as AssignmentInput).userId;
        if (isExecutorRole(current) && (targetId !== current.id || previous.assignedUserId && previous.assignedUserId !== current.id)) throw new ApiError("SCOPE_DENIED", "Somente a gestão pode reatribuir outro profissional.", 404);
        if (targetId) {
          const target = findOrThrow(state.users.find((entry) => entry.id === targetId));
          if (!eligible(state, target, previous)) throw new ApiError("SCOPE_DENIED", "O profissional não está elegível para este exame.", 404);
          patch = { assignedUserId: targetId, assignedAt: timestamp, assignedBy: current.id };
        } else patch = { assignedUserId: undefined, assignedAt: undefined, assignedBy: undefined };
        metadata = { ...metadata, previousAssignedUserId: previous.assignedUserId ?? "", assignedUserId: targetId ?? "" };
      } else if (action === "PLAN") {
        if (isExecutorRole(current) && previous.assignedUserId !== current.id) throw new ApiError("SCOPE_DENIED", "Assuma o exame antes de planejar suas datas.", 404);
        const dates = input as PlanningInput;
        patch = { plannedStartsAt: dates.plannedStartsAt ?? undefined, plannedEndsAt: dates.plannedEndsAt ?? undefined } satisfies Partial<DiagnosticPlanning>;
        metadata = { ...metadata, plannedStartsAt: dates.plannedStartsAt ?? "", plannedEndsAt: dates.plannedEndsAt ?? "", slaChanged: false, reservationCreated: false };
      } else {
        const priority = input as PriorityInput;
        const service = serviceFor(state, previous.serviceId);
        const slaHours = previous.definitionSnapshot?.definition.slaHours ?? (service.version === previous.slaPolicyVersion ? service.slaHours : undefined);
        if (!slaHours) throw new ApiError("SLA_POLICY_UNAVAILABLE", "A política histórica de prazo não está disponível para reclassificar este exame.", 409);
        const dueAt = new Date(Date.parse(previous.slaStartedAt) + slaHours[priority.priority] * 3_600_000).toISOString();
        patch = { priority: priority.priority, dueAt };
        metadata = { ...metadata, previousPriority: previous.priority, priority: priority.priority, previousDueAt: previous.dueAt, dueAt, reason: requireText(priority.reason, "motivo", 500), slaStartedAt: previous.slaStartedAt, slaPolicyVersion: previous.slaPolicyVersion, criticalityChanged: false };
      }
      const updated = { ...previous, ...patch, version: previous.version + 1 };
      const request = requestFor(state, previous.requestId);
      const correlationId = input.correlationId ?? id("corr");
      const eventType = action === "ASSIGN" ? "DiagnosticItemAssigned" : action === "PLAN" ? "DiagnosticItemPlanned" : "DiagnosticItemPriorityChanged";
      const next = { ...state, items: state.items.map((item) => item.id === itemId ? updated : item), requests: state.requests.map((entry) => entry.id === request.id ? { ...entry, updatedAt: timestamp, version: entry.version + 1 } : entry), auditEvents: [...state.auditEvents, createAudit(eventType, current.id, "DiagnosticRequestItem", itemId, correlationId, previous.status, previous.status, metadata)], outbox: [...state.outbox, createOutbox(eventType, "DiagnosticRequestItem", itemId, correlationId, { itemId, version: updated.version })] };
      const result = { item: updated, request: requestViewForActor(next, current, requestFor(next, request.id)) };
      return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, result, { input }), result };
    });
  }
  return {
    async listDiagnosticItemAssignees(actor: User, itemId: string) {
      const state = await store.readState();
      const current = requireActiveUser(state, actor);
      const item = itemFor(state, itemId);
      requireItemPermission(state, current, "item.assignment.update", item);
      return state.users.filter((user) => user.active !== false && (!isExecutorRole(current) || user.id === current.id) && eligible(state, user, item)).map((user) => ({ id: user.id, displayName: user.displayName, role: user.role, departmentCode: user.departmentCode }));
    },
    assignDiagnosticItem: (actor: User, itemId: string, input: AssignmentInput) => change(actor, itemId, input, "ASSIGN"),
    planDiagnosticItem: (actor: User, itemId: string, input: PlanningInput) => change(actor, itemId, input, "PLAN"),
    reprioritizeDiagnosticItem: (actor: User, itemId: string, input: PriorityInput) => change(actor, itemId, input, "PRIORITY")
  };
}
