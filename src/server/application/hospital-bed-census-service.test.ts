import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hospitalOperationFixture, OPERATION_NOW, OPERATION_WINDOW } from "../../test/hospital-operation-fixtures";
import { systemGroupId } from "../security/access-group-policy";

function policyReady() {
  vi.stubEnv("ADMISSION_CONTEXT_POLICY_ENABLED", "true"); vi.stubEnv("ADMISSION_CONTEXT_POLICY_VERSION", "SYNTHETIC-D01-v1"); vi.stubEnv("ADMISSION_CONTEXT_POLICY_APPROVAL_REF", "test-only-approval"); vi.stubEnv("ADMISSION_CONTEXT_POLICY_APPROVED_AT", "2026-01-01T00:00:00Z"); vi.stubEnv("ADMISSION_CONTEXT_ALLOWED_RESPONSIBLE_ROLES", "VETERINARIAN,INPATIENT_TEAM");
}
const patientInput = { displayName: "Paciente sintético", species: "Canino", breed: "SRD", sex: "Macho", ownerLabel: "Tutor sintético", encounterType: "INPATIENT" as const };
const bedInput = { kind: "BED" as const, departmentCode: "INPATIENT", ward: "UTI 1", bedLabel: "Box 03", allowedSpecies: ["Canino"], availabilityWindows: [] };
async function reconcile(c: ReturnType<typeof hospitalOperationFixture>, bedId: string) {
  return c.service.updateAdmissionContext(c.user("user-manager"), "admission-thor", { action: "BED_CHANGE", bedResourceId: bedId, effectiveAt: "2026-10-11T09:59:59Z", reason: "Vínculo explícito sintético, sem inferência de rótulo", expectedVersion: 1, idempotencyKey: "reconcile" });
}
describe("single Admission authority, reconciliation and census", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(OPERATION_NOW); policyReady(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
  it("keeps legacy occupancy unknown and blocks new admission until explicit audited reconciliation", async () => {
    const c = hospitalOperationFixture(); const bed = await c.resource(bedInput); const before = c.store.getState();
    const census = await c.service.getBedCensus(c.user("user-vet")); expect(census.beds[0].state).toBe("UNRECONCILED"); expect(census.unregisteredAdmissions[0].admissionId).toBe("admission-thor");
    expect((await c.service.getHospitalCapacity(c.user("user-vet"), { from: OPERATION_WINDOW.startsAt, to: OPERATION_WINDOW.endsAt })).resources[0]).toMatchObject({ available: null, availabilityKnown: false, reason: "LEGACY_OCCUPANCY_NOT_LINKED" });
    await expect(c.service.createPatient(c.user("user-vet"), { ...patientInput, bedResourceId: bed.id }, { idempotencyKey: "unreconciled" })).rejects.toMatchObject({ code: "BED_OCCUPANCY_UNRECONCILED" }); expect(c.store.getState()).toEqual(before);
    const linked = await reconcile(c, bed.id); expect(linked.admission).toMatchObject({ bedResourceId: bed.id, ward: "UTI 1", bed: "Box 03", version: 2 });
    expect((await c.service.getBedCensus(c.user("user-vet"))).beds[0]).toMatchObject({ state: "OCCUPIED", occupancy: { admissionId: "admission-thor", patientId: "patient-thor" } });
    const event = c.store.getState().auditEvents.find((entry) => entry.eventType === "AdmissionBedChanged"); expect(event?.metadata).toMatchObject({ policyVersion: "SYNTHETIC-D01-v1", previousBedResourceId: null, bedResourceId: bed.id });
  });
  it.each(["BLOCKED", "MAINTENANCE", "INACTIVE", "UNKNOWN", "INCOMPATIBLE"])("does not admit into a %s bed or fabricate scope", async (condition) => {
    const c = hospitalOperationFixture(); const bed = await c.resource({ ...bedInput, availability: condition === "BLOCKED" || condition === "MAINTENANCE" ? condition : "AVAILABLE", active: condition !== "INACTIVE", allowedSpecies: condition === "INCOMPATIBLE" ? ["Felino"] : ["Canino"] }); const before = c.store.getState();
    await expect(c.service.createPatient(c.user("user-vet"), { ...patientInput, bedResourceId: condition === "UNKNOWN" ? "missing" : bed.id }, { idempotencyKey: "negative" })).rejects.toMatchObject({ code: condition === "INCOMPATIBLE" ? "BED_INCOMPATIBLE" : "BED_UNAVAILABLE" }); expect(c.store.getState()).toEqual(before);
  });
  it("refuses forged labels and bypassing registered beds with unbound text", async () => {
    const c = hospitalOperationFixture(); const bed = await c.resource(bedInput);
    await expect(c.service.createPatient(c.user("user-vet"), { ...patientInput, bedResourceId: bed.id, ward: "Outro", bed: "Box 03" }, { idempotencyKey: "forged-label" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(c.service.createPatient(c.user("user-vet"), { ...patientInput, ward: "UTI 1", bed: "Box 03" }, { idempotencyKey: "text-bypass" })).rejects.toMatchObject({ code: "BED_INVENTORY_REQUIRED" });
    expect(c.store.getState().patients).toHaveLength(3);
  });
  it("serializes two new occupations of the same free bed", async () => {
    const c = hospitalOperationFixture(); const occupied = await c.resource(bedInput); await reconcile(c, occupied.id); const free = await c.resource({ ...bedInput, bedLabel: "Box 04" });
    const results = await Promise.allSettled(["first", "second"].map((key) => c.service.createPatient(c.user("user-vet"), { ...patientInput, externalId: `SYNTHETIC-${key}`, bedResourceId: free.id }, { idempotencyKey: key })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1); expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "BED_OCCUPIED" } });
    expect(c.store.getState().admissions.filter((admission) => admission.bedResourceId === free.id && !admission.dischargedAt)).toHaveLength(1);
  });
  it("transfers transactionally and keeps exams, deadline and audit before/after", async () => {
    const c = hospitalOperationFixture(); const first = await c.resource(bedInput); const second = await c.resource({ ...bedInput, ward: "UTI 2", bedLabel: "Box 04" }); await reconcile(c, first.id); const item = await c.ultrasound("request");
    const input = { action: "TRANSFER" as const, departmentCode: "INPATIENT", bedResourceId: second.id, responsibleUserId: "user-vet", effectiveAt: OPERATION_NOW, reason: "Transferência explícita sintética", expectedVersion: 2, idempotencyKey: "transfer" };
    const result = await c.service.updateAdmissionContext(c.user("user-manager"), "admission-thor", input); expect(result.admission).toMatchObject({ bedResourceId: second.id, ward: "UTI 2", responsibleUserId: "user-vet", version: 3 });
    expect(c.store.getState().admissions).toHaveLength(1); expect(c.store.getState().items[0]).toEqual(item); expect(result.openItemsPreserved).toBe(true); expect(result.openItemCount).toBe(1);
    expect((await c.service.getBedCensus(c.user("user-vet"))).beds.find((bed) => bed.resource.id === first.id)?.state).toBe("AVAILABLE");
  });
  it("prevents concurrent transfers from assigning both admissions to one bed", async () => {
    const c = hospitalOperationFixture(); const first = await c.resource(bedInput); await reconcile(c, first.id); const second = await c.resource({ ...bedInput, bedLabel: "Box 04" }); const third = await c.resource({ ...bedInput, bedLabel: "Box 05" });
    const patient = await c.service.createPatient(c.user("user-vet"), { ...patientInput, bedResourceId: second.id }, { idempotencyKey: "new" });
    const results = await Promise.allSettled([{ admissionId: "admission-thor", version: 2 }, { admissionId: patient.admission!.id, version: 1 }].map((entry, index) => c.service.updateAdmissionContext(c.user("user-manager"), entry.admissionId, { action: "BED_CHANGE", bedResourceId: third.id, effectiveAt: "2026-10-11T10:00:01Z", reason: "Transferência concorrente sintética", expectedVersion: entry.version, idempotencyKey: `transfer-${index}` })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1); expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "BED_OCCUPIED" } });
  });
  it("discharges and frees occupancy while preserving visible pending diagnostics", async () => {
    const c = hospitalOperationFixture(); const bed = await c.resource(bedInput); await reconcile(c, bed.id); const item = await c.ultrasound("request");
    const discharged = await c.service.updateAdmissionContext(c.user("user-manager"), "admission-thor", { action: "DISCHARGE", effectiveAt: OPERATION_NOW, reason: "Alta sintética aprovada", expectedVersion: 2, idempotencyKey: "discharge" });
    expect(discharged.openItemCount).toBe(1); expect(c.store.getState().items[0]).toEqual(item); const census = await c.service.getBedCensus(c.user("user-vet")); expect(census.beds[0].state).toBe("AVAILABLE"); expect(census.dischargedWithPendingWork[0]).toMatchObject({ admissionId: "admission-thor", openDiagnosticItemCount: 1 });
  });
  it("hides restricted patient occupancy and denies clinical census to technical admin", async () => {
    const c = hospitalOperationFixture(); const bed = await c.resource(bedInput); await reconcile(c, bed.id);
    await c.store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === "viewer" ? { ...user, patientIds: ["patient-mel"] } : user) }, result: undefined }));
    const census = await c.service.getBedCensus(c.user("viewer")); expect(census.beds[0]).toMatchObject({ state: "RESTRICTED_OCCUPANCY" }); expect(census.beds[0].occupancy).toBeUndefined(); expect(JSON.stringify(census)).not.toMatch(/patient-thor|admission-thor|encounter-thor/);
    await expect(c.service.getBedCensus(c.user("user-admin"))).rejects.toMatchObject({ status: 404 });
  });
  it("provides transfer options only with real context permission and eligible responsibility", async () => {
    const c = hospitalOperationFixture(); const options = await c.service.getAdmissionContextOptions(c.user("user-manager"), "admission-thor", { departmentCode: "INPATIENT" }); expect(options.eligibleResponsibles).toEqual([{ id: "user-vet", displayName: "Dra. Marina Costa", departmentCode: "INPATIENT" }]); expect(JSON.stringify(options)).not.toMatch(/passwordHash|patientIds/);
    await c.store.transaction((state) => ({ state: { ...state, accessGroups: state.accessGroups.map((group) => group.id === systemGroupId("MANAGER") ? { ...group, permissions: group.permissions.filter((permission) => permission !== "admission.context.manage") } : group) }, result: undefined }));
    await expect(c.service.getAdmissionContextOptions(c.user("user-manager"), "admission-thor")).rejects.toMatchObject({ status: 404 });
  });
  it("requires an explicit registered bed in production even before inventory exists", async () => {
    const c = hospitalOperationFixture(); vi.stubEnv("NODE_ENV", "production"); const before = c.store.getState();
    await expect(c.service.createPatient(c.user("user-vet"), { ...patientInput, ward: "UTI 1", bed: "Box 10" }, { idempotencyKey: "production-text" })).rejects.toMatchObject({ code: "BED_INVENTORY_REQUIRED" }); expect(c.store.getState()).toEqual(before);
  });
});

it("counts authorized hospital tasks separately after discharge and drops the continuity row after their completion", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(OPERATION_NOW);
  try {
    const f = hospitalOperationFixture(); const task = await f.service.createHospitalTask(f.user("user-vet"), { title: "Continuidade sintética", typeId: "hospital-task-type-care", departmentCode: "INPATIENT", patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", responsibleUserId: "user-vet", idempotencyKey: "continuity" });
    await f.store.transaction((state) => ({ state: { ...state, admissions: state.admissions.map((admission) => ({ ...admission, dischargedAt: OPERATION_NOW })) }, result: undefined }));
    expect((await f.service.getBedCensus(f.user("user-vet"), { departmentCode: "INPATIENT" })).dischargedWithPendingWork).toMatchObject([{ admissionId: "admission-thor", openDiagnosticItemCount: 0, openHospitalTaskCount: 1 }]);
    await f.service.commandHospitalTask(f.user("user-vet"), task.task.id, { command: "START", expectedVersion: 1, idempotencyKey: "start-continuity" }); await f.service.commandHospitalTask(f.user("user-vet"), task.task.id, { command: "COMPLETE", expectedVersion: 2, idempotencyKey: "complete-continuity" });
    expect((await f.service.getBedCensus(f.user("user-vet"))).dischargedWithPendingWork).toEqual([]);
  } finally { vi.useRealTimers(); }
});

it("separates inactive and maintained inventory from unknown legacy occupancy without disclosing broken encounter references", async () => {
  const f = hospitalOperationFixture(); const inactive = await f.resource({ ...bedInput, active: false }); const maintenance = await f.resource({ ...bedInput, bedLabel: "Maintenance", availability: "MAINTENANCE" }); const blocked = await f.resource({ ...bedInput, bedLabel: "Blocked", availability: "BLOCKED" });
  await f.store.transaction((state) => ({ state: { ...state, admissions: state.admissions.map((admission) => ({ ...admission, encounterId: "missing-encounter", bedResourceId: maintenance.id })) }, result: undefined }));
  const census = await f.service.getBedCensus(f.user("user-vet"), { departmentCode: "INPATIENT" }); expect(census.beds.find((bed) => bed.resource.id === inactive.id)?.state).toBe("INACTIVE"); expect(census.beds.find((bed) => bed.resource.id === blocked.id)?.state).toBe("BLOCKED"); expect(census.beds.find((bed) => bed.resource.id === maintenance.id)).toMatchObject({ state: "RESTRICTED_OCCUPANCY" }); expect(census.unregisteredAdmissions).toEqual([]); expect(JSON.stringify(census)).not.toContain("missing-encounter");
  await f.store.transaction((state) => ({ state: { ...state, admissions: [] }, result: undefined })); expect((await f.service.getBedCensus(f.user("user-vet"))).beds.find((bed) => bed.resource.id === maintenance.id)?.state).toBe("MAINTENANCE");
});

describe("published work in the inpatient census", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(OPERATION_NOW); policyReady(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
  const draftBody = { title: "Planejamento assistencial sintético", typeId: "hospital-task-type-care", departmentCode: "INPATIENT", patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE" as const, responsibleUserId: "user-vet" };
  async function occupiedFixture() {
    const f = hospitalOperationFixture(); const bed = await f.resource(bedInput); await reconcile(f, bed.id);
    await f.store.transaction((state) => ({ state: { ...state, users: [...state.users, { ...state.users.find((user) => user.id === "user-vet")!, id: "census-super", email: "census-super@example.test", role: "SUPERADMIN", accessGroupId: systemGroupId("SUPERADMIN") }] }, result: undefined }));
    return { ...f, bed };
  }

  it.each(["user-vet", "user-manager", "census-super"])("counts published care only for %s, retaining draft visibility without treating it as execution", async (actorId) => {
    const f = await occupiedFixture(); const first = await f.service.createHospitalTaskDraft(f.user("user-vet"), { ...draftBody, idempotencyKey: "first-draft" });
    expect((await f.service.getHospitalTask(f.user(actorId), first.task.id)).task.isDraft).toBe(true);
    expect((await f.service.getBedCensus(f.user(actorId))).beds[0].occupancy?.openHospitalTaskCount).toBe(0);
    const published = await f.service.commandHospitalTaskDraft(f.user("user-vet"), first.task.id, { command: "PUBLISH", expectedVersion: 1, idempotencyKey: "publish-first" });
    expect(published.task).toMatchObject({ isDraft: false, phase: "PENDING" }); expect(published.task.startedAt).toBeUndefined();
    expect((await f.service.getBedCensus(f.user(actorId))).beds[0].occupancy?.openHospitalTaskCount).toBe(1);
    const second = await f.service.createHospitalTaskDraft(f.user("user-vet"), { ...draftBody, idempotencyKey: "second-draft" });
    expect((await f.service.getBedCensus(f.user(actorId))).beds[0].occupancy?.openHospitalTaskCount).toBe(1);
    const discarded = await f.service.commandHospitalTaskDraft(f.user("user-vet"), second.task.id, { command: "DISCARD", expectedVersion: 1, idempotencyKey: "discard-second" }); expect(discarded.task).toMatchObject({ isDraft: true, phase: "PENDING", draftCancelledBy: "user-vet" });
    expect((await f.service.getBedCensus(f.user(actorId))).beds[0].occupancy?.openHospitalTaskCount).toBe(1); expect(f.store.getState().hospitalTasks).toHaveLength(2);
  });

  it.each(["unpublished", "discarded"])("does not report discharged continuity when the only related work is an %s draft", async (state) => {
    const f = await occupiedFixture(); const draft = await f.service.createHospitalTaskDraft(f.user("user-vet"), { ...draftBody, idempotencyKey: "draft-before-discharge" });
    if (state === "discarded") await f.service.commandHospitalTaskDraft(f.user("user-vet"), draft.task.id, { command: "DISCARD", expectedVersion: 1, idempotencyKey: "discard-before-discharge" });
    await f.service.updateAdmissionContext(f.user("user-manager"), "admission-thor", { action: "DISCHARGE", effectiveAt: OPERATION_NOW, reason: "Alta sintética sem atividade publicada", expectedVersion: 2, idempotencyKey: "discharge-draft-only" });
    for (const actorId of ["user-vet", "user-manager", "census-super"]) {
      const census = await f.service.getBedCensus(f.user(actorId)); expect(census.beds[0].state).toBe("AVAILABLE"); expect(census.dischargedWithPendingWork).toEqual([]);
    }
    expect(f.store.getState().hospitalTasks[0]).toMatchObject({ isDraft: true, phase: "PENDING" }); expect(f.store.getState().hospitalTasks[0].startedAt).toBeUndefined(); expect(f.store.getState().items).toEqual([]);
  });

  it("does not reopen a bed's operational load when completed care is archived", async () => {
    const f = await occupiedFixture(); const task = await f.service.createHospitalTask(f.user("user-vet"), { ...draftBody, idempotencyKey: "published-care" });
    expect((await f.service.getBedCensus(f.user("user-manager"))).beds[0].occupancy?.openHospitalTaskCount).toBe(1);
    await f.service.commandHospitalTask(f.user("user-vet"), task.task.id, { command: "START", expectedVersion: 1, idempotencyKey: "start-care" }); await f.service.commandHospitalTask(f.user("user-vet"), task.task.id, { command: "COMPLETE", expectedVersion: 2, idempotencyKey: "finish-care" });
    await f.service.setHospitalTaskArchived(f.user("user-vet"), task.task.id, { archived: true, expectedVersion: 3, idempotencyKey: "archive-care" });
    expect((await f.service.getBedCensus(f.user("user-manager"))).beds[0].occupancy?.openHospitalTaskCount).toBe(0);
  });
});
