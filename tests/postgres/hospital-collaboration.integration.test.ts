import { describe, expect, it } from "vitest";
import { withDisposablePostgresDatabase } from "../support/postgres-test-harness";
import { createDemoState } from "../../src/server/store/fixtures";
import { createApplicationService } from "../../src/server/application/service";
import { processPendingHospitalReportJobs } from "../../src/server/application/hospital-report-service";
import { verifyPassword } from "../../src/server/security/password";
describe("collaboration commands on isolated PostgreSQL", () => {
  it("serializes invitation acceptance across independent connections without orphan users or grants", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const base = createDemoState("hospital-collaboration-postgres-tests"); const first = await database.createStore(base); const second = await database.createStore();
      try {
        const a = createApplicationService(first), b = createApplicationService(second); const admin = base.users.find((user) => user.id === "user-admin")!; const group = base.accessGroups.find((entry) => entry.systemRole === "VIEWER")!;
        const issued = await a.createHospitalUserInvitation(admin, { email: "pg-invitee@example.test", displayName: "Pessoa sintética", role: "VIEWER", departmentCode: "ULTRASOUND", accessGroupId: group.id, expectedGroupVersion: group.version, expiresInHours: 24, idempotencyKey: "pg-invitation" });
        const password = "Cvg1-PostgresRecipient-Synthetic-913!";
        const attempts = await Promise.allSettled([a.acceptHospitalUserInvitation({ token: issued.token!, password }), b.acceptHospitalUserInvitation({ token: issued.token!, password })]);
        expect(attempts.filter((entry) => entry.status === "fulfilled")).toHaveLength(1); expect(attempts.find((entry) => entry.status === "rejected")).toMatchObject({ reason: { code: "INVITATION_INVALID" } });
        const stored = await second.readState(); const users = stored.users.filter((user) => user.email === "pg-invitee@example.test"); expect(users).toHaveLength(1); expect(users[0].mustChangePassword).toBe(false); expect(verifyPassword(password, users[0].passwordHash)).toBe(true);
        expect(stored.hospitalUserInvitations[0]).toMatchObject({ status: "ACCEPTED", acceptedBy: users[0].id }); expect(stored.patientGrants).toEqual(base.patientGrants); expect(JSON.stringify(stored)).not.toContain(issued.token!);
        await database.closeStore(first); await database.closeStore(second); const reopened = await database.createStore(); try { expect((await reopened.readState()).users.filter((user) => user.email === "pg-invitee@example.test")).toHaveLength(1); } finally { await database.closeStore(reopened); }
      } finally { await database.closeStore(first); await database.closeStore(second); }
    });
  });
  it("runs a durable export once and removes revoked access before download", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const base = createDemoState("hospital-report-postgres-tests"); const first = await database.createStore(base); const second = await database.createStore();
      try {
        const actor = base.users.find((user) => user.id === "user-us")!; const service = createApplicationService(first);
        const task = await service.createHospitalTask(actor, { title: "Atividade sintética", typeId: "hospital-task-type-routine", departmentCode: "ULTRASOUND", responsibleUserId: actor.id, priority: "ROUTINE", idempotencyKey: "pg-metric-task" });
        const report = await service.createHospitalReport(actor, { name: "Relatório sintético", metricCode: "TASK_CREATED", filters: { from: "2020-01-01T00:00:00.000Z", to: "2090-01-01T00:00:00.000Z", departmentCode: "ULTRASOUND" }, format: "JSONL", idempotencyKey: "pg-report" }); const queued = await service.createHospitalReportJob(actor, { reportId: report.id, expectedReportVersion: report.version, idempotencyKey: "pg-export" });
        const races = await Promise.all([processPendingHospitalReportJobs(first), processPendingHospitalReportJobs(second)]); expect(races.reduce((sum, result) => sum + result.succeeded, 0)).toBe(1);
        const reader = createApplicationService(second); expect(JSON.parse((await reader.downloadHospitalReportJob(actor, queued.job.id)).content.trim())).toMatchObject({ id: task.task.id });
        await first.transaction((state) => ({ state: { ...state, accessGroups: state.accessGroups.map((group) => group.id === actor.accessGroupId ? { ...group, permissions: group.permissions.filter((permission) => permission !== "hospital_task.view") } : group) }, result: undefined }));
        await expect(reader.downloadHospitalReportJob(actor, queued.job.id)).rejects.toMatchObject({ status: 404 });
        expect((await second.readState()).hospitalReportJobs[0]).toMatchObject({ status: "SUCCEEDED", attempts: 1, rowCount: 1 });
      } finally { await database.closeStore(first); await database.closeStore(second); }
    });
  });
});
