import { createHash, randomUUID } from "node:crypto";
import { ITEM_STATES, PRIORITIES, ROLES } from "@cvg/contracts";
import type { ItemState, ManagedSession, Permission, Priority, RoleCode, WorkflowType } from "@cvg/contracts";
import type { Admission, Attachment, AuditEvent, DiagnosticItem, DiagnosticRequest, DiagnosticService, Notification, Procedure, ProcedureSchedule, ReasonCode, Result, ResultVersion, Sample, StateStore, StoreState, User } from "../domain/models";
import type { CommandMeta, NotificationAcknowledgeInput, CreateRequestInput, ReceiveSampleInput, RecollectionInput, ResultDraftInput, ReleaseInput, ReviewInput, AmendInput, ScheduleInput, CancelInput, RejectInput, VoidInput, AttachmentUploadInput, DiagnosticServiceCreateInput, DiagnosticServicePatchInput, ReasonCodeCreateInput, ReasonCodePatchInput, UserRoleUpdateInput, ManagedUserCreateInput, ManagedUserDeactivateInput, SessionRevokeInput, ManagedUser, ManagementOverview, DashboardIndicatorKey, DashboardIndicator, DashboardWindow, DashboardView, RequestListFilters, SearchResultType, SearchFilters, SearchResult, TimelineFilters, TimelineResult, RequestView, ResultView, ItemView, SampleCommandResult, ResultDraftCommandResult, ResultReleaseCommandResult, ReviewCommandResult, ItemCommandResult, ProcedureScheduleCommandResult, ProcedureRescheduleCommandResult, ProcedureExecutionCommandResult, AmendCommandResult, VoidCommandResult, PublicAttachment, AttachmentSessionResult, AttachmentFinalizationResult, PatientDiagnosticsResult, ReportView } from "./service-types";
import { canAccessResource, managerCanAccessDepartment, managerDepartmentCodes } from "../security/authorization";
import { ApiError } from "../http/envelope";
import { hashPassword } from "../security/password";
import type { ApplicationServiceContext } from "./service-context";
import * as helpers from "./service-common";
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

export function createManagementService({ store, storage }: ApplicationServiceContext) {
  const service = {
    async listManagedUsers(actor: User): Promise<ManagedUser[]> {
      const state = await store.readState();
      const currentActor = requireActiveUser(state, actor);
      requirePermission(currentActor, "user_role.manage", {});
      return state.users
        .filter((user) => canManageUserTarget(currentActor, user.role, user.departmentCode))
        .slice()
        .sort((left, right) => left.displayName.localeCompare(right.displayName, "pt-BR"))
        .map(managedUser);
    },

    async listManagedSessions(actor: User): Promise<ManagedSession[]> {
      const state = await store.readState();
      const currentActor = requireActiveUser(state, actor);
      requirePermission(currentActor, "user_role.manage", {});
      return state.sessions
        .map((session) => ({ session, user: state.users.find((user) => user.id === session.userId) }))
        .filter((entry): entry is { session: typeof state.sessions[number]; user: User } => Boolean(entry.user && canManageUserTarget(currentActor, entry.user.role, entry.user.departmentCode)))
        .sort((left, right) => right.session.createdAt.localeCompare(left.session.createdAt))
        .map(({ session, user }) => managedSession(session, user, currentActor.sessionId));
    },

    async revokeManagedSession(actor: User, sessionId: string, input: SessionRevokeInput): Promise<ManagedSession> {
      const scope = "POST:/sessions/revoke";
      return store.transaction(async (originalState) => {
        const currentActor = requireActiveUser(originalState, actor);
        requireIdempotencyKey(input.idempotencyKey);
        requirePermission(currentActor, "user_role.manage", {});
        requireRecentReauthentication(currentActor);
        if (input.confirm !== true) throw new ApiError("VALIDATION_ERROR", "A confirmação explícita da revogação é obrigatória.", 400);
        const reason = requireText(input.reason, "reason", 500);
        const targetSession = findOrThrow(originalState.sessions.find((session) => session.id === sessionId));
        const targetUser = findOrThrow(originalState.users.find((user) => user.id === targetSession.userId));
        if (!canManageUserTarget(currentActor, targetUser.role, targetUser.departmentCode)) throw new ApiError("SCOPE_DENIED", "Você não tem acesso a esta sessão.", 404);
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
          auditEvents: [...originalState.auditEvents, createAudit("SessionRevoked", currentActor.id, "Session", targetSession.id, correlationId, "ACTIVE", "REVOKED", { targetUserId: targetUser.id, reason })]
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
        requirePermission(currentActor, "user_role.manage", {});
        requireRecentReauthentication(currentActor);
        if (input.expectedVersion === undefined) throw new ApiError("VALIDATION_ERROR", "expectedVersion é obrigatório para alterar uma role.", 400);
        if (input.confirm !== true) throw new ApiError("VALIDATION_ERROR", "A confirmação explícita da alteração é obrigatória.", 400);
        if (typeof input.reason !== "string") throw new ApiError("VALIDATION_ERROR", "reason é obrigatório para alterar uma role.", 400);
        const reason = requireText(input.reason, "reason", 500);
        if (currentActor.id === userId) throw new ApiError("VALIDATION_ERROR", "A própria sessão não pode alterar seu role.", 400);
        if (!ROLES.includes(input.role)) throw new ApiError("VALIDATION_ERROR", "O role informado é inválido.", 400);
        const departmentCode = requireText(input.departmentCode, "departmentCode", 60).toUpperCase();
        if (!/^[A-Z0-9_-]{1,60}$/.test(departmentCode)) throw new ApiError("VALIDATION_ERROR", "O departamento informado é inválido.", 400);
        const target = findOrThrow(originalState.users.find((user) => user.id === userId));
        if (!canManageUserTarget(currentActor, target.role, target.departmentCode) || !canManageUserTarget(currentActor, input.role, departmentCode)) {
          throw new ApiError("SCOPE_DENIED", "Você não tem acesso a este colaborador.", 404);
        }
        const idempotent = withIdempotency<ManagedUser>(originalState, currentActor.id, scope, input.idempotencyKey, { userId, input });
        if (idempotent.found) return { state: originalState, result: idempotent.existing! };
        ensureExpectedVersion(target.version, input.expectedVersion);
        const managedDepartmentCodes = input.role === "MANAGER"
          ? input.managedDepartmentCodes === undefined ? target.managedDepartmentCodes : normalizedManagedDepartments(input.managedDepartmentCodes)
          : undefined;
        if (input.role !== "MANAGER" && input.managedDepartmentCodes?.length) throw new ApiError("VALIDATION_ERROR", "Somente MANAGER pode ter setores delegados.", 400);
        const nextActive = input.active ?? target.active;
        if (target.role === "ADMIN" && target.active && !nextActive && originalState.users.filter((user) => user.active && user.role === "ADMIN" && user.id !== target.id).length === 0) {
          throw new ApiError("CONFLICT", "O último administrador ativo não pode ser desativado.", 409);
        }
        const updated: User = { ...target, role: input.role, departmentCode, managedDepartmentCodes, active: nextActive, version: target.version + 1 };
        const correlationId = input.correlationId ?? id("corr");
        const nextState = {
          ...originalState,
          users: originalState.users.map((user) => user.id === target.id ? updated : user),
          sessions: revokeUserSessions(originalState, target.id),
          auditEvents: [...originalState.auditEvents, createAudit("UserRoleUpdated", currentActor.id, "User", target.id, correlationId, `${target.role}:${target.departmentCode}:${target.active}`, `${updated.role}:${updated.departmentCode}:${updated.active}`, { reason, managedDepartmentCodes: managedDepartmentCodes?.join(",") ?? "" })]
        };
        const result = managedUser(updated);
        return { state: saveIdempotency(nextState, currentActor.id, scope, input.idempotencyKey, result, { userId, input }), result };
      });
    },

    async createManagedUser(actor: User, input: ManagedUserCreateInput): Promise<ManagedUser> {
      const scope = "POST:/users";
      return store.transaction(async (originalState) => {
        const currentActor = requireActiveUser(originalState, actor);
        requireIdempotencyKey(input.idempotencyKey);
        requirePermission(currentActor, "user_role.manage", {});
        requireRecentReauthentication(currentActor);
        if (input.confirm !== true) throw new ApiError("VALIDATION_ERROR", "A confirmação explícita da criação é obrigatória.", 400);
        const reason = requireText(input.reason, "reason", 500);
        if (!ROLES.includes(input.role)) throw new ApiError("VALIDATION_ERROR", "O role informado é inválido.", 400);
        const departmentCode = requireText(input.departmentCode, "departmentCode", 60).toUpperCase();
        if (!/^[A-Z0-9_-]{1,60}$/.test(departmentCode)) throw new ApiError("VALIDATION_ERROR", "O departamento informado é inválido.", 400);
        if (!canManageUserTarget(currentActor, input.role, departmentCode)) throw new ApiError("SCOPE_DENIED", "Você não pode provisionar este tipo de colaborador neste setor.", 404);
        const idempotent = withIdempotency<ManagedUser>(originalState, currentActor.id, scope, input.idempotencyKey, { input });
        if (idempotent.found) return { state: originalState, result: idempotent.existing! };
        const email = normalizedEmail(input.email);
        if (originalState.users.some((user) => user.email.toLowerCase() === email)) throw new ApiError("CONFLICT", "Já existe um colaborador com este e-mail.", 409);
        const displayName = requireText(input.displayName, "displayName", 160);
        const password = validatedPassword(input.password);
        const timezone = validatedTimezone(input.timezone);
        const managedDepartmentCodes = input.role === "MANAGER" ? normalizedManagedDepartments(input.managedDepartmentCodes) : undefined;
        if (input.role !== "MANAGER" && input.managedDepartmentCodes?.length) throw new ApiError("VALIDATION_ERROR", "Somente MANAGER pode ter setores delegados.", 400);
        const user: User = {
          id: id("user"),
          email,
          displayName,
          role: input.role,
          departmentCode,
          passwordHash: hashPassword(password),
          timezone,
          managedDepartmentCodes,
          createdAt: now(),
          version: 1,
          active: true
        };
        const correlationId = input.correlationId ?? id("corr");
        const nextState = {
          ...originalState,
          users: [...originalState.users, user],
          auditEvents: [...originalState.auditEvents, createAudit("UserCreated", currentActor.id, "User", user.id, correlationId, undefined, "ACTIVE", { role: user.role, departmentCode: user.departmentCode, reason })]
        };
        const result = managedUser(user);
        return { state: saveIdempotency(nextState, currentActor.id, scope, input.idempotencyKey, result, { input }), result };
      });
    },

    async deactivateManagedUser(actor: User, userId: string, input: ManagedUserDeactivateInput): Promise<ManagedUser> {
      const scope = "DELETE:/users";
      return store.transaction(async (originalState) => {
        const currentActor = requireActiveUser(originalState, actor);
        requireIdempotencyKey(input.idempotencyKey);
        requirePermission(currentActor, "user_role.manage", {});
        requireRecentReauthentication(currentActor);
        if (input.confirm !== true) throw new ApiError("VALIDATION_ERROR", "A confirmação explícita da desativação é obrigatória.", 400);
        const reason = requireText(input.reason, "reason", 500);
        if (currentActor.id === userId) throw new ApiError("VALIDATION_ERROR", "A própria sessão não pode ser desativada.", 400);
        const target = findOrThrow(originalState.users.find((user) => user.id === userId));
        if (!canManageUserTarget(currentActor, target.role, target.departmentCode)) throw new ApiError("SCOPE_DENIED", "Você não tem acesso a este colaborador.", 404);
        const idempotent = withIdempotency<ManagedUser>(originalState, currentActor.id, scope, input.idempotencyKey, { userId, input });
        if (idempotent.found) return { state: originalState, result: idempotent.existing! };
        ensureExpectedVersion(target.version, input.expectedVersion);
        if (target.role === "ADMIN" && target.active && originalState.users.filter((user) => user.active && user.role === "ADMIN" && user.id !== target.id).length === 0) {
          throw new ApiError("CONFLICT", "O último administrador ativo não pode ser desativado.", 409);
        }
        const updated: User = { ...target, active: false, version: target.version + 1 };
        const correlationId = input.correlationId ?? id("corr");
        const nextState = {
          ...originalState,
          users: originalState.users.map((user) => user.id === target.id ? updated : user),
          sessions: revokeUserSessions(originalState, target.id),
          auditEvents: [...originalState.auditEvents, createAudit("UserDeactivated", currentActor.id, "User", target.id, correlationId, "ACTIVE", "INACTIVE", { reason })]
        };
        const result = managedUser(updated);
        return { state: saveIdempotency(nextState, currentActor.id, scope, input.idempotencyKey, result, { userId, input }), result };
      });
    },

    async listServices(actor: User, options: { includeInactive?: boolean } = {}) {
      const state = await store.readState();
      const currentActor = requireActiveUser(state, actor);
      const includeInactive = options.includeInactive === true;
      if (includeInactive) requirePermission(currentActor, "service.catalog.manage", {});
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
      const service = findOrThrow(state.services.find((entry) => entry.id === serviceId));
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
        requirePermission(currentActor, "service.catalog.manage", { departmentCode });
        const idempotent = withIdempotency<DiagnosticService>(originalState, currentActor.id, scope, input.idempotencyKey, { input });
        if (idempotent.found) return { state: originalState, result: idempotent.existing! };
        const code = requireText(input.code, "code", 60).toUpperCase();
        if (!/^[A-Z][A-Z0-9_]{1,59}$/.test(code)) throw new ApiError("VALIDATION_ERROR", "Código de serviço inválido.", 400);
        if (originalState.services.some((service) => service.code === code)) throw new ApiError("CONFLICT", "Código de serviço já utilizado.", 409);
        validateServiceDefinition(input.category, input.workflowType);
        validateServiceResultSchema(input.category, input.workflowType, input.resultSchema);
        const service: DiagnosticService = {
          id: id("service"),
          code,
          name: requireText(input.name, "name", 120),
          category: input.category,
          departmentCode,
          workflowType: input.workflowType,
          requiresSample: input.requiresSample,
          requiresSchedule: input.requiresSchedule,
          allowsAttachment: input.allowsAttachment,
          active: true,
          resultSchema: input.resultSchema,
          slaHours: validatedSlaHours(input.slaHours),
          version: 1
        };
        const correlationId = input.correlationId ?? id("corr");
        const nextState = { ...originalState, services: [...originalState.services, service], auditEvents: [...originalState.auditEvents, createAudit("DiagnosticServiceCreated", currentActor.id, "DiagnosticService", service.id, correlationId, undefined, "ACTIVE", { code: service.code, workflowType: service.workflowType })] };
        return { state: saveIdempotency(nextState, currentActor.id, scope, input.idempotencyKey, service, { input }), result: service };
      });
    },

    async updateDiagnosticService(actor: User, serviceId: string, input: DiagnosticServicePatchInput) {
      const scope = "PATCH:/diagnostic-services";
      return store.transaction(async (originalState) => {
        const currentActor = requireActiveUser(originalState, actor);
        const service = findOrThrow(originalState.services.find((entry) => entry.id === serviceId));
        requirePermission(currentActor, "service.catalog.manage", { departmentCode: service.departmentCode });
        ensureExpectedVersion(service.version, input.expectedVersion);
        const departmentCode = input.departmentCode === undefined ? service.departmentCode : requireText(input.departmentCode, "departmentCode", 60).toUpperCase();
        if (!/^[A-Z0-9_-]{1,60}$/.test(departmentCode)) throw new ApiError("VALIDATION_ERROR", "O departamento informado é inválido.", 400);
        requirePermission(currentActor, "service.catalog.manage", { departmentCode });
        const idempotent = withIdempotency<DiagnosticService>(originalState, currentActor.id, scope, input.idempotencyKey, { serviceId, input });
        if (idempotent.found) return { state: originalState, result: idempotent.existing! };
        const category = input.category ?? service.category;
        const workflowType = input.workflowType ?? service.workflowType;
        const requiresSample = input.requiresSample ?? service.requiresSample;
        const requiresSchedule = input.requiresSchedule ?? service.requiresSchedule;
        const resultSchema = input.resultSchema ?? service.resultSchema;
        validateServiceDefinition(category, workflowType);
        validateServiceResultSchema(category, workflowType, resultSchema, service.resultTemplate);
        const structuralChanged = category !== service.category || departmentCode !== service.departmentCode || workflowType !== service.workflowType || requiresSample !== service.requiresSample || requiresSchedule !== service.requiresSchedule || resultSchema !== service.resultSchema;
        if (structuralChanged && originalState.items.some((item) => item.serviceId === service.id)) {
          throw new ApiError("CATALOG_IN_USE", "A estrutura deste serviço já está referenciada por solicitações e não pode ser alterada.", 409);
        }
        const updated: DiagnosticService = {
          ...service,
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
        const nextState = { ...originalState, services: originalState.services.map((entry) => entry.id === service.id ? updated : entry), auditEvents: [...originalState.auditEvents, createAudit("DiagnosticServiceUpdated", currentActor.id, "DiagnosticService", service.id, correlationId, String(service.version), String(updated.version), { active: updated.active, departmentCode: updated.departmentCode, workflowType: updated.workflowType, allowsAttachment: updated.allowsAttachment })] };
        return { state: saveIdempotency(nextState, currentActor.id, scope, input.idempotencyKey, updated, { serviceId, input }), result: updated };
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
        const reason = findOrThrow(originalState.reasonCodes.find((entry) => entry.id === reasonId));
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
