import { describe, expect, it } from "vitest";
import type { PlannerViewDisplay } from "@cvg/contracts";
import { hospitalOperationFixture } from "@/test/hospital-operation-fixtures";

const display: PlannerViewDisplay = { layout: "TABLE", orderBy: "UPDATED", direction: "DESC", groupBy: "NONE", columns: ["title"] };
describe("saved configuration reference validation and current command rights", () => {
  it("validates real type, responsible and plan references without expanding patient access", async () => {
    const c = hospitalOperationFixture(); const vet = c.user("user-vet");
    const plan = await c.service.createHospitalPlan(vet, { title: "Plano autorizado", objective: "Configuração sintética", patientId: "patient-thor", encounterId: "encounter-thor", departmentCodes: ["INPATIENT"], idempotencyKey: "plan" });
    const filters = { typeId: "hospital-task-type-care", departmentCode: "INPATIENT", responsibleUserId: vet.id, planId: plan.plan.id };
    const saved = await c.service.createPlannerView(vet, { name: "Referências válidas", filters, display, idempotencyKey: "valid" });
    expect(saved.filters).toEqual(filters);
    const before = c.store.getState();
    for (const [key, patch, status] of [["type", { typeId: "missing" }, 400], ["responsible", { responsibleUserId: "missing" }, 404], ["other-sector", { responsibleUserId: "user-lab" }, 404], ["plan", { planId: "missing" }, 404]] as const) {
      await expect(c.service.createPlannerView(vet, { name: key, filters: { ...filters, ...patch }, display, idempotencyKey: key })).rejects.toMatchObject({ status });
    }
    expect(c.store.getState()).toEqual(before);
    await c.store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === vet.id ? { ...user, patientIds: [] } : user) }, result: undefined }));
    await expect(c.service.updatePlannerView(vet, saved.id, { filters, expectedVersion: 1, idempotencyKey: "withdrawn-plan" })).rejects.toMatchObject({ status: 404 });
  });
  it("sorts independent configurations, rejects duplicate names and replays a single accepted revision", async () => {
    const c = hospitalOperationFixture(); const vet = c.user("user-vet");
    const a = await c.service.createPlannerView(vet, { name: "Zulu", filters: {}, display, idempotencyKey: "zulu" });
    await c.service.createPlannerView(vet, { name: "Alpha", filters: {}, display, idempotencyKey: "alpha" });
    expect((await c.service.listPlannerViews(vet)).map((view) => view.name)).toEqual(["Alpha", "Zulu"]);
    await expect(c.service.createPlannerView(vet, { name: "alpha", filters: {}, display, idempotencyKey: "duplicate" })).rejects.toMatchObject({ status: 409 });
    await expect(c.service.updatePlannerView(vet, a.id, { name: "Alpha", expectedVersion: 1, idempotencyKey: "duplicate-edit" })).rejects.toMatchObject({ status: 409 });
    await expect(c.service.updatePlannerView(vet, a.id, { expectedVersion: 1, idempotencyKey: "empty" })).rejects.toMatchObject({ status: 400 });
    await expect(c.service.updatePlannerView(vet, a.id, { display: { ...display, columns: [] }, expectedVersion: 1, idempotencyKey: "invalid" })).rejects.toMatchObject({ status: 400 });
    const input = { name: "Beta", filters: { priority: "URGENT" as const }, display: { ...display, direction: "ASC" as const }, expectedVersion: 1, idempotencyKey: "edit" };
    const changed = await c.service.updatePlannerView(vet, a.id, input);
    expect(await c.service.updatePlannerView(vet, a.id, input)).toEqual(changed);
    expect(c.store.getState().savedPlannerViews.find((view) => view.id === a.id)?.version).toBe(2);
    const off = { expectedVersion: 2, idempotencyKey: "off" };
    expect(await c.service.deactivatePlannerView(vet, a.id, off)).toMatchObject({ active: false, version: 3 });
    expect(await c.service.deactivatePlannerView(vet, a.id, off)).toMatchObject({ active: false, version: 3 });
  });
  it("can explicitly stop sharing a configuration and rejects replay after its update grant is removed", async () => {
    const c = hospitalOperationFixture(); const manager = c.user("user-manager");
    const saved = await c.service.createPlannerView(manager, { name: "Compartilhada", sharedDepartmentCode: "LABORATORY", filters: {}, display, idempotencyKey: "shared" });
    const input = { sharedDepartmentCode: null, expectedVersion: 1, idempotencyKey: "private" };
    expect((await c.service.updatePlannerView(manager, saved.id, input)).sharedDepartmentCode).toBeUndefined();
    expect(await c.service.listPlannerViews(c.user("user-lab"))).toEqual([]);
    await c.store.transaction((state) => ({ state: { ...state, accessGroups: state.accessGroups.map((group) => group.id === manager.accessGroupId ? { ...group, permissions: group.permissions.filter((permission) => permission !== "planner_view.update") } : group) }, result: undefined }));
    await expect(c.service.updatePlannerView(manager, saved.id, input)).rejects.toMatchObject({ status: 404 });
  });
});

describe("planner command options with independent grants", () => {
  it("offers template metadata to technical administration without granting clinical plan creation", async () => {
    const c = hospitalOperationFixture();
    const options = await c.service.listHospitalPlannerOptions(c.user("user-admin"), "checklist_template.manage");
    expect(options.departments.map((department) => department.code)).toEqual(expect.arrayContaining(["INPATIENT", "LABORATORY"]));
    expect(options.staff.map((user) => user.id)).toContain("user-vet");
    expect(JSON.stringify(options)).not.toMatch(/passwordHash|patientIds|email/);
    await expect(c.service.listHospitalPlannerOptions(c.user("user-admin"), "plan.create")).rejects.toMatchObject({ status: 404 });
    await expect(c.service.listHospitalPlannerOptions(c.user("user-vet"), "unexpected" as never)).rejects.toMatchObject({ status: 400 });
  });
});
