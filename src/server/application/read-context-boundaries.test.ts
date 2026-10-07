import { describe, expect, it } from "vitest";
import type { AuditEvent, Notification } from "../domain/models";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { createApplicationService } from "./service";

function setup() {
  const state = createDemoState();
  const store = new MemoryStore(state);
  return { store, service: createApplicationService(store), vet: state.users.find((user) => user.id === "user-vet")!, lab: state.users.find((user) => user.id === "user-lab")!, rx: state.users.find((user) => user.id === "user-rx")!, manager: state.users.find((user) => user.id === "user-manager")! };
}

function notification(id: string, changes: Partial<Notification> = {}): Notification {
  return { id, recipientUserId: "user-vet", entityType: "REQUEST", entityId: "missing-request", category: "CRITICAL", priority: "URGENT", deepLink: "/notifications", title: "Contexto sintético", body: "Confirmar contexto vigente", dedupeKey: id, state: "DELIVERED", attempts: 1, version: 1, createdAt: "2026-10-04T10:00:00.000Z", ...changes };
}

describe("application reads validate filters and resolve current context", () => {
  it("paginates equal-time notifications without duplicates, isolates recipients and filters critical entries", async () => {
    const c = setup();
    const notifications = [notification("n-b"), notification("n-a"), notification("n-old", { category: "INFORMATIONAL", createdAt: "2026-10-03T10:00:00.000Z" }), notification("n-other", { recipientUserId: c.lab.id })];
    await c.store.transaction((state) => ({ state: { ...state, notifications }, result: undefined }));
    const first = await c.service.listNotifications(c.vet, "ALL", { limit: 1 });
    expect(first.items.map((entry) => entry.id)).toEqual(["n-a"]);
    expect(first.total).toBe(3);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await c.service.listNotifications(c.vet, "ALL", { limit: 1, cursor: first.nextCursor });
    expect(second.items.map((entry) => entry.id)).toEqual(["n-b"]);
    const third = await c.service.listNotifications(c.vet, "ALL", { limit: 1, cursor: second.nextCursor });
    expect(third.items.map((entry) => entry.id)).toEqual(["n-old"]);
    expect(third.nextCursor).toBeUndefined();
    const critical = await c.service.listNotifications(c.vet, "CRITICAL");
    expect(critical.items.map((entry) => entry.id)).toEqual(["n-a", "n-b"]);
  });

  it("rejects oversized patient queries and reversed date windows while accepting valid controls", async () => {
    const c = setup();
    await expect(c.service.listPatients(c.vet, "x".repeat(201))).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 });
    await expect(c.service.listPatients(c.vet, "Thor")).resolves.toEqual([expect.objectContaining({ id: "patient-thor" })]);
    await expect(c.service.listRequests(c.vet, { from: "2026-10-04T12:00:00.000Z", to: "2026-10-03T12:00:00.000Z" })).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 });
    await expect(c.service.listRequests(c.vet, { from: "2026-10-03T12:00:00.000Z", to: "2026-10-04T12:00:00.000Z" })).resolves.toMatchObject({ items: [], total: 0 });
  });

  it("requires explicit acknowledgement and a delivered notification before persisting a decision", async () => {
    const c = setup();
    await c.store.transaction((state) => ({ state: { ...state, notifications: [notification("pending", { category: "INFORMATIONAL", state: "PENDING" }), notification("delivered", { category: "INFORMATIONAL" })] }, result: undefined }));
    const input = { confirm: true as const, reason: "Recebimento confirmado", expectedVersion: 1, idempotencyKey: "read-acknowledge" };
    const before = c.store.getState();
    await expect(Reflect.apply(c.service.acknowledgeNotification, c.service, [c.vet, "delivered", { ...input, confirm: false }])).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 });
    await expect(c.service.acknowledgeNotification(c.vet, "pending", input)).rejects.toMatchObject({ code: "NOTIFICATION_NOT_DELIVERED", status: 409, details: { retryable: true } });
    expect(c.store.getState()).toEqual(before);
    await expect(c.service.acknowledgeNotification(c.vet, "delivered", input)).resolves.toMatchObject({ state: "ACKNOWLEDGED", acknowledgedBy: c.vet.id, version: 2 });
    expect(c.store.getState().notifications[0]).toEqual(before.notifications[0]);
  });

  it("does not count unresolved, acknowledged or superseded critical notifications in the management overview", async () => {
    const c = setup();
    const request = await c.service.createRequest(c.vet, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-hemogram" }] }, { idempotencyKey: "overview-notification-request" });
    const received = await c.service.receiveSample(c.lab, [request.items[0].id], { accessionCode: "ACC-OVERVIEW", sampleType: "EDTA", expectedVersion: 1, idempotencyKey: "overview-sample" });
    const notifications = [
      notification("valid-critical", { entityType: "SAMPLE", entityId: received.sample.id }),
      notification("orphan-sample", { entityType: "SAMPLE", entityId: "missing-sample" }),
      notification("orphan-version", { entityType: "RESULT_VERSION", entityId: "missing-version" }),
      notification("already-acknowledged", { entityId: request.id, state: "ACKNOWLEDGED" }),
      notification("superseded", { entityId: request.id, state: "SUPERSEDED" }),
      notification("informational", { entityId: request.id, category: "INFORMATIONAL" })
    ];
    await c.store.transaction((state) => ({ state: { ...state, notifications }, result: undefined }));
    const overview = await c.service.managementOverview(c.manager);
    expect(overview.summary.critical).toBe(1);
    expect(overview.summary.activeItems).toBe(1);
    const before = c.store.getState();
    await expect(c.service.acknowledgeNotification(c.manager, "orphan-sample", { confirm: true, reason: "Sem contexto vigente", expectedVersion: 1, idempotencyKey: "orphan-sample-ack" })).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(c.store.getState()).toEqual(before);
  });

  it("keeps dangling clinical links out of patient history while preserving valid events", async () => {
    const c = setup();
    const request = await c.service.createRequest(c.vet, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-xray" }, { serviceId: "service-hemogram" }] }, { idempotencyKey: "history-context-request" });
    const imaging = request.items[0];
    const started = await c.service.startProcedure(c.rx, imaging.id, { expectedVersion: 1, idempotencyKey: "history-start" });
    const performed = await c.service.markProcedurePerformed(c.rx, imaging.id, { expectedVersion: started.item.version, idempotencyKey: "history-perform" });
    const draft = await c.service.createResultDraft(c.rx, imaging.id, { narrative: "Laudo sintético", content: {}, expectedVersion: performed.item.version, idempotencyKey: "history-draft" });
    const sample = await c.service.receiveSample(c.lab, [request.items[1].id], { accessionCode: "ACC-HISTORY", sampleType: "EDTA", expectedVersion: 1, idempotencyKey: "history-sample" });
    const orphanEntities = [
      { entityType: "DiagnosticRequestItem", entityId: "orphan-item" },
      { entityType: "Sample", entityId: "orphan-sample" },
      { entityType: "Result", entityId: "orphan-result" },
      { entityType: "ResultVersion", entityId: "orphan-version" },
      { entityType: "ResultVersion", entityId: "version-orphan-item" },
      { entityType: "Procedure", entityId: "orphan-procedure" },
      { entityType: "ProcedureSchedule", entityId: "orphan-schedule" },
      { entityType: "Attachment", entityId: "orphan-attachment" },
      { entityType: "Attachment", entityId: "attachment-orphan-result" }
    ];
    const orphanEvents: AuditEvent[] = orphanEntities.map((entity, index) => ({ ...entity, id: `orphan-event-${index}`, eventType: "HistoricalEvent", occurredAt: "2026-10-04T10:00:00.000Z", metadata: {}, correlationId: "orphan-context" }));
    const upload = await c.service.createAttachmentUploadSession(c.rx, draft.version.id, { filename: "history.pdf", mimeType: "application/pdf", sizeBytes: 1, checksum: "a".repeat(64), expectedVersion: draft.version.version, idempotencyKey: "history-attachment" });
    const attachment = c.store.getState().attachments.find((entry) => entry.id === upload.attachment.id)!;
    await c.store.transaction((state) => ({ state: {
      ...state,
      items: [...state.items, { ...imaging, id: "orphan-item", requestId: "missing-request" }],
      samples: [...state.samples, { ...sample.sample, id: "orphan-sample", requestId: "missing-request" }],
      results: [...state.results, { ...draft.result, id: "orphan-result", itemId: "missing-item" }],
      resultVersions: [...state.resultVersions, { ...draft.version, id: "orphan-version", resultId: "missing-result" }, { ...draft.version, id: "version-orphan-item", resultId: "orphan-result" }],
      procedures: [...state.procedures, { ...performed.procedure, id: "orphan-procedure", itemId: "missing-item" }],
      schedules: [...state.schedules, { id: "orphan-schedule", procedureId: "missing-procedure", startsAt: "2026-10-04T10:00:00.000Z", endsAt: "2026-10-04T10:30:00.000Z", resource: "HISTORICAL", status: "COMPLETED", actorId: c.rx.id, createdAt: "2026-10-04T09:00:00.000Z", version: 1 }],
      attachments: [...state.attachments, { ...attachment, id: "orphan-attachment", resultVersionId: "missing-version" }, { ...attachment, id: "attachment-orphan-result", resultVersionId: "orphan-version" }],
      auditEvents: [...state.auditEvents, ...orphanEvents]
    }, result: undefined }));
    const history = await c.service.timeline(c.vet, request.id, undefined, { limit: 100 });
    expect(history.items).toEqual(expect.arrayContaining([expect.objectContaining({ eventType: "DiagnosticRequestCreated", entityId: request.id }), expect.objectContaining({ eventType: "ResultDraftCreated", entityId: draft.result.id })]));
    expect(history.items.filter((event) => event.correlationId === "orphan-context")).toEqual([]);
    expect((await c.service.listAuditEvents(c.manager, { limit: 100 })).items.filter((event) => event.correlationId === "orphan-context")).toEqual([]);
  });
});
