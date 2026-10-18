import { hospitalChecklistCreateSchema, hospitalChecklistPatchSchema, hospitalChecklistApprovalSchema, hospitalChecklistStepSchema, hospitalChecklistFiltersSchema, hospitalRecurrenceCreateSchema, hospitalRecurrencePatchSchema, hospitalRecurrenceFiltersSchema, hospitalRecurrenceGenerationSchema } from "../../../../server/http/hospital-checklist-schemas";
import { hospitalCareExecuteSchema } from "../../../../server/http/hospital-care-schemas";
import { responseFor, type ApiHandlerGroup } from "./route-support";
import { planningCommand, planningFilters } from "./hospital-planning-handler-support";
export const hospitalChecklistHandlers = {
  listHospitalChecklistTemplates: { authentication: "session", handle: async ({ request, actor, service, correlationId, id }) => responseFor(await service.listHospitalChecklistTemplates(actor, planningFilters(request, hospitalChecklistFiltersSchema)), correlationId, id) },
  createHospitalChecklistTemplate: { authentication: "session", handle: async (context) => planningCommand(context, hospitalChecklistCreateSchema, (input) => context.service.createHospitalChecklistTemplate(context.actor, input), false, 201) },
  updateHospitalChecklistTemplate: { authentication: "session", handle: async (context) => planningCommand(context, hospitalChecklistPatchSchema, (input) => context.service.updateHospitalChecklistTemplate(context.actor, context.path[1], input)) },
  approveHospitalChecklistTemplate: { authentication: "session", handle: async (context) => planningCommand(context, hospitalChecklistApprovalSchema, (input) => context.service.approveHospitalChecklistTemplate(context.actor, context.path[1], input)) },
  retireHospitalChecklistTemplate: { authentication: "session", handle: async (context) => planningCommand(context, hospitalChecklistApprovalSchema, (input) => context.service.retireHospitalChecklistTemplate(context.actor, context.path[1], input)) },
  recordHospitalChecklistStep: { authentication: "session", handle: async (context) => planningCommand(context, hospitalChecklistStepSchema, (input) => context.service.recordHospitalChecklistStep(context.actor, context.path[1], input)) },
  executeHospitalCare: { authentication: "session", handle: async (context) => planningCommand(context, hospitalCareExecuteSchema, (input) => context.service.executeHospitalCare(context.actor, context.path[1], input)) },
  listHospitalRecurrences: { authentication: "session", handle: async ({ request, actor, service, correlationId, id }) => responseFor(await service.listHospitalRecurrences(actor, planningFilters(request, hospitalRecurrenceFiltersSchema, ["active"])), correlationId, id) },
  createHospitalRecurrence: { authentication: "session", handle: async (context) => planningCommand(context, hospitalRecurrenceCreateSchema, (input) => context.service.createHospitalRecurrence(context.actor, input), false, 201) },
  updateHospitalRecurrence: { authentication: "session", handle: async (context) => planningCommand(context, hospitalRecurrencePatchSchema, (input) => context.service.updateHospitalRecurrence(context.actor, context.path[1], input)) },
  generateHospitalRecurrences: { authentication: "session", handle: async (context) => planningCommand(context, hospitalRecurrenceGenerationSchema, (input) => context.service.generateHospitalRecurrences(context.actor, input), false) }
} satisfies ApiHandlerGroup;
