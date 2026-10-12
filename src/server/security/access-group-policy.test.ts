import { describe, expect, it } from "vitest";
import { ROLES } from "@cvg/contracts";
import { createDemoState } from "../store/fixtures";
import { canAccessResource, rolePermissions } from "./authorization";
import { expandLegacyPermissions, hydrateUserPermissions, initialSystemAccessGroups, resolveUserPermissions, systemGroupId } from "./access-group-policy";

describe("access groups retain the profile ceiling and independent scope", () => {
  it.each(ROLES)("initial %s group exactly preserves the previous active profile", (role) => {
    const state = { accessGroups: initialSystemAccessGroups("2026-10-11T00:00:00Z") };
    const user = { role, accessGroupId: systemGroupId(role), active: true };
    expect(resolveUserPermissions(state, user)).toEqual(rolePermissions[role]);
    expect(resolveUserPermissions(state, { ...user, active: false })).toEqual([]);
    expect(resolveUserPermissions(state, { ...user, accessGroupId: "unknown" })).toEqual([]);
  });
  it("retains legacy unassigned users without treating an invalid or inactive group as a legacy fallback", () => {
    const groups = initialSystemAccessGroups("2026-10-11T00:00:00Z");
    const user = { role: "VETERINARIAN" as const, active: true };
    expect(resolveUserPermissions({ accessGroups: groups }, user)).toEqual(rolePermissions.VETERINARIAN);
    groups.find((group) => group.id === systemGroupId("VETERINARIAN"))!.active = false;
    expect(resolveUserPermissions({ accessGroups: groups }, { ...user, accessGroupId: systemGroupId("VETERINARIAN") })).toEqual([]);
  });
  it("expands legacy manage grants without allowing a create-only group to update or deactivate", () => {
    expect(expandLegacyPermissions(["user_role.manage"])).toEqual(expect.arrayContaining(["user.create", "user.update", "user.deactivate", "access_group.assign"]));
    const state = createDemoState("group-policy-test-password");
    const group = state.accessGroups.find((entry) => entry.id === systemGroupId("ADMIN"))!;
    group.permissions = ["user.create"];
    const actor = hydrateUserPermissions(state, state.users.find((user) => user.role === "ADMIN")!);
    expect(canAccessResource(actor, "user.create", {})).toBe(true);
    expect(canAccessResource(actor, "user.update", {})).toBe(false);
    expect(canAccessResource(actor, "user.deactivate", {})).toBe(false);
    expect(canAccessResource(actor, "user_role.manage", {})).toBe(false);
  });
  it("a maximally permissive group supplies neither clinical eligibility to ADMIN nor global patients to a clinician", () => {
    const state = createDemoState("group-policy-test-password");
    for (const group of state.accessGroups) group.permissions = [...rolePermissions.SUPERADMIN];
    const admin = hydrateUserPermissions(state, state.users.find((user) => user.role === "ADMIN")!);
    const vet = hydrateUserPermissions(state, state.users.find((user) => user.role === "VETERINARIAN")!);
    expect(canAccessResource(admin, "result.release", {})).toBe(false);
    expect(canAccessResource(vet, "patient.view", { patientId: "outside-scope" })).toBe(false);
    expect(canAccessResource(vet, "sample.receive", {})).toBe(false);
    expect(canAccessResource(vet, "result.draft.edit_own", { patientId: "patient-thor", ownerId: "other-author" })).toBe(false);
  });
});
