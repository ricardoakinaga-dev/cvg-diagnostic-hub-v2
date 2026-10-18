import { captureApprovedHospitalDocuments } from "./hospital-document-policy";
import type { HospitalPlan, HospitalPlanView } from "@cvg/contracts";
import type { User, StoreState } from "../domain/models";
import type { ApplicationServiceContext } from "./service-context";
import type { HospitalPlanCommandInput, HospitalPlanCreateInput, HospitalPlanFilters, HospitalPlanLinkInput, HospitalPlanPatchInput } from "./hospital-plan-types";
import { ApiError } from "../http/envelope";
import { hospitalPlanCommandSchema, hospitalPlanCreateSchema, hospitalPlanFiltersSchema, hospitalPlanLinkSchema, hospitalPlanPatchSchema } from "../http/hospital-plan-schemas";
import { createAudit, createOutbox, ensureExpectedVersion, findOrThrowScoped, id, now, requireActiveUser, requireIdempotencyKey, requirePermission, saveIdempotency, withIdempotency } from "./service-common";
import { canAccessHospitalPlan, hospitalPlanView, planActivity, requireHospitalPlanAccess, requirePlanDepartmentBindings, requirePlanResponsible } from "./hospital-plan-policy";
import { pagePlannerObjects, validateTaskBody } from "./hospital-task-common";
import { requirePublishedHospitalTask, taskDate, validateNewTaskContext, validateTaskDates } from "./hospital-task-policy";
import { appendWorkNotifications, workActivityFollowers } from "./work-notification-policy";
import { requireHospitalCapability } from "./hospital-institution-policy";

function record(state: StoreState, actor: User, previous: HospitalPlan | undefined, plan: HospitalPlan, eventType: string, correlationId?: string, metadata: Record<string, string | number | boolean | null> = {}): StoreState {
  const correlation = correlationId ?? id("corr");
  const next = { ...state, hospitalPlans: previous ? state.hospitalPlans.map((entry) => entry.id === plan.id ? plan : entry) : [...state.hospitalPlans, plan], auditEvents: [...state.auditEvents, createAudit(eventType, actor.id, "HospitalPlan", plan.id, correlation, previous?.state, plan.state, { ...metadata, patientId: plan.patientId, encounterId: plan.encounterId, version: plan.version, linkedWorkflowsChanged: false })], outbox: [...state.outbox, createOutbox(eventType, "HospitalPlan", plan.id, correlation, { planId: plan.id, version: plan.version })] };
  return appendWorkNotifications(next, { sourceKey: `plan:${plan.id}:${plan.version}`, targetType: "HOSPITAL_PLAN", targetId: plan.id, eventType: "PLAN_UPDATED", recipientUserIds: [plan.responsibleUserId, ...workActivityFollowers(next, "HOSPITAL_PLAN", plan.id)].filter((entry): entry is string => Boolean(entry) && entry !== actor.id), createdAt: plan.updatedAt });
}
export function createHospitalPlanService({ store }: ApplicationServiceContext) {
  async function change(actor: User, planId: string, input: HospitalPlanPatchInput | HospitalPlanLinkInput | HospitalPlanCommandInput, action: "UPDATE" | "LINK" | "COMMAND"): Promise<HospitalPlanView> {
    return store.transaction((state) => {
      const current = requireActiveUser(state, actor); const previous = findOrThrowScoped(state.hospitalPlans.find((entry) => entry.id === planId));
      const command = action === "COMMAND" ? (input as HospitalPlanCommandInput).command : undefined;
      requireHospitalPlanAccess(state, current, command === "ARCHIVE" ? "plan.archive" : "plan.update", previous); requireIdempotencyKey(input.idempotencyKey);
      const scope = `${action}:/hospital-plans/${planId}`; const replay = withIdempotency<HospitalPlanView>(state, current.id, scope, input.idempotencyKey, { input });
      if (replay.found) return { state, result: hospitalPlanView(state, current, previous, command === "ARCHIVE" ? "plan.archive" : "plan.update") };
      validateTaskBody(action === "UPDATE" ? hospitalPlanPatchSchema : action === "LINK" ? hospitalPlanLinkSchema : hospitalPlanCommandSchema, input); ensureExpectedVersion(previous.version, input.expectedVersion);
      if (previous.state === "ARCHIVED" || previous.state === "CLOSED" && command !== "ARCHIVE") throw new ApiError("INVALID_STATE_TRANSITION", "O plano não aceita esta alteração após o encerramento.", 409);
      let updated = { ...previous }; const metadata: Record<string, string | number | boolean | null> = {};
      if (action === "UPDATE") {
        const edit = input as HospitalPlanPatchInput;
        if (edit.documentIds && previous.links.some((link) => link.targetType === "HOSPITAL_TASK" ? Boolean(state.hospitalTasks.find((task) => task.id === link.targetId)?.startedAt) : Boolean(state.items.find((item) => item.id === link.targetId)?.startedAt))) throw new ApiError("INVALID_STATE_TRANSITION", "Documentos usados nas atividades já iniciadas permanecem congelados no plano.", 409);
        const departmentCodes = edit.departmentCodes?.map((code) => code.trim().toUpperCase()) ?? previous.departmentCodes;
        if (edit.departmentCodes) requirePlanDepartmentBindings(state, current, departmentCodes, "plan.update");
        updated = { ...updated, title: edit.title?.trim() ?? previous.title, objective: edit.objective?.trim() ?? previous.objective, departmentCodes, responsibleUserId: edit.responsibleUserId === null ? undefined : edit.responsibleUserId ?? previous.responsibleUserId, plannedStartAt: edit.plannedStartAt === undefined ? previous.plannedStartAt : taskDate(edit.plannedStartAt), plannedEndAt: edit.plannedEndAt === undefined ? previous.plannedEndAt : taskDate(edit.plannedEndAt), steps: edit.steps ?? previous.steps, documentSnapshots: edit.documentIds ? captureApprovedHospitalDocuments(state, current, edit.documentIds, departmentCodes, now()) : previous.documentSnapshots };
        requireHospitalPlanAccess(state, current, "plan.update", updated); requirePlanResponsible(state, updated.responsibleUserId, updated); validateTaskDates(updated.plannedStartAt, updated.plannedEndAt);
        if (updated.links.some((link) => !updated.steps.some((step) => step.id === link.stepId))) throw new ApiError("CONFLICT", "Remova os vínculos da etapa antes de excluí-la.", 409);
        if (updated.links.some((link) => { const target = link.targetType === "HOSPITAL_TASK" ? state.hospitalTasks.find((entry) => entry.id === link.targetId) : state.items.find((entry) => entry.id === link.targetId); return target && !departmentCodes.includes(target.departmentCode); })) throw new ApiError("CONFLICT", "O plano deve manter os setores das atividades vinculadas.", 409);
        metadata.previousResponsibleUserId = previous.responsibleUserId ?? null; metadata.responsibleUserId = updated.responsibleUserId ?? null;
      } else if (action === "LINK") {
        const link = input as HospitalPlanLinkInput;
        if (link.active && link.targetType === "HOSPITAL_TASK") requirePublishedHospitalTask(findOrThrowScoped(state.hospitalTasks.find((task) => task.id === link.targetId)));
        if (!previous.steps.some((step) => step.id === link.stepId)) throw new ApiError("VALIDATION_ERROR", "A etapa não existe no plano.", 400);
        const old = previous.links.find((entry) => entry.stepId === link.stepId && entry.targetType === link.targetType && entry.targetId === link.targetId);
        const next = old ?? { id: id("plan-link"), stepId: link.stepId, targetType: link.targetType, targetId: link.targetId };
        const activity = planActivity(state, current, previous, next);
        if (!previous.departmentCodes.includes(activity.departmentCode)) throw new ApiError("VALIDATION_ERROR", "Inclua o setor da atividade no plano antes de vinculá-la.", 400);
        updated.links = link.active ? old ? previous.links : [...previous.links, next] : previous.links.filter((entry) => entry.id !== next.id);
        metadata.targetType = link.targetType; metadata.targetId = link.targetId; metadata.active = link.active;
      } else {
        const timestamp = now(); const commandInput = input as HospitalPlanCommandInput;
        updated = command === "CLOSE" ? { ...updated, state: "CLOSED", closedBy: current.id, closedAt: timestamp } : { ...updated, state: "ARCHIVED", archivedBy: current.id, archivedAt: timestamp };
        metadata.reason = commandInput.reason?.trim() ?? null;
      }
      updated = { ...updated, version: previous.version + 1, updatedAt: now() };
      const next = record(state, current, previous, updated, `HospitalPlan${action === "LINK" ? "LinkUpdated" : action === "COMMAND" ? command === "CLOSE" ? "Closed" : "Archived" : "Updated"}`, input.correlationId, metadata);
      const result = hospitalPlanView(next, current, updated, command === "ARCHIVE" ? "plan.archive" : "plan.update");
      return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, result, { input }), result };
    });
  }
  return {
    async listHospitalPlans(actor: User, filters: HospitalPlanFilters = {}) {
      validateTaskBody(hospitalPlanFiltersSchema, filters); const state = await store.readState(); const current = requireActiveUser(state, actor); requirePermission(current, "plan.view", {});
      const query = filters.query?.trim().toLocaleLowerCase("pt-BR");
      const rows = state.hospitalPlans.filter((plan) => canAccessHospitalPlan(state, current, "plan.view", plan) && (!filters.patientId || plan.patientId === filters.patientId) && (!filters.encounterId || plan.encounterId === filters.encounterId) && (!filters.departmentCode || plan.departmentCodes.includes(filters.departmentCode)) && (!filters.state || plan.state === filters.state) && (!query || `${plan.code} ${plan.title} ${plan.objective}`.toLocaleLowerCase("pt-BR").includes(query)));
      const page = pagePlannerObjects(rows, filters); return { ...page, items: page.items.map((plan) => hospitalPlanView(state, current, plan)) };
    },
    async getHospitalPlan(actor: User, planId: string) { const state = await store.readState(); const current = requireActiveUser(state, actor); return hospitalPlanView(state, current, findOrThrowScoped(state.hospitalPlans.find((entry) => entry.id === planId))); },
    async createHospitalPlan(actor: User, input: HospitalPlanCreateInput): Promise<HospitalPlanView> {
      return store.transaction((state) => {
        const current = requireActiveUser(state, actor); requireIdempotencyKey(input.idempotencyKey); validateTaskBody(hospitalPlanCreateSchema, input);
        const departmentCodes = input.departmentCodes.map((code) => code.trim().toUpperCase()); const context = { departmentCodes, patientId: input.patientId };
        requirePlanDepartmentBindings(state, current, departmentCodes); requireHospitalPlanAccess(state, current, "plan.create", context);
        const scope = "POST:/hospital-plans"; const replay = withIdempotency<HospitalPlanView>(state, current.id, scope, input.idempotencyKey, { input });
        if (replay.found) return { state, result: hospitalPlanView(state, current, findOrThrowScoped(state.hospitalPlans.find((entry) => entry.id === replay.existing!.plan.id)), "plan.create") };
        departmentCodes.forEach((code) => requireHospitalCapability(state, code, "PLANS"));
        validateNewTaskContext(state, { departmentCode: departmentCodes[0], patientId: input.patientId, encounterId: input.encounterId }, true); requirePlanResponsible(state, input.responsibleUserId, context);
        const timestamp = now(); const planId = id("hospital-plan");
        const plan: HospitalPlan = { id: planId, code: `PLA-${planId.slice(-12).toUpperCase()}`, title: input.title.trim(), objective: input.objective.trim(), ...context, encounterId: input.encounterId, responsibleUserId: input.responsibleUserId, plannedStartAt: taskDate(input.plannedStartAt), plannedEndAt: taskDate(input.plannedEndAt), steps: input.steps ?? [{ id: id("plan-step"), title: "Atividades", sortOrder: 0 }], links: [], documentSnapshots: input.documentIds ? captureApprovedHospitalDocuments(state, current, input.documentIds, departmentCodes, timestamp) : undefined, state: "ACTIVE", createdBy: current.id, version: 1, createdAt: timestamp, updatedAt: timestamp };
        validateTaskDates(plan.plannedStartAt, plan.plannedEndAt);
        const next = record(state, current, undefined, plan, "HospitalPlanCreated", input.correlationId); const result = hospitalPlanView(next, current, plan, "plan.create");
        return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, result, { input }), result };
      });
    },
    updateHospitalPlan: (actor: User, id: string, input: HospitalPlanPatchInput) => change(actor, id, input, "UPDATE"),
    putHospitalPlanLink: (actor: User, id: string, input: HospitalPlanLinkInput) => change(actor, id, input, "LINK"),
    commandHospitalPlan: (actor: User, id: string, input: HospitalPlanCommandInput) => change(actor, id, input, "COMMAND")
  };
}
