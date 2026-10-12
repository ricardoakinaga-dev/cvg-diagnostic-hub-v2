import { describe, expect, it } from "vitest";
import type { RoleCode, ServiceAccessPolicy } from "@cvg/contracts";
import type { StoreState, User } from "../../src/server/domain/models";
import type { PostgresStore } from "../../src/server/store/postgres-store";
import { createApplicationService } from "../../src/server/application/service";
import { createDemoState } from "../../src/server/store/fixtures";
import { systemGroupId } from "../../src/server/security/access-group-policy";
import { authenticateRequest, changeInitialPassword, getSessionCookieName, loginUser, reauthenticateUser } from "../../src/server/security/session";
import { withDisposablePostgresDatabase, type DisposablePostgresDatabase } from "../support/postgres-test-harness";

const PASSWORD = "synthetic-effective-authority-password-2026";
const PERSONAL_PASSWORD = "Opala-Castor-62!Vega";
const NONE: ServiceAccessPolicy = { mode: "NONE", includeFuture: false };
const CURRENT: ServiceAccessPolicy = { mode: "ALL_CURRENT", includeFuture: false };
const FUTURE: ServiceAccessPolicy = { mode: "ALL_CURRENT", includeFuture: true };
const SELECTED: ServiceAccessPolicy = { mode: "SELECTED", includeFuture: false };
const EXECUTORS = [
  { role: "LAB_TECH", departmentCode: "LABORATORY", legacyId: "user-lab", workflowType: "LABORATORY", category: "LABORATORY" },
  { role: "RADIOLOGY_TEAM", departmentCode: "RADIOLOGY", legacyId: "user-rx", workflowType: "RADIOLOGY", category: "IMAGING" },
  { role: "ULTRASOUND_TEAM", departmentCode: "ULTRASOUND", legacyId: "user-us", workflowType: "ULTRASOUND", category: "IMAGING" }
] as const;
const OPERATIONS = ["create", "import", "reactivate", "transfer"] as const;
const CATALOG_CASES = EXECUTORS.flatMap((executor) => OPERATIONS.map((operation) => ({ ...executor, operation })));
const CSV_HEADER = "codigo;nome;categoria;setor;fluxo;exige_amostra;tipo_amostra;exige_agenda;permite_anexo;esquema_resultado;sla_rotina_h;sla_urgente_h;sla_emergencia_h;ativo";

function sessionRequest(login: { sessionToken: string; csrfToken: string }): Request {
  return new Request("http://localhost/api/v1/session/me", { headers: {
    cookie: `${getSessionCookieName()}=${login.sessionToken}; cvg_csrf=${login.csrfToken}`,
    "x-csrf-token": login.csrfToken
  } });
}

async function signIn(store: PostgresStore, email: string, password = PASSWORD) {
  const request = sessionRequest(await loginUser(store, email, password));
  const actor = await authenticateRequest(store, request);
  return { request, actor };
}

async function provisionExecutor(
  database: DisposablePostgresDatabase,
  writer: PostgresStore,
  observer: PostgresStore,
  admin: User,
  executor: (typeof EXECUTORS)[number],
  label: string,
  policy: ServiceAccessPolicy,
  codes?: string[]
) {
  const created = await createApplicationService(writer).createManagedUser(admin, {
    displayName: `Executor sintético ${label}`, email: `${label}@example.invalid`,
    role: executor.role, departmentCode: executor.departmentCode,
    serviceAccessPolicy: policy, serviceCodes: codes, idempotencyKey: `provision-${label}`
  });
  expect(created.initialPassword).toEqual(expect.any(String));
  const initial = await loginUser(observer, created.email, created.initialPassword!);
  const rotated = await changeInitialPassword(writer, sessionRequest(initial), PERSONAL_PASSWORD, `password-${label}`);
  const request = sessionRequest(rotated);
  const actor = await authenticateRequest(observer, request);
  expect(actor).toMatchObject({ id: created.id, role: executor.role, serviceAccessPolicy: policy, mustChangePassword: false });
  expect(await entityRows(database, "users", [created.id])).toEqual([{ data: (await observer.readState()).users.find((user) => user.id === created.id) }]);
  return { id: created.id, email: created.email, request, actor };
}

async function entityRows(database: DisposablePostgresDatabase, collection: string, ids: readonly string[]) {
  return (await database.query(
    "SELECT data FROM cvg_runtime_entities WHERE collection = $1 AND entity_key = ANY($2::text[]) ORDER BY entity_key",
    [collection, [...ids]]
  )).rows;
}

async function durableSql(database: DisposablePostgresDatabase) {
  return {
    header: (await database.query("SELECT state, version::text, updated_at FROM cvg_runtime_state WHERE id = 1")).rows,
    entities: (await database.query("SELECT collection, entity_key, position::text, data, written_version::text FROM cvg_runtime_entities ORDER BY collection, entity_key")).rows,
    audit: (await database.query("SELECT * FROM audit_events ORDER BY id")).rows,
    outbox: (await database.query("SELECT * FROM outbox_messages ORDER BY id")).rows,
    removals: (await database.query("SELECT collection, entity_key, removed_version::text FROM cvg_runtime_entity_removals ORDER BY collection, entity_key, removed_version")).rows
  };
}

async function assertNoDurableMutation(database: DisposablePostgresDatabase, writer: PostgresStore, observer: PostgresStore, before: Awaited<ReturnType<PostgresStore["readStateSnapshot"]>>, sql: Awaited<ReturnType<typeof durableSql>>) {
  expect(await writer.readStateSnapshot()).toEqual(before);
  expect(await observer.readStateSnapshot()).toEqual(before);
  expect(await durableSql(database)).toEqual(sql);
}

function examFor(executor: (typeof EXECUTORS)[number], code: string) {
  return {
    code, name: "Exame sintético de política explícita", category: executor.category,
    departmentCode: executor.departmentCode, workflowType: executor.workflowType,
    requiresSample: false, requiresSchedule: false, allowsAttachment: false,
    resultSchema: "NARRATIVE" as const, slaHours: { ROUTINE: 24, URGENT: 4, EMERGENCY: 1 }
  };
}

function userAccess(state: StoreState) {
  return state.users.map((user) => ({ id: user.id, serviceCodes: user.serviceCodes, serviceAccessPolicy: user.serviceAccessPolicy, version: user.version, active: user.active }));
}

describe("BLD-HPL-003/005 durable effective authority on disposable PostgreSQL", () => {
  it.each(CATALOG_CASES)("$role: $operation grants a newly available examination only to explicit FUTURE and survives replay/reopen", async (executor) => {
    await withDisposablePostgresDatabase(async (database) => {
      const writer = await database.createStore(createDemoState(PASSWORD));
      const observer = await database.createStore();
      const service = createApplicationService(writer);
      const read = createApplicationService(observer);
      const admin = await signIn(writer, "admin@cvg.local");
      const exam = examFor(executor, `POLICY_${executor.workflowType}_${executor.operation.toUpperCase()}`);
      let prepared: Awaited<ReturnType<typeof service.createDiagnosticService>> | undefined;
      if (executor.operation === "reactivate" || executor.operation === "transfer") {
        prepared = await service.createDiagnosticService(admin.actor, {
          ...exam, departmentCode: executor.operation === "transfer" ? (executor.departmentCode === "LABORATORY" ? "RADIOLOGY" : "LABORATORY") : executor.departmentCode,
          idempotencyKey: "prepare-catalog-entry"
        });
        if (executor.operation === "reactivate") prepared = await service.updateDiagnosticService(admin.actor, prepared.id, { active: false, expectedVersion: prepared.version, idempotencyKey: "prepare-inactive-entry" });
      }
      const current = await provisionExecutor(database, writer, observer, admin.actor, executor, "current", CURRENT);
      const selected = await provisionExecutor(database, writer, observer, admin.actor, executor, "selected", SELECTED, [...current.actor.serviceCodes!]);
      const none = await provisionExecutor(database, writer, observer, admin.actor, executor, "none", NONE);
      const future = await provisionExecutor(database, writer, observer, admin.actor, executor, "future", FUTURE);
      const legacyUser = (await observer.readState()).users.find((user) => user.id === executor.legacyId)!;
      const legacy = await signIn(observer, legacyUser.email);
      const before = await observer.readStateSnapshot();
      const correlationId = "explicit-future-policy";
      const apply = () => executor.operation === "create"
        ? service.createDiagnosticService(admin.actor, { ...exam, idempotencyKey: "apply-catalog-entry", correlationId })
        : executor.operation === "import"
          ? service.importCatalog(admin.actor, { services: `${CSV_HEADER}\n${exam.code};${exam.name};${exam.category};${exam.departmentCode};${exam.workflowType};não;;não;não;NARRATIVE;24;4;1;sim`, idempotencyKey: "apply-catalog-entry", correlationId })
          : service.updateDiagnosticService(admin.actor, prepared!.id, { ...(executor.operation === "reactivate" ? { active: true } : { departmentCode: executor.departmentCode }), expectedVersion: prepared!.version, idempotencyKey: "apply-catalog-entry", correlationId });
      await apply();
      const after = await observer.readStateSnapshot();
      expect(await writer.readStateSnapshot()).toEqual(after);
      expect(userAccess(after.state)).toEqual(userAccess(before.state).map((user) => user.id === future.id ? { ...user, serviceCodes: [...user.serviceCodes!, exam.code], version: user.version + 1 } : user));
      expect(after.state.sessions.find((session) => session.id === future.actor.sessionId)).toMatchObject({ revokedAt: expect.any(String), version: 2 });
      for (const control of [current, selected, none, legacy]) {
        expect(after.state.sessions.find((session) => session.id === control.actor.sessionId)).toEqual(before.state.sessions.find((session) => session.id === control.actor.sessionId));
        expect((await authenticateRequest(observer, control.request)).id).toBe(control.actor.id);
      }
      await expect(authenticateRequest(writer, future.request)).rejects.toMatchObject({ status: 401 });
      await expect(read.listRequests(future.actor)).rejects.toMatchObject({ status: 401 });
      const accessAudit = await database.query("SELECT actor_id, entity_id, correlation_id, metadata FROM audit_events WHERE event_type = 'UserServiceAccessUpdated' AND correlation_id = $1 ORDER BY id", [correlationId]);
      expect(accessAudit.rows).toEqual([{ actor_id: admin.actor.id, entity_id: future.id, correlation_id: correlationId, metadata: expect.objectContaining({ addedServiceCodes: exam.code, removedServiceCodes: "", includeFuture: true, reason: "EXPLICIT_FUTURE_POLICY" }) }]);
      const controls = [current.id, selected.id, none.id, future.id, legacy.actor.id].sort();
      expect(await entityRows(database, "users", controls)).toEqual(controls.map((id) => ({ data: after.state.users.find((user) => user.id === id) })));
      const afterSql = await durableSql(database);
      await apply();
      await assertNoDurableMutation(database, writer, observer, after, afterSql);
      const managed = await read.listManagedUsers(admin.actor);
      expect(managed.find((user) => user.id === legacy.actor.id)?.serviceAccessPolicy).toEqual(SELECTED);
      expect(managed.find((user) => user.id === none.id)?.serviceCodes).toEqual([]);
      const vet = await signIn(writer, "vet@cvg.local");
      const savedExam = after.state.services.find((entry) => entry.code === exam.code)!;
      const request = await service.createRequest(vet.actor, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: savedExam.id }] }, { idempotencyKey: "request-new-exam" });
      const itemId = request.items[0].id;
      const renewedFuture = await signIn(observer, future.email, PERSONAL_PASSWORD);
      expect((await read.getItem(renewedFuture.actor, itemId)).item).toMatchObject({ id: itemId, serviceId: savedExam.id, departmentCode: executor.departmentCode });
      expect((await read.listQueue(renewedFuture.actor, executor.departmentCode)).map((item) => item.id)).toContain(itemId);
      for (const control of [current, selected, none, legacy]) {
        await expect(read.getItem(await authenticateRequest(observer, control.request), itemId)).rejects.toMatchObject({ status: 404 });
        expect((await read.listQueue(await authenticateRequest(observer, control.request), executor.departmentCode)).map((item) => item.id)).not.toContain(itemId);
      }
      const committed = await observer.readStateSnapshot();
      const committedSql = await durableSql(database);
      await database.closeStore(writer); await database.closeStore(observer);
      const reopened = await database.createStore();
      expect(await reopened.readStateSnapshot()).toEqual(committed);
      expect(await durableSql(database)).toEqual(committedSql);
      const reopenedRead = createApplicationService(reopened);
      expect((await reopenedRead.getItem(await authenticateRequest(reopened, renewedFuture.request), itemId)).item.id).toBe(itemId);
      for (const control of [current, selected, none, legacy]) await expect(reopenedRead.getItem(await authenticateRequest(reopened, control.request), itemId)).rejects.toMatchObject({ status: 404 });
      await expect(authenticateRequest(reopened, future.request)).rejects.toMatchObject({ status: 401 });
      expect((await database.query("SELECT count(*)::int AS count FROM audit_events WHERE event_type = 'UserServiceAccessUpdated' AND correlation_id = $1", [correlationId])).rows).toEqual([{ count: 1 }]);
    });
  });

  it.each(EXECUTORS)("$role: the first examination preserves NONE, empty SELECTED and empty CURRENT snapshots", async (executor) => {
    await withDisposablePostgresDatabase(async (database) => {
      const base = createDemoState(PASSWORD);
      base.services = base.services.filter((service) => service.departmentCode !== executor.departmentCode);
      base.users = base.users.map((user) => user.departmentCode === executor.departmentCode ? { ...user, serviceCodes: [] } : user);
      const writer = await database.createStore(base); const observer = await database.createStore();
      const service = createApplicationService(writer); const admin = await signIn(writer, "admin@cvg.local");
      const controls = [
        await provisionExecutor(database, writer, observer, admin.actor, executor, "empty-none", NONE),
        await provisionExecutor(database, writer, observer, admin.actor, executor, "empty-selected", SELECTED, []),
        await provisionExecutor(database, writer, observer, admin.actor, executor, "empty-current", CURRENT)
      ];
      const future = await provisionExecutor(database, writer, observer, admin.actor, executor, "empty-future", FUTURE);
      const before = await observer.readStateSnapshot();
      const exam = await service.createDiagnosticService(admin.actor, { ...examFor(executor, `FIRST_${executor.workflowType}`), idempotencyKey: "first-examination", correlationId: "first-examination" });
      const after = await observer.readStateSnapshot();
      expect(userAccess(after.state)).toEqual(userAccess(before.state).map((user) => user.id === future.id ? { ...user, serviceCodes: [exam.code], version: user.version + 1 } : user));
      for (const control of controls) {
        expect(after.state.users.find((user) => user.id === control.id)?.serviceCodes).toEqual([]);
        expect((await authenticateRequest(observer, control.request)).id).toBe(control.id);
      }
      await expect(authenticateRequest(observer, future.request)).rejects.toMatchObject({ status: 401 });
      const sql = await durableSql(database);
      await service.createDiagnosticService(admin.actor, { ...examFor(executor, `FIRST_${executor.workflowType}`), idempotencyKey: "first-examination", correlationId: "first-examination" });
      await assertNoDurableMutation(database, writer, observer, after, sql);
      expect((await database.query("SELECT count(*)::int AS count FROM audit_events WHERE event_type = 'UserServiceAccessUpdated' AND correlation_id = 'first-examination'")).rows).toEqual([{ count: 1 }]);
      await database.closeStore(writer); await database.closeStore(observer);
      expect(await (await database.createStore()).readStateSnapshot()).toEqual(after);
      expect(await durableSql(database)).toEqual(sql);
    });
  });

  it("rejects a stale bound-person scope and a changed candidate at a stable group revision without writes, then saves and replays one fresh decision", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const writer = await database.createStore(createDemoState(PASSWORD)); const observer = await database.createStore();
      const service = createApplicationService(writer); const independent = createApplicationService(observer);
      const admin = await signIn(writer, "admin@cvg.local"); const otherAdmin = await signIn(observer, "admin@cvg.local");
      const vetBefore = await signIn(writer, "vet@cvg.local");
      const request = await service.createRequest(vetBefore.actor, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-hemogram" }] }, { idempotencyKey: "impact-clinical-item" });
      const group = await service.createAccessGroup(admin.actor, { code: "DURABLE_IMPACT", description: "Grupo sintético compartilhado", permissions: ["request.list", "item.view"], idempotencyKey: "create-impact-group" });
      for (const userId of ["user-vet", "user-lab"]) {
        const user = (await observer.readState()).users.find((entry) => entry.id === userId)!;
        await service.assignUserAccessGroup(admin.actor, userId, { accessGroupId: group.id, expectedVersion: user.version, expectedGroupVersion: group.version, idempotencyKey: `bind-${userId}` });
      }
      const vet = await signIn(observer, "vet@cvg.local"); const lab = await signIn(observer, "lab@cvg.local");
      expect((await independent.listRequests(lab.actor)).items.map((entry) => entry.id)).toContain(request.id);
      const input = { permissions: ["result.release" as const], expectedVersion: group.version };
      const beforePreview = await observer.readStateSnapshot(); const beforePreviewSql = await durableSql(database);
      const preview = await service.previewAccessGroupImpact(admin.actor, group.id, input);
      expect(preview).toMatchObject({ groupVersion: 1, boundUserCount: 2, affectedUserCount: 2, activeAffectedUserCount: 2, requiresReauthentication: false });
      expect(JSON.stringify(preview)).not.toMatch(/patient-thor|patient-mel|passwordHash|synthetic-effective-authority-password/);
      await assertNoDurableMutation(database, writer, observer, beforePreview, beforePreviewSql);
      const boundVet = beforePreview.state.users.find((user) => user.id === vet.actor.id)!;
      await independent.changePatientGrant(otherAdmin.actor, vet.actor.id, { patientId: "patient-thor", active: false, reason: "Alteração sintética do vínculo assistencial", expectedVersion: boundVet.version, idempotencyKey: "change-bound-person" });
      const changedPerson = await writer.readStateSnapshot();
      expect(changedPerson.state.accessGroups.find((entry) => entry.id === group.id)?.version).toBe(1);
      expect(changedPerson.state.users.find((entry) => entry.id === vet.actor.id)).toMatchObject({ version: boundVet.version + 1, patientIds: ["patient-mel"] });
      const changedSql = await durableSql(database);
      await expect(service.updateAccessGroup(admin.actor, group.id, { ...input, expectedImpactToken: preview.impactToken, idempotencyKey: "stale-people" })).rejects.toMatchObject({ code: "STALE_VERSION", status: 409 });
      await assertNoDurableMutation(database, writer, observer, changedPerson, changedSql);
      const fresh = await independent.previewAccessGroupImpact(otherAdmin.actor, group.id, input);
      expect(fresh.impactToken).not.toBe(preview.impactToken);
      await expect(service.updateAccessGroup(admin.actor, group.id, { ...input, permissions: ["item.view"], expectedImpactToken: fresh.impactToken, idempotencyKey: "changed-candidate" })).rejects.toMatchObject({ code: "STALE_VERSION", status: 409 });
      await assertNoDurableMutation(database, writer, observer, changedPerson, changedSql);
      expect((await authenticateRequest(writer, lab.request)).id).toBe(lab.actor.id);
      await expect(authenticateRequest(writer, vet.request)).rejects.toMatchObject({ status: 401 });
      const saveInput = { ...input, expectedImpactToken: fresh.impactToken, idempotencyKey: "fresh-decision", correlationId: "durable-impact-save" };
      const saved = await service.updateAccessGroup(admin.actor, group.id, saveInput);
      expect(saved).toMatchObject({ version: 2, permissions: ["result.release"], active: true });
      const committed = await observer.readStateSnapshot(); const sql = await durableSql(database);
      expect(committed.state.users.find((user) => user.id === lab.actor.id)?.version).toBe(lab.actor.version + 1);
      expect(committed.state.users.find((user) => user.id === vet.actor.id)?.version).toBe(boundVet.version + 2);
      expect(committed.state.sessions.find((session) => session.id === lab.actor.sessionId)).toMatchObject({ revokedAt: expect.any(String), version: 2 });
      const savedAudit = (await database.query("SELECT metadata FROM audit_events WHERE event_type = 'AccessGroupUpdated' AND correlation_id = 'durable-impact-save'")).rows;
      expect(savedAudit).toEqual([{ metadata: expect.objectContaining({ sessionsRevoked: 1, affectedUserIds: expect.any(String) }) }]);
      expect(JSON.parse((savedAudit[0] as { metadata: { affectedUserIds: string } }).metadata.affectedUserIds).sort()).toEqual(["user-lab", "user-vet"]);
      expect(await independent.updateAccessGroup(otherAdmin.actor, group.id, saveInput)).toEqual(saved);
      await assertNoDurableMutation(database, writer, observer, committed, sql);
      await database.closeStore(writer); await database.closeStore(observer);
      const reopened = await database.createStore();
      expect(await reopened.readStateSnapshot()).toEqual(committed);
      expect(await durableSql(database)).toEqual(sql);
      await expect(authenticateRequest(reopened, lab.request)).rejects.toMatchObject({ status: 401 });
      const renewedLab = await signIn(reopened, "lab@cvg.local");
      expect(renewedLab.actor.permissions).toEqual(["result.release"]);
      await expect(createApplicationService(reopened).listRequests(renewedLab.actor)).rejects.toMatchObject({ status: 404 });
      await expect(createApplicationService(reopened).getItem(renewedLab.actor, request.items[0].id)).rejects.toMatchObject({ status: 404 });
      expect((await database.query("SELECT count(*)::int AS count FROM audit_events WHERE event_type = 'AccessGroupUpdated' AND entity_id = $1", [group.id])).rows).toEqual([{ count: 1 }]);
    });
  });

  it("requires a real password confirmation before a legitimate protected group write, revokes only its target and persists one replay", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const base = createDemoState(PASSWORD); const admin = base.users.find((user) => user.role === "ADMIN")!;
      const template = base.accessGroups.find((group) => group.id === systemGroupId("ADMIN"))!;
      const group = { ...template, id: "protected-step-up-group", code: "PROTECTED_STEP_UP", systemRole: undefined };
      base.accessGroups.push(group);
      const target = { ...admin, id: "step-up-target", email: "step-up-target@example.invalid", accessGroupId: group.id };
      base.users.push(target);
      base.departments = base.departments.map((department) => department.code === "IT" ? { ...department, memberUserIds: [...department.memberUserIds, target.id] } : department);
      const writer = await database.createStore(base); const observer = await database.createStore();
      const service = createApplicationService(writer); const read = createApplicationService(observer);
      const actor = await signIn(writer, admin.email); const signedTarget = await signIn(observer, target.email);
      const input = { permissions: ["user.create" as const], expectedVersion: 1 };
      const preview = await read.previewAccessGroupImpact(actor.actor, group.id, input);
      expect(preview).toMatchObject({ requiresReauthentication: true, affectedUserCount: 1 });
      const save = { ...input, expectedImpactToken: preview.impactToken, idempotencyKey: "confirmed-protected-write", correlationId: "confirmed-protected-write" };
      const before = await observer.readStateSnapshot(); const sql = await durableSql(database);
      await expect(service.updateAccessGroup(actor.actor, group.id, save)).rejects.toMatchObject({ code: "REAUTH_REQUIRED", status: 403 });
      await assertNoDurableMutation(database, writer, observer, before, sql);
      await expect(reauthenticateUser(observer, actor.request, "wrong-synthetic-password")).rejects.toMatchObject({ status: 401 });
      await assertNoDurableMutation(database, writer, observer, before, sql);
      const confirmed = await reauthenticateUser(observer, actor.request, PASSWORD);
      expect(confirmed).toMatchObject({ id: admin.id, sessionId: actor.actor.sessionId, reauthenticatedAt: expect.any(String) });
      const saved = await service.updateAccessGroup(confirmed, group.id, save);
      expect(saved).toMatchObject({ version: 2, permissions: ["user.create"] });
      const committed = await observer.readStateSnapshot(); const committedSql = await durableSql(database);
      expect(committed.state.users.find((user) => user.id === target.id)?.version).toBe(target.version + 1);
      expect(committed.state.users.find((user) => user.id === admin.id)).toEqual(before.state.users.find((user) => user.id === admin.id));
      await expect(authenticateRequest(observer, signedTarget.request)).rejects.toMatchObject({ status: 401 });
      expect((await authenticateRequest(writer, actor.request)).id).toBe(admin.id);
      expect((await database.query("SELECT metadata FROM audit_events WHERE event_type = 'AccessGroupUpdated' AND entity_id = $1", [group.id])).rows).toEqual([{ metadata: expect.objectContaining({ sessionsRevoked: 1, affectedUserIds: JSON.stringify([target.id]) }) }]);
      expect(await read.updateAccessGroup(confirmed, group.id, save)).toEqual(saved);
      await assertNoDurableMutation(database, writer, observer, committed, committedSql);
      await database.closeStore(writer); await database.closeStore(observer);
      const reopened = await database.createStore();
      expect(await reopened.readStateSnapshot()).toEqual(committed); expect(await durableSql(database)).toEqual(committedSql);
      await expect(authenticateRequest(reopened, signedTarget.request)).rejects.toMatchObject({ status: 401 });
      expect((await authenticateRequest(reopened, actor.request)).id).toBe(admin.id);
      expect((await database.query("SELECT count(*)::int AS count FROM audit_events WHERE event_type = 'AccessGroupUpdated' AND entity_id = $1", [group.id])).rows).toEqual([{ count: 1 }]);
    });
  });

  it.each(["ADMIN", "SUPERADMIN"] as const)("protects the last effective $0 independently of active empty administrative accounts and preserves sessions/SQL across denial and reopen", async (protectedRole) => {
    await withDisposablePostgresDatabase(async (database) => {
      const base = createDemoState(PASSWORD);
      const admin = base.users.find((user) => user.role === "ADMIN")!;
      const fullGroup = base.accessGroups.find((group) => group.id === systemGroupId(protectedRole))!;
      const operatorGroup = { ...fullGroup, id: "operator-limited-group", code: "OPERATOR_LIMITED", systemRole: undefined, permissions: ["access_group.update", "access_group.deactivate", "access_group.view"] as const };
      const targetGroup = { ...fullGroup, id: "protected-effective-group", code: "PROTECTED_EFFECTIVE", systemRole: undefined };
      const emptyGroup = { ...fullGroup, id: "active-empty-group", code: "ACTIVE_EMPTY", systemRole: undefined, permissions: [] };
      base.accessGroups.push({ ...operatorGroup, permissions: [...operatorGroup.permissions] }, targetGroup, emptyGroup);
      const operator = { ...admin, id: "limited-operator", email: "limited-operator@example.invalid", role: protectedRole, accessGroupId: operatorGroup.id };
      const target = { ...admin, id: "protected-target", email: "protected-target@example.invalid", role: protectedRole, accessGroupId: targetGroup.id };
      const empty = { ...admin, id: "active-empty-administrator", email: "active-empty@example.invalid", role: protectedRole, accessGroupId: emptyGroup.id };
      if (protectedRole === "ADMIN") base.users = base.users.filter((user) => user.id !== admin.id);
      base.users.push(operator, target, empty);
      base.departments = base.departments.map((department) => department.code === "IT" ? { ...department, memberUserIds: [...base.users.filter((user) => user.departmentCode === "IT").map((user) => user.id)] } : department);
      const writer = await database.createStore(base); const observer = await database.createStore();
      const service = createApplicationService(writer);
      const operatorLogin = await signIn(writer, operator.email); const targetLogin = await signIn(observer, target.email); const emptyLogin = await signIn(observer, empty.email);
      const confirmed = await reauthenticateUser(observer, operatorLogin.request, PASSWORD);
      expect(confirmed).toMatchObject({ id: operator.id, sessionId: operatorLogin.actor.sessionId, reauthenticatedAt: expect.any(String) });
      expect(emptyLogin.actor.permissions).toEqual([]);
      expect(targetLogin.actor.permissions).toEqual(expect.arrayContaining(["user.create", "user.update", "access_group.assign", "access_group.update"]));
      expect(confirmed.permissions).not.toContain("user.create");
      if (protectedRole === "SUPERADMIN") {
        const ordinaryAdmin = await signIn(observer, admin.email);
        expect(ordinaryAdmin.actor.permissions).toEqual(expect.arrayContaining(["user.create", "user.update", "access_group.assign", "access_group.update"]));
      }
      const before = await observer.readStateSnapshot(); const sql = await durableSql(database);
      const patch = { permissions: [], expectedVersion: targetGroup.version, idempotencyKey: "deny-last-effective" };
      await expect(service.previewAccessGroupImpact(confirmed, targetGroup.id, patch)).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
      await assertNoDurableMutation(database, writer, observer, before, sql);
      await expect(service.updateAccessGroup(confirmed, targetGroup.id, patch)).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
      await assertNoDurableMutation(database, writer, observer, before, sql);
      expect((await service.listAccessGroups(await authenticateRequest(writer, operatorLogin.request))).map((group) => group.id)).toContain(targetGroup.id);
      expect((await createApplicationService(observer).listManagedUsers(await authenticateRequest(observer, targetLogin.request))).map((user) => user.id)).toContain(target.id);
      await expect(createApplicationService(observer).listManagedUsers(await authenticateRequest(observer, emptyLogin.request))).rejects.toMatchObject({ status: 404 });
      await database.closeStore(writer); await database.closeStore(observer);
      const reopened = await database.createStore();
      expect(await reopened.readStateSnapshot()).toEqual(before);
      expect(await durableSql(database)).toEqual(sql);
      for (const session of [operatorLogin, targetLogin, emptyLogin]) expect((await authenticateRequest(reopened, session.request)).id).toBe(session.actor.id);
      expect((await database.query("SELECT count(*)::int AS count FROM audit_events WHERE event_type = 'AccessGroupUpdated'")).rows).toEqual([{ count: 0 }]);
      expect((await database.query("SELECT count(*)::int AS count FROM cvg_runtime_entities WHERE collection = 'idempotency' AND data->>'key' = 'deny-last-effective'")).rows).toEqual([{ count: 0 }]);
    });
  });

  it("serializes two independent protected writes so only one administrator can be withdrawn and the last effective administrator survives", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const base = createDemoState(PASSWORD); const admin = base.users.find((user) => user.role === "ADMIN")!;
      const template = base.accessGroups.find((group) => group.id === systemGroupId("ADMIN"))!;
      const operatorGroup = { ...template, id: "concurrent-operators", code: "CONCURRENT_OPERATORS", systemRole: undefined, permissions: ["access_group.update" as const, "access_group.view" as const] };
      const groups = ["one", "two"].map((suffix) => ({ ...template, id: `effective-${suffix}`, code: `EFFECTIVE_${suffix.toUpperCase()}`, systemRole: undefined }));
      base.accessGroups.push(operatorGroup, ...groups);
      base.users = base.users.filter((user) => user.id !== admin.id);
      for (const [index, suffix] of ["one", "two"].entries()) base.users.push(
        { ...admin, id: `operator-${suffix}`, email: `operator-${suffix}@example.invalid`, role: "SUPERADMIN" as RoleCode, accessGroupId: operatorGroup.id },
        { ...admin, id: `target-${suffix}`, email: `target-${suffix}@example.invalid`, accessGroupId: groups[index].id }
      );
      base.departments = base.departments.map((department) => department.code === "IT" ? { ...department, memberUserIds: base.users.filter((user) => user.departmentCode === "IT").map((user) => user.id) } : department);
      const writer = await database.createStore(base); const observer = await database.createStore();
      const first = createApplicationService(writer); const second = createApplicationService(observer);
      const operatorOne = await signIn(writer, "operator-one@example.invalid"); const operatorTwo = await signIn(observer, "operator-two@example.invalid");
      const targetOne = await signIn(writer, "target-one@example.invalid"); const targetTwo = await signIn(observer, "target-two@example.invalid");
      const confirmed = [await reauthenticateUser(writer, operatorOne.request, PASSWORD), await reauthenticateUser(observer, operatorTwo.request, PASSWORD)];
      const input = { permissions: [], expectedVersion: 1 };
      const previews = [await first.previewAccessGroupImpact(confirmed[0], groups[0].id, input), await second.previewAccessGroupImpact(confirmed[1], groups[1].id, input)];
      expect(previews.map((preview) => preview.requiresReauthentication)).toEqual([true, true]);
      const before = await observer.readStateSnapshot();
      const results = await Promise.allSettled([
        first.updateAccessGroup(confirmed[0], groups[0].id, { ...input, expectedImpactToken: previews[0].impactToken, idempotencyKey: "withdraw-one", correlationId: "concurrent-one" }),
        second.updateAccessGroup(confirmed[1], groups[1].id, { ...input, expectedImpactToken: previews[1].impactToken, idempotencyKey: "withdraw-two", correlationId: "concurrent-two" })
      ]);
      const successful = results.flatMap((result, index) => result.status === "fulfilled" ? [{ index, group: result.value }] : []);
      const denied = results.flatMap((result, index) => result.status === "rejected" ? [{ index, error: result.reason }] : []);
      expect(successful).toHaveLength(1); expect(denied).toHaveLength(1);
      expect(denied[0].error).toMatchObject({ code: "CONFLICT", status: 409 });
      const withdrawnIndex = successful[0].index; const retainedIndex = denied[0].index;
      expect(successful[0].group).toMatchObject({ id: groups[withdrawnIndex].id, version: 2, permissions: [] });
      const after = await observer.readStateSnapshot(); expect(await writer.readStateSnapshot()).toEqual(after);
      expect(after.version).toBe(before.version + 1);
      expect(after.state.accessGroups.find((group) => group.id === groups[retainedIndex].id)).toEqual(before.state.accessGroups.find((group) => group.id === groups[retainedIndex].id));
      const targets = [targetOne, targetTwo];
      await expect(authenticateRequest(observer, targets[withdrawnIndex].request)).rejects.toMatchObject({ status: 401 });
      const survivor = await authenticateRequest(writer, targets[retainedIndex].request);
      expect(survivor.permissions).toEqual(expect.arrayContaining(["user.create", "user.update", "access_group.assign", "access_group.update"]));
      expect((await first.listManagedUsers(survivor)).map((user) => user.id)).toContain(survivor.id);
      expect((await database.query("SELECT entity_id, metadata FROM audit_events WHERE event_type = 'AccessGroupUpdated'")).rows).toEqual([{ entity_id: groups[withdrawnIndex].id, metadata: expect.objectContaining({ sessionsRevoked: 1 }) }]);
      expect((await database.query("SELECT data->>'key' AS key FROM cvg_runtime_entities WHERE collection = 'idempotency' ORDER BY entity_key")).rows).toEqual([{ key: withdrawnIndex === 0 ? "withdraw-one" : "withdraw-two" }]);
      const sql = await durableSql(database);
      await database.closeStore(writer); await database.closeStore(observer);
      const reopened = await database.createStore();
      expect(await reopened.readStateSnapshot()).toEqual(after); expect(await durableSql(database)).toEqual(sql);
      await expect(authenticateRequest(reopened, targets[withdrawnIndex].request)).rejects.toMatchObject({ status: 401 });
      expect((await authenticateRequest(reopened, targets[retainedIndex].request)).permissions).toEqual(survivor.permissions);
      for (const operator of [operatorOne, operatorTwo]) expect((await authenticateRequest(reopened, operator.request)).id).toBe(operator.actor.id);
    });
  });
});
