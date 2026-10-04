import { describe, expect, it } from "vitest";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { listClinicalReasons } from "./clinical-reasons";

describe("clinical reason choices", () => {
  it("provides active clinical labels without granting catalog management", async () => {
    const state = createDemoState();
    state.reasonCodes.push({ id: "inactive-reason", type: "RECOLLECTION", code: "INACTIVE", label: "Desativado", active: false, version: 1 });
    const actor = state.users.find((user) => user.role === "LAB_TECH")!;
    const reasons = await listClinicalReasons(new MemoryStore(state), actor);
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.every((reason) => reason.active)).toBe(true);
    expect(reasons).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: "inactive-reason" })]));
    expect(reasons[0]).toHaveProperty("label");
  });
  it("does not give an observer or technical administrator clinical mutation choices", async () => {
    const state = createDemoState();
    const store = new MemoryStore(state);
    for (const role of ["VIEWER", "ADMIN"] as const) {
      const actor = { ...state.users.find((user) => user.role === "ADMIN")!, role };
      const scoped = new MemoryStore({ ...state, users: state.users.map((user) => user.id === actor.id ? actor : user) });
      expect(await listClinicalReasons(scoped, actor)).toEqual([]);
    }
    const stale = state.users.find((user) => user.role === "LAB_TECH")!;
    await store.transaction((current) => ({ state: { ...current, users: current.users.map((user) => user.id === stale.id ? { ...user, version: user.version + 1 } : user) }, result: undefined }));
    await expect(listClinicalReasons(store, stale)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
});
