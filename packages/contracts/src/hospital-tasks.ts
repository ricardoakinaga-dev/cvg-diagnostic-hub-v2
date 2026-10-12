import type { Priority } from "./diagnostic-catalog";
import type { Permission } from "./identity-permissions";
import type { RoleCode } from "./identity-roles";
import type { HospitalServiceSnapshot } from "./hospital-services";
import type { HospitalChecklistExecution, HospitalChecklistSnapshot } from "./hospital-checklists";
import type { HospitalCareExecution } from "./hospital-care";
import type { HospitalSchedule } from "./hospital-resources";
import type { HospitalDocumentContent, HospitalDocumentSnapshot } from "./hospital-documents";

export const HOSPITAL_TASK_PHASES = ["PENDING", "IN_PROGRESS", "COMPLETED", "CANCELLED"] as const;
export type HospitalTaskPhase = (typeof HOSPITAL_TASK_PHASES)[number];
export const HOSPITAL_TASK_COMMANDS = ["START", "COMPLETE", "CANCEL"] as const;
export type HospitalTaskCommand = (typeof HOSPITAL_TASK_COMMANDS)[number];
export interface HospitalTaskReaction { userId: string; code: "LIKE" | "THANKS" | "QUESTION"; createdAt: string }
export interface HospitalTaskState { code: string; label: string; phase: HospitalTaskPhase }
export interface HospitalTaskType {
  id: string; code: string; name: string; careContextRequired: boolean;
  states: HospitalTaskState[]; active: boolean; version: number; createdAt: string; updatedAt: string;
}
export type HospitalTaskTypeSnapshot = Pick<HospitalTaskType, "id" | "code" | "name" | "careContextRequired" | "states" | "version">;
/** General activity authority; it never substitutes a diagnostic item or result. */
export interface HospitalTask {
  id: string; taskCode: string; title: string; description?: string;
  descriptionContent?: HospitalDocumentContent; reactions?: HospitalTaskReaction[];
  typeId: string; typeSnapshot: HospitalTaskTypeSnapshot; status: string; phase: HospitalTaskPhase;
  departmentCode: string; patientId?: string; encounterId?: string;
  authorId: string; responsibleUserId?: string; executorTeamUserIds: string[]; participantUserIds: string[];
  priority: Priority; plannedStartAt?: string; plannedEndAt?: string;
  startedAt?: string; startedBy?: string; completedAt?: string; completedBy?: string;
  cancelledAt?: string; cancelledBy?: string; completionNote?: string; cancellationReason?: string;
  parentTaskId?: string; sortOrder: number; serviceSnapshot?: HospitalServiceSnapshot;
  shiftId?: string; checklistSnapshot?: HospitalChecklistSnapshot; checklistExecutions?: HospitalChecklistExecution[];
  recurrenceId?: string; occurrenceAt?: string;
  careExecution?: HospitalCareExecution; documentSnapshots?: HospitalDocumentSnapshot[];
  archivedAt?: string; archivedBy?: string;
  isDraft?: boolean; draftCancelledAt?: string; draftCancelledBy?: string;
  estimatedMinutes?: number; labels?: string[]; externalReferences?: Array<{ label: string; url: string }>;
  version: number; createdAt: string; updatedAt: string;
}
export interface HospitalTaskDependency {
  id: string; taskId: string; targetType: "HOSPITAL_TASK" | "DIAGNOSTIC_ITEM"; targetId: string;
  blocks: "START" | "COMPLETE"; active: boolean; version: number; createdAt: string; updatedAt: string;
}
export interface HospitalTaskAssignee { id: string; displayName: string; role: RoleCode; departmentCode: string }
export type HospitalTaskDependencyView = (HospitalTaskDependency & { restricted?: false; label: string; satisfied: boolean; responsibleUserId?: string }) | { id: string; restricted: true; blocks: "START" | "COMPLETE"; satisfied: false };
export interface HospitalTaskView {
  task: HospitalTask; permissions: Permission[]; eligibleAssignees: HospitalTaskAssignee[];
  dependencies: HospitalTaskDependencyView[]; children: HospitalTask[]; reservations?: HospitalSchedule[];
  patient?: { id: string; displayName: string; externalId: string; species: string; ownerLabel: string };
  encounter?: { id: string; externalId: string; status: string; type: string };
}
export interface HospitalTaskFilters {
  phase?: HospitalTaskPhase; status?: string; typeId?: string; departmentCode?: string; patientId?: string;
  priority?: Priority; responsibleUserId?: string; assignedToMe?: boolean;
  planId?: string; shiftId?: string; encounterId?: string;
  includeArchived?: boolean; includeDrafts?: boolean; label?: string;
  /** Inclusive planned start, falling back to creation when the activity is unplanned. */
  from?: string; to?: string; query?: string; limit?: number; cursor?: string;
  orderBy?: "UPDATED" | "PRIORITY" | "PLANNED_START"; direction?: "ASC" | "DESC";
}
export interface HospitalTaskOptions { departments: Array<{ code: string; name: string }>; types: HospitalTaskType[]; assignees: HospitalTaskAssignee[] }
export interface HospitalTaskPage { items: HospitalTaskView[]; total: number; limit: number; nextCursor?: string }
export const HOSPITAL_INTAKE_STATES = ["RECEIVED", "DEFERRED", "ACCEPTED", "REJECTED", "DUPLICATE"] as const;
export type HospitalIntakeState = (typeof HOSPITAL_INTAKE_STATES)[number];
export interface HospitalIntake {
  id: string; title: string; description?: string; typeId?: string; departmentCode: string;
  patientId?: string; encounterId?: string; priority: Priority;
  source: "MANUAL" | "DIAGNOSTIC_REQUEST"; sourceRequestId?: string; sourceLabel?: string;
  state: HospitalIntakeState; submittedBy: string; decisionBy?: string; decisionAt?: string; reason?: string;
  reasonPolicy?: HospitalIntakeReasonSnapshot;
  destinationTaskId?: string; destinationRequestId?: string; duplicateOfIntakeId?: string;
  version: number; createdAt: string; updatedAt: string;
}
export type HospitalIntakeView = HospitalIntake & { permissions: Permission[] };
export interface HospitalIntakePage { items: HospitalIntakeView[]; total: number; limit: number; nextCursor?: string }
export interface HospitalIntakeRejectionPolicy {
  version: string; approvedAt: string; approvalReference: string; departmentCodes: string[];
  reasons: Array<{ code: string; label: string }>; defaultReasonCode?: string;
}
export interface HospitalIntakeReasonSnapshot {
  code: string; label: string; policyVersion: string; approvedAt: string; approvalReference: string;
}
export interface HospitalIntakeOptions {
  rejectionPolicyStatus: "OFF" | "INVALID" | "AVAILABLE";
  rejectionPolicy?: HospitalIntakeRejectionPolicy;
}
export const PLANNER_SEARCH_TYPES = ["HOSPITAL_TASK", "DIAGNOSTIC_REQUEST", "DIAGNOSTIC_ITEM", "PATIENT", "ENCOUNTER", "HOSPITAL_PLAN", "HOSPITAL_SHIFT", "CHECKLIST_TEMPLATE", "HOSPITAL_RECURRENCE", "HOSPITAL_DOCUMENT", "HOSPITAL_RESOURCE"] as const;
export interface PlannerSearchResult {
  type: (typeof PLANNER_SEARCH_TYPES)[number];
  id: string; label: string; patient?: string; patientId?: string; departmentCode?: string;
  status?: string; priority?: Priority; responsibleUserId?: string; plannedStartAt?: string; updatedAt: string; deepLink: string;
}
export interface PlannerSearchPage { items: PlannerSearchResult[]; total: number; limit: number; nextCursor?: string }
