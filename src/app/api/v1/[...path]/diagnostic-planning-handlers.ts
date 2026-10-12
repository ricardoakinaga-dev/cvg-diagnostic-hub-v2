import { itemAssignmentSchema, itemPlanningSchema, itemPrioritySchema } from "../../../../server/http/diagnostic-planning-schemas";
import { responseFor, objectBody, parseVersionedCommandBody, commandMeta } from "./route-support";
import type { ApiHandlerGroup } from "./route-support";

export const diagnosticPlanningHandlers = {
  listDiagnosticItemAssignees: { authentication: "session", handle: async ({ path, actor, service, correlationId, id }) => responseFor(await service.listDiagnosticItemAssignees(actor, path[1]), correlationId, id) },
  assignDiagnosticItem: { authentication: "session", handle: async ({ request, path, operation, actor, service, correlationId, id }) => {
    const body = await objectBody(request);
    const input = parseVersionedCommandBody(request, body, operation, itemAssignmentSchema, "Vínculo de responsável inválido.");
    return responseFor(await service.assignDiagnosticItem(actor, path[1], { ...input, ...commandMeta(request, body, operation) }), correlationId, id);
  } },
  planDiagnosticItem: { authentication: "session", handle: async ({ request, path, operation, actor, service, correlationId, id }) => {
    const body = await objectBody(request);
    const input = parseVersionedCommandBody(request, body, operation, itemPlanningSchema, "Datas de planejamento inválidas.");
    return responseFor(await service.planDiagnosticItem(actor, path[1], { ...input, ...commandMeta(request, body, operation) }), correlationId, id);
  } },
  reprioritizeDiagnosticItem: { authentication: "session", handle: async ({ request, path, operation, actor, service, correlationId, id }) => {
    const body = await objectBody(request);
    const input = parseVersionedCommandBody(request, body, operation, itemPrioritySchema, "Reclassificação de prioridade inválida.");
    return responseFor(await service.reprioritizeDiagnosticItem(actor, path[1], { ...input, ...commandMeta(request, body, operation) }), correlationId, id);
  } }
} satisfies ApiHandlerGroup;
