import { describe, expect, it } from "vitest";
import { hospitalOperationFixture } from "../../test/hospital-operation-fixtures";
import { verifyPassword } from "../security/password";
const password = "Cvg1-InvitationRecipient-Synthetic-782!";
async function invitation(f: ReturnType<typeof hospitalOperationFixture>, key = "invite", email = "invitee@example.test") {
  const group = f.store.getState().accessGroups.find((entry) => entry.systemRole === "VIEWER")!;
  return f.service.createHospitalUserInvitation(f.user("user-admin"), { email, displayName: "Pessoa sintética", role: "VIEWER", departmentCode: "ULTRASOUND", accessGroupId: group.id, expectedGroupVersion: group.version, expiresInHours: 24, idempotencyKey: key });
}
describe("single institution configuration and revocable onboarding", () => {
  it("requires an explicit initial version and protects concurrent sector capability changes", async () => {
    const f = hospitalOperationFixture(); const admin = f.user("user-admin");
    expect((await f.service.getHospitalInstitutionSettings(f.user("user-us"))).settings).toBeNull();
    await expect(f.service.putHospitalInstitutionSettings(admin, { name: "Fuso divergente", timezone: "UTC", expectedVersion: 0, idempotencyKey: "wrong-timezone" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(f.store.getState().hospitalInstitutionSettings).toEqual([]);
    await expect(f.service.putHospitalInstitutionSettings(admin, { name: "Hospital sintético", timezone: "America/Sao_Paulo", expectedVersion: 1, idempotencyKey: "bad-initial" })).rejects.toMatchObject({ code: "STALE_VERSION" });
    const settings = await f.service.putHospitalInstitutionSettings(admin, { name: "Hospital sintético", timezone: "America/Sao_Paulo", expectedVersion: 0, idempotencyKey: "configure" });
    const attempts = await Promise.allSettled([f.service.putHospitalDepartmentCapabilities(admin, "ULTRASOUND", { disabledNewWork: ["TASKS"], archived: false, expectedVersion: settings.version, idempotencyKey: "caps-a" }), f.service.putHospitalDepartmentCapabilities(admin, "LABORATORY", { disabledNewWork: [], archived: true, expectedVersion: settings.version, idempotencyKey: "caps-b" })]);
    expect(attempts.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(attempts.find((entry) => entry.status === "rejected")).toMatchObject({ reason: { code: "STALE_VERSION" } });
  });
  it("disables new task creation while retaining existing pending execution and clinical grants", async () => {
    const f = hospitalOperationFixture(); const task = await f.task("before-off"); const before = f.store.getState().patientGrants;
    const admin = f.user("user-admin"); await f.service.putHospitalInstitutionSettings(admin, { name: "Hospital sintético", timezone: "America/Sao_Paulo", expectedVersion: 0, idempotencyKey: "institution" });
    await f.service.putHospitalDepartmentCapabilities(admin, "ULTRASOUND", { disabledNewWork: ["TASKS"], archived: true, expectedVersion: 1, idempotencyKey: "module-off" });
    await expect(f.task("after-off")).rejects.toMatchObject({ code: "DEPARTMENT_WORK_DISABLED" });
    expect((await f.service.listHospitalTasks(f.user("user-us"))).items.map((entry) => entry.task.id)).toContain(task.task.id);
    const started = await f.service.commandHospitalTask(f.user("user-us"), task.task.id, { command: "START", expectedVersion: 1, idempotencyKey: "existing-start" });
    expect((await f.service.commandHospitalTask(f.user("user-us"), task.task.id, { command: "COMPLETE", note: "Conclusão sintética", expectedVersion: started.task.version, idempotencyKey: "existing-complete" })).task.phase).toBe("COMPLETED");
    expect(f.store.getState().patientGrants).toEqual(before);
  });
  it("keeps institution configuration administrative and never grants technical ADMIN patient operation", async () => {
    const f = hospitalOperationFixture(); await expect(f.service.putHospitalInstitutionSettings(f.user("user-us"), { name: "Troca", timezone: "UTC", expectedVersion: 0, idempotencyKey: "denied" })).rejects.toMatchObject({ status: 404 });
    const issued = await invitation(f); expect(issued.tokenReturnedOnce).toBe(true);
    expect((await f.service.getHospitalInstitutionSettings(f.user("user-admin"))).permissions).toContain("institution.manage");
    await expect(f.service.listHospitalTasks(f.user("user-admin"))).rejects.toMatchObject({ status: 404 });
  });
  it("returns invitation tokens once and creates one user atomically with a recipient chosen password", async () => {
    const f = hospitalOperationFixture(); const before = f.store.getState().patientGrants; const issued = await invitation(f);
    const replay = await invitation(f); expect(replay).toMatchObject({ tokenReturnedOnce: false }); expect(replay.token).toBeUndefined();
    expect(JSON.stringify(f.store.getState())).not.toContain(issued.token!);
    expect(await f.service.previewHospitalUserInvitation({ token: issued.token! })).toMatchObject({ maskedEmail: "i***@example.test" });
    const races = await Promise.allSettled([f.service.acceptHospitalUserInvitation({ token: issued.token!, password }), f.service.acceptHospitalUserInvitation({ token: issued.token!, password })]);
    expect(races.filter((entry) => entry.status === "fulfilled")).toHaveLength(1); expect(races.find((entry) => entry.status === "rejected")).toMatchObject({ reason: { code: "INVITATION_INVALID" } });
    const created = f.store.getState().users.filter((user) => user.email === "invitee@example.test"); expect(created).toHaveLength(1); expect(created[0]).toMatchObject({ role: "VIEWER", departmentCode: "ULTRASOUND", accessGroupId: issued.invitation.accessGroupId, mustChangePassword: false }); expect(verifyPassword(password, created[0].passwordHash)).toBe(true);
    expect(f.store.getState().patientGrants).toEqual(before); expect(JSON.stringify(f.store.getState())).not.toContain(password);
  });
  it("rejects expiration, revocation and changed group versions without creating users", async () => {
    const f = hospitalOperationFixture(); const expired = await invitation(f, "expired", "expired@example.test");
    await f.store.transaction((state) => ({ state: { ...state, hospitalUserInvitations: state.hospitalUserInvitations.map((entry) => ({ ...entry, expiresAt: "2020-01-01T00:00:00.000Z" })) }, result: undefined }));
    await expect(f.service.acceptHospitalUserInvitation({ token: expired.token!, password })).rejects.toMatchObject({ code: "INVITATION_INVALID" });
    const revoked = await invitation(f, "revoked", "revoked@example.test"); await f.service.revokeHospitalUserInvitation(f.user("user-admin"), revoked.invitation.id, { expectedVersion: 1, reason: "Teste sintético", idempotencyKey: "revoke" });
    await expect(f.service.previewHospitalUserInvitation({ token: revoked.token! })).rejects.toMatchObject({ code: "INVITATION_INVALID" });
    const changed = await invitation(f, "changed", "changed@example.test"); await f.store.transaction((state) => ({ state: { ...state, accessGroups: state.accessGroups.map((group) => group.id === changed.invitation.accessGroupId ? { ...group, version: group.version + 1 } : group) }, result: undefined }));
    await expect(f.service.acceptHospitalUserInvitation({ token: changed.token!, password })).rejects.toMatchObject({ code: "INVITATION_INVALID" });
    expect(f.store.getState().users.some((user) => user.email.endsWith("@example.test") && ["expired", "revoked", "changed"].includes(user.email.split("@")[0]))).toBe(false);
  });
  it("revalidates issuer access at acceptance and preserves pending invitation on rejection", async () => {
    const f = hospitalOperationFixture(); const issued = await invitation(f);
    await f.store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === "user-admin" ? { ...user, active: false } : user) }, result: undefined }));
    await expect(f.service.acceptHospitalUserInvitation({ token: issued.token!, password })).rejects.toMatchObject({ code: "INVITATION_INVALID" });
    expect(f.store.getState().hospitalUserInvitations[0].status).toBe("PENDING"); expect(f.store.getState().users.some((user) => user.email === "invitee@example.test")).toBe(false);
  });
});
