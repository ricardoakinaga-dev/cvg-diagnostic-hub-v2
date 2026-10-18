import * as schemas from "../../../../server/http/hospital-institution-schemas";
import { createApplicationService } from "../../../../server/application/service";
import { getRuntimeStoreAsync, getRuntimeFileStore } from "../../../../server/store/runtime";
import { assertRateLimit } from "../../../../server/security/rate-limit";
import { responseFor, objectBody, parseCommandBody, type ApiHandlerGroup } from "./route-support";
import { planningCommand } from "./hospital-planning-handler-support";
export const hospitalInstitutionHandlers = {
  getHospitalInstitutionSettings: { authentication: "session", handle: async ({ actor, service, correlationId, id }) => responseFor(await service.getHospitalInstitutionSettings(actor), correlationId, id) },
  putHospitalInstitutionSettings: { authentication: "session", handle: async (c) => planningCommand(c, schemas.hospitalInstitutionPutSchema, (input) => c.service.putHospitalInstitutionSettings(c.actor, input)) },
  putHospitalDepartmentCapabilities: { authentication: "session", handle: async (c) => planningCommand(c, schemas.hospitalDepartmentCapabilitySchema, (input) => c.service.putHospitalDepartmentCapabilities(c.actor, c.path[1], input)) },
  getHospitalInvitationOptions: { authentication: "session", handle: async ({ actor, service, correlationId, id }) => responseFor(await service.getHospitalInvitationOptions(actor), correlationId, id) },
  listHospitalUserInvitations: { authentication: "session", handle: async ({ actor, service, correlationId, id }) => responseFor(await service.listHospitalUserInvitations(actor), correlationId, id) },
  createHospitalUserInvitation: { authentication: "session", handle: async (c) => planningCommand(c, schemas.hospitalInvitationCreateSchema, (input) => c.service.createHospitalUserInvitation(c.actor, input), false, 201) },
  revokeHospitalUserInvitation: { authentication: "session", handle: async (c) => planningCommand(c, schemas.hospitalInvitationRevokeSchema, (input) => c.service.revokeHospitalUserInvitation(c.actor, c.path[1], input)) },
  previewHospitalUserInvitation: { authentication: "public", handle: async ({ request, rateLimitClientKey, correlationId, id }) => {
    await assertRateLimit(`invitation-preview:${rateLimitClientKey}`, 30, 60_000);
    const input = parseCommandBody(await objectBody(request), schemas.hospitalInvitationPreviewSchema, "Convite inválido.");
    const service = createApplicationService(await getRuntimeStoreAsync(), { storage: getRuntimeFileStore() });
    return responseFor(await service.previewHospitalUserInvitation(input), correlationId, id);
  } },
  acceptHospitalUserInvitation: { authentication: "public", handle: async ({ request, rateLimitClientKey, correlationId, id }) => {
    await assertRateLimit(`invitation-accept:${rateLimitClientKey}`, 10, 60_000);
    const input = parseCommandBody(await objectBody(request), schemas.hospitalInvitationAcceptSchema, "Convite ou senha inválidos.");
    const service = createApplicationService(await getRuntimeStoreAsync(), { storage: getRuntimeFileStore() });
    return responseFor(await service.acceptHospitalUserInvitation({ ...input, correlationId }), correlationId, id);
  } }
} satisfies ApiHandlerGroup;
