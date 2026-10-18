import { hospitalShiftCreateSchema, hospitalShiftPatchSchema, hospitalShiftFiltersSchema, hospitalActivityShiftSchema, hospitalHandoffOfferSchema, hospitalHandoffDecisionSchema, hospitalHandoffFiltersSchema } from "../../../../server/http/hospital-shift-schemas";
import { responseFor, type ApiHandlerGroup } from "./route-support";
import { planningCommand, planningFilters } from "./hospital-planning-handler-support";
export const hospitalShiftHandlers = {
  listHospitalShifts: { authentication: "session", handle: async ({ request, actor, service, correlationId, id }) => responseFor(await service.listHospitalShifts(actor, planningFilters(request, hospitalShiftFiltersSchema, ["current"])), correlationId, id) },
  getHospitalShift: { authentication: "session", handle: async ({ path, actor, service, correlationId, id }) => responseFor(await service.getHospitalShift(actor, path[1]), correlationId, id) },
  createHospitalShift: { authentication: "session", handle: async (context) => planningCommand(context, hospitalShiftCreateSchema, (input) => context.service.createHospitalShift(context.actor, input), false, 201) },
  updateHospitalShift: { authentication: "session", handle: async (context) => planningCommand(context, hospitalShiftPatchSchema, (input) => context.service.updateHospitalShift(context.actor, context.path[1], input)) },
  assignHospitalActivityShift: { authentication: "session", handle: async (context) => planningCommand(context, hospitalActivityShiftSchema, (input) => context.service.assignHospitalActivityShift(context.actor, input)) },
  listHospitalHandoffs: { authentication: "session", handle: async ({ request, actor, service, correlationId, id }) => responseFor(await service.listHospitalHandoffs(actor, planningFilters(request, hospitalHandoffFiltersSchema)), correlationId, id) },
  offerHospitalHandoff: { authentication: "session", handle: async (context) => planningCommand(context, hospitalHandoffOfferSchema, (input) => context.service.offerHospitalHandoff(context.actor, input), false, 201) },
  decideHospitalHandoff: { authentication: "session", handle: async (context) => planningCommand(context, hospitalHandoffDecisionSchema, (input) => context.service.decideHospitalHandoff(context.actor, context.path[1], input)) }
} satisfies ApiHandlerGroup;
