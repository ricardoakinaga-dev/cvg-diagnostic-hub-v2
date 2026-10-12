/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HospitalIntakeOptions, HospitalIntakeView } from "@cvg/contracts";
import { ApiClientError, apiFetch } from "./api-client";
import { PlannerIntake } from "./planner-intake";
import { plannerUser } from "./planner.test-helpers";

vi.mock("next/link", () => ({ default: ({ children, ...props }: { children: React.ReactNode; href: string }) => <a {...props}>{children}</a> }));
vi.mock("./api-client", async (original) => ({ ...await original<typeof import("./api-client")>(), apiFetch: vi.fn() }));
const policy = { version: "synthetic-policy-1", approvalReference: "SYNTHETIC-APPROVAL", approvedAt: "2026-01-01T00:00:00Z", departmentCodes: ["INPATIENT"], defaultReasonCode: "COVERED", reasons: [{ code: "COVERED", label: "Demanda já coberta" }, { code: "OUT_OF_SCOPE", label: "Fora da finalidade aprovada" }] };
let row: HospitalIntakeView; let options: HospitalIntakeOptions; let refused = false; let viewer = false; let unavailable = false;
beforeEach(() => {
  row = { id: "intake", title: "Conferir materiais", departmentCode: "INPATIENT", priority: "ROUTINE", source: "MANUAL", state: "RECEIVED", submittedBy: "other-author", version: 3, createdAt: "2026-10-11T12:00:00Z", updatedAt: "2026-10-11T12:00:00Z", permissions: ["hospital_intake.view", "hospital_intake.triage"] };
  options = { rejectionPolicyStatus: "AVAILABLE", rejectionPolicy: policy }; refused = false; viewer = false; unavailable = false;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === "/session/me") return { user: viewer ? { ...plannerUser, role: "VIEWER", permissions: ["hospital_intake.view"] } : plannerUser } as never;
    if (path === "/hospital-intakes/options") { if (unavailable) throw new Error("policy read unavailable"); return options as never; }
    if (path.startsWith("/hospital-intakes?")) return { items: [row], total: 1, limit: 50 } as never;
    if (path.endsWith("/triage") && init?.method === "POST") {
      if (refused) throw new ApiClientError(409, { error: { code: "INTAKE_REJECTION_POLICY_CHANGED", message: "Atualize os motivos antes de confirmar." } });
      const body = JSON.parse(init.body as string); const reason = policy.reasons.find((entry) => entry.code === body.reasonCode);
      row = { ...row, state: "REJECTED", version: 4, permissions: [], reason: body.reason || reason?.label, ...(reason ? { reasonPolicy: { ...reason, policyVersion: body.reasonPolicyVersion, approvalReference: policy.approvalReference, approvedAt: policy.approvedAt } } : {}) };
      return row as never;
    }
    return [] as never;
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });
function writes() { return vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === "POST"); }
async function reject() { const button = await screen.findByRole("button", { name: "Rejeitar demanda" }); await waitFor(() => expect(button).toBeEnabled()); fireEvent.click(button); }

it("rejects in exactly two interactions using only an explicitly approved default and captures the policy version", async () => {
  render(<PlannerIntake />); await reject();
  expect(screen.getByRole("combobox", { name: "Motivo pré-definido aprovado" })).toHaveValue("COVERED");
  expect(screen.getByLabelText("Motivo da decisão")).not.toBeRequired(); expect(writes()).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Confirmar decisão" }));
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(JSON.parse(writes()[0][1]!.body as string)).toEqual({ decision: "REJECT", reasonCode: "COVERED", reasonPolicyVersion: policy.version, expectedVersion: 3 });
  expect(await screen.findByText(/Motivo aprovado: Demanda já coberta/)).toHaveTextContent(policy.approvalReference);
  expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path.includes("diagnostic-items") || path === "/hospital-tasks")).toBe(false);
});

it.each(["OFF", "INVALID"] as const)("requires a professional's own reason when institutional presets are %s", async (status) => {
  options = { rejectionPolicyStatus: status }; render(<PlannerIntake />); await reject();
  expect(screen.queryByRole("combobox", { name: "Motivo pré-definido aprovado" })).not.toBeInTheDocument();
  expect(screen.getByLabelText("Motivo da decisão")).toBeRequired(); fireEvent.submit(screen.getByRole("form", { name: "Decidir demanda Conferir materiais" })); expect(writes()).toHaveLength(0);
  fireEvent.change(screen.getByLabelText("Motivo da decisão"), { target: { value: "Conferência registrada pelo profissional" } }); fireEvent.click(screen.getByRole("button", { name: "Confirmar decisão" }));
  await waitFor(() => expect(writes()).toHaveLength(1)); expect(JSON.parse(writes()[0][1]!.body as string)).toEqual({ decision: "REJECT", reason: "Conferência registrada pelo profissional", expectedVersion: 3 });
});

it("does not infer a default from the first configured reason and allows a deliberate approved selection or manual fallback", async () => {
  const { defaultReasonCode: _default, ...withoutDefault } = policy; options = { rejectionPolicyStatus: "AVAILABLE", rejectionPolicy: withoutDefault }; render(<PlannerIntake />); await reject();
  expect(screen.getByRole("combobox", { name: "Motivo pré-definido aprovado" })).toHaveValue("");
  fireEvent.submit(screen.getByRole("form", { name: "Decidir demanda Conferir materiais" })); expect(writes()).toHaveLength(0);
  fireEvent.change(screen.getByRole("combobox", { name: "Motivo pré-definido aprovado" }), { target: { value: "OUT_OF_SCOPE" } }); expect(screen.getByLabelText("Motivo da decisão")).not.toBeRequired();
  fireEvent.change(screen.getByRole("combobox", { name: "Motivo pré-definido aprovado" }), { target: { value: "" } }); expect(screen.getByLabelText("Motivo da decisão")).toBeRequired();
  fireEvent.change(screen.getByRole("combobox", { name: "Motivo pré-definido aprovado" }), { target: { value: "OUT_OF_SCOPE" } }); fireEvent.change(screen.getByLabelText("Motivo da decisão"), { target: { value: "Detalhe preservado" } }); fireEvent.click(screen.getByRole("button", { name: "Confirmar decisão" }));
  await waitFor(() => expect(writes()).toHaveLength(1)); expect(JSON.parse(writes()[0][1]!.body as string)).toMatchObject({ reason: "Detalhe preservado", reasonCode: "OUT_OF_SCOPE", reasonPolicyVersion: policy.version });
});

it("retains the selected policy and durable intent on a conflict, requiring a deliberate new decision to adopt a changed approval", async () => {
  refused = true; render(<PlannerIntake />); await reject(); fireEvent.click(screen.getByRole("button", { name: "Confirmar decisão" })); await screen.findByText("A política de rejeição mudou. Atualize os motivos antes de confirmar uma nova decisão.");
  options = { ...options, rejectionPolicy: { ...policy, version: "synthetic-policy-2" } }; act(() => window.dispatchEvent(new Event("cvg:realtime-resync")));
  await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.filter(([path]) => path === "/hospital-intakes/options")).toHaveLength(2));
  fireEvent.click(screen.getByRole("button", { name: "Confirmar decisão" })); await waitFor(() => expect(writes()).toHaveLength(2));
  expect(JSON.parse(writes()[1][1]!.body as string).reasonPolicyVersion).toBe(policy.version); expect(writes()[0][1]!.headers).toEqual(writes()[1][1]!.headers);
  fireEvent.click(screen.getByRole("button", { name: "Voltar" })); await reject(); fireEvent.click(screen.getByRole("button", { name: "Confirmar decisão" })); await waitFor(() => expect(writes()).toHaveLength(3));
  expect(JSON.parse(writes()[2][1]!.body as string).reasonPolicyVersion).toBe("synthetic-policy-2"); expect(writes()[2][1]!.headers).not.toEqual(writes()[0][1]!.headers);
});

it("offers manual triage during a metadata outage and gives VIEWER no policy request or mutation controls", async () => {
  unavailable = true; const c = render(<PlannerIntake />); await screen.findByText(/Não foi possível atualizar os motivos aprovados/); await reject(); expect(screen.getByLabelText("Motivo da decisão")).toBeRequired();
  c.unmount(); vi.mocked(apiFetch).mockClear(); viewer = true; render(<PlannerIntake />); await screen.findByRole("heading", { name: "Conferir materiais" });
  expect(screen.queryByRole("button", { name: "Rejeitar demanda" })).not.toBeInTheDocument(); expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path === "/hospital-intakes/options")).toBe(false);
});
