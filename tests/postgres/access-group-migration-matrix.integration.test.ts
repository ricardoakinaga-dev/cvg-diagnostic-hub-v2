import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { ROLES, type RoleCode } from "@cvg/contracts";
import type { StoreState, User } from "../../src/server/domain/models";
import { createApplicationService } from "../../src/server/application/service";
import { serviceAccessPolicyFor } from "../../src/server/application/executor-service-access";
import { canAccessResource, rolePermissions } from "../../src/server/security/authorization";
import { hydrateUserPermissions, resolveUserPermissions, systemGroupId } from "../../src/server/security/access-group-policy";
import { createDemoState } from "../../src/server/store/fixtures";
import { MemoryStore } from "../../src/server/store/memory-store";
import { applyMigrations, RUNTIME_MIGRATION_VERSIONS } from "../../src/server/store/migrations";
import { PostgresStore } from "../../src/server/store/postgres-store";
import { withDisposablePostgresDatabase } from "../support/postgres-test-harness";

const DIRECTORY = path.resolve(process.cwd(), "db/migrations");
const variants = ["SELECTED", "EMPTY", "INACTIVE"] as const;
type Variant = typeof variants[number];
const userId = (role: RoleCode, variant: Variant) => `matrix-${role.toLowerCase()}-${variant.toLowerCase()}`;
const executorCodes: Partial<Record<RoleCode, string>> = { LAB_TECH: "HEMOGRAM", RADIOLOGY_TEAM: "XRAY_THORAX", ULTRASOUND_TEAM: "ULTRASOUND_ABDOMEN" };
const departments: Partial<Record<RoleCode, string>> = { ADMIN: "IT", MANAGER: "IT", LAB_TECH: "LABORATORY", RADIOLOGY_TEAM: "RADIOLOGY", ULTRASOUND_TEAM: "ULTRASOUND" };
const patientRoles: readonly RoleCode[] = ["VETERINARIAN", "INPATIENT_TEAM", "VIEWER"];
const oldCollections = new Set(["users", "sessions", "patients", "encounters", "admissions", "services", "reasonCodes", "requests", "items", "samples", "procedures", "schedules", "results", "resultVersions", "notifications", "idempotency", "attachments", "auditEvents", "outbox"]);

async function legacyFixture(): Promise<StoreState> {
  const base = createDemoState("matrix-migration-synthetic-password");
  const prototype = base.users.find((user) => user.role === "ADMIN")!;
  base.users = ROLES.flatMap((role) => variants.map((variant): User => ({
    ...prototype, id: userId(role, variant), email: `${userId(role, variant)}@example.test`,
    displayName: `${role} ${variant}`, role, accessGroupId: undefined, permissions: undefined,
    departmentCode: departments[role] ?? "INPATIENT", active: variant !== "INACTIVE",
    patientIds: patientRoles.includes(role) && variant !== "EMPTY" ? ["patient-thor"] : [],
    serviceCodes: executorCodes[role] && variant !== "EMPTY" ? [executorCodes[role]!] : [],
    managedDepartmentCodes: role === "MANAGER" ? variant === "EMPTY" ? [] : ["LABORATORY"] : undefined,
    serviceAccessPolicy: undefined
  })));
  base.admissions = [];
  const store = new MemoryStore(base);
  const service = createApplicationService(store);
  const superadmin = base.users.find((user) => user.id === userId("SUPERADMIN", "SELECTED"))!;
  const veterinarian = base.users.find((user) => user.id === userId("VETERINARIAN", "SELECTED"))!;
  await service.createRequest(veterinarian, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-hemogram" }, { serviceId: "service-xray" }, { serviceId: "service-ultrasound" }] }, { idempotencyKey: "matrix-request-thor" });
  await service.createRequest(superadmin, { patientId: "patient-mel", encounterId: "encounter-mel", priority: "ROUTINE", items: [{ serviceId: "service-crp" }] }, { idempotencyKey: "matrix-request-mel" });
  // Clinical rows are synthetic test fixtures. This test measures migration,
  // not the provenance of the in-memory fixture's discarded delivery ledger.
  return { ...store.getState(), auditEvents: [], outbox: [], idempotency: [] };
}

describe("BLD-HPL-018 nine-profile PostgreSQL migration matrix", () => {
  it("preserves all 27 role/activity/scope variants and enforces them after migration, reopening and a new exam", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "cvg-profile-matrix-"));
      const pool = new Pool({ connectionString: database.connectionString(), max: 1 });
      const client = await pool.connect();
      const schema = `profile_matrix_${randomUUID().replaceAll("-", "")}`;
      const stores: PostgresStore[] = [];
      try {
        await client.query(`CREATE SCHEMA "${schema}"`);
        await client.query(`SET search_path TO "${schema}", public`);
        await Promise.all(RUNTIME_MIGRATION_VERSIONS.filter((version) => version < "019").map((version) => copyFile(path.join(DIRECTORY, `${version}.sql`), path.join(directory, `${version}.sql`))));
        await applyMigrations(client, { migrationDirectory: directory, cutoverAcknowledged: true, logger: { info: () => undefined } });
        const before = await legacyFixture();
        const legacy = Object.fromEntries(Object.entries(before).filter(([key, value]) => !Array.isArray(value) || oldCollections.has(key)));
        await client.query("INSERT INTO cvg_runtime_state(id,state,version) VALUES (1,cvg_runtime_state_header($1::jsonb),5)", [JSON.stringify(legacy)]);
        await client.query("INSERT INTO cvg_runtime_entities(collection,entity_key,position,data,written_version) SELECT collection,entity_key,entity_position,data,written_version FROM cvg_runtime_entity_rows($1::jsonb,5)", [JSON.stringify(legacy)]);
        await Promise.all(RUNTIME_MIGRATION_VERSIONS.filter((version) => version >= "019").map((version) => copyFile(path.join(DIRECTORY, `${version}.sql`), path.join(directory, `${version}.sql`))));
        const expectedVersions = RUNTIME_MIGRATION_VERSIONS.filter((version) => version >= "019");
        expect((await applyMigrations(client, { migrationDirectory: directory, cutoverAcknowledged: true, logger: { info: () => undefined } })).applied).toEqual(expectedVersions);

        // The URL refers exclusively to the generated disposable database and
        // generated schema. Production/environment connection data is not used.
        const connection = new URL(database.connectionString());
        connection.searchParams.set("options", `-c search_path=${schema},public`);
        const first = await PostgresStore.create(connection.toString()); stores.push(first);
        const current = await first.readState();
        expect(current.users).toHaveLength(27);
        expect(current.accessGroups).toHaveLength(9);
        for (const role of ROLES) {
          const group = current.accessGroups.find((entry) => entry.id === systemGroupId(role))!;
          expect([...group.permissions].sort()).toEqual([...rolePermissions[role]].sort());
        }
        for (const original of before.users) {
          const migrated = current.users.find((user) => user.id === original.id)!;
          expect(migrated).toMatchObject({ role: original.role, active: original.active, departmentCode: original.departmentCode, patientIds: original.patientIds, serviceCodes: original.serviceCodes, accessGroupId: systemGroupId(original.role) });
          expect(migrated.managedDepartmentCodes).toEqual(original.managedDepartmentCodes);
          expect(serviceAccessPolicyFor(migrated)).toEqual(serviceAccessPolicyFor(original));
          expect(resolveUserPermissions(current, migrated)).toEqual(original.active ? [...rolePermissions[original.role]] : []);
          // Existing clinical/administrative operations retain both the old
          // profile ceiling and old scope. New roadmap actions are intentional.
          for (const permission of ["request.list", "item.view", "result.release", "result.review", "user_role.manage"] as const) {
            for (const resource of [
              { patientId: "patient-thor", departmentCode: "LABORATORY", serviceCode: "HEMOGRAM" },
              { patientId: "patient-mel", departmentCode: "LABORATORY", serviceCode: "CRP" },
              { patientId: "patient-thor", departmentCode: "RADIOLOGY", serviceCode: "XRAY_THORAX" }
            ]) expect(canAccessResource(hydrateUserPermissions(current, migrated), permission, resource)).toBe(canAccessResource(original, permission, resource));
          }
        }
        expect(current.patientGrants.map((grant) => [grant.userId, grant.patientId]).sort()).toEqual(before.users.flatMap((user) => (user.patientIds ?? []).map((patientId) => [user.id, patientId])).sort());
        expect(current.patientGrants.every((grant) => grant.active && grant.source === "LEGACY")).toBe(true);
        expect(current.requests).toEqual(before.requests);
        expect(current.items).toEqual(before.items);
        expect((await applyMigrations(client, { migrationDirectory: directory, cutoverAcknowledged: true, logger: { info: () => undefined } })).applied).toEqual([]);

        const second = await PostgresStore.create(connection.toString()); stores.push(second);
        const service = createApplicationService(second);
        const reopened = await second.readState();
        const thor = reopened.requests.find((request) => request.patientId === "patient-thor")!;
        const mel = reopened.requests.find((request) => request.patientId === "patient-mel")!;
        for (const role of ROLES) for (const variant of variants) {
          const actor = reopened.users.find((user) => user.id === userId(role, variant))!;
          if (variant === "INACTIVE") {
            await expect(service.listRequests(actor)).rejects.toMatchObject({ status: 401 });
            await expect(service.getRequest(actor, thor.id)).rejects.toMatchObject({ status: 401 });
          } else if (role === "ADMIN") {
            await expect(service.listRequests(actor)).rejects.toMatchObject({ status: 404 });
            await expect(service.getItem(actor, thor.itemIds[0])).rejects.toMatchObject({ status: 404 });
          } else if (role !== "SUPERADMIN" && variant === "EMPTY") {
            expect((await service.listRequests(actor)).items).toEqual([]);
            await expect(service.getRequest(actor, thor.id)).rejects.toMatchObject({ status: 404 });
          } else {
            const visible = await service.listRequests(actor);
            const globalOrManager = role === "SUPERADMIN" || role === "MANAGER";
            expect(visible.items.map((request) => request.id).sort()).toEqual((globalOrManager ? [thor.id, mel.id] : [thor.id]).sort());
            const detail = await service.getRequest(actor, thor.id);
            const expectedItems = role === "SUPERADMIN" || patientRoles.includes(role) ? 3 : 1;
            expect(detail.items).toHaveLength(expectedItems);
            if (!globalOrManager) await expect(service.getRequest(actor, mel.id)).rejects.toMatchObject({ status: 404 });
          }
        }
        const lab = reopened.users.find((user) => user.id === userId("LAB_TECH", "SELECTED"))!;
        const none = reopened.users.find((user) => user.id === userId("LAB_TECH", "EMPTY"))!;
        expect((await service.listQueuePage(lab, "LABORATORY")).items).toHaveLength(1);
        expect((await service.listQueuePage(none, "LABORATORY")).items).toEqual([]);
        await expect(service.listQueuePage(lab, "RADIOLOGY")).rejects.toMatchObject({ status: 404 });
        const admin = reopened.users.find((user) => user.id === userId("ADMIN", "SELECTED"))!;
        await service.createDiagnosticService(admin, { code: "MATRIX_FUTURE", name: "Novo exame sintético", category: "LABORATORY", departmentCode: "LABORATORY", workflowType: "LABORATORY", requiresSample: false, requiresSchedule: false, allowsAttachment: false, resultSchema: "NARRATIVE", slaHours: { ROUTINE: 24, URGENT: 4, EMERGENCY: 1 }, idempotencyKey: "matrix-new-exam" });
        const refreshed = await first.readState();
        for (const original of before.users) {
          const afterCatalog = refreshed.users.find((user) => user.id === original.id)!;
          expect(afterCatalog.serviceCodes).toEqual(original.serviceCodes);
          if (executorCodes[original.role]) {
            expect(serviceAccessPolicyFor(afterCatalog)?.includeFuture).toBe(false);
            expect(canAccessResource(hydrateUserPermissions(refreshed, afterCatalog), "item.view", { patientId: "patient-thor", departmentCode: afterCatalog.departmentCode, serviceCode: "MATRIX_FUTURE" })).toBe(false);
          }
        }
      } finally {
        await Promise.all(stores.map((store) => store.close()));
        client.release(); await pool.end();
        await rm(directory, { recursive: true, force: true });
      }
    });
  });
});
