import type { HospitalDocument, HospitalDocumentContent, HospitalDocumentRevision, HospitalDocumentView } from "@cvg/contracts";
import type { StoreState, User } from "../domain/models";
import type { ApplicationServiceContext } from "./service-context";
import { ApiError } from "../http/envelope";
import { hospitalDocumentCreateSchema, hospitalDocumentMetadataSchema, hospitalDocumentDraftSchema, hospitalDocumentRevisionSchema, hospitalDocumentDuplicateSchema, type HospitalDocumentCreateInput, type HospitalDocumentMetadataInput, type HospitalDocumentDraftInput, type HospitalDocumentRevisionInput, type HospitalDocumentDuplicateInput } from "../http/hospital-document-schemas";
import { ensureExpectedVersion, id, now, requireActiveUser, requireIdempotencyKey, saveIdempotency, withIdempotency } from "./service-common";
import { existingHospitalDocument, hospitalDocumentView, requireDocumentResponsible, requireEditableHospitalDocument, requireHospitalDocumentAccess } from "./hospital-document-policy";
import { changeHospitalDocument, currentDocumentDraft, parseDocumentCommand, recordHospitalDocument } from "./hospital-document-common";
import { requireHospitalCapability } from "./hospital-institution-policy";

function draft(title: string, content: HospitalDocumentContent, revision: number, actorId: string, timestamp: string): HospitalDocumentRevision {
  return { id: id("document-revision"), revision, title, content: structuredClone(content), status: "DRAFT", version: 1, createdBy: actorId, createdAt: timestamp, updatedBy: actorId, updatedAt: timestamp };
}
function createDefinition(state: StoreState, actor: User, input: { code: string; title: string; departmentCode: string; responsibleUserId: string; content: HospitalDocumentContent }, timestamp: string): HospitalDocument {
  const code = input.code.toUpperCase(); const departmentCode = input.departmentCode.toUpperCase();
  requireHospitalDocumentAccess(actor, "hospital_document.create", departmentCode); requireDocumentResponsible(state, input.responsibleUserId, departmentCode);
  requireHospitalCapability(state, departmentCode, "DOCUMENTS");
  if (state.hospitalDocuments.some((entry) => entry.code === code)) throw new ApiError("CONFLICT", "O código do documento já está em uso.", 409);
  const revision = draft(input.title, input.content, 1, actor.id, timestamp);
  return { id: id("hospital-document"), code, title: input.title, departmentCode, responsibleUserId: input.responsibleUserId, locked: false, archived: false, draftRevisionId: revision.id, revisions: [revision], createdBy: actor.id, createdAt: timestamp, updatedAt: timestamp, version: 1 };
}
export function createHospitalDocumentDraftService(context: Pick<ApplicationServiceContext, "store">) {
  return {
    async createHospitalDocument(actor: User, input: HospitalDocumentCreateInput): Promise<HospitalDocumentView> {
      return context.store.transaction((state) => {
        const current = requireActiveUser(state, actor); const body = parseDocumentCommand(hospitalDocumentCreateSchema, input);
        requireHospitalDocumentAccess(current, "hospital_document.create", body.departmentCode.toUpperCase()); requireIdempotencyKey(input.idempotencyKey);
        const scope = "POST:/hospital-documents"; const replay = withIdempotency<HospitalDocumentView>(state, current.id, scope, input.idempotencyKey, { input });
        // A create-only replay returns only the originally supplied content, never later editors' drafts.
        if (replay.found) return { state, result: hospitalDocumentView(state, current, replay.existing!.document) };
        const document = createDefinition(state, current, body, now()); const next = recordHospitalDocument(state, current, undefined, document, "HospitalDocumentCreated", input.correlationId);
        const result = hospitalDocumentView(next, current, document); return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, result, { input }), result };
      });
    },
    updateHospitalDocumentMetadata(actor: User, documentId: string, input: HospitalDocumentMetadataInput) {
      return changeHospitalDocument(context, actor, documentId, input, { permission: "hospital_document.update", action: "MetadataUpdated", schema: hospitalDocumentMetadataSchema, transform: (state, _current, previous, body, timestamp) => {
        requireEditableHospitalDocument(previous); requireDocumentResponsible(state, body.responsibleUserId, previous.departmentCode);
        return { ...previous, responsibleUserId: body.responsibleUserId, version: previous.version + 1, updatedAt: timestamp };
      } });
    },
    updateHospitalDocumentDraft(actor: User, documentId: string, input: HospitalDocumentDraftInput) {
      return changeHospitalDocument(context, actor, documentId, input, { permission: "hospital_document.update", action: "DraftUpdated", schema: hospitalDocumentDraftSchema, transform: (_state, current, previous, body, timestamp) => {
        requireEditableHospitalDocument(previous); const existing = currentDocumentDraft(previous); ensureExpectedVersion(existing.version, body.expectedDraftVersion);
        const revision = { ...existing, title: body.title ?? existing.title, content: body.content ? structuredClone(body.content) : existing.content, updatedBy: current.id, updatedAt: timestamp, version: existing.version + 1 };
        return { ...previous, revisions: previous.revisions.map((entry) => entry.id === revision.id ? revision : entry), version: previous.version + 1, updatedAt: timestamp };
      } });
    },
    createHospitalDocumentRevision(actor: User, documentId: string, input: HospitalDocumentRevisionInput) {
      return changeHospitalDocument(context, actor, documentId, input, { permission: "hospital_document.update", action: "RevisionCreated", schema: hospitalDocumentRevisionSchema, transform: (_state, current, previous, body, timestamp) => {
        requireEditableHospitalDocument(previous);
        if (previous.draftRevisionId) throw new ApiError("DOCUMENT_DRAFT_EXISTS", "Continue o rascunho atual antes de abrir outra revisão.", 409);
        const source = previous.revisions.find((entry) => entry.id === previous.currentPublishedRevisionId);
        if (!source) throw new ApiError("DOCUMENT_REVISION_REQUIRED", "A revisão publicada não está disponível.", 409);
        const revision = draft(body.title ?? source.title, body.content ?? source.content, Math.max(...previous.revisions.map((entry) => entry.revision)) + 1, current.id, timestamp);
        return { ...previous, draftRevisionId: revision.id, revisions: [...previous.revisions, revision], version: previous.version + 1, updatedAt: timestamp };
      } });
    },
    async duplicateHospitalDocument(actor: User, documentId: string, input: HospitalDocumentDuplicateInput): Promise<HospitalDocumentView> {
      return context.store.transaction((state) => {
        const current = requireActiveUser(state, actor); const source = existingHospitalDocument(state, current, documentId, "hospital_document.view"); const body = parseDocumentCommand(hospitalDocumentDuplicateSchema, input);
        requireHospitalDocumentAccess(current, "hospital_document.create", source.departmentCode); requireIdempotencyKey(input.idempotencyKey);
        const scope = `POST:/hospital-documents/${documentId}/duplicate`; const replay = withIdempotency<HospitalDocumentView>(state, current.id, scope, input.idempotencyKey, { input });
        if (replay.found) return { state, result: hospitalDocumentView(state, current, replay.existing!.document) };
        ensureExpectedVersion(source.version, body.expectedVersion);
        const revision = source.revisions.find((entry) => entry.id === (body.sourceRevisionId ?? source.currentPublishedRevisionId ?? source.draftRevisionId));
        if (!revision) throw new ApiError("VALIDATION_ERROR", "Escolha uma revisão deste documento.", 400);
        const document = { ...createDefinition(state, current, { ...body, departmentCode: source.departmentCode, content: revision.content }, now()), sourceDocumentId: source.id, sourceRevisionId: revision.id };
        const next = recordHospitalDocument(state, current, undefined, document, "HospitalDocumentDuplicated", input.correlationId); const result = hospitalDocumentView(next, current, document);
        return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, result, { input }), result };
      });
    }
  };
}
