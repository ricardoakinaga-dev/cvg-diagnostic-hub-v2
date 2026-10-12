export * from "./hospital-plans";
export * from "./hospital-shifts";
export * from "./hospital-checklists";
export * from "./planner-views";
export * from "./hospital-tasks";
export * from "./hospital-services";
import type { DiagnosticPlanning } from "./diagnostic-planning";
export type { DiagnosticPlanning } from "./diagnostic-planning";
export { ROLES } from "./identity-roles";
export type { RoleCode } from "./identity-roles";
import type { RoleCode } from "./identity-roles";
export * from "./diagnostic-catalog";
import type { Priority, WorkflowType, LaboratoryPanelTemplate } from "./diagnostic-catalog";
export { DEPARTMENT_TYPES } from "./hospital-planner";
export type { Department, DepartmentType, EffectiveAccessPreview, AccessGroupImpactPreview, AccessGroup, PatientGrant, ServiceAccessPolicy, ExamDefinition, ExamDefinitionVersion, ExamDefinitionSnapshot, ExamDefinitionProvenance } from "./hospital-planner";
import type { ServiceAccessPolicy, ExamDefinitionProvenance, ExamDefinitionSnapshot } from "./hospital-planner";
import type { Permission } from "./identity-permissions";
export { PERMISSIONS, LEGACY_PERMISSION_ACTIONS } from "./identity-permissions";
export type { Permission } from "./identity-permissions";

export const OPERATIONAL_OWNER_CODES = [
  "REQUESTING_TEAM",
  "LABORATORY",
  "RADIOLOGY",
  "ULTRASOUND",
  "DIAGNOSTICS_OPERATIONS",
  "UNKNOWN"
] as const;
export type OperationalOwnerCode = (typeof OPERATIONAL_OWNER_CODES)[number];

export const OPERATIONAL_ACTION_CODES = [
  "COLLECT_SAMPLE",
  "SCHEDULE_EXAM",
  "ROUTE_PATIENT",
  "START_PROCESSING",
  "REGISTER_RESULT",
  "MARK_PERFORMED",
  "PRODUCE_REPORT",
  "REVIEW_RESULT",
  "REGISTER_REPLACEMENT_RESULT",
  "COLLECT_REPLACEMENT_SAMPLE",
  "MONITOR_ITEM"
] as const;
export type OperationalActionCode = (typeof OPERATIONAL_ACTION_CODES)[number];

export const OPERATIONAL_BLOCKER_CODES = [
  "WAITING_SAMPLE",
  "WAITING_REPLACEMENT_SAMPLE",
  "WAITING_SCHEDULE",
  "WAITING_REPORT"
] as const;
export type OperationalBlockerCode = (typeof OPERATIONAL_BLOCKER_CODES)[number];

export const OPERATIONAL_ESCALATION_LEVELS = ["NONE", "WATCH", "ATTENTION", "URGENT"] as const;
export type OperationalEscalationLevel = (typeof OPERATIONAL_ESCALATION_LEVELS)[number];

export interface OperationalOwner {
  code: OperationalOwnerCode;
  label: string;
}

export interface OperationalAction {
  code: OperationalActionCode;
  label: string;
}

export interface OperationalBlocker {
  code: OperationalBlockerCode;
  label: string;
}

/** Server-derived work context; it does not replace an approved clinical policy. */
export interface OperationalContext {
  currentOwner: OperationalOwner;
  nextAction: OperationalAction;
  blockedBy: OperationalBlocker | null;
  waitingSince: string | null;
  expectedBy: string | null;
  escalationLevel: OperationalEscalationLevel;
}

export const ITEM_STATES = [
  "REQUESTED",
  "RECEIVED",
  "SCHEDULED",
  "IN_PROGRESS",
  "AWAITING_REPORT",
  "RESULT_AVAILABLE",
  "REVIEWED",
  "COMPLETED",
  "RECOLLECTION_REQUIRED",
  "FAILED",
  "CANCELLED",
  "REJECTED",
  "RESULT_VOIDED"
] as const;
export type ItemState = (typeof ITEM_STATES)[number];

export const TERMINAL_ITEM_STATES = ["COMPLETED", "CANCELLED", "REJECTED"] as const;

export const RESULT_VERSION_STATES = ["DRAFT", "RELEASED", "SUPERSEDED", "VOIDED"] as const;
export type ResultVersionState = (typeof RESULT_VERSION_STATES)[number];



export interface ApiMeta {
  requestId: string;
  correlationId: string;
  nextCursor?: string;
  limit?: number;
}

export interface ApiSuccess<T> {
  data: T;
  meta: ApiMeta;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    correlationId: string;
  };
}

export interface PatientSummary {
  id: string;
  displayName: string;
  species: string;
  sex: string;
  birthDate?: string;
  ownerLabel?: string;
  externalId?: string;
}

export type SessionRole = RoleCode | "VET";

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  role: SessionRole;
  permissions?: Permission[];
  departmentCode: string;
  managedDepartmentCodes?: string[];
  timezone: string;
  mustChangePassword?: boolean;
  /** PROD-402: the user's own alert number, masked; absent until they register one. */
  alertContact?: AlertContact;
  onCall?: boolean;
}

export interface AlertContact {
  maskedPhone: string;
  consentAt: string;
}

export interface SessionResponse {
  user: SessionUser;
}

export type ManagedSessionStatus = "ACTIVE" | "EXPIRED" | "REVOKED";

export interface ManagedSession {
  id: string;
  userId: string;
  userDisplayName: string;
  userEmail: string;
  userRole: RoleCode;
  departmentCode: string;
  createdAt: string;
  expiresAt: string;
  status: ManagedSessionStatus;
  current: boolean;
  revokedAt?: string;
}

export type ManagedSessionList = ManagedSession[];

export type DeadLetterStatus = "PENDING" | "FAILED" | "DISCARDED";

export interface DeadLetterMessage {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  status: DeadLetterStatus;
  attempts: number;
  availableAt: string;
  correlationId: string;
  lastError?: string;
  deadLetteredAt?: string;
  discardedAt?: string;
  discardedBy?: string;
  discardReason?: string;
}

export interface DeadLetterMutationResult {
  message: DeadLetterMessage;
  action: "REPROCESSED" | "DISCARDED";
}

export type DeadLetterList = DeadLetterMessage[];

/** GET /critical-results/readiness (D-056): can a critical result released now reach someone beyond the requester? */
export interface CriticalReadiness {
  asOf: string;
  policy: { status: "ACTIVE" | "OFF" | "INVALID"; version?: string; approvalRef?: string };
  redundantChannel: { status: "WHATSAPP" | "IN_APP_ONLY_ACCEPTED" | "MISSING"; approvalRef?: string };
  onCall: { departments: Array<{ departmentCode: string; requesters: number; onCall: number }>; departmentsWithoutOnCall: string[]; total: number };
  administrators: number;
  ready: boolean;
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
  openedAt: string;
  closedAt?: string;
}

export interface Admission {
  id: string;
  encounterId: string;
  departmentCode: string;
  ward: string;
  bed: string;
  admittedAt: string;
  dischargedAt?: string;
  version?: number;
}

export interface ReasonCode {
  id: string;
  type: "RECOLLECTION" | "CANCEL" | "REJECT" | "AMEND";
  code: string;
  label: string;
  active: boolean;
  version: number;
}

export interface ManagedUser {
  id: string;
  email: string;
  displayName: string;
  role: RoleCode;
  departmentCode: string;
  managedDepartmentCodes?: string[];
  serviceCodes?: string[];
  serviceAccessPolicy?: ServiceAccessPolicy;
  accessGroupId?: string;
  active: boolean;
  timezone: string;
  createdAt: string;
  version: number;
  onCall?: boolean;
  /** Whether the user registered a WhatsApp number for critical alerts; the number itself is never listed. */
  alertContactReady?: boolean;
}

export interface AuditEvent {
  id: string;
  eventType: string;
  actorId?: string;
  entityType: string;
  entityId: string;
  previousState?: string;
  newState?: string;
  occurredAt: string;
  metadata: Record<string, string | number | boolean | null>;
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
  state: "PENDING" | "DELIVERED" | "SEEN" | "ACKNOWLEDGED" | "FAILED" | "SUPERSEDED" | "ESCALATED";
  createdAt: string;
  acknowledgedAt?: string;
  acknowledgedBy?: string;
  attempts: number;
  version: number;
  /** PROD-402: redundant WhatsApp alert of a critical notification. */
  whatsapp?: { status: "QUEUED" | "SENT" | "DELIVERED" | "READ" | "FAILED" | "SKIPPED"; updatedAt: string; messageId?: string; errorCode?: string };
  /** PROD-402: escalation level reached; `unreachableAt` marks the level at which nobody clinical could be notified (D-056). */
  escalation?: { level: number; lastEscalatedAt: string; unreachableAt?: string };
  escalationOf?: string;
}

export type AggregateStatus =
  | "REQUESTED"
  | "IN_PROGRESS"
  | "PARTIALLY_AVAILABLE"
  | "RESULTS_AVAILABLE"
  | "COMPLETED"
  | "CANCELLED";

export interface DashboardRequestItem {
  id: string;
  status: ItemState;
  priority: Priority;
  dueAt: string;
  service: { name: string; code: string };
  note?: string;
}

export interface DashboardRequest {
  id: string;
  requestCode: string;
  patient: { displayName: string; species: string; sex: string; externalId: string };
  priority: Priority;
  aggregateStatus: AggregateStatus;
  createdAt: string;
  items: DashboardRequestItem[];
}

export interface DashboardService {
  id: string;
  name: string;
  code: string;
  workflowType: WorkflowType;
  category: "LABORATORY" | "IMAGING";
  requiresSample: boolean;
  requiresSchedule: boolean;
}

export interface QueueItem extends DiagnosticPlanning {
  id: string;
  requestId: string;
  status: ItemState;
  workflowType: WorkflowType;
  priority: Priority;
  version: number;
  currentResultId?: string;
  currentSampleId?: string;
  procedureId?: string;
  procedureVersion?: number;
  dueAt: string;
  createdAt: string;
  requestCode: string;
  nextAction: string;
  overdue: boolean;
  patient: { id: string; displayName: string; species: string; externalId: string };
  service: { id: string; code: string; name: string };
  operationalContext: OperationalContext;
}

export type IndicatorQueueItem = Pick<QueueItem, "id" | "status" | "priority" | "overdue" | "nextAction">;

export interface ManagementOverview {
  asOf: string;
  scope: { departments: string[]; label: string };
  summary: { totalRequests: number; activeItems: number; overdue: number; recollections: number; newResults: number; critical: number; pendingRequests: number; completedToday: number };
  departments: Array<{ departmentCode: string; serviceCount: number; totalRequests: number; activeItems: number; overdue: number; pending: number }>;
  pending: Array<{ id: string; requestId: string; requestCode: string; patient: string; service: string; departmentCode: string; status: ItemState; priority: Priority; dueAt: string; overdue: boolean; nextAction: string; deepLink: string }>;
  recentRequests: Array<{ id: string; requestCode: string; patient: string; aggregateStatus: AggregateStatus; priority: Priority; updatedAt: string; itemCount: number; deepLink: string }>;
}

export type DashboardIndicatorKey = "overdue" | "recollections" | "newResults" | "critical" | "totalActive";

export interface DashboardIndicator {
  key: DashboardIndicatorKey;
  label: string;
  count: number;
  denominator: number;
  denominatorDefinition: string;
  definition: string;
  nextAction: string;
}

export interface DashboardWindow {
  kind: "CURRENT_STATE";
  label: string;
  timezone: string;
  asOf: string;
}

export interface DashboardAttentionItem {
  id: string;
  requestId: string;
  requestCode: string;
  patient: { id: string; displayName: string; species: string; externalId: string };
  service: { id: string; name: string; workflowType: WorkflowType };
  departmentCode: string;
  status: ItemState;
  priority: Priority;
  dueAt: string;
  overdue: boolean;
  nextAction: string;
  operationalContext: OperationalContext;
  deepLink: string;
}

export interface DashboardDepartment {
  departmentCode: string;
  label: string;
  activeItems: number;
  overdue: number;
  attention: number;
  state: "CLEAR" | "ACTIVE" | "ATTENTION";
}

export interface DashboardView {
  overdue: number;
  recollections: number;
  newResults: number;
  critical: number;
  totalActive: number;
  updatedAt: string;
  window: DashboardWindow;
  indicators: DashboardIndicator[];
  attention: DashboardAttentionItem[];
  departments: DashboardDepartment[];
  dataQuality: { status: "FRESH" | "DEGRADED"; asOf: string; note?: string };
}

export interface SearchResult {
  type: "REQUEST" | "ITEM";
  id: string;
  label: string;
  patient: string;
  status: ItemState | AggregateStatus;
  priority: Priority;
  updatedAt: string;
  departmentCode: string;
  deepLink: string;
}

export type SampleStatus = "EXPECTED" | "RECEIVED" | "REJECTED" | "REPLACED";

export interface RequestSample {
  id: string;
  requestId: string;
  accessionCode: string;
  sampleType: string;
  status: SampleStatus;
  itemIds: string[];
  replacesSampleId?: string;
  receivedAt?: string;
}

export interface SampleLabel {
  sample: { id: string; accessionCode: string; sampleType: string; status: SampleStatus; version: number };
  request: { id: string; requestCode: string; priority: Priority };
  patient: { id: string; displayName: string; species: string; externalId: string };
  services: Array<{ code: string; name: string }>;
  encounter: { externalId: string };
  requestedAt: string;
  label: { widthMm: number; heightMm: number; barcode: { symbology: "code128"; modules: number; bars: Array<{ x: number; width: number }> } };
}

export interface DiagnosticRequestDetail {
  id: string;
  requestCode: string;
  priority: Priority;
  aggregateStatus: AggregateStatus;
  createdAt: string;
  patient: Patient;
  items: Array<DiagnosticPlanning & {
    id: string;
    status: ItemState;
    workflowType: WorkflowType;
    priority: Priority;
    dueAt: string;
    version: number;
    currentResultId?: string;
    currentSampleId?: string;
    service: { name: string; workflowType: WorkflowType };
  }>;
  samples?: RequestSample[];
}

export interface TimelineEvent {
  id: string;
  eventType: string;
  newState?: string;
  occurredAt: string;
}

export interface EncounterOpenResult {
  encounter: Encounter;
  admission?: Admission;
}

export interface EncounterCloseResult {
  encounter: Encounter;
  admission?: Admission;
  pendingItems: number;
}

export interface PatientCreateResult {
  patient: Patient;
  encounter: Encounter;
  admission?: Admission;
}

export interface PatientWorkspaceSample {
  id: string;
  requestId: string;
  accessionCode: string;
  sampleType: string;
  status: "EXPECTED" | "RECEIVED" | "REJECTED" | "REPLACED";
  collectedAt?: string;
  receivedAt?: string;
}

export interface PatientWorkspaceResult {
  id: string;
  versionId: string;
  status: "RELEASED";
  releasedAt?: string;
  needsReReview: boolean;
}

export interface PatientWorkspaceAttachment {
  id: string;
  safeName: string;
  detectedMime: string;
  sizeBytes: number;
  createdAt: string;
}

export interface PatientWorkspaceItemContext {
  operationalContext: OperationalContext;
  sample: PatientWorkspaceSample | null;
  result: PatientWorkspaceResult | null;
  attachments: PatientWorkspaceAttachment[];
}

export interface PatientWorkspaceRequest {
  id: string;
  requestCode: string;
  priority: Priority;
  aggregateStatus: AggregateStatus;
  createdAt: string;
  encounter: { id: string; externalId: string; type: string };
  items: Array<{
    id: string;
    requestId: string;
    status: ItemState;
    workflowType: WorkflowType;
    currentResultId?: string;
    service: { name: string };
    workspaceContext: PatientWorkspaceItemContext;
  }>;
}

export interface PatientWorkspaceSummary {
  asOf: string;
  dataQuality?: { status: "FRESH" | "DEGRADED"; asOf: string; note?: string };
  currentContext: { hasOpenEncounter: boolean; encounterId: string | null; admissionId: string | null; departmentCode: string | null; ward: string | null; bed: string | null; responsibleLabel: string | null };
  summary: { requestCount: number; itemCount: number; activeItemCount: number; availableResultCount: number; sampleCount: number; attachmentCount: number };
}

export interface PatientNextAction {
  id: string;
  requestId: string;
  requestCode: string;
  itemId: string;
  label: string;
  deepLink: string;
  status: ItemState;
  priority: Priority;
  dueAt: string;
  departmentCode: string;
}

export interface PatientDiagnosticsResult {
  patient: Patient;
  encounters: Encounter[];
  admissions: Admission[];
  items: PatientWorkspaceRequest[];
  events: TimelineEvent[];
  timelineNextCursor?: string;
  timelineTotal?: number;
  nextActions: PatientNextAction[];
  workspace: PatientWorkspaceSummary;
  nextCursor?: string;
  limit: number;
  total: number;
}

export interface ResultView {
  permissions?: Permission[];
  definitionProvenance?: ExamDefinitionProvenance;
  result: { id: string; lifecycleStatus: string; needsReReview: boolean; version: number; currentVersionId?: string };
  version: { id: string; sequence: number; status: ResultVersionState; narrative: string; conclusion?: string; authorId: string; createdAt: string; releasedAt?: string; critical: boolean; needsReReview: boolean; version: number; content: Record<string, unknown>; definitionSnapshot?: ExamDefinitionSnapshot };
  item: { id: string; status: ItemState; version: number; serviceId: string };
  request: { id: string; requestCode: string };
  patient: { displayName: string; species: string; sex: string; externalId: string };
  service: { name: string; workflowType: WorkflowType; allowsAttachment?: boolean; resultSchema?: "NUMERIC_PANEL" | "NARRATIVE"; resultTemplate?: LaboratoryPanelTemplate };
}

export interface PublicAttachment {
  id: string;
  safeName: string;
  detectedMime: string;
  sizeBytes: number;
  scanStatus: "PENDING" | "CLEAN" | "QUARANTINED" | "FAILED";
  uploadStatus: "INITIATED" | "UPLOADED" | "FINALIZED";
}

export interface AttachmentSession {
  attachment: PublicAttachment;
  uploadUrl: string;
  expiresAt: string;
}
export * from "./hospital-resources";
export * from "./hospital-care";
export * from "./hospital-documents";
export * from "./hospital-analytics";
export * from "./hospital-institution";
export * from "./hospital-integrations";
export * from "./hospital-his-v4";
export * from "./hospital-ai";
export * from "./hospital-collaboration";
export * from "./work-activity";
