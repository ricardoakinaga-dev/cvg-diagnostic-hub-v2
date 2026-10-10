import { describe, expect, it } from "vitest";
import {
  criticalPolicyFromEnvironment,
  defaultCriticalResultPolicy,
  nextCriticalRecipients,
  planCriticalEscalation,
  resolveCriticalRecipients,
  validateCriticalResultPolicy,
  type CriticalRecipientCandidate,
  type CriticalResultPolicy
} from "./critical-result-policy";

const approvedAt = "2026-08-20T10:00:00.000Z";
const policy = (overrides: Partial<CriticalResultPolicy> = {}): CriticalResultPolicy => ({
  version: "critical-v2",
  approvalRef: "clinical-approval-42",
  approvedAt,
  effectiveFrom: approvedAt,
  escalationAfterMs: [15 * 60 * 1_000, 30 * 60 * 1_000, 60 * 60 * 1_000],
  recipientRules: ["REQUESTER", "RESPONSIBLE", "DEPARTMENT_MANAGER", "ON_CALL", "ADMIN_FALLBACK"],
  requireDistinctRecipients: true,
  ...overrides
});

const candidates: CriticalRecipientCandidate[] = [
  { userId: "requester", role: "VETERINARIAN", departmentCode: "INPATIENT", active: true },
  { userId: "responsible", role: "INPATIENT_TEAM", departmentCode: "INPATIENT", active: true },
  { userId: "manager", role: "MANAGER", departmentCode: "INPATIENT", active: true, managedDepartmentCodes: ["INPATIENT"] },
  { userId: "on-call", role: "VETERINARIAN", departmentCode: "INPATIENT", active: true, onCall: true },
  { userId: "admin", role: "ADMIN", departmentCode: "INPATIENT", active: true },
  { userId: "inactive", role: "ADMIN", departmentCode: "INPATIENT", active: false },
  { userId: "other-department", role: "ADMIN", departmentCode: "RADIOLOGY", active: true }
];

describe("critical result policy", () => {
  it("validates an approved policy and rejects ambiguous schedules/fallbacks", () => {
    expect(() => validateCriticalResultPolicy(policy(), new Date("2026-09-05T00:00:00.000Z"))).not.toThrow();
    expect(() => validateCriticalResultPolicy(policy({ escalationAfterMs: [30_000, 20_000] }), new Date("2026-09-05T00:00:00.000Z"))).toThrow("CRITICAL_POLICY_ESCALATION_SCHEDULE_INVALID");
    expect(() => validateCriticalResultPolicy(policy({ recipientRules: ["REQUESTER"] }), new Date("2026-09-05T00:00:00.000Z"))).toThrow("CRITICAL_POLICY_NO_FALLBACK");
    expect(() => validateCriticalResultPolicy(policy({ effectiveFrom: "2026-08-19T10:00:00.000Z" }), new Date("2026-09-05T00:00:00.000Z"))).toThrow("CRITICAL_POLICY_EFFECTIVE_BEFORE_APPROVAL");
    expect(() => validateCriticalResultPolicy(policy({ approvedAt: "2026-09-06T10:00:00.000Z", effectiveFrom: "2026-09-06T10:00:00.000Z" }), new Date("2026-09-05T00:00:00.000Z"))).toThrow("CRITICAL_POLICY_APPROVAL_IN_FUTURE");
    expect(() => validateCriticalResultPolicy(policy({ effectiveFrom: "2028-09-06T10:00:00.000Z" }), new Date("2026-09-05T00:00:00.000Z"))).toThrow("CRITICAL_POLICY_EFFECTIVE_TOO_FAR");
    expect(() => validateCriticalResultPolicy(policy({ escalationAfterMs: [] }), new Date("2026-09-05T00:00:00.000Z"))).toThrow("CRITICAL_POLICY_ESCALATION_SCHEDULE_INVALID");
    expect(() => validateCriticalResultPolicy(policy({ escalationAfterMs: [1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 7_000, 8_000, 9_000] }), new Date("2026-09-05T00:00:00.000Z"))).toThrow("CRITICAL_POLICY_ESCALATION_SCHEDULE_INVALID");
    expect(() => validateCriticalResultPolicy(policy({ recipientRules: [] }), new Date("2026-09-05T00:00:00.000Z"))).toThrow("CRITICAL_POLICY_RECIPIENT_RULES_EMPTY");
    expect(() => validateCriticalResultPolicy(policy({ recipientRules: ["ADMIN_FALLBACK", "ADMIN_FALLBACK"] }), new Date("2026-09-05T00:00:00.000Z"))).toThrow("CRITICAL_POLICY_RECIPIENT_RULE_INVALID");
    expect(() => validateCriticalResultPolicy(policy({ requireDistinctRecipients: undefined as unknown as boolean }), new Date("2026-09-05T00:00:00.000Z"))).toThrow("CRITICAL_POLICY_DISTINCT_RECIPIENTS_INVALID");
    expect(() => validateCriticalResultPolicy(policy({ version: "" }), new Date("2026-09-05T00:00:00.000Z"))).toThrow("CRITICAL_POLICY_VERSION_INVALID");
    expect(() => validateCriticalResultPolicy(policy({ approvedAt: "not-a-timestamp", effectiveFrom: "not-a-timestamp" }), new Date("2026-09-05T00:00:00.000Z"))).toThrow("CRITICAL_POLICY_APPROVED_AT_INVALID");
  });

  it("reads only a complete environment policy and remains fail closed", () => {
    expect(criticalPolicyFromEnvironment({ CRITICAL_POLICY_ENABLED: "false" })).toBeUndefined();
    expect(criticalPolicyFromEnvironment({ CRITICAL_POLICY_ENABLED: "true", CRITICAL_POLICY_VERSION: "v1" })).toBeUndefined();
    expect(criticalPolicyFromEnvironment({
      CRITICAL_POLICY_ENABLED: "true",
      CRITICAL_POLICY_VERSION: "v3",
      CRITICAL_POLICY_APPROVAL_REF: "approval-3",
      CRITICAL_POLICY_APPROVED_AT: approvedAt,
      CRITICAL_POLICY_EFFECTIVE_FROM: "2026-08-21T10:00:00.000Z",
      CRITICAL_POLICY_ESCALATION_AFTER_MS: "900000,1800000",
      CRITICAL_POLICY_RECIPIENT_RULES: "REQUESTER,ADMIN_FALLBACK"
    })).toMatchObject({ version: "v3", recipientRules: ["REQUESTER", "ADMIN_FALLBACK"] });
    expect(criticalPolicyFromEnvironment({
      CRITICAL_POLICY_ENABLED: "true",
      CRITICAL_POLICY_VERSION: "v3",
      CRITICAL_POLICY_APPROVAL_REF: "approval-3",
      CRITICAL_POLICY_APPROVED_AT: approvedAt,
      CRITICAL_POLICY_ESCALATION_AFTER_MS: "900000,900000"
    })).toBeUndefined();
    expect(criticalPolicyFromEnvironment({
      CRITICAL_POLICY_ENABLED: "true",
      CRITICAL_POLICY_VERSION: "v3",
      CRITICAL_POLICY_APPROVAL_REF: "approval-3",
      CRITICAL_POLICY_APPROVED_AT: approvedAt,
      CRITICAL_POLICY_ESCALATION_AFTER_MS: "not-a-number"
    })).toBeUndefined();
  });

  it("resolves active recipients in policy order, with deterministic de-duplication and fallback", () => {
    const resolved = resolveCriticalRecipients({
      requesterId: "requester",
      responsibleUserId: "responsible",
      departmentCode: "inpatient",
      candidates
    }, policy());
    expect(resolved.map((candidate) => candidate.userId)).toEqual(["requester", "responsible", "manager", "on-call", "admin"]);

    const managerWithoutExplicitScope: CriticalRecipientCandidate = {
      userId: "manager-default-scope",
      role: "MANAGER",
      departmentCode: "INPATIENT",
      active: true
    };
    expect(resolveCriticalRecipients({ departmentCode: "INPATIENT", candidates: [managerWithoutExplicitScope] }, policy({ recipientRules: ["DEPARTMENT_MANAGER", "ADMIN_FALLBACK"] })).map((candidate) => candidate.userId)).toEqual(["manager-default-scope"]);

    const onlyRequester = resolveCriticalRecipients({ requesterId: "requester", departmentCode: "INPATIENT", candidates }, policy({ requireDistinctRecipients: false }));
    expect(onlyRequester.map((candidate) => candidate.userId)).toEqual(["requester"]);
    expect(() => resolveCriticalRecipients({ departmentCode: "IN PATIENT", candidates }, policy())).toThrow("departmentCode_INVALID");
    expect(() => resolveCriticalRecipients({ departmentCode: "LABORATORY", candidates: [] }, policy({ recipientRules: ["ADMIN_FALLBACK"] }))).toThrow("CRITICAL_RECIPIENTS_UNAVAILABLE");
  });

  it("creates one idempotent escalation decision per due level and stops after acknowledgement", () => {
    const base = {
      notificationId: "notification-critical-1",
      createdAt: "2026-09-05T10:00:00.000Z",
      state: "DELIVERED" as const,
      escalationLevel: 0
    };
    expect(planCriticalEscalation(base, policy(), new Date("2026-09-05T10:14:59.999Z"))).toBeUndefined();
    const first = planCriticalEscalation(base, policy(), new Date("2026-09-05T10:15:00.000Z"));
    expect(first).toMatchObject({ level: 1, dueAt: "2026-09-05T10:15:00.000Z", idempotencyKey: "critical-escalation:notification-critical-1:1" });
    expect(planCriticalEscalation({ ...base, escalationLevel: 1 }, policy(), new Date("2026-09-05T10:29:59.999Z"))).toBeUndefined();
    expect(planCriticalEscalation({ ...base, escalationLevel: 1 }, policy(), new Date("2026-09-05T10:30:00.000Z"))).toMatchObject({ level: 2 });
    // AUD-01: a late worker that only reached level 1 at 10:40 owes level 2 (due 10:30) right away.
    expect(planCriticalEscalation({ ...base, escalationLevel: 1 }, policy(), new Date("2026-09-05T10:40:00.000Z"))).toMatchObject({ level: 2, dueAt: "2026-09-05T10:30:00.000Z" });
    expect(planCriticalEscalation({ ...base, escalationLevel: 3 }, policy(), new Date("2026-09-05T12:00:00.000Z"))).toBeUndefined();
    expect(planCriticalEscalation({ ...base, state: "ACKNOWLEDGED" }, policy(), new Date("2026-09-05T12:00:00.000Z"))).toBeUndefined();
    expect(() => planCriticalEscalation({ ...base, escalationLevel: 99 }, policy(), new Date("2026-09-05T12:00:00.000Z"))).toThrow("CRITICAL_ESCALATION_LEVEL_INVALID");
    expect(planCriticalEscalation({ ...base, createdAt: "2026-08-01T10:00:00.000Z" }, policy(), new Date("2026-09-05T12:00:00.000Z"))).toBeUndefined();
    expect(planCriticalEscalation(base, policy({ effectiveFrom: "2026-09-05T11:00:00.000Z" }), new Date("2026-09-05T10:30:00.000Z"))).toBeUndefined();
  });

  it("has explicit defaults for an unconfigured local policy", () => {
    const defaults = defaultCriticalResultPolicy();
    expect(defaults.escalationAfterMs).toEqual([900_000, 1_800_000, 3_600_000]);
    expect(defaults.recipientRules).toContain("ADMIN_FALLBACK");
    expect(() => validateCriticalResultPolicy(defaults, new Date("2026-09-05T00:00:00.000Z"))).not.toThrow();
  });
});

describe("escalation ladder (PROD-402)", () => {
  const people: CriticalRecipientCandidate[] = [
    { userId: "requester", role: "VETERINARIAN", departmentCode: "INPATIENT", active: true },
    { userId: "on-call-b", role: "VETERINARIAN", departmentCode: "INPATIENT", active: true, onCall: true },
    { userId: "on-call-a", role: "INPATIENT_TEAM", departmentCode: "inpatient", active: true, onCall: true },
    { userId: "on-call-away", role: "VETERINARIAN", departmentCode: "LABORATORY", active: true, onCall: true },
    { userId: "on-call-inactive", role: "VETERINARIAN", departmentCode: "INPATIENT", active: false, onCall: true },
    { userId: "manager", role: "MANAGER", departmentCode: "IT", active: true, managedDepartmentCodes: ["INPATIENT"] }
  ];
  const context = { requesterId: "requester", departmentCode: "INPATIENT", candidates: people };
  const ladder = policy({ recipientRules: ["REQUESTER", "RESPONSIBLE", "ON_CALL", "DEPARTMENT_MANAGER", "ADMIN_FALLBACK"] });

  it("returns the first rule that reaches someone new, with every on-call professional of the department", () => {
    expect(nextCriticalRecipients(context, ladder, new Set())).toEqual({ rule: "REQUESTER", recipients: [people[0]] });
    const onCall = nextCriticalRecipients(context, ladder, new Set(["requester"]));
    expect(onCall?.rule).toBe("ON_CALL");
    expect(onCall?.recipients.map((candidate) => candidate.userId)).toEqual(["on-call-a", "on-call-b"]);
    // The manager works in another department but manages this one.
    expect(nextCriticalRecipients(context, ladder, new Set(["requester", "on-call-a", "on-call-b"]))).toEqual({ rule: "DEPARTMENT_MANAGER", recipients: [people[5]] });
  });

  it("reaches a single person per step when distinct recipients are not required, and nobody once the ladder is exhausted", () => {
    expect(nextCriticalRecipients(context, policy({ ...ladder, requireDistinctRecipients: false }), new Set(["requester"]))?.recipients.map((candidate) => candidate.userId)).toEqual(["on-call-a"]);
    expect(nextCriticalRecipients(context, ladder, new Set(["requester", "on-call-a", "on-call-b", "manager"]))).toBeUndefined();
    expect(() => nextCriticalRecipients(context, policy({ recipientRules: [] }), new Set())).toThrow("CRITICAL_POLICY_RECIPIENT_RULES_EMPTY");
  });

  it("falls back to any professional on call when the requesting department has nobody on call (D-056)", () => {
    const withoutDepartmentOnCall = { ...context, candidates: people.filter((candidate) => !["on-call-a", "on-call-b"].includes(candidate.userId)) };
    expect(nextCriticalRecipients(withoutDepartmentOnCall, ladder, new Set(["requester"]))).toEqual({ rule: "ON_CALL", recipients: [people.find((candidate) => candidate.userId === "on-call-away")] });
    // With somebody on call in the department, the other departments are never reached by this rule.
    expect(nextCriticalRecipients(context, ladder, new Set(["requester", "on-call-a", "on-call-b"]))?.rule).toBe("DEPARTMENT_MANAGER");
  });

  it("keeps the single on-call recipient of the release-time resolution", () => {
    expect(resolveCriticalRecipients(context, policy({ recipientRules: ["ON_CALL", "ADMIN_FALLBACK"] })).map((candidate) => candidate.userId)).toEqual(["on-call-a"]);
  });
});
