import type { HospitalDocument, HospitalDocumentRevision } from "@cvg/contracts";
import type { StoreState, User } from "../domain/models";
import type { ZodType } from "zod";
import { ApiError } from "../http/envelope";
import { createAudit, createOutbox, ensureExpectedVersion, id, now, requireActiveUser, requireIdempotencyKey, saveIdempotency, withIdempotency } from "./service-common";
import { commandBody } from "./hospital-service-policy";
import { existingHospitalDocument, hospitalDocumentView, type HospitalDocumentAction } from "./hospital-document-policy";
import type { ApplicationServiceContext } from "./service-context";
import { createHash } from "node:crypto";

export type DocumentCommandMetadata = { idempotencyKey?: string; correlationId?: string };
export function parseDocumentCommand<T>(schema: ZodType<T>, input: DocumentCommandMetadata): T {
  const parsed = schema.safeParse(commandBody(input));
  if (!parsed.success) throw new ApiError("VALIDATION_ERROR", "Revise os campos, o conteúdo e as versões do documento.", 400);
  return parsed.data;
}
export function recordHospitalDocument(state: StoreState, actor: User, previous: HospitalDocument | undefined, document: HospitalDocument, eventType: string, correlationId?: string, reason?: string): StoreState {
  const correlation = correlationId ?? id("corr");
  const revision = document.revisions.find((entry) => entry.id === (document.draftRevisionId ?? document.currentPublishedRevisionId));
  const oldRevision = previous?.revisions.find((entry) => entry.id === (previous.draftRevisionId ?? previous.currentPublishedRevisionId));
  const digest = (value: HospitalDocumentRevision | undefined) => value ? createHash("sha256").update(JSON.stringify({ title: value.title, content: value.content })).digest("hex") : null;
  return { ...state, hospitalDocuments: previous ? state.hospitalDocuments.map((entry) => entry.id === document.id ? document : entry) : [...state.hospitalDocuments, document], auditEvents: [...state.auditEvents, createAudit(eventType, actor.id, "HospitalDocument", document.id, correlation, previous ? String(previous.version) : undefined, String(document.version), { departmentCode: document.departmentCode, code: document.code, responsibleUserId: document.responsibleUserId, previousResponsibleUserId: previous?.responsibleUserId ?? null, version: document.version, publishedRevisionId: document.currentPublishedRevisionId ?? null, draftRevisionId: document.draftRevisionId ?? null, revisionVersion: revision?.version ?? null, previousContentSha256: digest(oldRevision), contentSha256: digest(revision), approvedBy: revision?.approvedBy ?? null, policyReference: revision?.policyReference ?? null, locked: document.locked, archived: document.archived, reason: reason ?? revision?.retirementReason ?? null })], outbox: [...state.outbox, createOutbox(eventType, "HospitalDocument", document.id, correlation, { documentId: document.id, version: document.version })] };
}
export function currentDocumentDraft(document: HospitalDocument): HospitalDocumentRevision {
  const revision = document.revisions.find((entry) => entry.id === document.draftRevisionId && entry.status === "DRAFT");
  if (!revision) throw new ApiError("DOCUMENT_DRAFT_REQUIRED", "Abra uma nova revisão antes de editar ou publicar.", 409);
  return revision;
}
export function changeHospitalDocument<T extends { expectedVersion: number }, I extends T & DocumentCommandMetadata>(context: Pick<ApplicationServiceContext, "store">, actor: User, documentId: string, input: I, options: { permission: HospitalDocumentAction; action: string; schema: ZodType<T>; transform: (state: StoreState, current: User, previous: HospitalDocument, body: T, timestamp: string) => HospitalDocument; afterChange?: (state: StoreState, current: User, document: HospitalDocument, timestamp: string) => StoreState }) {
  return context.store.transaction((state) => {
    const current = requireActiveUser(state, actor); const previous = existingHospitalDocument(state, current, documentId, options.permission);
    existingHospitalDocument(state, current, documentId, "hospital_document.view");
    const body = parseDocumentCommand(options.schema, input); requireIdempotencyKey(input.idempotencyKey);
    const scope = `${options.action}:/hospital-documents/${documentId}`;
    const replay = withIdempotency(state, current.id, scope, input.idempotencyKey, { input });
    if (replay.found) return { state, result: hospitalDocumentView(state, current, previous) };
    ensureExpectedVersion(previous.version, body.expectedVersion);
    const timestamp = now(); const changed = options.transform(state, current, previous, body, timestamp);
    const reason = "reason" in body && typeof body.reason === "string" ? body.reason : undefined;
    const recorded = recordHospitalDocument(state, current, previous, changed, `HospitalDocument${options.action}`, input.correlationId, reason);
    const next = options.afterChange ? options.afterChange(recorded, current, changed, timestamp) : recorded;
    const result = hospitalDocumentView(next, current, changed);
    return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, result, { input }), result };
  });
}
