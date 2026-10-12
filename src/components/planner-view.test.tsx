/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PlannerView } from "./planner-view";
import { PlannerCalendar } from "./planner-calendar";
import { ApiClientError, apiFetch } from "./api-client";
import { queuePreferenceKey } from "./use-queue-preferences";
import { PLANNER_DEFAULT_DISPLAY } from "./planner-model";
import { hospitalPlan } from "./hospital-ui.test-helpers";
import { plannerUser, routineType, careType, taskView } from "./planner.test-helpers";

vi.mock("next/link", () => ({ default: ({ children, ...props }: { children: React.ReactNode; href: string }) => <a {...props}>{children}</a> }));
vi.mock("./api-client", async (original) => ({ ...await original<typeof import("./api-client")>(), apiFetch: vi.fn() }));
function mockRead() {
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === "/session/me") return { user: plannerUser } as never;
    if (path === "/hospital-task-types") return [routineType, careType] as never;
    if (path === "/hospital-tasks/options") return { departments: [{ code: "INPATIENT", name: "Internação" }], types: [routineType, careType], assignees: [] } as never;
    if (path === "/planner-views" || path.startsWith("/departments") || path === "/patients") return [] as never;
    if (path.startsWith("/hospital-tasks?") && init?.method === undefined) return { items: [taskView()], total: 1, limit: 50 } as never;
    if (path === "/hospital-tasks" && init?.method === "POST") return taskView({ id: "created-task", taskCode: "HPL-2", title: JSON.parse(init.body as string).title }) as never;
    throw new Error(`Unexpected synthetic API ${path}`);
  });
}
beforeEach(() => { window.localStorage.clear(); mockRead(); });
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs(); });

it("shows another author's routine work without an implicit requester or primary-sector filter", async () => {
  render(<PlannerView />);
  expect(await screen.findByRole("link", { name: "Conferir materiais" })).toHaveAttribute("href", "/planner/tasks/task-1");
  const listRead = vi.mocked(apiFetch).mock.calls.find(([path]) => path.startsWith("/hospital-tasks?"))![0];
  expect(listRead).not.toContain("author"); expect(listRead).not.toContain("responsibleUserId"); expect(listRead).not.toContain("departmentCode");
  expect(screen.getByText("Mostrando 1 de 1 atividades autorizadas.")).toBeInTheDocument();
  fireEvent.change(screen.getByRole("combobox", { name: "Responsável" }), { target: { value: plannerUser.id } });
  await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path.includes(`responsibleUserId=${plannerUser.id}`))).toBe(true));
});

it("confirms creation with the returned task link and explains an incompatible explicit filter", async () => {
  window.localStorage.setItem(queuePreferenceKey(plannerUser.id, "/planner:filters"), JSON.stringify({ version: 2, userId: plannerUser.id, view: "/planner:filters", value: { phase: "COMPLETED" } }));
  render(<PlannerView />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Nova atividade" })).toBeEnabled()); fireEvent.click(screen.getByRole("button", { name: "Nova atividade" }));
  const dialog = await screen.findByRole("dialog", { name: "Nova atividade hospitalar" });
  fireEvent.change(within(dialog).getByLabelText("Título da atividade"), { target: { value: "Conferir armário" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Criar atividade" }));
  expect(await screen.findByRole("link", { name: "Abrir Conferir armário" })).toHaveAttribute("href", "/planner/tasks/created-task");
  expect(screen.getByText(/Os filtros atuais ocultam esta atividade/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Limpar filtros para ver a atividade" }));
  expect(screen.getByLabelText("Fase")).toHaveValue("");
  const call = vi.mocked(apiFetch).mock.calls.find(([path, init]) => path === "/hospital-tasks" && init?.method === "POST")!;
  expect(call[1]?.headers).toEqual({ "idempotency-key": expect.any(String) });
  expect(JSON.parse(call[1]?.body as string)).toEqual({ title: "Conferir armário", typeId: routineType.id, departmentCode: "INPATIENT", priority: "ROUTINE" });
});

it("keeps one batch panel and a working creation form after the search filter rerenders the planner", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    render(<PlannerView />);
    await screen.findByRole("link", { name: "Conferir materiais" });
    fireEvent.change(screen.getByLabelText("Buscar atividade"), { target: { value: "filtro sem correspondência" } });
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path.includes("query=filtro+sem+correspond%C3%AAncia"))).toBe(true));
    expect(screen.getAllByText("Operar atividades em lote")).toHaveLength(1);
    expect(screen.getAllByText("Visões salvas")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Nova atividade" }));
    const dialog = await screen.findByRole("dialog", { name: "Nova atividade hospitalar" });
    fireEvent.change(within(dialog).getByLabelText("Título da atividade"), { target: { value: "Rotina após o filtro" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Criar atividade" }));
    expect(await screen.findByRole("link", { name: "Abrir Rotina após o filtro" })).toHaveAttribute("href", "/planner/tasks/created-task");
    expect(screen.getByText(/Os filtros atuais ocultam esta atividade/)).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Nova atividade hospitalar" })).not.toBeInTheDocument();
    expect(screen.getAllByText("Operar atividades em lote")).toHaveLength(1);
    expect(errors.mock.calls.filter((args) => args.some((value) => typeof value === "string" && value.includes("same key")))).toHaveLength(0);
  } finally { errors.mockRestore(); }
});

it("refuses a care task without a real patient and encounter rather than creating a diagnostic substitute", async () => {
  render(<PlannerView />); await waitFor(() => expect(screen.getByRole("button", { name: "Nova atividade" })).toBeEnabled()); fireEvent.click(screen.getByRole("button", { name: "Nova atividade" }));
  fireEvent.change(screen.getByLabelText("Tipo de atividade"), { target: { value: careType.id } });
  fireEvent.change(screen.getByLabelText("Título da atividade"), { target: { value: "Acompanhar paciente" } });
  fireEvent.submit(screen.getByRole("form", { name: "Criar atividade hospitalar" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("exige paciente e atendimento aberto");
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
});

it("continues the server cursor and removes confirmed data if scope is revoked on refresh", async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!; let denied = false;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path.startsWith("/hospital-tasks?")) {
      if (denied) throw new ApiClientError(404, { error: { code: "SCOPE_DENIED" } });
      return path.includes("cursor=") ? { items: [taskView({ id: "task-2", title: "Conferir estoque" })], total: 2, limit: 50 } as never : { items: [taskView()], total: 2, limit: 50, nextCursor: "opaque:page2" } as never;
    }
    return original(path, init);
  });
  render(<PlannerView />); fireEvent.click(await screen.findByRole("button", { name: "Carregar mais atividades" }));
  expect(await screen.findByRole("link", { name: "Conferir estoque" })).toBeInTheDocument();
  expect(screen.getByText("Mostrando 2 de 2 atividades autorizadas.")).toBeInTheDocument();
  denied = true; act(() => window.dispatchEvent(new Event("cvg:realtime-updated")));
  await waitFor(() => expect(screen.queryByRole("link", { name: "Conferir materiais" })).not.toBeInTheDocument());
  expect(screen.queryByRole("link", { name: "Conferir estoque" })).not.toBeInTheDocument();
});

it("uses genuine table and board surfaces and keeps properties under the current identity", async () => {
  render(<PlannerView />); await screen.findByRole("link", { name: "Conferir materiais" });
  fireEvent.click(screen.getByText("Apresentação"));
  fireEvent.change(screen.getByLabelText("Visão"), { target: { value: "TABLE" } });
  expect(screen.getByRole("table", { name: "Atividades hospitalares autorizadas" })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Visão"), { target: { value: "BOARD" } });
  expect(screen.getByRole("region", { name: "Pendente" })).toHaveTextContent("Conferir materiais");
  const record = JSON.parse(window.localStorage.getItem(queuePreferenceKey(plannerUser.id, "/planner:display"))!);
  expect(record.userId).toBe(plannerUser.id); expect(record.value.layout).toBe("BOARD");
});

it("places midnight-boundary starts on the hospital civil date and exposes unplanned tasks separately", () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-11T12:00:00Z")); vi.stubEnv("NEXT_PUBLIC_HOSPITAL_TIMEZONE", "America/Sao_Paulo"); vi.stubEnv("TZ", "Asia/Tokyo");
  render(<PlannerCalendar items={[taskView({ plannedStartAt: "2026-10-12T01:00:00Z" }), taskView({ id: "unplanned", title: "Sem previsão" })]} />);
  expect(within(screen.getByRole("gridcell", { name: "11/10/2026: 1 atividades" })).getByRole("link", { name: "Conferir materiais" })).toBeInTheDocument();
  expect(within(screen.getByRole("region", { name: "Atividades sem data planejada" })).getByRole("link", { name: "Sem previsão" })).toBeInTheDocument();
  expect(screen.getAllByRole("row")).toHaveLength(7);
  fireEvent.click(screen.getByRole("button", { name: "Mês anterior" }));
  expect(screen.getByRole("gridcell", { name: "11/10/2026: 1 atividades" })).toHaveClass("is-outside");
  expect(screen.getByRole("gridcell", { name: "01/09/2026: 0 atividades" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Mês seguinte" }));
  expect(screen.getByRole("gridcell", { name: "11/10/2026: 1 atividades" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Mês seguinte" }));
  expect(screen.getByRole("gridcell", { name: "01/11/2026: 0 atividades" })).toBeInTheDocument();
});

it("sends the explicit operational filters and presentation ordering, then clears them without storing returned patient rows", async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === "/session/me") return { user: { ...plannerUser, permissions: [...plannerUser.permissions!, "plan.view"] } } as never;
    if (path.startsWith("/departments")) return [{ id: "registered", code: "INPATIENT", name: "Internação", active: true }] as never;
    if (path.startsWith("/hospital-plans?")) return { items: [hospitalPlan()], total: 1, limit: 50 } as never;
    return original(path, init);
  });
  render(<PlannerView />); await screen.findByRole("link", { name: "Conferir materiais" });
  fireEvent.click(screen.getByLabelText("Incluir arquivadas")); fireEvent.click(screen.getByLabelText("Incluir rascunhos autorizados")); fireEvent.change(screen.getByLabelText("Etiqueta exata"), { target: { value: "  turno  " } });
  fireEvent.change(screen.getByRole("combobox", { name: /^Setor$/ }), { target: { value: "INPATIENT" } }); fireEvent.change(screen.getByRole("combobox", { name: /^Responsável$/ }), { target: { value: plannerUser.id } }); fireEvent.change(screen.getByRole("combobox", { name: /^Tipo$/ }), { target: { value: routineType.id } }); fireEvent.change(screen.getByRole("combobox", { name: /^Fase$/ }), { target: { value: "PENDING" } }); fireEvent.change(screen.getByRole("combobox", { name: /^Prioridade$/ }), { target: { value: "URGENT" } });
  fireEvent.change(screen.getByLabelText("Período desde"), { target: { value: "2026-10-11T09:00" } }); fireEvent.change(screen.getByLabelText("Período até"), { target: { value: "2026-10-12T09:00" } }); await screen.findByRole("option", { name: /Plano do atendimento/ }); fireEvent.change(screen.getByLabelText("Plano assistencial"), { target: { value: "plan-1" } });
  fireEvent.click(screen.getByText("Apresentação")); fireEvent.change(screen.getByLabelText("Agrupar por"), { target: { value: "RESPONSIBLE" } }); fireEvent.change(screen.getByLabelText("Ordenar por"), { target: { value: "PRIORITY" } }); fireEvent.change(screen.getByLabelText("Direção"), { target: { value: "ASC" } });
  const columns = screen.getByRole("group", { name: "Colunas visíveis" }); fireEvent.click(within(columns).getByLabelText("Fim planejado")); fireEvent.click(within(columns).getByLabelText("Fim planejado"));
  await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path.includes("includeArchived=true") && path.includes("includeDrafts=true") && path.includes("planId=plan-1") && path.endsWith("orderBy=PRIORITY&direction=ASC"))).toBe(true));
  const record = JSON.parse(window.localStorage.getItem(queuePreferenceKey(plannerUser.id, "/planner:display"))!); expect(record.value).toMatchObject({ groupBy: "RESPONSIBLE", orderBy: "PRIORITY", direction: "ASC" }); expect(record).not.toHaveProperty("items");
  fireEvent.click(screen.getByRole("button", { name: /^Limpar filtros$/ })); await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path === "/hospital-tasks?limit=50&orderBy=PRIORITY&direction=ASC")).toBe(true)); expect(screen.getByLabelText("Etiqueta exata")).toHaveValue(""); expect(screen.getByLabelText("Incluir rascunhos autorizados")).not.toBeChecked();
});

it("applies a saved configuration including an unavailable responsible without attributing their identity to returned rows", async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => path === "/planner-views" ? [{ id: "saved", name: "Configuração do plantão", ownerId: "other", active: true, version: 3, filters: { responsibleUserId: "outside-options", phase: "PENDING" }, display: { ...PLANNER_DEFAULT_DISPLAY, layout: "TABLE", groupBy: "TYPE", direction: "ASC" }, createdAt: "2026-10-11T12:00:00Z", updatedAt: "2026-10-11T12:00:00Z" }] as never : original(path, init));
  render(<PlannerView />); fireEvent.click(await screen.findByRole("button", { name: "Configuração do plantão" })); await screen.findByRole("table", { name: "Atividades hospitalares autorizadas" }); expect(screen.getByRole("combobox", { name: /^Responsável$/ })).toHaveValue("outside-options"); expect(screen.getByRole("option", { name: "Responsável configurado na visão" })).toBeInTheDocument(); expect(screen.getByLabelText("Agrupar por")).toHaveValue("TYPE");
  await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path.includes("responsibleUserId=outside-options") && path.includes("direction=ASC"))).toBe(true));
});

it("confirms a private draft separately and makes it visible only after the user explicitly includes drafts", async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!; vi.mocked(apiFetch).mockImplementation(async (path, init) => path === "/hospital-task-drafts" ? taskView({ id: "private-draft", taskCode: "DRAFT-ONE", title: "Organização privada", isDraft: true }) as never : original(path, init));
  render(<PlannerView />); await waitFor(() => expect(screen.getByRole("button", { name: "Nova atividade" })).toBeEnabled()); fireEvent.click(screen.getByRole("button", { name: "Nova atividade" })); fireEvent.change(screen.getByLabelText("Título da atividade"), { target: { value: "Organização privada" } }); fireEvent.click(screen.getByRole("button", { name: "Salvar como rascunho privado" })); await screen.findByRole("link", { name: "Abrir Organização privada" }); expect(screen.getByText(/Rascunho privado DRAFT-ONE criada/)).toHaveTextContent("Os filtros atuais ocultam"); fireEvent.click(screen.getByRole("button", { name: "Limpar filtros para ver a atividade" })); expect(screen.getByLabelText("Incluir rascunhos autorizados")).toBeChecked(); expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path === "/hospital-tasks" )).toBe(false);
});

it("closes creation without sending a task and reports the type directory failure as an unavailable creation choice", async () => {
  render(<PlannerView />); await waitFor(() => expect(screen.getByRole("button", { name: "Nova atividade" })).toBeEnabled()); fireEvent.click(screen.getByRole("button", { name: "Nova atividade" })); fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancelar" })); expect(screen.queryByRole("dialog")).not.toBeInTheDocument(); expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method)).toBe(false);
  cleanup(); const original = vi.mocked(apiFetch).getMockImplementation()!; vi.mocked(apiFetch).mockImplementation(async (path, init) => { if (path === "/hospital-task-types") throw new Error("private type storage"); return original(path, init); }); render(<PlannerView />); expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível consultar os tipos de atividade."); expect(screen.getByRole("button", { name: "Nova atividade" })).toBeDisabled();
});

it("keeps table edits versioned and refreshes the authorized list after the per-item batch response", async () => {
  let current = taskView(); const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => { if (path.startsWith("/hospital-tasks?")) return { items: [current], total: 1, limit: 50 } as never; if (path === "/hospital-tasks/task-1" && init?.method) { current = taskView({ title: JSON.parse(init.body as string).title, version: 5 }); return current as never; } if (path === "/hospital-tasks/batch") return { items: [{ taskId: "task-1", ok: true }], successCount: 1, failureCount: 0 } as never; return original(path, init); });
  render(<PlannerView />); await screen.findByRole("link", { name: "Conferir materiais" }); fireEvent.click(screen.getByText("Apresentação")); fireEvent.change(screen.getByLabelText("Visão"), { target: { value: "TABLE" } }); fireEvent.click(screen.getByText("Editar título e datas")); fireEvent.change(screen.getByLabelText("Título editável"), { target: { value: "Conferência revisada" } }); fireEvent.submit(screen.getByRole("form", { name: "Editar planejamento de HPL-1" })); await screen.findByRole("link", { name: "Conferência revisada" }); expect(JSON.parse(vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === "PATCH")![1]!.body as string).expectedVersion).toBe(4);
  fireEvent.click(screen.getByText("Operar atividades em lote")); fireEvent.change(screen.getByLabelText("Ação do lote"), { target: { value: "ASSIGN" } }); fireEvent.click(screen.getByLabelText(/HPL-1 · Conferência revisada/)); fireEvent.change(screen.getByLabelText("Responsável elegível para todas"), { target: { value: plannerUser.id } }); fireEvent.click(screen.getByLabelText(/Confirmo a ação/)); fireEvent.click(screen.getByRole("button", { name: "Aplicar lote confirmado" })); await screen.findByText("1 confirmadas · 0 com falha."); const batch = vi.mocked(apiFetch).mock.calls.find(([path]) => path === "/hospital-tasks/batch")!; expect(JSON.parse(batch[1]!.body as string).operations).toEqual([{ taskId: "task-1", expectedVersion: 5, action: "ASSIGN", responsibleUserId: plannerUser.id }]);
});

it("preserves rows but disables editing after a transient page failure and retries its current explicit filters", async () => {
  let failed = false; const original = vi.mocked(apiFetch).getMockImplementation()!; vi.mocked(apiFetch).mockImplementation(async (path, init) => { if (failed && path.startsWith("/hospital-tasks?")) throw new ApiClientError(503, {}); return original(path, init); }); render(<PlannerView />); await screen.findByRole("link", { name: "Conferir materiais" }); failed = true; act(() => window.dispatchEvent(new Event("cvg:realtime-updated"))); await screen.findByText("Leitura parcial"); expect(screen.getByRole("link", { name: "Conferir materiais" })).toBeInTheDocument(); failed = false; fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" })); await waitFor(() => expect(screen.queryByText("Leitura parcial")).not.toBeInTheDocument());
});

it("rejects a hospital DST gap in date filters and never turns it into another UTC time", async () => {
  vi.stubEnv("NEXT_PUBLIC_HOSPITAL_TIMEZONE", "America/New_York"); render(<PlannerView />); await screen.findByRole("link", { name: "Conferir materiais" }); fireEvent.change(screen.getByLabelText("Período desde"), { target: { value: "2026-03-08T02:30" } }); expect(await screen.findByRole("alert")).toHaveTextContent("Este horário não existe no fuso do hospital"); expect(screen.getByLabelText("Período desde")).toHaveValue(""); fireEvent.change(screen.getByLabelText("Período até"), { target: { value: "2026-03-08T03:30" } }); await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument()); fireEvent.change(screen.getByLabelText("Período até"), { target: { value: "" } }); expect(screen.getByLabelText("Período até")).toHaveValue("");
});
