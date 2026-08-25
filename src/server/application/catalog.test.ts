import { describe, expect, it } from "vitest";
import { createApplicationService } from "./service";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";

function setup() {
  const store = new MemoryStore(createDemoState());
  const service = createApplicationService(store);
  const user = (email: string) => {
    const actor = store.getState().users.find((entry) => entry.email === email);
    if (!actor) throw new Error(`missing fixture actor: ${email}`);
    return actor;
  };
  return { store, service, admin: user("admin@cvg.local"), manager: user("manager@cvg.local"), vet: user("vet@cvg.local") };
}

describe("versioned catalog administration", () => {
  it("exposes the active laboratory template only through the scoped catalog read", async () => {
    const { service, admin, vet } = setup();
    const template = await service.getResultTemplate(admin, "service-hemogram");
    expect(template).toMatchObject({ kind: "LABORATORY_PANEL", code: "SYNTHETIC_HEMOGRAM", version: 1 });
    await expect(service.getResultTemplate(vet, "service-hemogram")).resolves.toMatchObject({ code: "SYNTHETIC_HEMOGRAM" });
    await expect(service.getResultTemplate(admin, "service-missing")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("creates and updates a service with permission, optimistic version and audit", async () => {
    const { service, admin, manager, store } = setup();
    const created = await service.createDiagnosticService(admin, {
      code: "CT_ABDOMEN",
      name: "Tomografia abdominal",
      category: "IMAGING",
      departmentCode: "RADIOLOGY",
      workflowType: "RADIOLOGY",
      requiresSample: false,
      requiresSchedule: true,
      allowsAttachment: true,
      resultSchema: "NARRATIVE",
      slaHours: { ROUTINE: 72, URGENT: 24, EMERGENCY: 8 },
      idempotencyKey: "catalog-create"
    });
    const managerUpdated = await service.updateDiagnosticService(manager, created.id, {
      name: "Tomografia",
      departmentCode: "RADIOLOGY",
      workflowType: "RADIOLOGY",
      category: "IMAGING",
      requiresSample: false,
      requiresSchedule: true,
      resultSchema: "NARRATIVE",
      expectedVersion: 1,
      idempotencyKey: "catalog-manager-update"
    });
    expect(managerUpdated.name).toBe("Tomografia");

    const updated = await service.updateDiagnosticService(admin, created.id, { name: "Tomografia abdominal", active: false, expectedVersion: managerUpdated.version, idempotencyKey: "catalog-update" });
    expect(updated.active).toBe(false);
    expect(updated.version).toBe(3);
    expect((await service.listServices(admin, { includeInactive: true })).some((entry) => entry.id === created.id && entry.active === false)).toBe(true);
    await expect(service.updateDiagnosticService(admin, created.id, { expectedVersion: managerUpdated.version, idempotencyKey: "catalog-stale" })).rejects.toMatchObject({ code: "STALE_VERSION" });
    expect(store.getState().auditEvents.some((event) => event.eventType === "DiagnosticServiceUpdated")).toBe(true);
  });

  it("rejects a numeric laboratory service without an active panel template", async () => {
    const { service, admin } = setup();
    await expect(service.createDiagnosticService(admin, {
      code: "CRP_NUMERIC",
      name: "CRP numérico sem painel",
      category: "LABORATORY",
      departmentCode: "LABORATORY",
      workflowType: "LABORATORY",
      requiresSample: true,
      requiresSchedule: false,
      allowsAttachment: false,
      resultSchema: "NUMERIC_PANEL",
      slaHours: { ROUTINE: 8, URGENT: 4, EMERGENCY: 2 },
      idempotencyKey: "catalog-numeric-without-template"
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 422 });
  });

  it("creates, deactivates and rejects duplicate reason codes", async () => {
    const { service, admin } = setup();
    const created = await service.createReasonCode(admin, { type: "REJECT", code: "CLOT", label: "Coágulo", idempotencyKey: "reason-create" });
    expect(created.version).toBe(1);
    await expect(service.createReasonCode(admin, { type: "REJECT", code: "CLOT", label: "Outro", idempotencyKey: "reason-duplicate" })).rejects.toMatchObject({ code: "CONFLICT" });
    const updated = await service.updateReasonCode(admin, created.id, { active: false, expectedVersion: created.version, idempotencyKey: "reason-update" });
    expect(updated.active).toBe(false);
    expect(updated.version).toBe(2);
    expect((await service.listReasonCodes(admin)).some((entry) => entry.id === created.id && entry.active === false)).toBe(true);
  });

  it("does not let a care actor mutate the catalog", async () => {
    const { service, vet } = setup();
    await expect(service.createReasonCode(vet, { type: "REJECT", code: "NOPE", label: "Sem permissão", idempotencyKey: "reason-denied" })).rejects.toMatchObject({ code: "SCOPE_DENIED" });
  });

  it("rejects structural catalog changes after the service is referenced by an item", async () => {
    const { service, admin, vet } = setup();
    const request = await service.createRequest(vet, {
      patientId: "patient-thor",
      encounterId: "encounter-thor",
      priority: "ROUTINE",
      items: [{ serviceId: "service-hemogram" }]
    }, { idempotencyKey: "catalog-in-use-request" });

    await expect(service.updateDiagnosticService(admin, "service-hemogram", {
      departmentCode: "RADIOLOGY",
      workflowType: "RADIOLOGY",
      category: "IMAGING",
      requiresSample: false,
      requiresSchedule: true,
      resultSchema: "NARRATIVE",
      expectedVersion: 1,
      idempotencyKey: "catalog-in-use-structural"
    })).rejects.toMatchObject({ code: "CATALOG_IN_USE" });
    expect(request.items[0].service.code).toBe("HEMOGRAM");
  });
});
