import { describe, expect, it, vi } from "vitest";
import type { AuditEntity, AuditEvent, AuditTransactionReader, StateStore, StoreState, User } from "../domain/models";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { createApplicationService } from "./service";

const occurredAt = "2026-08-20T12:00:00.000Z";

function event(entityType: string, entityId: string, id = `${entityType}:${entityId}`, actorId?: string): AuditEvent {
  return { id, entityType, entityId, actorId, eventType: "Changed", correlationId: "audit-read-test", metadata: {}, occurredAt };
}

function fixtureState(): StoreState {
  const state = createDemoState("audit-read-application-password");
  state.requests = [{
    id: "request-visible", requestCode: "EX-TEST-0001", patientId: "patient-thor", encounterId: "encounter-thor",
    requesterId: "user-vet", requestingDepartmentCode: "INPATIENT", priority: "ROUTINE", aggregateStatus: "REQUESTED",
    itemIds: ["item-lab", "item-rx"], createdAt: occurredAt, updatedAt: occurredAt, version: 1
  }];
  state.items = [state.services[0], state.services[2]].map((service, index) => ({
    id: index === 0 ? "item-lab" : "item-rx", requestId: "request-visible", serviceId: service.id,
    departmentCode: service.departmentCode, workflowType: service.workflowType, priority: "ROUTINE", status: "REQUESTED",
    requestedAt: occurredAt, slaStartedAt: occurredAt, dueAt: occurredAt, slaPolicyVersion: 1, version: 1
  }));
  state.samples = [
    { id: "sample-lab", requestId: "request-visible", accessionCode: "ACC-LAB", sampleType: "EDTA", status: "EXPECTED", itemIds: ["item-lab"], version: 1 },
    { id: "sample-mixed", requestId: "request-visible", accessionCode: "ACC-MIX", sampleType: "EDTA", status: "EXPECTED", itemIds: ["item-lab", "item-rx"], version: 1 },
    { id: "sample-orphan", requestId: "request-missing", accessionCode: "ACC-ORPHAN", sampleType: "EDTA", status: "EXPECTED", itemIds: [], version: 1 }
  ];
  state.results = ["lab", "rx"].map((sector) => ({ id: `result-${sector}`, itemId: `item-${sector}`, currentVersionId: `version-${sector}`, lifecycleStatus: "RELEASED", needsReReview: false, version: 1 }));
  state.resultVersions = ["lab", "rx"].map((sector) => ({
    id: `version-${sector}`, resultId: `result-${sector}`, sequence: 1, status: "RELEASED", content: {}, narrative: "Laudo",
    authorId: sector === "lab" ? "user-lab" : "user-rx", createdAt: occurredAt, critical: false, needsReReview: false, version: 1
  }));
  state.procedures = [{ id: "procedure-rx", itemId: "item-rx", workflowType: "RADIOLOGY", status: "SCHEDULED", scheduleIds: ["schedule-rx"], version: 1 }];
  state.schedules = [{ id: "schedule-rx", procedureId: "procedure-rx", startsAt: occurredAt, endsAt: occurredAt, resource: "RX", status: "SCHEDULED", actorId: "user-rx", createdAt: occurredAt, version: 1 }];
  state.attachments = ["lab", "rx"].map((sector) => ({
    id: `attachment-${sector}`, resultVersionId: `version-${sector}`, safeName: "laudo.pdf", storageKey: "private/laudo",
    detectedMime: "application/pdf", sizeBytes: 10, checksum: "a".repeat(64), scanStatus: "CLEAN", uploadStatus: "FINALIZED", createdBy: "user-lab", createdAt: occurredAt
  }));
  const entities: AuditEntity[] = [
    ...state.requests.map(({ id }) => ({ entityType: "DiagnosticRequest", entityId: id })),
    ...state.items.map(({ id }) => ({ entityType: "DiagnosticRequestItem", entityId: id })),
    ...state.samples.map(({ id }) => ({ entityType: "Sample", entityId: id })),
    ...state.results.map(({ id }) => ({ entityType: "Result", entityId: id })),
    ...state.resultVersions.map(({ id }) => ({ entityType: "ResultVersion", entityId: id })),
    ...state.procedures.map(({ id }) => ({ entityType: "Procedure", entityId: id })),
    ...state.schedules.map(({ id }) => ({ entityType: "ProcedureSchedule", entityId: id })),
    ...state.attachments.map(({ id }) => ({ entityType: "Attachment", entityId: id })),
    ...state.users.map(({ id }) => ({ entityType: "User", entityId: id })),
    ...state.services.map(({ id }) => ({ entityType: "DiagnosticService", entityId: id })),
    { entityType: "ReasonCode", entityId: "deleted-reason" },
    { entityType: "ResultVersion", entityId: "deleted-version" },
    { entityType: "Unknown", entityId: "item-rx" }
  ];
  state.auditEvents = entities.map(({ entityType, entityId }) => event(entityType, entityId));
  return state;
}

function actor(state: StoreState, role: User["role"]): User {
  return state.users.find((user) => user.role === role)!;
}

// Exercise application reads with history absent from the aggregate snapshot.
// The backing store remains a normal MemoryStore with its own audit history.
function seam(memory: MemoryStore, options: { legacyTransaction?: boolean } = {}) {
  const readState = vi.fn(async () => ({ ...memory.getState(), auditEvents: [] }));
  const readAuditEvents = vi.fn(memory.readAuditEvents.bind(memory));
  const readAuditActors = vi.fn(memory.readAuditActors.bind(memory));
  const hasAuditEvent = vi.fn<AuditTransactionReader["hasAuditEvent"]>();
  const transaction: StateStore["transaction"] = (operation) => memory.transaction(async (original, reader) => {
    hasAuditEvent.mockImplementation((query) => reader!.hasAuditEvent(query));
    if (options.legacyTransaction) return operation(original);
    const outcome = await operation({ ...original, auditEvents: [] }, { hasAuditEvent });
    return { ...outcome, state: { ...outcome.state, auditEvents: [...original.auditEvents, ...outcome.state.auditEvents] } };
  });
  const store = new Proxy(memory, {
    get(target, property) {
      if (property === "readState") return readState;
      if (property === "readAuditEvents") return readAuditEvents;
      if (property === "readAuditActors") return readAuditActors;
      if (property === "transaction") return transaction;
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  return { service: createApplicationService(store), readAuditEvents, readAuditActors, hasAuditEvent, memory };
}

const labEntities = [
  "DiagnosticRequest:request-visible", "DiagnosticRequestItem:item-lab", "Sample:sample-lab",
  "Result:result-lab", "ResultVersion:version-lab", "Attachment:attachment-lab"
];

describe("application historical audit read seam", () => {
  it("keeps ADMIN unresolved history without admitting any resolved clinical pair", async () => {
    const state = fixtureState();
    const context = seam(new MemoryStore(state));
    const page = await context.service.listAuditEvents(actor(state, "ADMIN"), { limit: 100 });
    expect(page.items.map((entry) => entry.id)).toEqual(state.auditEvents
      .filter((entry) => ["User", "DiagnosticService", "ReasonCode", "Unknown"].includes(entry.entityType) || ["sample-orphan", "deleted-version"].includes(entry.entityId))
      .sort((left, right) => left.id.localeCompare(right.id)).map((entry) => entry.id));
    expect(page.total).toBe(page.items.length);
    expect(page.nextCursor).toBeUndefined();
    expect(context.readAuditEvents.mock.calls[0][0].scope.unresolved?.resolvedEntities).toContainEqual({ entityType: "Attachment", entityId: "attachment-rx" });
    expect(context.readAuditEvents.mock.calls[0][0].scope.unresolved?.resolvedEntities).not.toContainEqual({ entityType: "Sample", entityId: "sample-orphan" });
  });

  it("keeps manager department, whole-sample and management scope including deleted reasons", async () => {
    const state = fixtureState();
    actor(state, "MANAGER").managedDepartmentCodes = ["LABORATORY"];
    const context = seam(new MemoryStore(state));
    const page = await context.service.listAuditEvents(actor(state, "MANAGER"), { limit: 100 });
    expect(page.items.map((entry) => entry.id).sort()).toEqual([
      ...labEntities, "ReasonCode:deleted-reason", "DiagnosticService:service-hemogram", "DiagnosticService:service-crp", "User:user-lab", "User:user-vet"
    ].sort());
    expect(context.readAuditEvents.mock.calls[0][0].scope.entityTypes).toEqual(["ReasonCode"]);
    expect(page.items.some((entry) => entry.entityId === "sample-mixed")).toBe(false);
  });

  it("pages permitted request entities with tied timestamps and stable totals", async () => {
    const state = fixtureState();
    const context = seam(new MemoryStore(state));
    const lab = actor(state, "LAB_TECH");
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await context.service.timeline(lab, "request-visible", "item-lab", { limit: 2, cursor });
      expect(page.total).toBe(labEntities.length);
      expect(page.limit).toBe(2);
      ids.push(...page.items.map((entry) => entry.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(ids).toEqual([...labEntities].sort((left, right) => left.localeCompare(right)));
    expect(context.readAuditEvents.mock.calls.every(([query]) => query.order === "asc")).toBe(true);
    await expect(context.service.timeline(lab, "request-visible", "item-rx")).rejects.toMatchObject({ status: 404 });
    expect(context.readAuditEvents).toHaveBeenCalledTimes(3);
  });

  it("preserves descending audit pagination and ascending IDs for timestamp ties", async () => {
    const state = fixtureState();
    state.auditEvents = [
      { ...event("ReasonCode", "old", "c"), occurredAt: "2026-08-19T12:00:00.000Z" },
      event("ReasonCode", "new", "b"), event("ReasonCode", "new", "a")
    ];
    const context = seam(new MemoryStore(state));
    const admin = actor(state, "ADMIN");
    const first = await context.service.listAuditEvents(admin, { limit: 1 });
    const second = await context.service.listAuditEvents(admin, { limit: 1, cursor: first.nextCursor });
    const third = await context.service.listAuditEvents(admin, { limit: 1, cursor: second.nextCursor });
    expect([first.items[0].id, second.items[0].id, third.items[0].id]).toEqual(["a", "b", "c"]);
    expect([first.total, second.total, third.total]).toEqual([3, 3, 3]);
    expect(third.nextCursor).toBeUndefined();
  });

  it("includes every resolved clinical entity type in the veterinarian timeline", async () => {
    const state = fixtureState();
    const context = seam(new MemoryStore(state));
    const page = await context.service.timeline(actor(state, "VETERINARIAN"), "request-visible", undefined, { limit: 100 });
    expect(page.items.map((entry) => entry.id).sort()).toEqual([
      ...labEntities, "DiagnosticRequestItem:item-rx", "Sample:sample-mixed", "Result:result-rx", "ResultVersion:version-rx",
      "Procedure:procedure-rx", "ProcedureSchedule:schedule-rx", "Attachment:attachment-rx"
    ].sort());
  });

  it("passes binary timestamp ties through pagination without skipped IDs", async () => {
    const state = fixtureState();
    state.auditEvents = ["é", "a", "Z", "_"].map((id) => event("DiagnosticRequestItem", "item-lab", id));
    const context = seam(new MemoryStore(state));
    const lab = actor(state, "LAB_TECH");
    const first = await context.service.timeline(lab, "request-visible", undefined, { limit: 2 });
    const second = await context.service.timeline(lab, "request-visible", undefined, { limit: 2, cursor: first.nextCursor });
    expect([...first.items, ...second.items].map((entry) => entry.id)).toEqual(["Z", "_", "a", "é"]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("returns all patient audit history through bounded pages, beyond the request page", async () => {
    const state = fixtureState();
    state.requests.push({ ...state.requests[0], id: "request-older", requestCode: "EX-TEST-0002", itemIds: ["item-older"], createdAt: "2026-08-19T12:00:00.000Z" });
    state.items.push({ ...state.items[0], id: "item-older", requestId: "request-older" });
    state.auditEvents = [
      ...Array.from({ length: 205 }, (_, index) => event("DiagnosticRequestItem", "item-lab", `history-${String(index).padStart(3, "0")}`)),
      event("DiagnosticRequest", "request-older", "older-request"), event("DiagnosticRequestItem", "item-rx", "hidden-item")
    ];
    const context = seam(new MemoryStore(state));
    const workspace = await context.service.getPatientDiagnostics(actor(state, "LAB_TECH"), "patient-thor", { limit: 1 });
    expect(workspace.items).toHaveLength(1);
    expect(workspace.nextCursor).toBeTruthy();
    expect(workspace.events).toHaveLength(206);
    expect(workspace.events.map((entry) => entry.id)).toContain("older-request");
    expect(workspace.events.map((entry) => entry.id)).not.toContain("hidden-item");
    expect(new Set(workspace.events.map((entry) => entry.id)).size).toBe(206);
    expect(context.readAuditEvents.mock.calls.map(([query]) => query.limit)).toEqual([100, 100, 100]);
    expect(context.readAuditEvents.mock.calls[1][0].cursor).toEqual({ occurredAt, id: "history-099" });
  });

  it("matches distinct reviewer identities across unexpected types only for visible IDs", async () => {
    const state = fixtureState();
    state.auditEvents = [
      event("Unknown", "item-lab", "reviewer-1", "user-admin"), event("Unknown", "item-lab", "reviewer-2", "user-admin"),
      event("Unknown", "item-rx", "reviewer-hidden", "user-us")
    ];
    const context = seam(new MemoryStore(state));
    const lab = actor(state, "LAB_TECH");
    expect((await context.service.search(lab, actor(state, "ADMIN").email)).items.map((entry) => entry.id)).toEqual(["request-visible"]);
    expect((await context.service.search(lab, actor(state, "ULTRASOUND_TEAM").email)).total).toBe(0);
    expect(context.readAuditActors.mock.calls[0][0]).toEqual([
      { entityType: "DiagnosticRequest", entityId: "request-visible" }, { entityType: "DiagnosticRequestItem", entityId: "item-lab" }
    ]);
    await expect(context.readAuditActors.mock.results[0].value).resolves.toEqual([{ entityId: "item-lab", actorId: "user-admin" }]);
    // Only the users matching the query are looked up in the audit trail (D-046).
    expect(context.readAuditActors.mock.calls[0][1]).toEqual([actor(state, "ADMIN").id]);
    expect(context.readAuditEvents).not.toHaveBeenCalled();
  });

  it("does not read the audit trail when the query matches no user (request codes, exam names)", async () => {
    const state = fixtureState();
    state.auditEvents = [event("Unknown", "item-lab", "reviewer-1", "user-admin")];
    const context = seam(new MemoryStore(state));
    const lab = actor(state, "LAB_TECH");
    const byExam = await context.service.search(lab, "HEMOGRAM", { types: ["REQUEST", "ITEM"] });
    expect(byExam.items.length).toBeGreaterThan(0);
    expect(context.readAuditActors).not.toHaveBeenCalled();
    // An upper-case, accented name ("ADMINISTRAÇÃO TÉCNICA") still matches its user and reads that actor only.
    expect((await context.service.search(lab, actor(state, "ADMIN").displayName.toUpperCase())).items.map((entry) => entry.id)).toEqual(["request-visible"]);
    expect(context.readAuditActors).toHaveBeenCalledTimes(1);
  });

  it("does not query history after invalid input or unauthorized access", async () => {
    const state = fixtureState();
    const context = seam(new MemoryStore(state));
    await expect(context.service.listAuditEvents(actor(state, "LAB_TECH"))).rejects.toMatchObject({ code: "SCOPE_DENIED", status: 404 });
    await expect(context.service.listAuditEvents(actor(state, "ADMIN"), { cursor: "bad" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(context.service.timeline(actor(state, "LAB_TECH"), "request-visible", undefined, { limit: 101 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(context.service.getPatientDiagnostics(actor(state, "LAB_TECH"), "patient-mel")).rejects.toMatchObject({ status: 404 });
    await expect(context.service.search(actor(state, "LAB_TECH"), "x")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(context.readAuditEvents).not.toHaveBeenCalled();
    expect(context.readAuditActors).not.toHaveBeenCalled();
  });

  it("fails the workspace read if historical pagination cannot advance", async () => {
    const state = fixtureState();
    const context = seam(new MemoryStore(state));
    const items = [event("DiagnosticRequestItem", "item-lab", "same-cursor")];
    context.readAuditEvents.mockResolvedValue({ items, total: 2, hasMore: true });
    await expect(context.service.getPatientDiagnostics(actor(state, "LAB_TECH"), "patient-thor")).rejects.toThrow("AUDIT_READ_CURSOR_NOT_ADVANCING");
    expect(context.readAuditEvents).toHaveBeenCalledTimes(2);
  });
});

function reviewFixture(events: AuditEvent[], legacyTransaction = false) {
  const state = fixtureState();
  state.items[0] = { ...state.items[0], status: "RESULT_AVAILABLE", currentResultId: "result-lab" };
  state.auditEvents = events;
  return { ...seam(new MemoryStore(state), { legacyTransaction }), vet: actor(state, "VETERINARIAN"), lab: actor(state, "LAB_TECH"), input: { versionId: "version-lab", expectedVersion: 1, idempotencyKey: "audit-read-review" } };
}

function viewed(entityType = "ResultVersion", entityId = "version-lab", actorId = "user-vet", eventType = "ResultViewed") {
  return { ...event(entityType, entityId, "viewed", actorId), eventType };
}

describe("transactional ResultViewed prerequisite", () => {
  it("accepts the exact viewed version and actor from transaction history absent in the snapshot", async () => {
    const context = reviewFixture([viewed()]);
    const reviewed = await context.service.reviewResult(context.vet, "result-lab", context.input);
    expect(reviewed.item.status).toBe("REVIEWED");
    expect(context.hasAuditEvent).toHaveBeenCalledExactlyOnceWith({ eventType: "ResultViewed", entityType: "ResultVersion", entityId: "version-lab", actorId: "user-vet" });
    expect(context.memory.getState().auditEvents.map((entry) => entry.eventType)).toEqual(["ResultViewed", "ResultReviewed"]);
    const replay = await context.service.reviewResult(context.vet, "result-lab", context.input);
    expect(replay.item.status).toBe("REVIEWED");
    expect(context.hasAuditEvent).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing event", []], ["other actor", [viewed("ResultVersion", "version-lab", "user-lab")]],
    ["other version", [viewed("ResultVersion", "old-version")]], ["wrong entity type", [viewed("Result", "version-lab")]],
    ["read without explicit view", [viewed("ResultVersion", "version-lab", "user-vet", "ResultRead")]]
  ])("rejects %s without mutating clinical state", async (_description, events) => {
    const context = reviewFixture(events as AuditEvent[]);
    const before = context.memory.getState();
    await expect(context.service.reviewResult(context.vet, "result-lab", context.input)).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 });
    expect(context.memory.getState()).toEqual(before);
  });

  it("performs permission, stale-result and version checks before querying audit history", async () => {
    const context = reviewFixture([viewed()]);
    await expect(context.service.reviewResult(context.lab, "result-lab", context.input)).rejects.toMatchObject({ code: "SCOPE_DENIED", status: 404 });
    await expect(context.service.reviewResult(context.vet, "result-lab", { ...context.input, versionId: "old-version" })).rejects.toMatchObject({ code: "REVIEW_STALE" });
    await expect(context.service.reviewResult(context.vet, "result-lab", { ...context.input, expectedVersion: 9 })).rejects.toMatchObject({ code: "STALE_VERSION" });
    expect(context.hasAuditEvent).not.toHaveBeenCalled();
  });

  it("keeps critical acknowledgement ahead of the viewed prerequisite", async () => {
    const context = reviewFixture([viewed()]);
    await context.memory.transaction((state) => ({ state: { ...state, resultVersions: state.resultVersions.map((version) => version.id === "version-lab" ? { ...version, critical: true } : version) }, result: undefined }));
    await expect(context.service.reviewResult(context.vet, "result-lab", context.input)).rejects.toMatchObject({ code: "CRITICAL_ACK_REQUIRED" });
    expect(context.hasAuditEvent).not.toHaveBeenCalled();
  });

  it("propagates transaction history failures and leaves the result unrevised", async () => {
    const context = reviewFixture([viewed()]);
    const before = context.memory.getState();
    context.hasAuditEvent.mockRejectedValueOnce(new Error("AUDIT_UNAVAILABLE"));
    await expect(context.service.reviewResult(context.vet, "result-lab", context.input)).rejects.toThrow("AUDIT_UNAVAILABLE");
    expect(context.memory.getState()).toEqual(before);
  });

  it("retains the original snapshot fallback for transaction test doubles without the reader", async () => {
    const context = reviewFixture([viewed()], true);
    expect((await context.service.reviewResult(context.vet, "result-lab", context.input)).item.status).toBe("REVIEWED");
    expect(context.hasAuditEvent).not.toHaveBeenCalled();
    const missing = reviewFixture([], true);
    await expect(missing.service.reviewResult(missing.vet, "result-lab", missing.input)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
