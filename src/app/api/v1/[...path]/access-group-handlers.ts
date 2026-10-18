import { accessGroupImpactPreviewSchema, accessGroupCreateSchema, accessGroupPatchSchema, userGroupAssignmentSchema, effectiveAccessPreviewSchema, patientGrantSchema } from "../../../../server/http/access-group-schemas";
import { responseFor, objectBody, parseCommandBody, parseVersionedCommandBody, commandMeta } from "./route-support";
import type { ApiHandlerGroup } from "./route-support";
export const accessGroupHandlers = {
  listDelegablePermissions: { authentication: "session", handle: async ({ actor, service, correlationId, id }) => responseFor(await service.listDelegablePermissions(actor), correlationId, id) },
  listAccessGroups: { authentication: "session", handle: async ({ actor, service, correlationId, id }) => responseFor(await service.listAccessGroups(actor), correlationId, id) },
  createAccessGroup: { authentication: "session", handle: async ({ request, operation, actor, service, correlationId, id }) => {
    const body = await objectBody(request);
    const input = parseVersionedCommandBody(request, body, operation, accessGroupCreateSchema, "Dados do grupo inválidos.");
    return responseFor(await service.createAccessGroup(actor, { ...input, ...commandMeta(request, body, operation) }), correlationId, id, 201);
  } },
  updateAccessGroup: { authentication: "session", handle: async ({ request, path, operation, actor, service, correlationId, id }) => {
    const body = await objectBody(request);
    const input = parseVersionedCommandBody(request, body, operation, accessGroupPatchSchema, "Dados da matriz inválidos.");
    return responseFor(await service.updateAccessGroup(actor, path[1], { ...input, ...commandMeta(request, body, operation) }), correlationId, id);
  } },
  previewAccessGroupImpact: { authentication: "session", handle: async ({ request, path, actor, service, correlationId, id }) => {
    const body = await objectBody(request);
    const input = parseCommandBody(body, accessGroupImpactPreviewSchema, "Dados do impacto inválidos.");
    return responseFor(await service.previewAccessGroupImpact(actor, path[1], input), correlationId, id);
  } },
  assignUserAccessGroup: { authentication: "session", handle: async ({ request, path, operation, actor, service, correlationId, id }) => {
    const body = await objectBody(request);
    const input = parseVersionedCommandBody(request, body, operation, userGroupAssignmentSchema, "Dados do vínculo inválidos.");
    return responseFor(await service.assignUserAccessGroup(actor, path[1], { ...input, ...commandMeta(request, body, operation) }), correlationId, id);
  } },
  previewUserAccess: { authentication: "session", handle: async ({ request, path, actor, service, correlationId, id }) => {
    const body = await objectBody(request);
    const input = parseCommandBody(body, effectiveAccessPreviewSchema, "Dados da prévia inválidos.");
    return responseFor(await service.previewUserAccess(actor, path[1], input), correlationId, id);
  } },
  listPatientGrants: { authentication: "session", handle: async ({ path, actor, service, correlationId, id }) => responseFor(await service.listPatientGrants(actor, path[1]), correlationId, id) },
  changePatientGrant: { authentication: "session", handle: async ({ request, path, operation, actor, service, correlationId, id }) => {
    const body = await objectBody(request);
    const input = parseVersionedCommandBody(request, body, operation, patientGrantSchema, "Dados da concessão inválidos.");
    return responseFor(await service.changePatientGrant(actor, path[1], { ...input, ...commandMeta(request, body, operation) }), correlationId, id);
  } }
} satisfies ApiHandlerGroup;
