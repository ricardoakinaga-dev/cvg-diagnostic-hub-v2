import type { HospitalChecklistStep, HospitalClinicalProcess, Priority } from "@cvg/contracts";
import type { CommandMeta } from "./service-types";
export type HospitalChecklistCreateInput = CommandMeta & { code: string; name: string; departmentCode: string; careContextRequired: boolean; steps: HospitalChecklistStep[]; clinicalProcess?: HospitalClinicalProcess };
export type HospitalChecklistPatchInput = CommandMeta & { name?: string; careContextRequired?: boolean; steps?: HospitalChecklistStep[]; clinicalProcess?: HospitalClinicalProcess | null };
export type HospitalChecklistStepInput = CommandMeta & { stepCode: string; command: "DONE" | "VOID"; evidenceText?: string; reason?: string };
export interface HospitalChecklistFilters { departmentCode?: string; status?: "DRAFT" | "APPROVED" | "RETIRED"; query?: string; limit?: number; cursor?: string }
export type HospitalRecurrenceCreateInput = CommandMeta & { templateId: string; departmentCode: string; patientId?: string; encounterId?: string; title: string; priority: Priority; responsibleUserId?: string; startAt: string; intervalMinutes: number; endAt?: string };
export type HospitalRecurrencePatchInput = CommandMeta & { title?: string; priority?: Priority; responsibleUserId?: string | null; endAt?: string | null; active?: boolean };
export interface HospitalRecurrenceFilters { departmentCode?: string; patientId?: string; active?: boolean; limit?: number; cursor?: string }
export type HospitalRecurrenceGenerationInput = CommandMeta & { asOf?: string; limit?: number };
