import { z } from "zod";
import { HOSPITAL_SERVICE_KINDS } from "@cvg/contracts";
import { hospitalServiceCreateSchema, hospitalServicePatchSchema, hospitalServiceImportSchema } from "../../../../server/http/hospital-service-schemas";
import { responseFor, objectBody, parseCommandBody, parseVersionedCommandBody, commandMeta, parseBooleanFilter } from "./route-support";
import type { ApiHandlerGroup } from "./route-support";
const filters = z.object({ departmentCode: z.string().trim().regex(/^[A-Za-z0-9_-]{1,60}$/).transform((code) => code.toUpperCase()).optional(), kind: z.enum([...HOSPITAL_SERVICE_KINDS, "DIAGNOSTIC"]).optional(), includeInactive: z.boolean().optional(), query: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).optional(), cursor: z.string().max(2000).optional() }).strict();
export const hospitalServiceHandlers = {
  listHospitalServices: { authentication: "session", handle: async ({ request, actor, service, correlationId, id }) => {
    const query = new URL(request.url).searchParams;
    const input = parseCommandBody({ ...Object.fromEntries(query), ...(query.has("includeInactive") ? { includeInactive: parseBooleanFilter(query.get("includeInactive"), "includeInactive") } : {}) }, filters, "Filtros de serviços inválidos.");
    return responseFor(await service.listHospitalServices(actor, input), correlationId, id);
  } },
  getHospitalService: { authentication: "session", handle: async ({ path, actor, service, correlationId, id }) => responseFor(await service.getHospitalService(actor, path[1]), correlationId, id) },
  createHospitalService: { authentication: "session", handle: async ({ request, operation, actor, service, correlationId, id }) => {
    const body = await objectBody(request); const input = parseCommandBody(body, hospitalServiceCreateSchema, "Serviço hospitalar inválido.");
    return responseFor(await service.createHospitalService(actor, { ...input, ...commandMeta(request, body, operation) }), correlationId, id, 201);
  } },
  updateHospitalService: { authentication: "session", handle: async ({ request, path, operation, actor, service, correlationId, id }) => {
    const body = await objectBody(request); const input = parseVersionedCommandBody(request, body, operation, hospitalServicePatchSchema, "Alteração do serviço inválida.");
    return responseFor(await service.updateHospitalService(actor, path[1], { ...input, ...commandMeta(request, body, operation) }), correlationId, id);
  } },
  importHospitalServices: { authentication: "session", handle: async ({ request, operation, actor, service, correlationId, id }) => {
    const body = await objectBody(request); const input = parseCommandBody(body, hospitalServiceImportSchema, "Planilha de serviços inválida.");
    return responseFor(await service.importHospitalServices(actor, { ...input, ...commandMeta(request, body, operation) }), correlationId, id);
  } }
} satisfies ApiHandlerGroup;
