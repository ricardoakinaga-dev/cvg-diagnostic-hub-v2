import { describe, expect, it } from "vitest";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { createApplicationService } from "./service";
import { requireActiveDepartment, reconcileDepartmentMembership } from "./department-registry";

function setup() {
  const store = new MemoryStore(createDemoState("hospital-department-tests"));
  const service = createApplicationService(store);
  const users = store.getState().users;
  return { store, service, admin: users.find((user) => user.role === "ADMIN")!, manager: users.find((user) => user.role === "MANAGER")!, vet: users.find((user) => user.role === "VETERINARIAN")!, lab: users.find((user) => user.role === "LAB_TECH")! };
}

describe("persisted hospital department lifecycle", () => {
  it("creates a normalized stable identity, replays exactly once and rejects reused codes", async () => {
    const { store, service, admin } = setup();
    const input = { code: " dentist ", name: "Odontologia", type: "CLINICAL" as const, idempotencyKey: "department-create" };
    const department = await service.createDepartment(admin, input);
    expect(department).toMatchObject({ code: "DENTIST", active: true, version: 1, memberUserIds: [] });
    expect(await service.createDepartment(admin, { ...input, correlationId: "retry-correlation" })).toEqual(department);
    expect(store.getState().departments.filter((entry) => entry.code === "DENTIST")).toHaveLength(1);
    await expect(service.createDepartment(admin, { ...input, idempotencyKey: "another-key" })).rejects.toMatchObject({ status: 409 });
    await expect(service.createDepartment(admin, { ...input, name: "Outro nome" })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    expect(store.getState().auditEvents.filter((event) => event.eventType === "DepartmentCreated")).toHaveLength(1);
  });

  it("denies create/update/deactivate independently with current effective permissions", async () => {
    const { store, service, admin, manager, vet } = setup();
    await expect(service.createDepartment(manager, { code: "X", name: "X", type: "SUPPORT", idempotencyKey: "denied-manager" })).rejects.toMatchObject({ status: 404 });
    await expect(service.deactivateDepartment(vet, "department-INPATIENT", { expectedVersion: 1, idempotencyKey: "denied-vet" })).rejects.toMatchObject({ status: 404 });
    const actor = { ...admin, permissions: ["department.create" as const] };
    const created = await service.createDepartment(actor, { code: "NEW", name: "Novo", type: "SUPPORT", idempotencyKey: "create-only" });
    await expect(service.updateDepartment(actor, created.id, { name: "Editar", expectedVersion: 1, idempotencyKey: "update-denied" })).rejects.toMatchObject({ status: 404 });
    await expect(service.deactivateDepartment(actor, created.id, { expectedVersion: 1, idempotencyKey: "deactivate-denied" })).rejects.toMatchObject({ status: 404 });
    expect(store.getState().departments.find((entry) => entry.id === created.id)?.version).toBe(1);
  });

  it("requires idempotency and optimistic version and serializes competing edits", async () => {
    const { service, admin } = setup();
    await expect(service.createDepartment(admin, { code: "TEST", name: "Teste", type: "SUPPORT" })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED" });
    await expect(service.updateDepartment(admin, "department-IT", { name: "TI", idempotencyKey: "missing-version" })).rejects.toMatchObject({ status: 400 });
    const attempts = await Promise.allSettled([
      service.updateDepartment(admin, "department-IT", { name: "TI A", expectedVersion: 1, idempotencyKey: "concurrent-a" }),
      service.updateDepartment(admin, "department-IT", { name: "TI B", expectedVersion: 1, idempotencyKey: "concurrent-b" })
    ]);
    expect(attempts.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(attempts.find((entry) => entry.status === "rejected")).toMatchObject({ reason: { code: "STALE_VERSION" } });
  });

  it("lets a delegated manager edit a sector but denies one outside delegation", async () => {
    const { service, manager } = setup();
    const updated = await service.updateDepartment(manager, "department-LABORATORY", { name: "Análises clínicas", expectedVersion: 1, idempotencyKey: "manager-lab" });
    expect(updated.code).toBe("LABORATORY");
    await expect(service.updateDepartment(manager, "department-IT", { name: "TI", expectedVersion: 1, idempotencyKey: "manager-it" })).rejects.toMatchObject({ status: 404 });
  });

  it("inactivates without deleting references and permits reactivation with a new version", async () => {
    const { store, service, admin } = setup();
    const before = store.getState();
    const input = { expectedVersion: 1, idempotencyKey: "deactivate-lab" };
    const inactive = await service.deactivateDepartment(admin, "department-LABORATORY", input);
    expect(inactive).toMatchObject({ active: false, version: 2, code: "LABORATORY" });
    expect(await service.deactivateDepartment(admin, inactive.id, input)).toEqual(inactive);
    expect(store.getState().services).toEqual(before.services);
    expect(store.getState().users).toEqual(before.users);
    expect(() => requireActiveDepartment(store.getState(), inactive.code)).toThrow("setor ativo");
    expect(await service.updateDepartment(admin, inactive.id, { active: true, expectedVersion: 2, idempotencyKey: "reactivate-lab" })).toMatchObject({ active: true, version: 3 });
  });

  it("validates responsible membership and never grants clinical scope from team membership", async () => {
    const { store, service, admin, manager, vet, lab } = setup();
    const before = store.getState().users;
    const department = await service.setDepartmentMembers(manager, "department-LABORATORY", { memberUserIds: [lab.id], responsibleUserId: lab.id, expectedVersion: 1, idempotencyKey: "members-lab" });
    expect(department.responsibleUserId).toBe(lab.id);
    expect(store.getState().users).toEqual(before);
    await expect(service.setDepartmentMembers(admin, department.id, { memberUserIds: [vet.id], expectedVersion: 2, idempotencyKey: "foreign-member" })).rejects.toMatchObject({ status: 400 });
    await expect(service.setDepartmentMembers(admin, department.id, { memberUserIds: [], responsibleUserId: lab.id, expectedVersion: 2, idempotencyKey: "responsible-nonmember" })).rejects.toMatchObject({ status: 400 });
    const reconciled = reconcileDepartmentMembership(store.getState(), { ...lab, active: false }, new Date().toISOString());
    expect(reconciled.find((entry) => entry.id === department.id)).toMatchObject({ memberUserIds: [], responsibleUserId: undefined });
  });
});
