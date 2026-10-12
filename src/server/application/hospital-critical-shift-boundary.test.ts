import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "../domain/models";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { systemGroupId } from "../security/access-group-policy";
import { runCriticalEscalation } from "./critical-escalation";
import type { CriticalResultPolicy } from "./critical-result-policy";
import { currentShiftCoverage } from "./hospital-shift-policy";
import { createApplicationService } from "./service";

const RELEASE_AT = "2026-10-11T09:45:00.000Z";
const BOUNDARY = "2026-10-11T10:00:00.000Z";
const policy: CriticalResultPolicy = {
  version: "synthetic-shift-boundary", approvalRef: "synthetic-only-existing-policy", approvedAt: "2026-01-01T00:00:00.000Z", effectiveFrom: "2026-01-01T00:00:00.000Z",
  escalationAfterMs: [15 * 60_000, 30 * 60_000, 60 * 60_000], recipientRules: ["REQUESTER", "ON_CALL", "DEPARTMENT_MANAGER"], requireDistinctRecipients: true
};

async function boundaryFixture() {
  const state = createDemoState("synthetic-critical-shift-boundary");
  const vet = state.users.find(user => user.id === "user-vet")!;
  const outgoing: User = { ...vet, id: "boundary-outgoing", email: "outgoing@example.test", displayName: "Plantonista anterior sintético", patientIds: [], onCall: true };
  const incoming: User = { ...vet, id: "boundary-incoming", email: "incoming@example.test", displayName: "Substituto sintético", onCall: false };
  state.users.push(outgoing, incoming);
  state.departments.find(department => department.code === "INPATIENT")!.memberUserIds.push(outgoing.id, incoming.id);
  state.users = state.users.map(user => user.id === "user-manager" ? { ...user, managedDepartmentCodes: ["INPATIENT", "LABORATORY"] } : user);
  const store = new MemoryStore(state); const service = createApplicationService(store);
  const actor = (id: string) => store.getState().users.find(user => user.id === id)!;
  await service.createHospitalShift(actor("user-manager"), { name: "Origem sintética", departmentCode: "INPATIENT", startAt: "2026-10-11T09:00:00Z", endAt: BOUNDARY, members: [{ userId: outgoing.id }], idempotencyKey: "boundary-outgoing-shift" });
  await service.createHospitalShift(actor("user-manager"), { name: "Destino com substituto sintético", departmentCode: "INPATIENT", startAt: BOUNDARY, endAt: "2026-10-11T11:00:00Z", members: [{ userId: incoming.id, replacesUserId: outgoing.id }], idempotencyKey: "boundary-incoming-shift" });
  const lab = actor("user-lab");
  const request = await service.createRequest(actor("user-vet"), { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-crp" }] }, { idempotencyKey: "boundary-request" });
  const received = await service.receiveSample(lab, [request.items[0].id], { sampleType: "EDTA", expectedVersion: request.items[0].version, idempotencyKey: "boundary-sample" });
  const started = await service.startProcessing(lab, request.items[0].id, { expectedVersion: received.items[0].version, idempotencyKey: "boundary-start" });
  const draft = await service.createResultDraft(lab, request.items[0].id, { narrative: "Resultado crítico sintético", content: {}, conclusion: "Somente prova de continuidade", expectedVersion: started.item.version, idempotencyKey: "boundary-draft" });
  const released = await service.releaseResult(lab, draft.result.id, { critical: true, expectedVersion: draft.result.version, idempotencyKey: "boundary-release" });
  const root = store.getState().notifications.find(notification => notification.category === "CRITICAL" && notification.entityId === released.version.id)!;
  expect(root.createdAt).toBe(RELEASE_AT);
  return { store, service, actor, root, released, outgoing, incoming };
}

describe("critical continuity at the exact shift boundary without an onCall cutover", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(RELEASE_AT);
    vi.stubEnv("CRITICAL_POLICY_ENABLED", "true"); vi.stubEnv("CRITICAL_POLICY_VERSION", policy.version);
    vi.stubEnv("CRITICAL_POLICY_APPROVAL_REF", policy.approvalRef); vi.stubEnv("CRITICAL_POLICY_APPROVED_AT", policy.approvedAt);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it("changes current coverage at [start,end) while the native critical ladder preserves approved onCall authority", async () => {
    const f = await boundaryFixture(); const flags = f.store.getState().users.map(user => [user.id, user.onCall]);
    vi.setSystemTime(Date.parse(BOUNDARY) - 1);
    expect(currentShiftCoverage(f.store.getState(), "INPATIENT").map(user => user.id)).toEqual([f.outgoing.id]);
    const beforeThreshold = f.store.getState();
    expect(await runCriticalEscalation(f.store, { policy })).toEqual({ due: 0, notified: 0, unreachable: 0 });
    expect(f.store.getState()).toEqual(beforeThreshold);
    vi.setSystemTime(BOUNDARY);
    expect(currentShiftCoverage(f.store.getState(), "INPATIENT").map(user => user.id)).toEqual([f.incoming.id]);
    expect(await runCriticalEscalation(f.store, { policy })).toEqual({ due: 1, notified: 1, unreachable: 0 });
    expect(f.store.getState().users.map(user => [user.id, user.onCall])).toEqual(flags);
    const notifications = f.store.getState().notifications.filter(notification => notification.escalationOf === f.root.id);
    expect(notifications).toMatchObject([{ recipientUserId: f.outgoing.id, entityId: f.released.version.id, state: "PENDING" }]);
    expect(notifications.some(notification => notification.recipientUserId === f.incoming.id)).toBe(false);
    expect(f.actor(f.outgoing.id).patientIds).toContain("patient-thor");
    expect((await f.service.getResult(f.actor(f.outgoing.id), f.released.result.id)).version.id).toBe(f.released.version.id);
    expect(f.store.getState().notifications.find(notification => notification.id === f.root.id)).toMatchObject({ state: "PENDING", escalation: { level: 1, lastEscalatedAt: BOUNDARY } });
    const after = f.store.getState();
    expect(await runCriticalEscalation(f.store, { policy })).toEqual({ due: 0, notified: 0, unreachable: 0 });
    expect(f.store.getState()).toEqual(after);
  });

  it.each(["result.view", "GROUP_INACTIVE"] as const)("rechecks %s at the boundary instead of granting or notifying an ineligible onCall recipient", async removed => {
    const f = await boundaryFixture(); const staleOutgoing = f.actor(f.outgoing.id);
    await f.store.transaction(state => {
      const baseline = state.accessGroups.find(group => group.id === systemGroupId("VETERINARIAN"))!;
      const group = { ...baseline, id: "boundary-restricted", code: "BOUNDARY_RESTRICTED", systemRole: undefined, active: removed !== "GROUP_INACTIVE", permissions: baseline.permissions.filter(permission => permission !== removed) };
      return { state: { ...state, accessGroups: [...state.accessGroups, group], users: state.users.map(user => user.id === f.outgoing.id ? { ...user, accessGroupId: group.id } : user) }, result: undefined };
    });
    vi.setSystemTime(BOUNDARY);
    expect(currentShiftCoverage(f.store.getState(), "INPATIENT").map(user => user.id)).toEqual([f.incoming.id]);
    expect(await runCriticalEscalation(f.store, { policy })).toEqual({ due: 1, notified: 1, unreachable: 0 });
    expect(f.store.getState().notifications.filter(notification => notification.escalationOf === f.root.id)).toMatchObject([{ recipientUserId: "user-manager", state: "PENDING" }]);
    expect(f.actor(f.outgoing.id).patientIds).toEqual([]);
    expect(f.store.getState().auditEvents.filter(event => event.eventType === "CriticalEscalationPatientAccessGranted" && event.entityId === f.outgoing.id)).toEqual([]);
    await expect(f.service.getResult(staleOutgoing, f.released.result.id)).rejects.toMatchObject({ status: 404 });
    expect(f.store.getState().notifications.find(notification => notification.id === f.root.id)).toMatchObject({ state: "PENDING", escalation: { level: 1 } });
    expect(f.actor(f.outgoing.id).onCall).toBe(true); expect(f.actor(f.incoming.id).onCall).toBe(false);
  });
});
