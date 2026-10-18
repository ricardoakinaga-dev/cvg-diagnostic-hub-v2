import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HospitalMetricCode, HospitalMetricFilters } from "@cvg/contracts";
import { hospitalOperationFixture, OPERATION_NOW } from "../../test/hospital-operation-fixtures";

const window = { from: "2026-10-11T00:00:00.000Z", to: "2026-10-12T00:00:00.000Z" };
async function linkedDelegatedFixture() {
  const f = hospitalOperationFixture(); const manager = f.user("user-manager");
  const own = await f.service.createHospitalTask(f.user("user-vet"), { title: "Own sector activity", typeId: "hospital-task-type-routine", departmentCode: "INPATIENT", priority: "ROUTINE", idempotencyKey: "metrics-own" });
  const delegated = await f.task("metrics-delegated");
  const outside = await f.service.createHospitalTask(manager, { title: "Formerly delegated activity", typeId: "hospital-task-type-routine", departmentCode: "LABORATORY", priority: "ROUTINE", idempotencyKey: "metrics-outside" });
  const item = await f.ultrasound("metrics-shared-native-exam");
  const plans = [];
  for (const key of ["first", "second"]) {
    const created = await f.service.createHospitalPlan(manager, { title: `Synthetic ${key} plan`, objective: "Verify native references, not duplicate clinical work", patientId: "patient-thor", encounterId: "encounter-thor", departmentCodes: ["INPATIENT", "ULTRASOUND"], idempotencyKey: `metrics-${key}-plan` });
    plans.push(await f.service.putHospitalPlanLink(manager, created.plan.id, { stepId: created.plan.steps[0].id, targetType: "DIAGNOSTIC_ITEM", targetId: item.id, active: true, expectedVersion: created.plan.version, idempotencyKey: `metrics-${key}-link` }));
  }
  await f.store.transaction(state => ({ state: { ...state, users: state.users.map(user => user.id === manager.id ? { ...user, managedDepartmentCodes: ["ULTRASOUND"] } : user) }, result: undefined }));
  return { ...f, manager, own: own.task, delegated: delegated.task, outside: outside.task, item, plans };
}

describe("manager indicators reconcile actual identities, delegated scope and repeated plan references", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(OPERATION_NOW); });
  afterEach(() => vi.useRealTimers());

  it("counts one native exam in two plans and reconciles real drilldown IDs across own/delegated filters and pages", async () => {
    const f = await linkedDelegatedFixture();
    expect(f.plans.map(view => view.plan.links[0].targetId)).toEqual([f.item.id, f.item.id]);
    const before = structuredClone(f.store.getState());
    const reconcile = async (code: HospitalMetricCode, filters: HospitalMetricFilters, ids: string[]) => {
      const aggregate = await f.service.getHospitalPlannerMetrics(f.manager, filters);
      const first = await f.service.listHospitalMetricRows(f.manager, code, { ...filters, limit: 1 });
      const second = first.nextCursor ? await f.service.listHospitalMetricRows(f.manager, code, { ...filters, limit: 1, cursor: first.nextCursor }) : undefined;
      const rows = [...first.items, ...(second?.items ?? [])];
      expect(aggregate.values.find(entry => entry.definition.code === code)).toMatchObject({ value: ids.length, availability: "AUTHORIZED" });
      expect(first.total).toBe(ids.length);
      expect(rows.map(row => row.id).sort()).toEqual([...ids].sort());
      expect(new Set(rows.map(row => `${row.targetType}:${row.id}`)).size).toBe(ids.length);
      return rows;
    };
    await reconcile("TASK_PENDING", window, [f.own.id, f.delegated.id]);
    await reconcile("TASK_PENDING", { ...window, departmentCode: "INPATIENT" }, [f.own.id]);
    await reconcile("TASK_PENDING", { ...window, departmentCode: "ULTRASOUND" }, [f.delegated.id]);
    const examRows = await reconcile("DIAGNOSTIC_REQUESTED", { ...window, departmentCode: "ULTRASOUND" }, [f.item.id]);
    expect(examRows[0]).toMatchObject({ targetType: "DIAGNOSTIC_ITEM", deepLink: `/requests/${f.item.requestId}#${f.item.id}`, occurredAt: f.item.requestedAt });
    await reconcile("DIAGNOSTIC_PENDING", window, [f.item.id]);
    await reconcile("PLAN_CREATED", window, f.plans.map(view => view.plan.id));
    const outside = { ...window, departmentCode: f.outside.departmentCode };
    await expect(f.service.getHospitalPlannerMetrics(f.manager, outside)).rejects.toMatchObject({ status: 404 });
    await expect(f.service.listHospitalMetricRows(f.manager, "TASK_PENDING", outside)).rejects.toMatchObject({ status: 404 });
    expect(f.store.getState()).toEqual(before);
  });

  it("withdraws delegation and source grants from a cached manager without treating forbidden data as zero", async () => {
    const f = await linkedDelegatedFixture();
    expect((await f.service.listHospitalMetricRows(f.manager, "TASK_PENDING", window)).items.map(row => row.id).sort()).toEqual([f.own.id, f.delegated.id].sort());
    await f.store.transaction(state => ({ state: { ...state, users: state.users.map(user => user.id === f.manager.id ? { ...user, managedDepartmentCodes: [] } : user) }, result: undefined }));
    expect((await f.service.listHospitalMetricRows(f.manager, "TASK_PENDING", window)).items.map(row => row.id)).toEqual([f.own.id]);
    await expect(f.service.getHospitalPlannerMetrics(f.manager, { ...window, departmentCode: "ULTRASOUND" })).rejects.toMatchObject({ status: 404 });
    const group = f.store.getState().accessGroups.find(entry => entry.id === f.manager.accessGroupId)!;
    await f.store.transaction(state => ({ state: { ...state, accessGroups: state.accessGroups.map(entry => entry.id === group.id ? { ...entry, permissions: entry.permissions.filter(permission => permission !== "item.view") } : entry) }, result: undefined }));
    const before = structuredClone(f.store.getState());
    const metrics = await f.service.getHospitalPlannerMetrics(f.manager, window);
    expect(metrics.values.find(entry => entry.definition.code === "DIAGNOSTIC_REQUESTED")).toMatchObject({ value: null, availability: "NOT_AUTHORIZED" });
    expect(metrics.values.find(entry => entry.definition.code === "TASK_PENDING")?.value).toBe(1);
    await expect(f.service.listHospitalMetricRows(f.manager, "DIAGNOSTIC_REQUESTED", window)).rejects.toMatchObject({ status: 404 });
    expect(f.store.getState()).toEqual(before);
  });
});
