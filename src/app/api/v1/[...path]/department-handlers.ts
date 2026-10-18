import { departmentCreateSchema, departmentPatchSchema, departmentDeactivateSchema, departmentMembersSchema } from "../../../../server/http/department-schemas";
import { responseFor, objectBody, parseVersionedCommandBody, commandMeta, parseBooleanFilter } from "./route-support";
import type { ApiHandlerGroup } from "./route-support";
export const departmentHandlers = {
  listDepartments: { authentication: "session", handle: async ({ request, actor, service, correlationId, id }) => responseFor(await service.listDepartments(actor, { includeInactive: parseBooleanFilter(new URL(request.url).searchParams.get("includeInactive"), "includeInactive") }), correlationId, id) },
  getDepartment: { authentication: "session", handle: async ({ path, actor, service, correlationId, id }) => responseFor(await service.getDepartment(actor, path[1]), correlationId, id) },
  createDepartment: { authentication: "session", handle: async ({ request, operation, actor, service, correlationId, id }) => {
    const body = await objectBody(request);
    const input = parseVersionedCommandBody(request, body, operation, departmentCreateSchema, "Dados do setor inválidos.");
    return responseFor(await service.createDepartment(actor, { ...input, ...commandMeta(request, body, operation) }), correlationId, id, 201);
  } },
  updateDepartment: { authentication: "session", handle: async ({ request, path, operation, actor, service, correlationId, id }) => {
    const body = await objectBody(request);
    const input = parseVersionedCommandBody(request, body, operation, departmentPatchSchema, "Dados da alteração do setor inválidos.");
    return responseFor(await service.updateDepartment(actor, path[1], { ...input, ...commandMeta(request, body, operation) }), correlationId, id);
  } },
  deactivateDepartment: { authentication: "session", handle: async ({ request, path, operation, actor, service, correlationId, id }) => {
    const body = await objectBody(request);
    const input = parseVersionedCommandBody(request, body, operation, departmentDeactivateSchema, "Dados da desativação do setor inválidos.");
    return responseFor(await service.deactivateDepartment(actor, path[1], { ...input, ...commandMeta(request, body, operation) }), correlationId, id);
  } },
  setDepartmentMembers: { authentication: "session", handle: async ({ request, path, operation, actor, service, correlationId, id }) => {
    const body = await objectBody(request);
    const input = parseVersionedCommandBody(request, body, operation, departmentMembersSchema, "Dados da equipe inválidos.");
    return responseFor(await service.setDepartmentMembers(actor, path[1], { ...input, ...commandMeta(request, body, operation) }), correlationId, id);
  } }
} satisfies ApiHandlerGroup;
