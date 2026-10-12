import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, PATCH, POST } from "../../app/api/v1/[...path]/route";
import { createApplicationService } from "../application/service";
import { OPERATION_NOW, OPERATION_WINDOW, BOOKING_WINDOW } from "../../test/hospital-operation-fixtures";
import { loginUser } from "../security/session";
import { resetRateLimits } from "../security/rate-limit";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { systemGroupId } from "../security/access-group-policy";

const password = "hospital-resource-http-synthetic-password";
const resourceInput = { code: "SYNTHETIC_ROOM", name: "Sala sintética", kind: "ROOM", departmentCode: "ULTRASOUND", availabilityWindows: [OPERATION_WINDOW] };
async function fixture() {
  const state = createDemoState(password); const vet = state.users.find((user) => user.id === "user-vet")!;
  state.users.push({ ...vet, id: "viewer", email: "viewer@example.test", role: "VIEWER", accessGroupId: systemGroupId("VIEWER") });
  const store = new MemoryStore(state); globalThis.__cvgDiagnosticsStore = store; globalThis.__cvgDiagnosticsStorePromise = undefined;
  const sessions = new Map<string, Record<string, string>>(); let sequence = 0;
  const user = (id: string) => store.getState().users.find((entry) => entry.id === id)!;
  return { store, user, service: createApplicationService(store), async send(actorId: string, method: "GET" | "POST" | "PATCH", path: string, body?: unknown, headers: Record<string, string> = {}) {
    let session = sessions.get(actorId); if (!session) { const login = await loginUser(store, user(actorId).email, password); session = { cookie: `cvg_session=${login.sessionToken}; cvg_csrf=${login.csrfToken}`, origin: "http://localhost", "x-csrf-token": login.csrfToken, "content-type": "application/json" }; sessions.set(actorId, session); }
    const request = new Request(`http://localhost/api/v1/${path}`, { method, headers: { ...session, "idempotency-key": `resource-route-${++sequence}`, ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const response = await ({ GET, POST, PATCH })[method](request, { params: Promise.resolve({ path: path.split("?")[0].split("/") }) });
    return { status: response.status, envelope: await response.json() };
  } };
}
describe.sequential("hospital resources authenticated HTTP boundaries", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(OPERATION_NOW); process.env.APP_DATA_MODE = "memory"; resetRateLimits(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); delete process.env.APP_DATA_MODE; delete globalThis.__cvgDiagnosticsStore; delete globalThis.__cvgDiagnosticsStorePromise; delete globalThis.__cvgDiagnosticsFileStore; resetRateLimits(); });
  it("creates inventory and accepts header-only revision while rejecting stale or contradictory changes", async () => {
    const c = await fixture(); const created = await c.send("user-admin", "POST", "hospital-resources", resourceInput); expect(created.status, JSON.stringify(created.envelope.error)).toBe(201); const resource = created.envelope.data;
    const updated = await c.send("user-admin", "PATCH", `hospital-resources/${resource.id}`, { name: "Sala revisada" }, { "if-match": '"1"' }); expect(updated.status).toBe(200); expect(updated.envelope.data).toMatchObject({ name: "Sala revisada", version: 2 });
    expect((await c.send("user-admin", "PATCH", `hospital-resources/${resource.id}`, { name: "Obsoleta" }, { "if-match": '"1"' })).status).toBe(409);
    expect((await c.send("user-admin", "PATCH", `hospital-resources/${resource.id}`, { name: "Contraditória", expectedVersion: 2 }, { "if-match": '"1"' })).status).toBe(400);
    const page = await c.send("user-admin", "GET", "hospital-resources?kind=ROOM&limit=1"); expect(page.envelope.data).toMatchObject({ items: [expect.objectContaining({ id: resource.id, version: 2 })], total: 1 });
    expect((await c.send("user-admin", "GET", "hospital-resources?kind=INVALID")).status).toBe(400);
  });
  it("uses real task/resource context, rejects overlap atomically and hides reservations when calendar grant is withdrawn", async () => {
    const c = await fixture(); const resource = (await c.send("user-admin", "POST", "hospital-resources", resourceInput)).envelope.data;
    const tasks = await Promise.all(["one", "two"].map((title) => c.send("user-us", "POST", "hospital-tasks", { title, typeId: "hospital-task-type-routine", departmentCode: "ULTRASOUND", priority: "ROUTINE", responsibleUserId: "user-us" })));
    const bookings = await Promise.all(tasks.map((task) => c.send("user-us", "POST", `hospital-tasks/${task.envelope.data.task.id}/reservations`, { ...BOOKING_WINDOW, resourceIds: [resource.id] }, { "if-match": '"1"' })));
    expect(bookings.map((booking) => booking.status).sort()).toEqual([201, 409]); expect(c.store.getState().schedules).toHaveLength(1);
    const winner = tasks[bookings[0].status === 201 ? 0 : 1].envelope.data.task.id; const detail = await c.send("user-us", "GET", `hospital-tasks/${winner}`); expect(detail.envelope.data.reservations).toHaveLength(1);
    await c.store.transaction((state) => ({ state: { ...state, accessGroups: state.accessGroups.map((group) => group.id === systemGroupId("ULTRASOUND_TEAM") ? { ...group, permissions: group.permissions.filter((permission) => permission !== "hospital_calendar.view") } : group) }, result: undefined }));
    const narrowed = await c.send("user-us", "GET", `hospital-tasks/${winner}`); expect(narrowed.status).toBe(200); expect(narrowed.envelope.data.reservations ?? []).toEqual([]);
  });
  it("returns 422 unavailable and does not create a rejected reservation", async () => {
    const c = await fixture(); const resource = (await c.send("user-admin", "POST", "hospital-resources", { ...resourceInput, availability: "MAINTENANCE" })).envelope.data; const created = await c.send("user-us", "POST", "hospital-tasks", { title: "Tarefa sintética", typeId: "hospital-task-type-routine", departmentCode: "ULTRASOUND", priority: "ROUTINE" });
    const reservation = await c.send("user-us", "POST", `hospital-tasks/${created.envelope.data.task.id}/reservations`, { ...BOOKING_WINDOW, resourceIds: [resource.id] }, { "if-match": '"1"' }); expect(reservation.status, JSON.stringify(reservation.envelope.error)).toBe(422); expect(c.store.getState().schedules).toEqual([]);
  });
  it("reads and revises the same reservation while keeping deadlines, admission authority and activity phase separate", async () => {
    const c = await fixture(); const resource = (await c.send("user-admin", "POST", "hospital-resources", resourceInput)).envelope.data;
    expect((await c.send("user-us", "GET", `hospital-resources/${resource.id}`)).status).toBe(200);
    const created = await c.send("user-us", "POST", "hospital-tasks", { title: "Reserva revisável", typeId: "hospital-task-type-routine", departmentCode: "ULTRASOUND", priority: "ROUTINE" }); const taskId = created.envelope.data.task.id;
    const reserved = await c.send("user-us", "POST", `hospital-tasks/${taskId}/reservations`, { ...BOOKING_WINDOW, resourceIds: [resource.id] }, { "if-match": '"1"' }); expect(reserved.status).toBe(201); const schedule = c.store.getState().schedules[0];
    const window = new URLSearchParams({ from: OPERATION_WINDOW.startsAt, to: OPERATION_WINDOW.endsAt, departmentCode: "ULTRASOUND", kinds: "RESERVATION,DEADLINE,EXECUTION", limit: "1" });
    const agenda = await c.send("user-us", "GET", `hospital-calendar?${window}`); expect(agenda.status).toBe(200);
    expect((await c.send("user-us", "GET", `hospital-capacity?${new URLSearchParams({ from: OPERATION_WINDOW.startsAt, to: OPERATION_WINDOW.endsAt, departmentCode: "ULTRASOUND" })}`)).status).toBe(200);
    const moved = await c.send("user-us", "POST", `hospital-reservations/${schedule.id}/reschedule`, { ...BOOKING_WINDOW, resourceIds: [resource.id], reason: "Remarcação sintética" }, { "if-match": '"1"' }); expect(moved.status).toBe(200);
    expect((await c.send("user-us", "POST", `hospital-reservations/${schedule.id}/cancel`, { reason: "Versão obsoleta" }, { "if-match": '"1"' })).status).toBe(409);
    const replacement = moved.envelope.data.schedule;
    expect(replacement.id).not.toBe(schedule.id);
    expect((await c.send("user-us", "POST", `hospital-reservations/${replacement.id}/cancel`, { reason: "Cancelamento sintético" }, { "if-match": '"1"' })).status).toBe(200);
    expect(c.store.getState().hospitalTasks[0].phase).toBe("PENDING");
    expect(c.store.getState().schedules).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: schedule.id, status: "CANCELLED", version: 2 }),
      expect.objectContaining({ id: replacement.id, status: "CANCELLED", version: 2 })
    ]));
    vi.stubEnv("ADMISSION_CONTEXT_POLICY_ENABLED", "true"); vi.stubEnv("ADMISSION_CONTEXT_POLICY_VERSION", "SYNTHETIC-HTTP-D01"); vi.stubEnv("ADMISSION_CONTEXT_POLICY_APPROVAL_REF", "test-only-no-institutional-approval"); vi.stubEnv("ADMISSION_CONTEXT_POLICY_APPROVED_AT", "2026-01-01T00:00:00Z"); vi.stubEnv("ADMISSION_CONTEXT_ALLOWED_RESPONSIBLE_ROLES", "VETERINARIAN,INPATIENT_TEAM");
    const options = await c.send("user-manager", "GET", "admissions/admission-thor/context-options?departmentCode=INPATIENT"); expect(options.status).toBe(200); expect(JSON.stringify(options.envelope)).not.toMatch(/passwordHash|whatsapp|tokenHash/);
    expect((await c.send("user-vet", "GET", "admissions/admission-thor/context-options")).status).toBe(404);
    expect((await c.send("user-admin", "GET", "admissions/admission-thor/context-options")).status).toBe(404);
    expect((await c.send("user-us", "GET", "hospital-calendar?from=bad&to=bad")).status).toBe(400);
    expect((await c.send("user-admin", "GET", "hospital-resources?includeInactive=true&cursor=missing&limit=1")).status).toBe(400);
  });
  it("provides create-only metadata without clinical reads and hides patient identity in restricted census", async () => {
    const c = await fixture(); await c.store.transaction((state) => ({ state: { ...state, accessGroups: state.accessGroups.map((group) => group.id === systemGroupId("ADMIN") ? { ...group, permissions: ["hospital_resource.create"] } : group) }, result: undefined }));
    const options = await c.send("user-admin", "GET", "hospital-resources/options"); expect(options.status).toBe(200); expect(JSON.stringify(options.envelope)).not.toMatch(/passwordHash|patientIds|whatsapp/);
    const bed = (await c.send("user-admin", "POST", "hospital-resources", { code: "SYNTHETIC_BED", name: "Leito sintético", kind: "BED", departmentCode: "INPATIENT", ward: "UTI 1", bedLabel: "Box 03", allowedSpecies: ["Canino"] })).envelope.data;
    expect((await c.send("user-admin", "GET", "hospital-resources")).status).toBe(404); expect((await c.send("user-admin", "GET", "bed-census")).status).toBe(404);
    await c.store.transaction((state) => ({ state: { ...state, admissions: state.admissions.map((admission) => ({ ...admission, bedResourceId: bed.id })), users: state.users.map((user) => user.id === "viewer" ? { ...user, patientIds: ["patient-mel"] } : user) }, result: undefined }));
    const census = await c.send("viewer", "GET", "bed-census?departmentCode=INPATIENT"); expect(census.status).toBe(200); expect(census.envelope.data.beds[0].state).toBe("RESTRICTED_OCCUPANCY"); expect(JSON.stringify(census.envelope)).not.toMatch(/patient-thor|admission-thor|encounter-thor/);
  });
  it("confirms approved care through normal HTTP commands and records server evidence with If-Match", async () => {
    const c = await fixture(); const template = await c.send("user-admin", "POST", "hospital-checklist-templates", { code: "SYNTHETIC_PROCESS", name: "Processo sintético", departmentCode: "INPATIENT", careContextRequired: true, steps: [{ code: "IDENTIFY", label: "Conferência sintética", required: true, evidenceRequired: true }], clinicalProcess: { modality: "CARE", allowedExecutorRoles: ["VETERINARIAN"], clinicalSystemReference: "synthetic-clinical-record", confirmationPolicyReference: "synthetic-confirmation-policy" } }); expect(template.status, JSON.stringify(template.envelope.error)).toBe(201);
    const templateId = template.envelope.data.template.id; expect((await c.send("user-vet", "POST", `hospital-checklist-templates/${templateId}/approve`, {}, { "if-match": '"1"' })).status).toBe(200);
    const created = await c.send("user-vet", "POST", "hospital-tasks", { title: "Cuidado sintético", typeId: "hospital-task-type-care", departmentCode: "INPATIENT", patientId: "patient-thor", encounterId: "encounter-thor", responsibleUserId: "user-vet", priority: "ROUTINE", checklistTemplateId: templateId }); expect(created.status, JSON.stringify(created.envelope.error)).toBe(201); const taskId = created.envelope.data.task.id;
    expect((await c.send("user-vet", "POST", `hospital-tasks/${taskId}/commands`, { command: "START" }, { "if-match": '"1"' })).status).toBe(200);
    const confirmation = { confirm: true, clinicalRecordReference: "synthetic-record/entry" };
    expect((await c.send("user-vet", "POST", `hospital-tasks/${taskId}/care-execution`, confirmation, { "if-match": '"2"' })).status).toBe(409);
    expect((await c.send("user-vet", "POST", `hospital-tasks/${taskId}/checklist-steps`, { command: "DONE", stepCode: "IDENTIFY", evidenceText: "Evidência sintética" }, { "if-match": '"2"' })).status).toBe(200);
    expect((await c.send("user-vet", "POST", `hospital-tasks/${taskId}/commands`, { command: "COMPLETE" }, { "if-match": '"3"' })).status).toBe(409);
    expect((await c.send("user-vet", "POST", `hospital-tasks/${taskId}/care-execution`, { ...confirmation, confirm: false }, { "if-match": '"3"' })).status).toBe(400);
    const result = await c.send("user-vet", "POST", `hospital-tasks/${taskId}/care-execution`, confirmation, { "if-match": '"3"' }); expect(result.status, JSON.stringify(result.envelope.error)).toBe(200); expect(result.envelope.data.task.careExecution).toMatchObject({ performedBy: "user-vet", approvedBy: "user-vet", recordEvidence: "EXECUTOR_REFERENCE", clinicalRecordReference: confirmation.clinicalRecordReference }); expect(c.store.getState().items).toEqual([]);
  });
});
