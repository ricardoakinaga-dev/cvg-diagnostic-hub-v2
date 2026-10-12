import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimits } from "../security/rate-limit";
import { systemGroupId } from "../security/access-group-policy";
import { hospitalPlannerHttpFixture as fixture } from "@/test/hospital-planner-http-fixture";
import { rich } from "@/test/hospital-external-fixtures";

const revision = (version: number) => ({ "if-match": `"${version}"` });
const planInput = { title: "Plano de preparação Thor", objective: "Organizar atividades", patientId: "patient-thor", encounterId: "encounter-thor", departmentCodes: ["INPATIENT"], steps: [{ id: "prepare", title: "Preparação", sortOrder: 0 }] };
const templateInput = { code: "VERIFY_SUPPLIES", name: "Conferência de materiais", departmentCode: "INPATIENT", careContextRequired: false, steps: [{ code: "VERIFY", label: "Conferir", required: true, evidenceRequired: true }] };



describe.sequential("planning command journeys through authenticated HTTP", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime("2026-10-11T12:00:00Z"); process.env.APP_DATA_MODE = "memory"; resetRateLimits(); });
  afterEach(() => { vi.useRealTimers(); delete process.env.APP_DATA_MODE; delete globalThis.__cvgDiagnosticsStore; delete globalThis.__cvgDiagnosticsStorePromise; delete globalThis.__cvgDiagnosticsFileStore; resetRateLimits(); });

  it("creates, reads, filters and revises a real plan with header-only concurrency and nullable planning fields", async () => {
    const c = await fixture();
    const options = await c.send("user-vet", "GET", "hospital-planner/options?action=plan.create");
    expect(options.status).toBe(200);
    expect(options.envelope.data.departments.map((entry: { code: string }) => entry.code)).toEqual(["INPATIENT", "LABORATORY", "RADIOLOGY", "ULTRASOUND", "IT"]);
    const taskOptions = await c.send("user-vet", "GET", "hospital-tasks/options");
    expect(taskOptions.status).toBe(200);
    expect(taskOptions.envelope.data.departments.map((entry: { code: string }) => entry.code)).toEqual(["INPATIENT"]);
    for (const departmentCode of ["LABORATORY", "IT"]) {
      expect((await c.send("user-vet", "POST", "hospital-tasks", { title: "Não ampliar criação de tarefa", typeId: "hospital-task-type-routine", departmentCode, priority: "ROUTINE" })).status).toBe(404);
    }
    const created = await c.send("user-vet", "POST", "hospital-plans", planInput);
    expect(created.status, JSON.stringify(created.envelope.error)).toBe(201);
    const id = created.envelope.data.plan.id;
    const changed = await c.send("user-vet", "PATCH", `hospital-plans/${id}`, { title: " Plano revisado ", objective: " Objetivo revisado ", departmentCodes: ["INPATIENT"], responsibleUserId: "vet-b", plannedStartAt: "2026-10-11T13:00:00-03:00", plannedEndAt: "2026-10-11T15:00:00-03:00", steps: [{ id: "prepare", title: "Preparar", sortOrder: 1 }], documentIds: [] }, revision(1));
    expect(changed.status, JSON.stringify(changed.envelope.error)).toBe(200);
    expect(changed.envelope.data.plan).toMatchObject({ title: "Plano revisado", objective: "Objetivo revisado", responsibleUserId: "vet-b", plannedStartAt: "2026-10-11T16:00:00.000Z", version: 2 });
    expect((await c.send("user-vet", "GET", `hospital-plans/${id}`)).envelope.data.plan.id).toBe(id);
    const filtered = await c.send("user-vet", "GET", "hospital-plans?patientId=patient-thor&encounterId=encounter-thor&departmentCode=INPATIENT&state=ACTIVE&query=revisado&limit=1");
    expect(filtered.envelope.data.items.map((row: { plan: { id: string } }) => row.plan.id)).toEqual([id]);
    expect((await c.send("user-vet", "GET", "hospital-plans?patientId=patient-mel")).envelope.data.total).toBe(0);
    expect((await c.send("user-vet", "GET", "hospital-plans?encounterId=encounter-mel")).envelope.data.total).toBe(0);
    expect((await c.send("user-vet", "GET", "hospital-plans?departmentCode=LABORATORY")).envelope.data.total).toBe(0);
    expect((await c.send("user-vet", "GET", "hospital-plans?state=CLOSED")).envelope.data.total).toBe(0);
    expect((await c.send("user-vet", "GET", "hospital-plans?query=inexistente")).envelope.data.total).toBe(0);
    const before = structuredClone(c.store.getState().hospitalPlans);
    expect((await c.send("user-vet", "PATCH", `hospital-plans/${id}`, { title: "Obsoleta" }, revision(1))).status).toBe(409);
    expect((await c.send("user-vet", "PATCH", `hospital-plans/${id}`, { title: "Contraditória", expectedVersion: 1 }, revision(2))).status).toBe(400);
    expect(c.store.getState().hospitalPlans).toEqual(before);
    const cleared = await c.send("user-vet", "PATCH", `hospital-plans/${id}`, { responsibleUserId: null, plannedStartAt: null, plannedEndAt: null }, revision(2));
    expect(cleared.status).toBe(200);
    expect(cleared.envelope.data.plan.responsibleUserId).toBeUndefined();
    expect(cleared.envelope.data.plan.plannedStartAt).toBeUndefined();
  });

  it("links and unlinks existing work, rejects structural conflicts and closes without executing pending tasks", async () => {
    const c = await fixture(); const plan = (await c.send("super", "POST", "hospital-plans", { ...planInput, departmentCodes: ["INPATIENT", "LABORATORY"] })).envelope.data.plan;
    const task = await c.service.createHospitalTask(c.actor("super"), { title: "Preparação laboratório", typeId: "hospital-task-type-routine", departmentCode: "LABORATORY", priority: "ROUTINE", idempotencyKey: "linked-task" });
    const link = { stepId: "prepare", targetType: "HOSPITAL_TASK", targetId: task.task.id, active: true };
    const linked = await c.send("super", "PUT", `hospital-plans/${plan.id}/links`, link, { ...revision(1), "idempotency-key": "link" });
    expect(linked.status).toBe(200);
    expect((await c.send("super", "PUT", `hospital-plans/${plan.id}/links`, link, { ...revision(1), "idempotency-key": "link" })).envelope.data.plan.version).toBe(2);
    expect((await c.send("super", "PUT", `hospital-plans/${plan.id}/links`, link, revision(2))).envelope.data.plan.links).toHaveLength(1);
    expect((await c.send("super", "PATCH", `hospital-plans/${plan.id}`, { steps: [] }, revision(3))).status).toBe(409);
    expect((await c.send("super", "PATCH", `hospital-plans/${plan.id}`, { departmentCodes: ["INPATIENT"] }, revision(3))).status).toBe(409);
    expect((await c.send("super", "PUT", `hospital-plans/${plan.id}/links`, { ...link, stepId: "missing" }, revision(3))).status).toBe(400);
    const unlinked = await c.send("super", "PUT", `hospital-plans/${plan.id}/links`, { ...link, active: false }, revision(3));
    expect(unlinked.envelope.data.plan.links).toEqual([]);
    const pending = structuredClone(c.store.getState().hospitalTasks);
    const closed = await c.send("super", "POST", `hospital-plans/${plan.id}/commands`, { command: "CLOSE", reason: "Plano encerrado administrativamente" }, revision(4));
    expect(closed.status).toBe(200);
    expect((await c.send("super", "PATCH", `hospital-plans/${plan.id}`, { title: "Proibida" }, revision(5))).status).toBe(409);
    const archived = await c.send("super", "POST", `hospital-plans/${plan.id}/commands`, { command: "ARCHIVE" }, revision(5));
    expect(archived.envelope.data.plan.state).toBe("ARCHIVED");
    expect(c.store.getState().hospitalTasks).toEqual(pending);
    expect(c.store.getState().items).toEqual([]);
  });

  it("revalidates plan identity and grants on replay and hides reads after current revocation", async () => {
    const c = await fixture(); const created = await c.send("user-vet", "POST", "hospital-plans", planInput, { "idempotency-key": "create-replay" }); const id = created.envelope.data.plan.id;
    expect((await c.send("user-vet", "POST", "hospital-plans", planInput, { "idempotency-key": "create-replay" })).envelope.data.plan.id).toBe(id);
    const edit = { objective: "Coordenar pendências" };
    expect((await c.send("user-vet", "PATCH", `hospital-plans/${id}`, edit, { ...revision(1), "idempotency-key": "edit-replay" })).status).toBe(200);
    expect((await c.send("user-vet", "PATCH", `hospital-plans/${id}`, edit, { ...revision(1), "idempotency-key": "edit-replay" })).envelope.data.plan.version).toBe(2);
    await c.store.transaction((state) => ({ state: { ...state, accessGroups: state.accessGroups.map((group) => group.id === systemGroupId("VETERINARIAN") ? { ...group, permissions: group.permissions.filter((permission) => !permission.startsWith("plan.")) } : group) }, result: undefined }));
    expect((await c.send("user-vet", "POST", "hospital-plans", planInput, { "idempotency-key": "create-replay" })).status).toBe(404);
    expect((await c.send("user-vet", "PATCH", `hospital-plans/${id}`, edit, { ...revision(1), "idempotency-key": "edit-replay" })).status).toBe(404);
    expect((await c.send("user-vet", "GET", `hospital-plans/${id}`)).status).toBe(404);
    expect(c.store.getState().hospitalPlans).toHaveLength(1);
  });

  it("captures the approved document and refuses to replace it after the linked activity has started", async () => {
    const c = await fixture();
    const created = await c.send("user-admin", "POST", "hospital-documents", { code: "PLAN_HTTP_POLICY", title: "Documento sintético do plano", departmentCode: "INPATIENT", responsibleUserId: "user-vet", content: rich("Conteúdo aprovado sintético") }); expect(created.status).toBe(201); const documentId = created.envelope.data.document.id;
    const approval = await c.send("user-vet", "POST", `hospital-documents/${documentId}/approve`, { expectedDraftVersion: 1, confirm: true, policyReference: "SYNTHETIC_HTTP_NOT_INSTITUTIONAL_APPROVAL" }, revision(1)); expect(approval.status).toBe(200);
    const { steps: _steps, ...input } = planInput;
    const plan = await c.send("user-vet", "POST", "hospital-plans", { ...input, documentIds: [documentId] }); expect(plan.status).toBe(201); const id = plan.envelope.data.plan.id; const stepId = plan.envelope.data.plan.steps[0].id;
    const captured = structuredClone(plan.envelope.data.plan.documentSnapshots); expect(captured).toHaveLength(1);
    const task = await c.send("user-vet", "POST", "hospital-tasks", { title: "Atividade com referência congelada", typeId: "hospital-task-type-care", departmentCode: "INPATIENT", patientId: "patient-thor", encounterId: "encounter-thor", responsibleUserId: "user-vet", priority: "ROUTINE" }); expect(task.status).toBe(201); const taskId = task.envelope.data.task.id;
    expect((await c.send("user-vet", "PUT", `hospital-plans/${id}/links`, { stepId, targetType: "HOSPITAL_TASK", targetId: taskId, active: true }, revision(1))).status).toBe(200);
    expect((await c.send("user-vet", "POST", `hospital-tasks/${taskId}/commands`, { command: "START" }, revision(1))).status).toBe(200);
    expect((await c.send("user-admin", "POST", `hospital-documents/${documentId}/revisions`, {}, revision(2))).status).toBe(200);
    expect((await c.send("user-admin", "PATCH", `hospital-documents/${documentId}/draft`, { expectedDraftVersion: 1, content: rich("Nova edição não publicada") }, revision(3))).status).toBe(200);
    const before = structuredClone(c.store.getState().hospitalPlans);
    expect((await c.send("user-vet", "PATCH", `hospital-plans/${id}`, { documentIds: [] }, revision(2))).status).toBe(409); expect(c.store.getState().hospitalPlans).toEqual(before);
    const metadata = await c.send("user-vet", "PATCH", `hospital-plans/${id}`, { objective: "Objetivo preserva a definição utilizada" }, revision(2)); expect(metadata.status).toBe(200); expect(metadata.envelope.data.plan.documentSnapshots).toEqual(captured);
    const replayHeaders = { ...revision(3), "idempotency-key": "close-frozen-plan" };
    expect((await c.send("user-vet", "POST", `hospital-plans/${id}/commands`, { command: "CLOSE" }, replayHeaders)).status).toBe(200);
    expect((await c.send("user-vet", "POST", `hospital-plans/${id}/commands`, { command: "CLOSE" }, replayHeaders)).envelope.data.plan.version).toBe(4);
    expect(c.store.getState().hospitalTasks[0].phase).toBe("IN_PROGRESS");
  });

  it("rejects unpublished and out-of-sector links, preserves an unlinked target and paginates plans without loss", async () => {
    const c = await fixture(); const ids = [];
    for (const title of ["Plano Alfa", "Plano Beta"]) { const created = await c.send("super", "POST", "hospital-plans", { ...planInput, title }); expect(created.status).toBe(201); ids.push(created.envelope.data.plan.id); }
    const first = await c.send("super", "GET", "hospital-plans?limit=1"); const second = await c.send("super", "GET", `hospital-plans?limit=1&cursor=${first.envelope.data.nextCursor}`); expect(new Set([...first.envelope.data.items, ...second.envelope.data.items].map(row => row.plan.id))).toEqual(new Set(ids));
    const draft = await c.send("user-vet", "POST", "hospital-task-drafts", { title: "Rascunho não publicado", typeId: "hospital-task-type-routine", departmentCode: "INPATIENT", priority: "ROUTINE" }); expect(draft.status).toBe(201);
    const link = { stepId: "prepare", targetType: "HOSPITAL_TASK", targetId: draft.envelope.data.task.id, active: true };
    expect((await c.send("super", "PUT", `hospital-plans/${ids[0]}/links`, link, revision(1))).status).toBe(409);
    const lab = await c.send("super", "POST", "hospital-tasks", { title: "Laboratório fora do plano", typeId: "hospital-task-type-routine", departmentCode: "LABORATORY", priority: "ROUTINE" }); expect(lab.status).toBe(201);
    expect((await c.send("super", "PUT", `hospital-plans/${ids[0]}/links`, { ...link, targetId: lab.envelope.data.task.id }, revision(1))).status).toBe(400);
    const notLinked = await c.send("user-vet", "POST", "hospital-tasks", { title: "Atividade nunca vinculada", typeId: "hospital-task-type-routine", departmentCode: "INPATIENT", priority: "ROUTINE" }); expect(notLinked.status).toBe(201);
    const detached = await c.send("super", "PUT", `hospital-plans/${ids[0]}/links`, { ...link, targetId: notLinked.envelope.data.task.id, active: false }, revision(1)); expect(detached.status).toBe(200); expect(detached.envelope.data.plan.links).toEqual([]);
    expect(c.store.getState().hospitalTasks.every(task => task.phase === "PENDING")).toBe(true);
  });

  it("creates, filters and revises real shifts, preserving closed and archived history", async () => {
    const c = await fixture(); const body = { name: "Plantão de manhã", departmentCode: "INPATIENT", startAt: "2026-10-11T06:00:00Z", endAt: "2026-10-11T12:00:00Z", members: [{ userId: "user-vet" }] };
    const created = await c.send("super", "POST", "hospital-shifts", body, { "idempotency-key": "shift-create" }); expect(created.status).toBe(201); const id = created.envelope.data.shift.id;
    expect((await c.send("super", "POST", "hospital-shifts", body, { "idempotency-key": "shift-create" })).envelope.data.shift.id).toBe(id);
    expect((await c.send("super", "GET", `hospital-shifts/${id}`)).envelope.data.shift.id).toBe(id);
    const page = await c.send("super", "GET", "hospital-shifts?departmentCode=INPATIENT&status=PLANNED&current=false&from=2026-10-11T07:00:00Z&to=2026-10-11T11:00:00Z"); expect(page.envelope.data.total).toBe(1);
    const changed = await c.send("super", "PATCH", `hospital-shifts/${id}`, { name: "Plantão ajustado", startAt: "2026-10-11T05:00:00Z", endAt: "2026-10-11T11:30:00Z", members: [{ userId: "vet-b", replacesUserId: "user-vet" }] }, { ...revision(1), "idempotency-key": "shift-edit" }); expect(changed.status, JSON.stringify(changed.envelope.error)).toBe(200);
    expect((await c.send("super", "PATCH", `hospital-shifts/${id}`, { name: "Plantão ajustado", startAt: "2026-10-11T05:00:00Z", endAt: "2026-10-11T11:30:00Z", members: [{ userId: "vet-b", replacesUserId: "user-vet" }] }, { ...revision(1), "idempotency-key": "shift-edit" })).envelope.data.shift.version).toBe(2);
    expect((await c.send("super", "PATCH", `hospital-shifts/${id}`, { name: "Obsoleto" }, revision(1))).status).toBe(409);
    expect((await c.send("super", "PATCH", `hospital-shifts/${id}`, { status: "CLOSED" }, revision(2))).status).toBe(200);
    expect((await c.send("super", "PATCH", `hospital-shifts/${id}`, { members: [] }, revision(3))).status).toBe(409);
    expect((await c.send("super", "PATCH", `hospital-shifts/${id}`, { status: "ARCHIVED" }, revision(3))).envelope.data.shift.status).toBe("ARCHIVED");
    expect((await c.send("super", "PATCH", `hospital-shifts/${id}`, { name: "Não reescrever" }, revision(4))).status).toBe(409);
  });

  it("assigns a shift and accepts a nominal handoff through HTTP without executing the activity", async () => {
    const c = await fixture(); const shift = async (name: string, startAt: string, endAt: string, userId: string) => (await c.send("super", "POST", "hospital-shifts", { name, departmentCode: "INPATIENT", startAt, endAt, members: [{ userId }] })).envelope.data.shift;
    const from = await shift("Origem", "2026-10-11T06:00:00Z", "2026-10-11T12:00:00Z", "user-vet"); const to = await shift("Destino", "2026-10-11T12:00:00Z", "2026-10-11T18:00:00Z", "vet-b");
    const task = await c.service.createHospitalTask(c.actor("user-vet"), { title: "Pendência assistencial", typeId: "hospital-task-type-care", departmentCode: "INPATIENT", patientId: "patient-thor", encounterId: "encounter-thor", responsibleUserId: "user-vet", priority: "URGENT", idempotencyKey: "handoff-task" });
    const assigned = await c.send("super", "PUT", "hospital-activities/shift", { targetType: "HOSPITAL_TASK", targetId: task.task.id, shiftId: from.id }, revision(1)); expect(assigned.status).toBe(200);
    const offered = await c.send("user-vet", "POST", "hospital-handoffs", { fromShiftId: from.id, toShiftId: to.id, recipientUserId: "vet-b", entries: [{ targetType: "HOSPITAL_TASK", targetId: task.task.id, expectedTargetVersion: 2 }] }); expect(offered.status).toBe(201); const id = offered.envelope.data.handoff.id;
    const list = await c.send("vet-b", "GET", "hospital-handoffs?departmentCode=INPATIENT&state=OFFERED&limit=1"); expect(list.envelope.data.total).toBe(1);
    expect((await c.send("user-vet", "POST", `hospital-handoffs/${id}/decision`, { decision: "ACCEPT" }, revision(1))).status).toBe(404);
    const accepted = await c.send("vet-b", "POST", `hospital-handoffs/${id}/decision`, { decision: "ACCEPT" }, { ...revision(1), "idempotency-key": "accept-replay" }); expect(accepted.status).toBe(200);
    expect((await c.send("vet-b", "POST", `hospital-handoffs/${id}/decision`, { decision: "ACCEPT" }, { ...revision(1), "idempotency-key": "accept-replay" })).envelope.data.handoff.state).toBe("ACCEPTED");
    expect(c.store.getState().hospitalTasks[0]).toMatchObject({ phase: "PENDING", responsibleUserId: "vet-b", shiftId: to.id, priority: "URGENT" });
  });

  it("uses versioned template approval, frozen occurrence evidence and explicit retirement through HTTP", async () => {
    const c = await fixture(); const created = await c.send("user-admin", "POST", "hospital-checklist-templates", templateInput); expect(created.status).toBe(201); const id = created.envelope.data.template.id;
    const updated = await c.send("user-admin", "PATCH", `hospital-checklist-templates/${id}`, { name: "Materiais revisados" }, revision(1)); expect(updated.status).toBe(200);
    expect((await c.send("user-admin", "POST", `hospital-checklist-templates/${id}/approve`, {}, revision(2))).status).toBe(404);
    expect((await c.send("user-vet", "POST", `hospital-checklist-templates/${id}/approve`, {}, revision(2))).status).toBe(200);
    const page = await c.send("user-vet", "GET", "hospital-checklist-templates?departmentCode=INPATIENT&status=APPROVED&query=Materiais&limit=1"); expect(page.envelope.data.total).toBe(1);
    const task = await c.service.createHospitalTask(c.actor("user-vet"), { title: "Conferência congelada", typeId: "hospital-task-type-routine", departmentCode: "INPATIENT", responsibleUserId: "user-vet", checklistTemplateId: id, priority: "ROUTINE", idempotencyKey: "check-task" }); const taskId = task.task.id;
    const done = { stepCode: "VERIFY", command: "DONE", evidenceText: "Materiais conferidos" };
    const recorded = await c.send("user-vet", "POST", `hospital-tasks/${taskId}/checklist-steps`, done, { ...revision(1), "idempotency-key": "check-done" }); expect(recorded.status).toBe(200);
    expect((await c.send("user-vet", "POST", `hospital-tasks/${taskId}/checklist-steps`, done, { ...revision(1), "idempotency-key": "check-done" })).envelope.data.task.version).toBe(2);
    expect((await c.send("user-vet", "POST", `hospital-tasks/${taskId}/checklist-steps`, done, revision(2))).status).toBe(409);
    const invalidated = await c.send("user-vet", "POST", `hospital-tasks/${taskId}/checklist-steps`, { stepCode: "VERIFY", command: "VOID", reason: "Selecionada a conferência incorreta" }, revision(2)); expect(invalidated.envelope.data.task.checklistExecutions[0].status).toBe("VOIDED");
    expect((await c.send("user-admin", "POST", `hospital-checklist-templates/${id}/retire`, {}, revision(3))).status).toBe(200);
    expect(c.store.getState().hospitalTasks[0].checklistSnapshot?.templateVersion).toBe(3);
    expect((await c.send("user-admin", "PATCH", `hospital-checklist-templates/${id}`, { name: "Reabrir indevidamente" }, revision(4))).status).toBe(409);
  });

  it("generates bounded recurring work and revises only its future definition through HTTP", async () => {
    const c = await fixture(); const template = (await c.send("user-admin", "POST", "hospital-checklist-templates", templateInput)).envelope.data.template; await c.send("user-vet", "POST", `hospital-checklist-templates/${template.id}/approve`, {}, revision(1));
    const created = await c.send("user-vet", "POST", "hospital-recurrences", { templateId: template.id, departmentCode: "INPATIENT", title: "Conferência recorrente", priority: "ROUTINE", startAt: "2026-10-11T11:00:00Z", intervalMinutes: 60 }); expect(created.status).toBe(201); const id = created.envelope.data.recurrence.id;
    const generated = await c.send("user-vet", "POST", "hospital-recurrences/generate", { limit: 1 }); expect(generated.status).toBe(200); expect(generated.envelope.data.generated).toBe(1);
    const historical = structuredClone(c.store.getState().hospitalTasks);
    const version = c.store.getState().hospitalRecurrences[0].version;
    const stopped = await c.send("user-vet", "PATCH", `hospital-recurrences/${id}`, { title: "Definição futura", priority: "URGENT", active: false, responsibleUserId: null, endAt: null }, revision(version)); expect(stopped.status, JSON.stringify(stopped.envelope.error)).toBe(200);
    expect((await c.send("user-vet", "GET", "hospital-recurrences?departmentCode=INPATIENT&active=false&limit=1")).envelope.data.total).toBe(1);
    expect((await c.send("user-vet", "GET", "hospital-recurrences?active=true")).envelope.data.total).toBe(0);
    expect(c.store.getState().hospitalTasks).toEqual(historical);
    expect((await c.send("user-vet", "POST", "hospital-recurrences/generate", { asOf: "2026-10-12T12:00:00Z" })).status).toBe(400);
  });

  it("rejects invalid filters and missing protections before writing any planning data", async () => {
    const c = await fixture();
    expect((await c.send("user-vet", "GET", "hospital-planner/options?action=invalid")).status).toBe(400);
    expect((await c.send("user-vet", "GET", "hospital-plans?state=INVALID")).status).toBe(400);
    expect((await c.send("super", "GET", "hospital-shifts?current=maybe")).status).toBe(400);
    expect((await c.send("user-vet", "GET", "hospital-recurrences?active=maybe")).status).toBe(400);
    expect((await c.send("user-vet", "POST", "hospital-plans", planInput, { "x-csrf-token": null })).status).toBe(403);
    expect((await c.send("user-vet", "POST", "hospital-plans", planInput, { "idempotency-key": null })).status).toBe(400);
    expect(c.store.getState().hospitalPlans).toEqual([]);
    expect(c.store.getState().hospitalShifts).toEqual([]);
  });
});
