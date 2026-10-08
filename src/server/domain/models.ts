import type { ItemState, LaboratoryPanelTemplate, Priority, ResultVersionState, RoleCode, WorkflowType } from "@cvg/contracts";

export type Timestamp = string;

export interface Actor {
  id: string;
  role: RoleCode;
  departmentCode: string;
  managedDepartmentCodes?: ReadonlyArray<string>;
  patientIds?: ReadonlyArray<string>;
  serviceCodes?: ReadonlyArray<string>;
  active?: boolean;
}

export interface ScopedResource {
  patientId?: string;
  departmentCode?: string;
  serviceCode?: string;
  ownerId?: string;
}

export interface User extends Actor {
  email: string;
  displayName: string;
  passwordHash: string;
  timezone: string;
  createdAt: Timestamp;
  version: number;
  /** Temporary credentials can only establish a session for password replacement. */
  mustChangePassword?: boolean;
  /** PROD-402: E.164 number for critical-result alerts over WhatsApp, set only by the user with consent. */
  whatsappPhone?: string;
  /** PROD-402: when the user consented to receive the alerts on whatsappPhone. */
  whatsappConsentAt?: Timestamp;
  /** PROD-402: set by user administration; the ON_CALL rule of the critical policy picks it within the department. */
  onCall?: boolean;
  /** Ephemeral authentication context; never persisted or returned as a user field. */
  sessionId?: string;
  reauthenticatedAt?: Timestamp;
}

export interface Session {
  id: string;
  userId: string;
  tokenHash: string;
  csrfTokenHash: string;
  createdAt: Timestamp;
  expiresAt: Timestamp;
  revokedAt?: Timestamp;
  reauthenticatedAt?: Timestamp;
  version: number;
}

/**
 * Per-session liveness used by the idle timeout. It deliberately lives outside
 * StoreState: recording activity in the snapshot turned every authenticated
 * read into a global write against the single locked JSONB row.
 */
export interface SessionActivity {
  sessionId: string;
  userId: string;
  lastSeenAt: Timestamp;
}

export interface RuntimeRetentionOptions {
  readonly now?: Date;
  readonly outboxHotWindow?: number;
  readonly sessionRetentionMs?: number;
  readonly idempotencyRetentionMs?: number;
  readonly outboxRetentionMs?: number;
}

export interface RuntimeRetentionSummary {
  readonly auditEventsRemoved: number;
  readonly outboxMessagesRemoved: number;
  readonly sessionsRemoved: number;
  readonly idempotencyRecordsRemoved: number;
  readonly sessionActivityRowsRemoved: number;
}

export interface Patient {
  id: string;
  displayName: string;
  species: string;
  breed: string;
  sex: string;
  birthDate?: string;
  ownerLabel: string;
  externalId: string;
  active: boolean;
}

export interface Encounter {
  id: string;
  patientId: string;
  externalId: string;
  type: "INPATIENT" | "EMERGENCY" | "OUTPATIENT";
  status: "OPEN" | "CLOSED";
  openedAt: Timestamp;
  closedAt?: Timestamp;
}

export interface Admission {
  id: string;
  encounterId: string;
  departmentCode: string;
  ward: string;
  bed: string;
  admittedAt: Timestamp;
  dischargedAt?: Timestamp;
  responsibleUserId?: string;
  contextEffectiveAt?: Timestamp;
  updatedAt?: Timestamp;
  version: number;
}

export interface DiagnosticService {
  id: string;
  code: string;
  name: string;
  category: "LABORATORY" | "IMAGING";
  departmentCode: string;
  workflowType: WorkflowType;
  requiresSample: boolean;
  /** Tube or material the label asks the collector for (D8/D10); free text from the catalog sheet. */
  sampleType?: string;
  requiresSchedule: boolean;
  allowsAttachment: boolean;
  active: boolean;
  resultSchema: "NUMERIC_PANEL" | "NARRATIVE";
  resultTemplate?: LaboratoryPanelTemplate;
  slaHours: Record<Priority, number>;
  version: number;
}

export interface ReasonCode {
  id: string;
  type: "RECOLLECTION" | "CANCEL" | "REJECT" | "AMEND";
  code: string;
  label: string;
  active: boolean;
  version: number;
}

export interface DiagnosticRequest {
  id: string;
  requestCode: string;
  patientId: string;
  encounterId: string;
  admissionId?: string;
  requesterId: string;
  requestingDepartmentCode: string;
  priority: Priority;
  aggregateStatus: "REQUESTED" | "IN_PROGRESS" | "PARTIALLY_AVAILABLE" | "RESULTS_AVAILABLE" | "COMPLETED" | "CANCELLED";
  itemIds: string[];
  createdAt: Timestamp;
  updatedAt: Timestamp;
  version: number;
}

export interface DiagnosticItem {
  id: string;
  requestId: string;
  serviceId: string;
  departmentCode: string;
  workflowType: WorkflowType;
  priority: Priority;
  status: ItemState;
  note?: string;
  requestedAt: Timestamp;
  receivedAt?: Timestamp;
  startedAt?: Timestamp;
  performedAt?: Timestamp;
  releasedAt?: Timestamp;
  reviewedAt?: Timestamp;
  completedAt?: Timestamp;
  slaStartedAt: Timestamp;
  dueAt: Timestamp;
  slaPolicyVersion: number;
  version: number;
  cancellationReason?: string;
  rejectionReason?: string;
  currentResultId?: string;
  currentSampleId?: string;
  procedureId?: string;
}

export interface Sample {
  id: string;
  requestId: string;
  accessionCode: string;
  sampleType: string;
  status: "EXPECTED" | "RECEIVED" | "REJECTED" | "REPLACED";
  replacesSampleId?: string;
  rejectionCode?: string;
  rejectionNote?: string;
  itemIds: string[];
  collectedAt?: Timestamp;
  receivedAt?: Timestamp;
  receivedBy?: string;
  version: number;
}

export interface ProcedureSchedule {
  id: string;
  procedureId: string;
  startsAt: Timestamp;
  endsAt: Timestamp;
  resource: string;
  status: "SCHEDULED" | "CANCELLED" | "COMPLETED";
  reason?: string;
  actorId: string;
  createdAt: Timestamp;
  version: number;
}

export interface Procedure {
  id: string;
  itemId: string;
  workflowType: "RADIOLOGY" | "ULTRASOUND";
  status: "EXPECTED" | "SCHEDULED" | "IN_PROGRESS" | "PERFORMED" | "AWAITING_REPORT";
  scheduleIds: string[];
  performedAt?: Timestamp;
  performedBy?: string;
  version: number;
}

export interface Result {
  id: string;
  itemId: string;
  currentVersionId?: string;
  lifecycleStatus: "DRAFT" | "RELEASED" | "VOIDED";
  needsReReview: boolean;
  version: number;
}

export interface ResultVersion {
  id: string;
  resultId: string;
  sequence: number;
  status: ResultVersionState;
  content: Record<string, unknown>;
  narrative: string;
  conclusion?: string;
  authorId: string;
  createdAt: Timestamp;
  releasedAt?: Timestamp;
  releasedBy?: string;
  amendmentReason?: string;
  supersedesId?: string;
  critical: boolean;
  needsReReview: boolean;
  version: number;
}

export interface Notification {
  id: string;
  category: "INFORMATIONAL" | "ACTIONABLE" | "CRITICAL" | "ADMINISTRATIVE";
  priority: "NORMAL" | "HIGH" | "URGENT";
  recipientUserId: string;
  entityType: "REQUEST" | "ITEM" | "RESULT_VERSION" | "SAMPLE";
  entityId: string;
  deepLink: string;
  title: string;
  body: string;
  dedupeKey: string;
  state: "PENDING" | "DELIVERED" | "SEEN" | "ACKNOWLEDGED" | "FAILED" | "SUPERSEDED" | "ESCALATED";
  createdAt: Timestamp;
  acknowledgedAt?: Timestamp;
  acknowledgedBy?: string;
  attempts: number;
  version: number;
  /** PROD-402: the redundant WhatsApp alert of a critical notification, updated by the worker and the webhook. */
  whatsapp?: NotificationChannelDelivery;
}

export interface NotificationChannelDelivery {
  status: "QUEUED" | "SENT" | "DELIVERED" | "READ" | "FAILED" | "SKIPPED";
  updatedAt: Timestamp;
  /** Provider message id (wamid); never the recipient's number. */
  messageId?: string;
  errorCode?: string;
}

export interface AuditEvent {
  id: string;
  eventType: string;
  actorId?: string;
  entityType: string;
  entityId: string;
  previousState?: string;
  newState?: string;
  correlationId: string;
  metadata: Record<string, string | number | boolean | null>;
  occurredAt: Timestamp;
}

export type OutboxConsumerType = "DOMAIN_EVENT" | "NOTIFICATION_DELIVERY";

export const OUTBOX_NOTIFICATION_ROUTING_KEY = "notification.in_app";
/** PROD-402: the redundant WhatsApp channel of a critical result (D3). */
export const OUTBOX_WHATSAPP_ROUTING_KEY = "notification.whatsapp";
export const CRITICAL_ALERT_WHATSAPP_EVENT = "CriticalResultAlertRequested";

export interface OutboxEnvelope {
  consumerType: OutboxConsumerType;
  routingKey: string;
}

const NOTIFICATION_INTENT_EVENT_TYPES = new Set([
  "ResultReleased",
  "ResultVoided",
  "RecollectionRequested"
]);

/**
 * Returns the durable route for a new or legacy outbox message. Legacy rows
 * may omit both fields because the envelope was added after the snapshot
 * projection; their route is still derived from the immutable event type and
 * payload before a relational projection is written.
 */
export function outboxEnvelopeFor(
  eventType: string,
  payload: Record<string, unknown>,
  consumerType?: unknown,
  routingKey?: unknown
): OutboxEnvelope {
  const hasNotificationId = typeof payload.notificationId === "string" && payload.notificationId.trim().length > 0;
  const inferredConsumerType: OutboxConsumerType = NOTIFICATION_INTENT_EVENT_TYPES.has(eventType) || hasNotificationId
    ? "NOTIFICATION_DELIVERY"
    : "DOMAIN_EVENT";
  const normalizedConsumerType = consumerType === undefined
    ? inferredConsumerType
    : consumerType;
  if (normalizedConsumerType !== "DOMAIN_EVENT" && normalizedConsumerType !== "NOTIFICATION_DELIVERY") {
    throw new Error(`OUTBOX_CONSUMER_TYPE_INVALID:${String(normalizedConsumerType)}`);
  }

  const expectedRoutingKey = normalizedConsumerType === "NOTIFICATION_DELIVERY"
    ? eventType === CRITICAL_ALERT_WHATSAPP_EVENT ? OUTBOX_WHATSAPP_ROUTING_KEY : OUTBOX_NOTIFICATION_ROUTING_KEY
    : `domain.${eventType}`;
  const normalizedRoutingKey = routingKey === undefined ? expectedRoutingKey : routingKey;
  if (typeof normalizedRoutingKey !== "string" || normalizedRoutingKey.trim() !== normalizedRoutingKey || !normalizedRoutingKey) {
    throw new Error("OUTBOX_ROUTING_KEY_INVALID");
  }
  if (normalizedConsumerType === "NOTIFICATION_DELIVERY" && normalizedRoutingKey !== expectedRoutingKey) {
    throw new Error(`OUTBOX_ROUTE_MISMATCH:${normalizedConsumerType}:${normalizedRoutingKey}`);
  }
  if (normalizedConsumerType === "DOMAIN_EVENT" && normalizedRoutingKey !== expectedRoutingKey) {
    throw new Error(`OUTBOX_ROUTE_MISMATCH:${normalizedConsumerType}:${normalizedRoutingKey}`);
  }

  return {
    consumerType: normalizedConsumerType,
    routingKey: normalizedRoutingKey
  };
}

export interface OutboxMessage {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  consumerType: OutboxConsumerType;
  routingKey: string;
  status: "PENDING" | "PROCESSING" | "PROCESSED" | "FAILED" | "DISCARDED";
  attempts: number;
  availableAt: Timestamp;
  correlationId: string;
  lockedAt?: Timestamp;
  workerId?: string;
  claimToken?: string;
  lastError?: string;
  deadLetteredAt?: Timestamp;
  discardedAt?: Timestamp;
  discardedBy?: string;
  discardReason?: string;
}

export interface IdempotencyRecord {
  actorId: string;
  scope: string;
  key: string;
  payloadHash: string;
  response: unknown;
  createdAt: Timestamp;
}

export interface Attachment {
  id: string;
  resultVersionId: string;
  safeName: string;
  storageKey: string;
  detectedMime: string;
  sizeBytes: number;
  checksum: string;
  scanStatus: "PENDING" | "CLEAN" | "QUARANTINED" | "FAILED";
  uploadStatus: "INITIATED" | "UPLOADED" | "FINALIZED";
  uploadClaimToken?: string;
  uploadClaimExpiresAt?: Timestamp;
  expiresAt?: Timestamp;
  createdBy: string;
  createdAt: Timestamp;
}

export interface StoreState {
  users: User[];
  sessions: Session[];
  patients: Patient[];
  encounters: Encounter[];
  admissions: Admission[];
  services: DiagnosticService[];
  reasonCodes: ReasonCode[];
  requests: DiagnosticRequest[];
  items: DiagnosticItem[];
  samples: Sample[];
  procedures: Procedure[];
  schedules: ProcedureSchedule[];
  results: Result[];
  resultVersions: ResultVersion[];
  notifications: Notification[];
  auditEvents: AuditEvent[];
  outbox: OutboxMessage[];
  idempotency: IdempotencyRecord[];
  attachments: Attachment[];
  protocolSequence: number;
}

export interface AuditEntity {
  entityType: string;
  entityId: string;
}

export interface AuditScope {
  entities: AuditEntity[];
  entityTypes?: string[];
  /** ADMIN fallback for events without a resolved clinical request. */
  unresolved?: { resolvedEntities: AuditEntity[] };
}

export interface AuditReadQuery {
  scope: AuditScope;
  order: "asc" | "desc";
  limit: number;
  cursor?: { occurredAt: string; id: string };
}

export interface AuditReadPage {
  items: AuditEvent[];
  total: number;
  hasMore: boolean;
}

export interface AuditTransactionReader {
  hasAuditEvent(query: { eventType: string; entityType: string; entityId: string; actorId: string }): Promise<boolean>;
}

export interface AuditMetricsQuery {
  requestCount: number;
  samples: { id: string; requestId: string }[];
  releasedVersions: { id: string; releasedAtMs: number }[];
}

export interface AuditMetrics {
  recollectionRate?: number;
  resultViewLatencySeconds?: number;
}

export interface ClinicalArchiveOptions {
  readonly now?: Date;
  /** Months a completed request stays in the active aggregate (D5: 24). */
  readonly activeMonths?: number;
  readonly dryRun?: boolean;
  readonly actor?: string;
}

export interface ClinicalArchiveSummary {
  readonly batchId?: string;
  readonly cutoff: Timestamp;
  readonly requestsArchived: number;
  readonly entitiesArchived: number;
  readonly attachmentsArchived: number;
  readonly requestIds: readonly string[];
}

/** Entity collections that move to the archive with their request. */
export const ARCHIVED_COLLECTIONS = ["requests", "items", "samples", "procedures", "schedules", "results", "resultVersions", "notifications", "attachments"] as const;
export type ArchivedCollection = (typeof ARCHIVED_COLLECTIONS)[number];

export interface ClinicalArchiveRow {
  readonly requestId: string;
  readonly collection: ArchivedCollection;
  readonly entityKey: string;
  readonly position: number;
  readonly data: Record<string, unknown>;
  readonly archivedAt: Timestamp;
  readonly archiveBatch: string;
}

export interface ClinicalArchiveQuery {
  readonly patientId?: string;
  readonly requestId?: string;
  readonly limit: number;
}

export interface ClinicalArchiveEntry {
  requestId: string;
  requestCode: string;
  patientId: string;
  encounterId: string;
  requestingDepartmentCode: string;
  archivedAt: Timestamp;
  completedAt: Timestamp;
  /** One entry per distinct service of the archived items; departmentCode is the item's. */
  services: { code: string; name: string; departmentCode: string }[];
  attachmentCount: number;
}

export interface ClinicalArchivePurgeOptions {
  readonly now?: Date;
  /** Months after archiving before an entry may be deleted; unset or 0 purges nothing. */
  readonly purgeAfterMonths?: number;
  readonly dryRun?: boolean;
}

export interface ClinicalArchivePurgeSummary {
  readonly requestsPurged: number;
  readonly entitiesPurged: number;
  /** Storage keys of the purged attachments: the caller deletes the objects. */
  readonly attachmentKeys: string[];
}

export interface StateStore {
  /** Relational outbox reads never restore delivery history into the snapshot. */
  readOutbox(query: { kind: "replay" | "dead-letter"; limit: number }): Promise<OutboxMessage[]>;
  /** `deadLetters` counts FAILED messages awaiting an operator and is present only when non-zero. */
  readOutboxMetrics(): Promise<{ pending: number; oldestAvailableAt?: Timestamp; deadLetters?: number }>;
  readRealtimeSnapshot(limit: number): Promise<{ state: StoreState; version: number }>;
  /** Hydrates only a locked message or the first eligible claim candidate. */
  outboxTransaction<T>(query: OutboxTransactionQuery, operation: (state: StoreState) => Promise<{ state: StoreState; result: T }> | { state: StoreState; result: T }): Promise<T>;
  getState(): StoreState;
  readState(): Promise<StoreState>;
  /**
   * Aggregate read that also returns the write version it observed, from a
   * single statement. Realtime authorization is revalidated against that
   * version, which is what lets many connections share one read.
   */
  readStateSnapshot(): Promise<{ state: StoreState; version: number }>;
  /** Current write version only. Cheap enough to call per connection tick. */
  readStateVersion(): Promise<number>;
  /** Scoped historical reads; PostgreSQL reads the append-only table. */
  readAuditEvents(query: AuditReadQuery): Promise<AuditReadPage>;
  readAuditActors(entities: AuditEntity[]): Promise<{ entityId: string; actorId: string }[]>;
  readAuditMetrics(query: AuditMetricsQuery): Promise<AuditMetrics>;
  /**
   * Narrow authorization read. Implementations must answer from indexed single
   * rows or an equally bounded source; a full aggregate read here would
   * reintroduce the per-connection full-state read the realtime path removed.
   */
  readAuthorizationSnapshot(query: { userId: string; sessionId?: string }): Promise<{ user?: User; session?: Session }>;
  /** Narrow liveness read for one session. Never rewrites the snapshot. */
  readSessionActivity(sessionId: string): Promise<SessionActivity | undefined>;
  /** Narrow liveness write for one session. Never rewrites the snapshot. */
  touchSessionActivity(activity: { sessionId: string; userId: string; lastSeenAt: Timestamp }): Promise<SessionActivity>;
  /**
   * Applies runtime retention to the snapshot and to the session-activity
   * table in one audited step. Removes expired/revoked sessions, expired
   * idempotency records and processed outbox messages beyond their windows.
   */
  compactRuntimeState(options?: RuntimeRetentionOptions): Promise<RuntimeRetentionSummary>;
  /**
   * D5: moves requests completed more than `activeMonths` ago, with their items,
   * samples, procedures, schedules, results, versions, notifications and
   * attachments, out of the active aggregate into the clinical archive.
   */
  archiveClinicalRecords(options?: ClinicalArchiveOptions): Promise<ClinicalArchiveSummary>;
  /** Archive summaries, newest first. Never loads the archive into the aggregate. */
  readClinicalArchive(query: ClinicalArchiveQuery): Promise<ClinicalArchiveEntry[]>;
  /** Every archived entity of one request, in original collection order, or undefined. */
  readArchivedRequest(requestId: string): Promise<ClinicalArchiveRow[] | undefined>;
  /** Deletes archive rows older than `purgeAfterMonths` and returns their attachment keys. */
  purgeClinicalArchive(options?: ClinicalArchivePurgeOptions): Promise<ClinicalArchivePurgeSummary>;
  transaction<T>(operation: (state: StoreState, audit?: AuditTransactionReader) => Promise<{ state: StoreState; result: T }> | { state: StoreState; result: T }): Promise<T>;
  reset?(state: StoreState): Promise<void>;
  healthcheck?(): Promise<void>;
}

export type OutboxTransactionQuery = { kind: "message"; id: string } | {
  kind: "claim";
  now: Timestamp;
  leaseMs: number;
  accepts: (message: OutboxMessage) => boolean;
};

export function userAsActor(user: User): Actor {
  return {
    id: user.id,
    role: user.role,
    departmentCode: user.departmentCode,
    managedDepartmentCodes: user.managedDepartmentCodes,
    patientIds: user.patientIds,
    serviceCodes: user.serviceCodes,
    active: user.active
  };
}
