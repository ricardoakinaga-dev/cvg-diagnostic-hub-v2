import { ApiError } from "../../../../server/http/envelope";
import { assertRateLimit } from "../../../../server/security/rate-limit";
import { admissionContextSchema, amendResultSchema, attachmentFinalizeSchema, attachmentUploadSchema, cancelSchema, emptyCommandSchema, encounterCloseSchema, encounterOpenSchema, recollectionSchema, rejectSchema, releaseResultSchema, resultDraftSchema, reviewResultSchema, sampleSchema, scheduleSchema, voidResultSchema } from "../../../../server/http/command-schemas";
import { readBytesWithLimit } from "../../../../server/http/request-body";
import { codePointLength, createRequestSchema, createPatientSchema, responseFor, jsonBody, objectBody, parseCommandBody, commandMeta, positiveInteger, parseLimit, parseItemState, parsePriority, parseBooleanFilter, parseServiceIdentifier, parseDateTimeFilter, parseCursor } from "./route-support";
import type { ApiHandlerGroup } from "./route-support";
export const clinicalHandlers = {
  listPatients: { authentication: "session", handle: async ({ request, correlationId, id, service, actor }) => {
      const query = new URL(request.url).searchParams.get("q") ?? "";
      if (codePointLength(query) > 200)
        throw new ApiError("VALIDATION_ERROR", "A busca de pacientes é muito longa.", 400);
      return responseFor(await service.listPatients(actor, query), correlationId, id);
    } },
  createPatient: { authentication: "session", handle: async ({ request, operation, correlationId, id, service, actor }) => {
      const body = await objectBody(request);
      const parsed = createPatientSchema.safeParse(body);
      if (!parsed.success)
        throw new ApiError("VALIDATION_ERROR", "Os dados do paciente são inválidos.", 400);
      return responseFor(await service.createPatient(actor, parsed.data, commandMeta(request, body, operation)), correlationId, id, 201);
    } },
  getPatientDiagnostics: { authentication: "session", handle: async ({ request, path, correlationId, id, service, actor }) => {
      const search = new URL(request.url).searchParams;
      return responseFor(await service.getPatientDiagnostics(actor, path[1], { limit: parseLimit(search.get("limit")), cursor: parseCursor(search.get("cursor")) }), correlationId, id);
    } },
  listPatientArchive: { authentication: "session", handle: async ({ request, path, correlationId, id, service, actor }) => {
      return responseFor(await service.listPatientArchive(actor, path[1], { limit: parseLimit(new URL(request.url).searchParams.get("limit")) }), correlationId, id);
    } },
  getArchivedRequest: { authentication: "session", handle: async ({ path, correlationId, id, service, actor }) => {
      return responseFor(await service.getArchivedRequest(actor, path[2]), correlationId, id);
    } },
  exportPatientData: { authentication: "session", handle: async ({ request, correlationId, id, service, actor }) => {
      const externalId = new URL(request.url).searchParams.get("externalId") ?? "";
      if (!/^[A-Za-z0-9._-]{1,100}$/.test(externalId))
        throw new ApiError("VALIDATION_ERROR", "Informe o número do prontuário (letras, números, ponto, hífen ou sublinhado; até 100 caracteres).", 400);
      return responseFor(await service.exportPatientData(actor, externalId, { correlationId }), correlationId, id);
    } },
  listPatientEncounters: { authentication: "session", handle: async ({ path, correlationId, id, service, actor }) => {
      return responseFor(await service.listEncounters(actor, path[1]), correlationId, id);
    } },
  openPatientEncounter: { authentication: "session", handle: async ({ request, path, operation, correlationId, id, service, actor }) => {
      const body = await objectBody(request);
      const input = parseCommandBody(body, encounterOpenSchema, "Os dados do atendimento são inválidos.");
      return responseFor(await service.openEncounter(actor, path[1], input, commandMeta(request, body, operation)), correlationId, id, 201);
    } },
  closeEncounter: { authentication: "session", handle: async ({ request, path, operation, correlationId, id, service, actor }) => {
      const body = await objectBody(request);
      const input = parseCommandBody(body, encounterCloseSchema, "Os dados do encerramento são inválidos.");
      return responseFor(await service.closeEncounter(actor, path[1], input, commandMeta(request, body, operation)), correlationId, id);
    } },
  getPatient: { authentication: "session", handle: async ({ path, correlationId, id, service, actor }) => {
      return responseFor(await service.getPatient(actor, path[1]), correlationId, id);
    } },
  getEncounter: { authentication: "session", handle: async ({ path, correlationId, id, service, actor }) => {
      return responseFor(await service.getEncounter(actor, path[1]), correlationId, id);
    } },
  getAdmission: { authentication: "session", handle: async ({ path, correlationId, id, service, actor }) => {
      return responseFor(await service.getAdmission(actor, path[1]), correlationId, id);
    } },
  updateAdmissionContext: { authentication: "session", handle: async ({ request, path, operation, correlationId, id, service, actor }) => {
      const body = await objectBody(request);
      const input = parseCommandBody(body, admissionContextSchema, "Os dados da atualização de contexto são inválidos.");
      return responseFor(await service.updateAdmissionContext(actor, path[1], { ...input, ...commandMeta(request, body, operation) }), correlationId, id);
    } },
  listDiagnosticRequests: { authentication: "session", handle: async ({ request, correlationId, id, service, actor }) => {
      const search = new URL(request.url).searchParams;
      const data = await service.listRequests(actor, {
        status: parseItemState(search.get("status")),
        departmentCode: search.get("departmentCode") ?? search.get("departmentId") ?? undefined,
        priority: parsePriority(search.get("priority")),
        serviceId: parseServiceIdentifier(search.get("serviceId")),
        overdue: parseBooleanFilter(search.get("overdue"), "overdue"),
        from: parseDateTimeFilter(search.get("from"), "from"),
        to: parseDateTimeFilter(search.get("to"), "to"),
        cursor: parseCursor(search.get("cursor")),
        limit: parseLimit(search.get("limit"))
      });
      return responseFor(data.items, correlationId, id, 200, { nextCursor: data.nextCursor, limit: data.limit, total: data.total });
    } },
  createDiagnosticRequest: { authentication: "session", handle: async ({ request, operation, correlationId, id, service, actor }) => {
      const parsed = createRequestSchema.safeParse(await jsonBody(request));
      if (!parsed.success)
        throw new ApiError("VALIDATION_ERROR", "Os dados da solicitação são inválidos.", 400);
      const body = parsed.data;
      const result = await service.createRequest(actor, body, { ...commandMeta(request, body, operation), allowDuplicateOverride: request.headers.get("x-duplicate-override") === "true" });
      return responseFor(result, correlationId, id, 201);
    } },
  getDiagnosticRequest: { authentication: "session", handle: async ({ path, correlationId, id, service, actor }) => {
      return responseFor(await service.getRequest(actor, path[1]), correlationId, id);
    } },
  cancelDiagnosticRequest: { authentication: "session", handle: async ({ request, path, operation, correlationId, id, service, actor }) => {
      const body = await objectBody(request);
      const input = parseCommandBody(body, cancelSchema, "Os dados de cancelamento são inválidos.");
      return responseFor(await service.cancelRequest(actor, path[1], { ...input, ...commandMeta(request, body, operation) }), correlationId, id);
    } },
  getDiagnosticItem: { authentication: "session", handle: async ({ path, correlationId, id, service, actor }) => {
      return responseFor(await service.getItem(actor, path[1]), correlationId, id);
    } },
  receiveDiagnosticItemSample: { authentication: "session", handle: async ({ request, path, operation, correlationId, id, service, actor }) => {
      const itemId = path[1];
      const body = await objectBody(request);
      const meta = commandMeta(request, body, operation);
      const input = parseCommandBody(body, sampleSchema, "Os dados da amostra são inválidos.");
      return responseFor(await service.receiveSample(actor, [itemId], { ...input, ...meta }), correlationId, id);
    } },
  startDiagnosticItemProcessing: { authentication: "session", handle: async ({ request, path, operation, correlationId, id, service, actor }) => {
      const itemId = path[1];
      const body = await objectBody(request);
      const meta = commandMeta(request, body, operation);
      parseCommandBody(body, emptyCommandSchema, "Os dados de processamento são inválidos.");
      return responseFor(await service.startProcessing(actor, itemId, meta), correlationId, id);
    } },
  cancelDiagnosticItem: { authentication: "session", handle: async ({ request, path, operation, correlationId, id, service, actor }) => {
      const itemId = path[1];
      const body = await objectBody(request);
      const meta = commandMeta(request, body, operation);
      const input = parseCommandBody(body, cancelSchema, "Os dados de cancelamento são inválidos.");
      return responseFor(await service.cancelItem(actor, itemId, { ...input, ...meta }), correlationId, id);
    } },
  rejectDiagnosticItem: { authentication: "session", handle: async ({ request, path, operation, correlationId, id, service, actor }) => {
      const itemId = path[1];
      const body = await objectBody(request);
      const meta = commandMeta(request, body, operation);
      const input = parseCommandBody(body, rejectSchema, "Os dados de rejeição são inválidos.");
      return responseFor(await service.rejectItem(actor, itemId, { ...input, ...meta }), correlationId, id);
    } },
  completeDiagnosticItem: { authentication: "session", handle: async ({ request, path, operation, correlationId, id, service, actor }) => {
      const itemId = path[1];
      const body = await objectBody(request);
      const meta = commandMeta(request, body, operation);
      parseCommandBody(body, emptyCommandSchema, "Os dados de conclusão são inválidos.");
      return responseFor(await service.completeItem(actor, itemId, meta), correlationId, id);
    } },
  scheduleDiagnosticItem: { authentication: "session", handle: async ({ request, path, operation, correlationId, id, service, actor }) => {
      const itemId = path[1];
      const body = await objectBody(request);
      const meta = commandMeta(request, body, operation);
      const input = parseCommandBody(body, scheduleSchema, "Os dados de agenda são inválidos.");
      return responseFor(await service.scheduleProcedure(actor, itemId, { ...input, ...meta }), correlationId, id);
    } },
  startDiagnosticItemProcedure: { authentication: "session", handle: async ({ request, path, operation, correlationId, id, service, actor }) => {
      const itemId = path[1];
      const body = await objectBody(request);
      const meta = commandMeta(request, body, operation);
      parseCommandBody(body, emptyCommandSchema, "Os dados de procedimento são inválidos.");
      return responseFor(await service.startProcedure(actor, itemId, meta), correlationId, id);
    } },
  markDiagnosticItemPerformed: { authentication: "session", handle: async ({ request, path, operation, correlationId, id, service, actor }) => {
      const itemId = path[1];
      const body = await objectBody(request);
      const meta = commandMeta(request, body, operation);
      parseCommandBody(body, emptyCommandSchema, "Os dados do procedimento são inválidos.");
      return responseFor(await service.markProcedurePerformed(actor, itemId, meta), correlationId, id);
    } },
  requestDiagnosticItemRecollection: { authentication: "session", handle: async ({ request, path, operation, correlationId, id, service, actor }) => {
      const itemId = path[1];
      const body = await objectBody(request);
      const meta = commandMeta(request, body, operation);
      const input = parseCommandBody(body, recollectionSchema, "Os dados de recoleta são inválidos.");
      return responseFor(await service.requestRecollectionForItem(actor, itemId, { ...input, ...meta }), correlationId, id);
    } },
  createDiagnosticItemResult: { authentication: "session", handle: async ({ request, path, operation, correlationId, id, service, actor }) => {
      const itemId = path[1];
      const body = await objectBody(request);
      const meta = commandMeta(request, body, operation);
      const input = parseCommandBody(body, resultDraftSchema, "Os dados do resultado são inválidos.");
      return responseFor(await service.createResultDraft(actor, itemId, { ...input, ...meta }), correlationId, id, 201);
    } },
  getSampleLabel: { authentication: "session", handle: async ({ path, correlationId, id, service, actor }) => {
      return responseFor(await service.getSampleLabel(actor, path[1]), correlationId, id);
    } },
  receiveReplacementSample: { authentication: "session", handle: async ({ request, path, operation, correlationId, id, service, actor }) => {
      const body = await objectBody(request);
      const input = parseCommandBody(body, sampleSchema, "Os dados da amostra substituta são inválidos.");
      return responseFor(await service.receiveReplacement(actor, path[1], { ...input, ...commandMeta(request, body, operation) }), correlationId, id);
    } },
  rescheduleProcedure: { authentication: "session", handle: async ({ request, path, operation, correlationId, id, service, actor }) => {
      const body = await objectBody(request);
      const input = parseCommandBody(body, scheduleSchema, "Os dados de remarcação são inválidos.");
      return responseFor(await service.rescheduleProcedure(actor, path[1], { ...input, ...commandMeta(request, body, operation) }), correlationId, id);
    } },
  createAttachmentUploadSession: { authentication: "session", handle: async ({ request, path, operation, correlationId, id, service, actor }) => {
      const body = await objectBody(request);
      const input = parseCommandBody(body, attachmentUploadSchema, "Os dados do anexo são inválidos.");
      return responseFor(await service.createAttachmentUploadSession(actor, path[1], { ...input, ...commandMeta(request, body, operation) }), correlationId, id, 201);
    } },
  uploadAttachmentContent: { authentication: "session", handle: async ({ request, path, correlationId, id, service, actor }) => {
      await assertRateLimit(`session:${actor.sessionId ?? actor.id}:attachment-content`, positiveInteger(process.env.ATTACHMENT_UPLOAD_RATE_LIMIT, 30), 60000);
      const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (mediaType !== "application/octet-stream")
        throw new ApiError("UNSUPPORTED_MEDIA_TYPE", "O tipo de conteúdo não é suportado.", 415);
      const maxAttachmentBytes = positiveInteger(process.env.ATTACHMENT_MAX_BYTES, 25 * 1024 * 1024);
      const authorized = await service.authorizeAttachmentUpload(actor, path[1]);
      const bytes = await readBytesWithLimit(request, Math.min(maxAttachmentBytes, authorized.sizeBytes));
      return responseFor(await service.uploadAttachment(actor, path[1], bytes), correlationId, id);
    } },
  finalizeAttachment: { authentication: "session", handle: async ({ request, path, operation, correlationId, id, service, actor }) => {
      const body = await objectBody(request);
      parseCommandBody(body, attachmentFinalizeSchema, "Os dados de finalização são inválidos.");
      return responseFor(await service.finalizeAttachment(actor, path[1], commandMeta(request, body, operation)), correlationId, id);
    } },
  downloadAttachment: { authentication: "session", handle: async ({ path, correlationId, service, actor }) => {
      const downloaded = await service.downloadAttachment(actor, path[1]);
      return new Response(downloaded.content as unknown as BodyInit, { status: 200, headers: { "content-type": downloaded.attachment.detectedMime, "content-length": String(downloaded.content.byteLength), "content-disposition": `attachment; filename="${downloaded.attachment.safeName}"`, "cache-control": "private, no-store", "x-correlation-id": correlationId } });
    } },
  getResult: { authentication: "session", handle: async ({ path, correlationId, id, service, actor }) => {
      const resultId = path[1];
      return responseFor(await service.getResult(actor, resultId), correlationId, id);
    } },
  listResultVersions: { authentication: "session", handle: async ({ path, correlationId, id, service, actor }) => {
      const resultId = path[1];
      return responseFor(await service.listResultVersions(actor, resultId), correlationId, id);
    } },
  updateResultDraft: { authentication: "session", handle: async ({ request, path, operation, correlationId, id, service, actor }) => {
      const resultId = path[1];
      const body = await objectBody(request);
      const input = parseCommandBody(body, resultDraftSchema, "Os dados do draft são inválidos.");
      return responseFor(await service.updateResultDraft(actor, resultId, { ...input, ...commandMeta(request, body, operation) }), correlationId, id);
    } },
  releaseResult: { authentication: "session", handle: async ({ request, path, operation, correlationId, id, service, actor }) => {
      const resultId = path[1];
      const body = await objectBody(request);
      const input = parseCommandBody(body, releaseResultSchema, "Os dados de liberação são inválidos.");
      return responseFor(await service.releaseResult(actor, resultId, { ...input, ...commandMeta(request, body, operation) }), correlationId, id);
    } },
  amendResult: { authentication: "session", handle: async ({ request, path, operation, correlationId, id, service, actor }) => {
      const resultId = path[1];
      const body = await objectBody(request);
      const input = parseCommandBody(body, amendResultSchema, "Os dados da emenda são inválidos.");
      return responseFor(await service.amendResult(actor, resultId, { ...input, ...commandMeta(request, body, operation) }), correlationId, id);
    } },
  voidResult: { authentication: "session", handle: async ({ request, path, operation, correlationId, id, service, actor }) => {
      const resultId = path[1];
      const body = await objectBody(request);
      const input = parseCommandBody(body, voidResultSchema, "Os dados de invalidação são inválidos.");
      return responseFor(await service.voidResult(actor, resultId, { ...input, ...commandMeta(request, body, operation) }), correlationId, id);
    } },
  viewResult: { authentication: "session", handle: async ({ request, path, operation, correlationId, id, service, actor }) => {
      const resultId = path[1];
      const body = await objectBody(request);
      const input = parseCommandBody(body, reviewResultSchema, "Os dados de visualização são inválidos.");
      const current = await service.getResult(actor, resultId);
      const versionId = input.versionId;
      if (current.version.id !== versionId)
        throw new ApiError("REVIEW_STALE", "A versão do resultado mudou. Atualize o contexto.", 409);
      return responseFor(await service.viewResult(actor, versionId, commandMeta(request, body, operation)), correlationId, id);
    } },
  reviewResult: { authentication: "session", handle: async ({ request, path, operation, correlationId, id, service, actor }) => {
      const resultId = path[1];
      const body = await objectBody(request);
      const input = parseCommandBody(body, reviewResultSchema, "Os dados de revisão são inválidos.");
      return responseFor(await service.reviewResult(actor, resultId, { ...input, ...commandMeta(request, body, operation) }), correlationId, id);
    } },
  getReport: { authentication: "session", handle: async ({ path, correlationId, id, service, actor }) => {
      return responseFor(await service.getReport(actor, path[1]), correlationId, id);
    } }
} satisfies ApiHandlerGroup;
