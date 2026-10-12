import type { HospitalDocument, HospitalDocumentSnapshot, HospitalDocumentView, Permission } from "@cvg/contracts";
import type { StoreState, User } from "../domain/models";
import { ApiError } from "../http/envelope";
import { canAccessResource, managerCanAccessDepartment } from "../security/authorization";
import { hydrateUserPermissions } from "../security/access-group-policy";
import { requireActiveDepartment } from "./department-registry";
import { requireActiveUser } from "./service-common";

export const HOSPITAL_DOCUMENT_ACTIONS = ["hospital_document.view", "hospital_document.create", "hospital_document.update", "hospital_document.approve", "hospital_document.retire", "hospital_document.lock", "hospital_document.archive"] as const satisfies readonly Permission[];
export type HospitalDocumentAction = (typeof HOSPITAL_DOCUMENT_ACTIONS)[number];
export function canAccessHospitalDocument(actor: User, permission: HospitalDocumentAction, departmentCode: string): boolean {
  const scoped = actor.role === "ADMIN" || actor.role === "SUPERADMIN" || (actor.role === "MANAGER" ? managerCanAccessDepartment(actor, departmentCode) : actor.departmentCode === departmentCode);
  const clinicalApprover = permission !== "hospital_document.approve" || ["VETERINARIAN", "MANAGER", "SUPERADMIN"].includes(actor.role);
  return scoped && clinicalApprover && canAccessResource(actor, permission, { departmentCode });
}
export function requireHospitalDocumentAccess(actor: User, permission: HospitalDocumentAction, departmentCode: string): void {
  if (!canAccessHospitalDocument(actor, permission, departmentCode)) throw new ApiError("SCOPE_DENIED", "Você não tem acesso a este documento operacional.", 404);
}
export function existingHospitalDocument(state: StoreState, actor: User, documentId: string, permission: HospitalDocumentAction): HospitalDocument {
  const document = state.hospitalDocuments.find((entry) => entry.id === documentId);
  if (!document) throw new ApiError("NOT_FOUND", "O documento operacional não está disponível.", 404);
  requireHospitalDocumentAccess(actor, permission, document.departmentCode);
  return document;
}
export function requireEditableHospitalDocument(document: HospitalDocument): void {
  if (document.archived || document.locked) throw new ApiError("DOCUMENT_LOCKED", "Desarquive ou desbloqueie o documento antes de preparar uma revisão.", 409);
}
export function requireDocumentResponsible(state: StoreState, userId: string, departmentCode: string): void {
  requireActiveDepartment(state, departmentCode);
  const user = state.users.find((entry) => entry.id === userId);
  if (!user?.active || user.mustChangePassword || !canAccessHospitalDocument(hydrateUserPermissions(state, user), "hospital_document.view", departmentCode)) throw new ApiError("DOCUMENT_RESPONSIBLE_UNAVAILABLE", "Selecione um responsável ativo e autorizado para este setor.", 422);
}
export function hospitalDocumentView(state: StoreState, actor: User, document: HospitalDocument): HospitalDocumentView {
  const permissions = HOSPITAL_DOCUMENT_ACTIONS.filter((permission) => canAccessHospitalDocument(actor, permission, document.departmentCode) && (!document.archived && !document.locked || ["hospital_document.view", "hospital_document.archive", "hospital_document.lock", "hospital_document.retire"].includes(permission)));
  const favorite = state.workActivityPreferences.some((entry) => entry.userId === actor.id && entry.targetType === "HOSPITAL_DOCUMENT" && entry.targetId === document.id && entry.favorite);
  return { document: structuredClone(document), permissions, favorite };
}
/** Called only after the target's current permission and clinical context have passed. */
export function captureApprovedHospitalDocuments(state: StoreState, actor: User, documentIds: string[], departmentCodes: string[], capturedAt: string): HospitalDocumentSnapshot[] {
  const current = requireActiveUser(state, actor);
  if (documentIds.length > 20 || new Set(documentIds).size !== documentIds.length) throw new ApiError("VALIDATION_ERROR", "Selecione até vinte documentos distintos.", 400);
  return documentIds.map((documentId) => {
    const document = existingHospitalDocument(state, current, documentId, "hospital_document.view");
    if (!departmentCodes.includes(document.departmentCode)) throw new ApiError("VALIDATION_ERROR", "O documento não pertence a um setor desta atividade ou plano.", 400);
    const revision = document.revisions.find((entry) => entry.id === document.currentPublishedRevisionId);
    if (document.archived || revision?.status !== "APPROVED" || !revision.approvedBy || !revision.approvedAt || !Number.isFinite(Date.parse(revision.approvedAt)) || !revision.policyReference) throw new ApiError("DOCUMENT_NOT_APPROVED", "Publique uma revisão aprovada e vigente antes de vinculá-la.", 409);
    requireActiveDepartment(state, document.departmentCode);
    return { documentId: document.id, code: document.code, title: revision.title, departmentCode: document.departmentCode, revisionId: revision.id, revision: revision.revision, content: structuredClone(revision.content), approvedBy: revision.approvedBy, approvedAt: revision.approvedAt, policyReference: revision.policyReference, capturedAt };
  });
}
/** Current access controls visibility; publication changes never reinterpret captured bytes. */
export function visibleHospitalDocumentSnapshots(state: StoreState, actor: User, snapshots: HospitalDocumentSnapshot[] | undefined, departmentCodes: string[]): HospitalDocumentSnapshot[] | undefined {
  const current = requireActiveUser(state, actor);
  return snapshots?.filter((snapshot) => departmentCodes.includes(snapshot.departmentCode) && state.hospitalDocuments.some((document) => document.id === snapshot.documentId && document.departmentCode === snapshot.departmentCode && canAccessHospitalDocument(current, "hospital_document.view", document.departmentCode))).map((snapshot) => structuredClone(snapshot));
}
