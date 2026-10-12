import type { RoleCode } from "./identity-roles";
import type { Priority } from "./diagnostic-catalog";
import type { Permission } from "./identity-permissions";

export interface HospitalChecklistStep { code: string; label: string; required: boolean; evidenceRequired: boolean }
export interface HospitalClinicalProcess {
  modality: "CARE" | "PROCEDURE"; allowedExecutorRoles: RoleCode[];
  clinicalSystemReference: string; confirmationPolicyReference: string;
}
export interface HospitalChecklistTemplate {
  id: string; code: string; name: string; departmentCode: string; careContextRequired: boolean;
  steps: HospitalChecklistStep[]; clinicalProcess?: HospitalClinicalProcess;
  status: "DRAFT" | "APPROVED" | "RETIRED"; approvedBy?: string; approvedAt?: string;
  createdBy: string; version: number; createdAt: string; updatedAt: string;
}
export interface HospitalChecklistSnapshot {
  templateId: string; templateVersion: number; code: string; name: string; departmentCode: string;
  careContextRequired: boolean; steps: HospitalChecklistStep[]; clinicalProcess?: HospitalClinicalProcess;
  approvedBy: string; approvedAt: string; capturedAt: string;
}
export interface HospitalChecklistExecution {
  id: string; stepCode: string; actorId: string; executedAt: string; evidenceText?: string;
  status: "DONE" | "VOIDED"; voidedBy?: string; voidedAt?: string; voidReason?: string; version: number;
}
export interface HospitalRecurrence {
  id: string; templateId: string; departmentCode: string; patientId?: string; encounterId?: string;
  title: string; priority: Priority; responsibleUserId?: string; startAt: string; intervalMinutes: number;
  endAt?: string; active: boolean; nextOccurrenceAt: string; createdBy: string; lastError?: string;
  version: number; createdAt: string; updatedAt: string;
}
export interface HospitalRecurrenceGenerationReport { generated: number; alreadyGenerated: number; blocked: number; pending: number; asOf: string }
export interface HospitalChecklistTemplateView { template: HospitalChecklistTemplate; permissions: Permission[] }
export interface HospitalRecurrenceView { recurrence: HospitalRecurrence; permissions: Permission[] }
