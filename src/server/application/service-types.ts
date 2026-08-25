import type { ItemState, OperationalContext, Priority, RoleCode, WorkflowType } from "@cvg/contracts";
import type { Admission, Attachment, AuditEvent, DiagnosticItem, DiagnosticRequest, DiagnosticService, Notification, Procedure, ProcedureSchedule, ReasonCode, Result, ResultVersion, Sample, StoreState, User } from "../domain/models";

export interface CommandMeta {
  idempotencyKey?: string;
  expectedVersion?: number;
  correlationId?: string;
}

export interface NotificationAcknowledgeInput extends CommandMeta {
  reason: string;
  confirm: true;
}

export interface CreateRequestInput {
  patientId: string;
  encounterId: string;
  admissionId?: string;
  priority: Priority;
  items: Array<{ serviceId: string; note?: string }>;
  overrideReason?: string;
}

export interface CreatePatientInput {
  displayName: string;
  species: string;
  breed: string;
  sex: string;
  birthDate?: string;
  ownerLabel: string;
  externalId?: string;
  encounterType: StoreState["encounters"][number]["type"];
  ward?: string;
  bed?: string;
}

export type PatientCreateResult = {
  patient: StoreState["patients"][number];
  encounter: StoreState["encounters"][number];
  admission?: Admission;
};

export interface ReceiveSampleInput extends CommandMeta {
  accessionCode: string;
  sampleType: string;
}

export interface RecollectionInput extends CommandMeta {
  reasonCode: string;
  note?: string;
}

export interface ResultDraftInput extends CommandMeta {
  narrative: string;
  conclusion?: string;
  content: Record<string, unknown>;
}

export interface ReleaseInput extends CommandMeta {
  critical?: boolean;
}

export interface ReviewInput extends CommandMeta {
  versionId: string;
}

export interface AmendInput extends CommandMeta {
  reason: string;
  narrative: string;
  conclusion?: string;
  content: Record<string, unknown>;
  critical?: boolean;
}

export interface ScheduleInput extends CommandMeta {
  startsAt: string;
  endsAt: string;
  resource: string;
  reason?: string;
}

export interface CancelInput extends CommandMeta {
  reasonCode: string;
  reason?: string;
}

export interface RejectInput extends CommandMeta {
  reasonCode: string;
  note?: string;
}

export interface VoidInput extends CommandMeta {
  reason: string;
}

export interface AttachmentUploadInput extends CommandMeta {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string;
}

export interface DiagnosticServiceCreateInput extends CommandMeta {
  code: string;
  name: string;
  category: DiagnosticService["category"];
  departmentCode: string;
  workflowType: WorkflowType;
  requiresSample: boolean;
  requiresSchedule: boolean;
  allowsAttachment: boolean;
  resultSchema: DiagnosticService["resultSchema"];
  slaHours: Record<Priority, number>;
}

export interface DiagnosticServicePatchInput extends CommandMeta {
  name?: string;
  category?: DiagnosticService["category"];
  departmentCode?: string;
  workflowType?: WorkflowType;
  requiresSample?: boolean;
  requiresSchedule?: boolean;
  active?: boolean;
  allowsAttachment?: boolean;
  resultSchema?: DiagnosticService["resultSchema"];
  slaHours?: Record<Priority, number>;
}

export interface ReasonCodeCreateInput extends CommandMeta {
  type: ReasonCode["type"];
  code: string;
  label: string;
}

export interface ReasonCodePatchInput extends CommandMeta {
  label?: string;
  active?: boolean;
}

export interface UserRoleUpdateInput extends CommandMeta {
  role: RoleCode;
  departmentCode: string;
  managedDepartmentCodes?: string[];
  active?: boolean;
  reason: string;
  confirm: true;
}

export interface ManagedUserCreateInput extends CommandMeta {
  email: string;
  displayName: string;
  password: string;
  role: RoleCode;
  departmentCode: string;
  managedDepartmentCodes?: string[];
  timezone: string;
  reason: string;
  confirm: true;
}

export interface ManagedUserDeactivateInput extends CommandMeta {
  reason: string;
  confirm: true;
}

export interface ManagedUser {
  id: string;
  email: string;
  displayName: string;
  role: RoleCode;
  departmentCode: string;
  managedDepartmentCodes?: ReadonlyArray<string>;
  timezone: string;
  active: boolean;
  createdAt: string;
  version: number;
}

export interface ManagementOverview {
  asOf: string;
  scope: { departments: string[]; label: string };
  summary: {
    totalRequests: number;
    activeItems: number;
    overdue: number;
    recollections: number;
    newResults: number;
    critical: number;
    pendingRequests: number;
    completedToday: number;
  };
  departments: Array<{
    departmentCode: string;
    serviceCount: number;
    totalRequests: number;
    activeItems: number;
    overdue: number;
    pending: number;
  }>;
  pending: Array<{
    id: string;
    requestId: string;
    requestCode: string;
    patient: string;
    service: string;
    departmentCode: string;
    status: ItemState;
    priority: Priority;
    dueAt: string;
    overdue: boolean;
    nextAction: string;
    deepLink: string;
  }>;
  recentRequests: Array<{
    id: string;
    requestCode: string;
    patient: string;
    aggregateStatus: DiagnosticRequest["aggregateStatus"];
    priority: Priority;
    updatedAt: string;
    itemCount: number;
    deepLink: string;
  }>;
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
  label: "Estado atual";
  timezone: string;
  asOf: string;
}

export interface QueueItemView extends DiagnosticItem {
  requestId: string;
  requestCode: string;
  patient: { id: string; displayName: string; species: string; sex: string; externalId: string };
  service: { id: string; code: string; name: string };
  overdue: boolean;
  nextAction: string;
  operationalContext: OperationalContext;
  currentOwner: OperationalContext["currentOwner"];
  blockedBy: OperationalContext["blockedBy"];
  waitingSince: OperationalContext["waitingSince"];
  expectedBy: OperationalContext["expectedBy"];
  escalationLevel: OperationalContext["escalationLevel"];
  procedureVersion?: number;
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

export interface RequestListFilters {
  status?: ItemState;
  departmentCode?: string;
  priority?: Priority;
  serviceId?: string;
  overdue?: boolean;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}

export type SearchResultType = "REQUEST" | "ITEM";

export interface SearchFilters {
  types?: SearchResultType[];
  status?: ItemState;
  departmentCode?: string;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}

export interface SearchResult {
  type: SearchResultType;
  id: string;
  label: string;
  patient: string;
  status: ItemState | DiagnosticRequest["aggregateStatus"];
  priority: Priority;
  updatedAt: string;
  departmentCode: string;
  deepLink: string;
}

export interface TimelineFilters {
  limit?: number;
  cursor?: string;
}

export interface TimelineResult {
  items: AuditEvent[];
  nextCursor?: string;
  limit: number;
  total: number;
}

export interface RequestView extends DiagnosticRequest {
  patient: StoreState["patients"][number];
  encounter: StoreState["encounters"][number];
  items: Array<DiagnosticItem & { service: DiagnosticService; procedureVersion?: number }>;
}

export interface ResultView {
  result: Result;
  version: ResultVersion;
  item: DiagnosticItem;
  request: DiagnosticRequest;
  patient: StoreState["patients"][number];
  service: DiagnosticService;
}

export interface ItemView {
  item: DiagnosticItem;
  request: DiagnosticRequest;
  patient: StoreState["patients"][number];
  service: DiagnosticService;
}

export type SampleCommandResult = { sample: Sample; items: DiagnosticItem[]; request: DiagnosticRequest };
export type ResultDraftCommandResult = { result: Result; version: ResultVersion; item: DiagnosticItem; request: DiagnosticRequest };
export type ResultReleaseCommandResult = { result: Result; version: ResultVersion; item: DiagnosticItem; request: DiagnosticRequest };
export type ReviewCommandResult = { result: Result; version: ResultVersion; item: DiagnosticItem; request: DiagnosticRequest };
export type ItemCommandResult = { item: DiagnosticItem; request: DiagnosticRequest };
export type ProcedureScheduleCommandResult = { item: DiagnosticItem; procedure: Procedure; schedule: ProcedureSchedule; request: DiagnosticRequest };
export type ProcedureRescheduleCommandResult = { procedure: Procedure; schedule: ProcedureSchedule; history: ProcedureSchedule[]; item: DiagnosticItem; request: DiagnosticRequest };
export type ProcedureExecutionCommandResult = { item: DiagnosticItem; procedure: Procedure; request: DiagnosticRequest };
export type AmendCommandResult = { result: Result; version: ResultVersion; previousVersion: ResultVersion; item: DiagnosticItem; request: DiagnosticRequest };
export type VoidCommandResult = { result: Result; version: ResultVersion; item: DiagnosticItem; request: DiagnosticRequest; replacementRequired: boolean };
export type PublicAttachment = Omit<Attachment, "storageKey" | "uploadClaimToken" | "uploadClaimExpiresAt">;
export type AttachmentSessionResult = { attachment: PublicAttachment; uploadUrl: string; expiresAt: string };
export type AttachmentFinalizationResult = { attachment: PublicAttachment };
export type PatientDiagnosticsResult = {
  patient: StoreState["patients"][number];
  items: RequestView[];
  events: AuditEvent[];
  nextCursor?: string;
  limit: number;
  total: number;
};
export type ReportView = ResultView & { attachments: PublicAttachment[] };
