import { describe, expect, it, vi } from "vitest";
import type { HospitalTaskCreateInput } from "./hospital-task-types";
import { hospitalOperationFixture } from "@/test/hospital-operation-fixtures";
import { systemGroupId } from "../security/access-group-policy";

async function setup() {
  const c = hospitalOperationFixture();
  await c.store.transaction((state) => ({ state: { ...state, users: [...state.users, { ...state.users[0], id: "super", role: "SUPERADMIN", accessGroupId: systemGroupId("SUPERADMIN") }, { ...state.users.find((user) => user.id === "user-vet")!, id: "vet-b" }], departments: state.departments.map((department) => department.code === "INPATIENT" ? { ...department, memberUserIds: [...department.memberUserIds, "vet-b"] } : department) }, result: undefined }));
  const actor = c.user("user-vet"); const superuser = c.user("super");
  const body = { title: "Conferência sintética", typeId: "hospital-task-type-routine", departmentCode: "INPATIENT", priority: "ROUTINE" as const, responsibleUserId: actor.id };
  const create = (key: string, patch: Partial<HospitalTaskCreateInput> = {}) => c.service.createHospitalTask(actor, { ...body, ...patch, idempotencyKey: key });
  const finish = async (id: string) => { const current = c.store.getState().hospitalTasks.find((task) => task.id === id)!; const started = await c.service.commandHospitalTask(actor, id, { command: "START", expectedVersion: current.version, idempotencyKey: `${id}:start` }); return c.service.commandHospitalTask(actor, id, { command: "COMPLETE", expectedVersion: started.task.version, idempotencyKey: `${id}:complete` }); };
  return { ...c, actor, superuser, body, create, finish };
}

describe("published and draft task retries and execution guards", () => {
  it("replays current draft creation and publication once, refusing draft hierarchy and post-publication commands", async () => {
    const c = await setup(); const input = { ...c.body, idempotencyKey: "draft-replay" };
    const draft = await c.service.createHospitalTaskDraft(c.actor, input);
    expect((await c.service.createHospitalTaskDraft(c.actor, input)).task.id).toBe(draft.task.id);
    await expect(c.service.createHospitalTaskDraft(c.actor, { ...c.body, parentTaskId: draft.task.id, idempotencyKey: "draft-parent" })).rejects.toMatchObject({ status: 400 });
    const command = { command: "PUBLISH" as const, expectedVersion: 1, idempotencyKey: "publish-replay" };
    const published = await c.service.commandHospitalTaskDraft(c.actor, draft.task.id, command);
    expect((await c.service.commandHospitalTaskDraft(c.actor, draft.task.id, command)).task.version).toBe(2);
    expect((await c.service.createHospitalTaskDraft(c.actor, input)).task.isDraft).toBe(false);
    await expect(c.service.commandHospitalTaskDraft(c.actor, draft.task.id, { command: "DISCARD", expectedVersion: 2, idempotencyKey: "published-discard" })).rejects.toMatchObject({ status: 409 });
    expect(published.task.startedAt).toBeUndefined(); expect(c.store.getState().hospitalTasks).toHaveLength(1);
  });
  it("replays changed task metadata from the current record and preserves explicit nullable planning edits", async () => {
    const c = await setup(); const task = await c.create("metadata", { description: "Anterior", plannedStartAt: "2026-10-12T10:00:00Z", plannedEndAt: "2026-10-12T11:00:00Z" });
    await expect(c.service.updateHospitalTask(c.actor, task.task.id, { expectedVersion: 1, idempotencyKey: "empty" })).rejects.toMatchObject({ status: 400 });
    const input = { title: "Conferência atual", description: " ", descriptionContent: { type: "hospital-document" as const, version: 1 as const, blocks: [{ type: "paragraph" as const, content: [{ text: "Descrição rica" }] }] }, plannedStartAt: null, plannedEndAt: null, parentTaskId: null, estimatedMinutes: 15, labels: ["equipe"], externalReferences: [{ label: "Documento", url: "https://example.test/protocol" }], expectedVersion: 1, idempotencyKey: "metadata-update" };
    const updated = await c.service.updateHospitalTask(c.actor, task.task.id, input);
    expect(updated.task).toMatchObject({ version: 2, title: "Conferência atual", estimatedMinutes: 15, labels: ["equipe"] });
    expect(updated.task.description).toBeUndefined(); expect(updated.task.plannedStartAt).toBeUndefined(); expect(updated.task.plannedEndAt).toBeUndefined();
    expect((await c.service.updateHospitalTask(c.actor, task.task.id, input)).task.version).toBe(2);
    await c.service.commandHospitalTask(c.actor, task.task.id, { command: "START", expectedVersion: 2, idempotencyKey: "metadata-start" });
    await expect(c.service.updateHospitalTask(c.actor, task.task.id, { documentIds: [], expectedVersion: 3, idempotencyKey: "after-start-docs" })).rejects.toMatchObject({ status: 409 });
  });
  it("denies execution by a visible nonresponsible colleague and incompatible phase commands", async () => {
    const c = await setup(); const task = await c.create("phase-guards");
    await expect(c.service.commandHospitalTask(c.user("vet-b"), task.task.id, { command: "START", expectedVersion: 1, idempotencyKey: "not-responsible" })).rejects.toMatchObject({ status: 404 });
    await expect(c.service.commandHospitalTask(c.actor, task.task.id, { command: "COMPLETE", expectedVersion: 1, idempotencyKey: "not-started" })).rejects.toMatchObject({ status: 409 });
    const start = { command: "START" as const, expectedVersion: 1, idempotencyKey: "start-once" };
    await c.service.commandHospitalTask(c.actor, task.task.id, start);
    expect((await c.service.commandHospitalTask(c.actor, task.task.id, start)).task.version).toBe(2);
    await expect(c.service.commandHospitalTask(c.actor, task.task.id, { command: "START", expectedVersion: 2, idempotencyKey: "double-start" })).rejects.toMatchObject({ status: 409 });
    await c.store.transaction((state) => ({ state: { ...state, hospitalTasks: state.hospitalTasks.map((entry) => entry.id === task.task.id ? { ...entry, startedAt: "2090-01-01T00:00:00.000Z" } : entry) }, result: undefined }));
    await expect(c.service.commandHospitalTask(c.actor, task.task.id, { command: "COMPLETE", expectedVersion: 2, idempotencyKey: "future-record" })).rejects.toMatchObject({ status: 409 });
  });
  it("detaches hierarchy and clears responsible/team selections only through delegated authority", async () => {
    const c = await setup(); const parent = await c.create("parent"); const child = await c.create("child", { parentTaskId: parent.task.id });
    expect((await c.service.updateHospitalTask(c.actor, child.task.id, { parentTaskId: null, expectedVersion: 1, idempotencyKey: "detach" })).task.parentTaskId).toBeUndefined();
    const assigned = await c.service.assignHospitalTask(c.superuser, child.task.id, { responsibleUserId: null, executorTeamUserIds: [], participantUserIds: [], expectedVersion: 2, idempotencyKey: "clear-members" });
    expect(assigned.task.responsibleUserId).toBeUndefined(); expect(assigned.task.executorTeamUserIds).toEqual([]);
    const claim = { responsibleUserId: c.actor.id, expectedVersion: 3, idempotencyKey: "reclaim" };
    await c.service.assignHospitalTask(c.actor, child.task.id, claim);
    expect((await c.service.assignHospitalTask(c.actor, child.task.id, claim)).task.version).toBe(4);
  });
  it("uses completed prerequisites and retains original task state snapshots through type revisions", async () => {
    const c = await setup(); const prerequisite = await c.create("done-first"); await c.finish(prerequisite.task.id);
    const dependent = await c.create("after-done");
    const linked = await c.service.putHospitalTaskDependency(c.actor, dependent.task.id, { targetType: "HOSPITAL_TASK", targetId: prerequisite.task.id, blocks: "START", active: true, expectedVersion: 1, idempotencyKey: "completed-link" });
    expect((await c.service.commandHospitalTask(c.actor, dependent.task.id, { command: "START", expectedVersion: linked.task.version, idempotencyKey: "allowed-start" })).task.phase).toBe("IN_PROGRESS");
    const states = c.store.getState().hospitalTaskTypes[0].states.map((state) => ({ ...state, code: `CUSTOM_${state.code}` }));
    const input = { code: "CUSTOM_BOUNDARY", name: "Fluxo sintético", careContextRequired: false, states, idempotencyKey: "custom-type" };
    const type = await c.service.createHospitalTaskType(c.user("user-admin"), input);
    expect(await c.service.createHospitalTaskType(c.user("user-admin"), input)).toEqual(type);
    await expect(c.service.createHospitalTaskType(c.user("user-admin"), { ...input, idempotencyKey: "duplicate-type" })).rejects.toMatchObject({ status: 409 });
    const task = await c.create("custom-snapshot", { typeId: type.id });
    const update = { name: "Nome futuro", careContextRequired: true, expectedVersion: 1, idempotencyKey: "type-change" };
    await c.service.updateHospitalTaskType(c.user("user-admin"), type.id, update);
    expect((await c.service.updateHospitalTaskType(c.user("user-admin"), type.id, update)).version).toBe(2);
    expect((await c.service.commandHospitalTask(c.actor, task.task.id, { command: "START", stateCode: "CUSTOM_IN_PROGRESS", expectedVersion: 1, idempotencyKey: "snapshot-start" })).task.status).toBe("CUSTOM_IN_PROGRESS");
  });
  it("records a no-op context retry without changing version and blocks native child/dependency context transfers", async () => {
    const c = await setup(); const task = await c.create("same-context");
    const input = { patientId: null, encounterId: null, expectedVersion: 1, idempotencyKey: "same-context-command" };
    expect((await c.service.updateHospitalTaskContext(c.actor, task.task.id, input)).task.version).toBe(1);
    expect((await c.service.updateHospitalTaskContext(c.actor, task.task.id, input)).task.version).toBe(1);
    const child = await c.create("bound-child", { parentTaskId: task.task.id });
    const care = { patientId: "patient-thor", encounterId: "encounter-thor", expectedVersion: 1, idempotencyKey: "new-context" };
    await expect(c.service.updateHospitalTaskContext(c.actor, task.task.id, care)).rejects.toMatchObject({ status: 409 });
    await expect(c.service.updateHospitalTaskContext(c.actor, child.task.id, { ...care, idempotencyKey: "child-context" })).rejects.toMatchObject({ status: 409 });
    const another = await c.create("dependency-context");
    await c.service.putHospitalTaskDependency(c.actor, another.task.id, { targetType: "HOSPITAL_TASK", targetId: task.task.id, blocks: "START", active: true, expectedVersion: 1, idempotencyKey: "context-dep" });
    await expect(c.service.updateHospitalTaskContext(c.actor, another.task.id, { ...care, expectedVersion: 2, idempotencyKey: "dependency-context-command" })).rejects.toMatchObject({ status: 409 });
  });
});

describe("terminal archive and resumable partial batches", () => {
  it("replays an archive, rejects an already archived state and rechecks every batch action under current grants", async () => {
    const c = await setup(); const archived = await c.create("batch-terminal"); await c.finish(archived.task.id);
    const assign = await c.create("batch-assignment"); const priority = await c.create("batch-priority"); const execute = await c.create("batch-execution");
    const input = { operations: [{ action: "ARCHIVE" as const, taskId: archived.task.id, archived: true, expectedVersion: 3 }, { action: "ASSIGN" as const, taskId: assign.task.id, responsibleUserId: "vet-b", expectedVersion: 1 }, { action: "PRIORITY" as const, taskId: priority.task.id, priority: "EMERGENCY" as const, reason: "Reposição necessária", expectedVersion: 1 }, { action: "COMMAND" as const, taskId: execute.task.id, command: "START" as const, expectedVersion: 1 }], idempotencyKey: "all-actions" };
    const result = await c.service.batchHospitalTasks(c.superuser, input);
    expect(result.successCount).toBe(4); expect(result.failureCount).toBe(0);
    expect((await c.service.batchHospitalTasks(c.superuser, input)).successCount).toBe(4);
    await expect(c.service.setHospitalTaskArchived(c.superuser, archived.task.id, { archived: true, expectedVersion: 4, idempotencyKey: "already" })).rejects.toMatchObject({ status: 409 });
    const restore = { operations: [{ action: "ARCHIVE" as const, taskId: archived.task.id, archived: false, expectedVersion: 4 }], idempotencyKey: "restore-batch" };
    expect((await c.service.batchHospitalTasks(c.superuser, restore)).successCount).toBe(1);
    expect((await c.service.batchHospitalTasks(c.superuser, restore)).successCount).toBe(1);
    await c.store.transaction((state) => ({ state: { ...state, accessGroups: state.accessGroups.map((group) => group.id === c.superuser.accessGroupId ? { ...group, permissions: group.permissions.filter((permission) => !["hospital_task.assign", "hospital_task.priority.update", "hospital_task.restore"].includes(permission)) } : group) }, result: undefined }));
    const current = await c.service.batchHospitalTasks(c.superuser, input);
    expect(current.successCount).toBe(2); expect(current.failureCount).toBe(2);
    expect((await c.service.batchHospitalTasks(c.superuser, restore)).items[0]).toMatchObject({ ok: false, error: { status: 404 } });
  });
  it("retains a batch receipt after a transient storage failure and resumes native idempotent operations", async () => {
    const c = await setup(); const task = await c.create("transient");
    const transaction = c.store.transaction.bind(c.store); let calls = 0;
    const spy = vi.spyOn(c.store, "transaction").mockImplementation(async (operation) => { if (++calls === 2) throw new Error("synthetic storage interruption"); return transaction(operation); });
    const input = { operations: [{ action: "COMMAND" as const, taskId: task.task.id, command: "START" as const, expectedVersion: 1 }], idempotencyKey: "resume" };
    await expect(c.service.batchHospitalTasks(c.actor, input)).rejects.toThrow("storage interruption");
    expect(c.store.getState().hospitalTasks[0].phase).toBe("PENDING"); spy.mockRestore();
    expect((await c.service.batchHospitalTasks(c.actor, input)).successCount).toBe(1);
    expect((await c.service.batchHospitalTasks(c.actor, input)).successCount).toBe(1);
    expect(c.store.getState().hospitalTasks[0].version).toBe(2);
  });
  it("returns the current archived record on replay without a second history event", async () => {
    const c = await setup(); const task = await c.create("archive-retry"); await c.finish(task.task.id);
    const input = { archived: true, expectedVersion: 3, idempotencyKey: "archive-retry-command" };
    const result = await c.service.setHospitalTaskArchived(c.actor, task.task.id, input);
    expect((await c.service.setHospitalTaskArchived(c.actor, task.task.id, input)).task).toEqual(result.task);
    expect(c.store.getState().auditEvents.filter((event) => event.eventType === "HospitalTaskArchived")).toHaveLength(1);
  });
});

describe("task history and context without inherited grants", () => {
  it("preserves an attached plan's context and never changes linked clinical work through a context edit", async () => {
    const c = await setup(); const task = await c.create("planned-care", { patientId: "patient-thor", encounterId: "encounter-thor" });
    const plan = await c.service.createHospitalPlan(c.actor, { title: "Plano com atividade", objective: "Conferir", patientId: "patient-thor", encounterId: "encounter-thor", departmentCodes: ["INPATIENT"], idempotencyKey: "context-plan" });
    await c.service.putHospitalPlanLink(c.actor, plan.plan.id, { stepId: plan.plan.steps[0].id, targetType: "HOSPITAL_TASK", targetId: task.task.id, active: true, expectedVersion: 1, idempotencyKey: "plan-task" });
    await expect(c.service.updateHospitalTaskContext(c.actor, task.task.id, { patientId: null, encounterId: null, expectedVersion: 1, idempotencyKey: "unlink-context" })).rejects.toMatchObject({ status: 409 });
    expect((await c.service.listHospitalTasks(c.actor, { planId: plan.plan.id })).items.map((view) => view.task.id)).toEqual([task.task.id]);
    expect((await c.service.searchPlanner(c.actor, "", { planId: plan.plan.id, types: ["HOSPITAL_TASK"] })).total).toBe(1);
  });
  it("redacts revoked calendar, patient, encounter and legacy reference identifiers from a still-visible history", async () => {
    const c = await setup(); const task = await c.create("history-redaction");
    const other = await c.service.createHospitalTask(c.superuser, { ...c.body, title: "Setor restrito", departmentCode: "LABORATORY", responsibleUserId: "user-lab", idempotencyKey: "history-other" });
    await c.store.transaction((state) => ({ state: { ...state, auditEvents: [...state.auditEvents, { ...state.auditEvents.find((event) => event.entityId === task.task.id)!, id: "legacy-task-reference", metadata: { scheduleId: "schedule-private", scheduleVersion: 7, resourceIds: JSON.stringify(["resource-private"]), startsAt: "2026-10-12T10:00:00Z", endsAt: "2026-10-12T11:00:00Z", previousPatientId: "patient-thor", encounterId: "encounter-thor", previousEncounterId: "missing", parentTaskId: other.task.id, previousParentTaskId: "missing", targetType: "UNKNOWN_LEGACY", targetId: "hidden-target", grantsChanged: false } }], users: state.users.map((user) => user.id === c.actor.id ? { ...user, patientIds: [] } : user), accessGroups: state.accessGroups.map((group) => group.id === c.actor.accessGroupId ? { ...group, permissions: group.permissions.filter((permission) => permission !== "hospital_calendar.view") } : group) }, result: undefined }));
    const history = await c.service.getHospitalTaskHistory(c.actor, task.task.id, { limit: 1 });
    expect(history.total).toBe(2); expect(history.nextCursor).toBeDefined();
    const combined = [...history.items, ...(await c.service.getHospitalTaskHistory(c.actor, task.task.id, { limit: 1, cursor: history.nextCursor })).items];
    expect(combined.find((event) => event.id === "legacy-task-reference")?.metadata).toEqual({ targetType: "UNKNOWN_LEGACY", grantsChanged: false });
    expect(JSON.stringify(combined)).not.toMatch(/schedule-private|resource-private|patient-thor|encounter-thor|hidden-target/);
    await expect(c.service.getHospitalTaskHistory(c.actor, task.task.id, { limit: 0 })).rejects.toMatchObject({ status: 400 });
    await expect(c.service.getHospitalTaskHistory(c.actor, task.task.id, { cursor: "x".repeat(2001) })).rejects.toMatchObject({ status: 400 });
  });
});

describe("retained task links under current policy", () => {
  it("changes an existing dependency revision and removes its blocking effect without changing the prerequisite", async () => {
    const c = await setup(); const source = await c.create("dependency-source"); const target = await c.create("dependency-target");
    await c.service.putHospitalTaskDependency(c.actor, target.task.id, { targetType: "HOSPITAL_TASK", targetId: source.task.id, blocks: "START", active: true, expectedVersion: 1, idempotencyKey: "dep-on" });
    const changed = await c.service.putHospitalTaskDependency(c.actor, target.task.id, { targetType: "HOSPITAL_TASK", targetId: source.task.id, blocks: "START", active: false, expectedVersion: 2, idempotencyKey: "dep-off" });
    expect(c.store.getState().hospitalTaskDependencies[0]).toMatchObject({ active: false, version: 2 });
    expect((await c.service.commandHospitalTask(c.actor, target.task.id, { command: "START", expectedVersion: changed.task.version, idempotencyKey: "dep-start" })).task.phase).toBe("IN_PROGRESS");
    expect(c.store.getState().hospitalTasks.find((task) => task.id === source.task.id)?.phase).toBe("PENDING");
  });
  it("captures a real approved document when publishing a draft and refuses publication after the document is retired", async () => {
    const c = await setup(); const document = await c.service.createHospitalDocument(c.user("user-admin"), { code: "DRAFT_GUIDE", title: "Instrução sintética", departmentCode: "INPATIENT", responsibleUserId: c.actor.id, content: { type: "hospital-document", version: 1, blocks: [{ type: "paragraph", content: [{ text: "Conferir material" }] }] }, idempotencyKey: "draft-guide" });
    const approved = await c.service.approveHospitalDocument(c.actor, document.document.id, { confirm: true, policyReference: "SYNTHETIC_ONLY", expectedVersion: 1, expectedDraftVersion: 1, idempotencyKey: "approve-guide" });
    const draft = await c.service.createHospitalTaskDraft(c.actor, { ...c.body, documentIds: [document.document.id], idempotencyKey: "document-draft" });
    const published = await c.service.commandHospitalTaskDraft(c.actor, draft.task.id, { command: "PUBLISH", expectedVersion: 1, idempotencyKey: "document-publish" });
    expect(published.task.documentSnapshots?.[0]).toMatchObject({ documentId: document.document.id, revision: 1, policyReference: "SYNTHETIC_ONLY" });
    const blocked = await c.service.createHospitalTaskDraft(c.actor, { ...c.body, documentIds: [document.document.id], idempotencyKey: "retired-document-draft" });
    await c.service.retireHospitalDocument(c.user("user-admin"), document.document.id, { expectedVersion: 2, expectedRevisionId: approved.document.currentPublishedRevisionId!, reason: "Retirada sintética", idempotencyKey: "retire-guide" });
    await expect(c.service.commandHospitalTaskDraft(c.actor, blocked.task.id, { command: "PUBLISH", expectedVersion: 1, idempotencyKey: "retired-publish" })).rejects.toMatchObject({ status: 409 });
    expect(c.store.getState().hospitalTasks.find((task) => task.id === blocked.task.id)?.isDraft).toBe(true);
  });
  it("allows an unlinked context move and its replay, but refuses moving a task with authored comments", async () => {
    const c = await setup(); const task = await c.create("context-replay");
    const input = { patientId: "patient-thor", encounterId: "encounter-thor", expectedVersion: 1, idempotencyKey: "move-context-once" };
    const moved = await c.service.updateHospitalTaskContext(c.actor, task.task.id, input);
    expect((await c.service.updateHospitalTaskContext(c.actor, task.task.id, input)).task).toEqual(moved.task);
    await c.service.createHospitalTaskComment(c.actor, task.task.id, { body: "Registro sintético", expectedVersion: 2, idempotencyKey: "context-comment" });
    await expect(c.service.updateHospitalTaskContext(c.actor, task.task.id, { patientId: null, encounterId: null, expectedVersion: 2, idempotencyKey: "move-with-comment" })).rejects.toMatchObject({ status: 409 });
  });
});

describe("retained attachment and reservation references", () => {
  it("refuses moving the context as soon as an attachment session references the task", async () => {
    const c = await setup(); const task = await c.create("attachment-context");
    await c.service.createHospitalTaskAttachmentSession(c.actor, task.task.id, { filename: "synthetic.pdf", mimeType: "application/pdf", sizeBytes: 12, checksum: "a".repeat(64), expectedVersion: 1, idempotencyKey: "context-attachment" });
    await expect(c.service.updateHospitalTaskContext(c.actor, task.task.id, { patientId: "patient-thor", encounterId: "encounter-thor", expectedVersion: 1, idempotencyKey: "attachment-context-move" })).rejects.toMatchObject({ status: 409 });
    expect(c.store.getState().hospitalTasks[0].patientId).toBeUndefined();
  });
  it.each(["COMPLETE", "CANCEL"] as const)("closes the current reservation atomically on %s while preserving unrelated future reservations", async (command) => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime("2026-10-11T10:00:00.000Z");
    try {
      const c = hospitalOperationFixture(); const resource = await c.resource(); const task = await c.task("terminal-reserved"); const other = await c.task("future-reserved"); const actor = c.user("user-us");
      const schedule = await c.service.reserveHospitalTaskSchedule(actor, task.task.id, { startsAt: "2026-10-11T10:00:00Z", endsAt: "2026-10-11T11:00:00Z", resourceIds: [resource.id], expectedVersion: 1, idempotencyKey: "terminal-booking" });
      const future = await c.service.reserveHospitalTaskSchedule(actor, other.task.id, { startsAt: "2026-10-11T12:00:00Z", endsAt: "2026-10-11T13:00:00Z", resourceIds: [resource.id], expectedVersion: 1, idempotencyKey: "future-booking" });
      await c.service.commandHospitalTask(actor, task.task.id, { command: "START", expectedVersion: 1, idempotencyKey: "reserved-start" });
      const terminal = await c.service.commandHospitalTask(actor, task.task.id, { command, reason: command === "CANCEL" ? "Cancelamento explícito" : undefined, expectedVersion: 2, idempotencyKey: "reserved-terminal" });
      expect(terminal.task.phase).toBe(command === "COMPLETE" ? "COMPLETED" : "CANCELLED");
      expect(c.store.getState().schedules.find((entry) => entry.id === schedule.id)).toMatchObject({ status: command === "COMPLETE" ? "COMPLETED" : "CANCELLED", version: 2 });
      expect(c.store.getState().schedules.find((entry) => entry.id === future.id)).toMatchObject({ status: "SCHEDULED", version: 1 });
      expect(c.store.getState().auditEvents.at(-1)?.metadata).toMatchObject({ scheduleId: schedule.id, scheduleVersion: 2, executorId: actor.id });
    } finally { vi.useRealTimers(); }
  });
});
