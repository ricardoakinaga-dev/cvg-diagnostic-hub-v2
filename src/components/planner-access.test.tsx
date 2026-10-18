/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AuditEvent, Department, Encounter, Patient, SavedPlannerView } from "@cvg/contracts";
import { ApiClientError, apiFetch, apiFetchWithMeta } from "./api-client";
import { PlannerTaskHistory } from "./planner-task-history";
import { PlannerContextFields } from "./planner-context-fields";
import { PlannerSavedViews } from "./planner-saved-views";
import { PlannerIntake } from "./planner-intake";
import { PLANNER_DEFAULT_DISPLAY } from "./planner-model";
import { plannerUser } from "./planner.test-helpers";

vi.mock("next/link", () => ({ default: ({ children, ...props }: { children: React.ReactNode; href: string }) => <a {...props}>{children}</a> }));
vi.mock("./api-client", async (original) => ({ ...await original<typeof import("./api-client")>(), apiFetch: vi.fn(), apiFetchWithMeta: vi.fn() }));
const department: Department = { id: "dept", code: "SUPPORT", name: "Apoio", type: "SUPPORT", memberUserIds: [], active: true, version: 1, createdAt: "2026-10-11T12:00:00Z", updatedAt: "2026-10-11T12:00:00Z" };
beforeEach(() => { vi.mocked(apiFetch).mockResolvedValue([]); vi.mocked(apiFetchWithMeta).mockResolvedValue({ data: [], meta: { correlationId: "test", requestId: "test" } }); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("reads the full history with array metadata and removes confirmed events after scope withdrawal", async () => {
  let denied = false;
  const event: AuditEvent = { id: "event-1", entityType: "HospitalTask", entityId: "task", eventType: "HospitalTaskTransitioned", occurredAt: "2026-10-11T12:00:00Z", metadata: { command: "START", patientId: "redacted-reference" } };
  vi.mocked(apiFetchWithMeta).mockImplementation(async (path) => {
    if (denied) throw new ApiClientError(403, { error: { code: "SCOPE_DENIED" } });
    return { data: path.includes("cursor=") ? [{ ...event, id: "event-2", eventType: "HospitalTaskReprioritized", metadata: { reason: "Reavaliação operacional" } }] : [event], meta: { correlationId: "test", requestId: "test", total: 2, limit: 25, ...(!path.includes("cursor=") ? { nextCursor: "next-page" } : {}) } } as never;
  });
  render(<PlannerTaskHistory userId="viewer" taskId="task" />);
  await screen.findByText("Execução iniciada"); expect(document.body.innerHTML).not.toContain("redacted-reference");
  fireEvent.click(screen.getByRole("button", { name: "Carregar mais histórico da atividade" }));
  await screen.findByText("Prioridade reclassificada"); expect(screen.getByText("Motivo: Reavaliação operacional")).toBeInTheDocument();
  expect(vi.mocked(apiFetchWithMeta)).toHaveBeenCalledWith("/hospital-tasks/task/history?limit=25&cursor=next-page");
  denied = true; act(() => window.dispatchEvent(new Event("cvg:realtime-updated")));
  await waitFor(() => expect(screen.queryByText("Execução iniciada")).not.toBeInTheDocument());
  expect(screen.queryByText("Motivo: Reavaliação operacional")).not.toBeInTheDocument();
});

it("retains the authorized current patient outside page one and distinguishes names and encounters", async () => {
  const current = { id: "patient-current", displayName: "Thor", externalId: "HIS-77", ownerLabel: "Tutor B" };
  vi.mocked(apiFetch).mockImplementation(async (path) => path === "/patients" ? [{ id: "patient-other", displayName: "Thor", externalId: "HIS-12", ownerLabel: "Tutor A" } as Patient] as never : [{ id: "encounter-current", externalId: "AT-2", type: "INPATIENT", status: "OPEN" }, { id: "encounter-old", externalId: "AT-1", type: "OUTPATIENT", status: "CLOSED" } as Encounter] as never);
  const onChange = vi.fn();
  render(<PlannerContextFields value={{ patientId: current.id, encounterId: "encounter-current" }} currentPatient={current} onChange={onChange} allowed required />);
  expect(screen.getByLabelText("Paciente")).toHaveValue(current.id);
  await screen.findByRole("option", { name: "Thor · HIS-12 · tutor Tutor A" });
  expect(screen.getByRole("option", { name: "Thor · HIS-77 · tutor Tutor B" })).toBeInTheDocument();
  await screen.findByRole("option", { name: "AT-2 · Internação" });
  expect(screen.queryByRole("option", { name: /AT-1/ })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Paciente"), { target: { value: "patient-other" } });
  expect(onChange).toHaveBeenCalledWith({ patientId: "patient-other" });
});

it("edits the owner's view identity and visibility with its exact version", async () => {
  const view: SavedPlannerView = { id: "view", ownerId: plannerUser.id, name: "Rotina", sharedDepartmentCode: "INPATIENT", filters: {}, display: PLANNER_DEFAULT_DISPLAY, active: true, version: 7, createdAt: "2026-10-11T12:00:00Z", updatedAt: "2026-10-11T12:00:00Z" };
  vi.mocked(apiFetch).mockImplementation(async (_path, init) => init?.method ? view as never : [view] as never);
  render(<PlannerSavedViews user={plannerUser} filters={{}} display={PLANNER_DEFAULT_DISPLAY} departments={[department]} onApply={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Editar nome e visibilidade de Rotina" }));
  fireEvent.change(screen.getByLabelText("Novo nome da visão"), { target: { value: "Conferência diária" } }); fireEvent.change(screen.getByLabelText("Nova visibilidade"), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Salvar nome e visibilidade" }));
  await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalledWith("/planner-views/view", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ name: "Conferência diária", sharedDepartmentCode: null, expectedVersion: 7 }), headers: { "idempotency-key": expect.any(String) } })));
});

it("forwards an intake to an authorized existing task without creating a substitute clinical item", async () => {
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === "/session/me") return { user: plannerUser } as never;
    if (path === "/departments") return [department] as never;
    if (path.startsWith("/hospital-intakes?")) return { items: [{ id: "intake", title: "Repor material", departmentCode: "INPATIENT", source: "MANUAL", state: "RECEIVED", priority: "ROUTINE", submittedBy: "author", version: 5, createdAt: "2026-10-11T12:00:00Z", updatedAt: "2026-10-11T12:00:00Z", permissions: ["hospital_intake.triage"] }], total: 1, limit: 50 } as never;
    if (path.startsWith("/planner/search?")) return { items: [{ id: "existing-task", type: "HOSPITAL_TASK", label: "Abastecer armário", departmentCode: "SUPPORT", updatedAt: "2026-10-11T12:00:00Z", deepLink: "/planner/tasks/existing-task" }], total: 1, limit: 25 } as never;
    return init?.method ? { id: "intake", state: "ACCEPTED", version: 6 } as never : [] as never;
  });
  render(<PlannerIntake />); await screen.findByRole("button", { name: "Aceitar demanda" });
  await screen.findByRole("option", { name: "Apoio" }); fireEvent.change(screen.getByLabelText("Setor para aceite"), { target: { value: "SUPPORT" } });
  fireEvent.change(screen.getByLabelText("Vincular atividade existente"), { target: { value: "armário" } });
  fireEvent.click(await screen.findByRole("radio", { name: "Abastecer armário" })); fireEvent.click(screen.getByRole("button", { name: "Aceitar demanda" }));
  await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalledWith("/hospital-intakes/intake/triage", expect.objectContaining({ method: "POST", body: JSON.stringify({ decision: "ACCEPT", destinationDepartmentCode: "SUPPORT", destinationTaskId: "existing-task", expectedVersion: 5 }) })));
  expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path.includes("diagnostic-items"))).toBe(false);
});
