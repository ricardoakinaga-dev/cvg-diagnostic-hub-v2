import type { RoleCode } from "@cvg/contracts";
import type { StoreState, User } from "../domain/models";
import { hasPermission } from "../security/authorization";
import { criticalPolicyFromEnvironment } from "./critical-result-policy";
import { whatsAppAlertsEnabled } from "./critical-alert-channel";

export type CriticalPolicyStatus = "ACTIVE" | "OFF" | "INVALID";
export type CriticalChannelStatus = "WHATSAPP" | "IN_APP_ONLY_ACCEPTED" | "MISSING";

export interface CriticalReadiness {
  asOf: string;
  /** Approved policy loaded from the environment; INVALID = enabled but incomplete or inconsistent. */
  policy: { status: CriticalPolicyStatus; version?: string; approvalRef?: string };
  /** D3 asks for a redundant channel; without WhatsApp the hospital must accept "in-app only" by name. */
  redundantChannel: { status: CriticalChannelStatus; approvalRef?: string };
  /** Requesting departments (active users who create requests) and who is on call for each of them. */
  onCall: {
    departments: Array<{ departmentCode: string; requesters: number; onCall: number }>;
    departmentsWithoutOnCall: string[];
    /** Active professionals on call anywhere who may acknowledge a critical result (the hospital-wide fallback). */
    total: number;
  };
  administrators: number;
  ready: boolean;
}

const ADMIN: RoleCode = "ADMIN";

/**
 * PROD-401/402 (D3): switching the policy on is not the same as being able to reach someone. This answers,
 * from the current users and configuration, whether a critical result released now would have a redundant
 * channel and an on-call professional behind the requester; it never blocks a release.
 */
export function criticalResultReadiness(state: Pick<StoreState, "users">, environment: Partial<NodeJS.ProcessEnv> = process.env, now = new Date()): CriticalReadiness {
  const policy = criticalPolicyFromEnvironment(environment);
  const policyStatus: CriticalPolicyStatus = policy ? "ACTIVE" : environment.CRITICAL_POLICY_ENABLED === "true" ? "INVALID" : "OFF";
  const inAppOnlyRef = environment.CRITICAL_POLICY_IN_APP_ONLY_APPROVAL_REF?.trim();
  const redundantChannel: CriticalReadiness["redundantChannel"] = whatsAppAlertsEnabled(environment)
    ? { status: "WHATSAPP" }
    : inAppOnlyRef ? { status: "IN_APP_ONLY_ACCEPTED", approvalRef: inAppOnlyRef.slice(0, 200) } : { status: "MISSING" };

  const active = state.users.filter((user) => user.active !== false);
  const requesters = active.filter((user) => hasPermission(user.role, "request.create") && user.role !== ADMIN);
  const acknowledgers = active.filter((user) => user.onCall === true && hasPermission(user.role, "notification.acknowledge"));
  const departmentCodes = [...new Set(requesters.map((user) => normalizedDepartment(user)))].sort();
  const departments = departmentCodes.map((departmentCode) => ({
    departmentCode,
    requesters: requesters.filter((user) => normalizedDepartment(user) === departmentCode).length,
    onCall: acknowledgers.filter((user) => normalizedDepartment(user) === departmentCode).length
  }));
  const departmentsWithoutOnCall = departments.filter((entry) => entry.onCall === 0).map((entry) => entry.departmentCode);
  const administrators = active.filter((user) => user.role === ADMIN).length;
  const ready = policyStatus === "ACTIVE"
    && redundantChannel.status !== "MISSING"
    && acknowledgers.length > 0
    && departmentsWithoutOnCall.length === 0
    && administrators > 0;
  return {
    asOf: now.toISOString(),
    policy: policy ? { status: policyStatus, version: policy.version, approvalRef: policy.approvalRef } : { status: policyStatus },
    redundantChannel,
    onCall: { departments, departmentsWithoutOnCall, total: acknowledgers.length },
    administrators,
    ready
  };
}

/** The 0/1 series behind `cvg_critical_readiness{check}`; the policy series is what gates the Prometheus rule. */
export function criticalReadinessChecks(readiness: CriticalReadiness): Record<"policy" | "redundant_channel" | "on_call", 0 | 1> {
  return {
    policy: readiness.policy.status === "ACTIVE" ? 1 : 0,
    redundant_channel: readiness.redundantChannel.status === "MISSING" ? 0 : 1,
    on_call: readiness.onCall.total > 0 && readiness.onCall.departmentsWithoutOnCall.length === 0 ? 1 : 0
  };
}

function normalizedDepartment(user: Pick<User, "departmentCode">): string {
  return user.departmentCode.trim().toUpperCase();
}
