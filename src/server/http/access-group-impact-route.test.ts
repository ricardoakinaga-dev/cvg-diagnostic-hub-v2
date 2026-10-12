import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hospitalPlannerHttpFixture } from "@/test/hospital-planner-http-fixture";
import { resetRateLimits } from "../security/rate-limit";

describe.sequential("shared group preview through the protected HTTP route", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime("2026-10-11T12:00:00Z"); process.env.APP_DATA_MODE = "memory"; resetRateLimits(); });
  afterEach(() => { vi.useRealTimers(); delete process.env.APP_DATA_MODE; delete globalThis.__cvgDiagnosticsStore; delete globalThis.__cvgDiagnosticsStorePromise; delete globalThis.__cvgDiagnosticsFileStore; resetRateLimits(); });
  it("preflights without idempotency or writes, rejects missing CSRF/schema errors and saves the exact versioned candidate", async () => {
    const c = await hospitalPlannerHttpFixture();
    const created = await c.send("user-admin", "POST", "access-groups", { code: "HTTP_IMPACT", description: "Equipe", permissions: ["request.list"] });
    expect(created.status).toBe(201); const groupId = created.envelope.data.id;
    await c.store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === "user-vet" || user.id === "vet-b" ? { ...user, accessGroupId: groupId } : user) }, result: undefined }));
    const body = { permissions: ["patient.view"], expectedVersion: 1 };
    expect((await c.send("user-admin", "POST", `access-groups/${groupId}/preview`, body, { "x-csrf-token": null })).status).toBe(403);
    expect((await c.send("user-admin", "POST", `access-groups/${groupId}/preview`, { ...body, expectedVersion: undefined })).status).toBe(400);
    expect((await c.send("user-admin", "POST", `access-groups/${groupId}/preview`, { ...body, clinicalApproval: true })).status).toBe(400);
    const before = c.store.getState();
    const response = await c.send("user-admin", "POST", `access-groups/${groupId}/preview`, body, { "idempotency-key": null });
    expect(response.status).toBe(200); expect(response.envelope.data).toMatchObject({ boundUserCount: 2, affectedUserCount: 2, groupVersion: 1 });
    expect(JSON.stringify(response.envelope.data)).not.toMatch(/patient-thor|patient-mel|passwordHash|sessionToken/);
    expect(c.store.getState()).toEqual(before);
    const saved = await c.send("user-admin", "PATCH", `access-groups/${groupId}`, { ...body, expectedImpactToken: response.envelope.data.impactToken });
    expect(saved.status).toBe(200); expect(saved.envelope.data.permissions).toEqual(["patient.view"]);
    expect((await c.send("user-admin", "POST", `access-groups/${groupId}/preview`, body)).status).toBe(409);
  });
  it("rejects stale bindings and current actor revocation before a previewed candidate can be written", async () => {
    const c = await hospitalPlannerHttpFixture();
    const created = await c.send("user-admin", "POST", "access-groups", { code: "HTTP_STALE", description: "Equipe", permissions: ["request.list"] }); const groupId = created.envelope.data.id;
    const body = { description: "Descrição nova", expectedVersion: 1 };
    const preview = await c.send("user-admin", "POST", `access-groups/${groupId}/preview`, body); expect(preview.status).toBe(200);
    await c.store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === "user-vet" ? { ...user, accessGroupId: groupId } : user) }, result: undefined }));
    const failed = await c.send("user-admin", "PATCH", `access-groups/${groupId}`, { ...body, expectedImpactToken: preview.envelope.data.impactToken }); expect(failed.status).toBe(409);
    const fresh = await c.send("user-admin", "POST", `access-groups/${groupId}/preview`, body); expect(fresh.status).toBe(200);
    await c.store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === "user-admin" ? { ...user, active: false } : user) }, result: undefined }));
    expect((await c.send("user-admin", "PATCH", `access-groups/${groupId}`, { ...body, expectedImpactToken: fresh.envelope.data.impactToken })).status).toBe(401);
    expect(c.store.getState().accessGroups.find((group) => group.id === groupId)).toMatchObject({ version: 1, description: "Equipe" });
  });
});
