import { describe, expect, it } from "vitest";
import { loginUser } from "../../src/server/security/session";
import { completePasswordReset } from "../../src/server/security/password-reset";
import { bootstrapProductionDatabase } from "../../src/server/store/production-bootstrap";
import { withDisposablePostgresDatabase } from "../support/postgres-test-harness";

const ADMIN = { email: "root@hospital.example.org", displayName: "Administração", password: "trust-chain-2026-unique" };

describe("production bootstrap against a migrated PostgreSQL database", () => {
  it("creates the first ADMIN, persists the audit event and lets the runtime authenticate", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const { adminId } = await bootstrapProductionDatabase(database.connectionString(), ADMIN);

      const audit = await database.query("SELECT event_type, entity_id FROM audit_events WHERE entity_id = $1", [adminId]);
      expect(audit.rows).toEqual([{ event_type: "ProductionBootstrap", entity_id: adminId }]);

      const store = await database.createStore();
      expect(store.getState().users.map((user) => user.role)).toEqual(["ADMIN"]);
      expect(store.getState().services).toEqual([]);
      expect(store.getState().auditEvents).toEqual([]);
      expect((await store.readState()).auditEvents).toEqual([]);
      const history = await store.readAuditEvents({ scope: { entities: [{ entityType: "User", entityId: adminId }] }, order: "asc", limit: 1000 });
      expect(history.items).toEqual([expect.objectContaining({ eventType: "ProductionBootstrap", entityId: adminId })]);
      const login = await loginUser(store, ADMIN.email, ADMIN.password);
      expect(login.sessionToken).toBeTruthy();
    });
  });

  it("bootstraps without a password: persists only the token hash, audits the link and completes the first login through it (PROD-202)", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const { adminId, resetUrl, expiresAt } = await bootstrapProductionDatabase(database.connectionString(), { ...ADMIN, password: "" });
      expect(resetUrl).toMatch(/\/reset-password\?token=[A-Za-z0-9_-]{43}$/);
      expect(Date.parse(expiresAt!)).toBeGreaterThan(Date.now());
      const token = new URL(resetUrl!, "http://x").searchParams.get("token")!;

      const stored = await database.query("SELECT data FROM cvg_runtime_entities WHERE collection = 'users' AND entity_key = $1", [adminId]);
      expect(JSON.stringify(stored.rows)).not.toContain(token);
      expect((stored.rows[0] as { data: unknown }).data).toMatchObject({ mustChangePassword: true, passwordReset: { tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/), issuedBy: "bootstrap", expiresAt } });
      const audit = await database.query("SELECT event_type, metadata FROM audit_events WHERE entity_id = $1 ORDER BY occurred_at, event_type", [adminId]);
      expect((audit.rows as { event_type: string }[]).map((row) => row.event_type).sort()).toEqual(["PasswordResetLinkIssued", "ProductionBootstrap"]);
      expect(JSON.stringify(audit.rows)).not.toContain(token);

      const store = await database.createStore();
      await expect(loginUser(store, ADMIN.email, "")).rejects.toMatchObject({ status: 401 });
      await expect(completePasswordReset(store, token, "Cavalo-azul-Lua-48-xk", "corr-pg-bootstrap")).resolves.toEqual({ email: ADMIN.email });
      await expect(completePasswordReset(store, token, "Outra-senha-Lua-77-q", "corr-pg-bootstrap")).rejects.toMatchObject({ code: "PASSWORD_RESET_INVALID" });
      const login = await loginUser(store, ADMIN.email, "Cavalo-azul-Lua-48-xk");
      expect(login.user.mustChangePassword).toBe(false);
      const completed = await database.query("SELECT event_type FROM audit_events WHERE event_type IN ('PasswordResetCompleted', 'PasswordResetRejected') ORDER BY occurred_at");
      expect((completed.rows as { event_type: string }[]).map((row) => row.event_type)).toEqual(["PasswordResetCompleted", "PasswordResetRejected"]);
    });
  });

  it("refuses to run twice without altering the existing state", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const { adminId } = await bootstrapProductionDatabase(database.connectionString(), ADMIN);

      await expect(
        bootstrapProductionDatabase(database.connectionString(), { ...ADMIN, email: "intruder@hospital.example.org" })
      ).rejects.toThrow(/BOOTSTRAP_ALREADY_INITIALIZED/);

      const users = await database.query("SELECT entity_key FROM cvg_runtime_entities WHERE collection = 'users' ORDER BY position");
      expect(users.rows).toEqual([{ entity_key: adminId }]);
      const audit = await database.query("SELECT count(*)::int AS total FROM audit_events WHERE event_type = 'ProductionBootstrap'");
      expect(audit.rows).toEqual([{ total: 1 }]);
    });
  });

  it("rolls back the first runtime state when the bootstrap audit INSERT fails, then permits recovery", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      expect(await database.query("SELECT id FROM cvg_runtime_state")).toEqual({ rows: [], rowCount: 0 });
      await database.query(`CREATE FUNCTION reject_bootstrap_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'BOOTSTRAP_AUDIT_TEST_FAILURE'; END; $$`);
      await database.query("CREATE TRIGGER reject_bootstrap_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_bootstrap_audit()");
      await expect(bootstrapProductionDatabase(database.connectionString(), ADMIN)).rejects.toThrow("BOOTSTRAP_AUDIT_TEST_FAILURE");
      expect(await database.query("SELECT id FROM cvg_runtime_state")).toEqual({ rows: [], rowCount: 0 });
      expect(await database.query("SELECT id FROM audit_events")).toEqual({ rows: [], rowCount: 0 });
      await expect(database.createStore()).rejects.toThrow("runtime state row is missing");
      await database.query("DROP TRIGGER reject_bootstrap_audit ON audit_events");
      const { adminId } = await bootstrapProductionDatabase(database.connectionString(), ADMIN);
      const store = await database.createStore();
      expect(store.getState().auditEvents).toEqual([]);
      expect(store.getState().users.map((user) => user.id)).toEqual([adminId]);
      const history = await store.readAuditEvents({ scope: { entities: [{ entityType: "User", entityId: adminId }] }, order: "asc", limit: 1000 });
      expect(history.items).toEqual([expect.objectContaining({ eventType: "ProductionBootstrap", entityId: adminId })]);
      await expect(store.healthcheck()).resolves.toBeUndefined();
    });
  });
});
