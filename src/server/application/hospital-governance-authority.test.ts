import { describe, expect, it, vi } from "vitest";
import { hospitalOperationFixture } from "../../test/hospital-operation-fixtures";
import { systemGroupId } from "../security/access-group-policy";

const password = "Cvg1-SyntheticInvitation-Recipient-491!";
function invitationInput(f: ReturnType<typeof hospitalOperationFixture>, email = "governance@example.test") {
  const group = f.store.getState().accessGroups.find((entry) => entry.systemRole === "VIEWER")!;
  return { email, displayName: "Pessoa sintética", role: "VIEWER" as const, departmentCode: "ULTRASOUND", accessGroupId: group.id, expectedGroupVersion: group.version, expiresInHours: 24, idempotencyKey: `invite-${email}` };
}

describe("institution and onboarding authorization at the command boundary", () => {
  it("requires institutional initialization, replaces only the selected sector and replays current versioned settings", async () => {
    const f = hospitalOperationFixture(); const admin = f.user("user-admin");
    await expect(f.service.putHospitalDepartmentCapabilities(admin, "ULTRASOUND", { disabledNewWork: [], archived: false, expectedVersion: 1, idempotencyKey: "before-config" })).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    const configure = { name: "Hospital sintético", timezone: "America/Sao_Paulo", expectedVersion: 0, idempotencyKey: "config-intent" };
    await f.service.putHospitalInstitutionSettings(admin, configure);
    await f.service.putHospitalDepartmentCapabilities(admin, "ULTRASOUND", { disabledNewWork: ["TASKS"], archived: false, expectedVersion: 1, idempotencyKey: "us-off" });
    await f.service.putHospitalDepartmentCapabilities(admin, "LABORATORY", { disabledNewWork: ["PLANS"], archived: false, expectedVersion: 2, idempotencyKey: "lab-off" });
    const input = { disabledNewWork: [] as [], archived: false, expectedVersion: 3, idempotencyKey: "us-on" };
    const current = await f.service.putHospitalDepartmentCapabilities(admin, "ULTRASOUND", input);
    expect(current.departmentCapabilities).toEqual([{ departmentCode: "LABORATORY", disabledNewWork: ["PLANS"], archived: false }, { departmentCode: "ULTRASOUND", disabledNewWork: [], archived: false }]);
    expect(await f.service.putHospitalDepartmentCapabilities(admin, "ULTRASOUND", input)).toEqual(current);
    const renamed = await f.service.putHospitalInstitutionSettings(admin, { name: "Nome atualizado", timezone: "America/Sao_Paulo", expectedVersion: 4, idempotencyKey: "rename" });
    expect(renamed.departmentCapabilities).toEqual(current.departmentCapabilities);
    expect(await f.service.putHospitalInstitutionSettings(admin, configure)).toEqual(renamed);
    expect((await f.service.getHospitalInstitutionSettings(admin)).settings).toEqual(renamed);
  });

  it("blocks onboarding in an archived sector and restores issuance without expanding any clinical grant", async () => {
    const f = hospitalOperationFixture(); const admin = f.user("user-admin"); const before = f.store.getState().patientGrants;
    await f.service.putHospitalInstitutionSettings(admin, { name: "Instituição para convite", timezone: "America/Sao_Paulo", expectedVersion: 0, idempotencyKey: "institution" });
    await f.service.putHospitalDepartmentCapabilities(admin, "ULTRASOUND", { disabledNewWork: [], archived: true, expectedVersion: 1, idempotencyKey: "archive-sector" });
    await expect(f.service.createHospitalUserInvitation(admin, invitationInput(f))).rejects.toMatchObject({ code: "DEPARTMENT_WORK_DISABLED" });
    await f.service.putHospitalDepartmentCapabilities(admin, "ULTRASOUND", { disabledNewWork: [], archived: false, expectedVersion: 2, idempotencyKey: "restore-sector" });
    const issued = await f.service.createHospitalUserInvitation(admin, invitationInput(f));
    expect(await f.service.previewHospitalUserInvitation({ token: issued.token! })).toMatchObject({ institutionName: "Instituição para convite" });
    await f.service.putHospitalDepartmentCapabilities(admin, "ULTRASOUND", { disabledNewWork: [], archived: true, expectedVersion: 3, idempotencyKey: "archive-again" });
    await expect(f.service.acceptHospitalUserInvitation({ token: issued.token!, password })).rejects.toMatchObject({ code: "INVITATION_INVALID" });
    expect(f.store.getState().hospitalUserInvitations[0].status).toBe("PENDING"); expect(f.store.getState().patientGrants).toEqual(before);
  });

  it("rejects unknown, inactive, undelegable and version-stale groups and technical role spoofing without issuing tokens", async () => {
    const f = hospitalOperationFixture(); const admin = f.user("user-admin"); const base = invitationInput(f);
    await expect(f.service.createHospitalUserInvitation(admin, { ...base, accessGroupId: "unknown" })).rejects.toMatchObject({ status: 404 });
    await expect(f.service.createHospitalUserInvitation(admin, { ...base, expectedGroupVersion: 99 })).rejects.toMatchObject({ code: "STALE_VERSION" });
    await expect(f.service.createHospitalUserInvitation(admin, { ...base, role: "ADMIN" } as never)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await f.store.transaction((state) => ({ state: { ...state, accessGroups: state.accessGroups.map((entry) => entry.id === base.accessGroupId ? { ...entry, active: false } : entry) }, result: undefined }));
    expect((await f.service.getHospitalInvitationOptions(admin)).groups.some((entry) => entry.id === base.accessGroupId)).toBe(false);
    await expect(f.service.createHospitalUserInvitation(admin, base)).rejects.toMatchObject({ status: 404 });
    const manager = f.user("user-manager");
    await expect(f.service.createHospitalUserInvitation(manager, { ...base, departmentCode: "IT" })).rejects.toMatchObject({ status: 404 });
    await expect(f.service.createHospitalUserInvitation(manager, { ...base, accessGroupId: systemGroupId("ADMIN") })).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    const options = await f.service.getHospitalInvitationOptions(manager);
    expect(options.groups.some((entry) => entry.id === systemGroupId("ADMIN"))).toBe(false);
    expect(options.departments.some((entry) => entry.code === "IT")).toBe(false);
    expect(f.store.getState().hospitalUserInvitations).toEqual([]);
  });

  it("rejects duplicate existing identities and live invitations; expired invitations are explicit list metadata", async () => {
    const f = hospitalOperationFixture(); const admin = f.user("user-admin");
    await expect(f.service.createHospitalUserInvitation(admin, invitationInput(f, f.user("user-vet").email))).rejects.toMatchObject({ code: "CONFLICT" });
    const input = invitationInput(f); const issued = await f.service.createHospitalUserInvitation(admin, input);
    await expect(f.service.createHospitalUserInvitation(admin, { ...input, idempotencyKey: "another-intent" })).rejects.toMatchObject({ code: "CONFLICT" });
    await f.store.transaction((state) => ({ state: { ...state, hospitalUserInvitations: state.hospitalUserInvitations.map((entry) => ({ ...entry, expiresAt: "2020-01-01T00:00:00Z" })) }, result: undefined }));
    expect((await f.service.listHospitalUserInvitations(admin))[0]).toMatchObject({ expired: true, invitation: { id: issued.invitation.id, status: "PENDING" } });
    const replacement = await f.service.createHospitalUserInvitation(admin, { ...input, idempotencyKey: "replacement-expired" }); expect(replacement.invitation.id).not.toBe(issued.invitation.id);
    expect(JSON.stringify(await f.service.listHospitalUserInvitations(admin))).not.toMatch(/tokenHash|tokenReturnedOnce/);
  });

  it("revalidates the issuer inside acceptance after public preview, including missing issuer and concurrent grant loss", async () => {
    const f = hospitalOperationFixture(); const admin = f.user("user-admin"); const issued = await f.service.createHospitalUserInvitation(admin, invitationInput(f));
    await f.service.previewHospitalUserInvitation({ token: issued.token! }); const native = f.store.transaction.bind(f.store);
    vi.spyOn(f.store, "transaction").mockImplementationOnce(async (mutator) => {
      await native((state) => ({ state: { ...state, accessGroups: state.accessGroups.map((entry) => entry.id === admin.accessGroupId ? { ...entry, permissions: entry.permissions.filter((permission) => permission !== "user_invite.manage") } : entry) }, result: undefined }));
      return native(mutator);
    });
    await expect(f.service.acceptHospitalUserInvitation({ token: issued.token!, password })).rejects.toMatchObject({ code: "INVITATION_INVALID" });
    expect(f.store.getState().users.some((entry) => entry.email === issued.invitation.email)).toBe(false);
    expect(f.store.getState().hospitalUserInvitations[0].status).toBe("PENDING");
    await f.store.transaction((state) => ({ state: { ...state, users: state.users.filter((entry) => entry.id !== admin.id) }, result: undefined }));
    await expect(f.service.previewHospitalUserInvitation({ token: issued.token! })).rejects.toMatchObject({ code: "INVITATION_INVALID" });
  });

  it("pins revocation versions, rejects missing and out-of-scope invitations, and replays without a second audit", async () => {
    const f = hospitalOperationFixture(); const admin = f.user("user-admin"); const issued = await f.service.createHospitalUserInvitation(admin, invitationInput(f));
    const command = { expectedVersion: 1, reason: "Cancelamento sintético", idempotencyKey: "revoke" };
    await expect(f.service.revokeHospitalUserInvitation(admin, "missing", command)).rejects.toMatchObject({ status: 404 });
    await expect(f.service.revokeHospitalUserInvitation(admin, issued.invitation.id, { ...command, expectedVersion: 8 })).rejects.toMatchObject({ code: "STALE_VERSION" });
    const revoked = await f.service.revokeHospitalUserInvitation(admin, issued.invitation.id, command);
    expect(await f.service.revokeHospitalUserInvitation(admin, issued.invitation.id, command)).toEqual(revoked);
    await expect(f.service.revokeHospitalUserInvitation(admin, issued.invitation.id, { ...command, expectedVersion: 2, idempotencyKey: "revoke-again" })).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    expect(f.store.getState().auditEvents.filter((entry) => entry.eventType === "HospitalUserInvitationRevoked")).toHaveLength(1);
  });
});
