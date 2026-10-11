import { describe, expect, it } from "vitest";
import type { AuditEvent, Notification } from "../domain/models";
import { createDemoState, syntheticHemogramContent } from "../store/fixtures";
import { activeServiceFor, auditEventItemIds, canViewManagementAudit, ensureExpectedVersion, hasServicePatientContext, notificationFor, requestForAuditEvent, requestForNotification, requestViewForActor, requireActiveUser, requirePatientPermission, resultView, saveIdempotency, serviceFor, visibleResultVersions, withIdempotency } from "./service-common";
import { freezeState } from "../store/immutable-state";
import { createApplicationService } from "./service";
import { MemoryStore } from "../store/memory-store";

function auditEvent(entityType: string, entityId: string): AuditEvent {
  return {
    id: `audit-${entityType}-${entityId}`,
    eventType: "ConfigurationChanged",
    actorId: "user-admin",
    entityType,
    entityId,
    correlationId: "correlation-test",
    metadata: {},
    occurredAt: "2026-08-24T12:00:00.000Z"
  };
}

function notification(entityType: Notification["entityType"], entityId: string): Notification {
  return {
    id: `notification-${entityType}-${entityId}`,
    category: "INFORMATIONAL",
    priority: "NORMAL",
    recipientUserId: "user-vet",
    entityType,
    entityId,
    deepLink: "/",
    title: "Notificação de teste",
    body: "Contexto",
    dedupeKey: `dedupe-${entityType}-${entityId}`,
    state: "PENDING",
    createdAt: "2026-08-24T12:00:00.000Z",
    attempts: 0,
    version: 1
  };
}

describe("shared application scope helpers", () => {
  it("recognizes a patient reached through a visible service item", () => {
    const state = createDemoState("service-common-context-password");
    const veterinarian = state.users.find((user) => user.id === "user-vet");
    state.requests.push({ id: "request-context", patientId: "patient-thor", itemIds: ["item-context"], requestingDepartmentCode: "INPATIENT" } as never);
    state.items.push({ id: "item-context", requestId: "request-context", serviceId: "service-hemogram", departmentCode: "INPATIENT" } as never);

    expect(veterinarian).toBeDefined();
    expect(hasServicePatientContext(state, veterinarian!, "patient-thor")).toBe(true);
    expect(hasServicePatientContext(state, veterinarian!, "patient-not-visible")).toBe(false);
  });

  it("keeps management audit visibility inside delegated departments", () => {
    const state = createDemoState("service-common-audit-password");
    const manager = state.users.find((user) => user.id === "user-manager");
    const veterinarian = state.users.find((user) => user.id === "user-vet");

    expect(manager).toBeDefined();
    expect(veterinarian).toBeDefined();
    expect(canViewManagementAudit(state, manager!, auditEvent("ReasonCode", "reason-recollection"))).toBe(true);
    expect(canViewManagementAudit(state, manager!, auditEvent("DiagnosticService", "service-hemogram"))).toBe(true);
    expect(canViewManagementAudit(state, manager!, auditEvent("User", "user-lab"))).toBe(true);
    expect(canViewManagementAudit(state, manager!, auditEvent("DiagnosticService", "missing-service"))).toBe(false);
    expect(canViewManagementAudit(state, veterinarian!, auditEvent("ReasonCode", "reason-recollection"))).toBe(false);
  });

  it("resolves notification context through request, item, sample and result version links", () => {
    const state = createDemoState("service-common-notification-password");
    state.requests.push({ id: "notification-request", patientId: "patient-thor", itemIds: ["notification-item"], requestingDepartmentCode: "INPATIENT" } as never);
    state.items.push({ id: "notification-item", requestId: "notification-request", serviceId: "service-hemogram", departmentCode: "INPATIENT" } as never);
    state.samples.push({ id: "notification-sample", requestId: "notification-request" } as never);
    state.results.push({ id: "notification-result", itemId: "notification-item" } as never);
    state.resultVersions.push({ id: "notification-version", resultId: "notification-result" } as never);

    const request = state.requests[0];
    expect(requestForNotification(state, notification("REQUEST", request.id))).toBe(request);
    expect(requestForNotification(state, notification("ITEM", "notification-item"))).toBe(request);
    expect(requestForNotification(state, notification("SAMPLE", "notification-sample"))).toBe(request);
    expect(requestForNotification(state, notification("RESULT_VERSION", "notification-version"))).toBe(request);
    expect(requestForNotification(state, notification("ITEM", "missing-item"))).toBeUndefined();
  });

  it("recomputes request aggregates from visible items instead of hidden departments", async () => {
    const store = new MemoryStore(createDemoState("service-common-projection-password"));
    const service = createApplicationService(store);
    const veterinarian = store.getState().users.find((user) => user.email === "vet@cvg.local");
    const laboratory = store.getState().users.find((user) => user.email === "lab@cvg.local");
    if (!veterinarian || !laboratory) throw new Error("fixture actors missing");
    const request = await service.createRequest(veterinarian, {
      patientId: "patient-thor",
      encounterId: "encounter-thor",
      priority: "ROUTINE",
      items: [{ serviceId: "service-hemogram" }, { serviceId: "service-xray" }]
    }, { idempotencyKey: "service-common-visible-projection" });
    const hiddenUpdatedAt = "2099-01-01T00:00:00.000Z";
    await store.transaction((state) => ({
      state: {
        ...state,
        requests: state.requests.map((entry) => entry.id === request.id
          ? { ...entry, aggregateStatus: "COMPLETED" as const, updatedAt: hiddenUpdatedAt, version: 88 }
          : entry),
        items: state.items.map((item) => item.serviceId === "service-xray"
          ? { ...item, status: "COMPLETED" as const, completedAt: hiddenUpdatedAt, version: 77 }
          : item)
      },
      result: undefined
    }));

    const projected = requestViewForActor(store.getState(), laboratory, store.getState().requests.find((entry) => entry.id === request.id)!);

    expect(projected.itemIds).toEqual([request.items.find((item) => item.serviceId === "service-hemogram")?.id]);
    expect(projected.aggregateStatus).toBe("REQUESTED");
    expect(projected.version).toBe(1);
    expect(projected.updatedAt).not.toBe(hiddenUpdatedAt);
    expect(projected.items).not.toEqual(expect.arrayContaining([expect.objectContaining({ serviceId: "service-xray" })]));
  });

  it("uses the latest result version when the result pointer is absent and requires a version guard", async () => {
    const store = new MemoryStore(createDemoState("service-common-result-password"));
    const service = createApplicationService(store);
    const veterinarian = store.getState().users.find((user) => user.email === "vet@cvg.local");
    const laboratory = store.getState().users.find((user) => user.email === "lab@cvg.local");
    if (!veterinarian || !laboratory) throw new Error("fixture actors missing");

    const request = await service.createRequest(veterinarian, {
      patientId: "patient-thor",
      encounterId: "encounter-thor",
      priority: "ROUTINE",
      items: [{ serviceId: "service-hemogram" }]
    }, { idempotencyKey: "service-common-result-request" });
    const received = await service.receiveSample(laboratory, [request.items[0].id], {
      sampleType: "EDTA",
      expectedVersion: request.items[0].version,
      idempotencyKey: "service-common-result-sample"
    });
    const started = await service.startProcessing(laboratory, request.items[0].id, {
      expectedVersion: received.items[0].version,
      idempotencyKey: "service-common-result-start"
    });
    const draft = await service.createResultDraft(laboratory, request.items[0].id, {
      narrative: "Resultado para cobertura de projeção.",
      content: syntheticHemogramContent(),
      expectedVersion: started.item.version,
      idempotencyKey: "service-common-result-draft"
    });

    const view = resultView(store.getState(), { ...draft.result, currentVersionId: undefined });
    expect(view.version.id).toBe(draft.version.id);
    expect(() => ensureExpectedVersion(view.result.version, undefined)).toThrowError(/expectedVersion/);
  });
});

describe("indexed lookups over the frozen snapshot", () => {
  it("deduplicates a notification by recipient and key", () => {
    const state = freezeState({ ...createDemoState("service-common-dedupe-password"), notifications: [notification("REQUEST", "request-dedupe")] });
    const { id: _id, createdAt: _createdAt, attempts: _attempts, state: _state, version: _version, ...input } = state.notifications[0];
    expect(notificationFor(state, input)).toBe(state);
    expect(notificationFor(state, { ...input, recipientUserId: "user-lab" }).notifications).toHaveLength(2);
  });

  it("finds, replaces and rejects reused idempotency keys through the index", () => {
    const base = createDemoState("service-common-idempotency-password");
    const saved = freezeState(saveIdempotency(base, "user-vet", "scope", "key", { first: true }, { payload: 1 }));
    expect(withIdempotency(saved, "user-vet", "scope", "key", { payload: 1 })).toMatchObject({ found: true, existing: { first: true } });
    expect(() => withIdempotency(saved, "user-vet", "scope", "key", { payload: 2 })).toThrow("A chave de repetição já foi usada com outro conteúdo.");
    const replaced = saveIdempotency(saved, "user-vet", "scope", "key", { second: true }, { payload: 3 });
    expect(replaced.idempotency).toHaveLength(1);
    expect(replaced.idempotency[0]).toMatchObject({ response: { second: true } });
    expect(withIdempotency(saved, "user-vet", "scope", undefined, {})).toEqual({ found: false, state: saved });
  });

  it("keeps an inactive service in the clinical record and refuses it only for a new offering", () => {
    const base = createDemoState("service-common-inactive-password");
    const state = freezeState({ ...base, services: base.services.map((service) => service.id === "service-hemogram" ? { ...service, active: false } : service) });
    expect(serviceFor(state, "service-hemogram")).toMatchObject({ active: false });
    expect(() => activeServiceFor(state, "service-hemogram")).toThrow("Serviço diagnóstico indisponível.");
    expect(() => serviceFor(state, "service-missing")).toThrow("Serviço diagnóstico indisponível.");
  });

  it("takes the newest version when the current pointer is missing and lists visible versions newest first", () => {
    const base = createDemoState("service-common-version-password");
    const state = freezeState({
      ...base,
      requests: [{ id: "request-v", patientId: "patient-thor", itemIds: ["item-v"] } as never],
      items: [{ id: "item-v", requestId: "request-v", serviceId: "service-hemogram" } as never],
      results: [{ id: "result-v", itemId: "item-v" } as never],
      resultVersions: [
        { id: "version-1", resultId: "result-v", sequence: 1, status: "SUPERSEDED" },
        { id: "version-3", resultId: "result-v", sequence: 3, status: "DRAFT" },
        { id: "version-2", resultId: "result-v", sequence: 2, status: "RELEASED" }
      ] as never
    });
    expect(resultView(state, state.results[0]).version.id).toBe("version-3");
    expect(visibleResultVersions(state, "result-v").map((version) => version.id)).toEqual(["version-2", "version-1"]);
  });

  it("resolves nothing for audit events whose references were removed", () => {
    const state = freezeState({
      ...createDemoState("service-common-dangling-password"),
      results: [{ id: "result-orphan", itemId: "item-gone" } as never],
      resultVersions: [{ id: "version-orphan", resultId: "result-gone" } as never],
      procedures: [{ id: "procedure-orphan", itemId: "item-gone" } as never],
      schedules: [{ id: "schedule-orphan", procedureId: "procedure-gone" } as never],
      attachments: [{ id: "attachment-orphan", resultVersionId: "version-gone" } as never]
    });
    for (const [entityType, entityId] of [
      ["Result", "result-orphan"], ["ResultVersion", "version-orphan"], ["Procedure", "procedure-orphan"],
      ["ProcedureSchedule", "schedule-orphan"], ["Attachment", "attachment-orphan"], ["Sample", "sample-gone"],
      ["DiagnosticRequestItem", "item-gone"], ["DiagnosticRequest", "request-gone"]
    ] as const) {
      expect(requestForAuditEvent(state, auditEvent(entityType, entityId)), entityType).toBeUndefined();
      expect(auditEventItemIds(state, auditEvent(entityType, entityId)), entityType).toEqual([]);
    }
  });

  it("ignores a session id that belongs to another user", () => {
    const base = createDemoState("service-common-session-password");
    const session = { id: "session-other", userId: "user-lab", tokenHash: "hash", csrfTokenHash: "csrf", createdAt: "2026-10-08T00:00:00.000Z", expiresAt: "2999-01-01T00:00:00.000Z", version: 1 };
    const state = freezeState({ ...base, sessions: [session] });
    const veterinarian = state.users.find((user) => user.id === "user-vet")!;
    expect(() => requireActiveUser(state, { ...veterinarian, sessionId: session.id })).toThrow("Sessão inválida ou expirada.");
  });

  it("lets an executor reach a patient through any of several visible items", () => {
    const base = createDemoState("service-common-executor-password");
    const state = freezeState({
      ...base,
      requests: [
        { id: "request-a", patientId: "patient-thor", itemIds: ["item-a"], requestingDepartmentCode: "INPATIENT" } as never,
        { id: "request-b", patientId: "patient-thor", itemIds: ["item-b"], requestingDepartmentCode: "INPATIENT" } as never
      ],
      items: [
        { id: "item-b", requestId: "request-b", serviceId: "service-crp", departmentCode: "LABORATORY" } as never,
        { id: "item-a", requestId: "request-a", serviceId: "service-hemogram", departmentCode: "LABORATORY" } as never
      ]
    });
    const lab = state.users.find((user) => user.id === "user-lab")!;
    expect(() => requirePatientPermission(state, lab, "patient.view", "patient-thor")).not.toThrow();
    expect(() => requirePatientPermission(state, lab, "patient.view", "patient-mel")).toThrow("Você não tem acesso a este recurso.");
  });
});
