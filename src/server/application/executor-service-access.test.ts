import { describe, expect, it } from "vitest";
import type { ServiceAccessPolicy } from "@cvg/contracts";
import { createApplicationService } from "./service";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { serviceAccessPolicySchema, userRoleSchema } from "../http/admin-schemas";
import { canAccessResource } from "../security/authorization";

const NONE: ServiceAccessPolicy = { mode: "NONE", includeFuture: false };
const CURRENT: ServiceAccessPolicy = { mode: "ALL_CURRENT", includeFuture: false };
const FUTURE: ServiceAccessPolicy = { mode: "ALL_CURRENT", includeFuture: true };
const SELECTED: ServiceAccessPolicy = { mode: "SELECTED", includeFuture: false };
const exam = { code: "EXPLICIT_NEW", name: "Exame de teste", category: "LABORATORY" as const, departmentCode: "LABORATORY", workflowType: "LABORATORY" as const, requiresSample: false, requiresSchedule: false, allowsAttachment: false, resultSchema: "NARRATIVE" as const, slaHours: { ROUTINE: 24, URGENT: 4, EMERGENCY: 1 } };
const header = "codigo;nome;categoria;setor;fluxo;exige_amostra;tipo_amostra;exige_agenda;permite_anexo;esquema_resultado;sla_rotina_h;sla_urgente_h;sla_emergencia_h;ativo";

function setup() {
  const store = new MemoryStore(createDemoState("service-access-policy-test"));
  const admin = store.getState().users.find((user) => user.role === "ADMIN")!;
  const service = createApplicationService(store);
  const create = (email: string, policy?: ServiceAccessPolicy, codes?: string[]) => service.createManagedUser(admin, { displayName: email, email: `${email}@cvg.local`, role: "LAB_TECH", departmentCode: "LABORATORY", serviceAccessPolicy: policy, serviceCodes: codes, idempotencyKey: email });
  return { store, admin, service, create };
}

describe("explicit current and future executor access", () => {
  it("conserves legacy full lists and all-current snapshots without interpreting them as future consent", async () => {
    const { store, admin, service, create } = setup();
    const legacy = store.getState().users.find((user) => user.role === "LAB_TECH")!;
    const current = await create("current", CURRENT);
    const selected = await create("selected", SELECTED, [...current.serviceCodes!]);
    const none = await create("none", NONE);
    const before = store.getState().users.map((user) => ({ id: user.id, serviceCodes: user.serviceCodes, version: user.version }));
    await service.createDiagnosticService(admin, { ...exam, idempotencyKey: "new-exam" });
    expect(store.getState().users.map((user) => ({ id: user.id, serviceCodes: user.serviceCodes, version: user.version }))).toEqual(before);
    const users = await service.listManagedUsers(admin);
    expect(users.find((user) => user.id === legacy.id)?.serviceAccessPolicy).toEqual(SELECTED);
    expect(users.find((user) => user.id === current.id)?.serviceCodes).not.toContain(exam.code);
    expect(users.find((user) => user.id === selected.id)?.serviceAccessPolicy).toEqual(SELECTED);
    expect(users.find((user) => user.id === none.id)?.serviceCodes).toEqual([]);
  });

  it("keeps NONE and empty selections empty when the first exam enters an empty catalog", async () => {
    const { store, admin, service, create } = setup();
    await store.transaction((state) => ({ state: { ...state, services: state.services.filter((item) => item.departmentCode !== "LABORATORY") }, result: undefined }));
    const none = await create("empty-none", NONE);
    const selected = await create("empty-selected", SELECTED, []);
    const current = await create("empty-current", CURRENT);
    const future = await create("empty-future", FUTURE);
    await service.createDiagnosticService(admin, { ...exam, idempotencyKey: "first-exam" });
    for (const user of [none, selected, current]) expect(store.getState().users.find((entry) => entry.id === user.id)?.serviceCodes).toEqual([]);
    expect(store.getState().users.find((entry) => entry.id === future.id)?.serviceCodes).toEqual([exam.code]);
  });

  it.each(["create", "import", "reactivate", "transfer"] as const)("%s grants only a confirmed future policy and audits affected users once", async (operation) => {
    const { store, admin, service, create } = setup();
    let existing: Awaited<ReturnType<typeof service.createDiagnosticService>> | undefined;
    if (operation === "reactivate" || operation === "transfer") {
      existing = await service.createDiagnosticService(admin, { ...exam, departmentCode: operation === "transfer" ? "RADIOLOGY" : "LABORATORY", idempotencyKey: "prepare" });
      if (operation === "reactivate") existing = await service.updateDiagnosticService(admin, existing.id, { active: false, expectedVersion: existing.version, idempotencyKey: "disable" });
    }
    const future = await create("future", FUTURE);
    const current = await create("current", CURRENT);
    const selected = await create("selected", SELECTED, [...current.serviceCodes!]);
    const none = await create("none", NONE);
    await store.transaction((state) => ({ state: { ...state, sessions: [...state.sessions, { id: "future-session", userId: future.id, tokenHash: "synthetic", csrfTokenHash: "synthetic", createdAt: "2026-01-01T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z", version: 1 }] }, result: undefined }));
    const beforeAudits = store.getState().auditEvents.length;
    const apply = () => operation === "create" ? service.createDiagnosticService(admin, { ...exam, idempotencyKey: "apply", correlationId: "explicit-access" })
      : operation === "import" ? service.importCatalog(admin, { services: `${header}\n${exam.code};${exam.name};LABORATORY;LABORATORY;LABORATORY;não;;não;não;NARRATIVE;24;4;1;sim`, idempotencyKey: "apply", correlationId: "explicit-access" })
      : service.updateDiagnosticService(admin, existing!.id, { ...(operation === "reactivate" ? { active: true } : { departmentCode: "LABORATORY" }), expectedVersion: existing!.version, idempotencyKey: "apply", correlationId: "explicit-access" });
    await apply();
    const state = store.getState();
    expect(state.users.find((entry) => entry.id === future.id)).toMatchObject({ serviceCodes: expect.arrayContaining([exam.code]), serviceAccessPolicy: FUTURE, version: future.version + 1 });
    for (const user of [none, selected, current]) expect(state.users.find((entry) => entry.id === user.id)?.serviceCodes).toEqual(user.serviceCodes);
    expect(state.sessions.find((session) => session.id === "future-session")?.revokedAt).toBeDefined();
    const accessEvents = state.auditEvents.slice(beforeAudits).filter((event) => event.eventType === "UserServiceAccessUpdated");
    expect(accessEvents).toHaveLength(1);
    expect(accessEvents[0]).toMatchObject({ actorId: admin.id, entityId: future.id, correlationId: "explicit-access", metadata: { addedServiceCodes: exam.code, includeFuture: true, reason: "EXPLICIT_FUTURE_POLICY" } });
    const eventCount = state.auditEvents.length;
    await apply();
    expect(store.getState().auditEvents).toHaveLength(eventCount);
  });

  it("removes a transferred exam from old department grants and audits their withdrawal", async () => {
    const { store, admin, service, create } = setup();
    const created = await service.createDiagnosticService(admin, { ...exam, idempotencyKey: "prepare-transfer" });
    const selected = await create("old-department", SELECTED, [exam.code]);
    await service.updateDiagnosticService(admin, created.id, { departmentCode: "RADIOLOGY", expectedVersion: created.version, idempotencyKey: "move" });
    expect(store.getState().users.find((user) => user.id === selected.id)?.serviceCodes).toEqual([]);
    expect(store.getState().auditEvents.find((event) => event.eventType === "UserServiceAccessUpdated" && event.entityId === selected.id)).toMatchObject({ metadata: { removedServiceCodes: exam.code, reason: "SERVICE_DEPARTMENT_TRANSFER" } });
  });

  it.each(["reactivate", "transfer"] as const)("catalog import %s follows the same explicit future policy", async (operation) => {
    const { store, admin, service, create } = setup();
    const prepared = await service.createDiagnosticService(admin, { ...exam, departmentCode: operation === "transfer" ? "RADIOLOGY" : "LABORATORY", idempotencyKey: "import-prepare" });
    if (operation === "reactivate") await service.updateDiagnosticService(admin, prepared.id, { active: false, expectedVersion: prepared.version, idempotencyKey: "import-disable" });
    const future = await create("import-future", FUTURE);
    const none = await create("import-none", NONE);
    await service.importCatalog(admin, { services: `${header}\n${exam.code};${exam.name};LABORATORY;LABORATORY;LABORATORY;não;;não;não;NARRATIVE;24;4;1;sim`, idempotencyKey: "import-reactivate-or-transfer" });
    expect(store.getState().users.find((user) => user.id === future.id)?.serviceCodes).toContain(exam.code);
    expect(store.getState().users.find((user) => user.id === none.id)?.serviceCodes).toEqual([]);
    expect(store.getState().auditEvents.filter((event) => event.eventType === "UserServiceAccessUpdated" && event.entityId === future.id)).toHaveLength(1);
  });

  it("materializing a confirmed future grant never reactivates an inactive user", async () => {
    const { store, admin, service, create } = setup();
    const future = await create("inactive-future", FUTURE);
    await service.deactivateManagedUser(admin, future.id, { expectedVersion: future.version, idempotencyKey: "deactivate-future" });
    await service.createDiagnosticService(admin, { ...exam, idempotencyKey: "inactive-new-exam" });
    const persisted = store.getState().users.find((user) => user.id === future.id)!;
    expect(persisted).toMatchObject({ active: false, serviceCodes: expect.arrayContaining([exam.code]) });
    expect(canAccessResource(persisted, "sample.receive", { departmentCode: "LABORATORY", serviceCode: exam.code })).toBe(false);
  });

  it("preserves unchanged policies on ordinary edits but moving departments without a choice grants nothing", async () => {
    const { store, admin, service, create } = setup();
    const future = await create("unchanged", FUTURE);
    const unchanged = await service.updateUserRole(admin, future.id, { role: "LAB_TECH", departmentCode: "LABORATORY", expectedVersion: future.version, idempotencyKey: "ordinary-edit" });
    expect(unchanged.serviceAccessPolicy).toEqual(FUTURE);
    expect(unchanged.serviceCodes).toEqual(future.serviceCodes);
    const moved = await service.updateUserRole(admin, future.id, { role: "RADIOLOGY_TEAM", departmentCode: "RADIOLOGY", expectedVersion: unchanged.version, idempotencyKey: "move-user" });
    expect(moved.serviceAccessPolicy).toEqual(NONE);
    expect(moved.serviceCodes).toEqual([]);
    const restored = await service.updateUserRole(admin, future.id, { role: "RADIOLOGY_TEAM", departmentCode: "RADIOLOGY", serviceAccessPolicy: CURRENT, expectedVersion: moved.version, idempotencyKey: "confirm-new-scope" });
    expect(restored.serviceCodes).toEqual(store.getState().services.filter((entry) => entry.active && entry.departmentCode === "RADIOLOGY").map((entry) => entry.code));
  });

  it("denies incompatible policies and unauthorized grants without mutation", async () => {
    const { store, admin, service, create } = setup();
    const before = store.getState();
    await expect(create("invalid-future", { mode: "SELECTED", includeFuture: true }, ["HEMOGRAM"])).rejects.toMatchObject({ status: 400 });
    await expect(create("contradictory-none", NONE, ["HEMOGRAM"])).rejects.toMatchObject({ status: 400 });
    await expect(create("missing-selection", SELECTED)).rejects.toMatchObject({ status: 400 });
    await expect(create("cross-department", SELECTED, ["XRAY_THORAX"])).rejects.toMatchObject({ status: 404 });
    const vet = store.getState().users.find((user) => user.role === "VETERINARIAN")!;
    await expect(service.createManagedUser(vet, { displayName: "Blocked", email: "blocked@cvg.local", role: "LAB_TECH", departmentCode: "LABORATORY", serviceAccessPolicy: FUTURE, idempotencyKey: "blocked" })).rejects.toMatchObject({ status: 404 });
    await expect(service.createManagedUser(admin, { displayName: "Non executor", email: "viewer@cvg.local", role: "VIEWER", serviceAccessPolicy: NONE, idempotencyKey: "viewer" })).rejects.toMatchObject({ status: 400 });
    expect(store.getState()).toEqual(before);
    expect(serviceAccessPolicySchema.safeParse({ mode: "NONE", includeFuture: true }).success).toBe(false);
    expect(serviceAccessPolicySchema.safeParse({ ...FUTURE, permission: "user_role.manage" }).success).toBe(false);
    expect(userRoleSchema.safeParse({ role: "LAB_TECH", departmentCode: "LABORATORY", serviceAccessPolicy: FUTURE, expectedVersion: 1 }).success).toBe(true);
  });
});
