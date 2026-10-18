import type { LaboratoryPanelTemplate, Permission } from "@cvg/contracts";
import { ApiError } from "../http/envelope";
import { prepareExamTemplateSchema, publishExamTemplateSchema, retireExamTemplateSchema, type PrepareExamTemplateInput, type PublishExamTemplateInput, type RetireExamTemplateInput } from "../http/exam-definition-schemas";
import type { ApplicationServiceContext } from "./service-context";
import type { DiagnosticService, User } from "../domain/models";
import { canAccessResource } from "../security/authorization";
import { recordExamDefinition } from "./exam-definition";
import { createAudit, ensureExpectedVersion, id, now, requireActiveUser, requireIdempotencyKey, requirePermission, saveIdempotency, serviceFor, withIdempotency } from "./service-common";

function catalogWrite(actor: User, service: DiagnosticService) {
  if (!["service.catalog.manage", "service.catalog.update"].some((permission) => canAccessResource(actor, permission as Permission, { departmentCode: service.departmentCode, serviceCode: service.code }))) throw new ApiError("SCOPE_DENIED", "Você não tem acesso a este recurso.", 404);
}
function parse<T>(schema: { safeParse: (input: unknown) => { success: boolean; data?: T } }, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ApiError("VALIDATION_ERROR", "A definição, população ou faixa de referência é inválida.", 400);
  return parsed.data!;
}
function commandBody<T extends { idempotencyKey?: string; correlationId?: string }>(input: T) { const { idempotencyKey: _key, correlationId: _correlation, ...body } = input; return body; }

export function createExamDefinitionService({ store }: ApplicationServiceContext) {
  const mutate = async (actor: User, serviceId: string, input: PrepareExamTemplateInput | PublishExamTemplateInput | RetireExamTemplateInput, kind: "PREPARE" | "PUBLISH" | "RETIRE") => {
    const scope = `${kind === "PREPARE" ? "PUT" : "POST"}:/diagnostic-services/template/${kind.toLowerCase()}`;
    return store.transaction((original) => {
      const current = requireActiveUser(original, actor);
      const service = serviceFor(original, serviceId);
      if (kind === "PUBLISH") requirePermission(current, "exam_definition.approve", { departmentCode: service.departmentCode, serviceCode: service.code });
      else catalogWrite(current, service);
      requireIdempotencyKey(input.idempotencyKey);
      const fingerprint = { serviceId, input };
      const replay = withIdempotency<DiagnosticService>(original, current.id, scope, input.idempotencyKey, fingerprint);
      if (replay.found) return { state: original, result: replay.existing! };
      ensureExpectedVersion(service.version, input.expectedVersion);
      if (service.category !== "LABORATORY" || service.workflowType !== "LABORATORY") throw new ApiError("VALIDATION_ERROR", "Um painel laboratorial exige serviço e fluxo de laboratório.", 422);
      const timestamp = now();
      const correlationId = input.correlationId ?? id("corr");
      let template: LaboratoryPanelTemplate;
      if (kind === "PREPARE") {
        const body = parse(prepareExamTemplateSchema, commandBody(input)) as PrepareExamTemplateInput;
        if (service.resultSchema !== "NUMERIC_PANEL" && original.items.some((item) => item.serviceId === serviceId)) throw new ApiError("CATALOG_IN_USE", "A estrutura deste serviço utilizado não pode mudar para painel numérico.", 409);
        template = { ...body.template, kind: "LABORATORY_PANEL", status: "DRAFT", version: (service.resultTemplate?.version ?? 0) + 1, analytes: body.template.analytes.map((entry) => ({ ...entry, ...(entry.referenceRange ? { referenceRange: { ...entry.referenceRange, source: "PENDING_HUMAN_POLICY" as const } } : {}) })) };
      } else if (kind === "PUBLISH") {
        const body = parse(publishExamTemplateSchema, commandBody(input)) as PublishExamTemplateInput;
        if (!service.active || !original.departments.some((department) => department.code === service.departmentCode && department.active)) throw new ApiError("EXAM_DEFINITION_NOT_PUBLISHED", "Ative o serviço e seu setor antes de publicar o painel.", 422);
        if (!service.resultTemplate || service.resultTemplate.status !== "DRAFT") throw new ApiError("INVALID_STATE_TRANSITION", "Prepare um rascunho de template antes de publicar.", 409);
        if (service.resultTemplate.analytes.some((entry) => entry.valueType === "NUMERIC" && (!entry.referenceRange || entry.referenceRange.kind !== "NUMERIC" || entry.referenceRange.low === undefined && entry.referenceRange.high === undefined))) throw new ApiError("REFERENCE_POLICY_MISSING", "Configure as faixas numéricas antes da aprovação clínica.", 422);
        template = { ...structuredClone(service.resultTemplate), status: "ACTIVE", approval: { approvedBy: current.id, approvedAt: timestamp, policyReference: body.policyReference, population: structuredClone(body.population) }, analytes: service.resultTemplate.analytes.map((entry) => ({ ...structuredClone(entry), ...(entry.referenceRange?.kind === "NUMERIC" ? { referenceRange: { ...structuredClone(entry.referenceRange), source: "HUMAN_APPROVED" as const } } : {}) })) };
      } else {
        parse(retireExamTemplateSchema, commandBody(input));
        if (!service.resultTemplate || service.resultTemplate.status !== "ACTIVE") throw new ApiError("INVALID_STATE_TRANSITION", "Somente um template ativo pode ser retirado.", 409);
        template = { ...structuredClone(service.resultTemplate), status: "RETIRED" };
      }
      const updated: DiagnosticService = { ...service, resultSchema: "NUMERIC_PANEL", resultTemplate: template, version: service.version + 1 };
      const state = recordExamDefinition({ ...original, services: original.services.map((entry) => entry.id === serviceId ? updated : entry), auditEvents: [...original.auditEvents, createAudit(kind === "PUBLISH" ? "ExamDefinitionApproved" : kind === "RETIRE" ? "ExamDefinitionRetired" : "ExamDefinitionDraftPrepared", current.id, "DiagnosticService", serviceId, correlationId, service.resultTemplate?.status, template.status, { templateVersion: template.version, ...(kind === "RETIRE" ? { reason: (input as RetireExamTemplateInput).reason } : {}) })] }, service, updated, current.id, timestamp, correlationId);
      return { state: saveIdempotency(state, current.id, scope, input.idempotencyKey, updated, fingerprint), result: updated };
    });
  };
  return {
    prepareExamTemplate: (actor: User, serviceId: string, input: PrepareExamTemplateInput) => mutate(actor, serviceId, input, "PREPARE"),
    publishExamTemplate: (actor: User, serviceId: string, input: PublishExamTemplateInput) => mutate(actor, serviceId, input, "PUBLISH"),
    retireExamTemplate: (actor: User, serviceId: string, input: RetireExamTemplateInput) => mutate(actor, serviceId, input, "RETIRE"),
    async listExamDefinitions(actor: User, serviceId: string) {
      const state = await store.readState();
      const current = requireActiveUser(state, actor);
      const service = serviceFor(state, serviceId);
      requirePermission(current, "service.catalog.view", { departmentCode: service.departmentCode, serviceCode: service.code });
      return state.examDefinitions.filter((entry) => entry.serviceId === serviceId).sort((a, b) => b.serviceVersion - a.serviceVersion).map((entry) => structuredClone(entry));
    }
  };
}
