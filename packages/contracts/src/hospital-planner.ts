import type { DiagnosticService, LaboratoryPanelStatus } from "./diagnostic-catalog";
import type { Permission } from "./identity-permissions";
import type { RoleCode } from "./identity-roles";

export const DEPARTMENT_TYPES = ["CLINICAL", "DIAGNOSTIC", "ADMINISTRATIVE", "SUPPORT"] as const;
export type DepartmentType = (typeof DEPARTMENT_TYPES)[number];
export interface Department {
  id: string;
  code: string;
  name: string;
  type: DepartmentType;
  responsibleUserId?: string;
  memberUserIds: string[];
  active: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  /** Read-only deactivation preview; counts include only work the current actor may read. */
  pendingWork?: {
    asOf: string;
    scope: "AUTHORIZED_ONLY";
    diagnosticItems: number | null;
    hospitalTasks: number | null;
    intakes: number | null;
  };
}

export type ExamDefinition = Pick<DiagnosticService, "code" | "name" | "category" | "departmentCode" | "workflowType" | "requiresSample" | "sampleType" | "requiresSchedule" | "allowsAttachment" | "resultSchema" | "resultTemplate" | "slaHours">;

export interface ExamDefinitionVersion {
  id: string;
  serviceId: string;
  serviceVersion: number;
  status: LaboratoryPanelStatus;
  recordedAt: string;
  recordedBy: string;
  provenance: "CATALOG_WRITE" | "CATALOG_OBSERVATION";
  definition: ExamDefinition;
}

export interface ExamDefinitionSnapshot {
  schemaVersion: 1;
  capturedAt: string;
  provenance: "REQUEST_CAPTURE" | "COMMAND_CAPTURE_LEGACY_REQUEST";
  definitionId: string;
  serviceId: string;
  serviceVersion: number;
  definition: ExamDefinition;
  patientContext: { species: string; sex?: string; birthDate?: string };
}

export type ExamDefinitionProvenance = ExamDefinitionSnapshot["provenance"] | "UNKNOWN_LEGACY";

export interface ServiceAccessPolicy {
  mode: "NONE" | "SELECTED" | "ALL_CURRENT";
  /** Only an explicit ALL_CURRENT policy may opt into later catalog additions. */
  includeFuture: boolean;
}

export interface AccessGroup {
  id: string;
  code: string;
  description: string;
  active: boolean;
  permissions: Permission[];
  version: number;
  createdAt: string;
  updatedAt: string;
  systemRole?: RoleCode;
}

export interface PatientGrant {
  id: string;
  userId: string;
  patientId: string;
  active: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  source: "LEGACY" | "PATIENT_CREATION" | "ADMIN";
  grantedBy?: string;
}

export interface EffectiveAccessPreview {
  userId: string; userVersion: number; groupVersion?: number; role: RoleCode; accessGroupId?: string; groupActive: boolean; origin: "GROUP" | "LEGACY_PROFILE";
  permissions: Permission[]; deniedByProfile: Permission[]; addedPermissions: Permission[]; removedPermissions: Permission[];
  scopes: { departmentCode: string; managedDepartmentCodes: string[]; serviceCodes: string[]; patientCount: number; globalPatients: boolean };
  restrictions: string[];
}


/** A read-only, current-authority preview; clinical identifiers and credentials are excluded. */
export interface AccessGroupImpactPreview {
  groupId: string; groupVersion: number; proposedActive: boolean; permissions: Permission[];
  impactToken: string; boundUserCount: number; affectedUserCount: number; activeAffectedUserCount: number;
  requiresReauthentication: boolean;
  users: Array<{
    userId: string; displayName: string; role: RoleCode; userVersion: number; active: boolean;
    departmentCode: string; managedDepartmentCodes: string[]; serviceCodes: string[]; patientCount: number;
    beforePermissions: Permission[]; permissions: Permission[]; addedPermissions: Permission[];
    removedPermissions: Permission[]; effectiveAccessChanges: boolean;
  }>;
}
