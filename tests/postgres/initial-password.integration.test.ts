import { describe, expect, it } from "vitest";
import { createApplicationService } from "../../src/server/application/service";
import { createDemoState } from "../../src/server/store/fixtures";
import { authenticateRequest, changeInitialPassword, loginUser } from "../../src/server/security/session";
import { withDisposablePostgresDatabase } from "../support/postgres-test-harness";

const ADMIN_PASSWORD = "postgres-admin-password-1234";

function passwordRequest(login: { sessionToken: string; csrfToken: string }) {
  return new Request("http://localhost/api/v1/session/password", { headers: { cookie: `cvg_session=${login.sessionToken}; cvg_csrf=${login.csrfToken}`, "x-csrf-token": login.csrfToken } });
}

describe("PostgreSQL generated initial password lifecycle", () => {
  it("regenerates a lost credential once under concurrency and revokes sessions across store instances", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const store = await database.createStore(createDemoState(ADMIN_PASSWORD));
      const observer = await database.createStore();
      try {
        const admin = store.getState().users.find((user) => user.role === "ADMIN")!;
        const login = await loginUser(observer, "vet@cvg.local", ADMIN_PASSWORD);
        const input = { expectedVersion: 1, idempotencyKey: "pg-recover-vet" };
        const results = await Promise.all([
          createApplicationService(store).regenerateManagedUserPassword(admin, "user-vet", input),
          createApplicationService(observer).regenerateManagedUserPassword(admin, "user-vet", input)
        ]);
        const secrets = results.flatMap((result) => result.initialPassword ? [result.initialPassword] : []);
        expect(secrets).toHaveLength(1);
        expect(results.map((result) => result.version)).toEqual([2, 2]);
        const secret = secrets[0];
        await expect(authenticateRequest(observer, passwordRequest(login))).rejects.toMatchObject({ status: 401 });
        await expect(loginUser(observer, "vet@cvg.local", ADMIN_PASSWORD)).rejects.toMatchObject({ status: 401 });
        await expect(createApplicationService(observer).regenerateManagedUserPassword(admin, "user-vet", { expectedVersion: 1, idempotencyKey: "pg-stale-reset" })).rejects.toMatchObject({ status: 409 });
        const state = await observer.readState();
        expect(state.users.find((user) => user.id === "user-vet")).toMatchObject({ version: 2, mustChangePassword: true });
        expect(state.auditEvents.filter((event) => event.eventType === "UserPasswordRegenerated")).toHaveLength(1);
        expect(JSON.stringify(state)).not.toContain(secret);
        const temporary = await loginUser(observer, "vet@cvg.local", secret);
        await expect(authenticateRequest(store, passwordRequest(temporary))).rejects.toMatchObject({ code: "PASSWORD_CHANGE_REQUIRED" });
        const changed = await changeInitialPassword(store, passwordRequest(temporary), "Recovered-personal-password-2026", "pg-recovery-change");
        await expect(authenticateRequest(observer, passwordRequest(changed))).resolves.toMatchObject({ mustChangePassword: false });
      } finally { await database.closeStore(observer); await database.closeStore(store); }
    });
  });

  it("rolls back regenerated credentials and session revocations when the audit cannot commit", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const store = await database.createStore(createDemoState(ADMIN_PASSWORD));
      const observer = await database.createStore();
      try {
        const admin = store.getState().users.find((user) => user.role === "ADMIN")!;
        const login = await loginUser(observer, "vet@cvg.local", ADMIN_PASSWORD);
        const before = await observer.readStateSnapshot();
        await database.query(`CREATE FUNCTION reject_recovery_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'RECOVERY_AUDIT_FAILURE'; END; $$`);
        await database.query("CREATE TRIGGER reject_recovery_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_recovery_audit()");
        await expect(createApplicationService(store).regenerateManagedUserPassword(admin, "user-vet", { expectedVersion: 1, idempotencyKey: "pg-recovery-rollback" })).rejects.toThrow("RECOVERY_AUDIT_FAILURE");
        expect(await observer.readStateSnapshot()).toEqual(before);
        await expect(authenticateRequest(observer, passwordRequest(login))).resolves.toMatchObject({ id: "user-vet" });
      } finally { await database.closeStore(observer); await database.closeStore(store); }
    });
  });

  it("persists explicit executor grants and duplicated panel templates across store instances", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const store = await database.createStore(createDemoState(ADMIN_PASSWORD));
      const observer = await database.createStore();
      try {
        const state = await store.readState();
        const admin = state.users.find((user) => user.role === "ADMIN")!;
        const vet = state.users.find((user) => user.role === "VETERINARIAN")!;
        const source = state.services.find((service) => service.id === "service-hemogram")!;
        const service = createApplicationService(store);
        const copied = await service.createDiagnosticService(admin, { ...source, code: "HEMOGRAM_COPY", name: "Hemograma cópia", duplicateOfServiceId: source.id, idempotencyKey: "pg-panel-copy" });
        const created = await service.createManagedUser(admin, { displayName: "Técnica nova", email: "pg-tech@cvg.local", role: "LAB_TECH", departmentCode: "LABORATORY", serviceCodes: [copied.code], idempotencyKey: "pg-tech-create" });
        await service.createRequest(vet, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: copied.id }, { serviceId: "service-crp" }] }, { idempotencyKey: "pg-tech-request" });
        const login = await loginUser(observer, created.email, created.initialPassword!);
        const changed = await changeInitialPassword(store, passwordRequest(login), "personal-tech-password-2026", "pg-tech-password");
        const actor = await authenticateRequest(observer, passwordRequest(changed));
        const queue = await createApplicationService(observer).listQueue(actor, "LABORATORY");
        expect(queue.map((item) => item.service.code)).toEqual([copied.code]);
        const persisted = await observer.readState();
        expect(persisted.users.find((user) => user.id === created.id)?.serviceCodes).toEqual([copied.code]);
        expect(persisted.services.find((item) => item.id === copied.id)?.resultTemplate).toEqual(source.resultTemplate);
        const saved = await service.updateUserRole(admin, created.id, { role: "LAB_TECH", departmentCode: "LABORATORY", serviceCodes: [], expectedVersion: changed.user.version, idempotencyKey: "pg-tech-reset" });
        expect(saved.serviceCodes).toEqual([]);
        await expect(authenticateRequest(observer, passwordRequest(changed))).rejects.toMatchObject({ status: 401 });
      } finally { await database.closeStore(observer); await database.closeStore(store); }
    });
  });
  it("persists only the hash, reveals the password once and enforces replacement across store instances", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const store = await database.createStore(createDemoState(ADMIN_PASSWORD));
      const observer = await database.createStore();
      try {
        const admin = store.getState().users.find((user) => user.role === "ADMIN")!;
        const input = { displayName: "Nova colaboradora", email: "new-user@cvg.local", role: "VIEWER" as const, idempotencyKey: "new-pg-user", correlationId: "corr-pg-user" };
        const created = await createApplicationService(store).createManagedUser(admin, input);
        if (!("initialPassword" in created) || typeof created.initialPassword !== "string") throw new Error("Missing one-time password");
        const secret = created.initialPassword;
        expect(created.departmentCode).toBe(admin.departmentCode);
        expect(JSON.stringify(await observer.readState())).not.toContain(secret);
        const replay = await createApplicationService(observer).createManagedUser(admin, input);
        expect(replay.id).toBe(created.id);
        expect(replay).not.toHaveProperty("initialPassword");
        const login = await loginUser(observer, input.email, secret);
        await expect(authenticateRequest(store, passwordRequest(login))).rejects.toMatchObject({ code: "PASSWORD_CHANGE_REQUIRED" });
        const changed = await changeInitialPassword(store, passwordRequest(login), "My-personal-password-5678", "corr-pg-password");
        await expect(authenticateRequest(observer, passwordRequest(changed))).resolves.toMatchObject({ id: created.id, mustChangePassword: false });
        await expect(authenticateRequest(observer, passwordRequest(login))).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
        await expect(loginUser(observer, input.email, secret)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
        const final = await observer.readState();
        expect(final.auditEvents).toEqual(expect.arrayContaining([expect.objectContaining({ eventType: "InitialPasswordChanged", actorId: created.id })]));
        expect(JSON.stringify(final)).not.toContain(secret);
        expect(JSON.stringify(final)).not.toContain("My-personal-password-5678");
      } finally { await database.closeStore(observer); await database.closeStore(store); }
    });
  });

  it("rolls back credentials, revocations and audit if replacement-session activity cannot commit", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const state = createDemoState(ADMIN_PASSWORD);
      state.users.find((user) => user.id === "user-vet")!.mustChangePassword = true;
      const store = await database.createStore(state);
      const observer = await database.createStore();
      try {
        const login = await loginUser(store, "vet@cvg.local", ADMIN_PASSWORD);
        const before = await observer.readStateSnapshot();
        await database.query(`CREATE FUNCTION reject_new_activity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'ACTIVITY_REPLACEMENT_FAILURE'; END; $$`);
        await database.query("CREATE TRIGGER reject_new_activity BEFORE INSERT ON session_activity FOR EACH ROW EXECUTE FUNCTION reject_new_activity()");
        await expect(changeInitialPassword(store, passwordRequest(login), "My-personal-password-5678", "corr-pg-rollback")).rejects.toThrow("ACTIVITY_REPLACEMENT_FAILURE");
        expect(await observer.readStateSnapshot()).toEqual(before);
        await expect(authenticateRequest(observer, passwordRequest(login), { allowPasswordChange: true })).resolves.toMatchObject({ mustChangePassword: true });
      } finally { await database.closeStore(observer); await database.closeStore(store); }
    });
  });
});
