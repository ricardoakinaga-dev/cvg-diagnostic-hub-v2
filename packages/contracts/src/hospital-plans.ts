import type { HospitalTaskPhase } from "./hospital-tasks";
import type { Permission } from "./identity-permissions";
import type { HospitalDocumentSnapshot } from "./hospital-documents";

export interface HospitalPlanStep { id: string; title: string; sortOrder: number }
export interface HospitalPlanLink { id: string; stepId: string; targetType: "HOSPITAL_TASK" | "DIAGNOSTIC_ITEM"; targetId: string }
/** Links retain the original activity authority; closing a plan never changes a linked workflow. */
export interface HospitalPlan {
  id: string; code: string; title: string; objective: string; patientId: string; encounterId: string;
  departmentCodes: string[]; responsibleUserId?: string; plannedStartAt?: string; plannedEndAt?: string;
  steps: HospitalPlanStep[]; links: HospitalPlanLink[]; documentSnapshots?: HospitalDocumentSnapshot[]; state: "ACTIVE" | "CLOSED" | "ARCHIVED";
  createdBy: string; closedAt?: string; closedBy?: string; archivedAt?: string; archivedBy?: string;
  version: number; createdAt: string; updatedAt: string;
}
export interface HospitalPlanActivity extends HospitalPlanLink { label: string; phase: HospitalTaskPhase; status: string; departmentCode: string; responsibleUserId?: string; blocked: boolean }
export interface HospitalPlanView {
  plan: Omit<HospitalPlan, "links"> & { links: HospitalPlanLink[] }; permissions: Permission[];
  activities: HospitalPlanActivity[]; steps: Array<HospitalPlanStep & { visibleActivities: number; completedActivities: number; blockedActivities: number; state: "NO_VISIBLE_ACTIVITIES" | "PENDING" | "BLOCKED" | "IN_PROGRESS" | "COMPLETED" }>;
  summary: { visibleActivities: number; completedActivities: number; pendingActivities: number; blockedActivities: number; denominator: "AUTHORIZED_UNIQUE_ACTIVITIES" };
}
