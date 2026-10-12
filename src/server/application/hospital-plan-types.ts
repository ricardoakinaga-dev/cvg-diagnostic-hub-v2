import type { HospitalPlanLink, HospitalPlanStep } from "@cvg/contracts";
import type { CommandMeta } from "./service-types";
export type HospitalPlanCreateInput = CommandMeta & { title: string; objective: string; patientId: string; encounterId: string; departmentCodes: string[]; responsibleUserId?: string; plannedStartAt?: string; plannedEndAt?: string; steps?: HospitalPlanStep[]; documentIds?: string[] };
export type HospitalPlanPatchInput = CommandMeta & { title?: string; objective?: string; departmentCodes?: string[]; responsibleUserId?: string | null; plannedStartAt?: string | null; plannedEndAt?: string | null; steps?: HospitalPlanStep[]; documentIds?: string[] };
export type HospitalPlanLinkInput = CommandMeta & { stepId: string; targetType: HospitalPlanLink["targetType"]; targetId: string; active: boolean };
export type HospitalPlanCommandInput = CommandMeta & { command: "CLOSE" | "ARCHIVE"; reason?: string };
export interface HospitalPlanFilters { patientId?: string; encounterId?: string; departmentCode?: string; state?: "ACTIVE" | "CLOSED" | "ARCHIVED"; query?: string; limit?: number; cursor?: string }
