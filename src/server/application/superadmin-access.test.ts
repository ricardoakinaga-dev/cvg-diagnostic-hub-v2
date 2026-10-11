import { describe, expect, it } from "vitest";
import type { User } from "../domain/models";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { ARCHIVE_NOW, withCompletedRequest } from "../../test/archive-fixtures";
import { canManageUserTarget, createAudit } from "./service-common";
import { createApplicationService } from "./service";

function setup(archive = false) {
  let state = createDemoState("superadmin-synthetic-test-password");
  const admin = state.users.find((user) => user.role === "ADMIN")!;
  const superadmin: User = { ...admin, id: "user-superadmin-global-test", email: "superadmin@cvg.test", role: "SUPERADMIN", patientIds: [], serviceCodes: [], managedDepartmentCodes: [] };
  state.users.push(superadmin);
  if (archive) {
    state = withCompletedRequest(state, "superadmin-old");
    state.auditEvents.push(
      createAudit("ResultReleased", "user-lab", "ResultVersion", "version-superadmin-old-2", "superadmin-clinical-audit"),
      createAudit("UserRoleUpdated", admin.id, "User", admin.id, "superadmin-technical-audit"),
      createAudit("RetainedHistoricalAudit", admin.id, "Unknown", "deleted-entity", "superadmin-orphan-audit")
    );
  }
  const store = new MemoryStore(state);
  let sequence = 0;
  const meta = (expectedVersion?: number) => ({ expectedVersion, idempotencyKey: `superadmin-${sequence++}` });
  return { store, service: createApplicationService(store), superadmin, admin, meta };
}

describe("SUPERADMIN combines global administration and clinical operation", () => {
  it("reads every patient, clinical department, request and management dashboard without assigned scopes", async () => {
    const c = setup();
    expect(await c.service.listPatients(c.superadmin)).toHaveLength(3);
    expect((await c.service.getPatient(c.superadmin, "patient-mel-2")).id).toBe("patient-mel-2");
    const request = await c.service.createRequest(c.superadmin, {
      patientId: "patient-mel", encounterId: "encounter-mel", priority: "ROUTINE",
      items: [{ serviceId: "service-crp" }, { serviceId: "service-xray" }, { serviceId: "service-ultrasound" }]
    }, c.meta());
    expect((await c.service.getRequest(c.superadmin, request.id)).items).toHaveLength(3);
    expect((await c.service.getPatientDiagnostics(c.superadmin, "patient-mel")).items[0].items).toHaveLength(3);
    for (const department of ["LABORATORY", "RADIOLOGY", "ULTRASOUND"]) {
      expect(await c.service.listQueue(c.superadmin, department)).toHaveLength(1);
    }
    const dashboard = await c.service.dashboard(c.superadmin);
    expect(dashboard.totalActive).toBe(3);
    expect(dashboard.departments.map(({ departmentCode }) => departmentCode)).toEqual(["LABORATORY", "RADIOLOGY", "ULTRASOUND"]);
    const overview = await c.service.managementOverview(c.superadmin);
    expect(overview.summary.activeItems).toBe(3);
    expect(overview.scope.departments).toEqual(["LABORATORY", "RADIOLOGY", "ULTRASOUND"]);
    expect(overview.recentRequests[0].itemCount).toBe(3);
    expect((await c.service.search(c.superadmin, request.requestCode)).items).toEqual(expect.arrayContaining([expect.objectContaining({ id: request.id })]));
  });

  it("receives, processes, releases, reviews and completes a laboratory examination globally", async () => {
    const c = setup();
    const request = await c.service.createRequest(c.superadmin, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-crp" }] }, c.meta());
    const received = await c.service.receiveSample(c.superadmin, [request.items[0].id], { sampleType: "EDTA", ...c.meta(1) });
    const started = await c.service.startProcessing(c.superadmin, request.items[0].id, c.meta(received.items[0].version));
    const draft = await c.service.createResultDraft(c.superadmin, started.item.id, { narrative: "Resultado sintético global.", content: {}, ...c.meta(started.item.version) });
    const released = await c.service.releaseResult(c.superadmin, draft.result.id, c.meta(draft.result.version));
    await c.service.viewResult(c.superadmin, released.version.id, c.meta(released.item.version));
    const reviewed = await c.service.reviewResult(c.superadmin, released.result.id, { versionId: released.version.id, ...c.meta(released.item.version) });
    const completed = await c.service.completeItem(c.superadmin, reviewed.item.id, c.meta(reviewed.item.version));
    expect(completed.item.status).toBe("COMPLETED");
    expect(released.version.authorId).toBe(c.superadmin.id);
  });

  it.each(["service-xray", "service-ultrasound"])("executes imaging operations outside IT for %s", async (serviceId) => {
    const c = setup();
    const request = await c.service.createRequest(c.superadmin, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId }] }, c.meta());
    let item: { id: string; version: number } = request.items[0];
    if (serviceId === "service-ultrasound") {
      const scheduled = await c.service.scheduleProcedure(c.superadmin, item.id, { startsAt: "2027-01-11T10:00:00.000Z", endsAt: "2027-01-11T10:30:00.000Z", resource: "US-1", ...c.meta(item.version) });
      item = scheduled.item;
    }
    const started = await c.service.startProcedure(c.superadmin, item.id, c.meta(item.version));
    const performed = await c.service.markProcedurePerformed(c.superadmin, item.id, c.meta(started.item.version));
    const draft = await c.service.createResultDraft(c.superadmin, item.id, { narrative: "Laudo sintético global.", content: {}, ...c.meta(performed.item.version) });
    expect((await c.service.releaseResult(c.superadmin, draft.result.id, c.meta(draft.result.version))).version.status).toBe("RELEASED");
  });

  it("keeps expected versions, required reasons and terminal workflow guards on privileged cancellation", async () => {
    const c = setup();
    const request = await c.service.createRequest(c.superadmin, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-crp" }] }, c.meta());
    const received = await c.service.receiveSample(c.superadmin, [request.items[0].id], { sampleType: "EDTA", ...c.meta(1) });
    const before = c.store.getState();
    await expect(c.service.cancelItem(c.superadmin, request.items[0].id, { reasonCode: "CLINICAL_DECISION", ...c.meta(1) })).rejects.toMatchObject({ code: "STALE_VERSION" });
    await expect(c.service.cancelItem(c.superadmin, request.items[0].id, { reasonCode: "", ...c.meta(received.items[0].version) })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(c.store.getState()).toEqual(before);
    const cancelled = await c.service.cancelItem(c.superadmin, request.items[0].id, { reasonCode: "CLINICAL_DECISION", ...c.meta(received.items[0].version) });
    expect(cancelled.item.status).toBe("CANCELLED");
    await expect(c.service.startProcessing(c.superadmin, cancelled.item.id, c.meta(cancelled.item.version))).rejects.toThrow("INVALID_STATE_TRANSITION");
    expect(c.store.getState().items.find(({ id }) => id === cancelled.item.id)?.status).toBe("CANCELLED");
  });

  it("combines resolved clinical and administrative audit and reads historical archives globally", async () => {
    const c = setup(true);
    const clinicalEvents = (await c.service.listAuditEvents(c.superadmin)).items;
    expect(clinicalEvents).toHaveLength(3);
    expect(clinicalEvents).toEqual(expect.arrayContaining(c.store.getState().auditEvents));
    expect((await c.service.listAuditEvents(c.admin)).items.map(({ correlationId }) => correlationId).sort()).toEqual(["superadmin-orphan-audit", "superadmin-technical-audit"]);
    await c.store.archiveClinicalRecords({ now: ARCHIVE_NOW });
    expect(await c.service.listPatientArchive(c.superadmin, "patient-thor")).toEqual([expect.objectContaining({ requestId: "request-superadmin-old" })]);
    const archived = await c.service.getArchivedRequest(c.superadmin, "request-superadmin-old");
    expect(archived.items).toHaveLength(2);
    expect(archived.items[0].results[0].versions).toHaveLength(2);
    expect(c.store.getState().auditEvents.at(-1)).toMatchObject({ eventType: "ArchivedRequestRead", actorId: c.superadmin.id });
  });

  it("refuses inactive SUPERADMIN, forged roles and technical ADMIN clinical access", async () => {
    const c = setup();
    const input = { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE" as const, items: [{ serviceId: "service-crp" }] };
    await expect(c.service.listPatients(c.admin)).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    await expect(c.service.createRequest(c.admin, input, c.meta())).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    await expect(c.service.listPatients({ ...c.admin, role: "SUPERADMIN" })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await c.store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === c.superadmin.id ? { ...user, active: false } : user) }, result: undefined }));
    const before = c.store.getState();
    await expect(c.service.listPatients(c.superadmin)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(c.service.createRequest(c.superadmin, input, c.meta())).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(c.store.getState()).toEqual(before);
  });

  it("allows only SUPERADMIN to manage another SUPERADMIN and preserves manager target limits", () => {
    const c = setup();
    const manager = c.store.getState().users.find((user) => user.role === "MANAGER")!;
    expect(canManageUserTarget(c.superadmin, "SUPERADMIN", "ANOTHER_DEPARTMENT")).toBe(true);
    expect(canManageUserTarget(c.admin, "SUPERADMIN", "IT")).toBe(false);
    expect(canManageUserTarget(manager, "SUPERADMIN", "INPATIENT")).toBe(false);
    expect(canManageUserTarget(c.superadmin, "LAB_TECH", "ANOTHER_DEPARTMENT")).toBe(true);
    expect(canManageUserTarget(c.admin, "LAB_TECH", "ANOTHER_DEPARTMENT")).toBe(true);
    expect(canManageUserTarget(manager, "LAB_TECH", "ANOTHER_DEPARTMENT")).toBe(false);
  });
});
