/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Permission, PlannerSearchResult, SavedPlannerView } from "@cvg/contracts";
import { PlannerSearch } from "./planner-search";
import { PlannerTimeline, timelineBar } from "./planner-timeline";
import * as api from "./api-client";
import { PLANNER_DEFAULT_DISPLAY } from "./planner-model";
import { plannerUser, taskView } from "./planner.test-helpers";
import { hospitalPlan, hospitalShift } from "./hospital-ui.test-helpers";
import type { RequestListEntry } from "./work-items/model";

const permissions: Permission[] = [...plannerUser.permissions!, "request.list", "item.view", "queue.view", "plan.view", "shift.view", "hospital_calendar.view", "item.plan.update"];
const user = { ...plannerUser, permissions };
const from = "2026-10-11T12:00:00.000Z"; const to = "2026-10-12T12:00:00.000Z";
const saved: SavedPlannerView = { id: "view", name: "Rotinas planejadas", ownerId: user.id, filters: { from, to, departmentCode: "INPATIENT", responsibleUserId: user.id, priority: "URGENT" }, display: PLANNER_DEFAULT_DISPLAY, active: true, version: 2, createdAt: from, updatedAt: from };
const result: PlannerSearchResult = { type: "HOSPITAL_TASK", id: "task-1", label: "Rotina localizada", departmentCode: "INPATIENT", status: "PENDING", updatedAt: from, deepLink: "/planner/tasks/task-1", patient: "Paciente sintético autorizado" };
const request: RequestListEntry = { id: "request-1", requestCode: "REQ-ONE", priority: "URGENT", createdAt: from, patient: { id: "patient", displayName: "Paciente sintético", externalId: "HIS-TEST", species: "Canino" }, items: [{ id: "item-1", requestId: "request-1", status: "REQUESTED", priority: "URGENT", workflowType: "LABORATORY", departmentCode: "INPATIENT", version: 7, dueAt: to, plannedStartsAt: "2026-10-11T14:00:00.000Z", plannedEndsAt: "2026-10-11T15:00:00.000Z", assignedUserId: user.id, service: { id: "service", code: "TEST", name: "Exame planejado" } }] };
const planned = () => taskView({ title: "Rotina planejada", plannedStartAt: "2026-10-11T13:00:00.000Z", plannedEndAt: "2026-10-11T15:00:00.000Z", priority: "URGENT", responsibleUserId: user.id }, permissions);
function mockApi(override?: (path: string, init?: RequestInit) => unknown) {
  return vi.spyOn(api, "apiFetch").mockImplementation(async <T,>(path: string, init?: RequestInit) => {
    const custom = override?.(path, init); if (custom !== undefined) return await custom as T;
    if (path === "/session/me") return { user } as T;
    if (path.startsWith("/departments")) return [{ id: "dept", code: "INPATIENT", name: "Internação", active: true }] as T;
    if (path.startsWith("/hospital-plans?")) return { items: [hospitalPlan()], total: 1, limit: 50 } as T;
    if (path === "/hospital-plans/plan-1") return hospitalPlan() as T;
    if (path.startsWith("/hospital-shifts?")) return { items: [hospitalShift()], total: 1, limit: 50 } as T;
    if (path === "/planner-views") return [saved, { ...saved, id: "inactive", name: "Visão inativa", active: false }] as T;
    if (path.startsWith("/planner/search?")) return { items: [result], total: 1, limit: 50 } as T;
    if (path.startsWith("/hospital-tasks?")) return { items: [planned()], total: 1, limit: 50 } as T;
    if (init?.method) return taskView({ version: 5 }, permissions) as T;
    throw new Error(`Unexpected find API ${path}`);
  });
}
function mockWork(override?: (path: string) => unknown) {
  return vi.spyOn(api, "apiFetchWithMeta").mockImplementation(async <T,>(path: string) => {
    const custom = override?.(path); if (custom !== undefined) return await custom as api.ApiFetchResult<T>;
    return { data: (path.startsWith("/diagnostic-requests?") ? [request] : []) as T, meta: { correlationId: "synthetic", requestId: "synthetic" } };
  });
}
beforeEach(() => { window.localStorage.clear(); window.history.replaceState(null, "", "/"); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); window.history.replaceState(null, "", "/"); });

describe("authorized planner search", () => {
  it.each([
    { type: "HOSPITAL_DOCUMENT" as const, label: "Documento operacional", grant: "hospital_document.view" as const, deepLink: "/planner/documents/document-1" },
    { type: "HOSPITAL_RESOURCE" as const, label: "Recurso hospitalar", grant: "hospital_resource.view" as const, deepLink: "/admin/resources?resourceId=resource-1" }
  ])("supports a reduced normal group with only search and $grant and opens the native result", async ({ type, label, grant, deepLink }) => {
    const entry: PlannerSearchResult = { type, id: "metadata-1", label: "Metadado autorizado", deepLink, status: "DRAFT", departmentCode: "INPATIENT", updatedAt: from };
    const mock = mockApi(path => path === "/session/me" ? { user: { ...user, permissions: ["search.execute", grant] } } : path.startsWith("/planner/search?") ? { items: [entry], total: 1, limit: 50 } : undefined);
    render(<PlannerSearch />); fireEvent.click(await screen.findByLabelText(label)); fireEvent.change(screen.getByLabelText("Texto, identificação ou paciente"), { target: { value: "metadado" } }); fireEvent.click(screen.getByLabelText("Incluir documentos e atividades arquivados")); fireEvent.submit(screen.getByRole("form", { name: "Pesquisar no planner" }));
    expect(await screen.findByRole("link", { name: entry.label })).toHaveAttribute("href", deepLink);
    const path = mock.mock.calls.find(([value]) => value.startsWith("/planner/search?"))![0]; expect(new URLSearchParams(path.split("?")[1]).get("types")).toBe(type); expect(path).toContain("includeArchived=true");
    fireEvent.click(screen.getByRole("button", { name: "Limpar filtros da busca" })); await waitFor(() => expect(mock.mock.calls.at(-1)?.[0]).toBe("/planner/search?query=metadado&limit=50")); expect(screen.getByLabelText("Incluir documentos e atividades arquivados")).not.toBeChecked();
    expect(mock.mock.calls.some(([value]) => value === "/planner-views")).toBe(false);
  });
  it("combines query, explicit record types, current department, responsibility, period, plan and shift without expanding the returned scope", async () => {
    window.history.replaceState(null, "", "/planner/search?shiftId=shift-1"); const mock = mockApi(); render(<PlannerSearch />); const input = await screen.findByLabelText("Texto, identificação ou paciente"); fireEvent.change(input, { target: { value: " turno " } }); fireEvent.click(screen.getByLabelText("Atividade hospitalar")); fireEvent.click(screen.getByLabelText("Exame diagnóstico")); fireEvent.click(screen.getByLabelText("Exame diagnóstico")); await screen.findByRole("option", { name: "Internação" }); fireEvent.change(screen.getByLabelText("Setor"), { target: { value: "INPATIENT" } }); fireEvent.change(screen.getByLabelText("Responsabilidade"), { target: { value: user.id } }); fireEvent.change(screen.getByLabelText("Prioridade"), { target: { value: "URGENT" } }); fireEvent.change(screen.getByLabelText("Período desde"), { target: { value: "2026-10-11T09:00" } }); fireEvent.change(screen.getByLabelText("Período até"), { target: { value: "2026-10-12T09:00" } }); await screen.findByRole("option", { name: /Plano do atendimento/ }); fireEvent.change(screen.getByRole("combobox", { name: /^Plano assistencial$/ }), { target: { value: "plan-1" } }); await screen.findByRole("option", { name: /Plantão diurno/ }); fireEvent.change(screen.getByLabelText("Plantão da atividade"), { target: { value: "shift-1" } }); fireEvent.submit(screen.getByRole("form", { name: "Pesquisar no planner" }));
    expect(await screen.findByRole("link", { name: result.label })).toHaveAttribute("href", result.deepLink); expect(screen.getByText(result.patient!)).toBeInTheDocument(); const read = mock.mock.calls.find(([path]) => path.startsWith("/planner/search?"))![0]; const query = new URLSearchParams(read.split("?")[1]); expect(Object.fromEntries(query)).toEqual({ departmentCode: "INPATIENT", responsibleUserId: user.id, priority: "URGENT", from, to, planId: "plan-1", query: "turno", shiftId: "shift-1", limit: "50", types: "HOSPITAL_TASK" });
    fireEvent.change(screen.getByLabelText("Setor"), { target: { value: "" } }); fireEvent.change(screen.getByLabelText("Responsabilidade"), { target: { value: "" } }); fireEvent.change(screen.getByLabelText("Prioridade"), { target: { value: "" } }); fireEvent.change(screen.getByLabelText("Período desde"), { target: { value: "" } }); fireEvent.change(screen.getByLabelText("Período até"), { target: { value: "" } }); fireEvent.click(screen.getByRole("button", { name: "Limpar filtros da busca" })); await waitFor(() => expect(mock.mock.calls.at(-1)?.[0]).toBe("/planner/search?query=turno&limit=50")); expect(screen.getByLabelText("Atividade hospitalar")).not.toBeChecked();
  });

  it("does not submit a short query, shows loading and explains a genuinely empty authorized result", async () => {
    let complete: ((value: unknown) => void) | undefined; const mock = mockApi((path) => path.startsWith("/planner/search?") ? new Promise((resolve) => { complete = resolve; }) : undefined); render(<PlannerSearch />); const input = await screen.findByLabelText("Texto, identificação ou paciente"); fireEvent.change(input, { target: { value: "a" } }); fireEvent.submit(screen.getByRole("form", { name: "Pesquisar no planner" })); expect(mock.mock.calls.some(([path]) => path.startsWith("/planner/search?"))).toBe(false); fireEvent.change(input, { target: { value: "sem correspondência" } }); fireEvent.submit(screen.getByRole("form", { name: "Pesquisar no planner" })); await screen.findByText("Buscando registros autorizados"); await act(async () => { complete!({ items: [], total: 0, limit: 50 }); }); await screen.findByText("Nenhum registro com estes critérios"); expect(screen.getByRole("status", { name: /Nenhum registro/ })).toHaveTextContent("Somente registros do seu acesso");
  });

  it("retries a failed search, follows the returned cursor and removes both pages on access revocation", async () => {
    let failure = 503; const mock = mockApi((path) => { if (!path.startsWith("/planner/search?")) return; if (failure) throw new api.ApiClientError(failure, {}); return { items: [{ ...result, id: path.includes("cursor=") ? "second" : "first", label: path.includes("cursor=") ? "Outro registro permitido" : result.label }], total: 2, limit: 50, ...(path.includes("cursor=") ? {} : { nextCursor: "opaque:page2" }) }; }); render(<PlannerSearch />); fireEvent.change(await screen.findByLabelText("Texto, identificação ou paciente"), { target: { value: "rotina" } }); fireEvent.submit(screen.getByRole("form", { name: "Pesquisar no planner" })); await screen.findByText("Resultados indisponíveis"); failure = 0; fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" })); await screen.findByRole("link", { name: result.label }); fireEvent.click(screen.getByRole("button", { name: "Carregar mais resultados" })); await screen.findByRole("link", { name: "Outro registro permitido" }); expect(mock.mock.calls.some(([path]) => path.includes("cursor=opaque%3Apage2"))).toBe(true);
    failure = 404; act(() => window.dispatchEvent(new Event("cvg:realtime-updated"))); await waitFor(() => expect(screen.queryByRole("link", { name: result.label })).not.toBeInTheDocument()); expect(screen.queryByRole("link", { name: "Outro registro permitido" })).not.toBeInTheDocument();
  });

  it("rejects a civil time in a hospital DST gap and preserves the previous valid date filter", async () => {
    vi.stubEnv("NEXT_PUBLIC_HOSPITAL_TIMEZONE", "America/New_York"); mockApi(); render(<PlannerSearch />); await screen.findByLabelText("Período desde"); fireEvent.change(screen.getByLabelText("Período desde"), { target: { value: "2026-03-08T01:30" } }); fireEvent.change(screen.getByLabelText("Período desde"), { target: { value: "2026-03-08T02:30" } }); expect(await screen.findByRole("alert")).toHaveTextContent("Este horário não existe no fuso do hospital"); expect(screen.getByLabelText("Período desde")).toHaveValue("2026-03-08T01:30");
  });

  it("does not carry a previous professional's submitted query or results into a new identity", async () => {
    let identity = user; const mock = mockApi((path) => path === "/session/me" ? { user: identity } : undefined); render(<PlannerSearch />); fireEvent.change(await screen.findByLabelText("Texto, identificação ou paciente"), { target: { value: "rotina" } }); fireEvent.submit(screen.getByRole("form", { name: "Pesquisar no planner" })); await screen.findByRole("link", { name: result.label }); const reads = mock.mock.calls.filter(([path]) => path.startsWith("/planner/search?")).length; identity = { ...user, id: "new-professional", permissions: ["hospital_task.view"] }; act(() => window.dispatchEvent(new Event("cvg:realtime-resync"))); await waitFor(() => expect(screen.queryByRole("link", { name: result.label })).not.toBeInTheDocument()); expect(mock.mock.calls.filter(([path]) => path.startsWith("/planner/search?"))).toHaveLength(reads + 1);
  });

  it.each([{ identityError: true }, { identityError: false }])("fails closed without authorized reads (identity error $identityError)", async ({ identityError }) => {
    const mock = mockApi((path) => { if (path === "/session/me") { if (identityError) throw new api.ApiClientError(401, {}); return { user: { ...user, permissions: [] } }; } }); render(<PlannerSearch />); await screen.findByText(identityError ? "Busca indisponível" : "Busca fora do seu acesso"); expect(mock.mock.calls.some(([path]) => path.startsWith("/planner/search?"))).toBe(false);
  });
});

describe("timeline planning journeys", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(from)); });
  it("keeps hospital tasks visible for a task-only group without calling denied diagnostic endpoints", async () => {
    mockApi((path) => path === "/session/me" ? { user: { ...user, permissions: ["hospital_task.view"] } } : undefined); const work = mockWork(() => { throw new api.ApiClientError(404, { error: { code: "SCOPE_DENIED" } }); }); render(<PlannerTimeline />); await screen.findByRole("link", { name: "Rotina planejada" }); expect(work).not.toHaveBeenCalled(); expect(screen.queryByText("Cronograma indisponível")).not.toBeInTheDocument(); expect(screen.queryByRole("link", { name: "Exame planejado · REQ-ONE" })).not.toBeInTheDocument();
  });
  it("shows diagnostic and hospital planning, private dependencies and each cursor without treating dates as resource reservations", async () => {
    const task = planned(); task.dependencies = [{ id: "known", taskId: task.task.id, targetType: "HOSPITAL_TASK", targetId: "prerequisite", label: "Preparação permitida", restricted: false, satisfied: true, blocks: "START", active: true, version: 1, createdAt: from, updatedAt: from }, { id: "private", restricted: true, satisfied: false, blocks: "COMPLETE" }];
    const mock = mockApi((path, init) => { if (path.startsWith("/hospital-tasks?")) return { items: [path.includes("cursor=") ? taskView({ id: "second", title: "Rotina sem intervalo" }, permissions) : task], total: 2, limit: 50, ...(path.includes("cursor=") ? {} : { nextCursor: "task-page2" }) }; if (path === "/hospital-tasks/task-1" && init?.method) return { ...task, task: { ...task.task, version: 5 } }; });
    const work = mockWork((path) => path.startsWith("/diagnostic-requests?") ? { data: [{ ...request, id: path.includes("cursor=") ? "request-2" : request.id, requestCode: path.includes("cursor=") ? "REQ-TWO" : request.requestCode, items: [{ ...request.items[0], id: path.includes("cursor=") ? "item-2" : "item-1" }] }], meta: { correlationId: "synthetic", requestId: "synthetic", ...(path.includes("cursor=") ? {} : { nextCursor: "exam-page2" }) } } : undefined);
    render(<PlannerTimeline />); await screen.findByRole("link", { name: "Rotina planejada" }); await screen.findByRole("link", { name: "Exame planejado · REQ-ONE" }); expect(screen.getByRole("link", { name: "Consultar reservas de recursos" })).toHaveAttribute("href", "/planner/agenda"); expect(screen.getByText(/Preparação permitida · Satisfeito · bloqueia início/)).toBeInTheDocument(); expect(screen.getByText(/Pré-requisito restrito · Pendente · bloqueia conclusão/)).toBeInTheDocument(); expect(document.body.innerHTML).not.toContain('"private"');
    fireEvent.click(screen.getByText("Editar título e datas")); const form = screen.getByRole("form", { name: "Editar planejamento de HPL-1" }); fireEvent.change(within(form).getByLabelText("Título editável"), { target: { value: "Título revisado" } }); fireEvent.submit(form); await waitFor(() => expect(mock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true)); const write = mock.mock.calls.find(([, init]) => init?.method === "PATCH")!; expect(JSON.parse(write[1]!.body as string)).toMatchObject({ title: "Título revisado", expectedVersion: 4 });
    fireEvent.submit(screen.getByRole("form", { name: "Planejar exame" })); await waitFor(() => expect(mock.mock.calls.some(([path]) => path === "/diagnostic-items/item-1/planning")).toBe(true)); fireEvent.click(screen.getByRole("button", { name: "Mais atividades no cronograma" })); await screen.findByRole("link", { name: "Rotina sem intervalo" }); expect(screen.getByText("Sem intervalo planejado")).toBeInTheDocument(); fireEvent.click(screen.getByRole("button", { name: "Mais exames para o cronograma" })); await screen.findByRole("link", { name: "Exame planejado · REQ-TWO" }); expect(work.mock.calls.some(([path]) => path.includes("cursor=exam-page2"))).toBe(true); expect(mock.mock.calls.some(([path, init]) => init?.method && /schedules|reservations|commands/.test(path))).toBe(false);
  });

  it("validates the civil period, applies a saved view and clears explicit filters without offering inactive views", async () => {
    const mock = mockApi(); mockWork(); render(<PlannerTimeline />); await screen.findByRole("link", { name: "Rotina planejada" }); fireEvent.change(screen.getByLabelText("Período de"), { target: { value: "2026-10-12T09:00" } }); fireEvent.change(screen.getByLabelText("Período até"), { target: { value: "2026-10-11T09:00" } }); fireEvent.submit(screen.getByRole("form", { name: "Filtrar cronograma" })); expect(await screen.findByRole("alert")).toHaveTextContent("O fim deve ser posterior ao início.");
    fireEvent.change(screen.getByLabelText("Período de"), { target: { value: "2026-10-11T09:00" } }); fireEvent.change(screen.getByLabelText("Período até"), { target: { value: "2026-10-12T09:00" } }); fireEvent.submit(screen.getByRole("form", { name: "Filtrar cronograma" })); await waitFor(() => expect(mock.mock.calls.some(([path]) => path.includes("to=2026-10-12T12%3A00%3A00.000Z"))).toBe(true)); await screen.findByRole("option", { name: "Rotinas planejadas" }); expect(screen.queryByRole("option", { name: "Visão inativa" })).not.toBeInTheDocument(); fireEvent.change(screen.getByLabelText("Aplicar filtros de visão salva"), { target: { value: "view" } }); await waitFor(() => expect(mock.mock.calls.some(([path]) => path.includes("responsibleUserId=professional-b") && path.includes("priority=URGENT"))).toBe(true));
    await screen.findByRole("option", { name: /Plano do atendimento/ }); fireEvent.change(screen.getByRole("combobox", { name: /^Plano assistencial$/ }), { target: { value: "plan-1" } }); await waitFor(() => expect(screen.queryByRole("link", { name: "Exame planejado · REQ-ONE" })).not.toBeInTheDocument()); fireEvent.click(screen.getByRole("button", { name: "Limpar filtros de visão salva" })); await screen.findByRole("link", { name: "Exame planejado · REQ-ONE" });
  });

  it("freezes cached editing during a partial timeline read and retries all sources", async () => {
    let fail = false; const mock = mockApi((path) => { if (path.startsWith("/hospital-tasks?") && fail) throw new api.ApiClientError(503, {}); }); const work = mockWork(); render(<PlannerTimeline />); await screen.findByRole("link", { name: "Rotina planejada" }); fail = true; act(() => window.dispatchEvent(new Event("cvg:realtime-updated"))); await screen.findByText("Leitura parcial"); expect(screen.queryByLabelText("Título editável")).not.toBeInTheDocument(); const before = work.mock.calls.length; fail = false; fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" })); await waitFor(() => expect(screen.queryByText("Leitura parcial")).not.toBeInTheDocument()); expect(work.mock.calls.length).toBeGreaterThan(before); expect(mock.mock.calls.filter(([path]) => path === "/planner-views").length).toBeGreaterThan(1);
  });

  it("distinguishes an empty authorized timeline from an identity failure or denied profile", async () => {
    let identityError = false; let denied = false; mockApi((path) => { if (path === "/session/me") { if (identityError) throw new api.ApiClientError(401, {}); if (denied) return { user: { ...user, permissions: [] } }; } if (path.startsWith("/hospital-tasks?")) return { items: [], total: 0, limit: 50 }; }); mockWork(() => ({ data: [], meta: { correlationId: "synthetic", requestId: "synthetic" } })); const view = render(<PlannerTimeline />); await screen.findByText("Nenhum intervalo autorizado nesta seleção."); identityError = true; act(() => window.dispatchEvent(new Event("cvg:realtime-resync"))); await screen.findByText("Cronograma indisponível"); view.unmount(); identityError = false; denied = true; render(<PlannerTimeline />); await screen.findByText("Cronograma fora do seu acesso");
  });

  it("clamps planned bars to the window and rejects invalid dates rather than inventing a duration", () => {
    const clipped = timelineBar("2026-10-11T11:00:00Z", "2026-10-11T13:00:00Z", { from, to })!; expect(clipped.left).toBe("0%"); expect(parseFloat(clipped.width)).toBeCloseTo(100 / 24); expect(timelineBar("invalid", undefined, { from, to })).toBeUndefined(); expect(timelineBar(from, from, { from, to: from })).toBeUndefined(); expect(timelineBar(from, undefined, { from, to })).toEqual({ left: "0%", width: "0.5%" });
  });
});
