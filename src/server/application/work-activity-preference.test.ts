import { describe, expect, it } from "vitest";
import { hospitalOperationFixture } from "../../test/hospital-operation-fixtures";
import { resolveWorkActivity } from "./work-activity-policy";

describe("private preferences as versioned references, never an access grant", () => {
  it("updates selected fields, clears optional notes/groups and distinguishes favorites, following and recent history", async () => {
    const f = hospitalOperationFixture(); const actor = f.user("user-us"); const a = await f.task("preference-a"); const b = await f.task("preference-b");
    const base = { targetType: "HOSPITAL_TASK" as const, targetId: a.task.id };
    const first = await f.service.putWorkActivityPreference(actor, { ...base, favorite: true, favoriteGroup: "  Plantão  ", following: true, privateNote: "  Nota particular  ", opened: true, expectedVersion: 0, idempotencyKey: "private-first" });
    expect(first.preference).toMatchObject({ favoriteGroup: "Plantão", privateNote: "Nota particular", hiddenFromRecents: false, version: 1 });
    await f.service.putWorkActivityPreference(actor, { targetType: "HOSPITAL_TASK", targetId: b.task.id, privateNote: "Outra nota", expectedVersion: 0, idempotencyKey: "private-second" });
    expect((await f.service.listWorkActivityPreferences(actor, { mode: "FAVORITES" })).items.map((entry) => entry.target.targetId)).toEqual([a.task.id]);
    expect((await f.service.listWorkActivityPreferences(actor, { mode: "FOLLOWING" })).total).toBe(1);
    expect((await f.service.listWorkActivityPreferences(actor, { mode: "NOTES" })).total).toBe(2);
    expect((await f.service.listWorkActivityPreferences(actor, { mode: "RECENTS" })).total).toBe(1);
    const hidden = await f.service.putWorkActivityPreference(actor, { ...base, favorite: false, following: false, privateNote: null, favoriteGroup: null, hiddenFromRecents: true, expectedVersion: 1, idempotencyKey: "private-clear" });
    expect(hidden.preference).toMatchObject({ version: 2, favorite: false, following: false, hiddenFromRecents: true });
    expect(hidden.preference.privateNote).toBeUndefined(); expect(hidden.preference.favoriteGroup).toBeUndefined(); expect(hidden.preference.lastOpenedAt).toBe(first.preference.lastOpenedAt);
    expect((await f.service.listWorkActivityPreferences(actor, { mode: "FAVORITES" })).total).toBe(0);
    expect((await f.service.listWorkActivityPreferences(actor, { mode: "FOLLOWING" })).total).toBe(0);
    expect((await f.service.listWorkActivityPreferences(actor, { mode: "NOTES" })).total).toBe(1);
    expect((await f.service.listWorkActivityPreferences(actor, { mode: "RECENTS" })).total).toBe(0);
    const reopened = await f.service.putWorkActivityPreference(actor, { ...base, opened: true, expectedVersion: 2, idempotencyKey: "private-reopen" });
    expect(reopened.preference.hiddenFromRecents).toBe(false);
    expect((await f.service.listWorkActivityPreferences(actor, { mode: "ALL", targetType: "HOSPITAL_TASK", limit: 1 })).nextCursor).toBeTruthy();
    expect((await f.service.listWorkActivityPreferences(actor, { targetType: "HOSPITAL_TASK", targetId: b.task.id })).items[0].preference.privateNote).toBe("Outra nota");
  });

  it("binds retries to the original payload and returns present metadata without stale overwrites", async () => {
    const f = hospitalOperationFixture(); const actor = f.user("user-us"); const task = await f.task("retry-target"); const input = { targetType: "HOSPITAL_TASK" as const, targetId: task.task.id, favorite: true, expectedVersion: 0, idempotencyKey: "favorite-intent" };
    await f.service.putWorkActivityPreference(actor, input);
    const updated = await f.service.putWorkActivityPreference(actor, { ...input, favorite: false, privateNote: "Atual", expectedVersion: 1, idempotencyKey: "unfavorite-intent" });
    const before = structuredClone(f.store.getState());
    expect(await f.service.putWorkActivityPreference(actor, input)).toEqual(updated);
    await expect(f.service.putWorkActivityPreference(actor, { ...input, favorite: false })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    await expect(f.service.putWorkActivityPreference(actor, { ...input, idempotencyKey: "stale-intent" })).rejects.toMatchObject({ code: "STALE_VERSION" });
    await expect(f.service.putWorkActivityPreference(actor, { targetType: input.targetType, targetId: input.targetId, expectedVersion: 2, idempotencyKey: "empty-intent" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(f.store.getState()).toEqual(before);
  });

  it("rejects a target filter without its type and omits archived or discarded targets without erasing private stored records", async () => {
    const f = hospitalOperationFixture(); const actor = f.user("user-us"); const task = await f.task("archived-target");
    await f.service.putWorkActivityPreference(actor, { targetType: "HOSPITAL_TASK", targetId: task.task.id, favorite: true, expectedVersion: 0, idempotencyKey: "before-archive" });
    await expect(f.service.listWorkActivityPreferences(actor, { targetId: task.task.id })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    for (const field of ["archivedAt", "draftCancelledAt"] as const) {
      await f.store.transaction((state) => ({ state: { ...state, hospitalTasks: state.hospitalTasks.map((entry) => ({ ...entry, archivedAt: undefined, draftCancelledAt: undefined, [field]: new Date().toISOString() })) }, result: undefined }));
      expect((await f.service.listWorkActivityPreferences(actor)).total).toBe(0);
      await expect(f.service.putWorkActivityPreference(actor, { targetType: "HOSPITAL_TASK", targetId: task.task.id, favorite: false, expectedVersion: 1, idempotencyKey: `hidden-${field}` })).rejects.toMatchObject({ status: 404 });
    }
    expect(f.store.getState().workActivityPreferences).toHaveLength(1);
    expect(() => resolveWorkActivity(f.store.getState(), actor, "UNSUPPORTED" as never, task.task.id)).toThrow("Tipo de referência inválido");
  });

  it("keeps another account's saved view unavailable unless shared into a currently authorized sector", async () => {
    const f = hospitalOperationFixture(); const manager = f.user("user-manager"); const actor = f.user("user-us");
    const view = await f.service.createPlannerView(manager, { name: "Visão do gestor", filters: {}, display: { layout: "LIST", orderBy: "UPDATED", direction: "DESC", groupBy: "NONE", columns: ["title"] }, idempotencyKey: "private-view" });
    const input = { targetType: "SAVED_PLANNER_VIEW" as const, targetId: view.id, favorite: true, expectedVersion: 0, idempotencyKey: "favorite-view" };
    await expect(f.service.putWorkActivityPreference(actor, input)).rejects.toMatchObject({ status: 404 });
    await f.service.updatePlannerView(manager, view.id, { sharedDepartmentCode: "ULTRASOUND", expectedVersion: 1, idempotencyKey: "share-view" });
    const saved = await f.service.putWorkActivityPreference(actor, input); expect(saved.target.deepLink).toBe(`/planner?viewId=${view.id}`);
    await f.service.updatePlannerView(manager, view.id, { sharedDepartmentCode: "LABORATORY", expectedVersion: 2, idempotencyKey: "move-shared-view" });
    expect((await f.service.listWorkActivityPreferences(actor, { mode: "FAVORITES" })).total).toBe(0);
    await expect(f.service.putWorkActivityPreference(actor, input)).rejects.toMatchObject({ status: 404 });
    await f.service.deactivatePlannerView(manager, view.id, { expectedVersion: 3, idempotencyKey: "remove-view" });
    expect(() => resolveWorkActivity(f.store.getState(), manager, "SAVED_PLANNER_VIEW", view.id)).toThrow();
  });
});
