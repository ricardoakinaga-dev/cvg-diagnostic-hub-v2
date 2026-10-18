import { describe, expect, it } from "vitest";
import { hospitalOperationFixture } from "@/test/hospital-operation-fixtures";
import { PLANNER_DEFAULT_DISPLAY } from "@/components/planner-model";

async function fixture() {
  const c = hospitalOperationFixture(); const request = await c.service.createRequest(c.user("user-vet"), { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-crp" }], overrideReason: "Teste sintético dos filtros; sem atendimento real." }, { allowDuplicateOverride: true, idempotencyKey: "diagnostic-view-request" });
  const item = request.items[0]; await c.service.assignDiagnosticItem(c.user("user-lab"), item.id, { userId: "user-lab", expectedVersion: item.version, idempotencyKey: "diagnostic-view-assignment" });
  return { ...c, item };
}
describe("saved view metadata preserves the authority of diagnostic filters", () => {
  it("lets a normal veterinarian save a configuration for an authorized diagnostic department and its assigned professional", async () => {
    const c = await fixture(); const input = { name: "Exames do profissional atribuído", filters: { departmentCode: "LABORATORY", responsibleUserId: "user-lab" }, display: PLANNER_DEFAULT_DISPLAY, idempotencyKey: "diagnostic-context-view" };
    const view = await c.service.createPlannerView(c.user("user-vet"), input);
    expect(view.filters).toEqual(input.filters); expect(view.ownerId).toBe("user-vet");
    expect((await c.service.searchPlanner(c.user("user-vet"), c.item.id, { ...view.filters, types: ["DIAGNOSTIC_ITEM"] })).items.map(row => row.id)).toEqual([c.item.id]);
    await c.service.updatePlannerView(c.user("user-vet"), view.id, { filters: input.filters, expectedVersion: view.version, idempotencyKey: "diagnostic-context-view-update" });
    expect((await c.service.listPlannerViews(c.user("user-lab"))).map(row => row.id)).not.toContain(view.id);
    const shared = await c.service.createPlannerView(c.user("user-manager"), { ...input, name: "Configuração compartilhada autorizada", sharedDepartmentCode: "INPATIENT", idempotencyKey: "shared-diagnostic-context-view" });
    expect((await c.service.listPlannerViews(c.user("user-vet"))).map(row => row.id)).toContain(shared.id);
  });
  it("does not expose an unrelated professional, another sector or revoked native grants through a saved filter", async () => {
    const c = await fixture(); const actor = c.user("user-vet"); const base = { name: "Filtro sem autorização", filters: { departmentCode: "RESTRICTED", responsibleUserId: "user-admin" }, display: PLANNER_DEFAULT_DISPLAY };
    await expect(c.service.createPlannerView(actor, { ...base, idempotencyKey: "unrelated-diagnostic-filter" })).rejects.toMatchObject({ status: 404 });
    await expect(c.service.createPlannerView(actor, { ...base, filters: { departmentCode: "LABORATORY", responsibleUserId: "user-admin" }, idempotencyKey: "unrelated-diagnostic-person" })).rejects.toMatchObject({ status: 404 });
    const group = c.store.getState().accessGroups.find(entry => entry.id === actor.accessGroupId)!;
    await c.store.transaction(state => ({ state: { ...state, accessGroups: state.accessGroups.map(entry => entry.id === group.id ? { ...entry, permissions: entry.permissions.filter(permission => permission !== "item.view") } : entry) }, result: undefined }));
    await expect(c.service.createPlannerView(actor, { ...base, filters: { departmentCode: "LABORATORY", responsibleUserId: "user-lab" }, idempotencyKey: "revoked-diagnostic-filter" })).rejects.toMatchObject({ status: 404 });
    expect(await c.service.listPlannerViews(actor)).toEqual([]);
  });
});
