import { copyFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { withDisposablePostgresDatabase } from "../support/postgres-test-harness";
import { applyMigrations, RUNTIME_MIGRATION_VERSIONS } from "../../src/server/store/migrations";
import { createDemoState } from "../../src/server/store/fixtures";
import { createApplicationService } from "../../src/server/application/service";
import { rolePermissions } from "../../src/server/security/authorization";

const migrationDirectory = path.resolve(process.cwd(), "db/migrations");

describe("hospital foundation on isolated PostgreSQL", () => {
  it.each([false, true])("upgrades legacy scope and preserves reduced matrices: reduced=%s", async (reduced) => {
    await withDisposablePostgresDatabase(async (database) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "cvg-hpl-upgrade-"));
      const pool = new Pool({ connectionString: database.connectionString(), max: 1 });
      const client = await pool.connect();
      const schema = `hpl_upgrade_${randomUUID().replaceAll("-", "")}`;
      try {
        await client.query(`CREATE SCHEMA "${schema}"`);
        await client.query(`SET search_path TO "${schema}", public`);
        await Promise.all(RUNTIME_MIGRATION_VERSIONS.filter((version) => version < "019").map((version) => copyFile(path.join(migrationDirectory, `${version}.sql`), path.join(directory, `${version}.sql`))));
        await applyMigrations(client, { migrationDirectory: directory, cutoverAcknowledged: true });
        const base = createDemoState("hospital-pg-upgrade-tests");
        const vet = base.users.find((user) => user.role === "VETERINARIAN")!;
        const lab = base.users.find((user) => user.role === "LAB_TECH")!;
        const session = (userId: string, suffix: string) => ({ id: `migration-session-${suffix}`, userId, tokenHash: `test-token-${suffix}`, csrfTokenHash: `test-csrf-${suffix}`, createdAt: "2026-10-11T00:00:00.000Z", expiresAt: "2026-10-12T00:00:00.000Z", version: 1 });
        base.sessions = [session(vet.id, "vet"), session(lab.id, "lab")];
        const legacy = Object.fromEntries(Object.entries(base).filter(([key]) => !["departments", "accessGroups", "patientGrants", "examDefinitions", "hospitalServices", "hospitalTaskTypes", "hospitalTasks", "hospitalTaskDependencies", "hospitalIntakes", "savedPlannerViews", "hospitalResources", "hospitalPlans", "hospitalShifts", "hospitalHandoffs", "hospitalChecklistTemplates", "hospitalRecurrences", "hospitalDocuments", "hospitalTaskComments", "hospitalTaskAttachments", "workNotifications", "workNotificationPreferences", "workActivityPreferences", "hospitalReports", "hospitalReportJobs", "hospitalInstitutionSettings", "hospitalUserInvitations", "hospitalIntegrationCredentials", "hospitalIntegrationMessages", "hospitalAiSuggestions", "hospitalHisV4Deliveries"].includes(key)));
        legacy.users = base.users.map(({ accessGroupId: _group, permissions: _permissions, ...user }) => user);
        await client.query("INSERT INTO cvg_runtime_state(id,state,version) VALUES (1,cvg_runtime_state_header($1::jsonb),5)", [JSON.stringify(legacy)]);
        await client.query("INSERT INTO cvg_runtime_entities(collection,entity_key,position,data,written_version) SELECT collection,entity_key,entity_position,data,written_version FROM cvg_runtime_entity_rows($1::jsonb,5)", [JSON.stringify(legacy)]);
        await Promise.all(RUNTIME_MIGRATION_VERSIONS.filter((version) => version >= "019" && version < "021").map((version) => copyFile(path.join(migrationDirectory, `${version}.sql`), path.join(directory, `${version}.sql`))));
        expect((await applyMigrations(client, { migrationDirectory: directory, cutoverAcknowledged: true })).applied).toEqual(["019_hospital_departments", "020_hospital_access_groups"]);
        if (reduced) await client.query("UPDATE cvg_runtime_entities SET data=jsonb_set(data,'{permissions}',$1::jsonb) WHERE collection='accessGroups' AND data->>'systemRole'='VETERINARIAN'", [JSON.stringify(["department.view"])]);
        await Promise.all(RUNTIME_MIGRATION_VERSIONS.filter((version) => version >= "021").map((version) => copyFile(path.join(migrationDirectory, `${version}.sql`), path.join(directory, `${version}.sql`))));
        expect((await applyMigrations(client, { migrationDirectory: directory, cutoverAcknowledged: true })).applied).toEqual(["021_exam_definitions", "022_hospital_services", "023_hospital_tasks", "024_hospital_planning_resources", "025_hospital_collaboration", "026_hospital_external_capabilities", "027_hospital_his_v4_deliveries"]);
        const rows = (await client.query("SELECT collection,data FROM cvg_runtime_entities ORDER BY collection,position")).rows;
        const users = rows.filter((row) => row.collection === "users").map((row) => row.data);
        for (const before of base.users) {
          const after = users.find((user) => user.id === before.id);
          expect(after).toMatchObject({ role: before.role, departmentCode: before.departmentCode, patientIds: before.patientIds, serviceCodes: before.serviceCodes, active: before.active, accessGroupId: `access-group-${before.role.toLowerCase()}` });
          expect(after.managedDepartmentCodes).toEqual(before.managedDepartmentCodes);
        }
        const departments = rows.filter((row) => row.collection === "departments").map((row) => row.data);
        expect(departments.map((department) => department.code).sort()).toEqual(["INPATIENT", "IT", "LABORATORY", "RADIOLOGY", "ULTRASOUND"]);
        expect(departments.every((department) => !department.responsibleUserId)).toBe(true);
        const groups = rows.filter((row) => row.collection === "accessGroups").map((row) => row.data);
        expect(groups).toHaveLength(9);
        for (const group of groups) {
          const expected = reduced && group.systemRole === "VETERINARIAN" ? ["department.view"] : rolePermissions[group.systemRole as keyof typeof rolePermissions];
          expect([...group.permissions].sort()).toEqual([...expected].sort());
        }
        const sessions = rows.filter((row) => row.collection === "sessions").map((row) => row.data);
        expect(Boolean(sessions.find((entry) => entry.userId === vet.id)?.revokedAt)).toBe(!reduced);
        expect(sessions.find((entry) => entry.userId === lab.id)?.revokedAt).toBeDefined();
        expect(rows.filter((row) => row.collection === "examDefinitions")).toHaveLength(0);
        const grants = rows.filter((row) => row.collection === "patientGrants").map((row) => row.data);
        expect(grants.map((grant) => [grant.userId, grant.patientId]).sort()).toEqual(base.users.flatMap((user) => (user.patientIds ?? []).map((patientId) => [user.id, patientId])).sort());
        expect(grants.every((grant) => grant.source === "LEGACY" && grant.active)).toBe(true);
        expect((await client.query("SELECT state->'departments' AS departments,state->'accessGroups' AS groups,state->'patientGrants' AS grants FROM cvg_runtime_state")).rows).toEqual([{ departments: [], groups: [], grants: [] }]);
        for (const collection of ["hospitalResources", "hospitalPlans", "hospitalShifts", "hospitalHandoffs", "hospitalChecklistTemplates", "hospitalRecurrences", "hospitalDocuments", "hospitalTaskComments", "hospitalTaskAttachments", "workNotifications", "workNotificationPreferences", "workActivityPreferences", "hospitalReports", "hospitalReportJobs", "hospitalInstitutionSettings", "hospitalUserInvitations", "hospitalIntegrationCredentials", "hospitalIntegrationMessages", "hospitalAiSuggestions", "hospitalHisV4Deliveries"]) {
          expect(rows.filter((row) => row.collection === collection)).toEqual([]);
          expect((await client.query("SELECT state->$1 AS value FROM cvg_runtime_state", [collection])).rows).toEqual([{ value: [] }]);
        }
        expect((await client.query("SELECT event_type FROM audit_events ORDER BY event_type")).rows).toEqual([{ event_type: "ExamDefinitionsEnabled" }, { event_type: "HospitalAccessGroupsMigrated" }, { event_type: "HospitalCollaborationEnabled" }, { event_type: "HospitalDepartmentsMigrated" }, { event_type: "HospitalExternalCapabilitiesEnabled" }, { event_type: "HospitalHisV4ReceiptsEnabled" }, { event_type: "HospitalPlannerTasksEnabled" }, { event_type: "HospitalPlanningResourcesEnabled" }, { event_type: "HospitalServicesEnabled" }]);
        expect(await applyMigrations(client, { migrationDirectory: directory, cutoverAcknowledged: true })).toMatchObject({ applied: [] });
      } finally {
        client.release();
        await pool.end();
        await rm(directory, { recursive: true, force: true });
      }
    });
  });

  it("serializes sector updates between independent stores and persists a stable code", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const base = createDemoState("hospital-pg-concurrency-tests");
      const first = await database.createStore(base);
      const second = await database.createStore();
      try {
        const a = createApplicationService(first);
        const b = createApplicationService(second);
        const admin = base.users.find((user) => user.role === "ADMIN")!;
        const department = await a.createDepartment(admin, { code: "SURGERY", name: "Centro cirúrgico", type: "CLINICAL", idempotencyKey: "pg-sector-create" });
        const attempts = await Promise.allSettled([
          a.updateDepartment(admin, department.id, { name: "Centro A", expectedVersion: 1, idempotencyKey: "pg-sector-a" }),
          b.updateDepartment(admin, department.id, { name: "Centro B", expectedVersion: 1, idempotencyKey: "pg-sector-b" })
        ]);
        expect(attempts.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
        expect(attempts.find((entry) => entry.status === "rejected")).toMatchObject({ reason: { code: "STALE_VERSION" } });
        expect(await b.getDepartment(admin, department.id)).toMatchObject({ code: "SURGERY", version: 2 });
        const persisted = await database.query("SELECT data->>'code' AS code FROM cvg_runtime_entities WHERE collection='departments' AND entity_key=$1", [department.id]);
        expect(persisted.rows).toEqual([{ code: "SURGERY" }]);
      } finally {
        await database.closeStore(first);
        await database.closeStore(second);
      }
    });
  });
});
