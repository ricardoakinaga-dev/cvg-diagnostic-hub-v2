import type { Permission } from "./identity-permissions";
import type { HospitalTaskAssignee } from "./hospital-tasks";

export interface HospitalShiftMember { userId: string; replacesUserId?: string }
export interface HospitalShift {
  id: string; code: string; name: string; departmentCode: string; startAt: string; endAt: string;
  members: HospitalShiftMember[]; status: "PLANNED" | "CLOSED" | "ARCHIVED"; createdBy: string;
  version: number; createdAt: string; updatedAt: string;
}
export interface HospitalShiftView {
  shift: HospitalShift; permissions: Permission[]; current: boolean; coverage: HospitalTaskAssignee[];
  workload: { visibleActivities: number; completedActivities: number; denominator: "AUTHORIZED_UNIQUE_ACTIVITIES" };
}
export interface HospitalHandoffEntry { targetType: "HOSPITAL_TASK" | "DIAGNOSTIC_ITEM"; targetId: string; expectedTargetVersion: number; previousResponsibleUserId?: string }
export interface HospitalHandoff {
  id: string; fromShiftId: string; toShiftId: string; departmentCode: string; offeredBy: string;
  recipientUserId: string; state: "OFFERED" | "ACCEPTED" | "REJECTED"; entries: HospitalHandoffEntry[];
  offeredAt: string; acceptedAt?: string; rejectedAt?: string; reason?: string; decidedBy?: string;
  version: number; createdAt: string; updatedAt: string;
}
export interface HospitalHandoffView {
  handoff: Omit<HospitalHandoff, "entries"> & { entries: HospitalHandoffEntry[] }; permissions: Permission[];
  activities: Array<HospitalHandoffEntry & { label: string; status: string }>;
}
