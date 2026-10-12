import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { createApplicationService } from "./service";
import { intakeRejectionPolicyFromEnvironment } from "./hospital-intake-rejection-policy";

const policy = { version: "synthetic-policy-1", approvedAt: "2026-01-01T00:00:00Z", approvalReference: "SYNTHETIC-TEST-APPROVAL", departmentCodes: ["INPATIENT", "LABORATORY"], reasons: [{ code: "COVERED", label: "Demanda já coberta" }, { code: "OUT_OF_SCOPE", label: "Fora da finalidade aprovada" }], defaultReasonCode: "COVERED" };
function configure(value: unknown = policy) { vi.stubEnv("HOSPITAL_INTAKE_REJECTION_POLICY_JSON", typeof value === "string" ? value : JSON.stringify(value)); }
function setup() {
  const store = new MemoryStore(createDemoState()); const service = createApplicationService(store);
  const actor = () => store.getState().users.find((user) => user.id === "user-vet")!;
  const receive = (key: string) => service.createHospitalIntake(actor(), { title: "Conferência operacional sintética", departmentCode: "INPATIENT", priority: "ROUTINE", source: "MANUAL", idempotencyKey: key });
  return { store, service, actor, receive };
}
afterEach(() => vi.unstubAllEnvs());

describe("explicit approved rejection policy", () => {
  it("captures an approved diagnostic rejection once, preserves its historical label after policy rotation and never rejects the diagnostic examination", async () => {
    configure(); const c = setup();
    const request = await c.service.createRequest(c.actor(), { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-hemogram" }] }, { idempotencyKey: "request" });
    const before = structuredClone(c.store.getState().items);
    const intake = await c.service.createHospitalIntake(c.actor(), { title: "Triar solicitação real", departmentCode: "INPATIENT", priority: "ROUTINE", source: "DIAGNOSTIC_REQUEST", sourceRequestId: request.id, idempotencyKey: "intake" });
    const input = { decision: "REJECT" as const, reasonCode: "COVERED", reasonPolicyVersion: policy.version, expectedVersion: intake.version, idempotencyKey: "reject" };
    const [first, replay] = await Promise.all([c.service.triageHospitalIntake(c.actor(), intake.id, input), c.service.triageHospitalIntake(c.actor(), intake.id, input)]);
    expect(first).toEqual(replay); expect(first).toMatchObject({ state: "REJECTED", reason: policy.reasons[0].label, reasonPolicy: { code: "COVERED", label: policy.reasons[0].label, policyVersion: policy.version, approvalReference: policy.approvalReference, approvedAt: policy.approvedAt }, decisionBy: c.actor().id, version: 2 });
    configure({ ...policy, version: "synthetic-policy-2", reasons: [{ code: "COVERED", label: "Novo texto aprovado" }] });
    expect(await c.service.triageHospitalIntake(c.actor(), intake.id, input)).toEqual(first);
    expect((await c.service.listHospitalIntakes(c.actor())).items[0].reasonPolicy).toEqual(first.reasonPolicy);
    const audits = c.store.getState().auditEvents.filter((event) => event.eventType === "HospitalIntakeTriaged");
    expect(audits).toHaveLength(1); expect(audits[0].metadata).toMatchObject({ reason: policy.reasons[0].label, reasonCode: "COVERED", reasonPolicyVersion: policy.version, reasonApprovalReference: policy.approvalReference, reasonApprovedAt: policy.approvedAt, clinicalStateChanged: false });
    expect(c.store.getState().items).toEqual(before); expect(c.store.getState().hospitalTasks).toHaveLength(0);
  });

  it("rejects a stale policy, an unknown reason and use on another decision before changing the intake", async () => {
    configure(); const c = setup(); const intake = await c.receive("receive"); const before = structuredClone(c.store.getState());
    await expect(c.service.triageHospitalIntake(c.actor(), intake.id, { decision: "REJECT", reasonCode: "COVERED", reasonPolicyVersion: "previous-policy", expectedVersion: 1, idempotencyKey: "stale" })).rejects.toMatchObject({ code: "INTAKE_REJECTION_POLICY_CHANGED", status: 409 });
    await expect(c.service.triageHospitalIntake(c.actor(), intake.id, { decision: "REJECT", reasonCode: "UNKNOWN", reasonPolicyVersion: policy.version, expectedVersion: 1, idempotencyKey: "unknown" })).rejects.toMatchObject({ status: 400 });
    for (const decision of ["DEFER", "ACCEPT", "DUPLICATE"] as const) await expect(c.service.triageHospitalIntake(c.actor(), intake.id, { decision, reasonCode: "COVERED", reasonPolicyVersion: policy.version, expectedVersion: 1, idempotencyKey: decision })).rejects.toMatchObject({ status: 400 });
    for (const pair of [{ reasonCode: "COVERED" }, { reasonPolicyVersion: policy.version }]) await expect(c.service.triageHospitalIntake(c.actor(), intake.id, { decision: "REJECT", ...pair, expectedVersion: 1, idempotencyKey: JSON.stringify(pair) })).rejects.toMatchObject({ status: 400 });
    expect(c.store.getState()).toEqual(before);
    expect(await c.service.triageHospitalIntake(c.actor(), intake.id, { decision: "REJECT", reason: "Conferência própria mantida no histórico", reasonCode: "COVERED", reasonPolicyVersion: policy.version, expectedVersion: 1, idempotencyKey: "current" })).toMatchObject({ reason: "Conferência própria mantida no histórico", reasonPolicy: { label: policy.reasons[0].label } });
  });

  it.each([undefined, "not JSON", JSON.stringify({ ...policy, defaultReasonCode: "UNKNOWN" })])("keeps manual triage available while an absent or invalid approval cannot supply a shortcut (%s)", async (configuration) => {
    vi.stubEnv("HOSPITAL_INTAKE_REJECTION_POLICY_JSON", configuration); const c = setup(); const intake = await c.receive("receive");
    expect(await c.service.getHospitalIntakeOptions(c.actor())).toEqual({ rejectionPolicyStatus: configuration ? "INVALID" : "OFF" });
    await expect(c.service.triageHospitalIntake(c.actor(), intake.id, { decision: "REJECT", reasonCode: "COVERED", reasonPolicyVersion: policy.version, expectedVersion: 1, idempotencyKey: "preset" })).rejects.toMatchObject({ status: 409 });
    const manual = await c.service.triageHospitalIntake(c.actor(), intake.id, { decision: "REJECT", reason: "Motivo registrado pelo profissional", expectedVersion: 1, idempotencyKey: "manual" });
    expect(manual.reason).toBe("Motivo registrado pelo profissional"); expect(manual.reasonPolicy).toBeUndefined();
  });

  it("returns only policy metadata for current authorized sectors and refuses revoked permissions even on a replay", async () => {
    configure(); const c = setup();
    expect((await c.service.getHospitalIntakeOptions(c.actor())).rejectionPolicy?.departmentCodes).toEqual(["INPATIENT"]);
    await expect(c.service.getHospitalIntakeOptions(c.actor(), { departmentCode: "LABORATORY" })).rejects.toMatchObject({ status: 404 });
    expect((await c.service.getHospitalIntakeOptions(c.store.getState().users.find((user) => user.id === "user-manager")!)).rejectionPolicy?.departmentCodes).toEqual(["INPATIENT", "LABORATORY"]);
    await c.store.transaction((state) => ({ state: { ...state, users: [...state.users, { ...c.actor(), id: "synthetic-viewer", role: "VIEWER", accessGroupId: "access-group-viewer" }] }, result: undefined }));
    for (const id of ["synthetic-viewer", "user-admin"]) await expect(c.service.getHospitalIntakeOptions(c.store.getState().users.find((user) => user.id === id)!)).rejects.toMatchObject({ status: 404 });
    expect(JSON.stringify(await c.service.getHospitalIntakeOptions(c.actor()))).not.toMatch(/patientIds|passwordHash|whatsappPhone/);
    const intake = await c.receive("receive"); const input = { decision: "REJECT" as const, reasonCode: "COVERED", reasonPolicyVersion: policy.version, expectedVersion: 1, idempotencyKey: "reject" };
    await c.service.triageHospitalIntake(c.actor(), intake.id, input);
    await c.store.transaction((state) => ({ state: { ...state, accessGroups: state.accessGroups.map((group) => group.id === c.actor().accessGroupId ? { ...group, permissions: group.permissions.filter((permission) => permission !== "hospital_intake.triage") } : group) }, result: undefined }));
    await expect(c.service.getHospitalIntakeOptions(c.actor())).rejects.toMatchObject({ status: 404 });
    await expect(c.service.triageHospitalIntake(c.actor(), intake.id, input)).rejects.toMatchObject({ status: 404 });
    expect(c.store.getState().auditEvents.filter((event) => event.eventType === "HospitalIntakeTriaged")).toHaveLength(1);
  });

  it("keeps presets unavailable outside their approved departments, and does not infer a default reason", async () => {
    configure({ ...policy, departmentCodes: ["LABORATORY"] }); const c = setup(); const intake = await c.receive("receive");
    expect(await c.service.getHospitalIntakeOptions(c.actor())).toEqual({ rejectionPolicyStatus: "OFF" });
    await expect(c.service.triageHospitalIntake(c.actor(), intake.id, { decision: "REJECT", reasonCode: "COVERED", reasonPolicyVersion: policy.version, expectedVersion: 1, idempotencyKey: "scope" })).rejects.toMatchObject({ status: 409 });
    const { defaultReasonCode: _default, ...withoutDefault } = policy; configure(withoutDefault);
    expect((await c.service.getHospitalIntakeOptions(c.actor(), { departmentCode: "INPATIENT" })).rejectionPolicy?.defaultReasonCode).toBeUndefined();
    await c.store.transaction((state) => ({ state: { ...state, departments: state.departments.map((department) => ({ ...department, active: false })) }, result: undefined }));
    expect(await c.service.getHospitalIntakeOptions(c.actor())).toEqual({ rejectionPolicyStatus: "OFF" });
  });

  it.each([
    { ...policy, approvedAt: "2999-01-01T00:00:00Z" }, { ...policy, approvedAt: "invalid" },
    { ...policy, approvalReference: "" }, { ...policy, version: "" },
    { ...policy, departmentCodes: ["INPATIENT", "INPATIENT"] }, { ...policy, departmentCodes: [] },
    { ...policy, reasons: [policy.reasons[0], policy.reasons[0]] }, { ...policy, reasons: [] },
    { ...policy, reasons: [{ code: "invalid code", label: "Texto" }] }, { ...policy, extra: true }
  ])("fails closed for malformed or unapproved institutional configuration %#", (value) => {
    expect(intakeRejectionPolicyFromEnvironment({ HOSPITAL_INTAKE_REJECTION_POLICY_JSON: JSON.stringify(value) })).toEqual({ rejectionPolicyStatus: "INVALID" });
  });
});
