import type { RoleCode } from "@cvg/contracts";

/**
 * The policy is deliberately storage neutral.  A relational repository or a
 * durable job can persist this value, while application code keeps all
 * validation and recipient ordering in one place.
 */
export type CriticalRecipientRule =
  | "REQUESTER"
  | "RESPONSIBLE"
  | "DEPARTMENT_MANAGER"
  | "ON_CALL"
  | "ADMIN_FALLBACK";

export interface CriticalResultPolicy {
  readonly version: string;
  readonly approvalRef: string;
  readonly approvedAt: string;
  readonly effectiveFrom: string;
  /** Absolute elapsed times from notification creation to escalation. */
  readonly escalationAfterMs: readonly number[];
  readonly recipientRules: readonly CriticalRecipientRule[];
  readonly requireDistinctRecipients: boolean;
}

export interface CriticalRecipientCandidate {
  readonly userId: string;
  readonly role: RoleCode;
  readonly departmentCode: string;
  readonly active: boolean;
  readonly managedDepartmentCodes?: readonly string[];
  readonly onCall?: boolean;
}

export interface CriticalRecipientContext {
  readonly requesterId?: string;
  readonly responsibleUserId?: string;
  readonly departmentCode: string;
  readonly candidates: readonly CriticalRecipientCandidate[];
}

export interface CriticalEscalationSnapshot {
  readonly notificationId: string;
  readonly createdAt: string;
  readonly state: "PENDING" | "DELIVERED" | "SEEN" | "ESCALATED" | "ACKNOWLEDGED" | "FAILED" | "SUPERSEDED";
  readonly acknowledgedAt?: string;
  readonly escalationLevel: number;
  readonly lastEscalatedAt?: string;
}

export interface CriticalEscalationDecision {
  readonly notificationId: string;
  readonly level: number;
  readonly dueAt: string;
  readonly recipientRules: readonly CriticalRecipientRule[];
  readonly idempotencyKey: string;
}

const DEFAULT_ESCALATION_AFTER_MS = Object.freeze([
  15 * 60 * 1_000,
  30 * 60 * 1_000,
  60 * 60 * 1_000
]);

const RECIPIENT_RULES: readonly CriticalRecipientRule[] = [
  "REQUESTER",
  "RESPONSIBLE",
  "DEPARTMENT_MANAGER",
  "ON_CALL",
  "ADMIN_FALLBACK"
];

export function defaultCriticalResultPolicy(): CriticalResultPolicy {
  return {
    version: "unconfigured",
    approvalRef: "unconfigured",
    approvedAt: "1970-01-01T00:00:00.000Z",
    effectiveFrom: "1970-01-01T00:00:00.000Z",
    escalationAfterMs: DEFAULT_ESCALATION_AFTER_MS,
    recipientRules: ["REQUESTER", "RESPONSIBLE", "DEPARTMENT_MANAGER", "ON_CALL", "ADMIN_FALLBACK"],
    requireDistinctRecipients: true
  };
}

export function criticalPolicyFromEnvironment(environment: Partial<NodeJS.ProcessEnv> = process.env): CriticalResultPolicy | undefined {
  if (environment.CRITICAL_POLICY_ENABLED !== "true") return undefined;
  const version = environment.CRITICAL_POLICY_VERSION?.trim();
  const approvalRef = environment.CRITICAL_POLICY_APPROVAL_REF?.trim();
  const approvedAt = environment.CRITICAL_POLICY_APPROVED_AT?.trim();
  if (!version || !approvalRef || !approvedAt) return undefined;

  const effectiveFrom = environment.CRITICAL_POLICY_EFFECTIVE_FROM?.trim() || approvedAt;
  const escalationAfterMs = parseEscalationAfter(environment.CRITICAL_POLICY_ESCALATION_AFTER_MS);
  const recipientRules = parseRecipientRules(environment.CRITICAL_POLICY_RECIPIENT_RULES);
  const requireDistinctRecipients = environment.CRITICAL_POLICY_DISTINCT_RECIPIENTS !== "false";
  const candidate: CriticalResultPolicy = {
    version,
    approvalRef,
    approvedAt,
    effectiveFrom,
    escalationAfterMs,
    recipientRules,
    requireDistinctRecipients
  };
  try {
    validateCriticalResultPolicy(candidate);
    return candidate;
  } catch {
    return undefined;
  }
}

export function validateCriticalResultPolicy(policy: CriticalResultPolicy, now = new Date()): void {
  nonEmpty(policy.version, "CRITICAL_POLICY_VERSION", 100);
  nonEmpty(policy.approvalRef, "CRITICAL_POLICY_APPROVAL_REF", 200);
  const approvedAt = validTimestamp(policy.approvedAt, "CRITICAL_POLICY_APPROVED_AT");
  const effectiveFrom = validTimestamp(policy.effectiveFrom, "CRITICAL_POLICY_EFFECTIVE_FROM");
  if (effectiveFrom < approvedAt) throw new Error("CRITICAL_POLICY_EFFECTIVE_BEFORE_APPROVAL");
  if (approvedAt > now.getTime()) throw new Error("CRITICAL_POLICY_APPROVAL_IN_FUTURE");
  if (effectiveFrom > now.getTime() + 366 * 24 * 60 * 60 * 1_000) throw new Error("CRITICAL_POLICY_EFFECTIVE_TOO_FAR");

  if (!Array.isArray(policy.escalationAfterMs) || policy.escalationAfterMs.length < 1 || policy.escalationAfterMs.length > 8) {
    throw new Error("CRITICAL_POLICY_ESCALATION_SCHEDULE_INVALID");
  }
  let previous = 0;
  for (const threshold of policy.escalationAfterMs) {
    if (!Number.isSafeInteger(threshold) || threshold < 1_000 || threshold > 30 * 24 * 60 * 60 * 1_000 || threshold <= previous) {
      throw new Error("CRITICAL_POLICY_ESCALATION_SCHEDULE_INVALID");
    }
    previous = threshold;
  }

  if (!Array.isArray(policy.recipientRules) || policy.recipientRules.length < 1) throw new Error("CRITICAL_POLICY_RECIPIENT_RULES_EMPTY");
  const seen = new Set<CriticalRecipientRule>();
  for (const rule of policy.recipientRules) {
    if (!RECIPIENT_RULES.includes(rule) || seen.has(rule)) throw new Error("CRITICAL_POLICY_RECIPIENT_RULE_INVALID");
    seen.add(rule);
  }
  if (!policy.recipientRules.includes("ADMIN_FALLBACK") && !policy.recipientRules.includes("ON_CALL")) {
    throw new Error("CRITICAL_POLICY_NO_FALLBACK");
  }
  if (typeof policy.requireDistinctRecipients !== "boolean") throw new Error("CRITICAL_POLICY_DISTINCT_RECIPIENTS_INVALID");
}

export function resolveCriticalRecipients(
  context: CriticalRecipientContext,
  policy: CriticalResultPolicy
): CriticalRecipientCandidate[] {
  validateCriticalResultPolicy(policy);
  const departmentCode = normalizedCode(context.departmentCode, "departmentCode");
  const activeCandidates = context.candidates
    .filter((candidate) => candidate.active && normalizedCode(candidate.departmentCode, "candidate.departmentCode") === departmentCode)
    .sort((left, right) => left.userId.localeCompare(right.userId));

  const selected: CriticalRecipientCandidate[] = [];
  const selectedIds = new Set<string>();
  const add = (candidate: CriticalRecipientCandidate | undefined) => {
    if (!candidate || selectedIds.has(candidate.userId)) return;
    selectedIds.add(candidate.userId);
    selected.push(candidate);
  };

  for (const rule of policy.recipientRules) {
    if (rule === "REQUESTER") add(activeCandidates.find((candidate) => candidate.userId === context.requesterId));
    if (rule === "RESPONSIBLE") add(activeCandidates.find((candidate) => candidate.userId === context.responsibleUserId));
    if (rule === "ON_CALL") add(activeCandidates.find((candidate) => candidate.onCall === true));
    if (rule === "DEPARTMENT_MANAGER") {
      activeCandidates
        .filter((candidate) => candidate.role === "MANAGER" && (candidate.managedDepartmentCodes ?? [candidate.departmentCode]).some((code) => normalizedCode(code, "managedDepartmentCode") === departmentCode))
        .forEach(add);
    }
    if (rule === "ADMIN_FALLBACK") activeCandidates.filter((candidate) => candidate.role === "ADMIN").forEach(add);
  }

  if (selected.length === 0) throw new Error("CRITICAL_RECIPIENTS_UNAVAILABLE");
  return policy.requireDistinctRecipients ? selected : selected.slice(0, 1);
}

export function planCriticalEscalation(
  snapshot: CriticalEscalationSnapshot,
  policy: CriticalResultPolicy,
  now = new Date()
): CriticalEscalationDecision | undefined {
  validateCriticalResultPolicy(policy, now);
  if (["ACKNOWLEDGED", "SUPERSEDED", "FAILED"].includes(snapshot.state)) return undefined;
  if (!Number.isSafeInteger(snapshot.escalationLevel) || snapshot.escalationLevel < 0 || snapshot.escalationLevel > policy.escalationAfterMs.length) {
    throw new Error("CRITICAL_ESCALATION_LEVEL_INVALID");
  }
  const createdAt = validTimestamp(snapshot.createdAt, "createdAt");
  const currentTime = now.getTime();
  if (currentTime < Date.parse(policy.effectiveFrom)) return undefined;
  const nextThreshold = policy.escalationAfterMs[snapshot.escalationLevel];
  if (nextThreshold === undefined || currentTime - createdAt > 30 * 24 * 60 * 60 * 1_000) return undefined;
  const dueAtMs = createdAt + nextThreshold;
  if (currentTime < dueAtMs) return undefined;
  if (snapshot.lastEscalatedAt && Date.parse(snapshot.lastEscalatedAt) >= dueAtMs) return undefined;
  const level = snapshot.escalationLevel + 1;
  return {
    notificationId: snapshot.notificationId,
    level,
    dueAt: new Date(dueAtMs).toISOString(),
    recipientRules: policy.recipientRules,
    idempotencyKey: `critical-escalation:${snapshot.notificationId}:${level}`
  };
}

function parseEscalationAfter(value: string | undefined): readonly number[] {
  if (!value?.trim()) return DEFAULT_ESCALATION_AFTER_MS;
  const parsed = value.split(",").map((entry) => Number(entry.trim()));
  return parsed.every((entry) => Number.isSafeInteger(entry)) ? parsed : [];
}

function parseRecipientRules(value: string | undefined): readonly CriticalRecipientRule[] {
  if (!value?.trim()) return ["REQUESTER", "RESPONSIBLE", "DEPARTMENT_MANAGER", "ON_CALL", "ADMIN_FALLBACK"];
  return value.split(",").map((entry) => entry.trim().toUpperCase()) as CriticalRecipientRule[];
}

function nonEmpty(value: string, name: string, maxLength: number): void {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) throw new Error(`${name}_INVALID`);
}

function validTimestamp(value: string, name: string): number {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name}_INVALID`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name}_INVALID`);
  return parsed;
}

function normalizedCode(value: string, name: string): string {
  nonEmpty(value, name, 60);
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{1,60}$/.test(normalized)) throw new Error(`${name}_INVALID`);
  return normalized;
}
