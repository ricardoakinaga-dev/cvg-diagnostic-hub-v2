import { randomUUID } from "node:crypto";
import type { HospitalDocumentContent } from "@cvg/contracts";
import { levelVerdict, summarizeOperations, type OperationSample } from "./perf-hospital-model";

/** Existing technical regression targets, not a hospital capacity/volume acceptance. */
export const PLANNER_TARGETS = Object.freeze({ readP95Ms: 500, writeP95Ms: 800, maxErrorRate: 0.01 });
export interface PlannerLoadSettings { journeys: number; concurrency: number; readRounds: number; contentChars: number }
export function plannerLoadSettings(environment: Record<string, string | undefined> = process.env): PlannerLoadSettings {
  const integer = (name: string, fallback: number, max: number) => {
    const raw = environment[name]; const value = raw === undefined ? fallback : Number(raw);
    if (!raw?.trim() && raw !== undefined || !Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`PLANNER_LOAD_INVALID_${name}`);
    return value;
  };
  const journeys = integer("PERF_HPL_JOURNEYS", 12, 500);
  const concurrency = integer("PERF_HPL_CONCURRENCY", 2, 20);
  if (concurrency > journeys) throw new Error("PLANNER_LOAD_CONCURRENCY_EXCEEDS_JOURNEYS");
  return { journeys, concurrency, readRounds: integer("PERF_HPL_READ_ROUNDS", 3, 100), contentChars: integer("PERF_HPL_CONTENT_CHARS", 512, 20_000) };
}
export type PlannerActor = "manager" | "operator" | "outsider";
export type PlannerMethod = "GET" | "POST" | "PATCH" | "PUT";
export interface PlannerCall { actor: PlannerActor; method: PlannerMethod; route: string; body?: unknown; key?: string; version?: number }
export interface PlannerResponse { status: number; durationMs: number; data?: unknown; errorCode?: string }
export type PlannerTransport = (request: PlannerCall) => Promise<PlannerResponse>;
export interface PlannerGuard { name: string; expectedStatus: number; actualStatus: number; errorCode?: string; passed: boolean; durationMs: number }
export class PlannerRecorder {
  readonly samples: OperationSample[] = [];
  readonly guards: PlannerGuard[] = [];
  private readonly started = performance.now();
  private inFlight = 0;
  private peakInFlight = 0;
  constructor(private readonly transport: PlannerTransport) {}
  private async send(request: PlannerCall): Promise<PlannerResponse> {
    this.peakInFlight = Math.max(this.peakInFlight, ++this.inFlight); const started = performance.now();
    try { return await this.transport(request); }
    catch { return { status: 0, durationMs: performance.now() - started, errorCode: "TRANSPORT" }; }
    finally { this.inFlight--; }
  }
  async call(operation: string, request: PlannerCall, expectedStatus = 200): Promise<unknown> {
    const startedAtMs = performance.now() - this.started;
    const response = await this.send(request);
    this.samples.push({ operation, kind: request.method === "GET" ? "read" : "write", status: response.status, durationMs: response.durationMs, startedAtMs, ...(response.errorCode ? { errorCode: response.errorCode } : {}) });
    if (response.status !== expectedStatus) throw new Error(`PLANNER_${operation}_${response.errorCode ?? `HTTP_${response.status}`}`);
    return response.data;
  }
  async guard(name: string, request: PlannerCall, expectedStatus: number): Promise<PlannerResponse> {
    const response = await this.send(request); this.recordGuard(name, response, expectedStatus);
    return response;
  }
  recordGuard(name: string, response: PlannerResponse, expectedStatus: number): void {
    const passed = response.status === expectedStatus;
    this.guards.push({ name, expectedStatus, actualStatus: response.status, passed, durationMs: response.durationMs, ...(response.errorCode ? { errorCode: response.errorCode } : {}) });
    if (!passed) throw new Error(`PLANNER_GUARD_${name}_EXPECTED_${expectedStatus}_ACTUAL_${response.status}`);
  }
  direct(request: PlannerCall): Promise<PlannerResponse> { return this.send(request); }
  summary(durationMs: number) {
    const verdict = levelVerdict(1, this.samples, durationMs, PLANNER_TARGETS);
    return { ...verdict, operations: summarizeOperations(this.samples), requests: this.samples.length, peakInFlightHttpRequests: this.peakInFlight, correctnessPassed: this.guards.every((guard) => guard.passed) };
  }
}
export function plannerObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("PLANNER_INVALID_RESPONSE_OBJECT");
  return value as Record<string, unknown>;
}
export function plannerString(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("PLANNER_INVALID_RESPONSE_ID"); return value;
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error("PLANNER_INVALID_RESPONSE_VERSION"); return Number(value);
}
function aggregate(value: unknown, name: string) { const object = plannerObject(plannerObject(value)[name]); return { object, id: plannerString(object.id), version: revision(object.version) }; }
export function plannerContent(chars: number, marker: string): HospitalDocumentContent {
  return { type: "hospital-document", version: 1, blocks: [{ type: "paragraph", content: [{ text: `${marker}: ${"x".repeat(chars)}`.slice(0, chars) }] }] };
}
export interface PlannerWindow { startsAt: string; endsAt: string }
export interface PlannerJourneyInput { index: number; prefix: string; patientId: string; encounterId: string; managerId: string; operatorId: string; window: PlannerWindow; config: PlannerLoadSettings }
export interface PlannerJourneyResult { index: number; documentId: string; revisionId: string; taskId: string; planId: string; resourceId: string; completed: boolean }
function check(condition: boolean, code: string): void { if (!condition) throw new Error(`PLANNER_INTEGRITY_${code}`); }

/** Every measured write is a native command; no synthetic DTO is substituted for its response. */
export async function runPlannerJourney(recorder: PlannerRecorder, input: PlannerJourneyInput): Promise<PlannerJourneyResult> {
  const { index, prefix, config, window } = input; const marker = `${prefix}_${index}`;
  const content = plannerContent(config.contentChars, `${marker}-edited`);
  const documentInput = { code: `HPL_DOC_${marker}`, title: `Documento sintético ${marker}`, departmentCode: "ULTRASOUND", responsibleUserId: input.managerId, content: plannerContent(config.contentChars, marker) };
  const createdDocument = aggregate(await recorder.call("document.create", { actor: "manager", method: "POST", route: "/hospital-documents", body: documentInput, key: `${marker}-document` }, 201), "document");
  const editedDocument = aggregate(await recorder.call("document.edit", { actor: "manager", method: "PATCH", route: `/hospital-documents/${createdDocument.id}/draft`, version: createdDocument.version, body: { content, expectedDraftVersion: 1 } }), "document");
  const approved = aggregate(await recorder.call("document.approve", { actor: "manager", method: "POST", route: `/hospital-documents/${createdDocument.id}/approve`, version: editedDocument.version, body: { confirm: true, policyReference: "SYNTHETIC_LOAD_ONLY_NOT_INSTITUTIONAL_APPROVAL", expectedDraftVersion: 2 } }), "document");
  const revisionId = plannerString(approved.object.currentPublishedRevisionId);
  const taskInput = { title: `Rotina sintética ${marker}`, typeId: "hospital-task-type-routine", departmentCode: "ULTRASOUND", priority: "ROUTINE", responsibleUserId: input.operatorId, estimatedMinutes: 30, documentIds: [createdDocument.id] };
  const task = aggregate(await recorder.call("task.create", { actor: "operator", method: "POST", route: "/hospital-tasks", body: taskInput, key: `${marker}-task` }, 201), "task");
  const replay = aggregate(await recorder.call("task.replay", { actor: "operator", method: "POST", route: "/hospital-tasks", body: taskInput, key: `${marker}-task` }, 201), "task");
  check(replay.id === task.id && replay.version === task.version, "TASK_REPLAY_ID_VERSION");
  const snapshots = task.object.documentSnapshots;
  check(Array.isArray(snapshots) && snapshots.length === 1 && plannerObject(snapshots[0]).revisionId === revisionId && JSON.stringify(plannerObject(snapshots[0]).content) === JSON.stringify(content), "DOCUMENT_CAPTURE_BYTES");
  const plan = aggregate(await recorder.call("plan.create", { actor: "manager", method: "POST", route: "/hospital-plans", key: `${marker}-plan`, body: { title: `Plano sintético ${marker}`, objective: "Verificar fluxo operacional sintético, sem execução clínica.", patientId: input.patientId, encounterId: input.encounterId, departmentCodes: ["ULTRASOUND"], responsibleUserId: input.managerId, steps: [{ id: "load-step", title: "Rotina operacional", sortOrder: 0 }], documentIds: [createdDocument.id] } }, 201), "plan");
  const linked = aggregate(await recorder.call("plan.link", { actor: "manager", method: "PUT", route: `/hospital-plans/${plan.id}/links`, version: plan.version, body: { stepId: "load-step", targetType: "HOSPITAL_TASK", targetId: task.id, active: true } }), "plan");
  const resource = plannerObject(await recorder.call("resource.create", { actor: "manager", method: "POST", route: "/hospital-resources", key: `${marker}-resource`, body: { code: `HPL_ROOM_${marker}`, name: `Sala sintética ${marker}`, kind: "ROOM", departmentCode: "ULTRASOUND", availabilityWindows: [window] } }, 201));
  const resourceId = plannerString(resource.id);
  const reservation = plannerObject(await recorder.call("calendar.reserve", { actor: "operator", method: "POST", route: `/hospital-tasks/${task.id}/reservations`, version: task.version, body: { ...window, resourceIds: [resourceId] } }, 201));
  check(reservation.hospitalTaskId === task.id && reservation.status === "SCHEDULED", "RESERVATION_TARGET");
  const query = new URLSearchParams({ from: window.startsAt, to: window.endsAt, departmentCode: "ULTRASOUND" });
  for (let round = 0; round < config.readRounds; round++) {
    await Promise.all([
      ["task.list", "operator", "/hospital-tasks?departmentCode=ULTRASOUND&limit=100"],
      ["task.detail", "operator", `/hospital-tasks/${task.id}`],
      ["plan.list", "manager", "/hospital-plans?departmentCode=ULTRASOUND&limit=100"],
      ["plan.detail", "manager", `/hospital-plans/${plan.id}`],
      ["document.list", "manager", "/hospital-documents?departmentCode=ULTRASOUND&limit=100"],
      ["document.detail", "manager", `/hospital-documents/${createdDocument.id}`],
      ["resource.list", "manager", "/hospital-resources?departmentCode=ULTRASOUND&limit=100"],
      ["calendar.read", "operator", `/hospital-calendar?${query}&limit=100`],
      ["capacity.read", "manager", `/hospital-capacity?${query}`],
      ["metrics.read", "manager", `/hospital-metrics?${query}`]
    ].map(([operation, actor, route]) => recorder.call(operation!, { actor: actor as PlannerActor, method: "GET", route: route! })));
  }
  const started = aggregate(await recorder.call("task.start", { actor: "operator", method: "POST", route: `/hospital-tasks/${task.id}/commands`, version: task.version, body: { command: "START" } }), "task");
  check(started.object.phase === "IN_PROGRESS", "START_PHASE");
  await recorder.guard("task.stale-edit", { actor: "operator", method: "PATCH", route: `/hospital-tasks/${task.id}`, version: task.version, body: { title: "Edição obsoleta deve ser recusada" } }, 409);
  const completed = aggregate(await recorder.call("task.complete", { actor: "operator", method: "POST", route: `/hospital-tasks/${task.id}/commands`, key: `${marker}-complete`, version: started.version, body: { command: "COMPLETE" } }), "task");
  check(completed.object.phase === "COMPLETED", "COMPLETE_PHASE");
  const finalPlanData = await recorder.call("plan.completed-summary", { actor: "manager", method: "GET", route: `/hospital-plans/${plan.id}` });
  const summary = plannerObject(plannerObject(finalPlanData).summary);
  check(summary.visibleActivities === 1 && summary.completedActivities === 1 && summary.pendingActivities === 0 && summary.denominator === "AUTHORIZED_UNIQUE_ACTIVITIES", "PLAN_UNIQUE_DENOMINATOR");
  const closed = aggregate(await recorder.call("plan.close", { actor: "manager", method: "POST", route: `/hospital-plans/${plan.id}/commands`, version: linked.version, body: { command: "CLOSE" } }), "plan");
  check(closed.object.state === "CLOSED", "PLAN_CLOSED");
  return { index, documentId: createdDocument.id, revisionId, taskId: task.id, planId: plan.id, resourceId, completed: true };
}

/** A deliberately contended native reservation: exactly one winner, not two success responses. */
export async function provePlannerGuards(recorder: PlannerRecorder, input: PlannerJourneyInput, journey: PlannerJourneyResult): Promise<{ taskIds: string[]; resourceId: string }> {
  const prefix = `${input.prefix}_GUARD`; const resource = plannerObject(await recorder.call("guard.resource.create", { actor: "manager", method: "POST", route: "/hospital-resources", body: { code: `HPL_ROOM_${prefix}`, name: "Sala sintética disputada", kind: "ROOM", departmentCode: "ULTRASOUND", availabilityWindows: [input.window] } }, 201));
  const resourceId = plannerString(resource.id);
  const tasks = await Promise.all([0, 1].map(async (index) => aggregate(await recorder.call("guard.task.create", { actor: "operator", method: "POST", route: "/hospital-tasks", body: { title: `Contenção sintética ${prefix} ${index}`, typeId: "hospital-task-type-routine", departmentCode: "ULTRASOUND", priority: "ROUTINE", responsibleUserId: input.operatorId, estimatedMinutes: 10 } }, 201), "task")));
  const responses = await Promise.all(tasks.map((task) => recorder.direct({ actor: "operator", method: "POST", route: `/hospital-tasks/${task.id}/reservations`, version: task.version, body: { ...input.window, resourceIds: [resourceId] } })));
  check(responses.filter((response) => response.status === 201).length === 1 && responses.filter((response) => response.status === 409 && response.errorCode === "SCHEDULE_CONFLICT").length === 1, "RESERVATION_SINGLE_WINNER");
  for (let index = 0; index < responses.length; index++) {
    const response = responses[index]!; recorder.recordGuard("calendar.overlap", response, response.status === 201 ? 201 : 409);
    const task = tasks[index]!;
    const started = aggregate(await recorder.call("guard.task.start", { actor: "operator", method: "POST", route: `/hospital-tasks/${task.id}/commands`, version: task.version, body: { command: "START" } }), "task");
    await recorder.call("guard.task.complete", { actor: "operator", method: "POST", route: `/hospital-tasks/${task.id}/commands`, version: started.version, body: { command: "COMPLETE" } });
  }
  for (const route of [`/hospital-tasks/${journey.taskId}`, `/hospital-documents/${journey.documentId}`, `/hospital-resources/${journey.resourceId}`]) await recorder.guard("scope.outside-department", { actor: "outsider", method: "GET", route }, 404);
  await recorder.guard("scope.manager-not-delegated", { actor: "manager", method: "GET", route: "/hospital-resources?departmentCode=LABORATORY" }, 404);
  const query = new URLSearchParams({ departmentCode: "ULTRASOUND", from: input.window.startsAt, to: input.window.endsAt });
  const capacity = plannerObject(await recorder.call("capacity.final", { actor: "manager", method: "GET", route: `/hospital-capacity?${query}` }));
  const load = plannerObject(capacity.authorizedLoad);
  check(load.openHospitalTasks === 0 && load.openDiagnosticItems === 0 && load.estimatedMinutes === 0, "FINAL_AUTHORIZED_LOAD_EMPTY");
  const resources = capacity.resources; check(Array.isArray(resources) && resources.every((entry) => plannerObject(entry).unit === "MINUTES" && plannerObject(entry).availabilityKnown === true), "CAPACITY_REAL_UNIT_WINDOWS");
  const pagedIds = new Set<string>(); let cursor: string | undefined;
  for (let pageIndex = 0; pageIndex <= input.config.journeys + 2; pageIndex++) {
    const page = plannerObject(await recorder.call("task.cursor-page", { actor: "operator", method: "GET", route: `/hospital-tasks?departmentCode=ULTRASOUND&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}` }));
    check(page.total === input.config.journeys + 2 && Array.isArray(page.items), "CURSOR_AUTHORIZED_TOTAL");
    for (const entry of page.items as unknown[]) { const taskId = aggregate(entry, "task").id; check(!pagedIds.has(taskId), "CURSOR_NO_DUPLICATE"); pagedIds.add(taskId); }
    if (page.nextCursor === undefined) { cursor = undefined; break; }
    const nextCursor = plannerString(page.nextCursor); check(nextCursor !== cursor, "CURSOR_PROGRESS"); cursor = nextCursor;
  }
  check(!cursor && pagedIds.size === input.config.journeys + 2, "CURSOR_NO_LOSS");
  return { taskIds: tasks.map((task) => task.id), resourceId };
}

export async function runPlannerLoad(recorder: PlannerRecorder, inputs: PlannerJourneyInput[]): Promise<{ completed: PlannerJourneyResult[]; failures: Array<{ index: number; code: string }> }> {
  const completed: PlannerJourneyResult[] = []; const failures: Array<{ index: number; code: string }> = []; let next = 0;
  await Promise.all(Array.from({ length: inputs[0]?.config.concurrency ?? 0 }, async () => {
    while (next < inputs.length) {
      const input = inputs[next++]!;
      try { completed.push(await runPlannerJourney(recorder, input)); } catch (error) { failures.push({ index: input.index, code: error instanceof Error && /^PLANNER_[A-Z_a-z0-9.]+$/.test(error.message) ? error.message : "PLANNER_UNEXPECTED_FAILURE" }); }
    }
  }));
  return { completed: completed.sort((a, b) => a.index - b.index), failures };
}
/** Call after a declared synthetic control withdraws current grants; it is not a measured grant command. */
export async function provePlannerRevocation(recorder: PlannerRecorder, input: PlannerJourneyInput, journey: PlannerJourneyResult): Promise<void> {
  await recorder.guard("revocation.task-current-read", { actor: "operator", method: "GET", route: `/hospital-tasks/${journey.taskId}` }, 404);
  await recorder.guard("revocation.task-command-replay", { actor: "operator", method: "POST", route: `/hospital-tasks/${journey.taskId}/commands`, key: `${input.prefix}_${journey.index}-complete`, version: 2, body: { command: "COMPLETE" } }, 404);
  await recorder.guard("revocation.document-current-read", { actor: "manager", method: "GET", route: `/hospital-documents/${journey.documentId}` }, 404);
  const visibleTask = plannerObject(await recorder.call("revocation.task-redacted-snapshot", { actor: "manager", method: "GET", route: `/hospital-tasks/${journey.taskId}` }));
  const snapshots = plannerObject(visibleTask.task).documentSnapshots;
  check(Array.isArray(snapshots) && snapshots.length === 0, "REVOKED_DOCUMENT_REDACTED");
}
export function plannerKey(request: PlannerCall): string { return request.key ?? randomUUID(); }
