import * as schemas from "../../../../server/http/hospital-document-schemas";
import { responseFor, type ApiHandlerGroup } from "./route-support";
import { planningCommand, planningFilters } from "./hospital-planning-handler-support";

export const hospitalDocumentHandlers = {
  getHospitalDocumentOptions: { authentication: "session", handle: async ({ actor, service, correlationId, id }) => responseFor(await service.getHospitalDocumentOptions(actor), correlationId, id) },
  listHospitalDocuments: { authentication: "session", handle: async ({ request, actor, service, correlationId, id }) => responseFor(await service.listHospitalDocuments(actor, planningFilters(request, schemas.hospitalDocumentFiltersSchema, ["includeArchived", "favoritesOnly"])), correlationId, id) },
  getHospitalDocument: { authentication: "session", handle: async ({ path, actor, service, correlationId, id }) => responseFor(await service.getHospitalDocument(actor, path[1]), correlationId, id) },
  getHospitalDocumentHistory: { authentication: "session", handle: async ({ path, actor, service, correlationId, id }) => responseFor(await service.getHospitalDocumentHistory(actor, path[1]), correlationId, id) },
  createHospitalDocument: { authentication: "session", handle: async (c) => planningCommand(c, schemas.hospitalDocumentCreateSchema, (input) => c.service.createHospitalDocument(c.actor, input), false, 201) },
  updateHospitalDocumentMetadata: { authentication: "session", handle: async (c) => planningCommand(c, schemas.hospitalDocumentMetadataSchema, (input) => c.service.updateHospitalDocumentMetadata(c.actor, c.path[1], input)) },
  updateHospitalDocumentDraft: { authentication: "session", handle: async (c) => planningCommand(c, schemas.hospitalDocumentDraftSchema, (input) => c.service.updateHospitalDocumentDraft(c.actor, c.path[1], input)) },
  createHospitalDocumentRevision: { authentication: "session", handle: async (c) => planningCommand(c, schemas.hospitalDocumentRevisionSchema, (input) => c.service.createHospitalDocumentRevision(c.actor, c.path[1], input)) },
  approveHospitalDocument: { authentication: "session", handle: async (c) => planningCommand(c, schemas.hospitalDocumentApproveSchema, (input) => c.service.approveHospitalDocument(c.actor, c.path[1], input)) },
  retireHospitalDocument: { authentication: "session", handle: async (c) => planningCommand(c, schemas.hospitalDocumentRetireSchema, (input) => c.service.retireHospitalDocument(c.actor, c.path[1], input)) },
  lockHospitalDocument: { authentication: "session", handle: async (c) => planningCommand(c, schemas.hospitalDocumentLockSchema, (input) => c.service.lockHospitalDocument(c.actor, c.path[1], input)) },
  archiveHospitalDocument: { authentication: "session", handle: async (c) => planningCommand(c, schemas.hospitalDocumentArchiveSchema, (input) => c.service.archiveHospitalDocument(c.actor, c.path[1], input)) },
  duplicateHospitalDocument: { authentication: "session", handle: async (c) => planningCommand(c, schemas.hospitalDocumentDuplicateSchema, (input) => c.service.duplicateHospitalDocument(c.actor, c.path[1], input)) }
} satisfies ApiHandlerGroup;
