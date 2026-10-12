import { afterEach, describe, expect, it, vi } from "vitest";
import { createApplicationService } from "./service";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { eventVisible } from "./realtime-visibility";

async function setup(serviceId = "service-hemogram") {
  const state = createDemoState("diagnostic-planning-test-password");
  state.users.push({ ...state.users.find((entry) => entry.role === "VETERINARIAN")!, id: "planning-viewer", email: "planning-viewer@cvg.local", role: "VIEWER", accessGroupId: "access-group-viewer" });
  const store = new MemoryStore(state);
  const service = createApplicationService(store);
  const user = (role: string) => store.getState().users.find((entry) => entry.role === role)!;
  const request = await service.createRequest(user("VETERINARIAN"), { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId }] }, { idempotencyKey: "planning-create" });
  return { store, service, user, item: request.items[0] };
}

describe("diagnostic planning without clinical side effects", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("reprioritizes an exam actually in progress while preserving existing report authorship, critical history, notifications and the original SLA clock", async () => {
    const { store, service, user, item } = await setup("service-crp"); const lab = user("LAB_TECH");
    const received = await service.receiveSample(lab, [item.id], { sampleType: "EDTA", expectedVersion: item.version, idempotencyKey: "progress-receive" });
    const started = await service.startProcessing(lab, item.id, { expectedVersion: received.items[0].version, idempotencyKey: "progress-start" });
    const draft = await service.createResultDraft(lab, item.id, { narrative: "Laudo sintético anterior.", content: {}, expectedVersion: started.item.version, idempotencyKey: "progress-first-draft" });
    vi.stubEnv("CRITICAL_POLICY_ENABLED", "true"); vi.stubEnv("CRITICAL_POLICY_VERSION", "synthetic-progress-policy"); vi.stubEnv("CRITICAL_POLICY_APPROVAL_REF", "synthetic-unit-approval"); vi.stubEnv("CRITICAL_POLICY_APPROVED_AT", "2026-01-01T00:00:00.000Z");
    const released = await service.releaseResult(lab, draft.result.id, { critical: true, expectedVersion: draft.result.version, idempotencyKey: "progress-release" });
    const voided = await service.voidResult(lab, released.result.id, { reason: "Correção exclusivamente sintética.", expectedVersion: released.result.version, idempotencyKey: "progress-void" });
    const replacement = await service.createResultDraft(lab, item.id, { narrative: "Laudo substituto ainda em elaboração.", content: {}, expectedVersion: voided.item.version, idempotencyKey: "progress-replacement" });
    expect(replacement.item.status).toBe("IN_PROGRESS");
    const before = structuredClone(store.getState()); expect(before.resultVersions.some(version => version.critical)).toBe(true);
    await expect(service.reprioritizeDiagnosticItem(user("VIEWER"), item.id, { priority: "URGENT", reason: "Sem autorização.", expectedVersion: replacement.item.version, idempotencyKey: "progress-denied" })).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    expect(store.getState()).toEqual(before);
    const changed = await service.reprioritizeDiagnosticItem(user("VETERINARIAN"), item.id, { priority: "URGENT", reason: "Reavaliação sintética durante execução.", expectedVersion: replacement.item.version, idempotencyKey: "progress-priority" });
    expect(changed.item).toMatchObject({ status: "IN_PROGRESS", priority: "URGENT", startedAt: replacement.item.startedAt, slaStartedAt: item.slaStartedAt, slaPolicyVersion: item.slaPolicyVersion, currentResultId: replacement.result.id, definitionSnapshot: item.definitionSnapshot });
    expect(changed.item.dueAt).toBe(new Date(Date.parse(item.slaStartedAt) + item.definitionSnapshot!.definition.slaHours.URGENT * 3_600_000).toISOString());
    const assigned = await service.assignDiagnosticItem(user("MANAGER"), item.id, { userId: lab.id, expectedVersion: changed.item.version, idempotencyKey: "progress-assignment" });
    const planned = await service.planDiagnosticItem(lab, item.id, { plannedStartsAt: "2026-10-12T12:00:00Z", plannedEndsAt: "2026-10-12T13:00:00Z", expectedVersion: assigned.item.version, idempotencyKey: "progress-dates" });
    expect(planned.item).toMatchObject({ status: "IN_PROGRESS", assignedUserId: lab.id, slaStartedAt: item.slaStartedAt, dueAt: changed.item.dueAt, currentResultId: replacement.result.id });
    expect(planned.request.requesterId).toBe(user("VETERINARIAN").id);
    for (const collection of ["results", "resultVersions", "notifications", "samples", "schedules", "patientGrants", "users"] as const) expect(store.getState()[collection]).toEqual(before[collection]);
    expect(store.getState().auditEvents.find(event => event.eventType === "DiagnosticItemPriorityChanged" && event.entityId === item.id)).toMatchObject({ actorId: user("VETERINARIAN").id, previousState: "IN_PROGRESS", newState: "IN_PROGRESS", metadata: { previousPriority: "ROUTINE", priority: "URGENT", reason: "Reavaliação sintética durante execução.", clinicalStateChanged: false, criticalityChanged: false, slaStartedAt: item.slaStartedAt } });
  });
  it("allows an eligible executor to assume once and preserves patient grants and authorship", async () => {
    const { store, service, user, item } = await setup();
    const lab = user("LAB_TECH");
    const before = structuredClone(lab);
    const input = { userId: lab.id, expectedVersion: item.version, idempotencyKey: "assume" };
    const assigned = await service.assignDiagnosticItem(lab, item.id, input);
    expect(assigned.item).toMatchObject({ assignedUserId: lab.id, assignedBy: lab.id, status: item.status, slaStartedAt: item.slaStartedAt, dueAt: item.dueAt });
    expect(assigned.request.requesterId).toBe(user("VETERINARIAN").id);
    expect(store.getState().users.find((entry) => entry.id === lab.id)).toEqual(before);
    expect(await service.assignDiagnosticItem(lab, item.id, input)).toEqual(assigned);
    expect(store.getState().auditEvents.filter((event) => event.eventType === "DiagnosticItemAssigned")).toHaveLength(1);
    const events = store.getState().outbox.filter((event) => event.eventType === "DiagnosticItemAssigned");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ aggregateType: "DiagnosticRequestItem", aggregateId: item.id, payload: { itemId: item.id, version: assigned.item.version } });
    expect(eventVisible(store.getState(), lab, events[0].aggregateType, events[0].aggregateId, events[0].payload)).toBe(true);
    expect(eventVisible(store.getState(), user("RADIOLOGY_TEAM"), events[0].aggregateType, events[0].aggregateId, events[0].payload)).toBe(false);
    expect(await service.listDiagnosticItemAssignees(lab, item.id)).toEqual([{ id: lab.id, displayName: lab.displayName, role: lab.role, departmentCode: lab.departmentCode }]);
  });

  it("denies viewer, ineligible targets and executor reassignment without partial writes", async () => {
    const { store, service, user, item } = await setup();
    const initial = structuredClone(store.getState());
    await expect(service.assignDiagnosticItem(user("VIEWER"), item.id, { userId: user("LAB_TECH").id, expectedVersion: 1, idempotencyKey: "viewer-assign" })).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    await expect(service.assignDiagnosticItem(user("LAB_TECH"), item.id, { userId: user("RADIOLOGY_TEAM").id, expectedVersion: 1, idempotencyKey: "cross-executor" })).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    await expect(service.assignDiagnosticItem(user("MANAGER"), item.id, { userId: user("RADIOLOGY_TEAM").id, expectedVersion: 1, idempotencyKey: "ineligible-target" })).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    expect(store.getState()).toEqual(initial);
  });

  it("uses the frozen SLA from the original clock after the catalog changes", async () => {
    const { store, service, user, item } = await setup();
    const catalog = store.getState().services.find((entry) => entry.id === item.serviceId)!;
    await service.updateDiagnosticService(user("ADMIN"), catalog.id, { slaHours: { ROUTINE: 100, URGENT: 50, EMERGENCY: 10 }, expectedVersion: catalog.version, idempotencyKey: "change-current-sla" });
    const result = await service.reprioritizeDiagnosticItem(user("VETERINARIAN"), item.id, { priority: "URGENT", reason: "Reavaliação do atendimento", expectedVersion: item.version, idempotencyKey: "reprioritize" });
    expect(result.item.dueAt).toBe(new Date(Date.parse(item.slaStartedAt) + item.definitionSnapshot!.definition.slaHours.URGENT * 3_600_000).toISOString());
    expect(result.item).toMatchObject({ priority: "URGENT", status: item.status, slaStartedAt: item.slaStartedAt, slaPolicyVersion: item.slaPolicyVersion, definitionSnapshot: item.definitionSnapshot });
    expect(result.request.priority).toBe("ROUTINE");
    expect(store.getState().resultVersions).toHaveLength(0);
  });

  it("refuses to reconstruct an unavailable legacy SLA policy", async () => {
    const { store, service, user, item } = await setup();
    await store.transaction((state) => ({ state: { ...state, items: state.items.map((entry) => entry.id === item.id ? { ...entry, definitionSnapshot: undefined, slaPolicyVersion: 777 } : entry) }, result: undefined }));
    const before = structuredClone(store.getState());
    await expect(service.reprioritizeDiagnosticItem(user("MANAGER"), item.id, { priority: "URGENT", reason: "Motivo válido", expectedVersion: 1, idempotencyKey: "legacy-policy" })).rejects.toMatchObject({ code: "SLA_POLICY_UNAVAILABLE" });
    expect(store.getState()).toEqual(before);
  });

  it("requires valid planning dates and assignment, without reserving resources or changing SLA", async () => {
    const { store, service, user, item } = await setup();
    const lab = user("LAB_TECH");
    const dates = { plannedStartsAt: "2026-10-12T12:00:00Z", plannedEndsAt: "2026-10-12T13:00:00Z", expectedVersion: 1, idempotencyKey: "unassigned-dates" };
    await expect(service.planDiagnosticItem(lab, item.id, dates)).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    const assumed = await service.assignDiagnosticItem(lab, item.id, { userId: lab.id, expectedVersion: 1, idempotencyKey: "assume-before-plan" });
    await expect(service.planDiagnosticItem(lab, item.id, { ...dates, expectedVersion: assumed.item.version, plannedEndsAt: dates.plannedStartsAt, idempotencyKey: "invalid-dates" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const planned = await service.planDiagnosticItem(lab, item.id, { ...dates, expectedVersion: assumed.item.version, idempotencyKey: "valid-dates" });
    expect(planned.item).toMatchObject({ plannedStartsAt: dates.plannedStartsAt, plannedEndsAt: dates.plannedEndsAt, dueAt: item.dueAt, status: item.status });
    expect(store.getState().schedules).toHaveLength(0);
    const cleared = await service.planDiagnosticItem(lab, item.id, { plannedStartsAt: null, plannedEndsAt: null, expectedVersion: planned.item.version, idempotencyKey: "clear-dates" });
    expect(cleared.item.plannedStartsAt).toBeUndefined();
  });

  it("rejects stale concurrent assignment and revoked groups", async () => {
    const { store, service, user, item } = await setup();
    const lab = user("LAB_TECH");
    const results = await Promise.allSettled(["a", "b"].map((key) => service.assignDiagnosticItem(lab, item.id, { userId: lab.id, expectedVersion: 1, idempotencyKey: `concurrent-${key}` })));
    expect(results.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(results.find((entry) => entry.status === "rejected")).toMatchObject({ reason: { code: "STALE_VERSION" } });
    await store.transaction((state) => ({ state: { ...state, accessGroups: state.accessGroups.map((group) => group.id === lab.accessGroupId ? { ...group, active: false, version: group.version + 1 } : group) }, result: undefined }));
    await expect(service.assignDiagnosticItem(lab, item.id, { userId: lab.id, expectedVersion: 2, idempotencyKey: "after-revoke" })).rejects.toMatchObject({ code: "SCOPE_DENIED" });
  });
});
