import { describe, expect, it } from "vitest";
import { withDisposablePostgresDatabase } from "../support/postgres-test-harness";
import { createDemoState } from "../../src/server/store/fixtures";
import { createApplicationService } from "../../src/server/application/service";
import { generateDueHospitalRecurrences } from "../../src/server/application/hospital-recurrence-service";

describe("hospital planning across independent PostgreSQL connections", () => {
  it("arbitrates a diagnostic reservation against general work using the same inventory and schedules", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const base = createDemoState("synthetic-hospital-pg-reservations");
      const first = await database.createStore(base); const second = await database.createStore();
      try {
        const a = createApplicationService(first); const b = createApplicationService(second);
        const actor = (id: string) => base.users.find((user) => user.id === id)!;
        const startsAt = new Date(Date.now() + 3_600_000).toISOString(); const endsAt = new Date(Date.parse(startsAt) + 3_600_000).toISOString();
        const resource = await a.createHospitalResource(actor("user-admin"), { code: "PG_US_EQUIPMENT", name: "Equipamento sintético", kind: "EQUIPMENT", departmentCode: "ULTRASOUND", availabilityWindows: [{ startsAt, endsAt }], idempotencyKey: "pg-resource" });
        const task = await a.createHospitalTask(actor("user-us"), { title: "Rotina sintética", typeId: "hospital-task-type-routine", departmentCode: "ULTRASOUND", responsibleUserId: "user-us", priority: "ROUTINE", idempotencyKey: "pg-task" });
        const request = await a.createRequest(actor("user-vet"), { patientId: "patient-thor", encounterId: "encounter-thor", admissionId: "admission-thor", priority: "ROUTINE", items: [{ serviceId: "service-ultrasound" }] }, { idempotencyKey: "pg-request" });
        const itemBefore = (await first.readState()).items.find((item) => item.id === request.items[0].id)!;
        const attempts = await Promise.allSettled([
          a.reserveHospitalTaskSchedule(actor("user-us"), task.task.id, { startsAt, endsAt, resourceIds: [resource.id], expectedVersion: 1, idempotencyKey: "pg-task-reserve" }),
          b.scheduleProcedure(actor("user-us"), itemBefore.id, { startsAt, endsAt, resourceIds: [resource.id], expectedVersion: itemBefore.version, idempotencyKey: "pg-exam-reserve" })
        ]);
        expect(attempts.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
        expect(attempts.find((entry) => entry.status === "rejected")).toMatchObject({ reason: { code: "SCHEDULE_CONFLICT", status: 409 } });
        const persisted = await second.readState();
        expect(persisted.schedules.filter((schedule) => schedule.resourceIds?.includes(resource.id) && schedule.status === "SCHEDULED")).toHaveLength(1);
        expect(persisted.items.find((item) => item.id === itemBefore.id)?.dueAt).toBe(itemBefore.dueAt);
        expect(persisted.hospitalTasks.find((entry) => entry.id === task.task.id)?.phase).toBe("PENDING");
        expect(persisted.patientGrants).toEqual(base.patientGrants);
        await database.closeStore(first); await database.closeStore(second);
        const reopened = await database.createStore();
        try { expect((await reopened.readState()).schedules).toEqual(persisted.schedules); } finally { await database.closeStore(reopened); }
      } finally { await database.closeStore(first); await database.closeStore(second); }
    });
  });

  it("admits exactly one patient to a registered bed without orphan encounters or grants", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const base = createDemoState("synthetic-hospital-pg-beds"); base.admissions = [];
      const first = await database.createStore(base); const second = await database.createStore();
      try {
        const a = createApplicationService(first); const b = createApplicationService(second);
        const admin = base.users.find((user) => user.id === "user-admin")!; const vet = base.users.find((user) => user.id === "user-vet")!;
        const bed = await a.createHospitalResource(admin, { code: "PG_BED", name: "Leito sintético", kind: "BED", departmentCode: "INPATIENT", ward: "Teste", bedLabel: "01", allowedSpecies: ["Canina"], idempotencyKey: "pg-bed" });
        const input = { species: "Canina", breed: "SRD", sex: "Macho", ownerLabel: "Tutor sintético", encounterType: "INPATIENT" as const, bedResourceId: bed.id };
        const attempts = await Promise.allSettled([
          a.createPatient(vet, { ...input, displayName: "Sintético A", externalId: "PG_A" }, { idempotencyKey: "pg-patient-a" }),
          b.createPatient(vet, { ...input, displayName: "Sintético B", externalId: "PG_B" }, { idempotencyKey: "pg-patient-b" })
        ]);
        expect(attempts.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
        expect(attempts.find((entry) => entry.status === "rejected")).toMatchObject({ reason: { code: "BED_OCCUPIED", status: 409 } });
        const persisted = await second.readState();
        expect(persisted.admissions.filter((entry) => entry.bedResourceId === bed.id && !entry.dischargedAt)).toHaveLength(1);
        expect(persisted.patients).toHaveLength(base.patients.length + 1);
        expect(persisted.encounters).toHaveLength(base.encounters.length + 1);
        const createdPatient = persisted.patients.find((entry) => ["PG_A", "PG_B"].includes(entry.externalId))!;
        expect(persisted.patientGrants.filter((entry) => entry.patientId === createdPatient.id)).toHaveLength(1);
        expect(persisted.hospitalResources.find((entry) => entry.id === bed.id)?.availability).toBe("AVAILABLE");
      } finally { await database.closeStore(first); await database.closeStore(second); }
    });
  });

  it("generates unique durable occurrences with two workers and keeps the cursor after reopening", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const base = createDemoState("synthetic-hospital-pg-recurrence");
      const first = await database.createStore(base); const second = await database.createStore();
      try {
        const a = createApplicationService(first); const admin = base.users.find((user) => user.id === "user-admin")!; const vet = base.users.find((user) => user.id === "user-vet")!;
        const draft = await a.createHospitalChecklistTemplate(admin, { code: "PG_SYNTHETIC_ROUTINE", name: "Modelo somente de teste", departmentCode: "INPATIENT", careContextRequired: false, steps: [{ code: "VERIFY", label: "Etapa sintética", required: true, evidenceRequired: false }], idempotencyKey: "pg-template" });
        const approved = await a.approveHospitalChecklistTemplate(vet, draft.template.id, { expectedVersion: 1, idempotencyKey: "pg-template-approve" });
        const asOf = new Date().toISOString(); const startAt = new Date(Date.parse(asOf) - 180_000).toISOString();
        const recurrence = await a.createHospitalRecurrence(vet, { templateId: approved.template.id, departmentCode: "INPATIENT", title: "Recorrência sintética", priority: "ROUTINE", responsibleUserId: vet.id, startAt, endAt: asOf, intervalMinutes: 1, idempotencyKey: "pg-recurrence" });
        const reports = await Promise.all([generateDueHospitalRecurrences(first, { asOf, limit: 10 }), generateDueHospitalRecurrences(second, { asOf, limit: 10 })]);
        expect(reports.reduce((total, report) => total + report.generated, 0)).toBe(3);
        const persisted = await second.readState(); const tasks = persisted.hospitalTasks.filter((task) => task.recurrenceId === recurrence.recurrence.id);
        expect(tasks).toHaveLength(3); expect(new Set(tasks.map((task) => task.occurrenceAt)).size).toBe(3);
        expect(tasks.every((task) => task.phase === "PENDING" && task.checklistSnapshot?.templateVersion === 2 && !task.careExecution)).toBe(true);
        expect(persisted.patientGrants).toEqual(base.patientGrants);
        await database.closeStore(first); await database.closeStore(second);
        const reopened = await database.createStore();
        try {
          expect(await generateDueHospitalRecurrences(reopened, { asOf, limit: 10 })).toMatchObject({ generated: 0, pending: 0 });
          expect((await reopened.readState()).hospitalTasks.filter((task) => task.recurrenceId === recurrence.recurrence.id)).toHaveLength(3);
        } finally { await database.closeStore(reopened); }
      } finally { await database.closeStore(first); await database.closeStore(second); }
    });
  });
});
