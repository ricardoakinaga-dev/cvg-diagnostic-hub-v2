import { prepareExamTemplateSchema, publishExamTemplateSchema, retireExamTemplateSchema } from "../../../../server/http/exam-definition-schemas";
import { responseFor, objectBody, parseVersionedCommandBody, commandMeta } from "./route-support";
import type { ApiHandlerGroup } from "./route-support";

export const examDefinitionHandlers = {
  listExamDefinitions: { authentication: "session", handle: async ({ path, actor, service, correlationId, id }) => responseFor(await service.listExamDefinitions(actor, path[1]), correlationId, id) },
  prepareExamTemplate: { authentication: "session", handle: async ({ request, path, operation, actor, service, correlationId, id }) => {
    const body = await objectBody(request);
    const input = parseVersionedCommandBody(request, body, operation, prepareExamTemplateSchema, "Definição do painel inválida.");
    return responseFor(await service.prepareExamTemplate(actor, path[1], { ...input, ...commandMeta(request, body, operation) }), correlationId, id);
  } },
  publishExamTemplate: { authentication: "session", handle: async ({ request, path, operation, actor, service, correlationId, id }) => {
    const body = await objectBody(request);
    const input = parseVersionedCommandBody(request, body, operation, publishExamTemplateSchema, "Aprovação do painel inválida.");
    return responseFor(await service.publishExamTemplate(actor, path[1], { ...input, ...commandMeta(request, body, operation) }), correlationId, id);
  } },
  retireExamTemplate: { authentication: "session", handle: async ({ request, path, operation, actor, service, correlationId, id }) => {
    const body = await objectBody(request);
    const input = parseVersionedCommandBody(request, body, operation, retireExamTemplateSchema, "Retirada do painel inválida.");
    return responseFor(await service.retireExamTemplate(actor, path[1], { ...input, ...commandMeta(request, body, operation) }), correlationId, id);
  } }
} satisfies ApiHandlerGroup;
