import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hospitalPlannerHttpFixture as fixture } from "@/test/hospital-planner-http-fixture";
import { resetRateLimits } from "../security/rate-limit";

const version = (value: number) => ({ "if-match": `"${value}"` });
const display = { layout: "BOARD", orderBy: "PRIORITY", direction: "DESC", groupBy: "PHASE", columns: ["title", "priority", "phase"] };
const panel = { code: "HTTP_SYNTHETIC", name: "Painel exclusivamente sintético", schemaVersion: "1", analytes: [{ code: "VALUE", label: "Valor sintético", valueType: "NUMERIC", unitCode: "fixture/unit", required: true, displayOrder: 1, referenceRange: { kind: "NUMERIC", unitCode: "fixture/unit", low: 1, high: 10, source: "PENDING_HUMAN_POLICY" } }] };

describe.sequential("administration and saved configurations through actual HTTP commands", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime("2026-10-11T12:00:00Z"); process.env.APP_DATA_MODE = "memory"; resetRateLimits(); });
  afterEach(() => { vi.useRealTimers(); delete process.env.APP_DATA_MODE; delete globalThis.__cvgDiagnosticsStore; delete globalThis.__cvgDiagnosticsStorePromise; delete globalThis.__cvgDiagnosticsFileStore; resetRateLimits(); });

  it("manages a stable department and its team without granting patient scope", async () => {
    const c = await fixture(); const originalUsers = structuredClone(c.store.getState().users);
    const created = await c.send("user-admin", "POST", "departments", { code: "HTTP_SUPPORT", name: "Apoio hospitalar", type: "SUPPORT" });
    expect(created.status).toBe(201); const id = created.envelope.data.id;
    expect((await c.send("user-admin", "GET", `departments/${id}`)).envelope.data).toMatchObject({ code: "HTTP_SUPPORT", version: 1 });
    expect((await c.send("user-manager", "PATCH", `departments/${id}`, { name: "Tentativa fora da delegação" }, version(1))).status).toBe(404);
    const edited = await c.send("user-admin", "PATCH", `departments/${id}`, { name: "Apoio revisado" }, version(1)); expect(edited.status).toBe(200);
    expect((await c.send("user-admin", "PATCH", `departments/${id}`, { name: "Obsoleto" }, version(1))).status).toBe(409);
    const members = await c.send("user-admin", "PUT", "departments/department-INPATIENT/members", { memberUserIds: ["user-vet", "vet-b"], responsibleUserId: "vet-b" }, version(1)); expect(members.status).toBe(200);
    expect(members.envelope.data.responsibleUserId).toBe("vet-b"); expect(c.store.getState().users).toEqual(originalUsers);
    expect((await c.send("user-admin", "POST", `departments/${id}/deactivate`, {}, version(2))).envelope.data.active).toBe(false);
    const inactive = await c.send("user-admin", "GET", "departments?includeInactive=true"); expect(inactive.envelope.data.some((row: { id: string }) => row.id === id)).toBe(true);
    expect((await c.send("user-admin", "PATCH", `departments/${id}`, { active: true }, version(3))).envelope.data.active).toBe(true);
    expect((await c.send("user-admin", "GET", "departments?includeInactive=invalid")).status).toBe(400);
    expect((await c.send("user-admin", "POST", `departments/${id}`, {})).status).toBe(404);
  });

  it("previews and assigns a group with optimistic revisions, then withdraws an existing session", async () => {
    const c = await fixture();
    expect((await c.send("user-admin", "POST", "session/reauth", { password: "synthetic-planning-http-password" })).status).toBe(200);
    expect((await c.send("user-admin", "GET", "access-groups/permissions")).status).toBe(200);
    const created = await c.send("user-admin", "POST", "access-groups", { code: "HTTP_CLINICAL_READ", description: "Leitura sem execução", permissions: ["patient.view", "request.list"] }); expect(created.status).toBe(201); const id = created.envelope.data.id;
    expect((await c.send("user-admin", "GET", "access-groups")).envelope.data.some((row: { id: string }) => row.id === id)).toBe(true);
    const preview = await c.send("user-admin", "POST", "users/vet-b/access-preview", { accessGroupId: id }); expect(preview.status).toBe(200); expect(preview.envelope.data.permissions).toEqual(["patient.view", "request.list"]);
    expect((await c.send("user-admin", "PUT", "users/vet-b/access-group", { accessGroupId: id, expectedGroupVersion: 1 }, version(1))).status).toBe(200);
    expect((await c.send("vet-b", "GET", "diagnostic-requests")).status).toBe(200);
    const edited = await c.send("user-admin", "PATCH", `access-groups/${id}`, { description: "Leitura revisada" }, version(1)); expect(edited.envelope.data.version).toBe(2);
    expect((await c.send("user-admin", "PATCH", `access-groups/${id}`, { permissions: [] }, version(1))).status).toBe(409);
    expect((await c.send("user-admin", "PATCH", `access-groups/${id}`, { permissions: [] }, version(2))).status).toBe(200);
    expect((await c.send("vet-b", "GET", "diagnostic-requests")).status).toBe(401);
    expect(c.store.getState().users.find(user => user.id === "vet-b")?.active).toBe(true);
  });

  it("withdraws and restores an explicit patient grant while retaining the author's request", async () => {
    const c = await fixture(); const request = await c.service.createRequest(c.actor("user-vet"), { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-crp" }] }, { idempotencyKey: "grant-request" });
    expect((await c.send("user-admin", "GET", "users/vet-b/patient-grants")).status).toBe(200);
    const revoked = await c.send("user-admin", "PUT", "users/vet-b/patient-grants", { patientId: "patient-thor", active: false, reason: "Fim do vínculo sintético" }, version(1)); expect(revoked.status).toBe(200);
    expect((await c.send("vet-b", "GET", `diagnostic-requests/${request.id}`)).status).toBe(404);
    expect((await c.send("user-admin", "PUT", "users/vet-b/patient-grants", { patientId: "patient-thor", active: true, reason: "Novo vínculo sintético" }, version(1))).status).toBe(409);
    expect((await c.send("user-admin", "PUT", "users/vet-b/patient-grants", { patientId: "patient-thor", active: true, reason: "Novo vínculo sintético" }, version(2))).status).toBe(200);
    // Revocation intentionally invalidates the previous browser session.
    expect((await c.send("vet-b", "GET", `diagnostic-requests/${request.id}`)).status).toBe(401);
    expect((await c.service.getRequest(c.actor("vet-b"), request.id)).requesterId).toBe("user-vet");
    expect(c.store.getState().requests).toHaveLength(1);
  });

  it("prepares and publishes an explicit clinical definition while refusing technical approval and spoofed provenance", async () => {
    const c = await fixture(); const path = "diagnostic-services/service-hemogram/template";
    const prepared = await c.send("user-admin", "PUT", path, { template: panel }, version(1)); expect(prepared.status).toBe(200); expect(prepared.envelope.data.resultTemplate.status).toBe("DRAFT");
    const approval = { confirm: true, policyReference: "SYNTHETIC_HTTP_TEST_ONLY_NOT_INSTITUTIONAL_APPROVAL", population: { species: ["Canino"] } };
    expect((await c.send("user-admin", "POST", `${path}/publish`, approval, version(2))).status).toBe(404);
    expect((await c.send("user-admin", "PUT", path, { template: { ...panel, approval: { approvedBy: "user-vet" } } }, version(2))).status).toBe(400);
    const approved = await c.send("user-vet", "POST", `${path}/publish`, approval, version(2)); expect(approved.status).toBe(200); expect(approved.envelope.data.resultTemplate.approval.approvedBy).toBe("user-vet");
    const history = await c.send("user-vet", "GET", "diagnostic-services/service-hemogram/definitions"); expect(history.status).toBe(200); expect(history.envelope.data.length).toBeGreaterThanOrEqual(2);
    const definitions = structuredClone(c.store.getState().examDefinitions);
    expect((await c.send("user-admin", "POST", `${path}/retire`, { reason: "Retirada sintética" }, version(3))).status).toBe(200);
    expect(c.store.getState().examDefinitions.slice(0, definitions.length)).toEqual(definitions);
  });

  it("assigns and plans an exam without changing phase or restarting the clinical SLA", async () => {
    const c = await fixture(); const request = await c.service.createRequest(c.actor("user-vet"), { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-crp" }] }, { idempotencyKey: "planning-request" }); const item = request.items[0];
    const directory = await c.send("user-manager", "GET", `diagnostic-items/${item.id}/assignees`); expect(directory.status).toBe(200); expect(directory.envelope.data.some((user: { id: string }) => user.id === "user-lab")).toBe(true);
    expect((await c.send("user-manager", "PUT", `diagnostic-items/${item.id}/assignment`, { userId: "user-lab" }, version(1))).status).toBe(200);
    const planned = await c.send("user-lab", "PUT", `diagnostic-items/${item.id}/planning`, { plannedStartsAt: "2026-10-11T14:00:00Z", plannedEndsAt: "2026-10-11T15:00:00Z" }, version(2)); expect(planned.status).toBe(200);
    expect((await c.send("user-manager", "PUT", `diagnostic-items/${item.id}/priority`, { priority: "URGENT", reason: "Reclassificação sintética autorizada" }, version(3))).status).toBe(200);
    expect(c.store.getState().items[0]).toMatchObject({ status: "REQUESTED", slaStartedAt: item.slaStartedAt, priority: "URGENT", version: 4 }); expect(c.store.getState().schedules).toEqual([]);
    expect((await c.send("user-manager", "PUT", `diagnostic-items/${item.id}/priority`, { priority: "EMERGENCY", reason: "" }, version(4))).status).toBe(400);
  });

  it("persists private and shared view configurations without widening object permissions", async () => {
    const c = await fixture(); const created = await c.send("user-manager", "POST", "planner-views", { name: "Visão da equipe", sharedDepartmentCode: "LABORATORY", filters: { departmentCode: "LABORATORY" }, display }); expect(created.status).toBe(201); const id = created.envelope.data.id;
    expect((await c.send("user-lab", "GET", "planner-views")).envelope.data.map((row: { id: string }) => row.id)).toEqual([id]);
    expect((await c.send("user-rx", "GET", "planner-views")).envelope.data).toEqual([]);
    expect((await c.send("user-lab", "PATCH", `planner-views/${id}`, { name: "Não sou o dono" }, version(1))).status).toBe(404);
    expect((await c.send("user-manager", "PATCH", `planner-views/${id}`, { name: "Visão privada revisada", sharedDepartmentCode: null, filters: {}, display }, version(1))).status).toBe(200);
    expect((await c.send("user-lab", "GET", "planner-views")).envelope.data).toEqual([]);
    expect((await c.send("user-manager", "POST", `planner-views/${id}/deactivate`, {}, version(2))).status).toBe(200);
    expect((await c.send("user-manager", "GET", "planner-views")).envelope.data).toEqual([]);
    expect(c.store.getState().hospitalTasks).toEqual([]);
  });
  it("configures a task type, updates context and assignment, and triages an intake without bypassing dependencies", async () => {
    const c = await fixture(); const states = ["PENDING", "IN_PROGRESS", "COMPLETED", "CANCELLED"].map(phase => ({ code: phase, label: phase, phase }));
    const type = await c.send("user-admin", "POST", "hospital-task-types", { code: "HTTP_ROUTINE", name: "Rotina HTTP sintética", careContextRequired: false, states }); expect(type.status).toBe(201); const typeId = type.envelope.data.id;
    expect((await c.send("user-admin", "PATCH", `hospital-task-types/${typeId}`, { name: "Rotina configurada" }, version(1))).status).toBe(200);
    const taskInput = { typeId, title: "Atividade dependente", departmentCode: "INPATIENT", priority: "ROUTINE", responsibleUserId: "user-vet" };
    const dependent = await c.send("user-vet", "POST", "hospital-tasks", taskInput); expect(dependent.status).toBe(201); const taskId = dependent.envelope.data.task.id;
    expect((await c.send("user-vet", "PUT", `hospital-tasks/${taskId}/context`, { patientId: "patient-thor", encounterId: "encounter-thor" }, version(1))).status).toBe(200);
    expect((await c.send("super", "PUT", `hospital-tasks/${taskId}/assignment`, { responsibleUserId: "vet-b", executorTeamUserIds: ["vet-b"], participantUserIds: ["user-vet"] }, version(2))).status).toBe(200);
    const prerequisite = await c.send("user-vet", "POST", "hospital-tasks", { ...taskInput, title: "Etapa prévia" }); expect(prerequisite.status).toBe(201);
    const unfilteredSearch = await c.send("user-vet", "GET", "planner/search"); expect(unfilteredSearch.status).toBe(200); expect(unfilteredSearch.envelope.data.items.some((entry: { id: string }) => entry.id === prerequisite.envelope.data.task.id)).toBe(true);
    const searched = await c.send("user-vet", "GET", "planner/search?types=HOSPITAL_TASK&assignedToMe=true&query=Etapa&limit=1"); expect(searched.status).toBe(200); expect(searched.envelope.data.items.map((entry: { id: string }) => entry.id)).toEqual([prerequisite.envelope.data.task.id]);
    const dependency = await c.send("user-vet", "PUT", `hospital-tasks/${taskId}/dependencies`, { targetType: "HOSPITAL_TASK", targetId: prerequisite.envelope.data.task.id, blocks: "START", active: true }, version(3)); expect(dependency.status).toBe(200);
    expect((await c.send("vet-b", "POST", `hospital-tasks/${taskId}/commands`, { command: "START" }, version(4))).status).toBe(409);
    const intake = await c.send("user-vet", "POST", "hospital-intakes", { title: "Triagem sintética", typeId, departmentCode: "INPATIENT", priority: "ROUTINE", source: "MANUAL" }); expect(intake.status).toBe(201); const intakeId = intake.envelope.data.id;
    expect((await c.send("user-vet", "GET", "hospital-intakes?departmentCode=INPATIENT&state=RECEIVED&query=Triagem&limit=1")).envelope.data.items.map((row: { id: string }) => row.id)).toEqual([intakeId]);
    expect((await c.send("user-vet", "POST", `hospital-intakes/${intakeId}/triage`, { decision: "DEFER", reason: "Aguardar decisão sintética" }, version(1))).status).toBe(200);
    expect((await c.send("user-vet", "POST", `hospital-intakes/${intakeId}/triage`, { decision: "REJECT", reason: "Não adotar nesta jornada" }, version(2))).status).toBe(200);
    expect(c.store.getState().hospitalTasks).toHaveLength(2); expect(c.store.getState().hospitalTasks.every(task => task.phase === "PENDING")).toBe(true);
  });
});
