import { createHash, createHmac, randomUUID } from "node:crypto";
import type { ItemState, ManagedSession, Permission, Priority, RoleCode, WorkflowType } from "@cvg/contracts";
import { outboxEnvelopeFor, type Admission, type Attachment, type AuditEvent, type DiagnosticItem, type DiagnosticRequest, type DiagnosticService, type Notification, type Procedure, type ProcedureSchedule, type ReasonCode, type Result, type ResultVersion, type Sample, type StateStore, type StoreState, type User } from "../domain/models";
import type { FileStore } from "../storage/file-store";
import type { CommandMeta, NotificationAcknowledgeInput, CreateRequestInput, ReceiveSampleInput, RecollectionInput, ResultDraftInput, ReleaseInput, ReviewInput, AmendInput, ScheduleInput, CancelInput, RejectInput, VoidInput, AttachmentUploadInput, DiagnosticServiceCreateInput, DiagnosticServicePatchInput, ReasonCodeCreateInput, ReasonCodePatchInput, UserRoleUpdateInput, ManagedUserCreateInput, ManagedUserDeactivateInput, ManagedUser, ManagementOverview, DashboardIndicatorKey, DashboardIndicator, DashboardWindow, DashboardView, RequestListFilters, SearchResultType, SearchFilters, SearchResult, TimelineFilters, TimelineResult, RequestView, ResultView, ItemView, SampleCommandResult, ResultDraftCommandResult, ResultReleaseCommandResult, ReviewCommandResult, ItemCommandResult, ProcedureScheduleCommandResult, ProcedureRescheduleCommandResult, ProcedureExecutionCommandResult, AmendCommandResult, VoidCommandResult, PublicAttachment, AttachmentSessionResult, AttachmentFinalizationResult, PatientDiagnosticsResult, ReportView } from "./service-types";
import { canAccessResource, managerCanAccessDepartment } from "../security/authorization";
import { ApiError } from "../http/envelope";
import { aggregateRequestStatus, transitionItem } from "../domain/state-machine";
import { legacyServiceSlaPolicy, startSlaClock } from "./sla-policy";
import { criticalPolicyFromEnvironment } from "./critical-result-policy";
export { transitionItem };

export const MAX_NOTE_LENGTH = 2000;
export const MAX_RESULT_NARRATIVE_LENGTH = 20000;
export const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024;
export const ALLOWED_ATTACHMENT_MIME = new Set(["application/pdf", "image/jpeg", "image/png"]);

export { DEFAULT_PAGE_SIZE, dateFilter, decodeAuditCursor, decodeKeysetCursor, decodeRequestCursor, decodeSearchCursor, decodeTimelineCursor, encodeKeysetCursor, pageSize } from "./service-pagination";
export type { AuditCursor, RequestCursor, SearchCursor, TimelineCursor } from "./service-pagination";

export const INDICATOR_DEFINITIONS: Record<DashboardIndicatorKey, Omit<DashboardIndicator, "key" | "count" | "denominator">> = {
  overdue: {
    label: "Atrasados",
    denominatorDefinition: "itens ativos visíveis no escopo autorizado",
    definition: "Itens não terminais cujo prazo calculado pelo servidor já passou.",
    nextAction: "Abrir a fila e tratar por prioridade e SLA."
  },
  recollections: {
    label: "Recoletas",
    denominatorDefinition: "itens laboratoriais visíveis no escopo autorizado",
    definition: "Itens laboratoriais que aguardam uma nova amostra após recoleta solicitada.",
    nextAction: "Receber a nova amostra ou acompanhar o item."
  },
  newResults: {
    label: "Resultados novos",
    denominatorDefinition: "itens visíveis no escopo autorizado",
    definition: "Itens com resultado liberado que ainda aguardam revisão.",
    nextAction: "Abrir e revisar o resultado autorizado."
  },
  critical: {
    label: "Críticos",
    denominatorDefinition: "notificações críticas do usuário, confirmadas ou não",
    definition: "Notificações críticas do usuário que ainda não estão confirmadas.",
    nextAction: "Abrir a notificação e seguir a política crítica aprovada."
  },
  totalActive: {
    label: "Ativos",
    denominatorDefinition: "itens visíveis no escopo autorizado",
    definition: "Itens não terminais atualmente visíveis no escopo autorizado.",
    nextAction: "Abrir a fila e acompanhar os itens ativos."
  }
};

export function criticalPolicyIsReady(): boolean {
  return criticalPolicyFromEnvironment() !== undefined;
}

export function now(): string {
  return new Date().toISOString();
}

export function dashboardTimezone(actor: User): string {
  const candidate = actor.timezone?.trim() || process.env.APP_TIMEZONE?.trim() || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format();
    return candidate;
  } catch {
    return "UTC";
  }
}

export function managedUser(user: User): ManagedUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    departmentCode: user.departmentCode,
    managedDepartmentCodes: user.managedDepartmentCodes ? [...user.managedDepartmentCodes] : undefined,
    serviceCodes: user.serviceCodes ? [...user.serviceCodes] : undefined,
    timezone: user.timezone,
    active: user.active !== false,
    createdAt: user.createdAt,
    version: user.version
  };
}

export function managedSession(session: StoreState["sessions"][number], user: User, currentSessionId?: string): ManagedSession {
  const nowMs = Date.now();
  const status = session.revokedAt
    ? "REVOKED"
    : Date.parse(session.expiresAt) <= nowMs || user.active === false
      ? "EXPIRED"
      : "ACTIVE";
  return {
    id: session.id,
    userId: user.id,
    userDisplayName: user.displayName,
    userEmail: user.email,
    userRole: user.role,
    departmentCode: user.departmentCode,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    status,
    current: session.id === currentSessionId,
    ...(session.revokedAt ? { revokedAt: session.revokedAt } : {})
  };
}

export function id(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

export function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashPayload(value: unknown): string {
  return createHash("sha256").update(stableSerialize(idempotencyFingerprint(value))).digest("hex");
}

export function idempotencyFingerprint(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const payload = value as Record<string, unknown>;
  const input = payload.input;
  if (input === null || typeof input !== "object" || Array.isArray(input)) return payload;
  const semanticInput = Object.fromEntries(Object.entries(input as Record<string, unknown>)
    .filter(([key]) => key !== "correlationId" && key !== "idempotencyKey")
    .map(([key, entry]) => {
      if (key !== "password" || typeof entry !== "string") return [key, entry];
      const secret = process.env.SESSION_SECRET;
      if (process.env.NODE_ENV === "production" && (!secret || secret.length < 32)) {
        throw new Error("SESSION_SECRET deve conter ao menos 32 caracteres em produção.");
      }
      const digest = secret
        ? createHmac("sha256", secret).update(entry).digest("hex")
        : createHash("sha256").update(entry).digest("hex");
      return [key, { confidentialDigest: digest }];
    }));
  return { ...payload, input: semanticInput };
}

export function requireText(value: string, field: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized || Array.from(normalized).length > maxLength) {
    throw new ApiError("VALIDATION_ERROR", `${field} é obrigatório e deve ter no máximo ${maxLength} caracteres.`, 400);
  }
  return normalized;
}

export const operationalManagedRoles: RoleCode[] = ["VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "VIEWER"];

export function canManageUserTarget(actor: User, role: RoleCode, departmentCode: string): boolean {
  if (actor.role === "ADMIN") return true;
  return actor.role === "MANAGER" && operationalManagedRoles.includes(role) && managerCanAccessDepartment(actor, departmentCode);
}

export function normalizedEmail(value: string): string {
  const email = requireText(value, "email", 320).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError("VALIDATION_ERROR", "O e-mail informado é inválido.", 400);
  return email;
}

export function validatedTimezone(value: string): string {
  const timezone = requireText(value, "timezone", 80);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new ApiError("VALIDATION_ERROR", "O fuso horário informado é inválido.", 400);
  }
  return timezone;
}

export function validatedPassword(value: string): string {
  if (typeof value !== "string" || Array.from(value).length < 12 || Array.from(value).length > 200 || !/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) {
    throw new ApiError("VALIDATION_ERROR", "A senha deve ter pelo menos 12 caracteres, letras e números.", 400);
  }
  return value;
}

export function normalizedManagedDepartments(value: string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  if (value.length > 20) throw new ApiError("VALIDATION_ERROR", "O colaborador não pode ter mais de 20 setores delegados.", 400);
  const normalized = Array.from(new Set(value.map((code) => requireText(code, "managedDepartmentCode", 60).toUpperCase())));
  if (normalized.some((code) => !/^[A-Z0-9_-]{1,60}$/.test(code))) throw new ApiError("VALIDATION_ERROR", "Um setor delegado é inválido.", 400);
  return normalized;
}

export function revokeUserSessions(state: StoreState, userId: string): StoreState["sessions"] {
  const revokedAt = now();
  return state.sessions.map((session) => session.userId === userId && !session.revokedAt
    ? { ...session, revokedAt, version: session.version + 1 }
    : session);
}

export function requireRecentReauthentication(actor: User): void {
  const reauthenticatedAt = actor.reauthenticatedAt ? Date.parse(actor.reauthenticatedAt) : Number.NaN;
  if (!actor.sessionId || Number.isNaN(reauthenticatedAt) || Date.now() - reauthenticatedAt > 10 * 60 * 1000 || reauthenticatedAt > Date.now() + 30_000) {
    throw new ApiError("REAUTH_REQUIRED", "Confirme sua identidade novamente antes de alterar acessos.", 403, { retryable: true });
  }
}

export function requireActiveUser(state: StoreState, actor: User): User {
  const current = state.users.find((user) => user.id === actor.id);
  if (current?.mustChangePassword) throw new ApiError("PASSWORD_CHANGE_REQUIRED", "Troque sua senha inicial antes de continuar.", 403);
  const session = actor.sessionId ? state.sessions.find((entry) => entry.id === actor.sessionId && entry.userId === actor.id) : undefined;
  if (
    !current
    || !current.active
    // A newer user version alone is not a reason to reject: registering a patient bumps it to publish the new
    // patient scope, and requests already in flight (double click, second tab) carry the previous snapshot.
    // Role, department and active are compared below and everything else is narrowed to the scope the
    // request was authenticated with, so a stale snapshot can only ever see less, never more.
    || current.role !== actor.role
    || current.departmentCode !== actor.departmentCode
    || (actor.sessionId !== undefined && (!session || session.revokedAt !== undefined || Date.parse(session.expiresAt) <= Date.now()))
  ) {
    throw new ApiError("UNAUTHENTICATED", "Sessão inválida ou expirada.", 401);
  }
  const narrowed = (persisted: readonly string[] | undefined, asserted: readonly string[] | undefined): string[] | undefined => asserted === undefined
    ? persisted ? [...persisted] : undefined
    : (persisted ?? []).filter((entry) => asserted.includes(entry));
  return {
    ...current,
    managedDepartmentCodes: narrowed(current.managedDepartmentCodes, actor.managedDepartmentCodes),
    patientIds: narrowed(current.patientIds, actor.patientIds),
    serviceCodes: narrowed(current.serviceCodes, actor.serviceCodes),
    sessionId: actor.sessionId,
    reauthenticatedAt: session?.reauthenticatedAt
  };
}

export function requirePermission(actor: User, permission: Permission, resource: { patientId?: string; departmentCode?: string; serviceCode?: string; ownerId?: string }): void {
  if (!canAccessResource(actor, permission, resource)) {
    throw new ApiError("SCOPE_DENIED", "Você não tem acesso a este recurso.", 404);
  }
}

export function isExecutorRole(actor: User): boolean {
  return ["LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM"].includes(actor.role);
}

function itemResource(state: StoreState, item: DiagnosticItem) {
  const request = requestFor(state, item.requestId);
  const service = serviceFor(state, item.serviceId);
  return { patientId: request.patientId, departmentCode: item.departmentCode, serviceCode: service.code };
}

export function canViewItem(state: StoreState, actor: User, item: DiagnosticItem): boolean {
  return canAccessResource(actor, "item.view", itemResource(state, item));
}

export function requireItemPermission(state: StoreState, actor: User, permission: Permission, item: DiagnosticItem): void {
  requirePermission(actor, permission, itemResource(state, item));
}

export function hasServicePatientContext(state: StoreState, actor: User, patientId: string): boolean {
  return state.requests.some((request) => request.patientId === patientId && request.itemIds.some((itemId) => canViewItem(state, actor, itemFor(state, itemId))));
}

export function hasManagerRequestContext(state: StoreState, actor: User, request: DiagnosticRequest): boolean {
  return managerCanAccessDepartment(actor, request.requestingDepartmentCode) || request.itemIds.some((itemId) => managerCanAccessDepartment(actor, itemFor(state, itemId).departmentCode));
}

export function hasManagerPatientContext(state: StoreState, actor: User, patientId: string): boolean {
  return state.requests.some((request) => request.patientId === patientId && hasManagerRequestContext(state, actor, request));
}

export function requirePatientPermission(state: StoreState, actor: User, permission: Permission, patientId: string): void {
  if (actor.role === "MANAGER") {
    if (!hasManagerPatientContext(state, actor, patientId)) throw new ApiError("SCOPE_DENIED", "Você não tem acesso a este recurso.", 404);
    requirePermission(actor, permission, { departmentCode: actor.departmentCode });
    return;
  }
  if (isExecutorRole(actor)) {
    const visibleItem = state.items.find((item) => requestFor(state, item.requestId).patientId === patientId && canViewItem(state, actor, item));
    if (!visibleItem) throw new ApiError("SCOPE_DENIED", "Você não tem acesso a este recurso.", 404);
    requireItemPermission(state, actor, permission, visibleItem);
    return;
  }
  requirePermission(actor, permission, { patientId });
}

export function requireRequestPermission(state: StoreState, actor: User, permission: Permission, request: DiagnosticRequest): void {
  if (actor.role === "MANAGER") {
    if (!hasManagerRequestContext(state, actor, request)) throw new ApiError("SCOPE_DENIED", "Você não tem acesso a este recurso.", 404);
    requirePermission(actor, permission, { departmentCode: actor.departmentCode });
    return;
  }
  if (isExecutorRole(actor)) {
    const visibleItem = request.itemIds.map((itemId) => itemFor(state, itemId)).find((item) => canViewItem(state, actor, item));
    if (!visibleItem) throw new ApiError("SCOPE_DENIED", "Você não tem acesso a este recurso.", 404);
    requireItemPermission(state, actor, permission, visibleItem);
    return;
  }
  requirePermission(actor, permission, { patientId: request.patientId, departmentCode: request.requestingDepartmentCode });
}

export function findOrThrow<T>(value: T | undefined, code = "NOT_FOUND", message = "Recurso não encontrado."): T {
  if (!value) throw new ApiError(code, message, 404); return value;
}

export function findOrThrowScoped<T>(value: T | undefined, message = "Você não tem acesso a este recurso."): T { if (!value) throw new ApiError("SCOPE_DENIED", message, 404); return value; }

export function createAudit(
  eventType: string,
  actorId: string | undefined,
  entityType: string,
  entityId: string,
  correlationId: string,
  previousState?: string,
  newState?: string,
  metadata: AuditEvent["metadata"] = {}
): AuditEvent {
  return {
    id: id("audit"),
    eventType,
    actorId,
    entityType,
    entityId,
    previousState,
    newState,
    correlationId,
    metadata,
    occurredAt: now()
  };
}

export function createOutbox(eventType: string, aggregateType: string, aggregateId: string, correlationId: string, payload: Record<string, unknown>): StoreState["outbox"][number] {
  const envelope = outboxEnvelopeFor(eventType, payload);
  return {
    id: id("outbox"),
    eventType,
    aggregateType,
    aggregateId,
    payload,
    ...envelope,
    status: "PENDING",
    attempts: 0,
    availableAt: now(),
    correlationId
  };
}

export function notificationFor(
  state: StoreState,
  notification: Omit<Notification, "id" | "createdAt" | "attempts" | "state" | "version">
): StoreState {
  if (state.notifications.some((item) => item.dedupeKey === notification.dedupeKey && item.recipientUserId === notification.recipientUserId)) {
    return state;
  }
  const nextNotification: Notification = {
    ...notification,
    id: id("notification"),
    createdAt: now(),
    attempts: 0,
    state: "PENDING",
    version: 1
  };
  return { ...state, notifications: [...state.notifications, nextNotification] };
}

export function withIdempotency<T>(
  state: StoreState,
  actorId: string,
  scope: string,
  key: string | undefined,
  payload: unknown
): { found: boolean; existing?: T; state: StoreState } {
  if (!key) {
    return { found: false, state };
  }
  const payloadHash = hashPayload(payload);
  const existing = state.idempotency.find((record) => record.actorId === actorId && record.scope === scope && record.key === key);
  if (existing) {
    if (existing.payloadHash !== payloadHash) {
      throw new ApiError("IDEMPOTENCY_KEY_REUSED", "A chave de repetição já foi usada com outro conteúdo.", 409);
    }
    return { found: true, existing: existing.response as T, state };
  }
  return { found: false, state };
}

export function saveIdempotency(state: StoreState, actorId: string, scope: string, key: string | undefined, response: unknown, payload: unknown): StoreState {
  if (!key) return state;
  const payloadHash = hashPayload(payload);
  const exists = state.idempotency.some((record) => record.actorId === actorId && record.scope === scope && record.key === key);
  if (!exists) {
    return {
      ...state,
      idempotency: [...state.idempotency, { actorId, scope, key, payloadHash, response, createdAt: now() }]
    };
  }
  return {
    ...state,
    idempotency: state.idempotency.map((record) =>
      record.actorId === actorId && record.scope === scope && record.key === key ? { ...record, payloadHash, response } : record
    )
  };
}

export function requireIdempotencyKey(key: string | undefined): void {
  if (!key?.trim() || Array.from(key).length > 200) {
    throw new ApiError("IDEMPOTENCY_KEY_REQUIRED", "Esta operação exige um Idempotency-Key válido.", 400);
  }
}

export function validatedSlaHours(value: Record<Priority, number>): Record<Priority, number> {
  const priorities: Priority[] = ["ROUTINE", "URGENT", "EMERGENCY"];
  if (!value || priorities.some((priority) => !Number.isFinite(value[priority]) || value[priority] <= 0 || value[priority] > 720)) {
    throw new ApiError("VALIDATION_ERROR", "SLA deve informar horas positivas de até 720 horas para cada prioridade.", 400);
  }
  return { ROUTINE: value.ROUTINE, URGENT: value.URGENT, EMERGENCY: value.EMERGENCY };
}

export function validateServiceDefinition(category: DiagnosticService["category"], workflowType: WorkflowType): void {
  const valid = (category === "LABORATORY" && workflowType === "LABORATORY") || (category === "IMAGING" && ["RADIOLOGY", "ULTRASOUND"].includes(workflowType));
  if (!valid) throw new ApiError("VALIDATION_ERROR", "Categoria e workflow do serviço não são compatíveis.", 400);
}

export function validateServiceResultSchema(
  category: DiagnosticService["category"],
  workflowType: WorkflowType,
  resultSchema: DiagnosticService["resultSchema"],
  resultTemplate?: DiagnosticService["resultTemplate"]
): void {
  if (resultSchema !== "NUMERIC_PANEL") return;
  if (category !== "LABORATORY" || workflowType !== "LABORATORY" || resultTemplate?.status !== "ACTIVE") {
    throw new ApiError("VALIDATION_ERROR", "Um painel numérico exige um template laboratorial ativo e versionado.", 422);
  }
}

export function serviceFor(state: StoreState, serviceId: string): DiagnosticService {
  return findOrThrow(state.services.find((service) => service.id === serviceId && service.active), "NOT_FOUND", "Serviço diagnóstico indisponível.");
}

export function requestFor(state: StoreState, requestId: string): DiagnosticRequest {
  return findOrThrow(state.requests.find((request) => request.id === requestId));
}

export function itemFor(state: StoreState, itemId: string): DiagnosticItem {
  return findOrThrow(state.items.find((item) => item.id === itemId));
}

export function resultFor(state: StoreState, resultId: string): Result {
  return findOrThrow(state.results.find((result) => result.id === resultId));
}

export function procedureFor(state: StoreState, procedureId: string): Procedure {
  return findOrThrow(state.procedures.find((procedure) => procedure.id === procedureId));
}

export function scheduleWindow(input: ScheduleInput): { startsAt: string; endsAt: string; resource: string } {
  const starts = new Date(input.startsAt);
  const ends = new Date(input.endsAt);
  const resource = requireText(input.resource, "resource", 100);
  if (!Number.isFinite(starts.getTime()) || !Number.isFinite(ends.getTime()) || ends <= starts) {
    throw new ApiError("VALIDATION_ERROR", "A janela da agenda é inválida.", 400);
  }
  if (ends.getTime() - starts.getTime() > 24 * 60 * 60 * 1000) {
    throw new ApiError("VALIDATION_ERROR", "A janela da agenda não pode exceder 24 horas.", 400);
  }
  return { startsAt: starts.toISOString(), endsAt: ends.toISOString(), resource };
}

export function hasScheduleConflict(state: StoreState, window: { startsAt: string; endsAt: string; resource: string }, excludeProcedureId?: string): boolean {
  const starts = new Date(window.startsAt).getTime();
  const ends = new Date(window.endsAt).getTime();
  return state.schedules.some((schedule) => {
    if (schedule.status !== "SCHEDULED" || schedule.resource !== window.resource) return false;
    if (excludeProcedureId && schedule.procedureId === excludeProcedureId) return false;
    return starts < new Date(schedule.endsAt).getTime() && ends > new Date(schedule.startsAt).getTime();
  });
}

export function activeReason(state: StoreState, type: "CANCEL" | "REJECT" | "AMEND", code: string) {
  return findOrThrow(
    state.reasonCodes.find((reason) => reason.type === type && reason.code === code && reason.active),
    "VALIDATION_ERROR",
    "Motivo informado não está disponível."
  );
}

export function attachmentFor(state: StoreState, attachmentId: string): Attachment {
  return findOrThrow(state.attachments.find((attachment) => attachment.id === attachmentId));
}

export function publicAttachment(attachment: Attachment): PublicAttachment {
  const {
    storageKey: _storageKey,
    uploadClaimToken: _uploadClaimToken,
    uploadClaimExpiresAt: _uploadClaimExpiresAt,
    ...safeAttachment
  } = attachment;
  return safeAttachment;
}

export async function deleteStoredObject(storage: FileStore, storageKey: string): Promise<void> {
  if (storage.delete) {
    await storage.delete(storageKey);
    return;
  }
  await storage.remove(storageKey);
}

export async function releaseUploadClaim(store: StateStore, attachmentId: string, claimToken: string): Promise<void> {
  await store.transaction((state) => {
    const attachment = state.attachments.find((entry) => entry.id === attachmentId);
    if (!attachment || attachment.uploadClaimToken !== claimToken) return { state, result: undefined };
    const released = { ...attachment, uploadClaimToken: undefined, uploadClaimExpiresAt: undefined };
    return {
      state: {
        ...state,
        attachments: state.attachments.map((entry) => entry.id === attachment.id ? released : entry)
      },
      result: undefined
    };
  });
}

export function safeAttachmentName(filename: string): string {
  const basename = filename.split(/[\\/]/).pop()?.trim() ?? "attachment";
  const safe = basename.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 120);
  if (!safe) throw new ApiError("VALIDATION_ERROR", "Nome de arquivo inválido.", 400);
  return safe;
}

export function assertAttachmentMetadata(input: AttachmentUploadInput): { safeName: string; mimeType: string; checksum: string } {
  const safeName = safeAttachmentName(input.filename);
  const mimeType = input.mimeType.trim().toLowerCase();
  const checksum = input.checksum.trim().toLowerCase();
  if (!ALLOWED_ATTACHMENT_MIME.has(mimeType)) throw new ApiError("VALIDATION_ERROR", "Tipo de arquivo não permitido.", 400);
  if (!Number.isInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > MAX_ATTACHMENT_SIZE) throw new ApiError("VALIDATION_ERROR", "Tamanho de arquivo não permitido.", 400);
  if (!/^[a-f0-9]{64}$/.test(checksum)) throw new ApiError("VALIDATION_ERROR", "Checksum SHA-256 inválido.", 400);
  return { safeName, mimeType, checksum };
}

export function requireAttachmentOwner(actor: User, version: ResultVersion, attachment?: Attachment): void {
  if (version.authorId !== actor.id || (attachment && attachment.createdBy !== actor.id)) {
    throw new ApiError("SCOPE_DENIED", "Você não tem acesso a este recurso.", 404);
  }
}

export function attachmentSessionIsExpired(attachment: Attachment, at = Date.now()): boolean {
  return attachment.uploadStatus !== "FINALIZED"
    && attachment.expiresAt !== undefined
    && Date.parse(attachment.expiresAt) < at;
}

export function attachmentUploadClaimIsActive(attachment: Attachment, at = Date.now()): boolean {
  return attachment.uploadClaimToken !== undefined
    && (attachment.uploadClaimExpiresAt === undefined || Date.parse(attachment.uploadClaimExpiresAt) > at);
}

export function attachmentStorageKeys(attachment: Attachment): string[] {
  const claimedStorageKey = attachment.uploadClaimToken
    ? `${attachment.storageKey}.claim-${attachment.uploadClaimToken}`
    : undefined;
  return [...new Set([attachment.storageKey, claimedStorageKey].filter((key): key is string => key !== undefined))];
}

export function detectedMime(content: Uint8Array): string | undefined {
  if (content.length >= 5 && Buffer.from(content.subarray(0, 5)).toString("ascii") === "%PDF-") return "application/pdf";
  if (content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) return "image/jpeg";
  if (content.length >= 8 && Buffer.from(content.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  return undefined;
}

export function requestView(state: StoreState, request: DiagnosticRequest): RequestView {
  const patient = findOrThrow(state.patients.find((item) => item.id === request.patientId));
  const encounter = findOrThrow(state.encounters.find((item) => item.id === request.encounterId));
  const items = request.itemIds.map((itemId) => {
    const item = itemFor(state, itemId);
    const procedure = item.procedureId ? state.procedures.find((entry) => entry.id === item.procedureId) : undefined;
    return { ...item, service: serviceFor(state, item.serviceId), ...(procedure ? { procedureVersion: procedure.version } : {}) };
  });
  return { ...request, patient, encounter, items };
}

export function requestViewForActor(state: StoreState, actor: User, request: DiagnosticRequest): RequestView {
  const view = requestView(state, request);
  const items = view.items.filter((item) => canViewItem(state, actor, item));
  const itemIds = items.map((item) => item.id);
  if (items.length === view.items.length) return { ...view, itemIds, items };
  const timestamps = items.flatMap((item) => [item.requestedAt, item.receivedAt, item.startedAt, item.performedAt, item.releasedAt, item.reviewedAt, item.completedAt]).filter((timestamp): timestamp is string => Boolean(timestamp));
  return { ...view, aggregateStatus: aggregateRequestStatus(items), itemIds, items, updatedAt: timestamps.sort((left, right) => right.localeCompare(left))[0] ?? request.createdAt, version: Math.max(1, ...items.map((item) => item.version)) };
}

export function canViewRequest(state: StoreState, actor: User, request: DiagnosticRequest): boolean {
  if (actor.role === "MANAGER") return hasManagerRequestContext(state, actor, request) && canAccessResource(actor, "request.view", {});
  return request.itemIds.some((itemId) => canViewItem(state, actor, itemFor(state, itemId)));
}

export function requestForAuditEvent(state: StoreState, event: AuditEvent): DiagnosticRequest | undefined {
  if (event.entityType === "DiagnosticRequest") return state.requests.find((request) => request.id === event.entityId);
  if (event.entityType === "DiagnosticRequestItem") {
    const item = state.items.find((entry) => entry.id === event.entityId);
    return item ? state.requests.find((request) => request.id === item.requestId) : undefined;
  }
  if (event.entityType === "Sample") {
    const sample = state.samples.find((entry) => entry.id === event.entityId);
    return sample ? state.requests.find((request) => request.id === sample.requestId) : undefined;
  }
  if (event.entityType === "Result" || event.entityType === "ResultVersion") {
    const resultId = event.entityType === "Result"
      ? event.entityId
      : state.resultVersions.find((version) => version.id === event.entityId)?.resultId;
    const result = resultId ? state.results.find((entry) => entry.id === resultId) : undefined;
    const item = result ? state.items.find((entry) => entry.id === result.itemId) : undefined;
    return item ? state.requests.find((request) => request.id === item.requestId) : undefined;
  }
  if (event.entityType === "Procedure" || event.entityType === "ProcedureSchedule") {
    const procedureId = event.entityType === "Procedure" ? event.entityId : state.schedules.find((schedule) => schedule.id === event.entityId)?.procedureId;
    const procedure = procedureId ? state.procedures.find((entry) => entry.id === procedureId) : undefined;
    const item = procedure ? state.items.find((entry) => entry.id === procedure.itemId) : undefined;
    return item ? state.requests.find((request) => request.id === item.requestId) : undefined;
  }
  if (event.entityType === "Attachment") {
    const attachment = state.attachments.find((entry) => entry.id === event.entityId);
    const resultVersion = attachment ? state.resultVersions.find((version) => version.id === attachment.resultVersionId) : undefined;
    const result = resultVersion ? state.results.find((entry) => entry.id === resultVersion.resultId) : undefined;
    const item = result ? state.items.find((entry) => entry.id === result.itemId) : undefined;
    return item ? state.requests.find((request) => request.id === item.requestId) : undefined;
  }
  return undefined;
}

export function auditEventItem(state: StoreState, event: AuditEvent): DiagnosticItem | undefined {
  const itemId = auditEventItemIds(state, event)[0];
  return itemId ? state.items.find((item) => item.id === itemId) : undefined;
}

export function auditEventItemIds(state: StoreState, event: AuditEvent): string[] {
  if (event.entityType === "DiagnosticRequestItem") return state.items.some((item) => item.id === event.entityId) ? [event.entityId] : [];
  if (event.entityType === "Sample") return state.samples.find((entry) => entry.id === event.entityId)?.itemIds ?? [];
  let itemId: string | undefined;
  if (event.entityType === "Result") itemId = state.results.find((result) => result.id === event.entityId)?.itemId;
  if (event.entityType === "ResultVersion") {
    const resultId = state.resultVersions.find((version) => version.id === event.entityId)?.resultId;
    itemId = resultId ? state.results.find((result) => result.id === resultId)?.itemId : undefined;
  }
  if (event.entityType === "Procedure") itemId = state.procedures.find((procedure) => procedure.id === event.entityId)?.itemId;
  if (event.entityType === "ProcedureSchedule") {
    const procedureId = state.schedules.find((schedule) => schedule.id === event.entityId)?.procedureId;
    itemId = procedureId ? state.procedures.find((procedure) => procedure.id === procedureId)?.itemId : undefined;
  }
  if (event.entityType === "Attachment") {
    const attachment = state.attachments.find((entry) => entry.id === event.entityId);
    const resultVersion = attachment ? state.resultVersions.find((version) => version.id === attachment.resultVersionId) : undefined;
    const result = resultVersion ? state.results.find((entry) => entry.id === resultVersion.resultId) : undefined;
    itemId = result?.itemId;
  }
  return itemId && state.items.some((item) => item.id === itemId) ? [itemId] : [];
}

export function auditEventDepartmentCode(state: StoreState, event: AuditEvent): string | undefined {
  return auditEventItem(state, event)?.departmentCode;
}

export function canViewManagementAudit(state: StoreState, actor: User, event: AuditEvent): boolean {
  if (actor.role !== "MANAGER") return false;
  if (event.entityType === "ReasonCode") return true;
  if (event.entityType === "DiagnosticService") {
    const service = state.services.find((entry) => entry.id === event.entityId);
    return Boolean(service && managerCanAccessDepartment(actor, service.departmentCode));
  }
  if (event.entityType === "User") {
    const user = state.users.find((entry) => entry.id === event.entityId);
    return Boolean(user && canManageUserTarget(actor, user.role, user.departmentCode));
  }
  return false;
}

export function requestForNotification(state: StoreState, notification: Notification): DiagnosticRequest | undefined {
  if (notification.entityType === "REQUEST") return state.requests.find((request) => request.id === notification.entityId);
  if (notification.entityType === "ITEM") {
    const item = state.items.find((entry) => entry.id === notification.entityId);
    return item ? state.requests.find((request) => request.id === item.requestId) : undefined;
  }
  if (notification.entityType === "SAMPLE") {
    const sample = state.samples.find((entry) => entry.id === notification.entityId);
    return sample ? state.requests.find((request) => request.id === sample.requestId) : undefined;
  }
  const version = state.resultVersions.find((entry) => entry.id === notification.entityId);
  const result = version ? state.results.find((entry) => entry.id === version.resultId) : undefined;
  const item = result ? state.items.find((entry) => entry.id === result.itemId) : undefined;
  return item ? state.requests.find((request) => request.id === item.requestId) : undefined;
}

export function resultView(state: StoreState, result: Result): ResultView {
  const item = itemFor(state, result.itemId);
  const request = requestFor(state, item.requestId);
  const patient = findOrThrow(state.patients.find((entry) => entry.id === request.patientId));
  const service = serviceFor(state, item.serviceId);
  const currentVersion = findOrThrow(
    state.resultVersions.find((version) => version.id === result.currentVersionId) ??
      state.resultVersions.filter((version) => version.resultId === result.id).sort((left, right) => right.sequence - left.sequence)[0]
  );
  return { result, version: currentVersion, item, request, patient, service };
}

export function visibleResultVersions(state: StoreState, resultId: string): ResultVersion[] {
  return state.resultVersions
    .filter((version) => version.resultId === resultId && ["RELEASED", "SUPERSEDED"].includes(version.status))
    .sort((left, right) => right.sequence - left.sequence);
}

export function requireCurrentResultRead(actor: User, view: ResultView): "ResultRead" | "ResultDraftRead" {
  const resource = {
    patientId: view.request.patientId,
    departmentCode: view.service.departmentCode,
    serviceCode: view.service.code
  };
  if (view.version.status === "DRAFT") {
    const draftResource = {
      ...resource,
      ownerId: view.version.authorId
    };
    if (!canAccessResource(actor, "result.draft.edit_own", draftResource)) {
      throw new ApiError("NOT_FOUND", "Resultado não disponível.", 404);
    }
    return "ResultDraftRead";
  }
  if (view.version.status !== "RELEASED") {
    throw new ApiError("NOT_FOUND", "Resultado não disponível.", 404);
  }
  requirePermission(actor, "result.view", resource);
  return "ResultRead";
}

export function ensureExpectedVersion(actual: number, expectedVersion: number | undefined): void {
  if (expectedVersion === undefined) {
    throw new ApiError("VALIDATION_ERROR", "expectedVersion ou If-Match é obrigatório para esta operação.", 400);
  }
  if (actual !== expectedVersion) {
    throw new ApiError("STALE_VERSION", "O registro mudou enquanto você trabalhava. Atualize a tela para continuar.", 409, { currentVersion: actual, retryable: false });
  }
}
export function calculateDueAt(startedAt: string, service: DiagnosticService, priority: Priority): string {
  return startSlaClock(legacyServiceSlaPolicy(service, priority), { type: "REQUESTED", occurredAt: startedAt }).dueAt;
}
export function nextRequestState(state: StoreState, request: DiagnosticRequest, itemUpdates: DiagnosticItem[]): StoreState {
  const nextItems = state.items.map((item) => itemUpdates.find((updated) => updated.id === item.id) ?? item);
  const nextStatus = aggregateRequestStatus(request.itemIds.map((itemId) => nextItems.find((item) => item.id === itemId)!));
  const nextRequest = { ...request, aggregateStatus: nextStatus, updatedAt: now(), version: request.version + 1 };
  return {
    ...state,
    items: nextItems,
    requests: state.requests.map((entry) => (entry.id === request.id ? nextRequest : entry))
  };
} export { operationalContextFor, nextActionFor } from "./operational-context";
