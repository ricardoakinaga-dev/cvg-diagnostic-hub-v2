import { describe, expect, it } from "vitest";
import type { User } from "../domain/models";
import { createDemoState } from "../store/fixtures";
import { criticalReadinessChecks, criticalResultReadiness } from "./critical-readiness";

const approved = { CRITICAL_POLICY_ENABLED: "true", CRITICAL_POLICY_VERSION: "v1", CRITICAL_POLICY_APPROVAL_REF: "ATA-3", CRITICAL_POLICY_APPROVED_AT: "2026-01-01T00:00:00.000Z" };
const now = new Date("2026-10-10T12:00:00.000Z");

describe("critical result readiness (D-056)", () => {
  it("reports the policy off, no redundant channel and the requesting departments without anyone on call", () => {
    const state = createDemoState("readiness-password");
    const readiness = criticalResultReadiness(state, {}, now);
    expect(readiness).toMatchObject({ asOf: now.toISOString(), policy: { status: "OFF" }, redundantChannel: { status: "MISSING" }, ready: false });
    expect(criticalReadinessChecks(readiness)).toEqual({ policy: 0, redundant_channel: 0, on_call: 0 });
    expect(readiness.onCall.total).toBe(0);
    expect(readiness.onCall.departments.map((entry) => entry.departmentCode)).toEqual(readiness.onCall.departmentsWithoutOnCall);
    expect(readiness.onCall.departmentsWithoutOnCall).toContain("INPATIENT");
    expect(readiness.administrators).toBe(1);
  });

  it("tells an enabled but incomplete policy from an approved one", () => {
    const state = createDemoState("readiness-password");
    expect(criticalResultReadiness(state, { CRITICAL_POLICY_ENABLED: "true" }, now).policy).toEqual({ status: "INVALID" });
    expect(criticalResultReadiness(state, approved, now).policy).toEqual({ status: "ACTIVE", version: "v1", approvalRef: "ATA-3" });
  });

  it("counts an active SUPERADMIN as an administrator and a clinical requester, preserving inactive exclusions", () => {
    const base = createDemoState("readiness-password");
    const users: User[] = base.users.map((user) => user.role === "ADMIN"
      ? { ...user, role: "SUPERADMIN", onCall: true }
      : ["VETERINARIAN", "INPATIENT_TEAM", "MANAGER"].includes(user.role) ? { ...user, onCall: true } : user);
    const environment = { ...approved, CRITICAL_POLICY_IN_APP_ONLY_APPROVAL_REF: "ATA-SUPER" };
    const readiness = criticalResultReadiness({ users }, environment, now);
    const superadmin = users.find((user) => user.role === "SUPERADMIN")!;
    expect(readiness).toMatchObject({ administrators: 1, ready: true });
    expect(readiness.onCall.departments.find((department) => department.departmentCode === superadmin.departmentCode)).toMatchObject({ requesters: 1, onCall: 1 });
    const inactive = criticalResultReadiness({ users: users.map((user) => user.role === "SUPERADMIN" ? { ...user, active: false } : user) }, environment, now);
    expect(inactive).toMatchObject({ administrators: 0, ready: false });
  });

  it("is ready with the approved policy, WhatsApp or a named in-app-only acceptance, and someone on call in every requesting department", () => {
    const base = createDemoState("readiness-password");
    const onCall = (user: User) => ({ ...user, onCall: true });
    const requesters = base.users.filter((user) => ["VETERINARIAN", "INPATIENT_TEAM"].includes(user.role));
    const departments = [...new Set(requesters.map((user) => user.departmentCode))];
    const covered = { ...base, users: base.users.map((user) => departments.includes(user.departmentCode) && user.role === "VETERINARIAN" ? onCall(user) : user) };
    const coveredReadiness = criticalResultReadiness(covered, { ...approved, WHATSAPP_ENABLED: "true" }, now);
    expect(coveredReadiness.onCall.departmentsWithoutOnCall).toEqual([]);
    expect(coveredReadiness.redundantChannel).toEqual({ status: "WHATSAPP" });
    expect(coveredReadiness.ready).toBe(true);
    expect(criticalReadinessChecks(coveredReadiness)).toEqual({ policy: 1, redundant_channel: 1, on_call: 1 });

    const accepted = criticalResultReadiness(covered, { ...approved, CRITICAL_POLICY_IN_APP_ONLY_APPROVAL_REF: "  ATA-4  " }, now);
    expect(accepted.redundantChannel).toEqual({ status: "IN_APP_ONLY_ACCEPTED", approvalRef: "ATA-4" });
    expect(accepted.ready).toBe(true);

    // A deactivated on-call professional and a VIEWER on call do not count; an on-call elsewhere keeps the total but not the department.
    const degraded = { ...covered, users: covered.users.map((user) => user.onCall ? { ...user, active: false } : user.id === "user-admin" ? user : user).concat([{ ...requesters[0], id: "user-viewer-on-call", email: "viewer@cvg.local", role: "VIEWER", onCall: true, active: true, version: 1 }, { ...requesters[0], id: "user-away-on-call", email: "away@cvg.local", departmentCode: "surgery", onCall: true, active: true, version: 1 }]) };
    const degradedReadiness = criticalResultReadiness(degraded, { ...approved, WHATSAPP_ENABLED: "true" }, now);
    expect(degradedReadiness.onCall.total).toBe(1);
    expect(degradedReadiness.onCall.departments.find((entry) => entry.departmentCode === "SURGERY")).toMatchObject({ onCall: 1 });
    expect(degradedReadiness.onCall.departmentsWithoutOnCall).toContain("INPATIENT");
    expect(degradedReadiness.ready).toBe(false);

    const withoutAdmin = criticalResultReadiness({ ...covered, users: covered.users.filter((user) => user.role !== "ADMIN") }, { ...approved, WHATSAPP_ENABLED: "true" }, now);
    expect(withoutAdmin).toMatchObject({ administrators: 0, ready: false });
  });
});
