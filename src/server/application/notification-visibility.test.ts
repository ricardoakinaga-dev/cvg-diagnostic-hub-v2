import { afterEach, describe, expect, it, vi } from "vitest";
import type { Notification, User } from "../domain/models";
import { InProcessEventBus, processOutboxBatch } from "../operations/outbox";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { canViewNotification } from "./notification-visibility";
import { createApplicationService } from "./service";

async function releasedResult(critical = false) {
  if (critical) {
    vi.stubEnv("CRITICAL_POLICY_ENABLED", "true");
    vi.stubEnv("CRITICAL_POLICY_VERSION", "policy-v1");
    vi.stubEnv("CRITICAL_POLICY_APPROVAL_REF", "approval-test-1");
    vi.stubEnv("CRITICAL_POLICY_APPROVED_AT", "2026-01-01T00:00:00.000Z");
  }
  const store = new MemoryStore(createDemoState());
  const service = createApplicationService(store);
  const user = (id: string) => store.getState().users.find((entry) => entry.id === id)!;
  const vet = user("user-vet");
  const lab = user("user-lab");
  const request = await service.createRequest(vet, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-crp" }] }, { idempotencyKey: "vis-request" });
  const received = await service.receiveSample(lab, [request.items[0].id], { sampleType: "EDTA", expectedVersion: request.items[0].version, idempotencyKey: "vis-receive" });
  const started = await service.startProcessing(lab, request.items[0].id, { expectedVersion: received.items[0].version, idempotencyKey: "vis-start" });
  const draft = await service.createResultDraft(lab, request.items[0].id, { narrative: "Proteína C reativa elevada.", content: {}, conclusion: "Avaliar", expectedVersion: started.item.version, idempotencyKey: "vis-draft" });
  const released = await service.releaseResult(lab, draft.result.id, { critical, expectedVersion: draft.result.version, idempotencyKey: "vis-release" });
  await processOutboxBatch(store, new InProcessEventBus(), { batchSize: 50, allowSyntheticDelivery: true });
  const notification = store.getState().notifications.find((entry) => entry.recipientUserId === vet.id && entry.entityId === released.version.id)!;
  const setPatients = (patientIds: string[]) => store.transaction((state) => ({
    state: { ...state, users: state.users.map((entry) => entry.id === vet.id ? { ...entry, patientIds, version: entry.version + 1 } : entry) },
    result: undefined
  }));
  return { store, service, user, request, released, notification, setPatients };
}

describe("notifications follow the recipient's current access", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("stops listing a result notification once the recipient can no longer open the result, and lists it again when access returns", async () => {
    const c = await releasedResult();
    expect(c.notification).toMatchObject({ state: "DELIVERED", category: "ACTIONABLE", body: expect.stringContaining("Thor") });
    await expect(c.service.listNotifications(c.user("user-vet"))).resolves.toMatchObject({ items: [expect.objectContaining({ id: c.notification.id })], total: 1 });

    // The auditor's probe: the result is now denied, so the old notification must not keep showing the patient.
    await c.setPatients([]);
    const narrowed = c.user("user-vet");
    await expect(c.service.getResult(narrowed, c.released.result.id)).rejects.toMatchObject({ status: 404, code: "SCOPE_DENIED" });
    for (const filter of ["ALL", "UNREAD", "ACTIONABLE"] as const) {
      await expect(c.service.listNotifications(narrowed, filter)).resolves.toMatchObject({ items: [], total: 0 });
    }
    const before = c.store.getState();
    await expect(c.service.acknowledgeNotification(narrowed, c.notification.id, { expectedVersion: c.notification.version, reason: "Sem acesso.", confirm: true, idempotencyKey: "vis-ack-denied" })).rejects.toMatchObject({ status: 404, code: "SCOPE_DENIED" });
    expect(c.store.getState()).toEqual(before);

    await c.setPatients(["patient-thor"]);
    const restored = c.user("user-vet");
    await expect(c.service.listNotifications(restored, "UNREAD")).resolves.toMatchObject({ items: [expect.objectContaining({ id: c.notification.id })], total: 1 });
    await expect(c.service.acknowledgeNotification(restored, c.notification.id, { expectedVersion: c.notification.version, reason: "Lido.", confirm: true, idempotencyKey: "vis-ack" })).resolves.toMatchObject({ state: "ACKNOWLEDGED" });
  });

  it("leaves a critical result the recipient can no longer open out of the dashboard count", async () => {
    const c = await releasedResult(true);
    expect(c.notification.category).toBe("CRITICAL");
    const critical = async () => (await c.service.dashboard(c.user("user-vet"))).indicators.find((indicator) => indicator.key === "critical");
    await expect(critical()).resolves.toMatchObject({ count: 1, denominator: 1 });
    await c.setPatients([]);
    await expect(critical()).resolves.toMatchObject({ count: 0, denominator: 0 });
  });

  it("resolves request, item and sample notifications through the request, and hides any whose target is gone", async () => {
    const c = await releasedResult();
    const state = c.store.getState();
    const vet = c.user("user-vet");
    const outsider: User = { ...vet, patientIds: ["patient-mel"] };
    const sampleId = state.samples.find((sample) => sample.requestId === c.request.id)!.id;
    const pointing = (entityType: Notification["entityType"], entityId: string): Notification => ({ ...c.notification, entityType, entityId });
    for (const [entityType, entityId] of [["REQUEST", c.request.id], ["ITEM", c.request.items[0].id], ["SAMPLE", sampleId]] as const) {
      expect(canViewNotification(state, vet, pointing(entityType, entityId))).toBe(true);
      expect(canViewNotification(state, outsider, pointing(entityType, entityId))).toBe(false);
      expect(canViewNotification(state, vet, pointing(entityType, "missing"))).toBe(false);
    }
    expect(canViewNotification(state, vet, pointing("RESULT_VERSION", "missing"))).toBe(false);
    // Operational notices carry no patient data and reach people outside the clinical scope, such as ADMIN.
    const admin = c.user("user-admin");
    expect(canViewNotification(state, admin, pointing("REQUEST", c.request.id))).toBe(false);
    expect(canViewNotification(state, admin, { ...pointing("REQUEST", c.request.id), category: "ADMINISTRATIVE" })).toBe(true);
    // A manager reaches a request notification through the departments they manage.
    const manager = c.user("user-manager");
    expect(canViewNotification(state, { ...manager, managedDepartmentCodes: ["INPATIENT", "LABORATORY"] }, pointing("REQUEST", c.request.id))).toBe(true);
    expect(canViewNotification(state, { ...manager, departmentCode: "IMAGING", managedDepartmentCodes: ["IMAGING"] }, pointing("REQUEST", c.request.id))).toBe(false);
  });
});
