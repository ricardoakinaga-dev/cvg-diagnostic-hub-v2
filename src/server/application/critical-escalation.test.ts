import { afterEach, describe, expect, it, vi } from "vitest";
import type { User } from "../domain/models";
import { CRITICAL_ALERT_WHATSAPP_EVENT } from "../domain/models";
import { InProcessEventBus, processOutboxBatch } from "../operations/outbox";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { updateOwnAlertContact } from "./alert-contact";
import { runCriticalEscalation } from "./critical-escalation";
import type { CriticalResultPolicy } from "./critical-result-policy";
import { createApplicationService } from "./service";

const MINUTE = 60_000;
const policy: CriticalResultPolicy = {
  version: "policy-v1", approvalRef: "approval-test-1", approvedAt: "2026-01-01T00:00:00.000Z", effectiveFrom: "2026-01-01T00:00:00.000Z",
  escalationAfterMs: [15 * MINUTE, 30 * MINUTE, 60 * MINUTE], recipientRules: ["REQUESTER", "ON_CALL", "DEPARTMENT_MANAGER"], requireDistinctRecipients: true
};

function approveRelease() {
  vi.stubEnv("CRITICAL_POLICY_ENABLED", "true");
  vi.stubEnv("CRITICAL_POLICY_VERSION", policy.version);
  vi.stubEnv("CRITICAL_POLICY_APPROVAL_REF", policy.approvalRef);
  vi.stubEnv("CRITICAL_POLICY_APPROVED_AT", policy.approvedAt);
}

async function releasedCritical() {
  approveRelease();
  const store = new MemoryStore(createDemoState());
  const service = createApplicationService(store);
  const vet = store.getState().users.find((user) => user.id === "user-vet")!;
  const lab = store.getState().users.find((user) => user.id === "user-lab")!;
  const onCall: User = { ...vet, id: "user-vet-on-call", email: "plantao@cvg.local", displayName: "Plantonista", patientIds: [], onCall: true, version: 1 };
  await store.transaction((state) => ({
    state: { ...state, users: [...state.users.map((user) => user.id === "user-manager" ? { ...user, managedDepartmentCodes: ["INPATIENT", "LABORATORY"] } : user), onCall] },
    result: undefined
  }));
  const request = await service.createRequest(vet, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-crp" }] }, { idempotencyKey: "esc-request" });
  const received = await service.receiveSample(lab, [request.items[0].id], { sampleType: "EDTA", expectedVersion: request.items[0].version, idempotencyKey: "esc-receive" });
  const started = await service.startProcessing(lab, request.items[0].id, { expectedVersion: received.items[0].version, idempotencyKey: "esc-start" });
  const draft = await service.createResultDraft(lab, request.items[0].id, { narrative: "Potássio muito alto.", content: {}, conclusion: "Avaliar", expectedVersion: started.item.version, idempotencyKey: "esc-draft" });
  const released = await service.releaseResult(lab, draft.result.id, { critical: true, expectedVersion: draft.result.version, idempotencyKey: "esc-release" });
  const root = store.getState().notifications.find((entry) => entry.category === "CRITICAL" && entry.entityId === released.version.id)!;
  const at = (minutes: number) => new Date(Date.parse(root.createdAt) + minutes * MINUTE);
  const notificationsOf = (userId: string) => store.getState().notifications.filter((entry) => entry.recipientUserId === userId && entry.category === "CRITICAL");
  return { store, service, root, released, at, notificationsOf, onCall };
}

describe("critical result escalation (PROD-402)", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("climbs the ladder at each threshold and stops when nobody is left", async () => {
    const { store, root, at, notificationsOf } = await releasedCritical();
    const read = vi.spyOn(store, "readState");
    const transaction = vi.spyOn(store, "transaction");

    expect(await runCriticalEscalation(store, { policy, now: at(14) })).toEqual({ due: 0, notified: 0, unreachable: 0 });
    expect(read).toHaveBeenCalledTimes(1);
    expect(transaction).not.toHaveBeenCalled();

    expect(await runCriticalEscalation(store, { policy, now: at(16) })).toEqual({ due: 1, notified: 1, unreachable: 0 });
    const [escalated] = notificationsOf("user-vet-on-call");
    expect(escalated).toMatchObject({ escalationOf: root.id, entityId: root.entityId, deepLink: root.deepLink, priority: "URGENT", state: "PENDING", title: "Resultado crítico sem confirmação" });
    expect(store.getState().users.find((user) => user.id === "user-vet-on-call")!.patientIds).toContain("patient-thor");
    expect(store.getState().notifications.find((entry) => entry.id === root.id)).toMatchObject({ version: root.version, escalation: { level: 1, lastEscalatedAt: at(16).toISOString() } });
    expect(store.getState().outbox.at(-1)).toMatchObject({ eventType: "CriticalResultEscalated", routingKey: "notification.in_app", payload: { notificationId: escalated.id, escalationOf: root.id, level: 1 } });
    expect(store.getState().auditEvents.filter((event) => event.eventType === "CriticalResultEscalated").at(-1)).toMatchObject({ entityId: root.id, previousState: "0", newState: "1", metadata: { rule: "ON_CALL", recipients: "1" } });
    expect(store.getState().auditEvents).toContainEqual(expect.objectContaining({ eventType: "CriticalEscalationPatientAccessGranted", entityId: "user-vet-on-call", metadata: { notificationId: root.id, patientId: "patient-thor" } }));

    expect(await runCriticalEscalation(store, { policy, now: at(20) })).toEqual({ due: 0, notified: 0, unreachable: 0 });
    expect(await runCriticalEscalation(store, { policy, now: at(31) })).toEqual({ due: 1, notified: 1, unreachable: 0 });
    expect(notificationsOf("user-manager")).toHaveLength(1);
    expect(store.getState().users.find((user) => user.id === "user-manager")!.patientIds ?? []).not.toContain("patient-thor");

    expect(await runCriticalEscalation(store, { policy, now: at(61) })).toEqual({ due: 1, notified: 0, unreachable: 1 });
    expect(store.getState().auditEvents.filter((event) => event.eventType === "CriticalResultEscalated").at(-1)).toMatchObject({ newState: "3", metadata: { rule: "NONE", recipients: "0" } });
    // D-056: the exhausted ladder is an operational alert to the administrators, without patient or result.
    const alert = store.getState().notifications.find((entry) => entry.recipientUserId === "user-admin")!;
    expect(alert).toMatchObject({ category: "ADMINISTRATIVE", priority: "URGENT", entityType: "REQUEST", deepLink: "/system", title: "Crítico sem confirmação e sem destinatário", dedupeKey: `critical-unreachable:${root.id}:user-admin` });
    expect(alert.body).toContain("setor INPATIENT");
    expect(alert.body).not.toMatch(/Thor|Potássio/);
    expect(store.getState().outbox.at(-1)).toMatchObject({ eventType: "CriticalResultUnreachable", routingKey: "notification.in_app", aggregateType: "Notification", payload: { notificationId: alert.id, escalationOf: root.id, level: 3 } });
    expect(store.getState().auditEvents.at(-1)).toMatchObject({ eventType: "CriticalResultUnreachable", entityId: root.id, metadata: { level: 3, departmentCode: "INPATIENT" } });
    expect(store.getState().notifications.find((entry) => entry.id === root.id)!.escalation).toEqual({ level: 3, lastEscalatedAt: at(61).toISOString(), unreachableAt: at(61).toISOString() });
    expect(await runCriticalEscalation(store, { policy, now: at(240) })).toEqual({ due: 0, notified: 0, unreachable: 0 });
    expect(store.getState().notifications.filter((entry) => entry.recipientUserId === "user-admin")).toHaveLength(1);
  });

  it("catches up one level per cycle when the first run comes after several thresholds (AUD-01)", async () => {
    const { store, root, at, notificationsOf } = await releasedCritical();
    expect(await runCriticalEscalation(store, { policy, now: at(40) })).toEqual({ due: 1, notified: 1, unreachable: 0 });
    expect(notificationsOf("user-vet-on-call")).toHaveLength(1);
    // The next cycle owes the 30-minute level: it is not blocked by the late run time of the first one.
    expect(await runCriticalEscalation(store, { policy, now: at(40) })).toEqual({ due: 1, notified: 1, unreachable: 0 });
    expect(notificationsOf("user-manager")).toHaveLength(1);
    expect(await runCriticalEscalation(store, { policy, now: at(41) })).toEqual({ due: 0, notified: 0, unreachable: 0 });
    expect(await runCriticalEscalation(store, { policy, now: at(61) })).toEqual({ due: 1, notified: 0, unreachable: 1 });
    expect(await runCriticalEscalation(store, { policy, now: at(240) })).toEqual({ due: 0, notified: 0, unreachable: 0 });
    expect(store.getState().notifications.find((entry) => entry.id === root.id)!.escalation!.level).toBe(3);
    expect(notificationsOf("user-vet-on-call")).toHaveLength(1);
    expect(notificationsOf("user-manager")).toHaveLength(1);
  });

  it("skips recipients who could not open the result and refuses a confirmation from them (AUD-02)", async () => {
    const { store, service, at, notificationsOf, onCall, released } = await releasedCritical();
    // An executor on call in the requesting department, without the exam's service, never receives the critical result.
    await store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === onCall.id ? { ...user, role: "RADIOLOGY_TEAM" as const, serviceCodes: [], version: user.version + 1 } : user) }, result: undefined }));
    expect(await runCriticalEscalation(store, { policy, now: at(16) })).toEqual({ due: 1, notified: 1, unreachable: 0 });
    expect(notificationsOf(onCall.id)).toHaveLength(0);
    expect(store.getState().auditEvents.filter((event) => event.eventType === "CriticalResultEscalated").at(-1)).toMatchObject({ metadata: { rule: "DEPARTMENT_MANAGER", recipients: "1" } });
    const manager = store.getState().users.find((user) => user.id === "user-manager")!;
    await expect(service.getResult(manager, released.result.id)).resolves.toMatchObject({ result: { id: released.result.id } });

    // A manager of the requesting department alone cannot open the laboratory result, so the ladder ends instead.
    const second = await releasedCritical();
    await second.store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === "user-manager" ? { ...user, managedDepartmentCodes: ["INPATIENT"] } : user).filter((user) => user.id !== second.onCall.id) }, result: undefined }));
    expect(await runCriticalEscalation(second.store, { policy, now: at(16) })).toEqual({ due: 1, notified: 0, unreachable: 1 });
    expect(second.notificationsOf("user-manager")).toHaveLength(0);
    // The alert repeats at no later level: one notice per root, however many levels find nobody.
    expect(await runCriticalEscalation(second.store, { policy, now: at(31) })).toEqual({ due: 1, notified: 0, unreachable: 0 });
    expect(second.store.getState().notifications.filter((entry) => entry.category === "ADMINISTRATIVE")).toHaveLength(1);
    expect(second.store.getState().notifications.find((entry) => entry.id === second.root.id)!.escalation).toMatchObject({ level: 2, unreachableAt: at(16).toISOString() });
  });

  it("does not let a recipient who lost access to the result stop the climb (AUD-02)", async () => {
    const { store, service, at, notificationsOf, onCall, released } = await releasedCritical();
    await runCriticalEscalation(store, { policy, now: at(16) });
    await processOutboxBatch(store, new InProcessEventBus(), { now: () => at(17), batchSize: 50, allowSyntheticDelivery: true });
    const escalated = notificationsOf(onCall.id)[0];
    // The on-call professional moves to an imaging team after being notified.
    await store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === onCall.id ? { ...user, role: "RADIOLOGY_TEAM" as const, serviceCodes: [], version: user.version + 1 } : user) }, result: undefined }));
    const actor = store.getState().users.find((user) => user.id === onCall.id)!;
    await expect(service.getResult(actor, released.result.id)).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    await expect(service.acknowledgeNotification(actor, escalated.id, { expectedVersion: escalated.version, reason: "Sem abrir o resultado.", confirm: true, idempotencyKey: "blind-ack" })).rejects.toMatchObject({ status: 404, code: "SCOPE_DENIED" });
    expect(store.getState().notifications.find((entry) => entry.id === escalated.id)!.state).not.toBe("ACKNOWLEDGED");
    expect(await runCriticalEscalation(store, { policy, now: at(31) })).toEqual({ due: 1, notified: 1, unreachable: 0 });
    expect(notificationsOf("user-manager")).toHaveLength(1);
  });

  it("stops as soon as any recipient acknowledges the result", async () => {
    const { store, service, at, notificationsOf, onCall } = await releasedCritical();
    await runCriticalEscalation(store, { policy, now: at(16) });
    await processOutboxBatch(store, new InProcessEventBus(), { now: () => at(17), batchSize: 50, allowSyntheticDelivery: true });
    const escalated = notificationsOf(onCall.id)[0];
    const actor = store.getState().users.find((user) => user.id === onCall.id)!;
    const manager = store.getState().users.find((user) => user.id === "user-manager")!;
    // Two notifications (requester and on call) are one pending critical result on the management panel.
    expect((await service.managementOverview(manager)).summary.critical).toBe(1);
    await service.acknowledgeNotification(actor, escalated.id, { expectedVersion: escalated.version, reason: "Plantão assumiu o crítico.", confirm: true, idempotencyKey: "esc-ack" });
    expect((await service.managementOverview(manager)).summary.critical).toBe(0);

    expect(await runCriticalEscalation(store, { policy, now: at(31) })).toEqual({ due: 0, notified: 0, unreachable: 0 });
    expect(notificationsOf("user-manager")).toHaveLength(0);
  });

  it("keeps escalating a notification whose in-app delivery failed and sends the WhatsApp alert to the escalated professional", async () => {
    const { store, root, at, notificationsOf, onCall } = await releasedCritical();
    vi.stubEnv("WHATSAPP_ENABLED", "true");
    await updateOwnAlertContact(store, store.getState().users.find((user) => user.id === onCall.id)!, { whatsappPhone: ["+55", "11", "9", "8765", "4321"].join(""), consent: true }, "corr-contact");
    await store.transaction((state) => ({ state: { ...state, notifications: state.notifications.map((entry) => entry.id === root.id ? { ...entry, state: "FAILED" as const } : entry) }, result: undefined }));

    expect(await runCriticalEscalation(store, { policy, now: at(16), environment: { WHATSAPP_ENABLED: "true" } })).toEqual({ due: 1, notified: 1, unreachable: 0 });
    const escalated = notificationsOf(onCall.id)[0];
    expect(escalated.whatsapp).toMatchObject({ status: "QUEUED" });
    expect(store.getState().outbox.at(-1)).toMatchObject({ eventType: CRITICAL_ALERT_WHATSAPP_EVENT, payload: { notificationId: escalated.id, recipientUserId: onCall.id } });
  });

  it("does nothing without an approved policy and ignores escalated copies as roots", async () => {
    const { store, at } = await releasedCritical();
    expect(await runCriticalEscalation(store, { now: at(16), environment: {} })).toEqual({ due: 0, notified: 0, unreachable: 0 });
    await runCriticalEscalation(store, { policy: { ...policy, recipientRules: ["REQUESTER", "ON_CALL"] }, now: at(16) });
    // The on-call copy is not a root: at the next threshold only the requester's notification is considered.
    expect(await runCriticalEscalation(store, { policy: { ...policy, recipientRules: ["REQUESTER", "ON_CALL"] }, now: at(31) })).toEqual({ due: 1, notified: 0, unreachable: 1 });
  });

  it("reaches a professional on call in another department when the requesting one has nobody on call (D-056)", async () => {
    const { store, at, notificationsOf, onCall } = await releasedCritical();
    await store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === onCall.id ? { ...user, departmentCode: "SURGERY", version: user.version + 1 } : user) }, result: undefined }));
    expect(await runCriticalEscalation(store, { policy, now: at(16) })).toEqual({ due: 1, notified: 1, unreachable: 0 });
    expect(notificationsOf(onCall.id)).toHaveLength(1);
    expect(store.getState().auditEvents.filter((event) => event.eventType === "CriticalResultEscalated").at(-1)).toMatchObject({ metadata: { rule: "ON_CALL", recipients: "1" } });
  });

  it("alerts nobody when there is no active administrator, but still marks the root as unreachable", async () => {
    const { store, root, at } = await releasedCritical();
    await store.transaction((state) => ({ state: { ...state, users: state.users.filter((user) => user.role !== "ADMIN") }, result: undefined }));
    expect(await runCriticalEscalation(store, { policy: { ...policy, recipientRules: ["REQUESTER", "ADMIN_FALLBACK"] }, now: at(16) })).toEqual({ due: 1, notified: 0, unreachable: 1 });
    expect(store.getState().notifications.filter((entry) => entry.category === "ADMINISTRATIVE")).toHaveLength(0);
    expect(store.getState().notifications.find((entry) => entry.id === root.id)!.escalation?.unreachableAt).toBe(at(16).toISOString());
  });

  it("records the level without recipients when the request behind the notification is gone", async () => {
    const { store, root, at } = await releasedCritical();
    await store.transaction((state) => ({ state: { ...state, resultVersions: state.resultVersions.filter((entry) => entry.id !== root.entityId) }, result: undefined }));
    expect(await runCriticalEscalation(store, { policy, now: at(16) })).toEqual({ due: 1, notified: 0, unreachable: 0 });
    expect(store.getState().notifications.find((entry) => entry.id === root.id)!.escalation).toMatchObject({ level: 1 });
  });
});
