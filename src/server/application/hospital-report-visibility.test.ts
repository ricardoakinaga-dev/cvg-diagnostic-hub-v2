import { describe, expect, it } from "vitest";
import { hospitalOperationFixture } from "../../test/hospital-operation-fixtures";
import { systemGroupId } from "../security/access-group-policy";
import { auditEventWithinScope, auditScopeForActor } from "./audit-read";
import { eventVisible } from "./realtime-visibility";
import { canAccessHospitalReport } from "./hospital-report-policy";

describe("current report audit and realtime visibility", () => {
  it("keeps private reports with their owner and shares only authorized definitions, including administrative fallback", async () => {
    const f = hospitalOperationFixture();
    await f.store.transaction((state) => ({ state: { ...state, users: [...state.users,
      { ...f.user("user-us"), id: "report-peer", email: "report-peer@example.test" },
      { ...f.user("user-admin"), id: "report-super", email: "report-super@example.test", role: "SUPERADMIN", accessGroupId: systemGroupId("SUPERADMIN") }
    ] }, result: undefined }));
    const input = { metricCode: "TASK_CREATED" as const, filters: { from: "2026-10-11T00:00:00.000Z", to: "2026-10-12T00:00:00.000Z", departmentCode: "ULTRASOUND" }, format: "CSV" as const };
    const privateReport = await f.service.createHospitalReport(f.user("user-us"), { ...input, name: "Privado sintético", idempotencyKey: "private-report" });
    const sharedReport = await f.service.createHospitalReport(f.user("user-us"), { ...input, name: "Compartilhado sintético", sharedDepartmentCode: "ULTRASOUND", idempotencyKey: "shared-report" });
    const state = f.store.getState();
    const visible = (userId: string, reportId: string) => {
      const actor = f.user(userId);
      const event = state.auditEvents.find((entry) => entry.entityType === "HospitalReport" && entry.entityId === reportId)!;
      return { read: canAccessHospitalReport(state, actor, reportId), stream: eventVisible(state, actor, "HospitalReport", reportId, {}), audit: auditEventWithinScope(auditScopeForActor(state, actor), event) };
    };
    expect(visible("user-us", privateReport.id)).toEqual({ read: true, stream: true, audit: true });
    for (const userId of ["report-peer", "user-admin", "report-super", "user-lab"]) expect(visible(userId, privateReport.id)).toEqual({ read: false, stream: false, audit: false });
    expect(visible("report-peer", sharedReport.id)).toEqual({ read: true, stream: true, audit: true });
    expect(visible("report-super", sharedReport.id)).toEqual({ read: true, stream: true, audit: true });
    for (const userId of ["user-admin", "user-lab"]) expect(visible(userId, sharedReport.id)).toEqual({ read: false, stream: false, audit: false });
  });

  it("withdraws streams and audit visibility from a cached actor when report source permissions or sharing are revoked", async () => {
    const f = hospitalOperationFixture();
    await f.store.transaction((state) => ({ state: { ...state, users: [...state.users, { ...f.user("user-us"), id: "report-peer", email: "report-peer@example.test" }] }, result: undefined }));
    const owner = f.user("user-us"); const peer = f.user("report-peer");
    const report = await f.service.createHospitalReport(owner, { name: "Revogação sintética", sharedDepartmentCode: "ULTRASOUND", metricCode: "TASK_CREATED", filters: { from: "2026-10-11T00:00:00.000Z", to: "2026-10-12T00:00:00.000Z" }, format: "JSONL", idempotencyKey: "revocation-report" });
    const event = f.store.getState().auditEvents.find((entry) => entry.entityType === "HospitalReport" && entry.entityId === report.id)!;
    expect(eventVisible(f.store.getState(), peer, "HospitalReport", report.id, {})).toBe(true);
    await f.service.updateHospitalReport(owner, report.id, { sharedDepartmentCode: null, expectedVersion: 1, idempotencyKey: "unshare-report" });
    expect(eventVisible(f.store.getState(), peer, "HospitalReport", report.id, {})).toBe(false);
    expect(auditEventWithinScope(auditScopeForActor(f.store.getState(), peer), event)).toBe(false);
    expect(eventVisible(f.store.getState(), owner, "HospitalReport", report.id, {})).toBe(true);
    await f.store.transaction((state) => ({ state: { ...state, accessGroups: state.accessGroups.map((group) => group.id === owner.accessGroupId ? { ...group, permissions: group.permissions.filter((permission) => permission !== "hospital_task.view") } : group) }, result: undefined }));
    expect(eventVisible(f.store.getState(), owner, "HospitalReport", report.id, {})).toBe(false);
    expect(auditEventWithinScope(auditScopeForActor(f.store.getState(), owner), event)).toBe(false);
    await expect(f.service.listHospitalReports(owner)).resolves.toEqual([]);
    await f.store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === owner.id ? { ...user, active: false } : user) }, result: undefined }));
    expect(canAccessHospitalReport(f.store.getState(), owner, report.id)).toBe(false);
  });
});
