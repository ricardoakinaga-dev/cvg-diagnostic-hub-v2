import * as comments from "../../../../server/http/hospital-task-comment-schemas";
import * as attachments from "../../../../server/http/hospital-task-attachment-schemas";
import * as archive from "../../../../server/http/hospital-task-archive-schemas";
import * as drafts from "../../../../server/http/hospital-task-draft-schemas";
import { hospitalTaskReactionSchema } from "../../../../server/http/hospital-task-reaction-schemas";
import { ApiError } from "../../../../server/http/envelope";
import { readBytesWithLimit } from "../../../../server/http/request-body";
import { assertRateLimit } from "../../../../server/security/rate-limit";
import { responseFor, type ApiHandlerGroup } from "./route-support";
import { planningCommand, planningFilters } from "./hospital-planning-handler-support";
export const hospitalTaskCollaborationHandlers = {
  setHospitalTaskReaction: { authentication: "session", handle: async (c) => planningCommand(c, hospitalTaskReactionSchema, (input) => c.service.setHospitalTaskReaction(c.actor, c.path[1], input)) },
  setHospitalTaskCommentReaction: { authentication: "session", handle: async (c) => planningCommand(c, hospitalTaskReactionSchema, (input) => c.service.setHospitalTaskCommentReaction(c.actor, c.path[1], c.path[3], input)) },
  setHospitalTaskArchived: { authentication: "session", handle: async (c) => planningCommand(c, archive.hospitalTaskArchiveSchema, (input) => c.service.setHospitalTaskArchived(c.actor, c.path[1], input)) },
  batchHospitalTasks: { authentication: "session", handle: async (c) => planningCommand(c, archive.hospitalTaskBatchSchema, (input) => c.service.batchHospitalTasks(c.actor, input), false) },
  createHospitalTaskDraft: { authentication: "session", handle: async (c) => planningCommand(c, drafts.hospitalTaskDraftCreateSchema, (input) => c.service.createHospitalTaskDraft(c.actor, input), false, 201) },
  commandHospitalTaskDraft: { authentication: "session", handle: async (c) => planningCommand(c, drafts.hospitalTaskDraftCommandSchema, (input) => c.service.commandHospitalTaskDraft(c.actor, c.path[1], input)) },
  listHospitalTaskComments: { authentication: "session", handle: async ({ request, path, actor, service, correlationId, id }) => responseFor(await service.listHospitalTaskComments(actor, path[1], planningFilters(request, comments.hospitalTaskCommentFiltersSchema)), correlationId, id) },
  createHospitalTaskComment: { authentication: "session", handle: async (c) => planningCommand(c, comments.hospitalTaskCommentCreateSchema, (input) => c.service.createHospitalTaskComment(c.actor, c.path[1], input), true, 201) },
  updateHospitalTaskComment: { authentication: "session", handle: async (c) => planningCommand(c, comments.hospitalTaskCommentPatchSchema, (input) => c.service.updateHospitalTaskComment(c.actor, c.path[1], c.path[3], input)) },
  deleteHospitalTaskComment: { authentication: "session", handle: async (c) => planningCommand(c, comments.hospitalTaskCommentDeleteSchema, (input) => c.service.deleteHospitalTaskComment(c.actor, c.path[1], c.path[3], input)) },
  listHospitalTaskAttachments: { authentication: "session", handle: async ({ request, path, actor, service, correlationId, id }) => responseFor(await service.listHospitalTaskAttachments(actor, path[1], planningFilters(request, attachments.hospitalTaskAttachmentFiltersSchema)), correlationId, id) },
  createHospitalTaskAttachmentSession: { authentication: "session", handle: async (c) => planningCommand(c, attachments.hospitalTaskAttachmentUploadSchema, (input) => c.service.createHospitalTaskAttachmentSession(c.actor, c.path[1], input), true, 201) },
  uploadHospitalTaskAttachment: { authentication: "session", handle: async ({ request, path, actor, service, correlationId, id }) => {
    await assertRateLimit(`session:${actor.sessionId ?? actor.id}:task-attachment-content`, 30, 60_000);
    if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/octet-stream") throw new ApiError("UNSUPPORTED_MEDIA_TYPE", "Envie o conteúdo binário do arquivo.", 415);
    const authorized = await service.authorizeHospitalTaskAttachmentUpload(actor, path[1]);
    const bytes = await readBytesWithLimit(request, Math.min(10 * 1024 * 1024, authorized.sizeBytes));
    return responseFor(await service.uploadHospitalTaskAttachment(actor, path[1], bytes), correlationId, id);
  } },
  finalizeHospitalTaskAttachment: { authentication: "session", handle: async (c) => planningCommand(c, attachments.hospitalTaskAttachmentFinalizeSchema, (input) => c.service.finalizeHospitalTaskAttachment(c.actor, c.path[1], input)) },
  downloadHospitalTaskAttachment: { authentication: "session", handle: async ({ path, actor, service, correlationId }) => {
    const { attachment, content } = await service.downloadHospitalTaskAttachment(actor, path[1]);
    return new Response(content as unknown as BodyInit, { status: 200, headers: { "content-type": attachment.detectedMime!, "content-length": String(content.byteLength), "content-disposition": `attachment; filename="${attachment.safeName}"`, "cache-control": "private, no-store", "x-correlation-id": correlationId } });
  } }
} satisfies ApiHandlerGroup;
