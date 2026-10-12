import { describe, expect, it } from "vitest";
import { withDisposablePostgresDatabase } from "../support/postgres-test-harness";
import { createDemoState } from "../../src/server/store/fixtures";
import { createApplicationService } from "../../src/server/application/service";

describe("dependent task completion across PostgreSQL connections", () => {
  it("revalidates the prerequisite and commits a concurrent completion once, without completing children or modifying diagnostics", async () => {
    await withDisposablePostgresDatabase(async database => {
      const base = createDemoState("synthetic-dependency-completion");
      const first = await database.createStore(base); const second = await database.createStore();
      try {
        const a = createApplicationService(first); const b = createApplicationService(second); const vet = base.users.find(user => user.id === "user-vet")!;
        const create = (key: string, parentTaskId?: string) => a.createHospitalTask(vet, { title: key, typeId: "hospital-task-type-routine", departmentCode: "INPATIENT", responsibleUserId: vet.id, priority: "ROUTINE", parentTaskId, idempotencyKey: key });
        const source = await create("completion-source"); const target = await create("completion-target"); const child = await create("completion-child", target.task.id);
        await a.createRequest(vet, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-crp" }] }, { idempotencyKey: "completion-diagnostic" });
        const linked = await a.putHospitalTaskDependency(vet, target.task.id, { targetType: "HOSPITAL_TASK", targetId: source.task.id, blocks: "COMPLETE", active: true, expectedVersion: target.task.version, idempotencyKey: "completion-link" });
        const running = await a.commandHospitalTask(vet, target.task.id, { command: "START", expectedVersion: linked.task.version, idempotencyKey: "completion-target-start" });
        const blockedState = await second.readState();
        await expect(b.commandHospitalTask(vet, target.task.id, { command: "COMPLETE", expectedVersion: running.task.version, idempotencyKey: "completion-blocked" })).rejects.toMatchObject({ code: "TASK_DEPENDENCY_PENDING", status: 409 });
        expect(await second.readState()).toEqual(blockedState);
        const sourceRunning = await a.commandHospitalTask(vet, source.task.id, { command: "START", expectedVersion: source.task.version, idempotencyKey: "completion-source-start" });
        await a.commandHospitalTask(vet, source.task.id, { command: "COMPLETE", expectedVersion: sourceRunning.task.version, idempotencyKey: "completion-source-complete" });
        const before = await second.readState();
        const attempts = await Promise.allSettled([
          a.commandHospitalTask(vet, target.task.id, { command: "COMPLETE", expectedVersion: running.task.version, idempotencyKey: "completion-a" }),
          b.commandHospitalTask(vet, target.task.id, { command: "COMPLETE", expectedVersion: running.task.version, idempotencyKey: "completion-b" })
        ]);
        expect(attempts.filter(attempt => attempt.status === "fulfilled")).toHaveLength(1);
        expect(attempts.find(attempt => attempt.status === "rejected")).toMatchObject({ reason: { code: "STALE_VERSION", status: 409 } });
        const after = await second.readState();
        expect(after.hospitalTasks.find(task => task.id === target.task.id)).toMatchObject({ phase: "COMPLETED", version: running.task.version + 1, completedBy: vet.id });
        expect(after.hospitalTasks.find(task => task.id === child.task.id)).toEqual(before.hospitalTasks.find(task => task.id === child.task.id));
        for (const collection of ["items", "results", "resultVersions", "samples", "patientGrants", "users"] as const) expect(after[collection]).toEqual(before[collection]);
        const completed = await database.query("SELECT actor_id,metadata FROM audit_events WHERE entity_id=$1 AND event_type='HospitalTaskTransitioned' AND metadata->>'command'='COMPLETE'", [target.task.id]);
        expect(completed.rows).toEqual([expect.objectContaining({ actor_id: vet.id, metadata: expect.objectContaining({ command: "COMPLETE", version: running.task.version + 1, clinicalStateChanged: false }) })]);
        const events = await database.query("SELECT payload FROM outbox_messages WHERE aggregate_id=$1 AND event_type='HospitalTaskTransitioned' AND (payload->>'version')::int=$2", [target.task.id, running.task.version + 1]);
        expect(events.rows).toEqual([{ payload: { taskId: target.task.id, version: running.task.version + 1 } }]);
        await database.closeStore(first); await database.closeStore(second);
        const reopened = await database.createStore();
        try { const persisted = await reopened.readState(); expect(persisted.hospitalTasks).toEqual(after.hospitalTasks); expect(persisted.items).toEqual(before.items); } finally { await database.closeStore(reopened); }
      } finally { await database.closeStore(first); await database.closeStore(second); }
    });
  });
});
