export const HOSPITAL_INTEGRATION_SYSTEMS = ["HIS", "LIS", "PACS"] as const;
export type HospitalIntegrationSystem = (typeof HOSPITAL_INTEGRATION_SYSTEMS)[number];
export const HOSPITAL_INTEGRATION_PURPOSES = ["HIS_INTAKE", "LIS_RESULT_DRAFT", "PACS_RESULT_DRAFT"] as const;
export type HospitalIntegrationPurpose = (typeof HOSPITAL_INTEGRATION_PURPOSES)[number];
export interface HospitalIntegrationScope { departmentCodes: string[]; patientIds?: string[] }
/** Token hashes never appear in public DTOs. Credentials restrict, never grant, actor access. */
export interface HospitalIntegrationCredential {
  id: string;
  /** Omitted legacy values retain the CVG operational profile. */
  profile?: "CVG_OPERATIONAL_V1" | "HIS_V4";
  system: HospitalIntegrationSystem;
  purpose: HospitalIntegrationPurpose;
  actorUserId: string;
  scope: HospitalIntegrationScope;
  name: string;
  tokenHash: string;
  active: boolean;
  expiresAt: string;
  lastUsedAt?: string;
  rotatedAt?: string;
  revokedAt?: string;
  createdBy: string;
  createdAt: string;
  version: number;
}
export type HospitalIntegrationCredentialView = Omit<HospitalIntegrationCredential, "tokenHash">;
export interface HospitalIntegrationCredentialIssued { credential: HospitalIntegrationCredentialView; token?: string; tokenReturnedOnce: boolean }
export interface HospitalIntegrationReceipt {
  id: string;
  messageId: string;
  system: HospitalIntegrationSystem;
  purpose: HospitalIntegrationPurpose;
  externalEntityId: string;
  sequence: number;
  direction: "INBOUND" | "OUTBOUND";
  status: "CLAIMED" | "SUCCEEDED" | "FAILED";
  targetType?: "HOSPITAL_INTAKE" | "DIAGNOSTIC_ITEM" | "RESULT";
  targetId?: string;
  remoteReceiptId?: string;
  attempts: number;
  retryable: boolean;
  nextAttemptAt?: string;
  errorCode?: string;
  createdAt: string;
  completedAt?: string;
  version: number;
}
/** Payloads stay in their original clinical authority. Tracking stores only hashes and references. */
export interface HospitalIntegrationMessage extends HospitalIntegrationReceipt {
  credentialId?: string;
  actorUserId: string;
  payloadHash: string;
  correlationId: string;
  leaseUntil?: string;
  expectedSourceVersion?: number;
}
export interface HospitalIntegrationCapability {
  system: HospitalIntegrationSystem;
  contract: "CVG_OPERATIONAL_V1";
  configured: boolean;
  deploymentVerified: false;
  reason?: "CONFIGURATION_MISSING" | "CONFIGURATION_INVALID";
}
