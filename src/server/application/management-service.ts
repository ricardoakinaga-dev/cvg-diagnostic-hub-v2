import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ITEM_STATES, PRIORITIES, ROLES } from "@cvg/contracts";
import type { ItemState, ManagedSession, Permission, Priority, RoleCode, WorkflowType } from "@cvg/contracts";
import type { Admission, Attachment, AuditEvent, DiagnosticItem, DiagnosticRequest, DiagnosticService, Notification, Procedure, ProcedureSchedule, ReasonCode, Result, ResultVersion, Sample, StateStore, StoreState, User } from "../domain/models";
import type { CommandMeta, NotificationAcknowledgeInput, CreateRequestInput, ReceiveSampleInput, RecollectionInput, ResultDraftInput, ReleaseInput, ReviewInput, AmendInput, ScheduleInput, CancelInput, RejectInput, VoidInput, AttachmentUploadInput, DiagnosticServiceCreateInput, DiagnosticServicePatchInput, CatalogImportInput, CatalogImportResult, ReasonCodeCreateInput, ReasonCodePatchInput, UserRoleUpdateInput, UserOnCallUpdateInput, ManagedUserCreateInput, ManagedUserDeactivateInput, SessionRevokeInput, ManagedUser, ManagementOverview, DashboardIndicatorKey, DashboardIndicator, DashboardWindow, DashboardView, RequestListFilters, SearchResultType, SearchFilters, SearchResult, TimelineFilters, TimelineResult, RequestView, ResultView, ItemView, SampleCommandResult, ResultDraftCommandResult, ResultReleaseCommandResult, ReviewCommandResult, ItemCommandResult, ProcedureScheduleCommandResult, ProcedureRescheduleCommandResult, ProcedureExecutionCommandResult, AmendCommandResult, VoidCommandResult, PublicAttachment, AttachmentSessionResult, AttachmentFinalizationResult, PatientDiagnosticsResult, ReportView } from "./service-types";
import { planCatalogImport, parseCatalogSheet, parseAnalyteSheet } from "./catalog-import";
import { canAccessResource, managerCanAccessDepartment, managerDepartmentCodes } from "../security/authorization";
import { ApiError } from "../http/envelope";
import { hashPassword } from "../security/password";
import { assertPasswordPolicy } from "../security/password-policy";
import { createPasswordResetGrant, passwordResetUrl, withoutPendingReset } from "../security/password-reset";
import type { ApplicationServiceContext } from "./service-context";
import * as helpers from "./service-common";
import { assignedServiceAccess, reconcileCatalogServiceAccess } from "./executor-service-access";
import { findById } from "../domain/state-index";
import { activeSystemGroupId, assertAdministrativeAccessRetained, requireAnyPermission } from "../security/access-group-policy";
import { requireActiveDepartment, reconcileDepartmentMembership } from "./department-registry";
import { recordExamDefinition } from "./exam-definition";
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
  managedSession,
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
  validateServiceResultSchema,
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

function isAdministrativeRole(role: RoleCode): boolean {
  return role === "ADMIN" || role === "SUPERADMIN";
}

function catalogServiceAccess(state: StoreState, previous: DiagnosticService | undefined, service: DiagnosticService, actorId: string, correlationId: string) {
  const { users, changes } = reconcileCatalogServiceAccess(state, previous, service);
  const affectedIds = new Set(changes.map((change) => change.after.id));
  const timestamp = now();
  const sessions = state.sessions.map((session) => affectedIds.has(session.userId) && !session.revokedAt ? { ...session, revokedAt: timestamp, version: session.version + 1 } : session);
  const auditEvents = changes.map(({ before, after, added, removed }) => createAudit("UserServiceAccessUpdated", actorId, "User", after.id, correlationId, before.serviceCodes?.join(",") ?? "", after.serviceCodes?.join(",") ?? "", {
    action: "CATALOG_SERVICE_ACCESS", serviceId: service.id, serviceCode: service.code, departmentCode: after.departmentCode,
    policyMode: after.serviceAccessPolicy?.mode ?? "SELECTED", includeFuture: after.serviceAccessPolicy?.includeFuture ?? false,
    addedServiceCodes: added.join(","), removedServiceCodes: removed.join(","), reason: removed.length ? "SERVICE_DEPARTMENT_TRANSFER" : "EXPLICIT_FUTURE_POLICY"
  }));
  return { users, sessions, auditEvents, granted: changes.filter((change) => change.added.length).length, affectedUserIds: JSON.stringify([...affectedIds]) };
}

export function createManagementService({ store, storage }: ApplicationServiceContext) {
  const service = {
    async listManagedUsers(actor: User): Promise<ManagedUser[]> {
      const state = await store.readState();
      const currentActor = requireActiveUser(state, actor);
      requireAnyPermission(currentActor, ["user_role.manage", "user.view"]);
      return state.users
        .filter((user) => canManageUserTarget(currentActor, user.role, user.departmentCode))
        .slice()
        .sort((left, right) => left.displayName.localeCompare(right.displayName, "pt-BR"))
        .map(managedUser);
    },

    async listManagedSessions(actor: User): Promise<ManagedSession[]> {
      const state = await store.readState();
      const currentActor = requireActiveUser(state, actor);
      requireAnyPermission(currentActor, ["user_role.manage", "user.view"]);
      if (!isAdministrativeRole(currentActor.role)) throw new ApiError("SCOPE_DENIED", "Você não tem acesso às sessões do sistema.", 404);
      return state.sessions
        .map((session) => ({ session, user: findById(state.users, session.userId) }))
        .filter((entry): entry is { session: typeof state.sessions[number]; user: User } => Boolean(entry.user && canManageUserTarget(currentActor, entry.user.role, entry.user.departmentCode)))
        .sort((left, right) => right.session.createdAt.localeCompare(left.session.createdAt))
        .map(({ session, user }) => managedSession(session, user, currentActor.sessionId));
    },

    async revokeManagedSession(actor: User, sessionId: string, input: SessionRevokeInput): Promise<ManagedSession> {
      const scope = "POST:/sessions/revoke";
      return store.transaction(async (originalState) => {
        const currentActor = requireActiveUser(originalState, actor);
        requireIdempotencyKey(input.idempotencyKey);
        requireAnyPermission(currentActor, ["user_role.manage", "user.update"]);
        if (!isAdministrativeRole(currentActor.role)) throw new ApiError("SCOPE_DENIED", "Você não tem acesso às sessões do sistema.", 404);
        const targetSession = findOrThrow(findById(originalState.sessions, sessionId));
        const targetUser = findOrThrow(findById(originalState.users, targetSession.userId));
        if (!canManageUserTarget(currentActor, targetUser.role, targetUser.departmentCode)) throw new ApiError("SCOPE_DENIED", "Você não tem acesso a esta sessão.", 404);
        if (targetUser.role === "SUPERADMIN") requireRecentReauthentication(currentActor);
        const idempotent = withIdempotency<ManagedSession>(originalState, currentActor.id, scope, input.idempotencyKey, { sessionId, input });
        if (idempotent.found) return { state: originalState, result: idempotent.existing! };
        if (targetSession.id === currentActor.sessionId) throw new ApiError("VALIDATION_ERROR", "A sessão atual deve ser encerrada pelo fluxo de logout.", 400);
        if (targetSession.revokedAt) throw new ApiError("SESSION_ALREADY_REVOKED", "A sessão já foi revogada.", 409);
        const revokedAt = now();
        const updatedSession = { ...targetSession, revokedAt, version: targetSession.version + 1 };
        const correlationId = input.correlationId ?? id("corr");
        const nextState = {
          ...originalState,
          sessions: originalState.sessions.map((session) => session.id === targetSession.id ? updatedSession : session),
          auditEvents: [...originalState.auditEvents, createAudit("SessionRevoked", currentActor.id, "Session", targetSession.id, correlationId, "ACTIVE", "REVOKED", { targetUserId: targetUser.id, action: "REVOKE_SESSION", departmentCode: targetUser.departmentCode })]
        };
        const result = managedSession(updatedSession, targetUser, currentActor.sessionId);
        return { state: saveIdempotency(nextState, currentActor.id, scope, input.idempotencyKey, result, { sessionId, input }), result };
      });
    },

    async updateUserRole(actor: User, userId: string, input: UserRoleUpdateInput): Promise<ManagedUser> {
      const scope = "POST:/users/roles";
      return store.transaction(async (originalState) => {
        const currentActor = requireActiveUser(originalState, actor);
        requireIdempotencyKey(input.idempotencyKey);
        requireAnyPermission(currentActor, ["user_role.manage", "user.update"]);
        if (input.expectedVersion === undefined) throw new ApiError("VALIDATION_ERROR", "expectedVersion é obrigatório para alterar uma role.", 400);
        if (currentActor.id === userId) throw new ApiError("VALIDATION_ERROR", "A própria sessão não pode alterar seu role.", 400);
        if (!ROLES.includes(input.role)) throw new ApiError("VALIDATION_ERROR", "O role informado é inválido.", 400);
        const departmentCode = requireText(input.departmentCode, "departmentCode", 60).toUpperCase();
        if (!/^[A-Z0-9_-]{1,60}$/.test(departmentCode)) throw new ApiError("VALIDATION_ERROR", "O departamento informado é inválido.", 400);
        const target = findOrThrow(findById(originalState.users, userId));
        if (!canManageUserTarget(currentActor, target.role, target.departmentCode) || !canManageUserTarget(currentActor, input.role, departmentCode)) {
          throw new ApiError("SCOPE_DENIED", "Você não tem acesso a este colaborador.", 404);
        }
        const adminAccessChanged = (target.role === "ADMIN" || input.role === "ADMIN")
          && (target.role !== input.role || target.active !== (input.active ?? target.active));
        if (adminAccessChanged || target.role === "SUPERADMIN" || input.role === "SUPERADMIN") requireRecentReauthentication(currentActor);
        const idempotent = withIdempotency<ManagedUser>(originalState, currentActor.id, scope, input.idempotencyKey, { userId, input });
        if (idempotent.found) return { state: originalState, result: idempotent.existing! };
        ensureExpectedVersion(target.version, input.expectedVersion);
        const email = input.email === undefined ? target.email : normalizedEmail(input.email);
        const displayName = input.displayName === undefined ? target.displayName : requireText(input.displayName, "displayName", 160);
        if (originalState.users.some((user) => user.id !== target.id && user.email.toLowerCase() === email)) throw new ApiError("CONFLICT", "Já existe um colaborador com este e-mail.", 409);
        const managedDepartmentCodes = input.role === "MANAGER"
          ? input.managedDepartmentCodes === undefined ? target.managedDepartmentCodes : normalizedManagedDepartments(input.managedDepartmentCodes)
          : undefined;
        if (input.role !== "MANAGER" && input.managedDepartmentCodes?.length) throw new ApiError("VALIDATION_ERROR", "Somente MANAGER pode ter setores delegados.", 400);
        const nextActive = input.active ?? target.active;
        if (!nextActive && target.active) requireAnyPermission(currentActor, ["user_role.manage", "user.deactivate"]);
        if (departmentCode !== target.departmentCode || (!target.active && nextActive)) requireActiveDepartment(originalState, departmentCode);
        for (const code of managedDepartmentCodes ?? []) if (!target.managedDepartmentCodes?.includes(code)) requireActiveDepartment(originalState, code);
        const oldGroup = originalState.accessGroups.find((group) => group.id === target.accessGroupId);
        const accessGroupId = input.role !== target.role && (!target.accessGroupId || oldGroup?.systemRole === target.role) ? activeSystemGroupId(originalState, input.role) : target.accessGroupId;
        const access = assignedServiceAccess(originalState, input.role, departmentCode, input.serviceCodes, input.serviceAccessPolicy, target);
        const pending = withoutPendingReset(target);
        const updated: User = { ...pending.user, email, displayName, role: input.role, accessGroupId, departmentCode, managedDepartmentCodes, ...access, active: nextActive, ...(target.onCall && !nextActive ? { onCall: false } : {}), version: target.version + 1 };
        const correlationId = input.correlationId ?? id("corr");
        const departments = reconcileDepartmentMembership(originalState, updated, now());
        const affectedDepartmentIds = departments.filter((department, index) => department !== originalState.departments[index]).map((department) => department.id);
        const nextState = {
          ...originalState,
          departments,
          users: originalState.users.map((user) => user.id === target.id ? updated : user),
          sessions: revokeUserSessions(originalState, target.id),
          auditEvents: [...originalState.auditEvents, createAudit("UserRoleUpdated", currentActor.id, "User", target.id, correlationId, `${target.role}:${target.departmentCode}:${target.active}`, `${updated.role}:${updated.departmentCode}:${updated.active}`, { action: "UPDATE_USER_ACCESS", affectedDepartmentIds: JSON.stringify(affectedDepartmentIds), identityChanged: email !== target.email || displayName !== target.displayName, accessGroupId: updated.accessGroupId ?? "", previousAccessGroupId: target.accessGroupId ?? "", departmentCode: updated.departmentCode, previousManagedDepartmentCodes: target.managedDepartmentCodes?.join(",") ?? "", managedDepartmentCodes: managedDepartmentCodes?.join(",") ?? "", previousServiceCodes: target.serviceCodes?.join(",") ?? "", serviceCodes: access.serviceCodes?.join(",") ?? "", previousServiceAccessPolicy: JSON.stringify(target.serviceAccessPolicy ?? null), serviceAccessPolicy: JSON.stringify(access.serviceAccessPolicy ?? null), ...(pending.revoked ? { resetLinkRevoked: true } : {}) })]
        };
        assertAdministrativeAccessRetained(originalState, nextState);
        const result = managedUser(updated);
        return { state: saveIdempotency(nextState, currentActor.id, scope, input.idempotencyKey, result, { userId, input }), result };
      });
    },

    /** PROD-402: the ON_CALL rule of the critical-result policy escalates to whoever is marked here. */
    async updateUserOnCall(actor: User, userId: string, input: UserOnCallUpdateInput): Promise<ManagedUser> {
      const scope = "PUT:/users/on-call";
      return store.transaction(async (originalState) => {
        const currentActor = requireActiveUser(originalState, actor);
        requireIdempotencyKey(input.idempotencyKey);
        requireAnyPermission(currentActor, ["user_role.manage", "user.update"]);
        if (input.expectedVersion === undefined) throw new ApiError("VALIDATION_ERROR", "expectedVersion é obrigatório para alterar o plantão.", 400);
        const target = findOrThrow(findById(originalState.users, userId));
        if (!canManageUserTarget(currentActor, target.role, target.departmentCode)) throw new ApiError("SCOPE_DENIED", "Você não tem acesso a este colaborador.", 404);
        if (target.role === "SUPERADMIN") requireRecentReauthentication(currentActor);
        const idempotent = withIdempotency<ManagedUser>(originalState, currentActor.id, scope, input.idempotencyKey, { userId, input });
        if (idempotent.found) return { state: originalState, result: idempotent.existing! };
        ensureExpectedVersion(target.version, input.expectedVersion);
        if (input.onCall && !target.active) throw new ApiError("VALIDATION_ERROR", "Um acesso desativado não pode entrar no plantão.", 400);
        const previous = target.onCall === true;
        const updated: User = { ...target, onCall: input.onCall, version: target.version + 1 };
        const correlationId = input.correlationId ?? id("corr");
        const nextState = {
          ...originalState,
          users: originalState.users.map((user) => user.id === target.id ? updated : user),
          auditEvents: [...originalState.auditEvents, createAudit("UserOnCallUpdated", currentActor.id, "User", target.id, correlationId, previous ? "ON_CALL" : "OFF_CALL", input.onCall ? "ON_CALL" : "OFF_CALL", { action: "UPDATE_USER_ON_CALL", departmentCode: target.departmentCode, ...(input.reason ? { reason: requireText(input.reason, "reason", 500) } : {}) })]
        };
        const result = managedUser(updated);
        return { state: saveIdempotency(nextState, currentActor.id, scope, input.idempotencyKey, result, { userId, input }), result };
      });
    },

    async createManagedUser(actor: User, input: ManagedUserCreateInput): Promise<ManagedUser & { initialPassword?: string }> {
      const scope = "POST:/users";
      return store.transaction(async (originalState) => {
        const currentActor = requireActiveUser(originalState, actor);
        requireIdempotencyKey(input.idempotencyKey);
        requireAnyPermission(currentActor, ["user_role.manage", "user.create"]);
        if (!ROLES.includes(input.role)) throw new ApiError("VALIDATION_ERROR", "O role informado é inválido.", 400);
        const departmentCode = requireText(input.departmentCode ?? currentActor.departmentCode, "departmentCode", 60).toUpperCase();
        if (!/^[A-Z0-9_-]{1,60}$/.test(departmentCode)) throw new ApiError("VALIDATION_ERROR", "O departamento informado é inválido.", 400);
        if (!canManageUserTarget(currentActor, input.role, departmentCode)) throw new ApiError("SCOPE_DENIED", "Você não pode provisionar este tipo de colaborador neste setor.", 404);
        if (isAdministrativeRole(input.role)) requireRecentReauthentication(currentActor);
        const idempotent = withIdempotency<ManagedUser>(originalState, currentActor.id, scope, input.idempotencyKey, { input });
        if (idempotent.found) return { state: originalState, result: idempotent.existing! };
        requireActiveDepartment(originalState, departmentCode);
        const email = normalizedEmail(input.email);
        if (originalState.users.some((user) => user.email.toLowerCase() === email)) throw new ApiError("CONFLICT", "Já existe um colaborador com este e-mail.", 409);
        const displayName = requireText(input.displayName, "displayName", 160);
        // An explicit password is never stored (credentials are server generated), but it must still meet the policy.
        if (input.password !== undefined) assertPasswordPolicy(input.password, { email, displayName });
        // Retain confidential fingerprints for legacy callers, but every new credential is server generated.
        const password = `Cvg1-${randomBytes(24).toString("base64url")}`;
        const timezone = validatedTimezone(input.timezone ?? process.env.APP_TIMEZONE ?? "America/Sao_Paulo");
        const managedDepartmentCodes = input.role === "MANAGER" ? normalizedManagedDepartments(input.managedDepartmentCodes) : undefined;
        if (input.role !== "MANAGER" && input.managedDepartmentCodes?.length) throw new ApiError("VALIDATION_ERROR", "Somente MANAGER pode ter setores delegados.", 400);
        for (const code of managedDepartmentCodes ?? []) requireActiveDepartment(originalState, code);
        const user: User = {
          id: id("user"),
          email,
          displayName,
          role: input.role,
          accessGroupId: activeSystemGroupId(originalState, input.role),
          departmentCode,
          passwordHash: hashPassword(password),
          mustChangePassword: true,
          timezone,
          managedDepartmentCodes,
          ...assignedServiceAccess(originalState, input.role, departmentCode, input.serviceCodes, input.serviceAccessPolicy),
          createdAt: now(),
          version: 1,
          active: true
        };
        const correlationId = input.correlationId ?? id("corr");
        const departments = reconcileDepartmentMembership(originalState, user, now());
        const affectedDepartmentIds = departments.filter((department, index) => department !== originalState.departments[index]).map((department) => department.id);
        const nextState = {
          ...originalState,
          departments,
          users: [...originalState.users, user],
          auditEvents: [...originalState.auditEvents, createAudit("UserCreated", currentActor.id, "User", user.id, correlationId, undefined, "ACTIVE", { action: "CREATE_USER", accessGroupId: user.accessGroupId ?? "", affectedDepartmentIds: JSON.stringify(affectedDepartmentIds), role: user.role, departmentCode: user.departmentCode, serviceCodes: user.serviceCodes?.join(",") ?? "", serviceAccessPolicy: JSON.stringify(user.serviceAccessPolicy ?? null) })]
        };
        const result = managedUser(user);
        return { state: saveIdempotency(nextState, currentActor.id, scope, input.idempotencyKey, result, { input }), result: { ...result, initialPassword: password } };
      });
    },

    async deactivateManagedUser(actor: User, userId: string, input: ManagedUserDeactivateInput): Promise<ManagedUser> {
      const scope = "DELETE:/users";
      return store.transaction(async (originalState) => {
        const currentActor = requireActiveUser(originalState, actor);
        requireIdempotencyKey(input.idempotencyKey);
        requireAnyPermission(currentActor, ["user_role.manage", "user.deactivate"]);
        if (currentActor.id === userId) throw new ApiError("VALIDATION_ERROR", "A própria sessão não pode ser desativada.", 400);
        const target = findOrThrow(findById(originalState.users, userId));
        if (!canManageUserTarget(currentActor, target.role, target.departmentCode)) throw new ApiError("SCOPE_DENIED", "Você não tem acesso a este colaborador.", 404);
        if (target.role === "SUPERADMIN" || (target.role === "ADMIN" && target.active)) requireRecentReauthentication(currentActor);
        const idempotent = withIdempotency<ManagedUser>(originalState, currentActor.id, scope, input.idempotencyKey, { userId, input });
        if (idempotent.found) return { state: originalState, result: idempotent.existing! };
        ensureExpectedVersion(target.version, input.expectedVersion);
        // Nobody stays on call (PROD-402) after losing access.
        const pending = withoutPendingReset(target);
        const updated: User = { ...pending.user, active: false, ...(target.onCall ? { onCall: false } : {}), version: target.version + 1 };
        const correlationId = input.correlationId ?? id("corr");
        const departments = reconcileDepartmentMembership(originalState, updated, now());
        const affectedDepartmentIds = departments.filter((department, index) => department !== originalState.departments[index]).map((department) => department.id);
        const nextState = {
          ...originalState,
          departments,
          users: originalState.users.map((user) => user.id === target.id ? updated : user),
          sessions: revokeUserSessions(originalState, target.id),
          auditEvents: [...originalState.auditEvents, createAudit("UserDeactivated", currentActor.id, "User", target.id, correlationId, target.active ? "ACTIVE" : "INACTIVE", "INACTIVE", { action: "DEACTIVATE_USER", affectedDepartmentIds: JSON.stringify(affectedDepartmentIds), role: target.role, departmentCode: target.departmentCode, ...(pending.revoked ? { resetLinkRevoked: true } : {}) })]
        };
        assertAdministrativeAccessRetained(originalState, nextState);
        const result = managedUser(updated);
        return { state: saveIdempotency(nextState, currentActor.id, scope, input.idempotencyKey, result, { userId, input }), result };
      });
    },

    async regenerateManagedUserPassword(actor: User, userId: string, input: CommandMeta): Promise<ManagedUser & { initialPassword?: string }> {
      const scope = "POST:/users/password";
      return store.transaction(async (originalState) => {
        const currentActor = requireActiveUser(originalState, actor);
        requireIdempotencyKey(input.idempotencyKey);
        requireAnyPermission(currentActor, ["user_role.manage", "user.update"]);
        if (currentActor.id === userId) throw new ApiError("VALIDATION_ERROR", "A recuperação da própria conta deve ser feita por outro administrador.", 400);
        const target = findOrThrow(findById(originalState.users, userId));
        if (!canManageUserTarget(currentActor, target.role, target.departmentCode)) throw new ApiError("SCOPE_DENIED", "Você não tem acesso a este colaborador.", 404);
        // Replacing an administrative credential grants control of that account.
        if (isAdministrativeRole(target.role)) requireRecentReauthentication(currentActor);
        const idempotent = withIdempotency<ManagedUser>(originalState, currentActor.id, scope, input.idempotencyKey, { userId, input });
        if (idempotent.found) return { state: originalState, result: idempotent.existing! };
        if (input.expectedVersion === undefined) throw new ApiError("VALIDATION_ERROR", "expectedVersion é obrigatório para gerar uma nova senha.", 400);
        ensureExpectedVersion(target.version, input.expectedVersion);
        if (!target.active) throw new ApiError("CONFLICT", "Ative o acesso antes de gerar uma nova senha.", 409);
        const password = `Cvg1-${randomBytes(24).toString("base64url")}`;
        const pending = withoutPendingReset(target);
        const updated: User = { ...pending.user, passwordHash: hashPassword(password), mustChangePassword: true, version: target.version + 1 };
        const nextState = {
          ...originalState,
          users: originalState.users.map((user) => user.id === target.id ? updated : user),
          sessions: revokeUserSessions(originalState, target.id),
          auditEvents: [...originalState.auditEvents, createAudit("UserPasswordRegenerated", currentActor.id, "User", target.id, input.correlationId ?? id("corr"), undefined, "TEMPORARY_PASSWORD", { action: "REGENERATE_USER_PASSWORD", role: target.role, departmentCode: target.departmentCode, ...(pending.revoked ? { resetLinkRevoked: true } : {}) })]
        };
        const result = managedUser(updated);
        return { state: saveIdempotency(nextState, currentActor.id, scope, input.idempotencyKey, result, { userId, input }), result: { ...result, initialPassword: password } };
      });
    },

    /**
     * PROD-202: the ADMIN issues a one-time link and hands it over out of band.
     * Only the SHA-256 of the token is stored; a new link replaces any previous
     * one and the target's sessions are revoked. The URL is returned once: an
     * idempotent replay returns the stored response without it.
     */
    async issuePasswordResetLink(actor: User, userId: string, input: CommandMeta): Promise<{ user: ManagedUser; resetUrl?: string; expiresAt: string }> {
      const scope = "POST:/users/password-reset-link";
      return store.transaction(async (originalState) => {
        const currentActor = requireActiveUser(originalState, actor);
        requireIdempotencyKey(input.idempotencyKey);
        requireAnyPermission(currentActor, ["user_role.manage", "user.update"]);
        if (currentActor.id === userId) throw new ApiError("VALIDATION_ERROR", "A redefinição da própria conta deve ser feita por outro administrador.", 400);
        const target = findOrThrow(findById(originalState.users, userId));
        if (!canManageUserTarget(currentActor, target.role, target.departmentCode)) throw new ApiError("SCOPE_DENIED", "Você não tem acesso a este colaborador.", 404);
        // A reset link takes over the account exactly like a regenerated password does.
        if (isAdministrativeRole(target.role)) requireRecentReauthentication(currentActor);
        const idempotent = withIdempotency<{ user: ManagedUser; expiresAt: string }>(originalState, currentActor.id, scope, input.idempotencyKey, { userId, input });
        if (idempotent.found) return { state: originalState, result: idempotent.existing! };
        if (input.expectedVersion === undefined) throw new ApiError("VALIDATION_ERROR", "expectedVersion é obrigatório para gerar o link de redefinição.", 400);
        ensureExpectedVersion(target.version, input.expectedVersion);
        if (!target.active) throw new ApiError("CONFLICT", "Ative o acesso antes de gerar o link de redefinição.", 409);
        const { token, grant } = createPasswordResetGrant(currentActor.id);
        const updated: User = { ...target, passwordReset: grant, version: target.version + 1 };
        const nextState = {
          ...originalState,
          users: originalState.users.map((user) => user.id === target.id ? updated : user),
          sessions: revokeUserSessions(originalState, target.id),
          auditEvents: [...originalState.auditEvents, createAudit("PasswordResetLinkIssued", currentActor.id, "User", target.id, input.correlationId ?? id("corr"), undefined, "PASSWORD_RESET_PENDING", { action: "ISSUE_PASSWORD_RESET_LINK", role: target.role, departmentCode: target.departmentCode, expiresAt: grant.expiresAt, replacedPrevious: Boolean(target.passwordReset) })]
        };
        const stored = { user: managedUser(updated), expiresAt: grant.expiresAt };
        return { state: saveIdempotency(nextState, currentActor.id, scope, input.idempotencyKey, stored, { userId, input }), result: { ...stored, resetUrl: passwordResetUrl(token) } };
      });
    },

    async listServices(actor: User, options: { includeInactive?: boolean } = {}) {
      const state = await store.readState();
      const currentActor = requireActiveUser(state, actor);
      const includeInactive = options.includeInactive === true;
      if (includeInactive) requireAnyPermission(currentActor, ["service.catalog.manage", "service.catalog.create", "service.catalog.update", "service.catalog.deactivate"]);
      else requirePermission(currentActor, "service.catalog.view", {});
      return state.services
        .filter((service) => currentActor.role !== "MANAGER" || managerCanAccessDepartment(currentActor, service.departmentCode))
        .filter((service) => includeInactive || service.active)
        .map((service) => ({
        id: service.id,
        code: service.code,
        name: service.name,
        category: service.category,
        departmentCode: service.departmentCode,
        workflowType: service.workflowType,
        requiresSample: service.requiresSample,
        ...(service.sampleType ? { sampleType: service.sampleType } : {}),
        requiresSchedule: service.requiresSchedule,
        allowsAttachment: service.allowsAttachment,
        resultSchema: service.resultSchema,
        ...(service.resultTemplate ? { resultTemplate: service.resultTemplate } : {}),
        active: service.active,
        slaHours: { ...service.slaHours },
        version: service.version
      }));
    },

    async getResultTemplate(actor: User, serviceId: string) {
      const state = await store.readState();
      const currentActor = requireActiveUser(state, actor);
      const service = findOrThrow(findById(state.services, serviceId));
      if (!service.active) throw new ApiError("NOT_FOUND", "O serviço diagnóstico não está disponível.", 404);
      requirePermission(currentActor, "service.catalog.view", { departmentCode: service.departmentCode, serviceCode: service.code });
      return service.resultTemplate?.status === "ACTIVE" ? service.resultTemplate : null;
    },

    async createDiagnosticService(actor: User, input: DiagnosticServiceCreateInput) {
      const scope = "POST:/diagnostic-services";
      return store.transaction(async (originalState) => {
        const currentActor = requireActiveUser(originalState, actor);
        const departmentCode = requireText(input.departmentCode, "departmentCode", 60).toUpperCase();
        if (!/^[A-Z0-9_-]{1,60}$/.test(departmentCode)) throw new ApiError("VALIDATION_ERROR", "O departamento informado é inválido.", 400);
        requireAnyPermission(currentActor, ["service.catalog.manage", "service.catalog.create"], { departmentCode });
        const idempotent = withIdempotency<DiagnosticService>(originalState, currentActor.id, scope, input.idempotencyKey, { input });
        if (idempotent.found) return { state: originalState, result: idempotent.existing! };
        requireActiveDepartment(originalState, departmentCode);
        const code = requireText(input.code, "code", 60).toUpperCase();
        if (!/^[A-Z][A-Z0-9_]{1,59}$/.test(code)) throw new ApiError("VALIDATION_ERROR", "Código de serviço inválido.", 400);
        if (originalState.services.some((service) => service.code === code) || originalState.hospitalServices.some((service) => service.code === code)) throw new ApiError("CONFLICT", "Código de serviço já utilizado.", 409);
        validateServiceDefinition(input.category, input.workflowType);
        const source = input.duplicateOfServiceId ? findOrThrow(findById(originalState.services, input.duplicateOfServiceId)) : undefined;
        if (source) requireAnyPermission(currentActor, ["service.catalog.manage", "service.catalog.create"], { departmentCode: source.departmentCode });
        const resultTemplate = input.resultSchema === "NUMERIC_PANEL" ? source?.resultTemplate : undefined;
        validateServiceResultSchema(input.category, input.workflowType, input.resultSchema, resultTemplate);
        const service: DiagnosticService = {
          id: id("service"),
          code,
          name: requireText(input.name, "name", 120),
          category: input.category,
          departmentCode,
          workflowType: input.workflowType,
          requiresSample: input.requiresSample,
          ...(input.sampleType ? { sampleType: requireText(input.sampleType, "sampleType", 60) } : {}),
          requiresSchedule: input.requiresSchedule,
          allowsAttachment: input.allowsAttachment,
          active: true,
          resultSchema: input.resultSchema,
          ...(resultTemplate ? { resultTemplate: structuredClone(resultTemplate) } : {}),
          slaHours: validatedSlaHours(input.slaHours),
          version: 1
        };
        const correlationId = input.correlationId ?? id("corr");
        const authorized = catalogServiceAccess(originalState, undefined, service, currentActor.id, correlationId);
        const nextState = { ...originalState, users: authorized.users, sessions: authorized.sessions, services: [...originalState.services, service], auditEvents: [...originalState.auditEvents, ...authorized.auditEvents, createAudit("DiagnosticServiceCreated", currentActor.id, "DiagnosticService", service.id, correlationId, undefined, "ACTIVE", { code: service.code, workflowType: service.workflowType, autoAuthorizedExecutors: String(authorized.granted), affectedUserIds: authorized.affectedUserIds })] };
        return { state: saveIdempotency(recordExamDefinition(nextState, undefined, service, currentActor.id, now(), correlationId), currentActor.id, scope, input.idempotencyKey, service, { input }), result: service };
      });
    },

    async updateDiagnosticService(actor: User, serviceId: string, input: DiagnosticServicePatchInput) {
      const scope = "PATCH:/diagnostic-services";
      return store.transaction(async (originalState) => {
        const currentActor = requireActiveUser(originalState, actor);
        const service = findOrThrow(findById(originalState.services, serviceId));
        const metadataChange = Object.keys(input).some((key) => !["active", "expectedVersion", "idempotencyKey", "correlationId"].includes(key));
        const action: Permission = input.active === false && !metadataChange ? "service.catalog.deactivate" : "service.catalog.update";
        requireAnyPermission(currentActor, ["service.catalog.manage", action], { departmentCode: service.departmentCode });
        if (input.active === false && metadataChange) requireAnyPermission(currentActor, ["service.catalog.manage", "service.catalog.deactivate"], { departmentCode: service.departmentCode });
        const departmentCode = input.departmentCode === undefined ? service.departmentCode : requireText(input.departmentCode, "departmentCode", 60).toUpperCase();
        if (!/^[A-Z0-9_-]{1,60}$/.test(departmentCode)) throw new ApiError("VALIDATION_ERROR", "O departamento informado é inválido.", 400);
        requireAnyPermission(currentActor, ["service.catalog.manage", action], { departmentCode });
        const idempotent = withIdempotency<DiagnosticService>(originalState, currentActor.id, scope, input.idempotencyKey, { serviceId, input });
        if (idempotent.found) return { state: originalState, result: idempotent.existing! };
        ensureExpectedVersion(service.version, input.expectedVersion);
        if (departmentCode !== service.departmentCode || (!service.active && input.active === true)) requireActiveDepartment(originalState, departmentCode);
        const category = input.category ?? service.category;
        const workflowType = input.workflowType ?? service.workflowType;
        const requiresSample = input.requiresSample ?? service.requiresSample;
        const requiresSchedule = input.requiresSchedule ?? service.requiresSchedule;
        const resultSchema = input.resultSchema ?? service.resultSchema;
        validateServiceDefinition(category, workflowType);
        validateServiceResultSchema(category, workflowType, resultSchema, service.resultTemplate, { allowUnpublished: resultSchema === service.resultSchema && Boolean(service.resultTemplate) });
        const structuralChanged = category !== service.category || departmentCode !== service.departmentCode || workflowType !== service.workflowType || requiresSample !== service.requiresSample || requiresSchedule !== service.requiresSchedule || resultSchema !== service.resultSchema;
        if (structuralChanged && originalState.items.some((item) => item.serviceId === service.id)) {
          throw new ApiError("CATALOG_IN_USE", "A estrutura deste serviço já está referenciada por solicitações e não pode ser alterada.", 409);
        }
        const sampleType = input.sampleType === undefined ? service.sampleType : input.sampleType === null ? undefined : requireText(input.sampleType, "sampleType", 60);
        const { sampleType: _previousSampleType, ...serviceWithoutSampleType } = service;
        const updated: DiagnosticService = {
          ...serviceWithoutSampleType,
          ...(sampleType ? { sampleType } : {}),
          name: input.name === undefined ? service.name : requireText(input.name, "name", 120),
          category,
          departmentCode,
          workflowType,
          requiresSample,
          requiresSchedule,
          active: input.active ?? service.active,
          allowsAttachment: input.allowsAttachment ?? service.allowsAttachment,
          resultSchema,
          slaHours: input.slaHours ? validatedSlaHours(input.slaHours) : { ...service.slaHours },
          version: service.version + 1
        };
        const correlationId = input.correlationId ?? id("corr");
        const authorized = catalogServiceAccess(originalState, service, updated, currentActor.id, correlationId);
        const nextState = { ...originalState, users: authorized.users, sessions: authorized.sessions, services: originalState.services.map((entry) => entry.id === service.id ? updated : entry), auditEvents: [...originalState.auditEvents, ...authorized.auditEvents, createAudit("DiagnosticServiceUpdated", currentActor.id, "DiagnosticService", service.id, correlationId, String(service.version), String(updated.version), { active: updated.active, departmentCode: updated.departmentCode, workflowType: updated.workflowType, allowsAttachment: updated.allowsAttachment, autoAuthorizedExecutors: String(authorized.granted), affectedUserIds: authorized.affectedUserIds })] };
        return { state: saveIdempotency(recordExamDefinition(nextState, service, updated, currentActor.id, now(), correlationId), currentActor.id, scope, input.idempotencyKey, updated, { serviceId, input }), result: updated };
      });
    },

    /**
     * D10: applies the catalog sheets. A dry run only plans. A real run is all-or-nothing: any ERROR row rejects the
     * whole sheet (422) so the same file can be corrected and re-sent; an identical re-import writes nothing.
     */
    async importCatalog(actor: User, input: CatalogImportInput): Promise<CatalogImportResult> {
      requireIdempotencyKey(input.idempotencyKey);
      const scope = "POST:/diagnostic-services/import";
      const planFor = (state: StoreState, currentActor: User) => {
        requireAnyPermission(currentActor, ["service.catalog.manage", "service.catalog.create", "service.catalog.update", "service.catalog.deactivate"]);
        const plan = planCatalogImport(state, parseCatalogSheet(input.services), input.analytes === undefined ? undefined : parseAnalyteSheet(input.analytes), {
          canManageDepartment: (departmentCode) => ["service.catalog.manage", "service.catalog.create", "service.catalog.update", "service.catalog.deactivate"].some((permission) => canAccessResource(currentActor, permission as Permission, { departmentCode }))
        });
        for (const write of plan.writes) {
          const previous = write.existingId ? findById(state.services, write.existingId) : undefined;
          const action: Permission = !previous ? "service.catalog.create" : previous.active && !write.next.active ? "service.catalog.deactivate" : "service.catalog.update";
          requireAnyPermission(currentActor, ["service.catalog.manage", action], { departmentCode: write.next.departmentCode });
          if (previous) requireAnyPermission(currentActor, ["service.catalog.manage", action], { departmentCode: previous.departmentCode });
          if (previous && action === "service.catalog.deactivate" && Object.entries(write.next).some(([key, value]) => key !== "active" && stableSerialize(value) !== stableSerialize((previous as unknown as Record<string, unknown>)[key]))) {
            requireAnyPermission(currentActor, ["service.catalog.manage", "service.catalog.update"], { departmentCode: previous.departmentCode });
            requireAnyPermission(currentActor, ["service.catalog.manage", "service.catalog.update"], { departmentCode: write.next.departmentCode });
          }
          if (!previous || previous.departmentCode !== write.next.departmentCode || (!previous.active && write.next.active)) requireActiveDepartment(state, write.next.departmentCode);
        }
        return plan;
      };
      if (input.dryRun) {
        const state = await store.readState();
        const { writes: _writes, ...report } = planFor(state, requireActiveUser(state, actor));
        return { applied: false, dryRun: true, ...report };
      }
      return store.transaction(async (originalState) => {
        const currentActor = requireActiveUser(originalState, actor);
        requireAnyPermission(currentActor, ["service.catalog.manage", "service.catalog.create", "service.catalog.update", "service.catalog.deactivate"]);
        const idempotent = withIdempotency<CatalogImportResult>(originalState, currentActor.id, scope, input.idempotencyKey, { services: input.services, analytes: input.analytes });
        if (idempotent.found) return { state: originalState, result: idempotent.existing! };
        const { writes, ...report } = planFor(originalState, currentActor);
        if (report.summary.error > 0) {
          throw new ApiError("CATALOG_IMPORT_INVALID", "A planilha contém erros e nada foi importado. Corrija as linhas indicadas e envie novamente.", 422, { importReport: { applied: false, dryRun: false, ...report } });
        }
        const result: CatalogImportResult = { applied: true, dryRun: false, ...report };
        if (writes.length === 0) return { state: originalState, result };
        const correlationId = input.correlationId ?? id("corr");
        let definitionState = originalState;
        let services = originalState.services;
        let users = originalState.users;
        let sessions = originalState.sessions;
        const audits: AuditEvent[] = [];
        for (const write of writes) {
          const previous = write.existingId ? services.find((entry) => entry.id === write.existingId) : undefined;
          const { sampleType: _previousSampleType, resultTemplate: _previousTemplate, ...base } = previous ?? { sampleType: undefined, resultTemplate: undefined };
          const saved: DiagnosticService = { ...base, ...write.next, id: previous?.id ?? id("service"), version: (previous?.version ?? 0) + 1 };
          definitionState = recordExamDefinition(definitionState, previous, saved, currentActor.id, now(), correlationId);
          const authorized = catalogServiceAccess({ ...originalState, users, services, sessions }, previous, saved, currentActor.id, correlationId);
          users = authorized.users;
          sessions = authorized.sessions;
          audits.push(...authorized.auditEvents);
          if (previous) {
            services = services.map((entry) => entry.id === previous.id ? saved : entry);
            audits.push(createAudit("DiagnosticServiceUpdated", currentActor.id, "DiagnosticService", saved.id, correlationId, String(previous.version), String(saved.version), { active: saved.active, departmentCode: saved.departmentCode, workflowType: saved.workflowType, allowsAttachment: saved.allowsAttachment, autoAuthorizedExecutors: String(authorized.granted), affectedUserIds: authorized.affectedUserIds, source: "CATALOG_IMPORT" }));
          } else {
            services = [...services, saved];
            audits.push(createAudit("DiagnosticServiceCreated", currentActor.id, "DiagnosticService", saved.id, correlationId, undefined, saved.active ? "ACTIVE" : "INACTIVE", { code: saved.code, workflowType: saved.workflowType, autoAuthorizedExecutors: String(authorized.granted), affectedUserIds: authorized.affectedUserIds, source: "CATALOG_IMPORT" }));
          }
        }
        audits.push(createAudit("CatalogImported", currentActor.id, "DiagnosticServiceCatalog", "catalog", correlationId, undefined, undefined, { created: report.summary.create, updated: report.summary.update, unchanged: report.summary.unchanged, rows: report.rows.length }));
        const nextState = { ...originalState, examDefinitions: definitionState.examDefinitions, users, sessions, services, auditEvents: [...definitionState.auditEvents, ...audits] };
        return { state: saveIdempotency(nextState, currentActor.id, scope, input.idempotencyKey, result, { services: input.services, analytes: input.analytes }), result };
      });
    },

    async listReasonCodes(actor: User) {
      const state = await store.readState();
      const currentActor = requireActiveUser(state, actor);
      requirePermission(currentActor, "reason_code.manage", {});
      return state.reasonCodes.map((reason) => ({ ...reason }));
    },

    async createReasonCode(actor: User, input: ReasonCodeCreateInput) {
      const scope = "POST:/reason-codes";
      return store.transaction(async (originalState) => {
        const currentActor = requireActiveUser(originalState, actor);
        requirePermission(currentActor, "reason_code.manage", {});
        const idempotent = withIdempotency<ReasonCode>(originalState, currentActor.id, scope, input.idempotencyKey, { input });
        if (idempotent.found) return { state: originalState, result: idempotent.existing! };
        const code = requireText(input.code, "code", 60).toUpperCase();
        if (!/^[A-Z][A-Z0-9_]{1,59}$/.test(code)) throw new ApiError("VALIDATION_ERROR", "Código de motivo inválido.", 400);
        if (originalState.reasonCodes.some((reason) => reason.type === input.type && reason.code === code)) throw new ApiError("CONFLICT", "Motivo já utilizado para este tipo.", 409);
        const reason: ReasonCode = { id: id("reason"), type: input.type, code, label: requireText(input.label, "label", 160), active: true, version: 1 };
        const correlationId = input.correlationId ?? id("corr");
        const nextState = { ...originalState, reasonCodes: [...originalState.reasonCodes, reason], auditEvents: [...originalState.auditEvents, createAudit("ReasonCodeCreated", currentActor.id, "ReasonCode", reason.id, correlationId, undefined, "ACTIVE", { type: reason.type, code: reason.code })] };
        return { state: saveIdempotency(nextState, currentActor.id, scope, input.idempotencyKey, reason, { input }), result: reason };
      });
    },

    async updateReasonCode(actor: User, reasonId: string, input: ReasonCodePatchInput) {
      const scope = "PATCH:/reason-codes";
      return store.transaction(async (originalState) => {
        const currentActor = requireActiveUser(originalState, actor);
        const reason = findOrThrow(findById(originalState.reasonCodes, reasonId));
        requirePermission(currentActor, "reason_code.manage", {});
        const idempotent = withIdempotency<ReasonCode>(originalState, currentActor.id, scope, input.idempotencyKey, { reasonId, input });
        if (idempotent.found) return { state: originalState, result: idempotent.existing! };
        ensureExpectedVersion(reason.version, input.expectedVersion);
        const updated: ReasonCode = { ...reason, label: input.label === undefined ? reason.label : requireText(input.label, "label", 160), active: input.active ?? reason.active, version: reason.version + 1 };
        const correlationId = input.correlationId ?? id("corr");
        const nextState = { ...originalState, reasonCodes: originalState.reasonCodes.map((entry) => entry.id === reason.id ? updated : entry), auditEvents: [...originalState.auditEvents, createAudit("ReasonCodeUpdated", currentActor.id, "ReasonCode", reason.id, correlationId, String(reason.version), String(updated.version), { active: updated.active })] };
        return { state: saveIdempotency(nextState, currentActor.id, scope, input.idempotencyKey, updated, { reasonId, input }), result: updated };
      });
    },

  };
  return service;
}
