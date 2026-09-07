import { describe, expect, it } from "vitest";
import {
  evaluateGovernanceAction,
  evaluateRetention,
  governancePolicyFromEnvironment,
  validateDataGovernancePolicy,
  type DataGovernancePolicy
} from "./data-governance-policy";

function policy(overrides: Partial<DataGovernancePolicy> = {}): DataGovernancePolicy {
  return {
    version: "policy-v1",
    approvalReference: "decision:D-05-2026-09",
    approvedAt: "2026-09-05T12:00:00.000Z",
    residency: { region: "br-south-1", providerReference: "env:STORAGE_REGION" },
    retention: {
      CLINICAL_RECORD: { durationDays: 365, deletionMode: "EXPLICIT_APPROVAL" },
      ATTACHMENT: { durationDays: 180, deletionMode: "EXPLICIT_APPROVAL" },
      AUDIT_EVENT: { durationDays: 730, deletionMode: "DISABLED" },
      BACKUP: { durationDays: 30, deletionMode: "EXPLICIT_APPROVAL" }
    },
    export: { mode: "SCOPED_ONLY", allowedRoles: ["PRIVACY_OFFICER"], approvalRequired: true },
    audit: { immutable: true, retentionDays: 730 },
    ...overrides
  };
}

describe("data governance policy guard", () => {
  it("fails closed when institutional policy is absent or disabled", () => {
    expect(governancePolicyFromEnvironment({ DATA_GOVERNANCE_POLICY_ENABLED: "false" })).toBeUndefined();
    expect(evaluateGovernanceAction(undefined, { action: "EXPORT", dataClass: "CLINICAL_RECORD", actorRole: "PRIVACY_OFFICER", scope: "PATIENT" })).toMatchObject({ allowed: false, code: "GOVERNANCE_POLICY_NOT_APPROVED", auditAction: "DENY" });
    expect(evaluateRetention(undefined, "BACKUP", 999)).toMatchObject({ eligible: false, code: "GOVERNANCE_POLICY_NOT_APPROVED" });
  });

  it("validates a policy only when approval, residency and every retention class are explicit", () => {
    expect(() => validateDataGovernancePolicy(policy())).not.toThrow();
    expect(() => validateDataGovernancePolicy(null)).toThrow("object_required");
    expect(() => validateDataGovernancePolicy({})).toThrow("version");
    expect(() => validateDataGovernancePolicy({ ...policy(), version: " " })).toThrow("version");
    expect(() => validateDataGovernancePolicy({ ...policy(), approvedAt: "not-a-date" })).toThrow("approved_at");
    expect(() => validateDataGovernancePolicy({ ...policy(), residency: undefined })).toThrow("residency");
    expect(() => validateDataGovernancePolicy({ ...policy(), residency: { region: "", providerReference: "env:STORAGE_REGION" } })).toThrow("residency_region");
    expect(() => validateDataGovernancePolicy({ ...policy(), residency: { region: "br-south-1", providerReference: "plaintext" } })).toThrow("provider_reference");
    expect(() => validateDataGovernancePolicy({ ...policy(), retention: undefined })).toThrow("retention");
    expect(() => validateDataGovernancePolicy({ ...policy(), retention: { ...policy().retention, BACKUP: { durationDays: -1, deletionMode: "EXPLICIT_APPROVAL" } } })).toThrow("retention:BACKUP");
    expect(() => validateDataGovernancePolicy({ ...policy(), retention: { ...policy().retention, BACKUP: { durationDays: 1.5, deletionMode: "EXPLICIT_APPROVAL" } } })).toThrow("retention:BACKUP");
    expect(() => validateDataGovernancePolicy({ ...policy(), export: undefined })).toThrow("export");
    expect(() => validateDataGovernancePolicy({ ...policy(), export: { mode: "GLOBAL" as never, allowedRoles: [], approvalRequired: false } })).toThrow("export");
    expect(() => validateDataGovernancePolicy({ ...policy(), export: { mode: "SCOPED_ONLY", allowedRoles: ["bad-role"], approvalRequired: false } })).toThrow("export");
    expect(() => validateDataGovernancePolicy({ ...policy(), export: { mode: "SCOPED_ONLY", allowedRoles: [], approvalRequired: "yes" as never } })).toThrow("export");
    expect(() => validateDataGovernancePolicy({ ...policy(), audit: { immutable: false as true, retentionDays: 1 } })).toThrow("audit");
    expect(() => validateDataGovernancePolicy({ ...policy(), audit: { immutable: true, retentionDays: -1 } })).toThrow("audit");
    expect(() => validateDataGovernancePolicy({ ...policy(), approvalReference: "plaintext-secret" })).toThrow("approval_reference");
  });

  it("loads an enabled environment policy and rejects missing or malformed retention JSON", () => {
    const environment = {
      DATA_GOVERNANCE_POLICY_ENABLED: "true",
      DATA_GOVERNANCE_POLICY_VERSION: "policy-v2",
      DATA_GOVERNANCE_POLICY_APPROVAL_REF: "decision:D-05-2026-09",
      DATA_GOVERNANCE_POLICY_APPROVED_AT: "2026-09-05T12:00:00.000Z",
      DATA_GOVERNANCE_RESIDENCY_REGION: "br-south-1",
      DATA_GOVERNANCE_PROVIDER_REF: "env:STORAGE_REGION",
      DATA_GOVERNANCE_RETENTION_JSON: JSON.stringify(policy().retention),
      DATA_GOVERNANCE_EXPORT_MODE: "SCOPED_ONLY",
      DATA_GOVERNANCE_EXPORT_ROLES: "PRIVACY_OFFICER, ADMIN",
      DATA_GOVERNANCE_EXPORT_APPROVAL_REQUIRED: "true",
      DATA_GOVERNANCE_AUDIT_RETENTION_DAYS: "730"
    };
    expect(governancePolicyFromEnvironment(environment)).toMatchObject({
      version: "policy-v2",
      export: { mode: "SCOPED_ONLY", allowedRoles: ["PRIVACY_OFFICER", "ADMIN"], approvalRequired: true }
    });
    expect(() => governancePolicyFromEnvironment({ ...environment, DATA_GOVERNANCE_RETENTION_JSON: undefined })).toThrow("retention_missing");
    expect(() => governancePolicyFromEnvironment({ ...environment, DATA_GOVERNANCE_RETENTION_JSON: "{" })).toThrow("retention_json");
    expect(() => governancePolicyFromEnvironment({ ...environment, DATA_GOVERNANCE_POLICY_VERSION: undefined })).toThrow("version");
  });

  it("allows only approved scoped exports and records an approval requirement", () => {
    const configured = policy();
    expect(evaluateGovernanceAction(configured, { action: "EXPORT", dataClass: "CLINICAL_RECORD", actorRole: "PRIVACY_OFFICER", scope: "PATIENT" })).toMatchObject({ allowed: false, code: "EXPORT_APPROVAL_REQUIRED", auditAction: "DENY" });
    expect(evaluateGovernanceAction(configured, { action: "EXPORT", dataClass: "CLINICAL_RECORD", actorRole: "PRIVACY_OFFICER", scope: "PATIENT", approvalReference: configured.approvalReference })).toMatchObject({ allowed: true, code: "ALLOWED", policyVersion: "policy-v1" });
    expect(evaluateGovernanceAction(configured, { action: "EXPORT", dataClass: "CLINICAL_RECORD", actorRole: "PRIVACY_OFFICER", scope: "GLOBAL", approvalReference: configured.approvalReference })).toMatchObject({ allowed: false, code: "EXPORT_SCOPE_TOO_BROAD" });
    expect(evaluateGovernanceAction(configured, { action: "EXPORT", dataClass: "CLINICAL_RECORD", actorRole: "ADMIN", scope: "PATIENT", approvalReference: configured.approvalReference })).toMatchObject({ allowed: false, code: "EXPORT_ROLE_FORBIDDEN" });
  });

  it("keeps audit immutable and requires explicit approval for deletion", () => {
    const configured = policy();
    expect(evaluateGovernanceAction(configured, { action: "DELETE", dataClass: "AUDIT_EVENT", actorRole: "PRIVACY_OFFICER", scope: "DEPARTMENT", approvalReference: configured.approvalReference })).toMatchObject({ allowed: false, code: "AUDIT_IMMUTABLE" });
    expect(evaluateGovernanceAction(configured, { action: "DELETE", dataClass: "ATTACHMENT", actorRole: "PRIVACY_OFFICER", scope: "PATIENT" })).toMatchObject({ allowed: false, code: "DELETE_APPROVAL_REQUIRED" });
    expect(evaluateGovernanceAction(configured, { action: "DELETE", dataClass: "ATTACHMENT", actorRole: "PRIVACY_OFFICER", scope: "PATIENT", approvalReference: configured.approvalReference })).toMatchObject({ allowed: true, code: "ALLOWED" });
    expect(evaluateGovernanceAction(configured, { action: "DELETE", dataClass: "AUDIT_EVENT", actorRole: "ADMIN", scope: "GLOBAL" })).toMatchObject({ allowed: false, code: "AUDIT_IMMUTABLE" });
    expect(evaluateGovernanceAction({ ...configured, export: { ...configured.export, mode: "DISABLED" } }, { action: "EXPORT", dataClass: "ATTACHMENT", actorRole: "PRIVACY_OFFICER", scope: "PATIENT" })).toMatchObject({ allowed: false, code: "EXPORT_DISABLED" });
    expect(evaluateGovernanceAction({ ...configured, retention: { ...configured.retention, BACKUP: { durationDays: 0, deletionMode: "DISABLED" } } }, { action: "DELETE", dataClass: "BACKUP", actorRole: "ADMIN", scope: "DEPARTMENT" })).toMatchObject({ allowed: false, code: "DELETE_DISABLED" });
    expect(evaluateGovernanceAction({ ...configured, retention: { ...configured.retention, BACKUP: { durationDays: 0, deletionMode: "AUTOMATED" } } }, { action: "DELETE", dataClass: "BACKUP", actorRole: "ADMIN", scope: "DEPARTMENT" })).toMatchObject({ allowed: true, code: "ALLOWED" });
  });

  it("does not mark retention eligible before the policy duration", () => {
    const configured = policy();
    expect(evaluateRetention(configured, "ATTACHMENT", 179)).toMatchObject({ eligible: false, code: "RETENTION_NOT_REACHED", policyVersion: "policy-v1" });
    expect(evaluateRetention(configured, "ATTACHMENT", 180)).toMatchObject({ eligible: true, code: "ALLOWED", policyVersion: "policy-v1" });
    expect(evaluateRetention(configured, "AUDIT_EVENT", 9999)).toMatchObject({ eligible: false, code: "DELETE_DISABLED", policyVersion: "policy-v1" });
    expect(evaluateRetention(configured, "ATTACHMENT", Number.NaN)).toMatchObject({ eligible: false, code: "RETENTION_NOT_REACHED", policyVersion: "policy-v1" });
  });
});
