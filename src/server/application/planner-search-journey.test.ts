import { describe, expect, it } from "vitest";
import { hospitalOperationFixture } from "@/test/hospital-operation-fixtures";
import { systemGroupId } from "../security/access-group-policy";

async function journey() {
  const c = hospitalOperationFixture();
  await c.store.transaction((state) => ({ state: { ...state, users: [...state.users, { ...state.users[0], id: "super", role: "SUPERADMIN", accessGroupId: systemGroupId("SUPERADMIN") }] }, result: undefined }));
  const actor = c.user("super");
  const task = await c.service.createHospitalTask(actor, { title: "Conferência hospitalar", typeId: "hospital-task-type-routine", departmentCode: "INPATIENT", responsibleUserId: "user-vet", priority: "URGENT", plannedStartAt: "2026-10-12T10:00:00Z", idempotencyKey: "task" });
  const request = await c.service.createRequest(c.user("user-vet"), { patientId: "patient-thor", encounterId: "encounter-thor", priority: "URGENT", items: [{ serviceId: "service-ultrasound" }] }, { idempotencyKey: "request" });
  const plan = await c.service.createHospitalPlan(c.user("user-vet"), { title: "Plano hospitalar", objective: "Conferência hospitalar", patientId: "patient-thor", encounterId: "encounter-thor", departmentCodes: ["INPATIENT"], idempotencyKey: "plan" });
  const shift = await c.service.createHospitalShift(actor, { name: "Turno hospitalar", departmentCode: "INPATIENT", startAt: "2026-10-12T09:00:00Z", endAt: "2026-10-12T17:00:00Z", members: [{ userId: "user-vet" }], idempotencyKey: "shift" });
  const template = await c.service.createHospitalChecklistTemplate(c.user("user-admin"), { code: "HOSPITAL_CHECK", name: "Checklist hospitalar", departmentCode: "INPATIENT", careContextRequired: false, steps: [{ code: "CHECK", label: "Conferir", required: true, evidenceRequired: false }], idempotencyKey: "template" });
  await c.service.approveHospitalChecklistTemplate(c.user("user-vet"), template.template.id, { expectedVersion: 1, idempotencyKey: "approve" });
  const recurrence = await c.service.createHospitalRecurrence(c.user("user-vet"), { title: "Rotina hospitalar", templateId: template.template.id, departmentCode: "INPATIENT", priority: "ROUTINE", startAt: "2026-10-12T10:00:00Z", intervalMinutes: 60, idempotencyKey: "recurrence" });
  return { ...c, actor, task: task.task, request, plan: plan.plan, shift: shift.shift, template: template.template, recurrence: recurrence.recurrence };
}

describe("search journeys across authorized hospital objects", () => {
  it("links diagnostic and checklist results to the actual detail routes", async () => {
    const c = await journey();
    const exams = await c.service.searchPlanner(c.actor, "", { types: ["DIAGNOSTIC_ITEM"] });
    expect.soft(exams.items[0].deepLink).toBe(`/requests/${c.request.id}#${c.request.items[0].id}`);
    const checklist = await c.service.searchPlanner(c.actor, "", { types: ["CHECKLIST_TEMPLATE"] });
    expect.soft(checklist.items[0].deepLink).toBe(`/planner/checklists?templateId=${c.template.id}`);
    const routines = await c.service.searchPlanner(c.actor, "", { types: ["HOSPITAL_RECURRENCE"] });
    expect.soft(routines.items[0].deepLink).toBe(`/planner/recurrences?recurrenceId=${c.recurrence.id}`);
  });
});

describe("current search filters and source boundaries", () => {
  it("finds plans, turns, approved templates and routines with their own scope and text filters", async () => {
    const c = await journey();
    const rows = await c.service.searchPlanner(c.actor, "hospitalar");
    expect(rows.items.map((row) => row.type)).toEqual(expect.arrayContaining(["HOSPITAL_TASK", "HOSPITAL_PLAN", "HOSPITAL_SHIFT", "CHECKLIST_TEMPLATE", "HOSPITAL_RECURRENCE"]));
    expect((await c.service.searchPlanner(c.actor, "not present")).total).toBe(0);
    for (const type of ["HOSPITAL_PLAN", "HOSPITAL_SHIFT", "CHECKLIST_TEMPLATE", "HOSPITAL_RECURRENCE"] as const) {
      expect((await c.service.searchPlanner(c.actor, "hospitalar", { types: [type], departmentCode: "INPATIENT" })).total).toBe(1);
      expect((await c.service.searchPlanner(c.actor, "hospitalar", { types: [type], departmentCode: "RADIOLOGY" })).total).toBe(0);
      expect((await c.service.searchPlanner(c.actor, "hospitalar", { types: [type], from: "2090-01-01T00:00:00Z" })).total).toBe(0);
    }
    expect((await c.service.searchPlanner(c.actor, "", { types: ["HOSPITAL_PLAN"], planId: c.plan.id, patientId: "patient-thor", encounterId: "encounter-thor" })).items[0].id).toBe(c.plan.id);
    expect((await c.service.searchPlanner(c.actor, "", { types: ["HOSPITAL_PLAN"], patientId: "patient-mel" })).total).toBe(0);
    expect((await c.service.searchPlanner(c.actor, "", { types: ["HOSPITAL_PLAN"], encounterId: "encounter-mel" })).total).toBe(0);
    expect((await c.service.searchPlanner(c.actor, "", { types: ["HOSPITAL_SHIFT"], shiftId: c.shift.id })).items[0].id).toBe(c.shift.id);
    expect((await c.service.searchPlanner(c.actor, "", { types: ["HOSPITAL_RECURRENCE"], patientId: "patient-thor" })).total).toBe(0);
    expect((await c.service.searchPlanner(c.actor, "", { types: ["HOSPITAL_RECURRENCE"], encounterId: "encounter-thor" })).total).toBe(0);
    expect((await c.service.searchPlanner(c.user("user-lab"), "hospitalar")).total).toBe(0);
  });
  it("resolves shift and plan references before reading tasks or any other search source", async () => {
    const c = await journey();
    await c.service.assignHospitalActivityShift(c.actor, { targetType: "HOSPITAL_TASK", targetId: c.task.id, shiftId: c.shift.id, expectedVersion: 1, idempotencyKey: "bind-turn" });
    expect((await c.service.listHospitalTasks(c.user("user-vet"), { shiftId: c.shift.id })).items.map((row) => row.task.id)).toEqual([c.task.id]);
    expect((await c.service.searchPlanner(c.user("user-vet"), "", { shiftId: c.shift.id, types: ["HOSPITAL_TASK"] })).total).toBe(1);
    await expect(c.service.listHospitalTasks(c.user("user-lab"), { shiftId: c.shift.id })).rejects.toMatchObject({ status: 404 });
    await expect(c.service.searchPlanner(c.actor, "", { shiftId: "missing" })).rejects.toMatchObject({ status: 404 });
    expect((await c.service.searchPlanner(c.actor, "", { planId: c.plan.id, types: ["DIAGNOSTIC_ITEM", "DIAGNOSTIC_REQUEST"] })).total).toBe(0);
    expect((await c.service.searchPlanner(c.actor, "", { typeId: c.task.typeId, types: ["DIAGNOSTIC_ITEM", "DIAGNOSTIC_REQUEST", "PATIENT", "ENCOUNTER"] })).total).toBe(0);
  });
  it("filters assigned exams and requests by current context, priority, status and exact period", async () => {
    const c = await journey(); const item = c.store.getState().items[0];
    await c.store.transaction((state) => ({ state: { ...state, items: state.items.map((entry) => ({ ...entry, assignedUserId: "user-us", plannedStartsAt: "2026-10-12T10:00:00.000Z" })) }, result: undefined }));
    const types = ["DIAGNOSTIC_ITEM", "DIAGNOSTIC_REQUEST"] as const;
    const positive = { types: [...types], departmentCode: "ULTRASOUND", patientId: "patient-thor", encounterId: "encounter-thor", priority: "URGENT" as const, status: item.status, phase: "PENDING" as const, responsibleUserId: "user-us" };
    expect((await c.service.searchPlanner(c.actor, "", positive)).items.map((row) => row.type)).toEqual(expect.arrayContaining([...types]));
    expect((await c.service.searchPlanner(c.user("user-us"), "", { types: [...types], assignedToMe: true })).total).toBe(2);
    expect((await c.service.searchPlanner(c.actor, "", { types: [...types], assignedToMe: true })).total).toBe(0);
    for (const patch of [{ encounterId: "encounter-mel" }, { patientId: "patient-mel" }, { priority: "ROUTINE" as const }, { status: "COMPLETED" }, { phase: "IN_PROGRESS" as const }, { responsibleUserId: "user-lab" }, { departmentCode: "LABORATORY" }, { to: "2000-01-01T00:00:00Z" }, { from: "2090-01-01T00:00:00Z" }]) expect((await c.service.searchPlanner(c.actor, "", { ...positive, ...patch })).total).toBe(0);
    expect((await c.service.searchPlanner(c.actor, "", { types: ["DIAGNOSTIC_ITEM"], from: "2026-10-12T10:00:00Z", to: "2026-10-12T10:00:00Z" })).total).toBe(1);
    expect((await c.service.searchPlanner(c.actor, "nothing matches", { types: [...types] })).total).toBe(0);
    expect((await c.service.searchPlanner(c.actor, "", { shiftId: c.shift.id, types: [...types] })).total).toBe(0);
  });
  it.each([
    ["COMPLETED", "COMPLETED"], ["CANCELLED", "CANCELLED"], ["REJECTED", "CANCELLED"], ["RESULT_AVAILABLE", "IN_PROGRESS"], ["AWAITING_REPORT", "IN_PROGRESS"], ["REVIEWED", "IN_PROGRESS"]
  ] as const)("maps persisted diagnostic state %s to phase %s without performing a clinical transition", async (status, phase) => {
    const c = await journey();
    await c.store.transaction((state) => ({ state: { ...state, items: state.items.map((item) => ({ ...item, status })) }, result: undefined }));
    expect((await c.service.searchPlanner(c.actor, "", { types: ["DIAGNOSTIC_ITEM", "DIAGNOSTIC_REQUEST"], phase })).total).toBe(2);
    expect((await c.service.searchPlanner(c.actor, "", { types: ["DIAGNOSTIC_ITEM", "DIAGNOSTIC_REQUEST"], phase: "PENDING" })).total).toBe(0);
  });
  it("scopes patient/encounter discovery through existing admissions and requesting departments", async () => {
    const c = await journey();
    const positive = await c.service.searchPlanner(c.actor, "Thor", { types: ["PATIENT", "ENCOUNTER"], patientId: "patient-thor", encounterId: "encounter-thor", departmentCode: "INPATIENT" });
    expect(positive.total).toBe(2);
    for (const patch of [{ departmentCode: "IT" }, { encounterId: "missing" }, { patientId: "patient-mel" }, { from: "2090-01-01T00:00:00Z" }, { to: "2000-01-01T00:00:00Z" }]) expect((await c.service.searchPlanner(c.actor, "Thor", { types: ["PATIENT", "ENCOUNTER"], ...patch })).total).toBe(0);
    const encounter = c.store.getState().encounters.find((entry) => entry.id === "encounter-thor")!;
    await c.store.transaction((state) => ({ state: { ...state, encounters: [...state.encounters, { ...encounter, id: "encounter-thor-second", externalId: "SECOND", openedAt: "2026-10-10T00:00:00.000Z" }] }, result: undefined }));
    expect((await c.service.searchPlanner(c.actor, "Thor", { types: ["ENCOUNTER"] })).total).toBe(2);
    expect((await c.service.searchPlanner(c.user("user-manager"), "Thor", { types: ["ENCOUNTER"] })).total).toBeGreaterThan(0);
  });
});

describe("every search result opens a concrete application route", () => {
  it("links both patient and encounter discovery to the authorized patient diagnostics page", async () => {
    const c = await journey();
    const results = await c.service.searchPlanner(c.actor, "Thor", { types: ["PATIENT", "ENCOUNTER"] });
    expect(results.items.map((row) => row.type)).toEqual(expect.arrayContaining(["PATIENT", "ENCOUNTER"]));
    for (const row of results.items) expect.soft(row.deepLink).toBe(`/patients/${row.patientId}/diagnostics`);
  });
  it("keeps all nine sources on existing detail pages or selectors without including clinical payload", async () => {
    const c = await journey(); const page = await c.service.searchPlanner(c.actor, "");
    const routes: Record<string, string> = {
      [`HOSPITAL_TASK:${c.task.id}`]: `/planner/tasks/${c.task.id}`,
      [`HOSPITAL_PLAN:${c.plan.id}`]: `/planner/plans/${c.plan.id}`,
      [`HOSPITAL_SHIFT:${c.shift.id}`]: `/planner/shifts/${c.shift.id}`,
      [`CHECKLIST_TEMPLATE:${c.template.id}`]: `/planner/checklists?templateId=${c.template.id}`,
      [`HOSPITAL_RECURRENCE:${c.recurrence.id}`]: `/planner/recurrences?recurrenceId=${c.recurrence.id}`,
      [`DIAGNOSTIC_REQUEST:${c.request.id}`]: `/requests/${c.request.id}`,
      [`DIAGNOSTIC_ITEM:${c.request.items[0].id}`]: `/requests/${c.request.id}#${c.request.items[0].id}`,
      "PATIENT:patient-thor": "/patients/patient-thor/diagnostics",
      "ENCOUNTER:encounter-thor": "/patients/patient-thor/diagnostics"
    };
    for (const [key, deepLink] of Object.entries(routes)) expect.soft(page.items.find((row) => `${row.type}:${row.id}` === key)?.deepLink).toBe(deepLink);
    expect(JSON.stringify(page)).not.toMatch(/passwordHash|referenceRange|narrative|patientIds/);
  });
});
