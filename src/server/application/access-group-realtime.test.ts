import { afterEach, expect, it, vi } from "vitest";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { createApplicationService } from "./service";
import { authenticateRequest, authorizationSnapshotIsCurrent, getSessionCookieName, loginUser } from "../security/session";
import { createRealtimeResponse } from "../observability/realtime-stream";
import { resetSharedRealtimeStateReaders } from "../observability/realtime-state-reader";
import { rolePermissions } from "../security/authorization";

afterEach(() => { vi.unstubAllEnvs(); resetSharedRealtimeStateReaders(); });
it("an open SSE stream closes before emitting clinical data after the assigned group loses its permissions", async () => {
  vi.stubEnv("REALTIME_STREAM_INTERVAL_MS", "50");
  vi.stubEnv("REALTIME_NOTIFICATION_ADAPTER", "process-local");
  vi.stubEnv("DATABASE_URL", "");
  const store = new MemoryStore(createDemoState("group-stream-test-password"));
  const service = createApplicationService(store);
  const admin = store.getState().users.find((user) => user.role === "ADMIN")!;
  const vet = store.getState().users.find((user) => user.role === "VETERINARIAN")!;
  const group = await service.createAccessGroup(admin, { code: "STREAM_CARE", description: "Equipe com stream", permissions: [...rolePermissions.VETERINARIAN], idempotencyKey: "stream-group" });
  await service.assignUserAccessGroup(admin, vet.id, { accessGroupId: group.id, expectedVersion: vet.version, idempotencyKey: "stream-assign" });
  const login = await loginUser(store, vet.email, "group-stream-test-password");
  const request = new Request("http://localhost/api/v1/realtime/events", { headers: { cookie: `${getSessionCookieName()}=${login.sessionToken}` } });
  const actor = await authenticateRequest(store, request);
  const visible = vi.fn(() => true);
  const response = await createRealtimeResponse(store, actor, "group-stream", undefined, false, request, { isAuthorized: authorizationSnapshotIsCurrent, eventVisible: visible, authorizationError: () => new Error("revoked") });
  const reader = response.body!.getReader();
  try {
    expect((await reader.read()).done).toBe(false);
    await service.updateAccessGroup(admin, group.id, { permissions: [], expectedVersion: 1, idempotencyKey: "stream-revoke" });
    await store.transaction((state) => ({ state: { ...state, outbox: [...state.outbox, { id: "after-revoke", eventType: "DiagnosticRequestCreated", aggregateType: "DiagnosticRequest", aggregateId: "protected-request", payload: { requestId: "protected-request" }, consumerType: "DOMAIN_EVENT", routingKey: "diagnostic.created", status: "PROCESSED", attempts: 1, availableAt: new Date().toISOString(), correlationId: "test-only" }] }, result: undefined }));
    const next = await Promise.race([reader.read(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("stream did not close after revocation")), 2000))]);
    expect(next.done).toBe(true);
    expect(visible).not.toHaveBeenCalled();
  } finally { await reader.cancel(); }
});
