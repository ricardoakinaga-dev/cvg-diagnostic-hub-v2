import { z } from "zod";
import { hospitalPlanCreateSchema, hospitalPlanPatchSchema, hospitalPlanLinkSchema, hospitalPlanCommandSchema, hospitalPlanFiltersSchema } from "../../../../server/http/hospital-plan-schemas";
import { parseCommandBody, responseFor, type ApiHandlerGroup } from "./route-support";
import { planningCommand, planningFilters } from "./hospital-planning-handler-support";
const options = z.object({ action: z.enum(["plan.create", "plan.update", "shift.manage", "handoff.offer", "recurrence.manage", "checklist_template.manage"]).default("plan.create") }).strict();
export const hospitalPlanHandlers = {
  listHospitalPlannerOptions: { authentication: "session", handle: async ({ request, actor, service, correlationId, id }) => {
    const input = parseCommandBody(Object.fromEntries(new URL(request.url).searchParams), options, "Ação de planejamento inválida.");
    return responseFor(await service.listHospitalPlannerOptions(actor, input.action), correlationId, id);
  } },
  listHospitalPlans: { authentication: "session", handle: async ({ request, actor, service, correlationId, id }) => responseFor(await service.listHospitalPlans(actor, planningFilters(request, hospitalPlanFiltersSchema)), correlationId, id) },
  getHospitalPlan: { authentication: "session", handle: async ({ path, actor, service, correlationId, id }) => responseFor(await service.getHospitalPlan(actor, path[1]), correlationId, id) },
  createHospitalPlan: { authentication: "session", handle: async (context) => planningCommand(context, hospitalPlanCreateSchema, (input) => context.service.createHospitalPlan(context.actor, input), false, 201) },
  updateHospitalPlan: { authentication: "session", handle: async (context) => planningCommand(context, hospitalPlanPatchSchema, (input) => context.service.updateHospitalPlan(context.actor, context.path[1], input)) },
  putHospitalPlanLink: { authentication: "session", handle: async (context) => planningCommand(context, hospitalPlanLinkSchema, (input) => context.service.putHospitalPlanLink(context.actor, context.path[1], input)) },
  commandHospitalPlan: { authentication: "session", handle: async (context) => planningCommand(context, hospitalPlanCommandSchema, (input) => context.service.commandHospitalPlan(context.actor, context.path[1], input)) }
} satisfies ApiHandlerGroup;
