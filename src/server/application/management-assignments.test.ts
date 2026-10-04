import { describe, expect, it } from "vitest";
import { createApplicationService } from "./service";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { authenticateRequest, changeInitialPassword, loginUser } from "../security/session";

function setup() {
  const store = new MemoryStore(createDemoState("test-password-2026"));
  const admin = store.getState().users.find((user) => user.role === "ADMIN")!;
  const vet = store.getState().users.find((user) => user.role === "VETERINARIAN")!;
  const manager = store.getState().users.find((user) => user.role === "MANAGER")!;
  return { store, admin, vet, manager, service: createApplicationService(store) };
}

describe("explicit executor assignments and catalog duplication", () => {
  it("allows a provisioned technician to execute only the configured service after changing the initial password", async () => {
    const { store, admin, vet, service } = setup();
    const request = await service.createRequest(vet, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-hemogram" }, { serviceId: "service-crp" }] }, { idempotencyKey: "assignment-request" });
    const created = await service.createManagedUser(admin, { displayName: "Técnico novo", email: "new-tech@cvg.local", role: "LAB_TECH", departmentCode: "LABORATORY", serviceCodes: ["hemogram", "HEMOGRAM"], idempotencyKey: "assignment-user" });
    expect(created.serviceCodes).toEqual(["HEMOGRAM"]);
    const login = await loginUser(store, created.email, created.initialPassword!);
    const changed = await changeInitialPassword(store, new Request("http://localhost/api/v1/session/password", { headers: { cookie: `cvg_session=${login.sessionToken}; cvg_csrf=${login.csrfToken}`, "x-csrf-token": login.csrfToken } }), "personal-tech-password-2026", "assignment-first-login");
    const actor = await authenticateRequest(store, new Request("http://localhost", { headers: { cookie: `cvg_session=${changed.sessionToken}` } }));
    const queue = await service.listQueue(actor, "LABORATORY");
    expect(queue).toHaveLength(1);
    expect(queue[0].service.code).toBe("HEMOGRAM");
    const blocked = request.items.find((item) => item.service.code === "CRP")!;
    await expect(service.receiveSample(actor, [blocked.id], { accessionCode: "ACC-DENIED", sampleType: "EDTA", expectedVersion: blocked.version, idempotencyKey: "assignment-denied" })).rejects.toMatchObject({ status: 404 });
    const saved = await service.updateUserRole(admin, created.id, { role: "LAB_TECH", departmentCode: "LABORATORY", serviceCodes: ["CRP"], expectedVersion: changed.user.version, idempotencyKey: "assignment-update" });
    expect(saved.serviceCodes).toEqual(["CRP"]);
    await expect(authenticateRequest(store, new Request("http://localhost", { headers: { cookie: `cvg_session=${changed.sessionToken}` } }))).rejects.toMatchObject({ status: 401 });
    expect(store.getState().auditEvents.at(-1)).toMatchObject({ actorId: admin.id, eventType: "UserRoleUpdated", metadata: { previousServiceCodes: "HEMOGRAM", serviceCodes: "CRP" } });
  });

  it("rejects unknown, cross-department and non-executor grants without mutating state", async () => {
    const { store, admin, manager, service } = setup();
    const base = { displayName: "Técnico", email: "invalid-tech@cvg.local", role: "LAB_TECH" as const, departmentCode: "LABORATORY", idempotencyKey: "invalid-assignment" };
    await store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === manager.id ? { ...user, departmentCode: "RADIOLOGY", managedDepartmentCodes: [] } : user) }, result: undefined }));
    const before = store.getState();
    for (const codes of [["UNKNOWN"], ["XRAY_THORAX"]]) await expect(service.createManagedUser(admin, { ...base, serviceCodes: codes })).rejects.toMatchObject({ status: 404 });
    await expect(service.createManagedUser(admin, { ...base, role: "VIEWER", serviceCodes: ["HEMOGRAM"] })).rejects.toMatchObject({ status: 400 });
    await expect(service.createManagedUser(admin, { ...base, serviceCodes: Array(201).fill("HEMOGRAM") })).rejects.toMatchObject({ status: 400 });
    await expect(service.createManagedUser({ ...manager, departmentCode: "RADIOLOGY", managedDepartmentCodes: [] }, { ...base, serviceCodes: ["HEMOGRAM"] })).rejects.toMatchObject({ status: 404 });
    expect(store.getState()).toEqual(before);
  });

  it("preserves explicit grants on ordinary edits and clears them when the executor leaves the department or role", async () => {
    const { store, admin, service } = setup();
    const technician = store.getState().users.find((user) => user.role === "LAB_TECH")!;
    const saved = await service.updateUserRole(admin, technician.id, { role: "LAB_TECH", departmentCode: "LABORATORY", expectedVersion: technician.version, idempotencyKey: "preserve-grants" });
    expect(saved.serviceCodes).toEqual(technician.serviceCodes);
    const moved = await service.updateUserRole(admin, technician.id, { role: "RADIOLOGY_TEAM", departmentCode: "RADIOLOGY", expectedVersion: saved.version, idempotencyKey: "move-grants" });
    expect(moved.serviceCodes).toEqual([]);
    const viewer = await service.updateUserRole(admin, technician.id, { role: "VIEWER", departmentCode: "RADIOLOGY", expectedVersion: moved.version, idempotencyKey: "clear-grants" });
    expect(viewer.serviceCodes).toBeUndefined();
  });

  it("duplicates an authorized numeric panel using its persisted template and enforces source scope", async () => {
    const { store, admin, manager, service } = setup();
    await store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === manager.id ? { ...user, departmentCode: "RADIOLOGY", managedDepartmentCodes: [] } : user) }, result: undefined }));
    const source = store.getState().services.find((item) => item.id === "service-hemogram")!;
    const command = { ...source, code: "HEMOGRAM_COPY", name: "Hemograma cópia", duplicateOfServiceId: source.id, idempotencyKey: "numeric-copy" };
    const copy = await service.createDiagnosticService(admin, command);
    expect(copy.resultSchema).toBe("NUMERIC_PANEL");
    expect(copy.resultTemplate).toEqual(source.resultTemplate);
    expect(copy.resultTemplate).not.toBe(source.resultTemplate);
    expect(copy.id).not.toBe(source.id);
    expect(await service.createDiagnosticService(admin, command)).toMatchObject({ id: copy.id });
    await expect(service.createDiagnosticService({ ...manager, departmentCode: "RADIOLOGY", managedDepartmentCodes: [] }, { ...command, code: "HEMOGRAM_SCOPE", departmentCode: "RADIOLOGY", idempotencyKey: "numeric-out-of-scope" })).rejects.toMatchObject({ status: 404 });
    await expect(service.createDiagnosticService(admin, { ...command, code: "HEMOGRAM_MISSING", duplicateOfServiceId: "missing", idempotencyKey: "numeric-source-missing" })).rejects.toMatchObject({ status: 404 });
    await expect(service.createDiagnosticService(admin, { ...command, code: "HEMOGRAM_INACTIVE", duplicateOfServiceId: "service-crp", idempotencyKey: "numeric-no-template" })).rejects.toMatchObject({ status: 422 });
    await store.transaction((state) => ({ state: { ...state, services: state.services.map((item) => item.id === source.id && item.resultTemplate ? { ...item, resultTemplate: { ...item.resultTemplate, status: "RETIRED" } } : item) }, result: undefined }));
    await expect(service.createDiagnosticService(admin, { ...command, code: "HEMOGRAM_RETIRED", idempotencyKey: "numeric-retired-template" })).rejects.toMatchObject({ status: 422 });
  });
});
