import { plannerViewCreateSchema, plannerViewPatchSchema, plannerViewDeactivateSchema } from "../../../../server/http/planner-view-schemas";
import { responseFor, objectBody, parseCommandBody, parseVersionedCommandBody, commandMeta } from "./route-support";
import type { ApiHandlerGroup } from "./route-support";
export const plannerViewHandlers = {
  listPlannerViews: { authentication: "session", handle: async ({ actor, service, correlationId, id }) => responseFor(await service.listPlannerViews(actor), correlationId, id) },
  createPlannerView: { authentication: "session", handle: async ({ request, operation, actor, service, correlationId, id }) => {
    const body = await objectBody(request); const input = parseCommandBody(body, plannerViewCreateSchema, "Visão de planejamento inválida.");
    return responseFor(await service.createPlannerView(actor, { ...input, ...commandMeta(request, body, operation) }), correlationId, id, 201);
  } },
  updatePlannerView: { authentication: "session", handle: async ({ request, path, operation, actor, service, correlationId, id }) => {
    const body = await objectBody(request); const input = parseVersionedCommandBody(request, body, operation, plannerViewPatchSchema, "Alteração da visão inválida.");
    return responseFor(await service.updatePlannerView(actor, path[1], { ...input, ...commandMeta(request, body, operation) }), correlationId, id);
  } },
  deactivatePlannerView: { authentication: "session", handle: async ({ request, path, operation, actor, service, correlationId, id }) => {
    const body = await objectBody(request); const input = parseVersionedCommandBody(request, body, operation, plannerViewDeactivateSchema, "Desativação da visão inválida.");
    return responseFor(await service.deactivatePlannerView(actor, path[1], { ...input, ...commandMeta(request, body, operation) }), correlationId, id);
  } }
} satisfies ApiHandlerGroup;
