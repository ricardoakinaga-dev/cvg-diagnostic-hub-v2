import type { HospitalHandoffEntry, HospitalShiftMember } from "@cvg/contracts";
import type { CommandMeta } from "./service-types";
export type HospitalShiftCreateInput = CommandMeta & { name: string; departmentCode: string; startAt: string; endAt: string; members: HospitalShiftMember[] };
export type HospitalShiftPatchInput = CommandMeta & { name?: string; startAt?: string; endAt?: string; members?: HospitalShiftMember[]; status?: "CLOSED" | "ARCHIVED" };
export interface HospitalShiftFilters { departmentCode?: string; current?: boolean; status?: "PLANNED" | "CLOSED" | "ARCHIVED"; from?: string; to?: string; limit?: number; cursor?: string }
export type HospitalActivityShiftInput = CommandMeta & { targetType: "HOSPITAL_TASK" | "DIAGNOSTIC_ITEM"; targetId: string; shiftId: string | null };
export type HospitalHandoffOfferInput = CommandMeta & { fromShiftId: string; toShiftId: string; recipientUserId: string; entries: Array<Pick<HospitalHandoffEntry, "targetType" | "targetId" | "expectedTargetVersion">> };
export type HospitalHandoffDecisionInput = CommandMeta & { decision: "ACCEPT" | "REJECT"; reason?: string };
export interface HospitalHandoffFilters { departmentCode?: string; state?: "OFFERED" | "ACCEPTED" | "REJECTED"; limit?: number; cursor?: string }
