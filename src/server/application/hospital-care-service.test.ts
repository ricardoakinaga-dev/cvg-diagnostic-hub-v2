import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hospitalOperationFixture, BOOKING_WINDOW, OPERATION_NOW } from "../../test/hospital-operation-fixtures";
import { systemGroupId } from "../security/access-group-policy";

async function approvedCare(c: ReturnType<typeof hospitalOperationFixture>, modality: "CARE" | "PROCEDURE" = "CARE", serviceId?: string) {
  const created = await c.service.createHospitalChecklistTemplate(c.user("user-admin"), { code: "SYNTHETIC_PILOT", name: "Processo sintético de teste", departmentCode: "INPATIENT", careContextRequired: true, steps: [{ code: "IDENTIFY", label: "Conferência sintética", required: true, evidenceRequired: true }], clinicalProcess: { modality, allowedExecutorRoles: ["VETERINARIAN"], clinicalSystemReference: "synthetic-record-system", confirmationPolicyReference: "synthetic-test-only-policy" }, idempotencyKey: "template" });
  const approved = await c.service.approveHospitalChecklistTemplate(c.user("user-vet"), created.template.id, { expectedVersion: 1, idempotencyKey: "approve" });
  const task = await c.service.createHospitalTask(c.user("user-vet"), { title: "Processo clínico sintético", typeId: "hospital-task-type-care", departmentCode: "INPATIENT", patientId: "patient-thor", encounterId: "encounter-thor", responsibleUserId: "user-vet", priority: "ROUTINE", checklistTemplateId: approved.template.id, ...(serviceId ? { serviceId } : {}), idempotencyKey: "care" });
  return { template: approved.template, task };
}
async function prepareExecution(c: ReturnType<typeof hospitalOperationFixture>, taskId: string, expectedVersion = 1) {
  const started = await c.service.commandHospitalTask(c.user("user-vet"), taskId, { command: "START", expectedVersion, idempotencyKey: "start" });
  return c.service.recordHospitalChecklistStep(c.user("user-vet"), taskId, { command: "DONE", stepCode: "IDENTIFY", evidenceText: "Evidência sintética de conferência", expectedVersion: started.task.version, idempotencyKey: "step" });
}
const confirmation = { confirm: true as const, clinicalRecordReference: "synthetic-record/encounter-thor/entry-1", idempotencyKey: "execute" };
describe("approved non-diagnostic clinical process execution", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(OPERATION_NOW); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
  it.each(["CARE", "PROCEDURE"] as const)("records %s server evidence atomically without creating an exam or claiming external delivery", async (modality) => {
    const c = hospitalOperationFixture(); const configured = await approvedCare(c, modality); const prepared = await prepareExecution(c, configured.task.task.id); const before = c.store.getState();
    const result = await c.service.executeHospitalCare(c.user("user-vet"), prepared.task.id, { ...confirmation, expectedVersion: prepared.task.version });
    expect(result.task).toMatchObject({ phase: "COMPLETED", completedBy: "user-vet", completedAt: OPERATION_NOW, careExecution: { performedBy: "user-vet", performedAt: OPERATION_NOW, modality, templateId: configured.template.id, templateVersion: 2, approvedBy: "user-vet", recordEvidence: "EXECUTOR_REFERENCE", clinicalRecordReference: confirmation.clinicalRecordReference, clinicalSystemReference: "synthetic-record-system", confirmationPolicyReference: "synthetic-test-only-policy" } });
    expect(c.store.getState().items).toEqual(before.items); expect(c.store.getState().requests).toEqual(before.requests); expect(c.store.getState().resultVersions).toEqual(before.resultVersions); expect(c.store.getState().auditEvents.at(-1)?.eventType).toBe("HospitalCareExecuted");
    const after = c.store.getState(); const replay = await c.service.executeHospitalCare(c.user("user-vet"), prepared.task.id, { ...confirmation, expectedVersion: prepared.task.version }); expect(replay.task.careExecution?.id).toBe(result.task.careExecution?.id); expect(c.store.getState()).toEqual(after);
  });
  it("rejects generic completion, missing step evidence and unapproved activities", async () => {
    const c = hospitalOperationFixture(); const configured = await approvedCare(c); const started = await c.service.commandHospitalTask(c.user("user-vet"), configured.task.task.id, { command: "START", expectedVersion: 1, idempotencyKey: "start" }); const before = c.store.getState();
    await expect(c.service.commandHospitalTask(c.user("user-vet"), started.task.id, { command: "COMPLETE", expectedVersion: started.task.version, idempotencyKey: "generic" })).rejects.toMatchObject({ code: "CLINICAL_CONFIRMATION_REQUIRED" });
    await expect(c.service.executeHospitalCare(c.user("user-vet"), started.task.id, { ...confirmation, expectedVersion: started.task.version })).rejects.toMatchObject({ code: "CHECKLIST_PENDING" }); expect(c.store.getState()).toEqual(before);
    const routine = await c.task("routine", "INPATIENT"); await c.service.commandHospitalTask(c.user("user-vet"), routine.task.id, { command: "START", expectedVersion: 1, idempotencyKey: "routine-start" }); await expect(c.service.executeHospitalCare(c.user("user-vet"), routine.task.id, { ...confirmation, expectedVersion: 2 })).rejects.toMatchObject({ code: "CARE_PROCESS_NOT_APPROVED" });
  });
  it("freezes the approved process even after the live template is revised and retired", async () => {
    const c = hospitalOperationFixture(); const configured = await approvedCare(c); const prepared = await prepareExecution(c, configured.task.task.id);
    const revised = await c.service.updateHospitalChecklistTemplate(c.user("user-admin"), configured.template.id, { name: "Processo futuro", clinicalProcess: { modality: "PROCEDURE", allowedExecutorRoles: ["MANAGER"], clinicalSystemReference: "different-future-system", confirmationPolicyReference: "different-future-policy" }, expectedVersion: 2, idempotencyKey: "revise" });
    expect(revised.template.status).toBe("DRAFT"); await c.service.retireHospitalChecklistTemplate(c.user("user-admin"), configured.template.id, { expectedVersion: revised.template.version, idempotencyKey: "retire" });
    const result = await c.service.executeHospitalCare(c.user("user-vet"), prepared.task.id, { ...confirmation, expectedVersion: prepared.task.version }); expect(result.task.careExecution).toMatchObject({ modality: "CARE", templateVersion: 2, clinicalSystemReference: "synthetic-record-system", confirmationPolicyReference: "synthetic-test-only-policy" });
  });
  it("requires current assigned eligibility and frozen modality roles without a manager override", async () => {
    const c = hospitalOperationFixture(); const configured = await approvedCare(c); const prepared = await prepareExecution(c, configured.task.task.id); const before = c.store.getState();
    await expect(c.service.executeHospitalCare(c.user("user-manager"), prepared.task.id, { ...confirmation, expectedVersion: prepared.task.version })).rejects.toMatchObject({ code: "SCOPE_DENIED", status: 404 });
    await expect(c.service.executeHospitalCare(c.user("user-admin"), prepared.task.id, { ...confirmation, expectedVersion: prepared.task.version })).rejects.toMatchObject({ status: 404 }); expect(c.store.getState()).toEqual(before);
  });
  it.each(["PATIENT_SCOPE", "CARE_GRANT", "ENCOUNTER_CLOSED", "STEP_VOIDED"])("refuses %s withdrawn context before mutating evidence", async (condition) => {
    const c = hospitalOperationFixture(); const configured = await approvedCare(c); const prepared = await prepareExecution(c, configured.task.task.id);
    await c.store.transaction((state) => ({ state: { ...state, users: condition === "PATIENT_SCOPE" ? state.users.map((user) => user.id === "user-vet" ? { ...user, patientIds: ["patient-mel"] } : user) : state.users, accessGroups: condition === "CARE_GRANT" ? state.accessGroups.map((group) => group.id === systemGroupId("VETERINARIAN") ? { ...group, permissions: group.permissions.filter((permission) => permission !== "care.execute") } : group) : state.accessGroups, encounters: condition === "ENCOUNTER_CLOSED" ? state.encounters.map((encounter) => encounter.id === "encounter-thor" ? { ...encounter, status: "CLOSED" } : encounter) : state.encounters, hospitalTasks: condition === "STEP_VOIDED" ? state.hospitalTasks.map((task) => task.id === prepared.task.id ? { ...task, checklistExecutions: task.checklistExecutions?.map((step) => ({ ...step, status: "VOIDED" })) } : task) : state.hospitalTasks }, result: undefined }));
    const before = c.store.getState(); await expect(c.service.executeHospitalCare(c.user("user-vet"), prepared.task.id, { ...confirmation, expectedVersion: prepared.task.version })).rejects.toMatchObject({ status: condition === "PATIENT_SCOPE" || condition === "CARE_GRANT" ? 404 : 409 }); expect(c.store.getState()).toEqual(before);
  });
  it("requires confirmation, prevents authority spoofing and protects concurrent completion", async () => {
    const c = hospitalOperationFixture(); const configured = await approvedCare(c); const prepared = await prepareExecution(c, configured.task.task.id); const injected = { ...confirmation, expectedVersion: prepared.task.version, approvedBy: "invented-approver", performedAt: "2020-01-01T00:00:00Z" };
    await expect(c.service.executeHospitalCare(c.user("user-vet"), prepared.task.id, injected)).rejects.toMatchObject({ status: 400 });
    await expect(c.service.executeHospitalCare(c.user("user-vet"), prepared.task.id, { ...confirmation, confirm: false, expectedVersion: prepared.task.version } as unknown as Parameters<typeof c.service.executeHospitalCare>[2])).rejects.toMatchObject({ status: 400 });
    const results = await Promise.allSettled(["one", "two"].map((key) => c.service.executeHospitalCare(c.user("user-vet"), prepared.task.id, { ...confirmation, idempotencyKey: key, expectedVersion: prepared.task.version })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1); expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "STALE_VERSION" } });
  });
  it("records delayed completion after a valid reserved start and releases the same reservation", async () => {
    const c = hospitalOperationFixture(); const configured = await approvedCare(c); const resource = await c.resource({ departmentCode: "INPATIENT", kind: "ROOM" }); const schedule = await c.service.reserveHospitalTaskSchedule(c.user("user-vet"), configured.task.task.id, { ...BOOKING_WINDOW, resourceIds: [resource.id], expectedVersion: 1, idempotencyKey: "reserve" }); const prepared = await prepareExecution(c, configured.task.task.id);
    vi.setSystemTime("2026-10-11T11:30:00Z"); const result = await c.service.executeHospitalCare(c.user("user-vet"), prepared.task.id, { ...confirmation, expectedVersion: prepared.task.version }); expect(result.task.careExecution?.performedAt).toBe("2026-10-11T11:30:00.000Z"); expect(result.task.careExecution?.resourceSnapshots[0].resourceId).toBe(resource.id); expect(c.store.getState().schedules.find((entry) => entry.id === schedule.id)).toMatchObject({ status: "COMPLETED", version: 2 });
  });
  it.each(["DRAFT", "ARCHIVED"])("does not execute unpublished care %s", async (kind) => {
    const c = hospitalOperationFixture(); const configured = await approvedCare(c); const prepared = await prepareExecution(c, configured.task.task.id);
    await c.store.transaction(state => ({ state: { ...state, hospitalTasks: state.hospitalTasks.map(task => task.id === prepared.task.id ? { ...task, ...(kind === "DRAFT" ? { isDraft: true } : { archivedAt: OPERATION_NOW, archivedBy: "user-vet" }) } : task) }, result: undefined }));
    const before = c.store.getState(); await expect(c.service.executeHospitalCare(c.user("user-vet"), prepared.task.id, { ...confirmation, expectedVersion: prepared.task.version })).rejects.toMatchObject({ status: kind === "DRAFT" ? 404 : 409 }); expect(c.store.getState()).toEqual(before);
  });

  it("keeps completion pending until its actual prerequisite is completed", async () => {
    const c = hospitalOperationFixture(); const configured = await approvedCare(c); const prerequisite = await c.task("care-prerequisite", "INPATIENT");
    const linked = await c.service.putHospitalTaskDependency(c.user("user-vet"), configured.task.task.id, { targetType: "HOSPITAL_TASK", targetId: prerequisite.task.id, blocks: "COMPLETE", active: true, expectedVersion: 1, idempotencyKey: "care-dependency" });
    const prepared = await prepareExecution(c, configured.task.task.id, linked.task.version); const before = c.store.getState();
    await expect(c.service.executeHospitalCare(c.user("user-vet"), prepared.task.id, { ...confirmation, expectedVersion: prepared.task.version })).rejects.toMatchObject({ code: "DEPENDENCY_PENDING" }); expect(c.store.getState()).toEqual(before);
    const started = await c.service.commandHospitalTask(c.user("user-vet"), prerequisite.task.id, { command: "START", expectedVersion: 1, idempotencyKey: "prerequisite-start" });
    await c.service.commandHospitalTask(c.user("user-vet"), prerequisite.task.id, { command: "COMPLETE", expectedVersion: started.task.version, idempotencyKey: "prerequisite-complete" });
    const completed = await c.service.executeHospitalCare(c.user("user-vet"), prepared.task.id, { ...confirmation, note: "Conferência sintética após pré-requisito", expectedVersion: prepared.task.version });
    expect(completed.task.careExecution?.note).toBe("Conferência sintética após pré-requisito"); expect(completed.task.phase).toBe("COMPLETED");
  });

  it("records the current reserved professional and refuses confirmation before a valid start", async () => {
    const c = hospitalOperationFixture(); const configured = await approvedCare(c);
    await expect(c.service.executeHospitalCare(c.user("user-vet"), "missing-care", { ...confirmation, expectedVersion: 1 })).rejects.toMatchObject({ status: 404 });
    await expect(c.service.executeHospitalCare(c.user("user-vet"), configured.task.task.id, { ...confirmation, expectedVersion: 1 })).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    const professional = await c.resource({ departmentCode: "INPATIENT", kind: "PROFESSIONAL", userId: "user-vet" });
    const reservation = await c.service.reserveHospitalTaskSchedule(c.user("user-vet"), configured.task.task.id, { ...BOOKING_WINDOW, resourceIds: [professional.id], expectedVersion: 1, idempotencyKey: "care-professional" });
    const prepared = await prepareExecution(c, configured.task.task.id);
    vi.setSystemTime("2026-10-11T09:59:59Z"); await expect(c.service.executeHospitalCare(c.user("user-vet"), prepared.task.id, { ...confirmation, expectedVersion: prepared.task.version })).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    vi.setSystemTime(OPERATION_NOW); const completed = await c.service.executeHospitalCare(c.user("user-vet"), prepared.task.id, { ...confirmation, expectedVersion: prepared.task.version });
    expect(completed.task.careExecution?.resourceSnapshots).toEqual([expect.objectContaining({ resourceId: professional.id, kind: "PROFESSIONAL", userId: "user-vet" })]);
    expect(c.store.getState().schedules.find(schedule => schedule.id === reservation.id)?.status).toBe("COMPLETED");
  });

  it("does not confirm an operational catalog service as approved clinical care", async () => {
    const c = hospitalOperationFixture(); const service = await c.service.createHospitalService(c.user("user-admin"), { code: "SYNTHETIC_OPERATIONS", name: "Apoio operacional sintético", kind: "OPERATIONAL", departmentCode: "INPATIENT", teamUserIds: ["user-vet"], resourceIds: [], idempotencyKey: "operational-service" });
    const configured = await approvedCare(c, "CARE", service.id); const prepared = await prepareExecution(c, configured.task.task.id); const before = c.store.getState();
    await expect(c.service.executeHospitalCare(c.user("user-vet"), prepared.task.id, { ...confirmation, expectedVersion: prepared.task.version })).rejects.toMatchObject({ code: "CARE_MODALITY_MISMATCH", status: 422 });
    expect(c.store.getState()).toEqual(before);
  });

});
