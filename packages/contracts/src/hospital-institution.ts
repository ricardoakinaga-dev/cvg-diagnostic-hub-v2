import type { RoleCode } from "./identity-roles";
export const HOSPITAL_CAPABILITIES = ["TASKS", "PLANS", "SHIFTS", "RECURRENCES", "CARE", "DOCUMENTS", "CALENDAR"] as const;
export type HospitalCapability = (typeof HOSPITAL_CAPABILITIES)[number];
/** A single installation represents one institution. Capabilities never replace permission checks. */
export interface HospitalInstitutionSettings {
  id: "hospital-institution"; name: string; timezone: string;
  departmentCapabilities: Array<{ departmentCode: string; disabledNewWork: HospitalCapability[]; archived: boolean }>;
  version: number; updatedAt: string; updatedBy: string;
}
export interface HospitalUserInvitation {
  id: string; email: string; displayName: string; role: RoleCode; departmentCode: string;
  accessGroupId: string; expectedGroupVersion: number; issuedBy: string;
  serviceCodes?: string[];
  status: "PENDING" | "ACCEPTED" | "REVOKED"; expiresAt: string; acceptedBy?: string;
  acceptedAt?: string; revokedAt?: string; version: number; createdAt: string; updatedAt: string;
}
export interface HospitalInvitationView { invitation: HospitalUserInvitation; expired: boolean }
export interface HospitalInvitationIssued { invitation: HospitalUserInvitation; token?: string; tokenReturnedOnce: boolean }
export interface HospitalInvitationPreview { institutionName: string; displayName: string; maskedEmail: string; expiresAt: string }
export interface HospitalInvitationAccepted { accepted: true; userId: string; nextAction: "LOGIN" }
export interface HospitalInstitutionView { settings: HospitalInstitutionSettings | null; permissions: import("./identity-permissions").Permission[] }
export interface HospitalInvitationOptions {
  roles: RoleCode[]; departments: Array<{ code: string; name: string }>;
  groups: Array<{ id: string; code: string; description: string; version: number }>;
}
