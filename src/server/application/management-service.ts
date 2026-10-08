import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ITEM_STATES, PRIORITIES, ROLES } from "@cvg/contracts";
import type { ItemState, ManagedSession, Permission, Priority, RoleCode, WorkflowType } from "@cvg/contracts";
import type { Admission, Attachment, AuditEvent, DiagnosticItem, DiagnosticRequest, DiagnosticService, Notification, Procedure, ProcedureSchedule, ReasonCode, Result, ResultVersion, Sample, StateStore, StoreState, User } from "../domain/models";
import type { CommandMeta, NotificationAcknowledgeInput, CreateRequestInput, ReceiveSampleInput, RecollectionInput, ResultDraftInput, ReleaseInput, ReviewInput, AmendInput, ScheduleInput, CancelInput, RejectInput, VoidInput, AttachmentUploadInput, DiagnosticServiceCreateInput, DiagnosticServicePatchInput, ReasonCodeCreateInput, ReasonCodePatchInput, UserRoleUpdateInput, ManagedUserCreateInput, ManagedUserDeactivateInput, SessionRevokeInput, ManagedUser, ManagementOverview, DashboardIndicatorKey, DashboardIndicator, DashboardWindow, DashboardView, RequestListFilters, SearchResultType, SearchFilters, SearchResult, TimelineFilters, TimelineResult, RequestView, ResultView, ItemView, SampleCommandResult, ResultDraftCommandResult, ResultReleaseCommandResult, ReviewCommandResult, ItemCommandResult, ProcedureScheduleCommandResult, ProcedureRescheduleCommandResult, ProcedureExecutionCommandResult, AmendCommandResult, VoidCommandResult, PublicAttachment, AttachmentSessionResult, AttachmentFinalizationResult, PatientDiagnosticsResult, ReportView } from "./service-types";
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

const EXECUTOR_ROLES: readonly RoleCode[] = ["LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM"];

function activeServiceCodes(state: StoreState, departmentCode: string): string[] {
  return state.services.filter((service) => service.active && service.departmentCode === departmentCode).map((service) => service.code);
}

/**
 * Exams an executor may work on. Left unspecified, an executor starts with every active exam of the
 * department: a technician created in four interactions must not land on an empty queue because a
 * collapsed checkbox list was never opened. An explicit list (even an empty one) is kept as given.
 */
function assignedServices(state: StoreState, role: RoleCode, departmentCode: string, codes?: ReadonlyArray<string>): string[] | undefined {
  if (!EXECUTOR_ROLES.includes(role)) {
    if (codes?.length) throw new ApiError("VALIDATION_ERROR", "Somente equipes executoras podem receber exames autorizados.", 400);
    return undefined;
  }
  if (codes === undefined) return activeServiceCodes(state, departmentCode);
  if (codes.length > 200) throw new ApiError("VALIDATION_ERROR", "Limite de exames autorizados excedido.", 400);
  const normalized = [...new Set(codes.map((code) => requireText(code, "serviceCodes", 60).toUpperCase()))];
  if (normalized.some((code) => !state.services.some((service) => service.code === code && service.departmentCode === departmentCode))) {
    throw new ApiError("SCOPE_DENIED", "O exame autorizado deve pertencer ao setor do colaborador.", 404);
  }
  return normalized;
}

/**
 * A new exam reaches the executors who already had every exam of the department. Someone who was
 * deliberately restricted to a subset keeps the subset; the administrator grants the new exam to them.
 */
function authorizeNewServiceForExecutors(state: StoreState, service: DiagnosticService): { users: User[]; granted: number } {
  const before = activeServiceCodes(state, service.departmentCode);
  let granted = 0;
  const users = state.users.map((user) => {
    if (!user.active || !EXECUTOR_ROLES.includes(user.role) || user.departmentCode !== service.departmentCode) return user;
    const held = new Set(user.serviceCodes ?? []);
    if (!before.every((code) => held.has(code)) || held.has(service.code)) return user;
    granted += 1;
    return { ...user, serviceCodes: [...held, service.code], version: user.version + 1 };
  });
  return { users, granted };
}

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
      if (currentActor.role !== "ADMIN") throw new ApiError("SCOPE_DENIED", "Você não tem acesso às sessões do sistema.", 404);
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
        requirePermission(currentActor, "user_role.manage", {});
        if (currentActor.role !== "ADMIN") throw new ApiError("SCOPE_DENIED", "Você não tem acesso às sessões do sistema.", 404);
        const targetSession = findOrThrow(findById(originalState.sessions, sessionId));
        const targetUser = findOrThrow(findById(originalState.users, targetSession.userId));
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
        requirePermission(currentActor, "user_role.manage", {});
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
        if (adminAccessChanged) requireRecentReauthentication(currentActor);
        const idempotent = withIdempotency<ManagedUser>(originalState, currentActor.id, scope, input.idempotencyKey, { userId, input });
        if (idempotent.found) return { state: originalState, result: idempotent.existing! };
        ensureExpectedVersion(target.version, input.expectedVersion);
        const managedDepartmentCodes = input.role === "MANAGER"
          ? input.managedDepartmentCodes === undefined ? target.managedDepartmentCodes : normalizedManagedDepartments(input.managedDepartmentCodes)
          : undefined;
        if (input.role !== "MANAGER" && input.managedDepartmentCodes?.length) throw new ApiError("VALIDATION_ERROR", "Somente MANAGER pode ter setores delegados.", 400);
        const nextActive = input.active ?? target.active;
        if (target.role === "ADMIN" && target.active && (input.role !== "ADMIN" || !nextActive) && originalState.users.filter((user) => user.active && user.role === "ADMIN" && user.id !== target.id).length === 0) {
          throw new ApiError("CONFLICT", "O último administrador ativo não pode perder o acesso administrativo.", 409);
        }
        const serviceCodes = assignedServices(originalState, input.role, departmentCode, input.serviceCodes ?? (isExecutorRole({ ...target, role: input.role }) && target.departmentCode === departmentCode ? target.serviceCodes : undefined));
        const updated: User = { ...target, role: input.role, departmentCode, managedDepartmentCodes, serviceCodes, active: nextActive, version: target.version + 1 };
        const correlationId = input.correlationId ?? id("corr");
        const nextState = {
          ...originalState,
          users: originalState.users.map((user) => user.id === target.id ? updated : user),
          sessions: revokeUserSessions(originalState, target.id),
          auditEvents: [...originalState.auditEvents, createAudit("UserRoleUpdated", currentActor.id, "User", target.id, correlationId, `${target.role}:${target.departmentCode}:${target.active}`, `${updated.role}:${updated.departmentCode}:${updated.active}`, { action: "UPDATE_USER_ACCESS", departmentCode: updated.departmentCode, previousManagedDepartmentCodes: target.managedDepartmentCodes?.join(",") ?? "", managedDepartmentCodes: managedDepartmentCodes?.join(",") ?? "", previousServiceCodes: target.serviceCodes?.join(",") ?? "", serviceCodes: serviceCodes?.join(",") ?? "" })]
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
        requirePermission(currentActor, "user_role.manage", {});
        if (!ROLES.includes(input.role)) throw new ApiError("VALIDATION_ERROR", "O role informado é inválido.", 400);
        const departmentCode = requireText(input.departmentCode ?? currentActor.departmentCode, "departmentCode", 60).toUpperCase();
        if (!/^[A-Z0-9_-]{1,60}$/.test(departmentCode)) throw new ApiError("VALIDATION_ERROR", "O departamento informado é inválido.", 400);
        if (!canManageUserTarget(currentActor, input.role, departmentCode)) throw new ApiError("SCOPE_DENIED", "Você não pode provisionar este tipo de colaborador neste setor.", 404);
        if (input.role === "ADMIN") requireRecentReauthentication(currentActor);
        const idempotent = withIdempotency<ManagedUser>(originalState, currentActor.id, scope, input.idempotencyKey, { input });
        if (idempotent.found) return { state: originalState, result: idempotent.existing! };
        const email = normalizedEmail(input.email);
        if (originalState.users.some((user) => user.email.toLowerCase() === email)) throw new ApiError("CONFLICT", "Já existe um colaborador com este e-mail.", 409);
        const displayName = requireText(input.displayName, "displayName", 160);
        // Retain confidential fingerprints for legacy callers, but every new credential is server generated.
        const password = `Cvg1-${randomBytes(24).toString("base64url")}`;
        const timezone = validatedTimezone(input.timezone ?? process.env.APP_TIMEZONE ?? "America/Sao_Paulo");
        const managedDepartmentCodes = input.role === "MANAGER" ? normalizedManagedDepartments(input.managedDepartmentCodes) : undefined;
        if (input.role !== "MANAGER" && input.managedDepartmentCodes?.length) throw new ApiError("VALIDATION_ERROR", "Somente MANAGER pode ter setores delegados.", 400);
        const user: User = {
          id: id("user"),
          email,
          displayName,
          role: input.role,
          departmentCode,
          passwordHash: hashPassword(password),
          mustChangePassword: true,
          timezone,
          managedDepartmentCodes,
          serviceCodes: assignedServices(originalState, input.role, departmentCode, input.serviceCodes),
          createdAt: now(),
          version: 1,
          active: true
        };
        const correlationId = input.correlationId ?? id("corr");
        const nextState = {
          ...originalState,
          users: [...originalState.users, user],
          auditEvents: [...originalState.auditEvents, createAudit("UserCreated", currentActor.id, "User", user.id, correlationId, undefined, "ACTIVE", { action: "CREATE_USER", role: user.role, departmentCode: user.departmentCode, serviceCodes: user.serviceCodes?.join(",") ?? "" })]
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
        requirePermission(currentActor, "user_role.manage", {});
        if (currentActor.id === userId) throw new ApiError("VALIDATION_ERROR", "A própria sessão não pode ser desativada.", 400);
        const target = findOrThrow(findById(originalState.users, userId));
        if (!canManageUserTarget(currentActor, target.role, target.departmentCode)) throw new ApiError("SCOPE_DENIED", "Você não tem acesso a este colaborador.", 404);
        if (target.role === "ADMIN" && target.active) requireRecentReauthentication(currentActor);
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
          auditEvents: [...originalState.auditEvents, createAudit("UserDeactivated", currentActor.id, "User", target.id, correlationId, target.active ? "ACTIVE" : "INACTIVE", "INACTIVE", { action: "DEACTIVATE_USER", role: target.role, departmentCode: target.departmentCode })]
        };
        const result = managedUser(updated);
        return { state: saveIdempotency(nextState, currentActor.id, scope, input.idempotencyKey, result, { userId, input }), result };
      });
    },

    async regenerateManagedUserPassword(actor: User, userId: string, input: CommandMeta): Promise<ManagedUser & { initialPassword?: string }> {
      const scope = "POST:/users/password";
      return store.transaction(async (originalState) => {
        const currentActor = requireActiveUser(originalState, actor);
        requireIdempotencyKey(input.idempotencyKey);
        requirePermission(currentActor, "user_role.manage", {});
        if (currentActor.id === userId) throw new ApiError("VALIDATION_ERROR", "A recuperação da própria conta deve ser feita por outro administrador.", 400);
        const target = findOrThrow(findById(originalState.users, userId));
        if (!canManageUserTarget(currentActor, target.role, target.departmentCode)) throw new ApiError("SCOPE_DENIED", "Você não tem acesso a este colaborador.", 404);
        // Replacing an ADMIN credential grants control of an administrative account.
        if (target.role === "ADMIN") requireRecentReauthentication(currentActor);
        const idempotent = withIdempotency<ManagedUser>(originalState, currentActor.id, scope, input.idempotencyKey, { userId, input });
        if (idempotent.found) return { state: originalState, result: idempotent.existing! };
        if (input.expectedVersion === undefined) throw new ApiError("VALIDATION_ERROR", "expectedVersion é obrigatório para gerar uma nova senha.", 400);
        ensureExpectedVersion(target.version, input.expectedVersion);
        if (!target.active) throw new ApiError("CONFLICT", "Ative o acesso antes de gerar uma nova senha.", 409);
        const password = `Cvg1-${randomBytes(24).toString("base64url")}`;
        const updated: User = { ...target, passwordHash: hashPassword(password), mustChangePassword: true, version: target.version + 1 };
        const nextState = {
          ...originalState,
          users: originalState.users.map((user) => user.id === target.id ? updated : user),
          sessions: revokeUserSessions(originalState, target.id),
          auditEvents: [...originalState.auditEvents, createAudit("UserPasswordRegenerated", currentActor.id, "User", target.id, input.correlationId ?? id("corr"), undefined, "TEMPORARY_PASSWORD", { action: "REGENERATE_USER_PASSWORD", role: target.role, departmentCode: target.departmentCode })]
        };
        const result = managedUser(updated);
        return { state: saveIdempotency(nextState, currentActor.id, scope, input.idempotencyKey, result, { userId, input }), result: { ...result, initialPassword: password } };
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
        requirePermission(currentActor, "service.catalog.manage", { departmentCode });
        const idempotent = withIdempotency<DiagnosticService>(originalState, currentActor.id, scope, input.idempotencyKey, { input });
        if (idempotent.found) return { state: originalState, result: idempotent.existing! };
        const code = requireText(input.code, "code", 60).toUpperCase();
        if (!/^[A-Z][A-Z0-9_]{1,59}$/.test(code)) throw new ApiError("VALIDATION_ERROR", "Código de serviço inválido.", 400);
        if (originalState.services.some((service) => service.code === code)) throw new ApiError("CONFLICT", "Código de serviço já utilizado.", 409);
        validateServiceDefinition(input.category, input.workflowType);
        const source = input.duplicateOfServiceId ? findOrThrow(findById(originalState.services, input.duplicateOfServiceId)) : undefined;
        if (source) requirePermission(currentActor, "service.catalog.manage", { departmentCode: source.departmentCode });
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
        const authorized = authorizeNewServiceForExecutors(originalState, service);
        const nextState = { ...originalState, users: authorized.users, services: [...originalState.services, service], auditEvents: [...originalState.auditEvents, createAudit("DiagnosticServiceCreated", currentActor.id, "DiagnosticService", service.id, correlationId, undefined, "ACTIVE", { code: service.code, workflowType: service.workflowType, autoAuthorizedExecutors: String(authorized.granted) })] };
        return { state: saveIdempotency(nextState, currentActor.id, scope, input.idempotencyKey, service, { input }), result: service };
      });
    },

    async updateDiagnosticService(actor: User, serviceId: string, input: DiagnosticServicePatchInput) {
      const scope = "PATCH:/diagnostic-services";
      return store.transaction(async (originalState) => {
        const currentActor = requireActiveUser(originalState, actor);
        const service = findOrThrow(findById(originalState.services, serviceId));
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
