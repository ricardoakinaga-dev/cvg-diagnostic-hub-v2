import { describe, expect, it, vi } from "vitest";
import { hospitalExternalFixture } from "../../test/hospital-external-fixtures";
import type { AuditTransactionReader } from "../domain/models";
import { createHospitalTaskService } from "./hospital-task-service";
import { transactionalServiceContext } from "./transactional-service-context";

const taskInput = { title: "Atividade transacional sintética", typeId: "hospital-task-type-routine", departmentCode: "INPATIENT", priority: "ROUTINE" as const, idempotencyKey: "synthetic-atomic-task" };

describe("commands composed inside a caller-owned transaction", () => {
  it("reads its own newly created work and commits it through one outer transaction", async () => {
    const f = hospitalExternalFixture(); const outerTransaction = vi.spyOn(f.store, "transaction"); const version = await f.store.readStateVersion();
    const created = await f.store.transaction(async (original) => {
      const scoped = transactionalServiceContext(f.context, original); const service = createHospitalTaskService(scoped.context);
      expect(scoped.context.store.writeQueueMetrics).toBeUndefined();
      expect(await scoped.context.store.readStateVersion()).toBe(version);
      const first = await service.createHospitalTask(f.user("user-vet"), taskInput);
      expect((await scoped.context.store.readState()).hospitalTasks.some(task => task.id === first.task.id)).toBe(true);
      const replay = await service.createHospitalTask(f.user("user-vet"), taskInput);
      expect(replay.task.id).toBe(first.task.id);
      expect(f.store.getState().hospitalTasks.some(task => task.id === first.task.id)).toBe(false);
      return { state: scoped.state(), result: first };
    });
    expect(outerTransaction).toHaveBeenCalledTimes(1);
    expect(f.store.getState().hospitalTasks.filter(task => task.id === created.task.id)).toHaveLength(1);
    expect(await f.store.readStateVersion()).toBe(version + 1);
  });

  it("rolls back all composed command effects when the caller fails before its receipt", async () => {
    const f = hospitalExternalFixture(); const before = await f.store.readStateSnapshot();
    await expect(f.store.transaction(async original => {
      const scoped = transactionalServiceContext(f.context, original);
      await createHospitalTaskService(scoped.context).createHospitalTask(f.user("user-vet"), taskInput);
      expect((await scoped.context.store.readState()).hospitalTasks.length).toBeGreaterThan(original.hospitalTasks.length);
      throw new Error("SYNTHETIC_RECEIPT_FAILURE");
    })).rejects.toThrow("SYNTHETIC_RECEIPT_FAILURE");
    expect(await f.store.readStateSnapshot()).toEqual(before);
  });

  it("keeps authorization audit reads on the caller's supplied connection", async () => {
    const f = hospitalExternalFixture(); const reader: AuditTransactionReader = { hasAuditEvent: vi.fn(async () => true), readArchivedRequest: vi.fn(async () => undefined) };
    const query = { eventType: "ResultReleased", entityType: "Result", entityId: "synthetic-result", actorId: "user-vet" };
    const scoped = transactionalServiceContext(f.context, f.store.getState(), reader);
    const result = await scoped.context.store.transaction(async (state, audit) => ({ state, result: await audit!.hasAuditEvent(query) }));
    expect(result).toBe(true); expect(reader.hasAuditEvent).toHaveBeenCalledWith(query);
    expect(await scoped.context.store.readStateVersion()).toBe(await f.store.readStateVersion());
  });
});
