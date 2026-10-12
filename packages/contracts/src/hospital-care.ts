import type { HospitalResourceSnapshot } from "./hospital-resources";

/** A signed executor declaration referencing the adopted record, not an external delivery receipt. */
export interface HospitalCareExecution {
  id: string; performedAt: string; performedBy: string;
  modality: "CARE" | "PROCEDURE"; templateId: string; templateVersion: number;
  approvedBy: string; approvedAt: string; clinicalRecordReference: string;
  clinicalSystemReference: string; confirmationPolicyReference: string;
  resourceSnapshots: HospitalResourceSnapshot[]; note?: string;
  recordEvidence: "EXECUTOR_REFERENCE";
}
