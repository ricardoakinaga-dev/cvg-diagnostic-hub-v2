import { createHash, randomUUID } from "node:crypto";
import { ITEM_STATES, PRIORITIES, ROLES } from "@cvg/contracts";
import type { ItemState, Permission, Priority, RoleCode, WorkflowType } from "@cvg/contracts";
import type { Admission, Attachment, AuditEvent, DiagnosticItem, DiagnosticRequest, DiagnosticService, Notification, Procedure, ProcedureSchedule, ReasonCode, Result, ResultVersion, Sample, StateStore, StoreState, User } from "../domain/models";
import type { CommandMeta, NotificationAcknowledgeInput, CreateRequestInput, ReceiveSampleInput, RecollectionInput, ResultDraftInput, ReleaseInput, ReviewInput, AmendInput, ScheduleInput, CancelInput, RejectInput, VoidInput, AttachmentUploadInput, DiagnosticServiceCreateInput, DiagnosticServicePatchInput, ReasonCodeCreateInput, ReasonCodePatchInput, UserRoleUpdateInput, ManagedUserCreateInput, ManagedUserDeactivateInput, ManagedUser, ManagementOverview, DashboardIndicatorKey, DashboardIndicator, DashboardWindow, DashboardView, RequestListFilters, SearchResultType, SearchFilters, SearchResult, TimelineFilters, TimelineResult, RequestView, ResultView, ItemView, SampleCommandResult, ResultDraftCommandResult, ResultReleaseCommandResult, ReviewCommandResult, ItemCommandResult, ProcedureScheduleCommandResult, ProcedureRescheduleCommandResult, ProcedureExecutionCommandResult, AmendCommandResult, VoidCommandResult, PublicAttachment, AttachmentSessionResult, AttachmentFinalizationResult, PatientDiagnosticsResult, ReportView } from "./service-types";
import { canAccessResource, managerCanAccessDepartment, managerDepartmentCodes } from "../security/authorization";
import { ApiError } from "../http/envelope";
import { hashPassword } from "../security/password";
import type { ApplicationServiceContext } from "./service-context";
import * as helpers from "./service-common";
import { findById } from "../domain/state-index";
const {
  MAX_NOTE_LENGTH,
  MAX_RESULT_NARRATIVE_LENGTH,
  MAX_ATTACHMENT_SIZE,
  DEFAULT_PAGE_SIZE,
  ALLOWED_ATTACHMENT_MIME,
  INDICATOR_DEFINITIONS,
  criticalPolicyIsReady,
  now,
  dashboardTimezone,
  managedUser,
  id,
  stableSerialize,
  hashPayload,
  idempotencyFingerprint,
  requireText,
  operationalManagedRoles,
  canManageUserTarget,
  normalizedEmail,
  validatedTimezone,
  validatedPassword,
  normalizedManagedDepartments,
  revokeUserSessions,
  requireRecentReauthentication,
  requireActiveUser,
  requirePermission,
  isExecutorRole,
  hasServicePatientContext,
  hasManagerRequestContext,
  hasManagerPatientContext,
  requirePatientPermission,
  requireRequestPermission,
  findOrThrow,
  createAudit,
  createOutbox,
  notificationFor,
  withIdempotency,
  saveIdempotency,
  requireIdempotencyKey,
  validatedSlaHours,
  validateServiceDefinition,
  serviceFor,
  requestFor,
  itemFor,
  resultFor,
  procedureFor,
  scheduleWindow,
  hasScheduleConflict,
  activeReason,
  attachmentFor,
  publicAttachment,
  safeAttachmentName,
  assertAttachmentMetadata,
  requireAttachmentOwner,
  attachmentSessionIsExpired,
  attachmentUploadClaimIsActive,
  attachmentStorageKeys,
  detectedMime,
  requestView,
  requestViewForActor,
  canViewRequest,
  requestForAuditEvent,
  auditEventItem,
  auditEventItemIds,
  auditEventDepartmentCode,
  canViewManagementAudit,
  requestForNotification,
  decodeKeysetCursor,
  decodeSearchCursor,
  decodeTimelineCursor,
  decodeRequestCursor,
  decodeAuditCursor,
  encodeKeysetCursor,
  pageSize,
  dateFilter,
  resultView,
  visibleResultVersions,
  requireCurrentResultRead,
  ensureExpectedVersion,
  calculateDueAt,
  nextRequestState,
  nextActionFor,
  deleteStoredObject,
  releaseUploadClaim,
  transitionItem,
} = helpers;

export function createAttachmentService({ store, storage, scanner }: ApplicationServiceContext) {
  const service = {
    async createAttachmentUploadSession(actor: User, versionId: string, input: AttachmentUploadInput): Promise<AttachmentSessionResult> {
      const scope = "POST:/attachments/upload-session";
      return store.transaction(async (originalState) => {
        const currentActor = requireActiveUser(originalState, actor);
        requireIdempotencyKey(input.idempotencyKey);
        const version = findOrThrow(findById(originalState.resultVersions, versionId));
        const result = resultFor(originalState, version.resultId);
        const view = resultView(originalState, result);
        const metadata = assertAttachmentMetadata(input);
        requirePermission(currentActor, "attachment.upload_session", { departmentCode: view.service.departmentCode, serviceCode: view.service.code });
        requireAttachmentOwner(currentActor, version);
        const idempotent = withIdempotency<AttachmentSessionResult>(originalState, currentActor.id, scope, input.idempotencyKey, { versionId, input });
        if (idempotent.found) return { state: originalState, result: idempotent.existing! };
        ensureExpectedVersion(version.version, input.expectedVersion);
        if (!view.service.allowsAttachment) throw new ApiError("VALIDATION_ERROR", "Este serviço não aceita anexos.", 400);
        if (version.status !== "DRAFT") throw new ApiError("INVALID_STATE_TRANSITION", "Anexos só podem ser preparados em um draft.", 409);
        const createdAt = now();
        const attachment: Attachment = { id: id("attachment"), resultVersionId: version.id, safeName: metadata.safeName, storageKey: `attachments/${result.id}/${randomUUID()}/${metadata.safeName}`, detectedMime: metadata.mimeType, sizeBytes: input.sizeBytes, checksum: metadata.checksum, scanStatus: "PENDING", uploadStatus: "INITIATED", expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(), createdBy: currentActor.id, createdAt };
        const correlationId = input.correlationId ?? id("corr");
        const nextState = { ...originalState, attachments: [...originalState.attachments, attachment], auditEvents: [...originalState.auditEvents, createAudit("AttachmentUploadSessionCreated", currentActor.id, "Attachment", attachment.id, correlationId, undefined, "INITIATED", { resultVersionId: version.id, sizeBytes: attachment.sizeBytes })] };
        const resultPayload = { attachment: publicAttachment(attachment), uploadUrl: `/api/v1/attachments/${attachment.id}/content`, expiresAt: attachment.expiresAt! };
        return { state: saveIdempotency(nextState, currentActor.id, scope, input.idempotencyKey, resultPayload, { versionId, input }), result: resultPayload };
      });
    },

    async authorizeAttachmentUpload(actor: User, attachmentId: string): Promise<{ sizeBytes: number }> {
      const state = await store.readState();
      const currentActor = requireActiveUser(state, actor);
      const attachment = attachmentFor(state, attachmentId);
      const version = findOrThrow(findById(state.resultVersions, attachment.resultVersionId));
      const result = resultFor(state, version.resultId);
      const view = resultView(state, result);
      requirePermission(currentActor, "attachment.finalize", { departmentCode: view.service.departmentCode, serviceCode: view.service.code });
      requireAttachmentOwner(currentActor, version, attachment);
      if (attachment.uploadStatus !== "INITIATED") throw new ApiError("INVALID_STATE_TRANSITION", "A sessão de upload não está aberta.", 409);
      if (attachmentSessionIsExpired(attachment)) throw new ApiError("UPLOAD_EXPIRED", "A sessão de upload expirou.", 409);
      return { sizeBytes: attachment.sizeBytes };
    },

    async uploadAttachment(actor: User, attachmentId: string, content: Uint8Array): Promise<AttachmentFinalizationResult> {
      const bytes = Buffer.from(content);
      const detected = detectedMime(bytes);
      const claimToken = randomUUID();
      const claimed = await store.transaction((state) => {
        const currentActor = requireActiveUser(state, actor);
        const attachment = attachmentFor(state, attachmentId);
        const version = findOrThrow(findById(state.resultVersions, attachment.resultVersionId));
        const result = resultFor(state, version.resultId);
        const view = resultView(state, result);
        requirePermission(currentActor, "attachment.finalize", { departmentCode: view.service.departmentCode, serviceCode: view.service.code });
        requireAttachmentOwner(currentActor, version, attachment);
        if (attachment.uploadStatus !== "INITIATED") throw new ApiError("INVALID_STATE_TRANSITION", "A sessão de upload não está aberta.", 409);
        if (attachment.expiresAt && new Date(attachment.expiresAt).getTime() < Date.now()) throw new ApiError("UPLOAD_EXPIRED", "A sessão de upload expirou.", 409);
        if (attachment.uploadClaimToken && (!attachment.uploadClaimExpiresAt || Date.parse(attachment.uploadClaimExpiresAt) > Date.now())) {
          throw new ApiError("UPLOAD_IN_PROGRESS", "Este anexo já está sendo enviado.", 409);
        }
        const actualChecksum = createHash("sha256").update(bytes).digest("hex");
        if (bytes.byteLength !== attachment.sizeBytes) throw new ApiError("ATTACHMENT_SIZE_MISMATCH", "O tamanho enviado não corresponde à sessão de upload.", 400);
        if (actualChecksum !== attachment.checksum) throw new ApiError("ATTACHMENT_CHECKSUM_MISMATCH", "O checksum enviado não corresponde ao conteúdo recebido.", 400);
        const storageKey = `${attachment.storageKey}.claim-${claimToken}`;
        const claimedAttachment = { ...attachment, uploadClaimToken: claimToken, uploadClaimExpiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString() };
        return {
          state: {
            ...state,
            attachments: state.attachments.map((entry) => entry.id === attachment.id ? claimedAttachment : entry)
          },
          result: { attachment, storageKey }
        };
      });
      let scanStatus: "CLEAN" | "QUARANTINED" | "FAILED";
      try {
        await storage.put(claimed.storageKey, bytes);
        scanStatus = await scanner.scan({ content: bytes, checksum: claimed.attachment.checksum, declaredMime: claimed.attachment.detectedMime, detectedMime: detected });
      } catch {
        await deleteStoredObject(storage, claimed.storageKey).catch(() => undefined);
        await releaseUploadClaim(store, attachmentId, claimToken).catch(() => undefined);
        throw new ApiError("STORAGE_UNAVAILABLE", "O armazenamento privado não está disponível.", 503, { retryable: true });
      }
      try {
        const updated = await store.transaction((state) => {
          const currentActor = requireActiveUser(state, actor);
          const attachment = attachmentFor(state, attachmentId);
          const version = findOrThrow(findById(state.resultVersions, attachment.resultVersionId));
          const result = resultFor(state, version.resultId);
          const view = resultView(state, result);
          requirePermission(currentActor, "attachment.finalize", { departmentCode: view.service.departmentCode, serviceCode: view.service.code });
          requireAttachmentOwner(currentActor, version, attachment);
          if (attachment.uploadStatus !== "INITIATED" || attachment.uploadClaimToken !== claimToken) {
            throw new ApiError("UPLOAD_CLAIM_LOST", "A sessão de upload foi alterada durante o envio.", 409, { retryable: true });
          }
          if (attachment.expiresAt && Date.parse(attachment.expiresAt) < Date.now()) {
            throw new ApiError("UPLOAD_EXPIRED", "A sessão de upload expirou.", 409);
          }
          const committed: Attachment = {
            ...attachment,
            storageKey: claimed.storageKey,
            uploadStatus: "UPLOADED",
            scanStatus,
            detectedMime: detected ?? "application/octet-stream",
            uploadClaimToken: undefined,
            uploadClaimExpiresAt: undefined
          };
          return {
            state: {
              ...state,
              attachments: state.attachments.map((entry) => entry.id === attachment.id ? committed : entry)
            },
            result: committed
          };
        });
        return { attachment: publicAttachment(updated) };
      } catch (error) {
        let authoritativeState: StoreState;
        try {
          authoritativeState = await store.readState();
        } catch {
          throw error;
        }
        const committed = authoritativeState.attachments.find((entry) =>
          entry.id === attachmentId && entry.storageKey === claimed.storageKey && entry.uploadStatus !== "INITIATED"
        );
        if (committed) return { attachment: publicAttachment(committed) };
        const storageKeyIsReferenced = authoritativeState.attachments.some((entry) => entry.storageKey === claimed.storageKey);
        if (!storageKeyIsReferenced) await deleteStoredObject(storage, claimed.storageKey).catch(() => undefined);
        await releaseUploadClaim(store, attachmentId, claimToken).catch(() => undefined);
        throw error;
      }
    },

    async finalizeAttachment(actor: User, attachmentId: string, input: CommandMeta): Promise<AttachmentFinalizationResult> {
      const scope = "POST:/attachments/finalize";
      return store.transaction(async (originalState) => {
        const currentActor = requireActiveUser(originalState, actor);
        requireIdempotencyKey(input.idempotencyKey);
        const attachment = attachmentFor(originalState, attachmentId);
        const version = findOrThrow(findById(originalState.resultVersions, attachment.resultVersionId));
        const result = resultFor(originalState, version.resultId);
        const view = resultView(originalState, result);
        requirePermission(currentActor, "attachment.finalize", { departmentCode: view.service.departmentCode, serviceCode: view.service.code });
        requireAttachmentOwner(currentActor, version, attachment);
        const idempotent = withIdempotency<AttachmentFinalizationResult>(originalState, currentActor.id, scope, input.idempotencyKey, { attachmentId, input });
        if (idempotent.found) return { state: originalState, result: idempotent.existing! };
        ensureExpectedVersion(version.version, input.expectedVersion);
        if (attachment.uploadStatus !== "UPLOADED") throw new ApiError("INVALID_STATE_TRANSITION", "O arquivo ainda não foi enviado.", 409);
        if (attachment.expiresAt && new Date(attachment.expiresAt).getTime() < Date.now()) throw new ApiError("UPLOAD_EXPIRED", "A sessão de upload expirou.", 409);
        if (attachment.scanStatus === "PENDING") throw new ApiError("SCAN_UNAVAILABLE", "A varredura de segurança ainda não foi concluída.", 422, { retryable: true });
        if (attachment.scanStatus !== "CLEAN") throw new ApiError("ATTACHMENT_QUARANTINED", "O arquivo foi colocado em quarentena e não pode ser anexado.", 422);
        const finalized = { ...attachment, uploadStatus: "FINALIZED" as const };
        const correlationId = input.correlationId ?? id("corr");
        const nextState = { ...originalState, attachments: originalState.attachments.map((entry) => entry.id === attachment.id ? finalized : entry), auditEvents: [...originalState.auditEvents, createAudit("AttachmentFinalized", currentActor.id, "Attachment", attachment.id, correlationId, "UPLOADED", "FINALIZED", { resultVersionId: version.id })], outbox: [...originalState.outbox, createOutbox("AttachmentFinalized", "Attachment", attachment.id, correlationId, { resultVersionId: version.id })] };
        const resultPayload = { attachment: publicAttachment(finalized) };
        return { state: saveIdempotency(nextState, currentActor.id, scope, input.idempotencyKey, resultPayload, { attachmentId, input }), result: resultPayload };
      });
    },

    async downloadAttachment(actor: User, attachmentId: string): Promise<{ attachment: Attachment; content: Buffer }> {
      const state = await store.readState();
      const currentActor = requireActiveUser(state, actor);
      const attachment = attachmentFor(state, attachmentId);
      const version = findOrThrow(findById(state.resultVersions, attachment.resultVersionId));
      const result = resultFor(state, version.resultId);
      const view = resultView(state, result);
      const resource = { patientId: view.request.patientId, departmentCode: view.service.departmentCode, serviceCode: view.service.code };
      requirePermission(currentActor, "attachment.download", resource);
      requirePermission(currentActor, "attachment.view", resource);
      if (!["RELEASED", "SUPERSEDED"].includes(version.status)) throw new ApiError("NOT_FOUND", "Anexo não disponível.", 404);
      if (attachment.uploadStatus !== "FINALIZED" || attachment.scanStatus !== "CLEAN") throw new ApiError("NOT_FOUND", "Anexo não disponível.", 404);
      let content: Buffer;
      try {
        content = await storage.get(attachment.storageKey);
      } catch {
        throw new ApiError("STORAGE_UNAVAILABLE", "O conteúdo do anexo não está disponível.", 503, { retryable: true });
      }
      if (content.byteLength !== attachment.sizeBytes || createHash("sha256").update(content).digest("hex") !== attachment.checksum) {
        throw new ApiError("ATTACHMENT_INTEGRITY_FAILED", "A integridade do anexo armazenado não pôde ser confirmada.", 503, { retryable: false });
      }
      const auditedAttachment = await store.transaction((currentState) => {
        const auditedActor = requireActiveUser(currentState, currentActor);
        const currentAttachment = attachmentFor(currentState, attachment.id);
        const currentVersion = findOrThrow(findById(currentState.resultVersions, currentAttachment.resultVersionId));
        const currentResult = resultFor(currentState, currentVersion.resultId);
        const currentView = resultView(currentState, currentResult);
        const currentResource = { patientId: currentView.request.patientId, departmentCode: currentView.service.departmentCode, serviceCode: currentView.service.code };
        requirePermission(auditedActor, "attachment.download", currentResource);
        requirePermission(auditedActor, "attachment.view", currentResource);
        if (!["RELEASED", "SUPERSEDED"].includes(currentVersion.status) || currentAttachment.uploadStatus !== "FINALIZED" || currentAttachment.scanStatus !== "CLEAN") {
          throw new ApiError("NOT_FOUND", "Anexo não disponível.", 404);
        }
        const audit = createAudit("AttachmentDownloaded", auditedActor.id, "Attachment", currentAttachment.id, id("corr"), undefined, undefined, { resultVersionId: currentVersion.id });
        if (content.byteLength !== currentAttachment.sizeBytes || createHash("sha256").update(content).digest("hex") !== currentAttachment.checksum) {
          throw new ApiError("ATTACHMENT_INTEGRITY_FAILED", "A integridade do anexo armazenado não pôde ser confirmada.", 503, { retryable: false });
        }
        return { state: { ...currentState, auditEvents: [...currentState.auditEvents, audit] }, result: currentAttachment };
      });
      return { attachment: auditedAttachment, content };
    },

  };
  return service;
}
