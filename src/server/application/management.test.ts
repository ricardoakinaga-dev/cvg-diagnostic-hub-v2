import { describe, expect, it } from "vitest";
import { createApplicationService } from "./service";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { authenticateRequest, loginUser, reauthenticateUser, revokeSession } from "../security/session";

function setup() {
  const store = new MemoryStore(createDemoState("management-test-password"));
  const service = createApplicationService(store);
  const user = (email: string) => {
    const actor = store.getState().users.find((entry) => entry.email === email);
    if (!actor) throw new Error(`missing fixture actor: ${email}`);
    return actor;
  };
  return { store, service, admin: user("admin@cvg.local"), manager: user("manager@cvg.local"), vet: user("vet@cvg.local") };
}

describe("management control center", () => {
  it("fingerprints provisioned passwords confidentially and rejects a changed password on retry", async () => {
    const first = setup();
    const second = setup();
    const baseInput = {
      email: "fingerprint.password@cvg.local",
      displayName: "Senha fora do fingerprint",
      role: "LAB_TECH" as const,
      departmentCode: "LABORATORY",
      timezone: "America/Sao_Paulo",
      reason: "Validar proteção do segredo",
      confirm: true as const,
      idempotencyKey: "password-fingerprint"
    };

    await first.service.createManagedUser({ ...first.admin, reauthenticatedAt: new Date().toISOString() }, {
      ...baseInput,
      password: "first-secure-password-123"
    });
    await second.service.createManagedUser({ ...second.admin, reauthenticatedAt: new Date().toISOString() }, {
      ...baseInput,
      password: "second-secure-password-456"
    });

    const firstFingerprint = first.store.getState().idempotency.find((record) => record.key === baseInput.idempotencyKey)?.payloadHash;
    const secondFingerprint = second.store.getState().idempotency.find((record) => record.key === baseInput.idempotencyKey)?.payloadHash;
    expect(firstFingerprint).toEqual(expect.any(String));
    expect(secondFingerprint).toEqual(expect.any(String));
    expect(secondFingerprint).not.toBe(firstFingerprint);
    await expect(first.service.createManagedUser({ ...first.admin, reauthenticatedAt: new Date().toISOString() }, {
      ...baseInput,
      password: "second-secure-password-456"
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED", status: 409 });
  });

  it("rejects privileged changes when the authenticated step-up session was revoked", async () => {
    const { store, service } = setup();
    const login = await loginUser(store, "admin@cvg.local", "management-test-password");
    const request = new Request("http://localhost/api/v1/session/reauth", {
      headers: { cookie: `cvg_session=${login.sessionToken}` }
    });
    const actor = await reauthenticateUser(store, request, "management-test-password");
    await revokeSession(store, login.sessionToken);

    await expect(service.createManagedUser(actor, {
      email: "revoked.stepup@cvg.local",
      displayName: "Sessão revogada",
      password: "revoked-session-password-123",
      role: "LAB_TECH",
      departmentCode: "LABORATORY",
      timezone: "America/Sao_Paulo",
      reason: "Validar revogação transacional",
      confirm: true,
      idempotencyKey: "revoked-stepup-create"
    })).rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
  });

  it("treats provisioned passwords as opaque values without trimming", async () => {
    const { service, store, admin } = setup();
    const password = " secure-password-123 ";
    const created = await service.createManagedUser({ ...admin, reauthenticatedAt: new Date().toISOString() }, {
      email: "opaque.password@cvg.local",
      displayName: "Senha opaca",
      password,
      role: "LAB_TECH",
      departmentCode: "LABORATORY",
      timezone: "America/Sao_Paulo",
      reason: "Validar credencial literal",
      confirm: true,
      idempotencyKey: "opaque-password-user"
    });

    await expect(loginUser(store, created.email, password)).resolves.toBeTruthy();
    await expect(loginUser(store, created.email, password.trim())).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("lets a delegated manager create and deactivate an operational collaborator", async () => {
    const { store, service, manager } = setup();
    const reauthenticatedManager = { ...manager, reauthenticatedAt: new Date().toISOString() };
    const created = await service.createManagedUser(reauthenticatedManager, {
      email: "new.lab.tech@cvg.local",
      displayName: "Nova técnica de laboratório",
      password: "secure-lab-password-123",
      role: "LAB_TECH",
      departmentCode: "LABORATORY",
      timezone: "America/Sao_Paulo",
      reason: "Admissão operacional para cobertura do laboratório",
      confirm: true,
      idempotencyKey: "management-create-user"
    });

    expect(created).toMatchObject({ email: "new.lab.tech@cvg.local", role: "LAB_TECH", active: true, version: 1 });
    expect(created).not.toHaveProperty("passwordHash");
    expect(store.getState().users.find((user) => user.id === created.id)?.passwordHash).not.toBe("secure-lab-password-123");

    const login = await loginUser(store, "new.lab.tech@cvg.local", "secure-lab-password-123");
    const deactivated = await service.deactivateManagedUser(reauthenticatedManager, created.id, {
      expectedVersion: created.version,
      reason: "Encerramento do acesso operacional",
      confirm: true,
      idempotencyKey: "management-deactivate-user"
    });

    expect(deactivated).toMatchObject({ id: created.id, active: false, version: 2 });
    expect(store.getState().sessions.find((session) => session.tokenHash === store.getState().sessions.find((entry) => entry.userId === created.id)?.tokenHash)?.revokedAt).toBeTruthy();
    await expect(loginUser(store, "new.lab.tech@cvg.local", "secure-lab-password-123")).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(store.getState().auditEvents.map((event) => event.eventType)).toEqual(expect.arrayContaining(["UserCreated", "UserDeactivated"]));
  });

  it("lists sessions without secret material and revokes a target session idempotently", async () => {
    const { store, service, admin, vet } = setup();
    const targetLogin = await loginUser(store, vet.email, "management-test-password");
    const actor = { ...admin, reauthenticatedAt: new Date().toISOString() };
    const targetSessionId = store.getState().sessions.find((session) => session.userId === vet.id)?.id;
    if (!targetSessionId) throw new Error("target session missing");

    const sessions = await service.listManagedSessions(actor);
    expect(sessions.find((session) => session.id === targetSessionId)).toMatchObject({
      userEmail: vet.email,
      status: "ACTIVE",
      current: false
    });
    expect(sessions[0]).not.toHaveProperty("tokenHash");

    const command = { reason: "Encerramento operacional", confirm: true as const, idempotencyKey: "revoke-target-session", correlationId: "corr-session-revoke" };
    const revoked = await service.revokeManagedSession(actor, targetSessionId, command);
    const replay = await service.revokeManagedSession(actor, revoked.id, command);

    expect(revoked).toMatchObject({ userEmail: vet.email, status: "REVOKED", revokedAt: expect.any(String) });
    expect(replay).toEqual(revoked);
    await expect(authenticateRequest(store, new Request("http://localhost", { headers: { cookie: `cvg_session=${targetLogin.sessionToken}` } }))).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    expect(store.getState().auditEvents).toContainEqual(expect.objectContaining({ eventType: "SessionRevoked", entityId: revoked.id, actorId: admin.id }));
  });

  it("keeps delegated managers away from technical roles and outside departments", async () => {
    const { service, manager, admin } = setup();
    const reauthenticatedManager = { ...manager, reauthenticatedAt: new Date().toISOString() };

    await expect(service.createManagedUser(reauthenticatedManager, {
      email: "forbidden.admin@cvg.local",
      displayName: "Tentativa técnica",
      password: "secure-admin-password-123",
      role: "ADMIN",
      departmentCode: "IT",
      timezone: "America/Sao_Paulo",
      reason: "Tentativa indevida",
      confirm: true,
      idempotencyKey: "management-forbidden-admin"
    })).rejects.toMatchObject({ code: "SCOPE_DENIED" });

    await expect(service.updateUserRole(reauthenticatedManager, admin.id, {
      role: "VIEWER",
      departmentCode: "IT",
      active: true,
      expectedVersion: admin.version,
      reason: "Tentativa indevida",
      confirm: true,
      idempotencyKey: "management-forbidden-admin-update"
    })).rejects.toMatchObject({ code: "SCOPE_DENIED" });
  });

  it("lets an administrator configure and revise a manager's delegated departments", async () => {
    const { service, admin } = setup();
    const reauthenticatedAdmin = { ...admin, reauthenticatedAt: new Date().toISOString() };
    const created = await service.createManagedUser(reauthenticatedAdmin, {
      email: "delegated.manager@cvg.local",
      displayName: "Gestora delegada",
      password: "secure-manager-password-123",
      role: "MANAGER",
      departmentCode: "OPERATIONS",
      managedDepartmentCodes: ["laboratory", "RADIOLOGY", "laboratory"],
      timezone: "America/Sao_Paulo",
      reason: "Delegação da operação diagnóstica",
      confirm: true,
      idempotencyKey: "management-create-delegated-manager"
    });

    expect(created).toMatchObject({ role: "MANAGER", departmentCode: "OPERATIONS", managedDepartmentCodes: ["LABORATORY", "RADIOLOGY"] });

    const updated = await service.updateUserRole(reauthenticatedAdmin, created.id, {
      role: "MANAGER",
      departmentCode: "OPERATIONS",
      managedDepartmentCodes: ["ULTRASOUND"],
      active: true,
      expectedVersion: created.version,
      reason: "Revisão do escopo delegado",
      confirm: true,
      idempotencyKey: "management-update-delegated-manager"
    });

    expect(updated).toMatchObject({ id: created.id, managedDepartmentCodes: ["ULTRASOUND"], version: 2 });
  });

  it("returns one scoped operational snapshot with departments and pending work", async () => {
    const { service, manager, vet } = setup();
    const request = await service.createRequest(vet, {
      patientId: "patient-thor",
      encounterId: "encounter-thor",
      priority: "EMERGENCY",
      items: [{ serviceId: "service-hemogram" }, { serviceId: "service-xray" }]
    }, { idempotencyKey: "management-overview-request" });

    const overview = await service.managementOverview(manager);

    expect(overview.asOf).toEqual(expect.any(String));
    expect(overview.summary.activeItems).toBe(2);
    expect(overview.summary.pendingRequests).toBe(1);
    expect(overview.departments.map((department) => department.departmentCode)).toEqual(expect.arrayContaining(["LABORATORY", "RADIOLOGY", "ULTRASOUND"]));
    expect(overview.pending.map((item) => item.requestId)).toEqual(expect.arrayContaining([request.id]));
    expect(overview.pending[0]).toMatchObject({ nextAction: expect.any(String), deepLink: expect.stringContaining(`/requests/${request.id}`) });
  });
});
