import { describe, expect, it } from "vitest";
import { canAccessResource, hasPermission, hasPermissionForUser, rolePermissions } from "./authorization";

describe("server authorization", () => {
  it("grants encounter.manage only to veterinarians, the inpatient team and managers", () => {
    for (const role of ["VETERINARIAN", "INPATIENT_TEAM", "MANAGER"] as const) expect(hasPermission(role, "encounter.manage")).toBe(true);
    for (const role of ["ADMIN", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "VIEWER"] as const) expect(hasPermission(role, "encounter.manage")).toBe(false);
    const vet = { id: "user-care", role: "VETERINARIAN" as const, departmentCode: "INPATIENT", patientIds: ["patient-1"] };
    expect(canAccessResource(vet, "encounter.manage", { patientId: "patient-1" })).toBe(true);
    expect(canAccessResource(vet, "encounter.manage", { patientId: "patient-2" })).toBe(false);
  });

  it("grants lab operations only to a lab role", () => {
    expect(hasPermission("LAB_TECH", "sample.receive")).toBe(true);
    expect(hasPermission("VETERINARIAN", "sample.receive")).toBe(false);
  });

  it("does not allow a client-supplied department to widen a scope", () => {
    const actor = {
      id: "user-care",
      role: "VETERINARIAN" as const,
      departmentCode: "INPATIENT",
      patientIds: ["patient-1"]
    };

    expect(
      canAccessResource(actor, "request.view", {
        patientId: "patient-2",
        departmentCode: "INPATIENT"
      })
    ).toBe(false);
    expect(rolePermissions.VETERINARIAN).not.toContain("sample.receive");
  });

  it("does not grant attachment bytes to a read-only viewer", () => {
    expect(hasPermission("VIEWER", "attachment.download")).toBe(false);
    expect(hasPermission("VETERINARIAN", "attachment.download")).toBe(true);
  });

  it("enforces a laboratory technician's service scope", () => {
    const labTechnician = {
      id: "user-lab",
      role: "LAB_TECH" as const,
      departmentCode: "LABORATORY",
      serviceCodes: ["HEMOGRAM"],
      active: true
    };

    expect(canAccessResource(labTechnician, "sample.receive", {
      departmentCode: "LABORATORY",
      serviceCode: "HEMOGRAM"
    })).toBe(true);
    expect(canAccessResource(labTechnician, "sample.receive", {
      departmentCode: "LABORATORY",
      serviceCode: "CRP"
    })).toBe(false);
  });

  it("fails closed when optional role scope metadata is absent", () => {
    const labTechnicianWithoutServiceScope = {
      id: "user-lab",
      role: "LAB_TECH" as const,
      departmentCode: "LABORATORY",
      active: true
    };
    const managerWithoutDelegatedDepartments = {
      id: "user-manager",
      role: "MANAGER" as const,
      departmentCode: "INPATIENT",
      active: true
    };

    expect(canAccessResource(labTechnicianWithoutServiceScope, "sample.receive", {
      departmentCode: "LABORATORY",
      serviceCode: "HEMOGRAM"
    })).toBe(false);
    expect(canAccessResource(managerWithoutDelegatedDepartments, "request.view", {
      departmentCode: "INPATIENT"
    })).toBe(true);
    expect(canAccessResource(managerWithoutDelegatedDepartments, "request.view", {
      patientId: "patient-1"
    })).toBe(false);
  });

  it("uses the role matrix instead of treating every permission as granted", () => {
    const viewer = { role: "VIEWER", active: true } as Parameters<typeof hasPermissionForUser>[0];
    expect(hasPermissionForUser(viewer, "sample.receive")).toBe(false);
    expect(hasPermissionForUser(viewer, "request.view")).toBe(true);
    expect(hasPermissionForUser({ ...viewer, active: false }, "request.view")).toBe(false);
  });

  it("rejects an active actor when the requested action is absent from the role matrix", () => {
    const viewer = { id: "viewer", role: "VIEWER" as const, departmentCode: "INPATIENT", active: true };
    expect(canAccessResource(viewer, "sample.receive", {})).toBe(false);
  });

  it("keeps technical administrators out of clinical commands and patient scope", () => {
    const admin = { id: "admin", role: "ADMIN" as const, departmentCode: "IT", active: true };
    expect(hasPermission("ADMIN", "sample.receive")).toBe(false);
    expect(canAccessResource(admin, "patient.view", { patientId: "patient-1" })).toBe(false);
    expect(canAccessResource(admin, "health.readiness", {})).toBe(true);
  });
});
