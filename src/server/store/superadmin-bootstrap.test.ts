import { describe, expect, it } from "vitest";
import { verifyPassword } from "../security/password";
import { MemoryStore } from "./memory-store";
import { createProductionBootstrapState } from "./production-bootstrap";
import { bootstrapSuperadmin } from "./superadmin-bootstrap";

const adminInput = { email: "admin@hospital.example.org", displayName: "Administração", password: "root-of-trust-2026-unique" };
const input = { email: "superadmin@hospital.example.org", displayName: "Superadmin", password: "Lua47-verde-montanha-sol" };
const authorization = { authorization: "ALLOW_SUPERADMIN_BOOTSTRAP" as const };

function installation() {
  const state = createProductionBootstrapState(adminInput);
  state.users[0].mustChangePassword = false;
  state.patients.push({ id: "patient-existing", displayName: "Paciente", species: "canina", breed: "SRD", sex: "F", ownerLabel: "Tutor", externalId: "P001", active: true });
  return new MemoryStore(state);
}

describe("offline superadmin bootstrap", () => {
  it("requires explicit authorization and an existing active administrator", async () => {
    const store = installation();
    const before = await store.readState();
    await expect(bootstrapSuperadmin(store, input)).rejects.toThrow("SUPERADMIN_BOOTSTRAP_REQUIRES_AUTHORIZATION");
    expect(await store.readState()).toEqual(before);
    const disabled = structuredClone(before);
    disabled.users[0].active = false;
    await expect(bootstrapSuperadmin(new MemoryStore(disabled), input, authorization)).rejects.toThrow("SUPERADMIN_BOOTSTRAP_REQUIRES_EXISTING_ADMIN");
  });

  it("creates a separate audited account with a hashed temporary password and preserves existing data", async () => {
    const store = installation();
    const before = await store.readState();
    const result = await bootstrapSuperadmin(store, input, authorization);
    const after = await store.readState();
    expect(result).toMatchObject({ role: "SUPERADMIN", mustChangePassword: true });
    expect(after.users[0]).toEqual(before.users[0]);
    expect(after.patients).toEqual(before.patients);
    expect(after.sessions).toEqual(before.sessions);
    const user = after.users.find((entry) => entry.id === result.userId)!;
    expect(user).toMatchObject({ email: input.email, role: "SUPERADMIN", active: true, mustChangePassword: true });
    expect(verifyPassword(input.password, user.passwordHash)).toBe(true);
    expect(JSON.stringify(after)).not.toContain(input.password);
    expect(after.auditEvents.at(-1)).toMatchObject({ eventType: "SuperadminBootstrapped", entityId: user.id, metadata: { source: "offline-bootstrap" } });
  });

  it("refuses re-provisioning and reused email without changing the installation", async () => {
    const store = installation();
    await expect(bootstrapSuperadmin(store, { ...input, email: adminInput.email }, authorization)).rejects.toThrow("SUPERADMIN_BOOTSTRAP_EMAIL_IN_USE");
    await bootstrapSuperadmin(store, input, authorization);
    const before = await store.readState();
    await expect(bootstrapSuperadmin(store, { ...input, email: "other@hospital.example.org" }, authorization)).rejects.toThrow("SUPERADMIN_ALREADY_PROVISIONED");
    expect(await store.readState()).toEqual(before);
  });

  it("requires a strong usable temporary password", async () => {
    const store = installation();
    await expect(bootstrapSuperadmin(store, { ...input, password: "" }, authorization)).rejects.toThrow("SUPERADMIN_BOOTSTRAP_PASSWORD_REQUIRED");
    await expect(bootstrapSuperadmin(store, { ...input, password: "short1" }, authorization)).rejects.toThrow("pelo menos 16");
    expect((await store.readState()).users).toHaveLength(1);
  });

  it("serializes concurrent bootstrap attempts so only one global administrator is provisioned", async () => {
    const store = installation();
    const attempts = await Promise.allSettled([
      bootstrapSuperadmin(store, input, authorization),
      bootstrapSuperadmin(store, { ...input, email: "other@hospital.example.org" }, authorization)
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect((await store.readState()).users.filter((user) => user.role === "SUPERADMIN")).toHaveLength(1);
  });
});
