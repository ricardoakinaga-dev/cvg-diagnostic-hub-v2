/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedPlannerView, SessionUser } from "@cvg/contracts";
import { rolePermissions } from "@/server/security/authorization";
import { Home } from "./home-view";
import { PlannerSearch } from "./planner-search";
import { WorkItemsView } from "./work-items/work-items-view";
import { PLANNER_DEFAULT_DISPLAY } from "./planner-model";
import * as api from "./api-client";

vi.mock("next/link", () => ({ default: ({ children, ...props }: { children: React.ReactNode; href: string }) => <a {...props}>{children}</a> }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }) }));
vi.mock("./dashboard", () => ({ Dashboard: () => <p>Administração técnica</p> }));
const user: SessionUser = { id: "clinician", displayName: "Veterinária sintética", role: "VETERINARIAN", email: "synthetic@example.invalid", departmentCode: "INPATIENT", timezone: "UTC", permissions: [...rolePermissions.VETERINARIAN] };
const instant = "2026-10-12T00:00:00.000Z";
const saved: SavedPlannerView = { id: "shared-view", name: "Atribuídas no plano", ownerId: "another-professional", sharedDepartmentCode: "INPATIENT", filters: { departmentCode: "LABORATORY", responsibleUserId: user.id, priority: "URGENT", phase: "PENDING", from: instant, to: instant, planId: "authorized-plan" }, display: PLANNER_DEFAULT_DISPLAY, active: true, version: 1, createdAt: instant, updatedAt: instant };
const request = { id: "request", requestCode: "REQ-SYNTHETIC", priority: "URGENT", requesterId: "another-professional", createdAt: "2026-10-01T12:00:00.000Z", patient: { id: "patient", displayName: "Paciente autorizado", species: "Canino", externalId: "PAT-SYNTHETIC" }, items: [
  { id: "assigned", requestId: "request", departmentCode: "LABORATORY", status: "REQUESTED", priority: "URGENT", assignedUserId: user.id, plannedStartsAt: instant, workflowType: "LABORATORY", version: 1, dueAt: "2027-01-01T00:00:00Z", service: { id: "service1", code: "ASSIGNED", name: "Exame atribuído" } },
  { id: "other", requestId: "request", departmentCode: "RADIOLOGY", status: "RESULT_AVAILABLE", priority: "ROUTINE", assignedUserId: "another-professional", plannedStartsAt: "2026-10-12T12:00:00.000Z", workflowType: "RADIOLOGY", version: 2, dueAt: "2027-01-01T00:00:00Z", service: { id: "service2", code: "OTHER", name: "Outro exame autorizado" } }
] };

function fixtures(options: { planFailure?: () => number; viewsFailure?: () => number; currentUser?: () => SessionUser } = {}) {
  const read = vi.spyOn(api, "apiFetch").mockImplementation(async <T,>(path: string) => {
    if (path === "/session/me") return { user: options.currentUser?.() ?? user } as T;
    if (path === "/planner-views") { const failure = options.viewsFailure?.(); if (failure) throw new api.ApiClientError(failure, {}); return [saved, { ...saved, id: "private-task-type", name: "Rotina geral", ownerId: user.id, sharedDepartmentCode: undefined, filters: { typeId: "general-care" } }, { ...saved, id: "inactive", name: "Desativada", active: false }] as T; }
    if (path === "/hospital-plans/authorized-plan") { const failure = options.planFailure?.(); if (failure) throw new api.ApiClientError(failure, {}); return { activities: [{ targetType: "DIAGNOSTIC_ITEM", targetId: "assigned" }] } as T; }
    if (path === "/dashboard") return { departments: [{ departmentCode: "LABORATORY", attention: 100, state: "ATTENTION" }] } as T;
    if (path.startsWith("/departments")) return [{ id: "lab", code: "LABORATORY", name: "Laboratório", type: "DIAGNOSTIC", active: true }, { id: "rad", code: "RADIOLOGY", name: "Radiologia", type: "DIAGNOSTIC", active: true }] as T;
    if (path === "/diagnostic-services") return [] as T;
    if (path.startsWith("/planner/search?")) return { items: [{ id: "assigned", type: "DIAGNOSTIC_ITEM", label: "Exame atribuído", deepLink: "/requests/request#assigned", updatedAt: instant }], total: 1, limit: 50 } as T;
    throw new Error(`Unexpected saved surface read ${path}`);
  });
  vi.spyOn(api, "apiFetchWithMeta").mockImplementation(async <T,>(path: string) => ({ data: (path.startsWith("/diagnostic-requests?") ? [request] : []) as T, meta: { correlationId: "synthetic", requestId: "synthetic" } }));
  return read;
}
beforeEach(() => { window.localStorage.clear(); window.history.replaceState(null, "", "/"); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("saved views on the normal clinician's operational surfaces", () => {
  it("disables cached saved configurations while their current list is unavailable and recovers through the explicit retry", async () => {
    let failure = 0; fixtures({ viewsFailure: () => failure }); render(<WorkItemsView />); await screen.findByRole("option", { name: "Atribuídas no plano · Compartilhada" });
    failure = 503; act(() => window.dispatchEvent(new Event("cvg:realtime-updated"))); await screen.findByRole("button", { name: "Recarregar visões salvas" }); expect(screen.getByRole("combobox", { name: "Aplicar visão salva" })).toBeDisabled();
    failure = 0; fireEvent.click(screen.getByRole("button", { name: "Recarregar visões salvas" })); await waitFor(() => expect(screen.getByRole("combobox", { name: "Aplicar visão salva" })).toBeEnabled()); expect(screen.queryByRole("button", { name: "Recarregar visões salvas" })).not.toBeInTheDocument();
  });
  it("applies all criteria in one Home selection, reconciles summaries with the filtered exams and restores them on reload", async () => {
    fixtures(); const mounted = render(<Home />);
    const picker = await screen.findByRole("combobox", { name: "Aplicar visão salva" }); await screen.findByRole("option", { name: "Atribuídas no plano · Compartilhada" });
    expect(screen.queryByRole("option", { name: /Desativada/ })).not.toBeInTheDocument();
    fireEvent.change(picker, { target: { value: saved.id } });
    await screen.findByText("1 exames carregados correspondem à visão aplicada. Os resumos abaixo usam estes mesmos exames.");
    expect(within(screen.getByRole("navigation", { name: "Atalhos" })).getByRole("link", { name: /Na minha fila\s*1/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Outro exame autorizado/ })).not.toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Critérios da visão salva" })).getByText("Responsável: clinician")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Laboratório\s*Visão aplicada/ })).toHaveTextContent("1atenção");
    mounted.unmount(); render(<Home />); await screen.findByText("1 exames carregados correspondem à visão aplicada. Os resumos abaixo usam estes mesmos exames.");
    fireEvent.click(screen.getByRole("button", { name: "Limpar visão salva aplicada" })); await screen.findAllByRole("link", { name: /Outro exame autorizado/ });
  });
  it("applies the same view to the diagnostic queue and explains a HospitalTask type incompatibility instead of broadening results", async () => {
    const read = fixtures(); render(<WorkItemsView />); await screen.findByRole("button", { name: "Abrir Outro exame autorizado — Paciente autorizado" });
    await screen.findByRole("option", { name: "Atribuídas no plano · Compartilhada" }); fireEvent.change(screen.getByRole("combobox", { name: "Aplicar visão salva" }), { target: { value: saved.id } });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Abrir Outro exame autorizado — Paciente autorizado" })).not.toBeInTheDocument());
    expect(await screen.findByRole("button", { name: "Abrir Exame atribuído — Paciente autorizado" })).toBeInTheDocument();
    expect(read).toHaveBeenCalledWith("/hospital-plans/authorized-plan");
    fireEvent.change(screen.getByRole("combobox", { name: "Aplicar visão salva" }), { target: { value: "private-task-type" } });
    await screen.findByText("Esta visão exige um tipo de atividade hospitalar. Exames não possuem esse tipo e não correspondem ao filtro.");
    expect(screen.queryByRole("button", { name: "Abrir Exame atribuído — Paciente autorizado" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Limpar visão salva aplicada" })); await screen.findByRole("button", { name: "Abrir Outro exame autorizado — Paciente autorizado" });
  });
  it("reuses every saved criterion in the search contract in one selection without retaining a separate shift or record type", async () => {
    const read = fixtures(); render(<PlannerSearch />); await screen.findByRole("option", { name: "Atribuídas no plano · Compartilhada" });
    fireEvent.click(screen.getByLabelText("Documento operacional")); fireEvent.click(screen.getByLabelText("Incluir documentos e atividades arquivados"));
    fireEvent.change(screen.getByRole("combobox", { name: "Aplicar visão salva" }), { target: { value: saved.id } });
    fireEvent.change(screen.getByLabelText("Texto, identificação ou paciente"), { target: { value: "atribuído" } }); fireEvent.submit(screen.getByRole("form", { name: "Pesquisar no planner" }));
    await screen.findByRole("link", { name: "Exame atribuído" }); const path = read.mock.calls.find(([value]) => value.startsWith("/planner/search?"))![0];
    expect(Object.fromEntries(new URLSearchParams(path.split("?")[1]))).toEqual({ ...saved.filters, query: "atribuído", limit: "50" });
    expect(screen.getByLabelText("Documento operacional")).not.toBeChecked(); expect(screen.getByLabelText("Incluir documentos e atividades arquivados")).not.toBeChecked();
  });
  it.each([404, 503])("hides all plan-filtered exams when current plan authority cannot be validated (%s), and permits recovery", async (status) => {
    let failure = 0; fixtures({ planFailure: () => failure }); render(<WorkItemsView />); await screen.findByRole("option", { name: "Atribuídas no plano · Compartilhada" }); fireEvent.change(screen.getByRole("combobox", { name: "Aplicar visão salva" }), { target: { value: saved.id } }); await screen.findByRole("button", { name: "Abrir Exame atribuído — Paciente autorizado" });
    failure = status; act(() => window.dispatchEvent(new Event("cvg:realtime-updated"))); await screen.findByRole("button", { name: "Revalidar plano da visão" });
    expect(screen.queryByRole("button", { name: "Abrir Exame atribuído — Paciente autorizado" })).not.toBeInTheDocument(); failure = 0; fireEvent.click(screen.getByRole("button", { name: "Revalidar plano da visão" })); await screen.findByRole("button", { name: "Abrir Exame atribuído — Paciente autorizado" });
  });
  it.each([404, 503])("keeps Home summaries unavailable rather than reporting zero or no clinical work when the plan cannot be revalidated (%s)", async (status) => {
    let failure = 0; fixtures({ planFailure: () => failure }); render(<Home />);
    await screen.findByRole("option", { name: "Atribuídas no plano · Compartilhada" }); fireEvent.change(screen.getByRole("combobox", { name: "Aplicar visão salva" }), { target: { value: saved.id } });
    await screen.findByText("1 exames carregados correspondem à visão aplicada. Os resumos abaixo usam estes mesmos exames.");
    failure = status; act(() => window.dispatchEvent(new Event("cvg:realtime-updated")));
    await screen.findByText("Os resumos estão indisponíveis até revalidar o plano ou limpar a visão aplicada.");
    expect(screen.queryByRole("navigation", { name: "Atalhos" })).not.toBeInTheDocument();
    expect(screen.queryByText(/exames carregados correspondem/)).not.toBeInTheDocument();
    expect(screen.queryByText("Nenhum exame exige atenção imediata.")).not.toBeInTheDocument();
    expect(screen.queryByText("Nenhum resultado aguardando revisão.")).not.toBeInTheDocument();
    expect(screen.queryByText("Nenhuma solicitação ainda.")).not.toBeInTheDocument();
    failure = 0; fireEvent.click(screen.getByRole("button", { name: "Revalidar plano da visão" }));
    await screen.findByText("1 exames carregados correspondem à visão aplicada. Os resumos abaixo usam estes mesmos exames.");
    expect(within(screen.getByRole("navigation", { name: "Atalhos" })).getByRole("link", { name: /Na minha fila\s*1/ })).toBeInTheDocument();
    failure = status; act(() => window.dispatchEvent(new Event("cvg:realtime-updated")));
    await screen.findByText("Os resumos estão indisponíveis até revalidar o plano ou limpar a visão aplicada.");
    fireEvent.click(screen.getByRole("button", { name: "Limpar visão salva aplicada" }));
    await screen.findAllByRole("link", { name: /Outro exame autorizado/ });
    expect(screen.queryByText("Os resumos estão indisponíveis até revalidar o plano ou limpar a visão aplicada.")).not.toBeInTheDocument();
  });
  it("does not fetch a saved plan without its native current permission or apply another identity's persisted criteria", async () => {
    const reduced = { ...user, permissions: user.permissions!.filter(permission => permission !== "plan.view") }; let identity: SessionUser = reduced;
    const read = fixtures({ currentUser: () => identity }); render(<WorkItemsView />); await screen.findByRole("option", { name: "Atribuídas no plano · Compartilhada" }); fireEvent.change(screen.getByRole("combobox", { name: "Aplicar visão salva" }), { target: { value: saved.id } });
    await screen.findByText("Esta visão exige acesso atual ao plano. Nenhum exame é exibido até selecionar uma visão compatível."); expect(read.mock.calls.some(([path]) => path === "/hospital-plans/authorized-plan")).toBe(false);
    identity = { ...user, id: "another-user" }; act(() => window.dispatchEvent(new Event("cvg:realtime-resync"))); await screen.findByText("Nenhum filtro de visão salva aplicado."); expect(screen.queryByRole("list", { name: "Critérios da visão salva" })).not.toBeInTheDocument();
  });
});
