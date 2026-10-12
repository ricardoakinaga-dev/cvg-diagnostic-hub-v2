import type { HospitalDocumentContent, HospitalTaskCommand, HospitalTaskFilters, HospitalTaskState, HospitalIntakeState, Priority, PlannerSearchResult } from "@cvg/contracts";
import type { CommandMeta } from "./service-types";

export type HospitalTaskTypeCreateInput = CommandMeta & { code: string; name: string; careContextRequired: boolean; states: HospitalTaskState[] };
export type HospitalTaskTypePatchInput = CommandMeta & { name?: string; states?: HospitalTaskState[]; careContextRequired?: boolean; active?: boolean };
export type HospitalTaskCreateInput = CommandMeta & {
  title: string; description?: string; descriptionContent?: HospitalDocumentContent; typeId: string; departmentCode: string; patientId?: string; encounterId?: string;
  responsibleUserId?: string; executorTeamUserIds?: string[]; participantUserIds?: string[]; priority: Priority;
  plannedStartAt?: string; plannedEndAt?: string; parentTaskId?: string; sortOrder?: number; serviceId?: string; checklistTemplateId?: string; documentIds?: string[];
  estimatedMinutes?: number; labels?: string[]; externalReferences?: Array<{ label: string; url: string }>;
};
export type HospitalTaskPatchInput = CommandMeta & { title?: string; description?: string; descriptionContent?: HospitalDocumentContent | null; plannedStartAt?: string | null; plannedEndAt?: string | null; parentTaskId?: string | null; sortOrder?: number; documentIds?: string[]; estimatedMinutes?: number | null; labels?: string[]; externalReferences?: Array<{ label: string; url: string }> };
export type HospitalTaskContextInput = CommandMeta & { patientId: string | null; encounterId: string | null };
export type HospitalTaskCommandInput = CommandMeta & { command: HospitalTaskCommand; stateCode?: string; note?: string; reason?: string };
export type HospitalTaskAssignmentInput = CommandMeta & { responsibleUserId: string | null; executorTeamUserIds?: string[]; participantUserIds?: string[] };
export type HospitalTaskPriorityInput = CommandMeta & { priority: Priority; reason: string };
export type HospitalTaskDependencyInput = CommandMeta & { targetType: "HOSPITAL_TASK" | "DIAGNOSTIC_ITEM"; targetId: string; blocks: "START" | "COMPLETE"; active: boolean };
export type HospitalIntakeCreateInput = CommandMeta & { title: string; description?: string; typeId?: string; departmentCode: string; patientId?: string; encounterId?: string; priority: Priority; source: "MANUAL" | "DIAGNOSTIC_REQUEST"; sourceRequestId?: string; sourceLabel?: string };
export type HospitalIntakeTriageInput = CommandMeta & { decision: "ACCEPT" | "REJECT" | "DEFER" | "DUPLICATE"; reason?: string; reasonCode?: string; reasonPolicyVersion?: string; destinationDepartmentCode?: string; destinationTaskId?: string; duplicateOfIntakeId?: string };
export type HospitalIntakeFilters = Pick<HospitalTaskFilters, "departmentCode" | "patientId" | "from" | "to" | "query" | "limit" | "cursor"> & { state?: HospitalIntakeState };
export type PlannerSearchFilters = HospitalTaskFilters & { types?: PlannerSearchResult["type"][] };
