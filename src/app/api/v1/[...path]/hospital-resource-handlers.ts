import { admissionContextOptionsFiltersSchema, hospitalResourceFiltersSchema, hospitalResourceCreateSchema, hospitalResourcePatchSchema, hospitalTaskReserveSchema, hospitalScheduleRescheduleSchema, hospitalScheduleCancelSchema, hospitalCalendarFiltersSchema, hospitalCapacityFiltersSchema } from "../../../../server/http/hospital-resource-schemas";
import { responseFor, objectBody, parseCommandBody, parseVersionedCommandBody, commandMeta, parseBooleanFilter, parseLimit, parseCursor } from "./route-support";
import type { ApiHandlerGroup } from "./route-support";

function resourceFilters(request: Request) {
  const query = new URL(request.url).searchParams;
  return parseCommandBody({ ...Object.fromEntries(query), ...(query.has("includeInactive") ? { includeInactive: parseBooleanFilter(query.get("includeInactive"), "includeInactive") } : {}), ...(query.has("limit") ? { limit: parseLimit(query.get("limit")) } : {}), ...(query.has("cursor") ? { cursor: parseCursor(query.get("cursor")) } : {}) }, hospitalResourceFiltersSchema, "Filtros de recursos inválidos.");
}
function calendarFilters(request: Request) {
  const query = new URL(request.url).searchParams;
  return { ...Object.fromEntries(query), ...(query.has("kinds") ? { kinds: query.get("kinds")!.split(",") } : {}), ...(query.has("limit") ? { limit: parseLimit(query.get("limit")) } : {}) };
}

export const hospitalResourceHandlers = {
  getAdmissionContextOptions: { authentication: "session", handle: async ({ request, path, actor, service, correlationId, id }) => responseFor(await service.getAdmissionContextOptions(actor, path[1], parseCommandBody(Object.fromEntries(new URL(request.url).searchParams), admissionContextOptionsFiltersSchema, "Filtros de internação inválidos.")), correlationId, id) },
  getHospitalResourceOptions: { authentication: "session", handle: async ({ actor, service, correlationId, id }) => responseFor(await service.getHospitalResourceOptions(actor), correlationId, id) },
  listHospitalResources: { authentication: "session", handle: async ({ request, actor, service, correlationId, id }) => responseFor(await service.listHospitalResources(actor, resourceFilters(request)), correlationId, id) },
  getHospitalResource: { authentication: "session", handle: async ({ path, actor, service, correlationId, id }) => responseFor(await service.getHospitalResource(actor, path[1]), correlationId, id) },
  createHospitalResource: { authentication: "session", handle: async ({ request, operation, actor, service, correlationId, id }) => {
    const body = await objectBody(request);
    const input = parseCommandBody(body, hospitalResourceCreateSchema, "Dados de recurso inválidos.");
    return responseFor(await service.createHospitalResource(actor, { ...input, ...commandMeta(request, body, operation) }), correlationId, id, 201);
  } },
  updateHospitalResource: { authentication: "session", handle: async ({ request, path, operation, actor, service, correlationId, id }) => {
    const body = await objectBody(request);
    const input = parseVersionedCommandBody(request, body, operation, hospitalResourcePatchSchema, "Alteração de recurso inválida.");
    return responseFor(await service.updateHospitalResource(actor, path[1], { ...input, ...commandMeta(request, body, operation) }), correlationId, id);
  } },
  listHospitalCalendar: { authentication: "session", handle: async ({ request, actor, service, correlationId, id }) => {
    const input = parseCommandBody(calendarFilters(request), hospitalCalendarFiltersSchema, "Filtros de agenda inválidos.");
    return responseFor(await service.listHospitalCalendar(actor, input), correlationId, id);
  } },
  reserveHospitalTaskSchedule: { authentication: "session", handle: async ({ request, path, operation, actor, service, correlationId, id }) => {
    const body = await objectBody(request);
    const input = parseVersionedCommandBody(request, body, operation, hospitalTaskReserveSchema, "Reserva inválida.");
    return responseFor(await service.reserveHospitalTaskSchedule(actor, path[1], { ...input, ...commandMeta(request, body, operation) }), correlationId, id, 201);
  } },
  rescheduleHospitalTaskSchedule: { authentication: "session", handle: async ({ request, path, operation, actor, service, correlationId, id }) => {
    const body = await objectBody(request);
    const input = parseVersionedCommandBody(request, body, operation, hospitalScheduleRescheduleSchema, "Remarcação inválida.");
    return responseFor(await service.rescheduleHospitalTaskSchedule(actor, path[1], { ...input, ...commandMeta(request, body, operation) }), correlationId, id);
  } },
  cancelHospitalTaskSchedule: { authentication: "session", handle: async ({ request, path, operation, actor, service, correlationId, id }) => {
    const body = await objectBody(request);
    const input = parseVersionedCommandBody(request, body, operation, hospitalScheduleCancelSchema, "Cancelamento de reserva inválido.");
    return responseFor(await service.cancelHospitalTaskSchedule(actor, path[1], { ...input, ...commandMeta(request, body, operation) }), correlationId, id);
  } },
  getBedCensus: { authentication: "session", handle: async ({ request, actor, service, correlationId, id }) => responseFor(await service.getBedCensus(actor, { departmentCode: new URL(request.url).searchParams.get("departmentCode") ?? undefined }), correlationId, id) },
  getHospitalCapacity: { authentication: "session", handle: async ({ request, actor, service, correlationId, id }) => {
    const input = parseCommandBody(Object.fromEntries(new URL(request.url).searchParams), hospitalCapacityFiltersSchema, "Filtros de capacidade inválidos.");
    return responseFor(await service.getHospitalCapacity(actor, input), correlationId, id);
  } }
} satisfies ApiHandlerGroup;
