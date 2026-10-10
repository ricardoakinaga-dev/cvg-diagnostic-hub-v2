import { afterEach, describe, expect, it, vi } from "vitest";
import type { User } from "../domain/models";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { runCriticalEscalation } from "./critical-escalation";
import type { CriticalResultPolicy } from "./critical-result-policy";
import { createApplicationService } from "./service";

const MINUTE = 60_000;
const policy: CriticalResultPolicy = {
  version: "policy-v1", approvalRef: "approval-test-1", approvedAt: "2026-01-01T00:00:00.000Z", effectiveFrom: "2026-01-01T00:00:00.000Z",
  escalationAfterMs: [15 * MINUTE, 30 * MINUTE, 60 * MINUTE], recipientRules: ["REQUESTER", "ON_CALL", "DEPARTMENT_MANAGER"], requireDistinctRecipients: true
};

function approveCriticalPolicy() {
  vi.stubEnv("CRITICAL_POLICY_ENABLED", "true");
  vi.stubEnv("CRITICAL_POLICY_VERSION", policy.version);
  vi.stubEnv("CRITICAL_POLICY_APPROVAL_REF", policy.approvalRef);
  vi.stubEnv("CRITICAL_POLICY_APPROVED_AT", policy.approvedAt);
}

async function released(options: { critical?: boolean } = {}) {
  const store = new MemoryStore(createDemoState());
  const service = createApplicationService(store);
  const vet = store.getState().users.find((user) => user.id === "user-vet")!;
  const lab = store.getState().users.find((user) => user.id === "user-lab")!;
  const onCall: User = { ...vet, id: "user-vet-on-call", email: "plantao@cvg.local", displayName: "Plantonista", patientIds: [], onCall: true, version: 1 };
  await store.transaction((state) => ({ state: { ...state, users: [...state.users, onCall] }, result: undefined }));
  const request = await service.createRequest(vet, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-crp" }] }, { idempotencyKey: "notice-request" });
  const receivedSample = await service.receiveSample(lab, [request.items[0].id], { sampleType: "EDTA", expectedVersion: request.items[0].version, idempotencyKey: "notice-receive" });
  const started = await service.startProcessing(lab, request.items[0].id, { expectedVersion: receivedSample.items[0].version, idempotencyKey: "notice-start" });
  const draft = await service.createResultDraft(lab, request.items[0].id, { narrative: "PCR elevada.", content: {}, conclusion: "Avaliar", expectedVersion: started.item.version, idempotencyKey: "notice-draft" });
  const release = await service.releaseResult(lab, draft.result.id, { critical: options.critical === true, expectedVersion: draft.result.version, idempotencyKey: "notice-release" });
  const notificationsOf = (userId: string) => store.getState().notifications.filter((entry) => entry.recipientUserId === userId);
  const amendInput = { reason: "Valor digitado errado.", narrative: "PCR corrigida.", content: {}, conclusion: "Reavaliar", critical: options.critical === true, expectedVersion: release.result.version, idempotencyKey: "notice-amend" };
  const amend = () => service.amendResult(lab, release.result.id, amendInput);
  return { store, service, vet, lab, onCall, release, notificationsOf, amend };
}

describe("result correction notices (auditoria de 10/10/2026, D-055)", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("notifies the requester at the moment of the amendment, not only at the next release", async () => {
    const { store, vet, release, notificationsOf, amend } = await released();
    const before = store.getState().notifications.length;
    const amended = await amend();

    expect(store.getState().notifications.length).toBe(before + 1);
    const notice = notificationsOf(vet.id).at(-1)!;
    expect(notice).toMatchObject({
      category: "ACTIONABLE", priority: "HIGH", entityType: "RESULT_VERSION", entityId: release.version.id, deepLink: `/results/${release.result.id}`,
      title: "Resultado em retificação", state: "PENDING", dedupeKey: `amend:${release.version.id}:${vet.id}`
    });
    expect(notice.body).toContain(`versão ${release.version.sequence} substituída`);
    const intents = store.getState().outbox.filter((entry) => entry.eventType === "ResultAmended");
    expect(intents).toHaveLength(2);
    expect(intents.find((entry) => entry.aggregateType === "Result")).toMatchObject({ consumerType: "DOMAIN_EVENT", routingKey: "domain.ResultAmended" });
    expect(intents.find((entry) => entry.aggregateType === "Notification")).toMatchObject({
      consumerType: "NOTIFICATION_DELIVERY", routingKey: "notification.in_app", aggregateType: "Notification", aggregateId: notice.id,
      payload: { notificationId: notice.id, recipientUserId: vet.id, resultId: release.result.id, versionId: amended.version.id, supersedesId: release.version.id }
    });
    expect(store.getState().auditEvents.at(-1)).toMatchObject({ eventType: "ResultAmended", entityId: amended.version.id });
  });

  it("replaying the amendment does not notify anyone twice", async () => {
    const { store, vet, release, amend } = await released();
    // A notice that already exists for the same version and recipient is kept, with no second delivery intent.
    await store.transaction((state) => ({
      state: { ...state, notifications: [...state.notifications, { ...state.notifications[0], id: "notification-earlier-notice", recipientUserId: vet.id, dedupeKey: `amend:${release.version.id}:${vet.id}` }] },
      result: undefined
    }));
    const outboxBefore = store.getState().outbox.length;
    await amend();
    expect(store.getState().outbox.filter((entry) => entry.aggregateType === "Notification")).toHaveLength(0);
    expect(store.getState().outbox.length).toBe(outboxBefore + 1);
    const after = store.getState().notifications.length;
    const outbox = store.getState().outbox.length;
    await amend();
    expect(store.getState().notifications.length).toBe(after);
    expect(store.getState().outbox.length).toBe(outbox);
  });

  it("reaches everyone who received the earlier version, including escalated on-call staff, and marks the correction on release", async () => {
    approveCriticalPolicy();
    const { store, service, vet, lab, onCall, release, notificationsOf, amend } = await released({ critical: true });
    const root = notificationsOf(vet.id).find((entry) => entry.category === "CRITICAL")!;
    const at = (minutes: number) => new Date(Date.parse(root.createdAt) + minutes * MINUTE);
    expect(await runCriticalEscalation(store, { policy, now: at(16) })).toEqual({ due: 1, notified: 1 });
    expect(notificationsOf(onCall.id)).toHaveLength(1);

    const amended = await amend();
    expect(store.getState().notifications.filter((entry) => entry.category === "CRITICAL").every((entry) => entry.state === "SUPERSEDED")).toBe(true);
    const vetNotice = notificationsOf(vet.id).at(-1)!;
    const onCallNotice = notificationsOf(onCall.id).at(-1)!;
    for (const notice of [vetNotice, onCallNotice]) {
      expect(notice).toMatchObject({ category: "ACTIONABLE", priority: "URGENT", title: "Resultado em retificação", entityId: release.version.id });
    }
    expect(onCallNotice.dedupeKey).toBe(`amend:${release.version.id}:${onCall.id}`);
    // The lab technician who amended never received the result and is not told about their own correction.
    expect(notificationsOf(lab.id)).toHaveLength(0);

    const corrected = await service.releaseResult(lab, release.result.id, { critical: true, expectedVersion: amended.result.version, idempotencyKey: "notice-release-2" });
    expect(corrected.version.supersedesId).toBe(release.version.id);
    expect(notificationsOf(vet.id).at(-1)).toMatchObject({ category: "CRITICAL", priority: "URGENT", title: "Resultado crítico retificado requer confirmação", entityId: corrected.version.id, state: "PENDING" });
    expect(notificationsOf(onCall.id).at(-1)).toMatchObject({ category: "ACTIONABLE", priority: "HIGH", title: "Resultado retificado", entityId: corrected.version.id, dedupeKey: `release:${corrected.version.id}:${onCall.id}` });
    expect(notificationsOf(vet.id).at(-1)!.body).toContain(`versão ${corrected.version.sequence} retificada e liberada`);
    const releaseIntents = store.getState().outbox.filter((entry) => entry.eventType === "ResultReleased" && entry.payload.versionId === corrected.version.id);
    expect(releaseIntents.map((entry) => [entry.aggregateType, entry.routingKey]).sort()).toEqual([["Notification", "notification.in_app"], ["Result", "notification.in_app"]]);
    expect(releaseIntents.find((entry) => entry.aggregateType === "Notification")!.payload).toMatchObject({ notificationId: notificationsOf(onCall.id).at(-1)!.id, supersedesId: release.version.id, critical: true });
    // Only the requester's notification is a root of the critical ladder: the on-call notice does not climb on its own.
    expect(store.getState().notifications.filter((entry) => entry.category === "CRITICAL" && entry.entityId === corrected.version.id && entry.escalationOf === undefined)).toHaveLength(1);
  });

  it("titles a non-critical correction as such for the requester", async () => {
    const { store, service, vet, lab, release, notificationsOf, amend } = await released();
    const amended = await amend();
    await service.releaseResult(lab, release.result.id, { expectedVersion: amended.result.version, idempotencyKey: "notice-release-plain" });
    const notice = notificationsOf(vet.id).at(-1)!;
    expect(notice).toMatchObject({ category: "ACTIONABLE", priority: "HIGH", title: "Resultado retificado" });
    // Nobody but the requester had the earlier version: the release carries a single delivery intent.
    expect(store.getState().outbox.filter((entry) => entry.eventType === "ResultReleased" && entry.aggregateType === "Notification")).toHaveLength(0);
  });

  it("tells earlier recipients about an invalidation and skips deactivated accounts", async () => {
    approveCriticalPolicy();
    const { store, service, vet, lab, onCall, release, notificationsOf } = await released({ critical: true });
    const root = notificationsOf(vet.id).find((entry) => entry.category === "CRITICAL")!;
    await runCriticalEscalation(store, { policy, now: new Date(Date.parse(root.createdAt) + 16 * MINUTE) });
    const manager: User = { ...store.getState().users.find((user) => user.id === "user-manager")!, managedDepartmentCodes: ["INPATIENT", "LABORATORY"] };
    await store.transaction((state) => ({
      state: { ...state, users: state.users.map((user) => user.id === manager.id ? manager : user), notifications: [...state.notifications, { ...notificationsOf(onCall.id)[0], id: "notification-manager-seen", recipientUserId: manager.id, dedupeKey: "escalation:manual:manager" }] },
      result: undefined
    }));
    await store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === onCall.id ? { ...user, active: false, version: user.version + 1 } : user) }, result: undefined }));

    const current = store.getState().results.find((entry) => entry.id === release.result.id)!;
    await service.voidResult(lab, release.result.id, { reason: "Amostra trocada.", expectedVersion: current.version, idempotencyKey: "notice-void" });
    expect(notificationsOf(vet.id).at(-1)).toMatchObject({ title: "Resultado invalidado", dedupeKey: `void:${release.version.id}:${vet.id}` });
    expect(notificationsOf(manager.id).at(-1)).toMatchObject({ title: "Resultado invalidado", category: "ACTIONABLE", priority: "HIGH", entityId: release.version.id, dedupeKey: `void:${release.version.id}:${manager.id}` });
    expect(notificationsOf(onCall.id).filter((entry) => entry.title === "Resultado invalidado")).toHaveLength(0);
    const voidIntents = store.getState().outbox.filter((entry) => entry.eventType === "ResultVoided");
    expect(voidIntents).toHaveLength(2);
    expect(voidIntents.find((entry) => entry.aggregateType === "Notification")).toMatchObject({ routingKey: "notification.in_app", payload: { recipientUserId: manager.id, versionId: release.version.id } });
  });
});
