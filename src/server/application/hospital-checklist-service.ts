import type { HospitalChecklistTemplate, HospitalChecklistTemplateView, HospitalTaskView } from "@cvg/contracts";
import type { StoreState, User } from "../domain/models";
import type { ApplicationServiceContext } from "./service-context";
import type { CommandMeta } from "./service-types";
import type { HospitalChecklistCreateInput, HospitalChecklistFilters, HospitalChecklistPatchInput, HospitalChecklistStepInput } from "./hospital-checklist-types";
import { ApiError } from "../http/envelope";
import { hospitalChecklistApprovalSchema, hospitalChecklistCreateSchema, hospitalChecklistFiltersSchema, hospitalChecklistPatchSchema, hospitalChecklistStepSchema } from "../http/hospital-checklist-schemas";
import { requireActiveDepartment } from "./department-registry";
import { createAudit, createOutbox, ensureExpectedVersion, findOrThrowScoped, id, now, requireActiveUser, requireIdempotencyKey, requirePermission, requireText, saveIdempotency, withIdempotency } from "./service-common";
import { canAccessChecklistTemplate, checklistTemplateView, requireChecklistTemplateAccess, validateChecklistTemplate } from "./hospital-checklist-policy";
import { existingTask, hospitalTaskView, pagePlannerObjects, recordTaskChange, requireOpenTask, validateTaskBody } from "./hospital-task-common";
import { mayExecuteTask, requireHospitalTaskAccess } from "./hospital-task-policy";

function record(state: StoreState, actor: User, previous: HospitalChecklistTemplate | undefined, template: HospitalChecklistTemplate, eventType: string, correlationId?: string): StoreState {
  const correlation = correlationId ?? id("corr");
  return { ...state, hospitalChecklistTemplates: previous ? state.hospitalChecklistTemplates.map((entry) => entry.id === template.id ? template : entry) : [...state.hospitalChecklistTemplates, template], auditEvents: [...state.auditEvents, createAudit(eventType, actor.id, "HospitalChecklistTemplate", template.id, correlation, previous?.status, template.status, { departmentCode: template.departmentCode, version: template.version, existingOccurrencesChanged: false, clinicalConfirmation: false })], outbox: [...state.outbox, createOutbox(eventType, "HospitalChecklistTemplate", template.id, correlation, { templateId: template.id, version: template.version })] };
}
export function createHospitalChecklistService({ store }: ApplicationServiceContext) {
  async function change(actor: User, templateId: string, input: HospitalChecklistPatchInput | CommandMeta, action: "UPDATE" | "APPROVE" | "RETIRE"): Promise<HospitalChecklistTemplateView> {
    return store.transaction((state) => {
      const current = requireActiveUser(state, actor); const previous = findOrThrowScoped(state.hospitalChecklistTemplates.find((entry) => entry.id === templateId));
      requireChecklistTemplateAccess(state, current, action === "APPROVE" ? "checklist_template.approve" : "checklist_template.manage", previous); requireIdempotencyKey(input.idempotencyKey);
      const scope = `${action}:/hospital-checklist-templates/${templateId}`; const replay = withIdempotency<HospitalChecklistTemplateView>(state, current.id, scope, input.idempotencyKey, { input });
      if (replay.found) return { state, result: checklistTemplateView(state, current, previous, action === "APPROVE" ? "checklist_template.approve" : "checklist_template.manage") };
      validateTaskBody(action === "UPDATE" ? hospitalChecklistPatchSchema : hospitalChecklistApprovalSchema, input); ensureExpectedVersion(previous.version, input.expectedVersion);
      if (previous.status === "RETIRED") throw new ApiError("INVALID_STATE_TRANSITION", "O modelo retirado permanece no histórico; crie uma nova revisão.", 409);
      const timestamp = now(); let template: HospitalChecklistTemplate;
      if (action === "UPDATE") {
        const edit = input as HospitalChecklistPatchInput;
        template = { ...previous, name: edit.name?.trim() ?? previous.name, careContextRequired: edit.careContextRequired ?? previous.careContextRequired, steps: edit.steps ?? previous.steps, clinicalProcess: edit.clinicalProcess === null ? undefined : edit.clinicalProcess ?? previous.clinicalProcess, status: "DRAFT", approvedBy: undefined, approvedAt: undefined };
      } else if (action === "APPROVE") {
        if (previous.status !== "DRAFT") throw new ApiError("INVALID_STATE_TRANSITION", "Somente modelos em preparação podem ser aprovados.", 409);
        requireActiveDepartment(state, previous.departmentCode); template = { ...previous, status: "APPROVED", approvedBy: current.id, approvedAt: timestamp };
      } else template = { ...previous, status: "RETIRED" };
      validateChecklistTemplate(template); template = { ...template, version: previous.version + 1, updatedAt: timestamp };
      const next = record(state, current, previous, template, `HospitalChecklistTemplate${action === "UPDATE" ? "Updated" : action === "APPROVE" ? "Approved" : "Retired"}`, input.correlationId); const result = checklistTemplateView(next, current, template, action === "APPROVE" ? "checklist_template.approve" : "checklist_template.manage");
      return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, result, { input }), result };
    });
  }
  return {
    async listHospitalChecklistTemplates(actor: User, filters: HospitalChecklistFilters = {}) {
      validateTaskBody(hospitalChecklistFiltersSchema, filters); const state = await store.readState(); const current = requireActiveUser(state, actor); requirePermission(current, "checklist_template.view", {});
      const query = filters.query?.trim().toLocaleLowerCase("pt-BR"); const rows = state.hospitalChecklistTemplates.filter((template) => canAccessChecklistTemplate(state, current, "checklist_template.view", template) && (!filters.departmentCode || template.departmentCode === filters.departmentCode) && (!filters.status || template.status === filters.status) && (!query || `${template.code} ${template.name}`.toLocaleLowerCase("pt-BR").includes(query)));
      const page = pagePlannerObjects(rows, filters); return { ...page, items: page.items.map((template) => checklistTemplateView(state, current, template)) };
    },
    async createHospitalChecklistTemplate(actor: User, input: HospitalChecklistCreateInput): Promise<HospitalChecklistTemplateView> {
      return store.transaction((state) => {
        const current = requireActiveUser(state, actor); validateTaskBody(hospitalChecklistCreateSchema, input); requireIdempotencyKey(input.idempotencyKey); const departmentCode = input.departmentCode.trim().toUpperCase();
        requireChecklistTemplateAccess(state, current, "checklist_template.manage", { departmentCode }); const scope = "POST:/hospital-checklist-templates";
        const replay = withIdempotency<HospitalChecklistTemplateView>(state, current.id, scope, input.idempotencyKey, { input });
        if (replay.found) return { state, result: checklistTemplateView(state, current, findOrThrowScoped(state.hospitalChecklistTemplates.find((entry) => entry.id === replay.existing!.template.id)), "checklist_template.manage") };
        requireActiveDepartment(state, departmentCode); const code = input.code.toUpperCase(); if (state.hospitalChecklistTemplates.some((entry) => entry.code === code)) throw new ApiError("CONFLICT", "Código de modelo já utilizado.", 409);
        const timestamp = now(); const template: HospitalChecklistTemplate = { id: id("checklist-template"), code, name: input.name.trim(), departmentCode, careContextRequired: input.careContextRequired, steps: structuredClone(input.steps), clinicalProcess: input.clinicalProcess ? structuredClone(input.clinicalProcess) : undefined, status: "DRAFT", createdBy: current.id, version: 1, createdAt: timestamp, updatedAt: timestamp }; validateChecklistTemplate(template);
        const next = record(state, current, undefined, template, "HospitalChecklistTemplateCreated", input.correlationId); const result = checklistTemplateView(next, current, template, "checklist_template.manage");
        return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, result, { input }), result };
      });
    },
    updateHospitalChecklistTemplate: (actor: User, id: string, input: HospitalChecklistPatchInput) => change(actor, id, input, "UPDATE"),
    approveHospitalChecklistTemplate: (actor: User, id: string, input: CommandMeta) => change(actor, id, input, "APPROVE"),
    retireHospitalChecklistTemplate: (actor: User, id: string, input: CommandMeta) => change(actor, id, input, "RETIRE"),
    async recordHospitalChecklistStep(actor: User, taskId: string, input: HospitalChecklistStepInput): Promise<HospitalTaskView> {
      return store.transaction((state) => {
        const current = requireActiveUser(state, actor); const previous = existingTask(state, current, taskId, "hospital_task.view"); requireHospitalTaskAccess(state, current, "checklist.execute", previous);
        if (!mayExecuteTask(state, current, previous)) throw new ApiError("SCOPE_DENIED", "Assuma a tarefa ou integre sua equipe antes de executar o checklist.", 404);
        requireIdempotencyKey(input.idempotencyKey); const scope = `POST:/hospital-tasks/${taskId}/checklist-steps`; const replay = withIdempotency<HospitalTaskView>(state, current.id, scope, input.idempotencyKey, { input });
        if (replay.found) return { state, result: hospitalTaskView(state, current, previous) };
        validateTaskBody(hospitalChecklistStepSchema, input); ensureExpectedVersion(previous.version, input.expectedVersion); requireOpenTask(previous);
        const step = findOrThrowScoped(previous.checklistSnapshot?.steps.find((entry) => entry.code === input.stepCode));
        const completed = previous.checklistExecutions?.find((entry) => entry.stepCode === step.code && entry.status === "DONE"); const timestamp = now();
        let executions = previous.checklistExecutions ?? [];
        if (input.command === "DONE") {
          if (completed) throw new ApiError("CONFLICT", "A etapa já está concluída.", 409);
          if (step.evidenceRequired && !input.evidenceText?.trim()) throw new ApiError("VALIDATION_ERROR", "A etapa exige evidência de execução.", 400);
          executions = [...executions, { id: id("checklist-execution"), stepCode: step.code, actorId: current.id, executedAt: timestamp, evidenceText: input.evidenceText?.trim() || undefined, status: "DONE", version: 1 }];
        } else {
          if (!completed) throw new ApiError("CONFLICT", "Não existe execução vigente para invalidar.", 409);
          if (completed.actorId !== current.id && current.role !== "MANAGER" && current.role !== "SUPERADMIN") throw new ApiError("SCOPE_DENIED", "Somente o executor ou a gestão pode invalidar a evidência.", 404);
          const reason = requireText(input.reason ?? "", "motivo da invalidação", 500); executions = executions.map((entry) => entry.id === completed.id ? { ...entry, status: "VOIDED", voidedBy: current.id, voidedAt: timestamp, voidReason: reason, version: entry.version + 1 } : entry);
        }
        const task = { ...previous, checklistExecutions: executions, version: previous.version + 1, updatedAt: timestamp }; const next = recordTaskChange(state, current, previous, task, "HospitalTaskChecklistRecorded", input.correlationId, { stepCode: step.code, command: input.command, actorId: current.id, clinicalConfirmation: false }); const result = hospitalTaskView(next, current, task);
        return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, result, { input }), result };
      });
    }
  };
}
