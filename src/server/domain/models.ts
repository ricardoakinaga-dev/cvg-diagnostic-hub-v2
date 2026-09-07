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
    ? OUTBOX_NOTIFICATION_ROUTING_KEY
    : `domain.${eventType}`;
  const normalizedRoutingKey = routingKey === undefined ? expectedRoutingKey : routingKey;
  if (typeof normalizedRoutingKey !== "string" || normalizedRoutingKey.trim() !== normalizedRoutingKey || !normalizedRoutingKey) {
    throw new Error("OUTBOX_ROUTING_KEY_INVALID");
  }
  if (normalizedConsumerType === "NOTIFICATION_DELIVERY" && normalizedRoutingKey !== OUTBOX_NOTIFICATION_ROUTING_KEY) {
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
  status: "PENDING" | "PROCESSING" | "PROCESSED" | "FAILED";
  attempts: number;
  availableAt: Timestamp;
  correlationId: string;
  lockedAt?: Timestamp;
  workerId?: string;
  claimToken?: string;
  lastError?: string;
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

export interface StateStore {
  getState(): StoreState;
  readState(): Promise<StoreState>;
  transaction<T>(operation: (state: StoreState) => Promise<{ state: StoreState; result: T }> | { state: StoreState; result: T }): Promise<T>;
  reset?(state: StoreState): Promise<void>;
  healthcheck?(): Promise<void>;
}

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
