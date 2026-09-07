export const GOVERNED_DATA_CLASSES = ["CLINICAL_RECORD", "ATTACHMENT", "AUDIT_EVENT", "BACKUP"] as const;
export type GovernedDataClass = (typeof GOVERNED_DATA_CLASSES)[number];
export type GovernanceAction = "EXPORT" | "DELETE";
export type GovernanceScope = "PATIENT" | "DEPARTMENT" | "GLOBAL";

export interface DataGovernancePolicy {
  version: string;
  approvalReference: string;
  approvedAt: string;
  residency: {
    region: string;
    providerReference: string;
  };
  retention: Record<GovernedDataClass, {
    durationDays: number;
    deletionMode: "DISABLED" | "EXPLICIT_APPROVAL" | "AUTOMATED";
  }>;
  export: {
    mode: "DISABLED" | "SCOPED_ONLY";
    allowedRoles: string[];
    approvalRequired: boolean;
  };
  audit: {
    immutable: true;
    retentionDays: number;
  };
}

export interface GovernanceDecision {
  allowed: boolean;
  code: "ALLOWED" | "GOVERNANCE_POLICY_NOT_APPROVED" | "EXPORT_DISABLED" | "EXPORT_SCOPE_TOO_BROAD" | "EXPORT_ROLE_FORBIDDEN" | "EXPORT_APPROVAL_REQUIRED" | "AUDIT_IMMUTABLE" | "DELETE_DISABLED" | "DELETE_APPROVAL_REQUIRED" | "RETENTION_NOT_REACHED";
  auditAction: "ALLOW" | "DENY";
  policyVersion?: string;
}

export interface RetentionDecision {
  eligible: boolean;
  code: "ALLOWED" | "GOVERNANCE_POLICY_NOT_APPROVED" | "RETENTION_NOT_REACHED" | "DELETE_DISABLED";
  policyVersion?: string;
}

const SAFE_REFERENCE = /^(?:decision|env|secret|vault|kms):[A-Za-z0-9._/@:+-]+$/;
const SAFE_REGION = /^[a-z0-9][a-z0-9-]{1,63}$/;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function validateDataGovernancePolicy(value: unknown): asserts value is DataGovernancePolicy {
  if (!value || typeof value !== "object") throw new Error("GOVERNANCE_POLICY_INVALID:object_required");
  const policy = value as Partial<DataGovernancePolicy>;
  if (typeof policy.version !== "string" || !SAFE_VERSION.test(policy.version)) throw new Error("GOVERNANCE_POLICY_INVALID:version");
  if (typeof policy.approvalReference !== "string" || !SAFE_REFERENCE.test(policy.approvalReference)) throw new Error("GOVERNANCE_POLICY_INVALID:approval_reference");
  if (typeof policy.approvedAt !== "string" || Number.isNaN(Date.parse(policy.approvedAt))) throw new Error("GOVERNANCE_POLICY_INVALID:approved_at");
  if (!policy.residency || typeof policy.residency !== "object") throw new Error("GOVERNANCE_POLICY_INVALID:residency");
  if (typeof policy.residency.region !== "string" || !SAFE_REGION.test(policy.residency.region)) throw new Error("GOVERNANCE_POLICY_INVALID:residency_region");
  if (typeof policy.residency.providerReference !== "string" || !SAFE_REFERENCE.test(policy.residency.providerReference)) throw new Error("GOVERNANCE_POLICY_INVALID:provider_reference");
  if (!policy.retention || typeof policy.retention !== "object") throw new Error("GOVERNANCE_POLICY_INVALID:retention");
  for (const dataClass of GOVERNED_DATA_CLASSES) {
    const rule = policy.retention[dataClass];
    if (!rule || !Number.isSafeInteger(rule.durationDays) || rule.durationDays < 0 || !["DISABLED", "EXPLICIT_APPROVAL", "AUTOMATED"].includes(rule.deletionMode)) {
      throw new Error(`GOVERNANCE_POLICY_INVALID:retention:${dataClass}`);
    }
  }
  if (!policy.export || typeof policy.export !== "object" || !["DISABLED", "SCOPED_ONLY"].includes(policy.export.mode ?? "") || !Array.isArray(policy.export.allowedRoles) || policy.export.allowedRoles.some((role) => typeof role !== "string" || !/^[A-Z][A-Z0-9_]{1,63}$/.test(role)) || typeof policy.export.approvalRequired !== "boolean") {
    throw new Error("GOVERNANCE_POLICY_INVALID:export");
  }
  if (!policy.audit || policy.audit.immutable !== true || !Number.isSafeInteger(policy.audit.retentionDays) || policy.audit.retentionDays < 0) throw new Error("GOVERNANCE_POLICY_INVALID:audit");
}

export function governancePolicyFromEnvironment(environment: Record<string, string | undefined>): DataGovernancePolicy | undefined {
  if (environment.DATA_GOVERNANCE_POLICY_ENABLED !== "true") return undefined;
  const retentionJson = environment.DATA_GOVERNANCE_RETENTION_JSON;
  const allowedRoles = environment.DATA_GOVERNANCE_EXPORT_ROLES?.split(",").map((role) => role.trim()).filter(Boolean) ?? [];
  if (!retentionJson) throw new Error("GOVERNANCE_POLICY_NOT_APPROVED:retention_missing");
  let retention: unknown;
  try {
    retention = JSON.parse(retentionJson);
  } catch {
    throw new Error("GOVERNANCE_POLICY_INVALID:retention_json");
  }
  const policy: unknown = {
    version: environment.DATA_GOVERNANCE_POLICY_VERSION,
    approvalReference: environment.DATA_GOVERNANCE_POLICY_APPROVAL_REF,
    approvedAt: environment.DATA_GOVERNANCE_POLICY_APPROVED_AT,
    residency: { region: environment.DATA_GOVERNANCE_RESIDENCY_REGION, providerReference: environment.DATA_GOVERNANCE_PROVIDER_REF },
    retention,
    export: { mode: environment.DATA_GOVERNANCE_EXPORT_MODE, allowedRoles, approvalRequired: environment.DATA_GOVERNANCE_EXPORT_APPROVAL_REQUIRED === "true" },
    audit: { immutable: true, retentionDays: Number(environment.DATA_GOVERNANCE_AUDIT_RETENTION_DAYS) }
  };
  validateDataGovernancePolicy(policy);
  return policy;
}

export function evaluateGovernanceAction(
  policy: DataGovernancePolicy | undefined,
  input: { action: GovernanceAction; dataClass: GovernedDataClass; actorRole: string; scope: GovernanceScope; approvalReference?: string }
): GovernanceDecision {
  if (!policy) return deny("GOVERNANCE_POLICY_NOT_APPROVED");
  if (input.action === "EXPORT") {
    if (policy.export.mode !== "SCOPED_ONLY") return deny("EXPORT_DISABLED", policy.version);
    if (input.scope === "GLOBAL") return deny("EXPORT_SCOPE_TOO_BROAD", policy.version);
    if (!policy.export.allowedRoles.includes(input.actorRole)) return deny("EXPORT_ROLE_FORBIDDEN", policy.version);
    if (policy.export.approvalRequired && input.approvalReference !== policy.approvalReference) return deny("EXPORT_APPROVAL_REQUIRED", policy.version);
    return allow(policy.version);
  }
  if (input.dataClass === "AUDIT_EVENT" && policy.audit.immutable) return deny("AUDIT_IMMUTABLE", policy.version);
  const rule = policy.retention[input.dataClass];
  if (rule.deletionMode === "DISABLED") return deny("DELETE_DISABLED", policy.version);
  if (rule.deletionMode === "EXPLICIT_APPROVAL" && input.approvalReference !== policy.approvalReference) return deny("DELETE_APPROVAL_REQUIRED", policy.version);
  return allow(policy.version);
}

export function evaluateRetention(
  policy: DataGovernancePolicy | undefined,
  dataClass: GovernedDataClass,
  ageDays: number
): RetentionDecision {
  if (!policy) return { eligible: false, code: "GOVERNANCE_POLICY_NOT_APPROVED" };
  const rule = policy.retention[dataClass];
  if (rule.deletionMode === "DISABLED") return { eligible: false, code: "DELETE_DISABLED", policyVersion: policy.version };
  if (!Number.isFinite(ageDays) || ageDays < rule.durationDays) return { eligible: false, code: "RETENTION_NOT_REACHED", policyVersion: policy.version };
  return { eligible: true, code: "ALLOWED", policyVersion: policy.version };
}

function allow(policyVersion: string): GovernanceDecision {
  return { allowed: true, code: "ALLOWED", auditAction: "ALLOW", policyVersion };
}

function deny(code: GovernanceDecision["code"], policyVersion?: string): GovernanceDecision {
  return { allowed: false, code, auditAction: "DENY", ...(policyVersion ? { policyVersion } : {}) };
}
