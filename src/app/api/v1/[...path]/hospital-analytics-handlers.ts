import { HOSPITAL_METRIC_CODES } from "@cvg/contracts";
import { z } from "zod";
import { hospitalMetricFiltersSchema, hospitalMetricRowsFiltersSchema, hospitalReportCreateSchema, hospitalReportPatchSchema, hospitalReportJobCreateSchema, hospitalReportJobRetrySchema } from "../../../../server/http/hospital-analytics-schemas";
import { parseCommandBody, responseFor, type ApiHandlerGroup } from "./route-support";
import { planningCommand, planningFilters } from "./hospital-planning-handler-support";

export const hospitalAnalyticsHandlers = {
  listHospitalReports: { authentication: "session", handle: async ({ actor, service, correlationId, id }) => responseFor(await service.listHospitalReports(actor), correlationId, id) },
  createHospitalReport: { authentication: "session", handle: async (c) => planningCommand(c, hospitalReportCreateSchema, (input) => c.service.createHospitalReport(c.actor, input), false, 201) },
  updateHospitalReport: { authentication: "session", handle: async (c) => planningCommand(c, hospitalReportPatchSchema, (input) => c.service.updateHospitalReport(c.actor, c.path[1], input)) },
  listHospitalReportJobs: { authentication: "session", handle: async ({ actor, service, correlationId, id }) => responseFor(await service.listHospitalReportJobs(actor), correlationId, id) },
  createHospitalReportJob: { authentication: "session", handle: async (c) => planningCommand(c, hospitalReportJobCreateSchema, (input) => c.service.createHospitalReportJob(c.actor, input), false, 201) },
  getHospitalReportJob: { authentication: "session", handle: async ({ actor, path, service, correlationId, id }) => responseFor(await service.getHospitalReportJob(actor, path[1]), correlationId, id) },
  retryHospitalReportJob: { authentication: "session", handle: async (c) => planningCommand(c, hospitalReportJobRetrySchema, (input) => c.service.retryHospitalReportJob(c.actor, c.path[1], input)) },
  downloadHospitalReportJob: { authentication: "session", handle: async ({ actor, path, service, correlationId, id }) => responseFor(await service.downloadHospitalReportJob(actor, path[1]), correlationId, id) },
  getHospitalPlannerMetrics: { authentication: "session", handle: async ({ request, actor, service, correlationId, id }) => responseFor(await service.getHospitalPlannerMetrics(actor, planningFilters(request, hospitalMetricFiltersSchema)), correlationId, id) },
  listHospitalMetricRows: { authentication: "session", handle: async ({ request, path, actor, service, correlationId, id }) => {
    const { code } = parseCommandBody({ code: path[1] }, z.object({ code: z.enum(HOSPITAL_METRIC_CODES) }), "Indicador desconhecido.");
    return responseFor(await service.listHospitalMetricRows(actor, code, planningFilters(request, hospitalMetricRowsFiltersSchema)), correlationId, id);
  } }
} satisfies ApiHandlerGroup;
