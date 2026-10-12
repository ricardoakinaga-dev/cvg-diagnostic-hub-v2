/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { HospitalPlanView, SavedPlannerView, SessionUser } from "@cvg/contracts";
import { ApiClientError } from "./api-client";
import * as api from "./api-client";
import { PlannerTimeline } from "./planner-timeline";
import { PLANNER_DEFAULT_DISPLAY } from "./planner-model";
import { hospitalPlan } from "./hospital-ui.test-helpers";
import { taskView } from "./planner.test-helpers";
import type { RequestListEntry } from "./work-items/model";

vi.mock("next/link", () => ({ default: ({ children, ...props }: { children: React.ReactNode; href: string }) => <a {...props}>{children}</a> }));

const from = "2026-10-11T12:00:00.000Z";
const to = "2026-10-12T12:00:00.000Z";
const user: SessionUser = { id: "clinician-b", role: "VETERINARIAN", displayName: "Veterinária B", email: "synthetic@example.invalid", departmentCode: "INPATIENT", timezone: "UTC", permissions: ["hospital_task.view", "request.list", "item.view", "plan.view", "planner_view.view"] };
const request: RequestListEntry = {
  id: "request-1", requestCode: "REQ-SYNTHETIC", requesterId: "clinician-a", priority: "URGENT", createdAt: from,
  patient: { id: "patient-1", displayName: "Paciente autorizado", externalId: "SYNTHETIC-PATIENT", species: "Canino" },
  items: [
    { id: "requested", status: "REQUESTED", service: { id: "service-1", code: "REQ", name: "Exame solicitado" }, plannedStartsAt: "2026-10-11T13:00:00.000Z" },
    { id: "received", status: "RECEIVED", service: { id: "service-2", code: "REC", name: "Exame recebido" }, plannedStartsAt: "2026-10-11T14:00:00.000Z" },
    { id: "available", status: "RESULT_AVAILABLE", service: { id: "service-3", code: "RES", name: "Exame com laudo" }, plannedStartsAt: "2026-10-11T15:00:00.000Z" },
    { id: "outside-plan", status: "REQUESTED", service: { id: "service-4", code: "OUT", name: "Exame sem vínculo" }, plannedStartsAt: "2026-10-11T16:00:00.000Z" }
  ].map((item) => ({ ...item, requestId: "request-1", status: item.status as RequestListEntry["items"][number]["status"], priority: "URGENT" as const, departmentCode: "LABORATORY", workflowType: "LABORATORY" as const, assignedUserId: user.id, version: 7, dueAt: to, plannedEndsAt: "2026-10-11T17:00:00.000Z" }))
};
const activities: HospitalPlanView["activities"] = request.items.filter((item) => item.id !== "outside-plan").map((item) => ({ id: `link-${item.id}`, stepId: "step-1", targetType: "DIAGNOSTIC_ITEM", targetId: item.id, label: item.service.name, status: item.status, phase: item.status === "RESULT_AVAILABLE" ? "IN_PROGRESS" : "PENDING", departmentCode: item.departmentCode, blocked: false }));
const plan: HospitalPlanView = {
  ...hospitalPlan({ departmentCodes: ["INPATIENT", "LABORATORY"], links: activities.map(({ id, stepId, targetType, targetId }) => ({ id, stepId, targetType, targetId })) }),
  activities,
  steps: [{ id: "step-1", title: "Avaliação", sortOrder: 0, visibleActivities: 3, completedActivities: 0, blockedActivities: 0, state: "IN_PROGRESS" }],
  summary: { visibleActivities: 3, completedActivities: 0, pendingActivities: 3, blockedActivities: 0, denominator: "AUTHORIZED_UNIQUE_ACTIVITIES" }
};
const saved = (id: string, filters: SavedPlannerView["filters"]): SavedPlannerView => ({ id, name: id, ownerId: user.id, filters: { from, to, ...filters }, display: PLANNER_DEFAULT_DISPLAY, active: true, version: 1, createdAt: from, updatedAt: from });
const views = [saved("Aguardando execução", { phase: "PENDING" }), saved("Em execução", { phase: "IN_PROGRESS" }), saved("Pendentes do plano", { planId: plan.plan.id, phase: "PENDING", departmentCode: "LABORATORY", responsibleUserId: user.id, priority: "URGENT", from: "2026-10-11T14:00:00.000Z" }), saved("Tipo hospitalar", { typeId: "routine-only" })];

let currentUser: SessionUser;
let failure: number;
let pendingPlan: Promise<HospitalPlanView> | undefined;
let read: MockInstance<typeof api.apiFetch>;

beforeEach(() => {
  currentUser = user; failure = 0; pendingPlan = undefined;
  window.localStorage.clear();
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(from));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

function fixtures() {
  read = vi.spyOn(api, "apiFetch").mockImplementation(async <T,>(path: string) => {
    if (path === "/session/me") return { user: currentUser } as T;
    if (path === "/planner-views") return views as T;
    if (path === `/hospital-plans/${plan.plan.id}`) {
      if (failure) throw new ApiClientError(failure, { error: { code: "CURRENT_PLAN_UNAVAILABLE" } });
      return await (pendingPlan ?? Promise.resolve(plan)) as T;
    }
    if (path.startsWith("/hospital-plans?")) return { items: [plan], total: 1, limit: 50 } as T;
    if (path.startsWith("/hospital-tasks?")) return { items: [taskView({ title: "Rotina hospitalar autorizada" }, ["hospital_task.view"])], total: 1, limit: 50 } as T;
    throw new Error(`Unexpected timeline read ${path}`);
  });
  vi.spyOn(api, "apiFetchWithMeta").mockImplementation(async <T,>(path: string) => {
    if (!path.startsWith("/diagnostic-requests?")) throw new Error(`Unexpected timeline feed ${path}`);
    return { data: [request] as T, meta: { correlationId: "synthetic", requestId: "synthetic" } };
  });
}

const name = (label: string) => `${label} · ${request.requestCode}`;
async function applyView(id: string) {
  await screen.findByRole("option", { name: id });
  fireEvent.change(screen.getByRole("combobox", { name: "Aplicar filtros de visão salva" }), { target: { value: id } });
}

describe("authorized diagnostic filters on the hospital timeline", () => {
  it("retains planned examinations linked to the selected native plan without changing clinical states, deadlines or commands", async () => {
    fixtures(); const original = structuredClone(request); render(<PlannerTimeline />);
    await screen.findByRole("link", { name: name("Exame sem vínculo") });
    await screen.findByRole("option", { name: /Plano do atendimento/ });
    fireEvent.change(screen.getByRole("combobox", { name: "Plano assistencial" }), { target: { value: plan.plan.id } });
    const received = await screen.findByRole("link", { name: name("Exame recebido") });
    expect(received).toHaveAttribute("href", "/requests/request-1");
    expect(within(received.closest("section")!).getByText(/Exame diagnóstico · RECEIVED · prazo/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: name("Exame solicitado") })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: name("Exame com laudo") })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: name("Exame sem vínculo") })).not.toBeInTheDocument();
    expect(read).toHaveBeenCalledWith(`/hospital-plans/${plan.plan.id}`);
    expect(screen.queryByRole("button", { name: /Iniciar|Concluir|Salvar planejamento/ })).not.toBeInTheDocument();
    expect(read.mock.calls.every(([, init]) => !init?.method)).toBe(true);
    expect(request).toEqual(original);
  });

  it("applies the shared read-only phase projection and preserves a planned result's native diagnostic state", async () => {
    fixtures(); render(<PlannerTimeline />); await screen.findByRole("link", { name: name("Exame com laudo") });
    await applyView("Aguardando execução");
    expect(await screen.findByRole("link", { name: name("Exame recebido") })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: name("Exame solicitado") })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: name("Exame com laudo") })).not.toBeInTheDocument();
    await applyView("Em execução");
    const available = await screen.findByRole("link", { name: name("Exame com laudo") });
    expect(within(available.closest("section")!).getByText(/Exame diagnóstico · RESULT_AVAILABLE · prazo/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: name("Exame recebido") })).not.toBeInTheDocument();
    expect(read.mock.calls.some(([path]) => path.startsWith("/hospital-plans/"))).toBe(false);
  });

  it("combines plan, phase and assignment filters, lets an explicit period replace saved dates and rejects a HospitalTask type for examinations", async () => {
    fixtures(); render(<PlannerTimeline />); await screen.findByRole("link", { name: name("Exame sem vínculo") });
    await applyView("Pendentes do plano"); await screen.findByRole("link", { name: name("Exame recebido") });
    expect(screen.queryByRole("link", { name: name("Exame solicitado") })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: name("Exame com laudo") })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: name("Exame sem vínculo") })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Período de"), { target: { value: "2026-10-11T10:00" } });
    fireEvent.submit(screen.getByRole("form", { name: "Filtrar cronograma" }));
    expect(screen.getByRole("link", { name: name("Exame solicitado") })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Período de"), { target: { value: "2026-10-11T11:00" } });
    fireEvent.submit(screen.getByRole("form", { name: "Filtrar cronograma" }));
    expect(screen.getByRole("link", { name: name("Exame recebido") })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: name("Exame solicitado") })).not.toBeInTheDocument();
    await applyView("Tipo hospitalar");
    expect(screen.queryByRole("link", { name: name("Exame recebido") })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Limpar filtros de visão salva" }));
    await screen.findByRole("link", { name: name("Exame sem vínculo") });
  });

  it.each([401, 403, 404, 503])("hides plan-filtered examinations on current native read failure %s, preserves independent tasks and recovers explicitly", async (status) => {
    fixtures(); render(<PlannerTimeline />); await applyView("Pendentes do plano");
    await screen.findByRole("link", { name: name("Exame recebido") });
    failure = status; act(() => window.dispatchEvent(new Event("cvg:realtime-resync")));
    await screen.findByText("Exames indisponíveis até revalidar o plano.");
    expect(screen.queryByRole("link", { name: name("Exame recebido") })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Rotina hospitalar autorizada" })).toBeInTheDocument();
    expect(screen.queryByText("Nenhum intervalo autorizado nesta seleção.")).not.toBeInTheDocument();
    failure = 0; fireEvent.click(await screen.findByRole("button", { name: "Tentar novamente" }));
    await screen.findByRole("link", { name: name("Exame recebido") });
  });

  it("does not issue a plan detail read without its effective grant", async () => {
    currentUser = { ...user, permissions: user.permissions!.filter((permission) => permission !== "plan.view") };
    fixtures(); render(<PlannerTimeline />); await applyView("Pendentes do plano");
    await screen.findByText(/Esta visão exige acesso atual ao plano/);
    expect(screen.queryByRole("link", { name: name("Exame recebido") })).not.toBeInTheDocument();
    expect(read.mock.calls.some(([path]) => path === `/hospital-plans/${plan.plan.id}`)).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Limpar filtros de visão salva" }));
    await screen.findByRole("link", { name: name("Exame recebido") });
  });

  it("removes a previously authorized plan after its effective grant is withdrawn", async () => {
    fixtures(); render(<PlannerTimeline />); await applyView("Pendentes do plano");
    await screen.findByRole("link", { name: name("Exame recebido") });
    read.mockClear(); currentUser = { ...user, permissions: user.permissions!.filter((permission) => permission !== "plan.view") };
    act(() => window.dispatchEvent(new Event("cvg:realtime-resync")));
    await screen.findByText(/Esta visão exige acesso atual ao plano/);
    expect(screen.queryByRole("link", { name: name("Exame recebido") })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Limpar filtros de visão salva" }));
    await screen.findByRole("link", { name: name("Exame recebido") });
  });

  it("does not expose cached examinations while the current plan is revalidating", async () => {
    fixtures(); render(<PlannerTimeline />); await applyView("Pendentes do plano");
    await screen.findByRole("link", { name: name("Exame recebido") });
    let resolve!: (value: HospitalPlanView) => void;
    pendingPlan = new Promise((complete) => { resolve = complete; });
    act(() => window.dispatchEvent(new Event("cvg:realtime-updated")));
    await screen.findByText("Revalidando exames do plano");
    expect(screen.queryByRole("link", { name: name("Exame recebido") })).not.toBeInTheDocument();
    expect(screen.getByText("Exames indisponíveis até revalidar o plano.")).toBeInTheDocument();
    await act(async () => { resolve(plan); });
    await screen.findByRole("link", { name: name("Exame recebido") });
  });
});
