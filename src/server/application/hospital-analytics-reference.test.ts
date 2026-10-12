import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HospitalHandoff, HospitalMetricCode, HospitalMetricRow } from "@cvg/contracts";
import { hospitalOperationFixture } from "../../test/hospital-operation-fixtures";
import { systemGroupId } from "../security/access-group-policy";
import { requireActiveUser } from "./service-common";
import { deriveHospitalMetricRows } from "./hospital-metrics-service";
import { hospitalMetricDefinition } from "./hospital-metric-definitions";
import { captureHospitalReportRows, resolveHospitalReportRows, readHospitalReportArchiveReferences } from "./hospital-report-rows";

const start = "2026-10-11T00:00:00.000Z"; const end = "2026-10-12T00:00:00.000Z";
const at = "2026-10-11T10:00:00.000Z"; const filters = { from: start, to: end };
async function fixture() {
  const f = hospitalOperationFixture(); const vet = f.user("user-vet");
  await f.store.transaction((state) => ({ state: { ...state, users: [...state.users, { ...vet, id: "super", role: "SUPERADMIN", accessGroupId: systemGroupId("SUPERADMIN") }] }, result: undefined }));
  const task = await f.task("reference-task", "INPATIENT");
  const plan = await f.service.createHospitalPlan(vet, { title: "Plano sintético", objective: "Avaliação", patientId: "patient-thor", encounterId: "encounter-thor", departmentCodes: ["INPATIENT"], idempotencyKey: "reference-plan" });
  const shift = await f.service.createHospitalShift(f.user("super"), { name: "Plantão sintético", departmentCode: "INPATIENT", startAt: at, endAt: "2026-10-11T18:00:00Z", members: [], idempotencyKey: "reference-shift" });
  const request = await f.service.createRequest(vet, { patientId: "patient-thor", encounterId: "encounter-thor", admissionId: "admission-thor", priority: "ROUTINE", items: [{ serviceId: "service-hemogram" }, { serviceId: "service-xray" }, { serviceId: "service-ultrasound" }] }, { idempotencyKey: "reference-request" });
  return { ...f, task: task.task, plan: plan.plan, shift: shift.shift, request, current: () => requireActiveUser(f.store.getState(), f.user("user-vet")) };
}

describe("metric membership and captured reference authorization are separate", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(at); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("uses distinct diagnostic execution/review facts, terminal guards and captured SLA boundaries", async () => {
    const f = await fixture(); const [lab, radiology, ultrasound] = f.request.items;
    await f.store.transaction((state) => ({ state: { ...state, items: state.items.map((item) => item.id === lab.id ? { ...item, completedAt: at, reviewedAt: at, status: "COMPLETED" } : item.id === radiology.id ? { ...item, performedAt: at, reviewedAt: end, status: "REVIEWED", dueAt: "2026-10-11T09:00:00Z" } : { ...item, completedAt: at, dueAt: "invalid" }) }, result: undefined }));
    const state = f.store.getState(); const actor = f.current();
    expect(deriveHospitalMetricRows(state, actor, "DIAGNOSTIC_EXECUTED", filters, at).map((row) => row.id).sort()).toEqual([lab.id, radiology.id].sort());
    expect(deriveHospitalMetricRows(state, actor, "DIAGNOSTIC_REVIEWED", filters, at).map((row) => row.id)).toEqual([lab.id]);
    expect(deriveHospitalMetricRows(state, actor, "DIAGNOSTIC_PENDING", filters, at).map((row) => row.id).sort()).toEqual([radiology.id, ultrasound.id].sort());
    const overdue = deriveHospitalMetricRows(state, actor, "DIAGNOSTIC_OVERDUE", filters, at);
    expect(overdue).toEqual([expect.objectContaining({ id: radiology.id, label: "RX de tórax" })]);
    await f.store.transaction((current) => ({ state: { ...current, items: current.items.map((item) => item.id === radiology.id ? { ...item, dueAt: at } : item) }, result: undefined }));
    expect(deriveHospitalMetricRows(f.store.getState(), f.current(), "DIAGNOSTIC_OVERDUE", filters, at)).toEqual([]);
    expect(hospitalMetricDefinition("DIAGNOSTIC_EXECUTED")).toMatchObject({ source: "DiagnosticItem.performedAt or laboratory completedAt", approval: "TECHNICAL_DEFINITION_REQUIRES_PILOT_ACCEPTANCE" });
  });

  it("captures closed plans and planned shift starts once, with present labels and current permissions at download", async () => {
    const f = await fixture();
    await f.service.commandHospitalPlan(f.user("user-vet"), f.plan.id, { command: "CLOSE", expectedVersion: 1, idempotencyKey: "close-plan" });
    const actor = f.current(); const state = f.store.getState();
    for (const [code, targetId] of [["PLAN_CREATED", f.plan.id], ["PLAN_CLOSED", f.plan.id], ["SHIFT_STARTED", f.shift.id]] as const) {
      const rows = deriveHospitalMetricRows(state, actor, code, filters, at); expect(rows.map((row) => row.id)).toEqual([targetId]);
      const captured = captureHospitalReportRows(state, actor, code, filters, rows.map((row) => ({ ...row, label: "STORED LABEL MUST NOT AUTHORIZE" })));
      const output = await resolveHospitalReportRows(state, actor, code, captured);
      expect(output[0]).toMatchObject({ id: targetId, occurredAt: at }); expect(output[0].label).not.toContain("STORED LABEL");
      const denied = { ...actor, permissions: actor.permissions!.filter((permission) => permission !== (code.startsWith("PLAN_") ? "plan.view" : "shift.view")) };
      expect(await resolveHospitalReportRows(state, denied, code, captured)).toEqual([]);
    }
    expect(() => deriveHospitalMetricRows(state, actor, "PLAN_CREATED", { ...filters, departmentCode: "LABORATORY" }, at)).toThrow("Você não tem acesso");
    expect(deriveHospitalMetricRows(state, actor, "SHIFT_STARTED", { ...filters, from: end, to: "2026-10-13T00:00:00Z" }, at)).toEqual([]);
    expect(await resolveHospitalReportRows({ ...state, hospitalPlans: [], hospitalShifts: [] }, actor, "PLAN_CREATED", [
      { targetType: "HOSPITAL_PLAN", id: f.plan.id, label: "forged", departmentCode: "INPATIENT", occurredAt: at, status: "CLOSED", deepLink: "invalid" },
      { targetType: "HOSPITAL_SHIFT", id: f.shift.id, label: "forged", departmentCode: "INPATIENT", occurredAt: at, status: "PLANNED", deepLink: "invalid" }
    ])).toEqual([]);
  });

  it("deduplicates accepted passages by target and selected event while rejecting outside and revoked origins", async () => {
    const f = await fixture(); const actor = f.current(); const item = f.request.items[0];
    const base: HospitalHandoff = { id: "handoff-early", fromShiftId: f.shift.id, toShiftId: f.shift.id, departmentCode: "INPATIENT", offeredBy: actor.id, recipientUserId: actor.id, state: "ACCEPTED", entries: [{ targetType: "HOSPITAL_TASK", targetId: f.task.id, expectedTargetVersion: 1 }, { targetType: "DIAGNOSTIC_ITEM", targetId: item.id, expectedTargetVersion: 1 }], offeredAt: at, acceptedAt: "2026-10-11T08:00:00Z", version: 2, createdAt: at, updatedAt: at };
    await f.store.transaction((state) => ({ state: { ...state, hospitalHandoffs: [base, { ...base, id: "handoff-latest", acceptedAt: at }, { ...base, id: "handoff-unaccepted", state: "OFFERED" }, { ...base, id: "handoff-outside", departmentCode: "IT" }, { ...base, id: "handoff-end", acceptedAt: end }] }, result: undefined }));
    const state = f.store.getState(); const rows = deriveHospitalMetricRows(state, actor, "ACTIVITY_HANDED_OVER", filters, at);
    expect(rows).toHaveLength(2); expect(rows.every((row) => row.occurredAt === at)).toBe(true);
    const captured = captureHospitalReportRows(state, actor, "ACTIVITY_HANDED_OVER", filters, rows);
    expect(captured.every((row) => row.sourceHandoffId === "handoff-latest")).toBe(true);
    expect((await resolveHospitalReportRows(state, actor, "ACTIVITY_HANDED_OVER", captured))).toHaveLength(2);
    const scoped = captureHospitalReportRows(state, actor, "ACTIVITY_HANDED_OVER", { ...filters, departmentCode: "INPATIENT" }, rows);
    expect(scoped.map((row) => row.sourceHandoffId)).toEqual(captured.map((row) => row.sourceHandoffId));
    const denied = { ...actor, permissions: actor.permissions!.filter((permission) => permission !== "shift.view") };
    expect(await resolveHospitalReportRows(state, denied, "ACTIVITY_HANDED_OVER", captured)).toEqual([]);
    expect(captureHospitalReportRows(state, denied, "ACTIVITY_HANDED_OVER", filters, rows).every((row) => !row.sourceHandoffId)).toBe(true);
    expect(await resolveHospitalReportRows(state, actor, "ACTIVITY_HANDED_OVER", rows)).toEqual([]);
  });

  it("rejects invalid metrics, windows and continuation identities before exposing an authorized object", async () => {
    const f = await fixture(); const actor = f.user("user-vet");
    await expect(f.service.getHospitalPlannerMetrics(actor, { from: end, to: start })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(f.service.listHospitalMetricRows(actor, "UNKNOWN" as HospitalMetricCode, filters)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(f.service.listHospitalMetricRows(actor, "TASK_CREATED", { ...filters, limit: 101 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const malformed = Buffer.from(JSON.stringify({ binding: JSON.stringify(["TASK_CREATED", start, end, null]), id: 1, at })).toString("base64url");
    await expect(f.service.listHospitalMetricRows(actor, "TASK_CREATED", { ...filters, cursor: malformed })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const empty = await f.service.listHospitalMetricRows(actor, "TASK_CANCELLED", filters); expect(empty).toMatchObject({ items: [], total: 0, limit: 25 }); expect(empty.nextCursor).toBeUndefined();
  });

  it("reads legacy cold references only from a canonical matching request/item link, never a stored label", async () => {
    const f = await fixture(); const actor = f.current(); const item = f.request.items[0];
    const row: HospitalMetricRow = { targetType: "DIAGNOSTIC_ITEM", id: item.id, label: "CAPTURED CLINICAL LABEL", departmentCode: "LABORATORY", occurredAt: at, status: "REQUESTED", deepLink: `/requests/${item.requestId}#${item.id}` };
    const cold = { ...f.store.getState(), requests: [], items: [] }; const reader = vi.fn(async () => undefined);
    expect(await readHospitalReportArchiveReferences(cold, [row, row], reader)).toEqual(new Map([[item.requestId, undefined]])); expect(reader).toHaveBeenCalledExactlyOnceWith(item.requestId);
    reader.mockClear();
    for (const deepLink of [`/requests/${item.requestId}#foreign-item`, `/requests/${item.requestId}?id=${item.id}`, `https://example.test/requests/${item.requestId}#${item.id}`]) {
      expect(await resolveHospitalReportRows(cold, actor, "DIAGNOSTIC_REQUESTED", [{ ...row, deepLink }], { readArchivedRequest: reader, hasAuditEvent: async () => false })).toEqual([]);
    }
    expect(reader).not.toHaveBeenCalled();
    await expect(resolveHospitalReportRows(cold, actor, "DIAGNOSTIC_REQUESTED", [row])).rejects.toMatchObject({ code: "ARCHIVE_READ_UNAVAILABLE" });
    expect(await resolveHospitalReportRows(cold, actor, "DIAGNOSTIC_REQUESTED", [row], { readArchivedRequest: reader, hasAuditEvent: async () => false })).toEqual([]);
  });

  it("validates native cold request/item relationships and current patient access before returning a captured fact", async () => {
    vi.setSystemTime("2020-10-11T10:00:00.000Z"); const f = hospitalOperationFixture(); const actor = f.user("user-vet");
    const request = await f.service.createRequest(actor, { patientId: "patient-thor", encounterId: "encounter-thor", admissionId: "admission-thor", priority: "ROUTINE", items: [{ serviceId: "service-xray" }] }, { idempotencyKey: "old-native-request" });
    await f.service.cancelItem(actor, request.items[0].id, { reasonCode: "CLINICAL_DECISION", expectedVersion: 1, idempotencyKey: "old-native-cancel" });
    const oldFilters = { from: "2020-10-11T00:00:00.000Z", to: "2020-10-12T00:00:00.000Z" }; const hot = f.store.getState();
    const captured = captureHospitalReportRows(hot, requireActiveUser(hot, actor), "DIAGNOSTIC_REQUESTED", oldFilters, deriveHospitalMetricRows(hot, requireActiveUser(hot, actor), "DIAGNOSTIC_REQUESTED", oldFilters, at));
    vi.setSystemTime(at); expect((await f.store.archiveClinicalRecords({ now: new Date(at), activeMonths: 24 })).requestIds).toEqual([request.id]);
    const rows = (await f.store.readArchivedRequest(request.id))!; const cold = f.store.getState(); const current = requireActiveUser(cold, actor);
    const reader = { readArchivedRequest: async () => rows, hasAuditEvent: async () => false };
    expect((await resolveHospitalReportRows(cold, current, "DIAGNOSTIC_REQUESTED", captured, reader))[0]).toMatchObject({ id: request.items[0].id, status: "CANCELLED", label: "RX de tórax", deepLink: `/archive/${request.id}` });
    const unavailableCatalog = { ...cold, services: [] };
    expect((await resolveHospitalReportRows(unavailableCatalog, current, "DIAGNOSTIC_REQUESTED", captured, reader))[0].label).toBe("RX de tórax");
    for (const excluded of ["requests", "items"] as const) {
      expect(await resolveHospitalReportRows(cold, current, "DIAGNOSTIC_REQUESTED", captured, { ...reader, readArchivedRequest: async () => rows.filter((entry) => entry.collection !== excluded) })).toEqual([]);
    }
    expect(await resolveHospitalReportRows({ ...cold, patients: [] }, current, "DIAGNOSTIC_REQUESTED", captured, reader)).toEqual([]);
    const mismatch = rows.map((entry) => entry.collection === "items" ? { ...entry, data: { ...entry.data, requestId: "foreign-request" } } : entry);
    expect(await resolveHospitalReportRows(cold, current, "DIAGNOSTIC_REQUESTED", captured, { ...reader, readArchivedRequest: async () => mismatch })).toEqual([]);
    const denied = { ...current, patientIds: [], permissions: current.permissions!.filter((permission) => permission !== "item.view") };
    expect(await resolveHospitalReportRows(cold, denied, "DIAGNOSTIC_REQUESTED", captured, reader)).toEqual([]);
    expect(await resolveHospitalReportRows(cold, current, "DIAGNOSTIC_REQUESTED", captured, { ...reader, readArchivedRequest: async () => undefined })).toEqual([]);
  });
});
