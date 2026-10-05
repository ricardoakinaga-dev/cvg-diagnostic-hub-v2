import { describe, expect, it } from "vitest";
import { loginUser } from "../../src/server/security/session";
import { bootstrapProductionDatabase } from "../../src/server/store/production-bootstrap";
import { withDisposablePostgresDatabase } from "../support/postgres-test-harness";

const ADMIN = { email: "root@hospital.example.org", displayName: "Administração", password: "root-of-trust-2026-unique" };

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

  it("refuses to run twice without altering the existing state", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const { adminId } = await bootstrapProductionDatabase(database.connectionString(), ADMIN);

      await expect(
        bootstrapProductionDatabase(database.connectionString(), { ...ADMIN, email: "intruder@hospital.example.org" })
      ).rejects.toThrow(/BOOTSTRAP_ALREADY_INITIALIZED/);

      const state = await database.query("SELECT state->'users' AS users FROM cvg_runtime_state WHERE id = 1");
      expect((state.rows[0] as { users: Array<{ id: string }> }).users.map((user) => user.id)).toEqual([adminId]);
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
