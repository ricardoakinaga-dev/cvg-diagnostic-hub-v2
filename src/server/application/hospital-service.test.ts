import { describe, expect, it } from "vitest";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { createApplicationService } from "./service";
import { captureHospitalServiceForActivity } from "./hospital-service-registry";
import { HOSPITAL_SERVICE_COLUMNS } from "./hospital-service-import";

function setup() {
  const state = createDemoState("hospital-service-fixture-password");
  const timestamp = "2026-10-11T12:00:00Z";
  state.departments.push({ id: "department-nursing", code: "NURSING", name: "Enfermagem", type: "CLINICAL", active: true, memberUserIds: ["user-vet"], version: 1, createdAt: timestamp, updatedAt: timestamp });
  state.users = state.users.map((user) => user.id === "user-vet" ? { ...user, departmentCode: "NURSING" } : user.id === "user-manager" ? { ...user, managedDepartmentCodes: ["LABORATORY"] } : user);
  const store = new MemoryStore(state); const service = createApplicationService(store);
  const user = (email: string) => store.getState().users.find((entry) => entry.email === email)!;
  return { store, service, admin: user("admin@cvg.local"), manager: user("manager@cvg.local"), vet: user("vet@cvg.local"), lab: user("lab@cvg.local") };
}
const input = { code: "CARE_FIXTURE", name: "Cuidado sintético", kind: "CARE" as const, departmentCode: "NURSING", teamUserIds: ["user-vet"], resourceIds: [] };
const csv = (rows: string[]) => [HOSPITAL_SERVICE_COLUMNS.join(";"), ...rows].join("\n");
describe("hospital capacity catalog", () => {
  it("creates a capacity in a new sector and captures it without changing clinical grants", async () => {
    const c = setup(); const before = c.store.getState();
    const saved = await c.service.createHospitalService(c.admin, { ...input, idempotencyKey: "create" });
    expect(saved).toMatchObject({ active: true, version: 1, teamUserIds: ["user-vet"] });
    const after = c.store.getState();
    expect(after.users).toEqual(before.users); expect(after.accessGroups).toEqual(before.accessGroups); expect(after.patientGrants).toEqual(before.patientGrants); expect(after.services).toEqual(before.services);
    const snapshot = captureHospitalServiceForActivity(after, saved.id, "2026-10-11T13:00:00Z");
    expect(snapshot).toMatchObject({ source: "HOSPITAL_SERVICE", serviceId: saved.id, serviceVersion: 1, name: input.name, departmentCode: "NURSING", teamUserIds: ["user-vet"] });
    expect(after.auditEvents.at(-1)?.eventType).toBe("HospitalServiceCreated");
  });
  it("keeps an activity snapshot through a sector change without granting service access", async () => {
    const c = setup(); const saved = await c.service.createHospitalService(c.admin, { ...input, idempotencyKey: "create" });
    const snapshot = captureHospitalServiceForActivity(c.store.getState(), saved.id, "2026-10-11T13:00:00Z");
    const before = c.store.getState().users;
    await c.service.updateHospitalService(c.admin, saved.id, { name: "Nome futuro", departmentCode: "LABORATORY", teamUserIds: [], expectedVersion: 1, idempotencyKey: "move" });
    expect(snapshot).toMatchObject({ name: input.name, departmentCode: "NURSING", teamUserIds: ["user-vet"], serviceVersion: 1 });
    expect(c.store.getState().users).toEqual(before);
    expect(c.store.getState().auditEvents.at(-1)?.metadata).toMatchObject({ previousDepartmentCode: "NURSING", departmentCode: "LABORATORY" });
  });
  it("refuses new use of inactive capacity and validates references on reactivation", async () => {
    const c = setup(); const saved = await c.service.createHospitalService(c.admin, { ...input, idempotencyKey: "create" });
    const snapshot = captureHospitalServiceForActivity(c.store.getState(), saved.id, "2026-10-11T13:00:00Z");
    const inactive = await c.service.updateHospitalService(c.admin, saved.id, { active: false, expectedVersion: 1, idempotencyKey: "off" });
    expect(() => captureHospitalServiceForActivity(c.store.getState(), saved.id, "2026-10-11T14:00:00Z")).toThrow("ativo");
    expect(snapshot.name).toBe(input.name);
    await c.store.transaction((state) => ({ state: { ...state, departments: state.departments.map((entry) => entry.code === "NURSING" ? { ...entry, active: false } : entry) }, result: undefined }));
    await expect(c.service.updateHospitalService(c.admin, saved.id, { active: true, expectedVersion: inactive.version, idempotencyKey: "on-denied" })).rejects.toMatchObject({ status: 400 });
    await c.store.transaction((state) => ({ state: { ...state, departments: state.departments.map((entry) => entry.code === "NURSING" ? { ...entry, active: true } : entry) }, result: undefined }));
    expect(await c.service.updateHospitalService(c.admin, saved.id, { active: true, expectedVersion: inactive.version, idempotencyKey: "on" })).toMatchObject({ active: true, version: 3 });
  });
  it.each([{ teamUserIds: ["user-lab"] }, { teamUserIds: ["missing"] }, { teamUserIds: ["user-vet", "user-vet"] }, { resourceIds: ["fabricated-room"] }, { departmentCode: "MISSING", teamUserIds: [] }])("rejects invalid new bindings atomically: %j", async (patch) => {
    const c = setup(); const before = c.store.getState();
    await expect(c.service.createHospitalService(c.admin, { ...input, ...patch, idempotencyKey: "invalid" })).rejects.toMatchObject({ status: 400 });
    expect(c.store.getState()).toEqual(before);
  });
  it("checks inactive users and sector membership again at the activity binding", async () => {
    const c = setup(); const saved = await c.service.createHospitalService(c.admin, { ...input, idempotencyKey: "create" });
    await c.store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === "user-vet" ? { ...user, active: false } : user) }, result: undefined }));
    expect(() => captureHospitalServiceForActivity(c.store.getState(), saved.id, "2026-10-11T13:00:00Z")).toThrow("ativos");
    // Deactivation remains possible even when a previous descriptive member is no longer active.
    expect(await c.service.updateHospitalService(c.admin, saved.id, { active: false, expectedVersion: 1, idempotencyKey: "deactivate-stale-team" })).toMatchObject({ active: false });
  });
  it("projects diagnostics without creating a second authority and rejects code collisions", async () => {
    const c = setup(); const before = c.store.getState();
    const page = await c.service.listHospitalServices(c.admin, { kind: "DIAGNOSTIC" });
    expect(page.items).toHaveLength(before.services.length);
    expect(page.items.every((entry) => entry.source === "DIAGNOSTIC_SERVICE")).toBe(true);
    expect(c.store.getState()).toEqual(before);
    await expect(c.service.createHospitalService(c.admin, { ...input, code: "HEMOGRAM", idempotencyKey: "cross-duplicate" })).rejects.toMatchObject({ status: 409 });
    await expect(c.service.updateHospitalService(c.admin, "service-hemogram", { name: "Ambiguous replacement", expectedVersion: 1, idempotencyKey: "diagnostic-patch" })).rejects.toMatchObject({ status: 404 });
  });
  it("also prevents diagnostic creation or import from claiming a general capacity code", async () => {
    const c = setup(); await c.service.createHospitalService(c.admin, { ...input, idempotencyKey: "create" });
    const before = c.store.getState();
    await expect(c.service.createDiagnosticService(c.admin, { code: input.code, name: "Collision", category: "LABORATORY", departmentCode: "LABORATORY", workflowType: "LABORATORY", requiresSample: true, requiresSchedule: false, allowsAttachment: false, resultSchema: "NARRATIVE", slaHours: { ROUTINE: 8, URGENT: 4, EMERGENCY: 2 }, idempotencyKey: "diagnostic-collision" })).rejects.toMatchObject({ status: 409 });
    const sheet = "codigo;nome;categoria;setor;fluxo;exige_amostra;tipo_amostra;exige_agenda;permite_anexo;esquema_resultado;sla_rotina_h;sla_urgente_h;sla_emergencia_h;ativo\nCARE_FIXTURE;Collision;LABORATORY;LABORATORY;LABORATORY;sim;EDTA;não;não;NARRATIVE;8;4;2;sim";
    await expect(c.service.importCatalog(c.admin, { services: sheet, idempotencyKey: "diagnostic-import-collision" })).rejects.toMatchObject({ code: "CATALOG_IMPORT_INVALID", status: 422 });
    expect(c.store.getState()).toEqual(before);
  });
  it("checks both the previous and proposed sector against manager delegation", async () => {
    const c = setup(); const saved = await c.service.createHospitalService(c.admin, { ...input, idempotencyKey: "create" });
    await expect(c.service.updateHospitalService(c.manager, saved.id, { departmentCode: "LABORATORY", teamUserIds: [], expectedVersion: 1, idempotencyKey: "claim-other-sector" })).rejects.toMatchObject({ status: 404 });
    await expect(c.service.createHospitalService(c.manager, { ...input, idempotencyKey: "foreign-create" })).rejects.toMatchObject({ status: 404 });
    const own = await c.service.createHospitalService(c.manager, { ...input, code: "LAB_OPERATIONS", kind: "OPERATIONAL", departmentCode: "LABORATORY", teamUserIds: [], idempotencyKey: "own-create" });
    await expect(c.service.updateHospitalService(c.manager, own.id, { departmentCode: "NURSING", expectedVersion: 1, idempotencyKey: "move-foreign" })).rejects.toMatchObject({ status: 404 });
    expect((await c.service.listHospitalServices(c.manager)).items.some((entry) => entry.id === saved.id)).toBe(false);
  });
  it("paginates the unified catalog without loss and binds cursor to filters", async () => {
    const c = setup(); const saved = await c.service.createHospitalService(c.admin, { ...input, idempotencyKey: "create" });
    await c.store.transaction((state) => ({ state: { ...state, hospitalServices: Array.from({ length: 12 }, (_, i) => ({ ...saved, id: `capacity-${i}`, code: `CARE_${String(i).padStart(3, "0")}` })) }, result: undefined }));
    const ids: string[] = []; let cursor: string | undefined;
    do { const page = await c.service.listHospitalServices(c.admin, { limit: 3, cursor }); ids.push(...page.items.map((entry) => entry.id)); cursor = page.nextCursor; } while (cursor);
    expect(ids).toHaveLength(12 + c.store.getState().services.length); expect(new Set(ids).size).toBe(ids.length);
    const first = await c.service.listHospitalServices(c.admin, { limit: 3 });
    await expect(c.service.listHospitalServices(c.admin, { limit: 3, kind: "CARE", cursor: first.nextCursor })).rejects.toMatchObject({ status: 400 });
  });
  it("previews and atomically imports capacities, then makes identical import a no-op", async () => {
    const c = setup(); const sheet = csv(["CARE_CSV;Cuidado CSV;CARE;NURSING;Descrição;user-vet;;sim;"]);
    const before = c.store.getState();
    expect(await c.service.importHospitalServices(c.admin, { csv: sheet })).toMatchObject({ applied: false, dryRun: true, summary: { create: 1, error: 0 } });
    expect(c.store.getState()).toEqual(before);
    expect(await c.service.importHospitalServices(c.admin, { csv: sheet, dryRun: false, idempotencyKey: "import" })).toMatchObject({ applied: true, summary: { create: 1 } });
    const applied = c.store.getState();
    expect(await c.service.importHospitalServices(c.admin, { csv: sheet, dryRun: false, idempotencyKey: "import" })).toMatchObject({ applied: true, summary: { create: 1 } });
    expect(await c.service.importHospitalServices(c.admin, { csv: sheet, dryRun: false, idempotencyKey: "import-identical" })).toMatchObject({ summary: { unchanged: 1, update: 0 } });
    expect(c.store.getState()).toEqual(applied);
    const broken = csv(["NEW_CARE;Novo;CARE;NURSING;;;;sim;", "BAD_CARE;Ruim;CARE;NURSING;;;fake-resource;sim;"]);
    await expect(c.service.importHospitalServices(c.admin, { csv: broken, dryRun: false, idempotencyKey: "atomic-broken" })).rejects.toMatchObject({ status: 422 });
    expect(c.store.getState()).toEqual(applied);
  });
  it("requires the expected revision for import changes and current authority for a create replay", async () => {
    const c = setup(); const saved = await c.service.createHospitalService(c.admin, { ...input, idempotencyKey: "create" });
    const stale = csv(["CARE_FIXTURE;Alterado;CARE;NURSING;;user-vet;;sim;9"]);
    await expect(c.service.importHospitalServices(c.admin, { csv: stale, dryRun: false, idempotencyKey: "stale" })).rejects.toMatchObject({ status: 422 });
    await c.store.transaction((state) => ({ state: { ...state, accessGroups: state.accessGroups.map((group) => group.id === c.admin.accessGroupId ? { ...group, permissions: group.permissions.filter((permission) => !["service.catalog.manage", "service.catalog.create"].includes(permission)), version: group.version + 1 } : group) }, result: undefined }));
    await expect(c.service.createHospitalService(c.admin, { ...input, idempotencyKey: "create" })).rejects.toMatchObject({ status: 404 });
    expect(c.store.getState().hospitalServices).toEqual([saved]);
  });
  it("deactivates and reactivates by import while preserving previous snapshots", async () => {
    const c = setup(); const saved = await c.service.createHospitalService(c.admin, { ...input, idempotencyKey: "create" });
    const snapshot = captureHospitalServiceForActivity(c.store.getState(), saved.id, "2026-10-11T13:00:00Z");
    const off = csv(["CARE_FIXTURE;Cuidado sintético;CARE;NURSING;;user-vet;;não;1"]);
    expect(await c.service.importHospitalServices(c.admin, { csv: off, dryRun: false, idempotencyKey: "import-off" })).toMatchObject({ summary: { update: 1 } });
    expect(() => captureHospitalServiceForActivity(c.store.getState(), saved.id, "2026-10-11T14:00:00Z")).toThrow("ativo");
    const on = csv(["CARE_FIXTURE;Cuidado sintético;CARE;NURSING;;user-vet;;sim;2"]);
    expect(await c.service.importHospitalServices(c.admin, { csv: on, dryRun: false, idempotencyKey: "import-on" })).toMatchObject({ summary: { update: 1 } });
    expect(c.store.getState().hospitalServices[0]).toMatchObject({ active: true, version: 3 });
    expect(snapshot).toMatchObject({ serviceVersion: 1, name: input.name });
  });
  it("refuses replaying an import after the manager loses its delegated sector", async () => {
    const c = setup(); const sheet = csv(["LAB_CAPACITY;Capacidade do laboratório;OPERATIONAL;LABORATORY;;;;sim;"]);
    await c.service.importHospitalServices(c.manager, { csv: sheet, dryRun: false, idempotencyKey: "delegated-import" });
    await c.store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === c.manager.id ? { ...user, managedDepartmentCodes: [], version: user.version + 1 } : user) }, result: undefined }));
    const before = c.store.getState();
    await expect(c.service.importHospitalServices(c.manager, { csv: sheet, dryRun: false, idempotencyKey: "delegated-import" })).rejects.toMatchObject({ code: "SCOPE_DENIED", status: 404 });
    expect(c.store.getState()).toEqual(before);
  });
  it("replays an originally authorized create import without demanding an update grant", async () => {
    const c = setup();
    await c.store.transaction((state) => ({ state: { ...state, accessGroups: state.accessGroups.map((group) => group.id === c.admin.accessGroupId ? { ...group, permissions: group.permissions.filter((permission) => !["service.catalog.manage", "service.catalog.update", "service.catalog.deactivate"].includes(permission)), version: group.version + 1 } : group) }, result: undefined }));
    const sheet = csv(["CREATE_ONLY;Nova capacidade;CARE;NURSING;;;;sim;"]);
    const first = await c.service.importHospitalServices(c.admin, { csv: sheet, dryRun: false, idempotencyKey: "create-only-import" });
    const before = c.store.getState();
    const replay = await c.service.importHospitalServices(c.admin, { csv: sheet, dryRun: false, idempotencyKey: "create-only-import" });
    expect(replay).toEqual(first); expect(c.store.getState()).toEqual(before);
  });
});

describe("hospital service sheet boundaries", () => {
  it.each(["codigo;nome\nCODE;Name", `${HOSPITAL_SERVICE_COLUMNS.join(";")}\n\"unterminated`])("reports invalid sheet structure without mutation: %s", async (sheet) => {
    const c = setup(); const before = c.store.getState();
    expect(await c.service.importHospitalServices(c.admin, { csv: sheet })).toMatchObject({ applied: false, summary: { error: 1 } });
    expect(c.store.getState()).toEqual(before);
  });
  it("reports bad boolean, duplicate code, columns and absent update version atomically", async () => {
    const c = setup(); await c.service.createHospitalService(c.admin, { ...input, idempotencyKey: "existing-sheet" });
    const sheet = csv(["BOOLEAN;Inválido;CARE;NURSING;;;;maybe;", "DUPLICATE;Primeiro;CARE;NURSING;;;;sim;", "DUPLICATE;Segundo;CARE;NURSING;;;;sim;", "SHORT;Sem colunas", "CARE_FIXTURE;Mudança sem versão;CARE;NURSING;;user-vet;;sim;"]);
    const before = c.store.getState(); const report = await c.service.importHospitalServices(c.admin, { csv: sheet });
    expect(report.summary).toMatchObject({ error: 4, create: 1 });
    expect(report.rows.filter((row) => row.action === "ERROR").every((row) => row.errors?.length)).toBe(true);
    await expect(c.service.importHospitalServices(c.admin, { csv: sheet, dryRun: false, idempotencyKey: "bad-sheet" })).rejects.toMatchObject({ status: 422 });
    expect(c.store.getState()).toEqual(before);
  });
  it("clears previous descriptions and checks deactivation permission on import replay", async () => {
    const c = setup(); const created = await c.service.createHospitalService(c.admin, { ...input, description: "Descrição anterior", idempotencyKey: "described" });
    const sheet = csv([`CARE_FIXTURE;Cuidado sintético;CARE;NURSING;; user-vet, ;;false;${created.version}`]);
    const command = { csv: sheet, dryRun: false, idempotencyKey: "clear-and-off" };
    expect(await c.service.importHospitalServices(c.admin, command)).toMatchObject({ summary: { update: 1 } });
    expect(c.store.getState().hospitalServices[0]).toMatchObject({ active: false, teamUserIds: ["user-vet"] });
    expect(c.store.getState().hospitalServices[0].description).toBeUndefined();
    await c.store.transaction((state) => ({ state: { ...state, accessGroups: state.accessGroups.map((group) => group.id === c.admin.accessGroupId ? { ...group, permissions: group.permissions.filter((permission) => !["service.catalog.manage", "service.catalog.deactivate"].includes(permission)) } : group) }, result: undefined }));
    await expect(c.service.importHospitalServices(c.admin, command)).rejects.toMatchObject({ status: 404 });
  });
});
