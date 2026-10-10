import { createHash, randomUUID } from "node:crypto";
import { validateStructuredLaboratoryResult } from "@cvg/domain";
import { ITEM_STATES, PRIORITIES, ROLES } from "@cvg/contracts";
import type { ItemState, Permission, Priority, RoleCode, WorkflowType } from "@cvg/contracts";
import type { Admission, Attachment, AuditEvent, DiagnosticItem, DiagnosticRequest, DiagnosticService, Notification, Procedure, ProcedureSchedule, ReasonCode, Result, ResultVersion, Sample, StateStore, StoreState, User } from "../domain/models";
import type { CommandMeta, NotificationAcknowledgeInput, CreateRequestInput, ReceiveSampleInput, RecollectionInput, ResultDraftInput, ReleaseInput, ReviewInput, AmendInput, ScheduleInput, CancelInput, RejectInput, VoidInput, AttachmentUploadInput, DiagnosticServiceCreateInput, DiagnosticServicePatchInput, ReasonCodeCreateInput, ReasonCodePatchInput, UserRoleUpdateInput, ManagedUserCreateInput, ManagedUserDeactivateInput, ManagedUser, ManagementOverview, DashboardIndicatorKey, DashboardIndicator, DashboardWindow, DashboardView, RequestListFilters, SearchResultType, SearchFilters, SearchResult, TimelineFilters, TimelineResult, RequestView, ResultView, ItemView, SampleCommandResult, ResultDraftCommandResult, ResultReleaseCommandResult, ReviewCommandResult, ItemCommandResult, ProcedureScheduleCommandResult, ProcedureRescheduleCommandResult, ProcedureExecutionCommandResult, AmendCommandResult, VoidCommandResult, PublicAttachment, AttachmentSessionResult, AttachmentFinalizationResult, PatientDiagnosticsResult, ReportView } from "./service-types";
import { canAccessResource, managerCanAccessDepartment, managerDepartmentCodes } from "../security/authorization";
import { ApiError } from "../http/envelope";
import { hashPassword } from "../security/password";
import type { ApplicationServiceContext } from "./service-context";
import { withCriticalWhatsAppAlert } from "./critical-alert-channel";
import * as helpers from "./service-common";
import { reprojectCommandRequest } from "./request-projection";
import { findById, resultVersionsForResult } from "../domain/state-index";
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

function normalizedResultContent(
  service: DiagnosticService,
  content: Record<string, unknown>,
  options: { requireStructured?: boolean } = {}
): Record<string, unknown> {
  const template = service.workflowType === "LABORATORY" && service.resultSchema === "NUMERIC_PANEL"
    ? service.resultTemplate
    : undefined;
  if (!template) return { ...content };
  if (template.status !== "ACTIVE") {
    throw new ApiError("RESULT_RELEASE_BLOCKED", "O painel laboratorial não está ativo para este serviço.", 422);
  }
  if (content.kind !== "LABORATORY_STRUCTURED") {
    if (options.requireStructured) {
      throw new ApiError("RESULT_RELEASE_BLOCKED", "Preencha o painel laboratorial estruturado antes de liberar o resultado.", 422);
    }
    // Legacy result content is retained only as a migration draft. It can be
    // read and replaced, but the release gate below never accepts it.
    return { ...content };
  }
  const validation = validateStructuredLaboratoryResult(template, content);
  if (!validation.ok) {
    throw new ApiError("VALIDATION_ERROR", "O resultado estruturado não corresponde ao painel configurado.", 422, { issues: validation.issues });
  }
  return validation.value as unknown as Record<string, unknown>;
}

function supersedeCriticalNotifications(state: StoreState, resultVersionId: string, actorId: string, correlationId: string): StoreState {
  const affected = state.notifications.filter((notification) => notification.category === "CRITICAL" && notification.entityType === "RESULT_VERSION" && notification.entityId === resultVersionId && notification.state !== "ACKNOWLEDGED" && notification.state !== "SUPERSEDED");
  if (affected.length === 0) return state;
  const affectedIds = new Set(affected.map((notification) => notification.id));
  return {
    ...state,
    notifications: state.notifications.map((notification) => affectedIds.has(notification.id) ? { ...notification, state: "SUPERSEDED" as const, version: notification.version + 1 } : notification),
    auditEvents: [
      ...state.auditEvents,
      ...affected.map((notification) => createAudit("CriticalNotificationSuperseded", actorId, "Notification", notification.id, correlationId, notification.state, "SUPERSEDED", { resultVersionId }))
    ]
  };
}

/**
 * Everyone who received a notification about any version of this result: the requester, the professionals
 * reached by a critical escalation, managers... A correction or an invalidation must reach the same people,
 * not only the requester (auditoria de 10/10/2026). Deactivated accounts are left out.
 */
function priorResultRecipients(state: StoreState, resultId: string, excludeUserId?: string): User[] {
  const versionIds = new Set(resultVersionsForResult(state, resultId).map((version) => version.id));
  const recipientIds = new Set(
    state.notifications
      .filter((notification) => notification.entityType === "RESULT_VERSION" && versionIds.has(notification.entityId))
      .map((notification) => notification.recipientUserId)
  );
  return [...recipientIds]
    .filter((userId) => userId !== excludeUserId)
    .sort()
    .map((userId) => findById(state.users, userId))
    .filter((user): user is User => Boolean(user && user.active !== false));
}

type ResultNoticeTemplate = Omit<Notification, "id" | "createdAt" | "attempts" | "state" | "version" | "recipientUserId" | "dedupeKey">;

/**
 * One in-app notification and one durable delivery intent per recipient, in the same transaction as the
 * clinical change. The dedupe key keeps a repeated command from notifying anyone twice.
 */
function notifyResultRecipients(
  state: StoreState,
  recipients: readonly User[],
  template: ResultNoticeTemplate,
  dedupePrefix: string,
  eventType: string,
  correlationId: string,
  payload: Record<string, unknown>
): StoreState {
  let nextState = state;
  for (const recipient of recipients) {
    const dedupeKey = `${dedupePrefix}:${recipient.id}`;
    const before = nextState.notifications.length;
    nextState = notificationFor(nextState, { ...template, recipientUserId: recipient.id, dedupeKey });
    if (nextState.notifications.length === before) continue;
    const created = nextState.notifications.at(-1)!;
    nextState = { ...nextState, outbox: [...nextState.outbox, createOutbox(eventType, "Notification", created.id, correlationId, { ...payload, notificationId: created.id, recipientUserId: recipient.id })] };
  }
  return nextState;
}

function requireResultMutationPermission(
  actor: User,
  permission: Permission,
  view: ReturnType<typeof helpers.resultView>
): void {
  requirePermission(actor, permission, {
    patientId: view.request.patientId,
    departmentCode: view.service.departmentCode,
    serviceCode: view.service.code
  });

  // A released result belongs to the actor who authored its current version.
  // Service peers may work in the same department, but they must not amend or
  // invalidate one another's clinical record. Managers retain the explicit
  // department-scoped policy path represented by the permission matrix.
  if (isExecutorRole(actor) && view.version.authorId !== actor.id) {
    throw new ApiError("SCOPE_DENIED", "Você não tem acesso a este recurso.", 404);
  }
}

export function createResultService({ store, storage }: ApplicationServiceContext) {
  const service = {
    async createResultDraft(actor: User, itemId: string, input: ResultDraftInput) {
      const scope = "POST:/results/draft";
      return store.transaction(async (originalState) => {
        const currentActor = requireActiveUser(originalState, actor);
        const item = itemFor(originalState, itemId);
        const service = serviceFor(originalState, item.serviceId);
        const request = requestFor(originalState, item.requestId);
        requirePermission(currentActor, "result.draft.create", { departmentCode: service.departmentCode, serviceCode: service.code });
        const idempotent = withIdempotency<ResultDraftCommandResult>(originalState, currentActor.id, scope, input.idempotencyKey, { itemId, input });
        if (idempotent.found) return { state: originalState, result: reprojectCommandRequest(originalState, currentActor, idempotent.existing!) };
        ensureExpectedVersion(item.version, input.expectedVersion);
        if (!["IN_PROGRESS", "AWAITING_REPORT", "RESULT_VOIDED"].includes(item.status)) {
          throw new ApiError("RESULT_RELEASE_BLOCKED", "O item ainda não está pronto para receber um resultado.", 422);
        }
        const narrative = requireText(input.narrative, "narrative", MAX_RESULT_NARRATIVE_LENGTH);
        const itemResults = originalState.results.filter((entry) => entry.itemId === item.id);
        if (itemResults.length > 1) {
          throw new ApiError("INVALID_STATE_TRANSITION", "O item possui mais de uma linhagem de resultado e exige reconciliação.", 409);
        }
        const existingResult = itemResults[0];
        if (existingResult && (
          item.currentResultId !== existingResult.id ||
          item.status !== "RESULT_VOIDED" ||
          existingResult.lifecycleStatus !== "VOIDED"
        )) {
          throw new ApiError("INVALID_STATE_TRANSITION", "Já existe um draft ou resultado para este item.", 409);
        }
        const previousVersion = existingResult ? resultView(originalState, existingResult).version : undefined;
        if (previousVersion && previousVersion.status !== "VOIDED") {
          throw new ApiError("INVALID_STATE_TRANSITION", "Já existe um draft ou resultado para este item.", 409);
        }
        const normalizedContent = normalizedResultContent(service, input.content);
        const versionId = id("result-version");
        const resultId = existingResult?.id ?? id("result");
        const version: ResultVersion = {
          id: versionId,
          resultId,
          sequence: (previousVersion?.sequence ?? 0) + 1,
          status: "DRAFT",
          content: normalizedContent,
          narrative,
          conclusion: input.conclusion?.trim(),
          authorId: currentActor.id,
          createdAt: now(),
          ...(previousVersion ? { supersedesId: previousVersion.id } : {}),
          critical: false,
          needsReReview: false,
          version: 1
        };
        const result: Result = existingResult
          ? { ...existingResult, currentVersionId: version.id, lifecycleStatus: "DRAFT", needsReReview: false, version: existingResult.version + 1 }
          : { id: resultId, itemId, currentVersionId: version.id, lifecycleStatus: "DRAFT", needsReReview: false, version: 1 };
        const updatedItem = {
          ...item,
          currentResultId: result.id,
          // A voided laboratory result re-enters processing. For imaging, the
          // procedure remains performed and the replacement draft is the new
          // report phase, so the item must be awaiting that report before release.
          status: item.status === "RESULT_VOIDED"
            ? item.workflowType === "LABORATORY"
              ? transitionItem(item.status, "IN_PROGRESS", item.workflowType)
              : transitionItem(
                transitionItem(item.status, "IN_PROGRESS", item.workflowType),
                "AWAITING_REPORT",
                item.workflowType
              )
            : item.status,
          version: item.version + 1
        };
        const correlationId = input.correlationId ?? id("corr");
        const nextResults = existingResult
          ? originalState.results.map((entry) => entry.id === result.id ? result : entry)
          : [...originalState.results, result];
        let nextState = nextRequestState({ ...originalState, results: nextResults, resultVersions: [...originalState.resultVersions, version] }, request, [updatedItem]);
        nextState = { ...nextState, auditEvents: [...nextState.auditEvents, createAudit(previousVersion ? "ReplacementResultDraftCreated" : "ResultDraftCreated", currentActor.id, "Result", result.id, correlationId, previousVersion?.status, "DRAFT", { itemId, versionId: version.id })] };
        const response = { result, version, item: updatedItem, request: requestViewForActor(nextState, currentActor, requestFor(nextState, request.id)) };
        return { state: saveIdempotency(nextState, currentActor.id, scope, input.idempotencyKey, response, { itemId, input }), result: response };
      });
    },

    async updateResultDraft(actor: User, resultId: string, input: ResultDraftInput) {
      const scope = "PATCH:/results/draft";
      return store.transaction(async (originalState) => {
        const currentActor = requireActiveUser(originalState, actor);
        const result = resultFor(originalState, resultId);
        const view = resultView(originalState, result);
        requirePermission(currentActor, "result.draft.edit_own", { departmentCode: view.service.departmentCode, serviceCode: view.service.code, ownerId: view.version.authorId });
        const idempotent = withIdempotency<ResultDraftCommandResult>(originalState, currentActor.id, scope, input.idempotencyKey, { resultId, input });
        if (idempotent.found) return { state: originalState, result: reprojectCommandRequest(originalState, currentActor, idempotent.existing!) };
        ensureExpectedVersion(result.version, input.expectedVersion);
        if (view.version.status !== "DRAFT" || result.lifecycleStatus !== "DRAFT") {
          throw new ApiError("INVALID_STATE_TRANSITION", "Somente o draft atual e não liberado pode ser editado.", 409);
        }
        const narrative = requireText(input.narrative, "narrative", MAX_RESULT_NARRATIVE_LENGTH);
        const updatedVersion: ResultVersion = { ...view.version, content: normalizedResultContent(view.service, input.content), narrative, conclusion: input.conclusion?.trim(), version: view.version.version + 1 };
        const updatedResult: Result = { ...result, version: result.version + 1 };
        const correlationId = input.correlationId ?? id("corr");
        let nextState = { ...originalState, results: originalState.results.map((entry) => entry.id === result.id ? updatedResult : entry), resultVersions: originalState.resultVersions.map((entry) => entry.id === view.version.id ? updatedVersion : entry) };
        nextState = { ...nextState, auditEvents: [...nextState.auditEvents, createAudit("ResultDraftUpdated", currentActor.id, "ResultVersion", updatedVersion.id, correlationId, "DRAFT", "DRAFT", { resultId })], outbox: [...nextState.outbox, createOutbox("ResultDraftUpdated", "Result", result.id, correlationId, { versionId: updatedVersion.id })] };
        const response = { result: updatedResult, version: updatedVersion, item: view.item, request: requestViewForActor(nextState, currentActor, requestFor(nextState, view.request.id)) };
        return { state: saveIdempotency(nextState, currentActor.id, scope, input.idempotencyKey, response, { resultId, input }), result: response };
      });
    },

    async releaseResult(actor: User, resultId: string, input: ReleaseInput) {
      const scope = "POST:/results/release";
      return store.transaction(async (originalState) => {
        const currentActor = requireActiveUser(originalState, actor);
        requireIdempotencyKey(input.idempotencyKey);
        const result = resultFor(originalState, resultId);
        const view = resultView(originalState, result);
        requireResultMutationPermission(currentActor, "result.release", view);
        // Re-check the resource boundary before replaying a stored response.
        // A permission or service assignment may have been revoked since the
        // original command was committed.
        const idempotent = withIdempotency<ResultReleaseCommandResult>(originalState, currentActor.id, scope, input.idempotencyKey, { resultId, input });
        if (idempotent.found) return { state: originalState, result: reprojectCommandRequest(originalState, currentActor, idempotent.existing!) };
        ensureExpectedVersion(result.version, input.expectedVersion);
        if (view.version.status !== "DRAFT") throw new ApiError("INVALID_STATE_TRANSITION", "Somente um draft pode ser liberado.", 409);
        const normalizedReleaseContent = normalizedResultContent(view.service, view.version.content, { requireStructured: true });
        const releaseCheckTime = Date.now();
        const blockedAttachments = originalState.attachments.filter((attachment) =>
          attachment.resultVersionId === view.version.id
          && (attachment.uploadStatus !== "FINALIZED" || attachment.scanStatus !== "CLEAN")
          && (
            !attachmentSessionIsExpired(attachment, releaseCheckTime)
            || attachmentUploadClaimIsActive(attachment, releaseCheckTime)
          )
        );
        if (blockedAttachments.length > 0) throw new ApiError("RESULT_RELEASE_BLOCKED", "Finalize ou remova os anexos pendentes antes de liberar o resultado.", 422, { retryable: true });
        if (input.critical && !criticalPolicyIsReady()) {
          throw new ApiError("CRITICAL_POLICY_MISSING", "A política de resultado crítico ainda não foi aprovada/ativada.", 422);
        }
        const expiredAttachments = originalState.attachments.filter((attachment) =>
          attachment.resultVersionId === view.version.id
          && attachmentSessionIsExpired(attachment, releaseCheckTime)
          && !attachmentUploadClaimIsActive(attachment, releaseCheckTime)
        );
        const expiredAttachmentIds = new Set(expiredAttachments.map((attachment) => attachment.id));
        const retainedAttachments = originalState.attachments.filter((attachment) => !expiredAttachmentIds.has(attachment.id));
        const retainedStorageKeys = new Set(retainedAttachments.flatMap(attachmentStorageKeys));
        const expiredStorageKeys = [...new Set(expiredAttachments.flatMap(attachmentStorageKeys))]
          .filter((storageKey) => !retainedStorageKeys.has(storageKey));
        // Storage and state persistence cannot share a commit. Delete first so a storage
        // failure preserves metadata; a later state rollback also preserves only expired,
        // non-finalized metadata, and retrying safely repeats the idempotent object delete.
        try {
          for (const storageKey of expiredStorageKeys) await deleteStoredObject(storage, storageKey);
        } catch {
          throw new ApiError("STORAGE_UNAVAILABLE", "Não foi possível remover os anexos expirados do armazenamento privado.", 503, { retryable: true });
        }
        const releaseState: StoreState = expiredAttachments.length === 0 ? originalState : {
          ...originalState,
          attachments: retainedAttachments,
          auditEvents: [
            ...originalState.auditEvents,
            ...expiredAttachments.map((attachment) => createAudit(
              "AttachmentUploadSessionExpired",
              currentActor.id,
              "Attachment",
              attachment.id,
              input.correlationId ?? id("corr"),
              attachment.uploadStatus,
              "EXPIRED",
              { resultVersionId: view.version.id }
            ))
          ]
        };
        const releasedAt = now();
        const releasedVersion: ResultVersion = { ...view.version, content: normalizedReleaseContent, status: "RELEASED", releasedAt, releasedBy: currentActor.id, critical: input.critical === true, version: view.version.version + 1 };
        const releasedResult: Result = { ...result, lifecycleStatus: "RELEASED", currentVersionId: releasedVersion.id, version: result.version + 1 };
        const releasedItem = { ...view.item, status: transitionItem(view.item.status, "RESULT_AVAILABLE", view.item.workflowType), releasedAt, version: view.item.version + 1 };
        const correlationId = input.correlationId ?? id("corr");
        let nextState = nextRequestState({ ...releaseState, results: releaseState.results.map((entry) => entry.id === result.id ? releasedResult : entry), resultVersions: releaseState.resultVersions.map((entry) => entry.id === view.version.id ? releasedVersion : entry) }, view.request, [releasedItem]);
        const requester = findOrThrow(findById(releaseState.users, view.request.requesterId));
        // A version that supersedes another is a correction: the requester, and everyone who saw the earlier
        // version, learn that the result they hold has changed (D-055).
        const corrected = releasedVersion.supersedesId !== undefined;
        const releaseTitle = releasedVersion.critical
          ? (corrected ? "Resultado crítico retificado requer confirmação" : "Resultado crítico requer confirmação")
          : (corrected ? "Resultado retificado" : "Resultado disponível");
        const releaseBody = `${view.patient.displayName} · ${view.service.name} · versão ${releasedVersion.sequence} ${corrected ? "retificada e liberada" : "liberada"}.`;
        const notification: Omit<Notification, "id" | "createdAt" | "attempts" | "state" | "version"> = { category: releasedVersion.critical ? "CRITICAL" : "ACTIONABLE", priority: releasedVersion.critical ? "URGENT" : "HIGH", recipientUserId: requester.id, entityType: "RESULT_VERSION", entityId: releasedVersion.id, deepLink: `/results/${result.id}`, title: releaseTitle, body: releaseBody, dedupeKey: `release:${releasedVersion.id}:${requester.id}` };
        nextState = notificationFor(nextState, notification);
        const notificationId = nextState.notifications.find((entry) => entry.dedupeKey === notification.dedupeKey && entry.recipientUserId === notification.recipientUserId)?.id;
        nextState = withCriticalWhatsAppAlert(nextState, notificationId, view.request, correlationId);
        if (corrected) {
          nextState = notifyResultRecipients(nextState, priorResultRecipients(nextState, result.id, requester.id), {
            category: "ACTIONABLE", priority: "HIGH", entityType: "RESULT_VERSION", entityId: releasedVersion.id, deepLink: `/results/${result.id}`, title: "Resultado retificado", body: releaseBody
          }, `release:${releasedVersion.id}`, "ResultReleased", correlationId, { resultId: result.id, versionId: releasedVersion.id, supersedesId: releasedVersion.supersedesId, critical: releasedVersion.critical });
        }
        nextState = { ...nextState, auditEvents: [...nextState.auditEvents, createAudit("ResultReleased", currentActor.id, "ResultVersion", releasedVersion.id, correlationId, "DRAFT", "RELEASED", { resultId, critical: releasedVersion.critical }), createAudit("DiagnosticItemResultAvailable", currentActor.id, "DiagnosticRequestItem", releasedItem.id, correlationId, view.item.status, releasedItem.status, {})], outbox: [...nextState.outbox, createOutbox("ResultReleased", "Result", result.id, correlationId, { versionId: releasedVersion.id, critical: releasedVersion.critical, ...(notificationId ? { notificationId } : {}) })] };
        const response = { result: releasedResult, version: releasedVersion, item: releasedItem, request: requestViewForActor(nextState, currentActor, requestFor(nextState, view.request.id)) };
        return { state: saveIdempotency(nextState, currentActor.id, scope, input.idempotencyKey, response, { resultId, input }), result: response };
      });
    },

    async amendResult(actor: User, resultId: string, input: AmendInput) {
      const scope = "POST:/results/amend";
      return store.transaction(async (originalState) => {
        const currentActor = requireActiveUser(originalState, actor);
        requireIdempotencyKey(input.idempotencyKey);
        const result = resultFor(originalState, resultId);
        const view = resultView(originalState, result);
        requireResultMutationPermission(currentActor, "result.amend", view);
        const idempotent = withIdempotency<AmendCommandResult>(originalState, currentActor.id, scope, input.idempotencyKey, { resultId, input });
        if (idempotent.found) return { state: originalState, result: reprojectCommandRequest(originalState, currentActor, idempotent.existing!) };
        ensureExpectedVersion(result.version, input.expectedVersion);
        if (!["RELEASED", "REVIEWED", "COMPLETED"].includes(view.version.status) || !["RESULT_AVAILABLE", "REVIEWED", "COMPLETED"].includes(view.item.status)) throw new ApiError("INVALID_STATE_TRANSITION", "Somente um resultado liberado pode ser emendado.", 409);
        const reason = requireText(input.reason, "reason", 500);
        const narrative = requireText(input.narrative, "narrative", MAX_RESULT_NARRATIVE_LENGTH);
        const supersededVersion = { ...view.version, status: "SUPERSEDED" as const, version: view.version.version + 1 };
        const nextVersion: ResultVersion = { id: id("result-version"), resultId: result.id, sequence: view.version.sequence + 1, status: "DRAFT", content: normalizedResultContent(view.service, input.content), narrative, conclusion: input.conclusion?.trim(), authorId: currentActor.id, createdAt: now(), amendmentReason: reason, supersedesId: view.version.id, critical: input.critical === true, needsReReview: true, version: 1 };
        const amendedResult = { ...result, currentVersionId: nextVersion.id, lifecycleStatus: "DRAFT" as const, needsReReview: true, version: result.version + 1 };
        const amendedItem = { ...view.item, status: transitionItem(view.item.status, "RESULT_VOIDED", view.item.workflowType), version: view.item.version + 1 };
        const correlationId = input.correlationId ?? id("corr");
        let nextState = supersedeCriticalNotifications(nextRequestState({ ...originalState, results: originalState.results.map((entry) => entry.id === result.id ? amendedResult : entry), resultVersions: [...originalState.resultVersions.map((entry) => entry.id === view.version.id ? supersededVersion : entry), nextVersion] }, view.request, [amendedItem]), view.version.id, currentActor.id, correlationId);
        // The superseded version is no longer valid and the corrected one is not released yet: everyone who
        // received the earlier version must stop acting on it now, not when the correction is released (D-055).
        const requester = findOrThrow(findById(originalState.users, view.request.requesterId));
        nextState = notifyResultRecipients(nextState, [requester, ...priorResultRecipients(nextState, result.id, requester.id)], {
          category: "ACTIONABLE", priority: view.version.critical ? "URGENT" : "HIGH", entityType: "RESULT_VERSION", entityId: supersededVersion.id, deepLink: `/results/${result.id}`,
          title: "Resultado em retificação", body: `${view.patient.displayName} · ${view.service.name} · versão ${supersededVersion.sequence} substituída: aguarde a nova liberação antes de agir.`
        }, `amend:${supersededVersion.id}`, "ResultAmended", correlationId, { resultId: result.id, versionId: nextVersion.id, supersedesId: supersededVersion.id });
        nextState = { ...nextState, auditEvents: [...nextState.auditEvents, createAudit("ResultAmended", currentActor.id, "ResultVersion", nextVersion.id, correlationId, view.version.status, "DRAFT", { resultId, supersedesId: view.version.id, reason })], outbox: [...nextState.outbox, createOutbox("ResultAmended", "Result", result.id, correlationId, { versionId: nextVersion.id, supersedesId: view.version.id })] };
        const response = { result: amendedResult, version: nextVersion, previousVersion: supersededVersion, item: amendedItem, request: requestViewForActor(nextState, currentActor, requestFor(nextState, view.request.id)) };
        return { state: saveIdempotency(nextState, currentActor.id, scope, input.idempotencyKey, response, { resultId, input }), result: response };
      });
    },

    async voidResult(actor: User, resultId: string, input: VoidInput) {
      const scope = "POST:/results/void";
      return store.transaction(async (originalState) => {
        const currentActor = requireActiveUser(originalState, actor);
        requireIdempotencyKey(input.idempotencyKey);
        const result = resultFor(originalState, resultId);
        const view = resultView(originalState, result);
        requireResultMutationPermission(currentActor, "result.void", view);
        const idempotent = withIdempotency<VoidCommandResult>(originalState, currentActor.id, scope, input.idempotencyKey, { resultId, input });
        if (idempotent.found) return { state: originalState, result: reprojectCommandRequest(originalState, currentActor, idempotent.existing!) };
        ensureExpectedVersion(result.version, input.expectedVersion);
        if (!["RELEASED", "REVIEWED"].includes(view.version.status)) throw new ApiError("INVALID_STATE_TRANSITION", "Somente uma versão liberada pode ser invalidada.", 409);
        const reason = requireText(input.reason, "reason", 500);
        const voidedVersion = { ...view.version, status: "VOIDED" as const, needsReReview: false, version: view.version.version + 1 };
        const voidedResult = { ...result, lifecycleStatus: "VOIDED" as const, needsReReview: false, version: result.version + 1 };
        const updatedItem = { ...view.item, status: view.item.status === "RESULT_VOIDED" ? view.item.status : transitionItem(view.item.status, "RESULT_VOIDED", view.item.workflowType), version: view.item.version + 1 };
        const requester = findOrThrow(findById(originalState.users, view.request.requesterId));
        const correlationId = input.correlationId ?? id("corr");
        let nextState = supersedeCriticalNotifications(nextRequestState({ ...originalState, results: originalState.results.map((entry) => entry.id === result.id ? voidedResult : entry), resultVersions: originalState.resultVersions.map((entry) => entry.id === view.version.id ? voidedVersion : entry) }, view.request, [updatedItem]), view.version.id, currentActor.id, correlationId);
        const notification: Omit<Notification, "id" | "createdAt" | "attempts" | "state" | "version"> = { category: "ACTIONABLE", priority: "HIGH", recipientUserId: requester.id, entityType: "RESULT_VERSION", entityId: voidedVersion.id, deepLink: `/results/${result.id}`, title: "Resultado invalidado", body: `${view.patient.displayName} · ${view.service.name}: um novo resultado é necessário.`, dedupeKey: `void:${voidedVersion.id}:${requester.id}` };
        nextState = notificationFor(nextState, notification);
        const notificationId = nextState.notifications.find((entry) => entry.dedupeKey === notification.dedupeKey && entry.recipientUserId === notification.recipientUserId)?.id;
        nextState = notifyResultRecipients(nextState, priorResultRecipients(nextState, result.id, requester.id), {
          category: "ACTIONABLE", priority: "HIGH", entityType: "RESULT_VERSION", entityId: voidedVersion.id, deepLink: `/results/${result.id}`, title: notification.title, body: notification.body
        }, `void:${voidedVersion.id}`, "ResultVoided", correlationId, { resultId: result.id, versionId: voidedVersion.id });
        nextState = { ...nextState, auditEvents: [...nextState.auditEvents, createAudit("ResultVoided", currentActor.id, "ResultVersion", voidedVersion.id, correlationId, view.version.status, "VOIDED", { resultId, reason })], outbox: [...nextState.outbox, createOutbox("ResultVoided", "Result", result.id, correlationId, { versionId: voidedVersion.id, reason, ...(notificationId ? { notificationId } : {}) })] };
        const response = { result: voidedResult, version: voidedVersion, item: updatedItem, request: requestViewForActor(nextState, currentActor, requestFor(nextState, view.request.id)), replacementRequired: true };
        return { state: saveIdempotency(nextState, currentActor.id, scope, input.idempotencyKey, response, { resultId, input }), result: response };
      });
    },

    async viewResult(actor: User, versionId: string, input: CommandMeta = {}) {
      return store.transaction(async (originalState) => {
        const currentActor = requireActiveUser(originalState, actor);
        requireIdempotencyKey(input.idempotencyKey);
        const version = findOrThrow(findById(originalState.resultVersions, versionId));
        const result = resultFor(originalState, version.resultId);
        const view = resultView(originalState, result);
        const resource = { patientId: view.request.patientId, departmentCode: view.service.departmentCode, serviceCode: view.service.code };
        requirePermission(currentActor, "result.view", resource);
        requirePermission(currentActor, "result.view.record", resource);
        ensureExpectedVersion(view.item.version, input.expectedVersion);
        if (version.status === "DRAFT" || version.status === "VOIDED") throw new ApiError("NOT_FOUND", "Resultado não disponível.", 404);
        const scope = `POST:/results/${result.id}/view`;
        const idempotent = withIdempotency<{ versionId: string; resultId: string; viewedAt: string }>(originalState, currentActor.id, scope, input.idempotencyKey, { versionId, input });
        if (idempotent.found) return { state: originalState, result: idempotent.existing! };
        const correlationId = input.correlationId ?? id("corr");
        const audit = createAudit("ResultViewed", currentActor.id, "ResultVersion", version.id, correlationId, undefined, undefined, { resultId: result.id });
        const response = { versionId: version.id, resultId: result.id, viewedAt: audit.occurredAt };
        const nextState = { ...originalState, auditEvents: [...originalState.auditEvents, audit] };
        return { state: saveIdempotency(nextState, currentActor.id, scope, input.idempotencyKey, response, { versionId, input }), result: response };
      });
    },

    async reviewResult(actor: User, resultId: string, input: ReviewInput) {
      const scope = "POST:/results/review";
      return store.transaction(async (originalState, audit) => {
        const currentActor = requireActiveUser(originalState, actor);
        requireIdempotencyKey(input.idempotencyKey);
        const result = resultFor(originalState, resultId);
        const view = resultView(originalState, result);
        requirePermission(currentActor, "result.review", { patientId: view.request.patientId, departmentCode: view.service.departmentCode, serviceCode: view.service.code });
        if (view.version.critical) {
          const criticalNotification = originalState.notifications.find((notification) => notification.category === "CRITICAL" && notification.entityType === "RESULT_VERSION" && notification.entityId === view.version.id && notification.recipientUserId === currentActor.id);
          if (!criticalNotification || criticalNotification.state !== "ACKNOWLEDGED" || criticalNotification.acknowledgedBy !== currentActor.id) {
            throw new ApiError("CRITICAL_ACK_REQUIRED", "Confirme a notificação crítica antes de revisar o resultado.", 409, { retryable: false });
          }
        }
        const idempotent = withIdempotency<ReviewCommandResult>(originalState, currentActor.id, scope, input.idempotencyKey, { resultId, input });
        if (idempotent.found) return { state: originalState, result: reprojectCommandRequest(originalState, currentActor, idempotent.existing!) };
        if (view.version.id !== input.versionId || view.item.status !== "RESULT_AVAILABLE") throw new ApiError("REVIEW_STALE", "O resultado mudou. Abra a versão atual antes de revisar.", 409);
        ensureExpectedVersion(view.item.version, input.expectedVersion);
        const wasViewed = audit
          ? await audit.hasAuditEvent({ eventType: "ResultViewed", entityType: "ResultVersion", entityId: input.versionId, actorId: currentActor.id })
          : originalState.auditEvents.some((event) => event.eventType === "ResultViewed" && event.entityId === input.versionId && event.actorId === currentActor.id);
        if (!wasViewed) throw new ApiError("VALIDATION_ERROR", "Abra o resultado antes de marcar como revisado.", 400);
        const reviewedAt = now();
        const reviewedItem = { ...view.item, status: transitionItem(view.item.status, "REVIEWED", view.item.workflowType), reviewedAt, version: view.item.version + 1 };
        const reviewedResult = { ...result, needsReReview: false, version: result.version + 1 };
        const reviewedVersion = { ...view.version, needsReReview: false, version: view.version.version + 1 };
        const correlationId = input.correlationId ?? id("corr");
        let nextState = nextRequestState({ ...originalState, results: originalState.results.map((entry) => entry.id === result.id ? reviewedResult : entry), resultVersions: originalState.resultVersions.map((entry) => entry.id === view.version.id ? reviewedVersion : entry) }, view.request, [reviewedItem]);
        nextState = { ...nextState, auditEvents: [...nextState.auditEvents, createAudit("ResultReviewed", currentActor.id, "ResultVersion", view.version.id, correlationId, "RESULT_AVAILABLE", "REVIEWED", { resultId })] };
        const response = { result: reviewedResult, version: reviewedVersion, item: reviewedItem, request: requestViewForActor(nextState, currentActor, requestFor(nextState, view.request.id)) };
        return { state: saveIdempotency(nextState, currentActor.id, scope, input.idempotencyKey, response, { resultId, input }), result: response };
      });
    },

    // Audited reads answer from the current snapshot and record the access beside the write queue (D-061): opening
    // a result must not wait behind, nor delay, the clinical writes.
    async getResult(actor: User, resultId: string): Promise<ResultView> {
      const state = await store.readState();
      const currentActor = requireActiveUser(state, actor);
      const result = resultFor(state, resultId);
      const view = resultView(state, result);
      const eventType = requireCurrentResultRead(currentActor, view);
      const response = { ...view, request: requestViewForActor(state, currentActor, view.request) };
      await store.appendReadAudit(createAudit(eventType, currentActor.id, "ResultVersion", view.version.id, id("corr"), undefined, undefined, { resultId: result.id }));
      return response;
    },

    async getReport(actor: User, reportId: string): Promise<ReportView> {
      const state = await store.readState();
      const currentActor = requireActiveUser(state, actor);
      const result = resultFor(state, reportId);
      const view = resultView(state, result);
      requireCurrentResultRead(currentActor, view);
      requirePermission(currentActor, "attachment.view", { patientId: view.request.patientId, departmentCode: view.service.departmentCode, serviceCode: view.service.code });
      const attachments = state.attachments
        .filter((attachment) => attachment.resultVersionId === view.version.id && attachment.scanStatus === "CLEAN" && attachment.uploadStatus === "FINALIZED")
        .map(publicAttachment);
      const response = { ...view, request: requestViewForActor(state, currentActor, view.request), attachments };
      await store.appendReadAudit(createAudit("ReportRead", currentActor.id, "ResultVersion", view.version.id, id("corr"), undefined, undefined, { resultId: result.id, attachmentCount: attachments.length }));
      return response;
    },

    async listResultVersions(actor: User, resultId: string): Promise<ResultVersion[]> {
      const state = await store.readState();
      const currentActor = requireActiveUser(state, actor);
      const result = resultFor(state, resultId);
      const view = resultView(state, result);
      requirePermission(currentActor, "result.history.view", { patientId: view.request.patientId, departmentCode: view.service.departmentCode, serviceCode: view.service.code });
      const versions = visibleResultVersions(state, result.id);
      if (versions.length === 0) throw new ApiError("NOT_FOUND", "Resultado não disponível.", 404);
      await store.appendReadAudit(createAudit("ResultHistoryRead", currentActor.id, "Result", result.id, id("corr"), undefined, undefined, { versionCount: versions.length }));
      return versions;
    },

  };
  return service;
}
