import type { HospitalDocumentRevision } from "@cvg/contracts";
import type { User } from "../domain/models";
import type { ApplicationServiceContext } from "./service-context";
import { ApiError } from "../http/envelope";
import { hospitalDocumentApproveSchema, hospitalDocumentRetireSchema, hospitalDocumentLockSchema, hospitalDocumentArchiveSchema, type HospitalDocumentApproveInput, type HospitalDocumentRetireInput, type HospitalDocumentLockInput, type HospitalDocumentArchiveInput } from "../http/hospital-document-schemas";
import { ensureExpectedVersion } from "./service-common";
import { requireActiveDepartment } from "./department-registry";
import { changeHospitalDocument, currentDocumentDraft } from "./hospital-document-common";
import { requireDocumentResponsible, requireEditableHospitalDocument } from "./hospital-document-policy";
import { appendWorkNotifications, workActivityFollowers } from "./work-notification-policy";

export function createHospitalDocumentPublicationService(context: Pick<ApplicationServiceContext, "store">) {
  return {
    approveHospitalDocument(actor: User, documentId: string, input: HospitalDocumentApproveInput) {
      return changeHospitalDocument(context, actor, documentId, input, { permission: "hospital_document.approve", action: "Approved", schema: hospitalDocumentApproveSchema, transform: (state, current, previous, body, timestamp) => {
        requireEditableHospitalDocument(previous); requireActiveDepartment(state, previous.departmentCode); requireDocumentResponsible(state, previous.responsibleUserId, previous.departmentCode);
        const existing = currentDocumentDraft(previous); ensureExpectedVersion(existing.version, body.expectedDraftVersion);
        const approved: HospitalDocumentRevision = { ...existing, status: "APPROVED", approvedBy: current.id, approvedAt: timestamp, policyReference: body.policyReference, updatedBy: current.id, updatedAt: timestamp, version: existing.version + 1 };
        const revisions = previous.revisions.map((entry): HospitalDocumentRevision => entry.id === approved.id ? approved : entry.id === previous.currentPublishedRevisionId && entry.status === "APPROVED" ? { ...entry, status: "RETIRED", retiredBy: current.id, retiredAt: timestamp, retirementReason: `Substituída pela revisão ${approved.revision}.`, version: entry.version + 1 } : entry);
        return { ...previous, title: approved.title, revisions, currentPublishedRevisionId: approved.id, draftRevisionId: undefined, updatedAt: timestamp, version: previous.version + 1 };
      }, afterChange: (state, current, document, timestamp) => appendWorkNotifications(state, { sourceKey: `document:${document.id}:${document.version}`, targetType: "HOSPITAL_DOCUMENT", targetId: document.id, eventType: "DOCUMENT_PUBLISHED", recipientUserIds: [...workActivityFollowers(state, "HOSPITAL_DOCUMENT", document.id), document.responsibleUserId].filter((userId) => userId !== current.id), createdAt: timestamp }) });
    },
    retireHospitalDocument(actor: User, documentId: string, input: HospitalDocumentRetireInput) {
      return changeHospitalDocument(context, actor, documentId, input, { permission: "hospital_document.retire", action: "Retired", schema: hospitalDocumentRetireSchema, transform: (_state, current, previous, body, timestamp) => {
        const existing = previous.revisions.find((entry) => entry.id === previous.currentPublishedRevisionId);
        if (existing?.id !== body.expectedRevisionId || existing.status !== "APPROVED") throw new ApiError("DOCUMENT_REVISION_NOT_CURRENT", "A revisão aprovada informada já não está vigente.", 409);
        const retired: HospitalDocumentRevision = { ...existing, status: "RETIRED", retiredBy: current.id, retiredAt: timestamp, retirementReason: body.reason, version: existing.version + 1 };
        return { ...previous, revisions: previous.revisions.map((entry) => entry.id === retired.id ? retired : entry), updatedAt: timestamp, version: previous.version + 1 };
      } });
    },
    lockHospitalDocument(actor: User, documentId: string, input: HospitalDocumentLockInput) {
      return changeHospitalDocument(context, actor, documentId, input, { permission: "hospital_document.lock", action: "LockChanged", schema: hospitalDocumentLockSchema, transform: (_state, _current, previous, body, timestamp) => ({ ...previous, locked: body.locked, updatedAt: timestamp, version: previous.version + 1 }) });
    },
    archiveHospitalDocument(actor: User, documentId: string, input: HospitalDocumentArchiveInput) {
      return changeHospitalDocument(context, actor, documentId, input, { permission: "hospital_document.archive", action: "ArchiveChanged", schema: hospitalDocumentArchiveSchema, transform: (state, _current, previous, body, timestamp) => {
        if (!body.archived) requireActiveDepartment(state, previous.departmentCode);
        return { ...previous, archived: body.archived, updatedAt: timestamp, version: previous.version + 1 };
      } });
    }
  };
}
