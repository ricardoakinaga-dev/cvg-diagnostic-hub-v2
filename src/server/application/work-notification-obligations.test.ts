import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hospitalOperationFixture } from "../../test/hospital-operation-fixtures";
import { InProcessEventBus, processOutboxBatch } from "../operations/outbox";

async function offeredHandoff() {
  const f = hospitalOperationFixture(); const vet = f.user("user-vet");
  await f.store.transaction(state => ({ state: { ...state, users: [...state.users, { ...vet, id: "handoff-recipient", email: "handoff-recipient@example.test" }], departments: state.departments.map(department => department.code === "INPATIENT" ? { ...department, memberUserIds: [...department.memberUserIds, "handoff-recipient"] } : department) }, result: undefined }));
  const from = await f.service.createHospitalShift(f.user("user-manager"), { name: "Synthetic departing shift", departmentCode: "INPATIENT", startAt: "2026-10-11T06:00:00Z", endAt: "2026-10-11T12:00:00Z", members: [{ userId: vet.id }], idempotencyKey: "obligation-from" });
  const to = await f.service.createHospitalShift(f.user("user-manager"), { name: "Synthetic receiving shift", departmentCode: "INPATIENT", startAt: "2026-10-11T12:00:00Z", endAt: "2026-10-11T18:00:00Z", members: [{ userId: "handoff-recipient" }], idempotencyKey: "obligation-to" });
  const task = await f.service.createHospitalTask(vet, { title: "Synthetic outstanding care", typeId: "hospital-task-type-care", departmentCode: "INPATIENT", patientId: "patient-thor", encounterId: "encounter-thor", responsibleUserId: vet.id, priority: "URGENT", plannedEndAt: "2026-10-11T16:00:00Z", idempotencyKey: "obligation-care" });
  const assigned = await f.service.assignHospitalActivityShift(f.user("user-manager"), { targetType: "HOSPITAL_TASK", targetId: task.task.id, shiftId: from.shift.id, expectedVersion: task.task.version, idempotencyKey: "obligation-bind" });
  const handoff = await f.service.offerHospitalHandoff(vet, { fromShiftId: from.shift.id, toShiftId: to.shift.id, recipientUserId: "handoff-recipient", entries: [{ targetType: "HOSPITAL_TASK", targetId: task.task.id, expectedTargetVersion: assigned.version }], idempotencyKey: "obligation-offer" });
  const notification = f.store.getState().workNotifications.find(entry => entry.userId === "handoff-recipient" && entry.targetType === "HOSPITAL_HANDOFF" && entry.targetId === handoff.handoff.id)!;
  expect(notification).toMatchObject({ eventType: "HANDOFF_OFFERED", version: 1 });
  return { ...f, handoff, notification };
}

describe("personal archives preserve independent operational and critical obligations", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime("2026-10-11T12:00:00Z"); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it("reading, archiving and restoring the offered handoff never accepts or transfers its outstanding care", async () => {
    const f = await offeredHandoff(); const actor = f.user("handoff-recipient");
    const obligations = () => ({ tasks: f.store.getState().hospitalTasks, handoffs: f.store.getState().hospitalHandoffs, critical: f.store.getState().notifications });
    const before = structuredClone(obligations());
    expect((await f.service.listWorkNotifications(actor)).unread).toBe(1);
    await f.service.markWorkNotificationsRead(actor, { notificationIds: [f.notification.id], idempotencyKey: "obligation-read" });
    const archived = await f.service.setWorkNotificationArchived(actor, f.notification.id, { archived: true, expectedVersion: 2, idempotencyKey: "obligation-archive" });
    expect(archived.notification.archivedAt).toBeDefined();
    expect((await f.service.listWorkNotifications(actor)).total).toBe(0);
    expect((await f.service.listWorkNotifications(actor, { includeArchived: true })).total).toBe(1);
    expect(obligations()).toEqual(before);
    expect((await f.service.listHospitalHandoffs(actor, { state: "OFFERED" })).items.map(entry => entry.handoff.id)).toContain(f.handoff.handoff.id);
    const restored = await f.service.setWorkNotificationArchived(actor, f.notification.id, { archived: false, expectedVersion: archived.notification.version, idempotencyKey: "obligation-restore" });
    expect(restored.notification.archivedAt).toBeUndefined(); expect(obligations()).toEqual(before);
    const accepted = await f.service.decideHospitalHandoff(actor, f.handoff.handoff.id, { decision: "ACCEPT", expectedVersion: f.handoff.handoff.version, idempotencyKey: "obligation-native-accept" });
    expect(accepted.handoff.state).toBe("ACCEPTED");
    expect(f.store.getState().hospitalTasks[0].responsibleUserId).toBe(actor.id);
  });

  it("denies restoring an archive and replaying its prior command after current access to the handoff is revoked", async () => {
    const f = await offeredHandoff(); const stale = f.user("handoff-recipient");
    const input = { archived: true, expectedVersion: 1, idempotencyKey: "obligation-replayed-archive" };
    const archived = await f.service.setWorkNotificationArchived(stale, f.notification.id, input);
    const group = f.store.getState().accessGroups.find(entry => entry.id === stale.accessGroupId)!;
    await f.store.transaction(state => ({ state: { ...state, accessGroups: state.accessGroups.map(entry => entry.id === group.id ? { ...entry, permissions: entry.permissions.filter(permission => permission !== "shift.view") } : entry) }, result: undefined }));
    const before = structuredClone(f.store.getState());
    expect((await f.service.listWorkNotifications(stale, { includeArchived: true })).total).toBe(0);
    await expect(f.service.setWorkNotificationArchived(stale, f.notification.id, { archived: false, expectedVersion: archived.notification.version, idempotencyKey: "obligation-denied-restore" })).rejects.toMatchObject({ status: 404 });
    await expect(f.service.setWorkNotificationArchived(stale, f.notification.id, input)).rejects.toMatchObject({ status: 404 });
    expect(f.store.getState()).toEqual(before);
    await f.store.transaction(state => ({ state: { ...state, accessGroups: state.accessGroups.map(entry => entry.id === group.id ? group : entry) }, result: undefined }));
    expect((await f.service.setWorkNotificationArchived(stale, f.notification.id, { archived: false, expectedVersion: archived.notification.version, idempotencyKey: "obligation-authorized-restore" })).notification.archivedAt).toBeUndefined();
    expect(f.store.getState().hospitalHandoffs[0].state).toBe("OFFERED");
  });

  it("rejects a native critical notification in the personal archive/read APIs and preserves its required acknowledgment and counters", async () => {
    vi.stubEnv("CRITICAL_POLICY_ENABLED", "true"); vi.stubEnv("CRITICAL_POLICY_VERSION", "SYNTHETIC_ARCHIVE_NEGATIVE_ONLY"); vi.stubEnv("CRITICAL_POLICY_APPROVAL_REF", "test-only-not-institutional-approval"); vi.stubEnv("CRITICAL_POLICY_APPROVED_AT", "2026-01-01T00:00:00.000Z");
    const f = hospitalOperationFixture(); const vet = f.user("user-vet"); const lab = f.user("user-lab");
    const request = await f.service.createRequest(vet, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-crp" }] }, { idempotencyKey: "archive-critical-request" });
    const received = await f.service.receiveSample(lab, [request.items[0].id], { sampleType: "EDTA", expectedVersion: request.items[0].version, idempotencyKey: "archive-critical-receive" });
    const started = await f.service.startProcessing(lab, request.items[0].id, { expectedVersion: received.items[0].version, idempotencyKey: "archive-critical-start" });
    const draft = await f.service.createResultDraft(lab, request.items[0].id, { narrative: "Synthetic critical-channel regression, not a clinical interpretation.", content: {}, expectedVersion: started.item.version, idempotencyKey: "archive-critical-draft" });
    const released = await f.service.releaseResult(lab, draft.result.id, { critical: true, expectedVersion: draft.result.version, idempotencyKey: "archive-critical-release" });
    // Test-only in-process delivery; no external recipient, endpoint or runtime is contacted.
    await processOutboxBatch(f.store, new InProcessEventBus(), { batchSize: 100, allowSyntheticDelivery: true });
    const critical = f.store.getState().notifications.find(entry => entry.recipientUserId === vet.id && entry.entityId === released.version.id && entry.category === "CRITICAL")!;
    expect(critical.state).toBe("DELIVERED");
    const counter = async () => (await f.service.dashboard(vet)).indicators.find(entry => entry.key === "critical")!.count;
    expect(await counter()).toBe(1); const before = structuredClone(f.store.getState());
    await expect(f.service.setWorkNotificationArchived(vet, critical.id, { archived: true, expectedVersion: critical.version, idempotencyKey: "deny-critical-archive" })).rejects.toMatchObject({ status: 404 });
    await expect(f.service.markWorkNotificationsRead(vet, { notificationIds: [critical.id], idempotencyKey: "deny-critical-personal-read" })).rejects.toMatchObject({ status: 404 });
    await expect(f.service.listNotifications(vet, "CRITICAL")).resolves.toMatchObject({ total: 1, items: [expect.objectContaining({ id: critical.id, state: "DELIVERED" })] });
    expect(f.store.getState()).toEqual(before); expect(await counter()).toBe(1);
    await f.service.markWorkNotificationsRead(vet, { all: true, idempotencyKey: "read-all-personal" });
    expect(f.store.getState().notifications).toEqual(before.notifications); expect(await counter()).toBe(1);
    await f.service.acknowledgeNotification(vet, critical.id, { confirm: true, reason: "Synthetic native acknowledgment regression", expectedVersion: critical.version, idempotencyKey: "native-critical-ack" });
    expect(await counter()).toBe(0); expect(f.store.getState().notifications.find(entry => entry.id === critical.id)?.state).toBe("ACKNOWLEDGED");
  });
});
