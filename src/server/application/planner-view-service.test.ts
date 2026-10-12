import { describe, expect, it } from "vitest";
import type { PlannerViewDisplay } from "@cvg/contracts";
import { createApplicationService } from "./service";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";

const display: PlannerViewDisplay = { layout: "BOARD", orderBy: "PRIORITY", direction: "DESC", groupBy: "PHASE", columns: ["title", "priority", "phase"] };
function setup() {
  const state = createDemoState("planner-views-test-password");
  const vet = state.users.find((user) => user.role === "VETERINARIAN")!;
  state.users.push({ ...vet, id: "view-reader", email: "view-reader@cvg.local", role: "VIEWER", accessGroupId: "access-group-viewer" });
  const store = new MemoryStore(state);
  return { store, service: createApplicationService(store), user: (role: string) => store.getState().users.find((user) => user.role === role)! };
}
describe("saved planner configurations with independent scope", () => {
  it("persists a private view for a normal user without sharing it", async () => {
    const { service, user } = setup();
    const viewer = user("VIEWER");
    const input = { name: "Minhas pendências", filters: { departmentCode: "INPATIENT" }, display, idempotencyKey: "save-private" };
    const saved = await service.createPlannerView(viewer, input);
    expect(saved).toMatchObject({ ownerId: viewer.id, version: 1, filters: input.filters, display });
    expect(await service.createPlannerView(viewer, input)).toEqual(saved);
    expect(await service.listPlannerViews(viewer)).toEqual([saved]);
    expect(await service.listPlannerViews(user("VETERINARIAN"))).toEqual([]);
  });
  it("shares configuration with a delegated sector without sharing clinical data or write ownership", async () => {
    const { store, service, user } = setup();
    const manager = user("MANAGER");
    const before = structuredClone(store.getState().users);
    const saved = await service.createPlannerView(manager, { name: "Laboratório do plantão", sharedDepartmentCode: "LABORATORY", filters: { departmentCode: "LABORATORY" }, display, idempotencyKey: "share-lab" });
    expect(await service.listPlannerViews(user("LAB_TECH"))).toEqual([saved]);
    expect(await service.listPlannerViews(user("RADIOLOGY_TEAM"))).toEqual([]);
    expect(await service.listPlannerViews(user("VETERINARIAN"))).toEqual([]);
    await expect(service.updatePlannerView(user("LAB_TECH"), saved.id, { name: "Outro título", expectedVersion: 1, idempotencyKey: "edit-other" })).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    expect(store.getState().users).toEqual(before);
    expect(await service.listHospitalTasks(user("LAB_TECH"))).toMatchObject({ items: [], total: 0 });
  });
  it("rejects out of scope sharing, spoofed ownership and invalid dates", async () => {
    const { store, service, user } = setup();
    const before = structuredClone(store.getState());
    await expect(service.createPlannerView(user("VETERINARIAN"), { name: "Compartilhada", sharedDepartmentCode: "INPATIENT", filters: {}, display, idempotencyKey: "vet-share" })).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    await expect(service.createPlannerView(user("MANAGER"), { name: "Setor não delegado", sharedDepartmentCode: "IT", filters: {}, display, idempotencyKey: "manager-share" })).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    await expect(service.createPlannerView(user("VIEWER"), { name: "Datas inválidas", filters: { from: "2026-10-12T00:00:00Z", to: "2026-10-11T00:00:00Z" }, display, idempotencyKey: "invalid-filter" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(service.createPlannerView(user("VIEWER"), { name: "Dono indevido", ownerId: user("MANAGER").id, filters: {}, display, idempotencyKey: "spoof-owner" } as never)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(store.getState()).toEqual(before);
  });
  it("keeps shared matrices current and rejects concurrent edits without persisting command metadata", async () => {
    const { store, service, user } = setup();
    const manager = user("MANAGER");
    const saved = await service.createPlannerView(manager, { name: "Equipe", sharedDepartmentCode: "LABORATORY", filters: {}, display, idempotencyKey: "team-view" });
    const result = await Promise.allSettled(["Um", "Dois"].map((name) => service.updatePlannerView(manager, saved.id, { name, expectedVersion: 1, idempotencyKey: `update-${name}` })));
    expect(result.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(result.find((entry) => entry.status === "rejected")).toMatchObject({ reason: { code: "STALE_VERSION" } });
    expect(store.getState().savedPlannerViews[0]).not.toHaveProperty("expectedVersion");
    const lab = user("LAB_TECH");
    await store.transaction((state) => ({ state: { ...state, accessGroups: state.accessGroups.map((group) => group.id === lab.accessGroupId ? { ...group, permissions: group.permissions.filter((permission) => permission !== "planner_view.view") } : group) }, result: undefined }));
    await expect(service.listPlannerViews(lab)).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    const deactivated = await service.deactivatePlannerView(manager, saved.id, { expectedVersion: 2, idempotencyKey: "deactivate-view" });
    expect(deactivated.active).toBe(false);
    expect(await service.listPlannerViews(manager)).toEqual([]);
  });
});
