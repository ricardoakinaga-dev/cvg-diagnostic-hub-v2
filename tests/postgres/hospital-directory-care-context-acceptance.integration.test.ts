import { describe, expect, it } from "vitest";
import { ROLES } from "@cvg/contracts";
import { createApplicationService } from "../../src/server/application/service";
import { createDemoState } from "../../src/server/store/fixtures";
import { authenticateRequest, changeInitialPassword, loginUser } from "../../src/server/security/session";
import { departmentOptions } from "../../src/components/use-departments";
import { workedDepartments } from "../../src/components/work-items/use-work-items";
import { withDisposablePostgresDatabase } from "../support/postgres-test-harness";

const password = "synthetic-directory-context-password-2026";
function sessionRequest(session: { sessionToken: string; csrfToken: string }) {
  return new Request("http://localhost/api/v1/session/password", { headers: { cookie: `cvg_session=${session.sessionToken}; cvg_csrf=${session.csrfToken}`, "x-csrf-token": session.csrfToken } });
}

// Providers, persistent commands and the actual menu-option derivation are exercised here.
// This is not browser evidence for selecting an option or completing the visible forms.
describe("BLD-HPL-013/022 native directory and exact care context on PostgreSQL", () => {
  it("provisions an unprecedented diagnostic sector through native commands, exposes only its assigned examination and revokes access without deleting identities", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const base = createDemoState(password);
      const store = await database.createStore(base); const observer = await database.createStore();
      try {
        const service = createApplicationService(store); const read = createApplicationService(observer);
        const admin = base.users.find((user) => user.role === "ADMIN")!; const vet = base.users.find((user) => user.role === "VETERINARIAN")!;
        const department = await service.createDepartment(admin, { code: "SYNTHETIC_NEW_DIAGNOSTIC", name: "Setor diagnóstico sintético inédito", type: "DIAGNOSTIC", idempotencyKey: "create-new-sector" });
        const exam = await service.createDiagnosticService(admin, { code: "SYNTHETIC_NEW_EXAM", name: "Exame sintético do setor inédito", category: "LABORATORY", departmentCode: department.code, workflowType: "LABORATORY", requiresSample: true, sampleType: "Sangue sintético", requiresSchedule: false, allowsAttachment: false, resultSchema: "NARRATIVE", slaHours: { ROUTINE: 24, URGENT: 4, EMERGENCY: 1 }, idempotencyKey: "create-new-exam" });
        const created = await service.createManagedUser(admin, { displayName: "Executor sintético do setor novo", email: "synthetic-new-executor@example.invalid", role: "LAB_TECH", departmentCode: department.code, serviceCodes: [exam.code], serviceAccessPolicy: { mode: "SELECTED", includeFuture: false }, idempotencyKey: "create-new-executor" });
        expect(ROLES).toContain(created.role); expect(created.role).toBe("LAB_TECH");
        const group = await service.createAccessGroup(admin, { code: "SYNTHETIC_DIAGNOSTIC_READ", description: "Fila, itens e catálogo autorizados, sem gestão", permissions: ["queue.view", "item.view", "request.view", "service.catalog.view"], idempotencyKey: "create-limited-executor-group" });
        await service.assignUserAccessGroup(admin, created.id, { accessGroupId: group.id, expectedVersion: created.version, expectedGroupVersion: group.version, idempotencyKey: "assign-limited-executor-group" });
        const initial = await loginUser(observer, created.email, created.initialPassword!);
        const personalPassword = "Quartzo-Marte-57!Zeno";
        const changed = await changeInitialPassword(store, sessionRequest(initial), personalPassword, "replace-synthetic-initial-password");
        const executor = await authenticateRequest(observer, sessionRequest(changed));
        expect(executor.role).toBe("LAB_TECH"); expect(executor.departmentCode).toBe(department.code);
        expect(executor.permissions).toEqual(expect.arrayContaining(["queue.view", "request.view", "service.catalog.view"])); expect(executor.permissions).not.toContain("user.create");
        const request = await service.createRequest(vet, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: exam.id }] }, { idempotencyKey: "request-new-exam" });
        const item = (await observer.readState()).items.find((entry) => entry.id === request.items[0].id)!;
        expect(item).toMatchObject({ departmentCode: department.code, serviceId: exam.id, workflowType: "LABORATORY", status: "REQUESTED" });
        expect((await read.listQueuePage(executor, department.code)).items.map((entry) => entry.id)).toEqual([item.id]);
        expect((await read.listQueue(executor, department.code)).map((entry) => entry.id)).toEqual([item.id]);
        expect((await read.getItem(executor, item.id)).item.id).toBe(item.id);
        const catalog = await read.listServices(executor);
        expect(catalog.map((entry) => entry.id)).toContain(exam.id);
        expect(workedDepartments({ ...executor, permissions: [...(executor.permissions ?? [])], managedDepartmentCodes: [...(executor.managedDepartmentCodes ?? [])] }, catalog)).toEqual([department.code]);
        expect(departmentOptions([], catalog.filter((entry) => entry.departmentCode === executor.departmentCode).map((entry) => entry.departmentCode))).toEqual([expect.objectContaining({ code: department.code, name: department.code })]);
        expect((await read.listDepartments(admin)).find((entry) => entry.id === department.id)).toMatchObject({ code: department.code, type: "DIAGNOSTIC", memberUserIds: [created.id] });
        await expect(read.listQueue(executor, "LABORATORY")).rejects.toMatchObject({ status: 404 });
        await expect(read.createDepartment(executor, { code: "NOT_GRANTED", name: "Negado", type: "SUPPORT", idempotencyKey: "executor-cannot-administer" })).rejects.toMatchObject({ status: 404 });

        const current = (await observer.readState()).users.find((user) => user.id === created.id)!;
        await service.updateUserRole(admin, created.id, { role: "LAB_TECH", departmentCode: department.code, serviceAccessPolicy: { mode: "NONE", includeFuture: false }, expectedVersion: current.version, idempotencyKey: "withdraw-explicit-service-access" });
        await expect(authenticateRequest(observer, sessionRequest(changed))).rejects.toMatchObject({ status: 401 });
        const renewed = await loginUser(observer, created.email, personalPassword); const restricted = await authenticateRequest(observer, sessionRequest(renewed));
        expect(await read.listQueue(restricted, department.code)).toEqual([]);
        // Catalog metadata is separately granted; NONE removes clinical access, not catalog.view.
        expect((await read.listServices(restricted)).map((entry) => entry.id)).toContain(exam.id);
        await expect(read.getItem(restricted, item.id)).rejects.toMatchObject({ status: 404 });
        await service.updateAccessGroup(admin, group.id, { permissions: [], expectedVersion: group.version, idempotencyKey: "withdraw-current-group-permissions" });
        await expect(authenticateRequest(observer, sessionRequest(renewed))).rejects.toMatchObject({ status: 401 });
        const noGrants = await authenticateRequest(observer, sessionRequest(await loginUser(observer, created.email, personalPassword)));
        await expect(read.listQueue(noGrants, department.code)).rejects.toMatchObject({ status: 404 });
        const persisted = await observer.readState();
        expect(persisted.items.find((entry) => entry.id === item.id)).toEqual(item);
        expect(persisted.requests.find((entry) => entry.id === request.id)?.itemIds).toEqual([item.id]);
        expect(persisted.services.find((entry) => entry.id === exam.id)).toMatchObject({ departmentCode: department.code, code: exam.code, active: true });
        expect(persisted.departments.find((entry) => entry.id === department.id)).toMatchObject({ code: department.code, active: true });
        expect(persisted.users.find((entry) => entry.id === created.id)).toMatchObject({ role: "LAB_TECH", active: true, departmentCode: department.code, accessGroupId: group.id, serviceCodes: [] });
      } finally { await database.closeStore(observer); await database.closeStore(store); }
    });
  });

  it("distinguishes homonymous patients and successive encounters by durable identifiers, rejecting exchanged and closed contexts without creating a task or plan", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const base = createDemoState(password); const store = await database.createStore(base); const observer = await database.createStore();
      try {
        const service = createApplicationService(store); const read = createApplicationService(observer);
        const login = await loginUser(observer, "vet@cvg.local", password);
        const actor = () => authenticateRequest(observer, sessionRequest(login));
        const patients = [];
        for (const [externalId, ownerLabel] of [["SYN_HOMONYM_A", "Tutor sintético A"], ["SYN_HOMONYM_B", "Tutor sintético B"]]) patients.push(await service.createPatient(await actor(), { displayName: "Alex sintético homônimo", externalId, ownerLabel, species: "Canino", breed: "SRD", sex: "Macho", encounterType: "OUTPATIENT" }, { idempotencyKey: externalId }));
        await service.closeEncounter(await actor(), patients[0].encounter.id, { reason: "Encerramento do primeiro contexto sintético" }, { idempotencyKey: "close-first-homonym-encounter" });
        const next = await service.openEncounter(await actor(), patients[0].patient.id, { encounterType: "OUTPATIENT", reason: "Novo atendimento sintético do mesmo paciente" }, { idempotencyKey: "open-next-homonym-encounter" });
        const matches = await read.listPatients(await actor(), "Alex sintético homônimo");
        expect(matches.map((patient) => patient.externalId).sort()).toEqual(["SYN_HOMONYM_A", "SYN_HOMONYM_B"]);
        expect(matches.map((patient) => patient.ownerLabel).sort()).toEqual(["Tutor sintético A", "Tutor sintético B"]);
        expect(await read.getPatient(await actor(), patients[0].patient.id)).toMatchObject({ id: patients[0].patient.id, externalId: "SYN_HOMONYM_A", ownerLabel: "Tutor sintético A" });
        const encounters = await read.listEncounters(await actor(), patients[0].patient.id);
        expect(encounters).toHaveLength(2); expect(new Set(encounters.map((encounter) => encounter.externalId)).size).toBe(2);
        expect(await read.getEncounter(await actor(), patients[0].encounter.id)).toMatchObject({ patientId: patients[0].patient.id, status: "CLOSED", closedAt: expect.any(String) });
        expect(await read.getEncounter(await actor(), next.encounter.id)).toMatchObject({ patientId: patients[0].patient.id, status: "OPEN" });
        const taskInput = { title: "Continuidade assistencial sintética", typeId: "hospital-task-type-care", departmentCode: "INPATIENT", patientId: patients[0].patient.id, encounterId: next.encounter.id, priority: "ROUTINE" as const };
        const planInput = { title: "Plano contextual sintético", objective: "Vincular somente o atendimento selecionado", departmentCodes: ["INPATIENT"], patientId: patients[0].patient.id, encounterId: next.encounter.id };
        const task = await service.createHospitalTask(await actor(), { ...taskInput, idempotencyKey: "correct-care-task" });
        const plan = await service.createHospitalPlan(await actor(), { ...planInput, idempotencyKey: "correct-care-plan" });
        expect((await read.getHospitalTask(await actor(), task.task.id)).task).toMatchObject({ patientId: patients[0].patient.id, encounterId: next.encounter.id });
        expect((await read.getHospitalPlan(await actor(), plan.plan.id)).plan).toMatchObject({ patientId: patients[0].patient.id, encounterId: next.encounter.id });
        const before = await observer.readStateSnapshot();
        for (const [key, patientId, encounterId, status] of [["other-patient", patients[1].patient.id, next.encounter.id, 404], ["other-encounter", patients[0].patient.id, patients[1].encounter.id, 404], ["closed-encounter", patients[0].patient.id, patients[0].encounter.id, 409]] as const) {
          await expect(service.createHospitalTask(await actor(), { ...taskInput, patientId, encounterId, idempotencyKey: `reject-task-${key}` })).rejects.toMatchObject({ status });
          await expect(service.createHospitalPlan(await actor(), { ...planInput, patientId, encounterId, idempotencyKey: `reject-plan-${key}` })).rejects.toMatchObject({ status });
        }
        expect(await observer.readStateSnapshot()).toEqual(before);
        await database.closeStore(store); await database.closeStore(observer);
        const reopened = await database.createStore();
        try {
          const persisted = await reopened.readState();
          expect(persisted.hospitalTasks.find((row) => row.id === task.task.id)?.encounterId).toBe(next.encounter.id);
          expect(persisted.hospitalPlans.find((row) => row.id === plan.plan.id)?.patientId).toBe(patients[0].patient.id);
          expect(persisted.patients.filter((row) => row.displayName === "Alex sintético homônimo")).toHaveLength(2);
        } finally { await database.closeStore(reopened); }
      } finally { await database.closeStore(observer); await database.closeStore(store); }
    });
  });
});
