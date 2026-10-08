/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueueItem, SessionUser } from "@cvg/contracts";
import { apiFetch, apiFetchWithMeta } from "@/components/api-client";
import type { RequestListEntry } from "./model";
import { WorkItemsView } from "./work-items-view";

vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) => <a {...props}>{children}</a>
}));

const navigation = { params: new URLSearchParams() };
const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() };
vi.mock("next/navigation", () => ({ useSearchParams: () => navigation.params, useRouter: () => router }));
vi.mock("@/components/api-client", async (importOriginal) => ({ ...await importOriginal<typeof import("@/components/api-client")>(), apiFetch: vi.fn(), apiFetchWithMeta: vi.fn() }));

const lab: SessionUser = { id: "user-lab", email: "lab@cvg.local", displayName: "Joana Lima", role: "LAB_TECH", departmentCode: "LABORATORY", timezone: "UTC" };
const vet: SessionUser = { id: "user-vet", email: "vet@cvg.local", displayName: "Dra. Marina", role: "VETERINARIAN", departmentCode: "INPATIENT", timezone: "UTC" };
const future = new Date(Date.now() + 6 * 3600_000).toISOString();
const past = new Date(Date.now() - 3600_000).toISOString();

const requests: RequestListEntry[] = [
  {
    id: "request-1", requestCode: "EX-261006-0001", priority: "EMERGENCY", createdAt: "2026-10-06T10:00:00.000Z", requesterId: "user-vet",
    patient: { id: "patient-thor", displayName: "Thor", species: "Canino", externalId: "HIS-THOR" },
    items: [
      { id: "item-hem", requestId: "request-1", status: "RECEIVED", priority: "EMERGENCY", workflowType: "LABORATORY", departmentCode: "LABORATORY", version: 2, dueAt: past, currentSampleId: "sample-1", service: { id: "s-hem", code: "HEMOGRAM", name: "Hemograma" } },
      { id: "item-rx", requestId: "request-1", status: "AWAITING_REPORT", priority: "EMERGENCY", workflowType: "RADIOLOGY", departmentCode: "RADIOLOGY", version: 3, dueAt: future, service: { id: "s-rx", code: "XRAY", name: "RX de tórax" } }
    ]
  },
  {
    id: "request-2", requestCode: "EX-261006-0002", priority: "ROUTINE", createdAt: "2026-10-06T11:00:00.000Z", requesterId: "user-other",
    patient: { id: "patient-mel", displayName: "Mel", species: "Felino", externalId: "HIS-MEL" },
    items: [{ id: "item-crp", requestId: "request-2", status: "REQUESTED", priority: "ROUTINE", workflowType: "LABORATORY", departmentCode: "LABORATORY", version: 1, dueAt: future, service: { id: "s-crp", code: "CRP", name: "Proteína C reativa" } }]
  }
];

const queueItem = {
  id: "item-hem", requestId: "request-1", status: "RECEIVED", workflowType: "LABORATORY", priority: "EMERGENCY", version: 2, dueAt: past, createdAt: "2026-10-06T10:00:00.000Z",
  requestCode: "EX-261006-0001", nextAction: "Iniciar processamento", overdue: true, currentSampleId: "sample-1",
  patient: { id: "patient-thor", displayName: "Thor", species: "Canino", externalId: "HIS-THOR" }, service: { id: "s-hem", code: "HEMOGRAM", name: "Hemograma" },
  operationalContext: { currentOwner: { code: "DEPARTMENT", label: "Laboratório" }, nextAction: { code: "START_PROCESSING", label: "Iniciar processamento" }, blockedBy: { code: "WAITING", label: "Aguardando bancada" }, waitingSince: "2026-10-06T10:00:00.000Z", expectedBy: past, escalationLevel: "URGENT" }
} as unknown as QueueItem;

function mockApi(user: SessionUser, options: { requests?: RequestListEntry[]; fail?: boolean } = {}) {
  vi.mocked(apiFetch).mockImplementation(async (path: string) => {
    if (path === "/session/me") return { user } as never;
    if (path.startsWith("/timeline")) return [{ id: "event-1", eventType: "SampleReceived", newState: "RECEIVED", occurredAt: "2026-10-06T10:30:00.000Z" }] as never;
    if (path.includes("/start-processing")) return {} as never;
    return [] as never;
  });
  vi.mocked(apiFetchWithMeta).mockImplementation(async (path: string) => {
    if (options.fail && path.startsWith("/diagnostic-requests")) throw new Error("boom");
    if (path.startsWith("/diagnostic-requests")) return { data: options.requests ?? requests, meta: {} } as never;
    if (path.startsWith("/queues/LABORATORY/items")) return { data: [queueItem], meta: {} } as never;
    return { data: [], meta: {} } as never;
  });
}

async function renderView() {
  render(<WorkItemsView />);
  await screen.findByRole("button", { name: "Abrir Hemograma — Thor" });
}

describe("WorkItemsView", () => {
  beforeEach(() => {
    navigation.params = new URLSearchParams();
    window.localStorage.clear();
    mockApi(lab);
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); window.history.replaceState(null, "", "/"); });

  it("lists scoped exams grouped by state with Plane properties and a count", async () => {
    await renderView();
    expect(screen.getByRole("navigation", { name: "Você está em" })).toHaveTextContent("Todos os exames");
    expect(screen.getByText("3 itens")).toBeInTheDocument();
    expect(screen.getByRole("listitem", { name: "Amostra recebida: 1 exames" })).toBeInTheDocument();
    expect(screen.getByText("LAB-0001")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Estado: Amostra recebida. Mudar estado" })).toBeEnabled();
    expect(screen.getAllByText(/Atrasado/).length).toBeGreaterThan(0);
    expect(vi.mocked(apiFetchWithMeta)).toHaveBeenCalledWith("/queues/LABORATORY/items?limit=100");
  });

  it("marks preserved exams as stale after a refresh failure and retries", async () => {
    await renderView();
    mockApi(lab, { fail: true });
    fireEvent.click(screen.getByRole("button", { name: /^Atualizar$/ }));
    expect(await screen.findByRole("status", { name: "Dados desatualizados" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Abrir Hemograma — Thor" })).toBeInTheDocument();
    mockApi(lab);
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    await waitFor(() => expect(screen.queryByRole("status", { name: "Dados desatualizados" })).not.toBeInTheDocument());
  });

  it("discards invalid persisted display fields", async () => {
    window.localStorage.setItem("cvg.work-items.display.v1", JSON.stringify({ layout: "obsolete", groupBy: null, orderBy: "other", properties: [null, "state", "unknown"], showEmptyGroups: "false" }));
    await renderView();
    expect(screen.getByRole("radio", { name: "Lista" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("listitem", { name: "Amostra recebida: 1 exames" })).toBeInTheDocument();
  });

  it("keeps empty board destinations for allowed sample and recollection transitions", async () => {
    await renderView();
    fireEvent.click(screen.getByRole("radio", { name: "Quadro" }));
    expect(screen.getByRole("region", { name: "Recoleta necessária" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Buscar paciente ou exame" }), { target: { value: "Mel" } });
    expect(screen.getByRole("region", { name: "Amostra recebida" })).toBeInTheDocument();
  });

  it("navigates the state menu with arrows and restores its trigger on Escape", async () => {
    await renderView();
    const trigger = screen.getByRole("button", { name: "Estado: Amostra recebida. Mudar estado" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const entries = screen.getAllByRole("menuitem");
    expect(entries[0]).toHaveFocus();
    fireEvent.keyDown(entries[0], { key: "End" });
    expect(entries.at(-1)).toHaveFocus();
    fireEvent.keyDown(entries.at(-1)!, { key: "Escape" });
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("switches between list, board, calendar and spreadsheet and remembers the layout", async () => {
    await renderView();
    fireEvent.click(screen.getByRole("radio", { name: "Quadro" }));
    expect(screen.getByLabelText("Quadro de exames")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Em execução" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Recolher Em execução" }));
    expect(screen.getByRole("button", { name: "Expandir Em execução" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Calendário" }));
    expect(screen.getByRole("grid")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Próximo período" }));
    fireEvent.click(screen.getByRole("button", { name: "Semana" }));
    fireEvent.click(screen.getByRole("button", { name: "Período anterior" }));
    fireEvent.click(screen.getByRole("button", { name: "Hoje" }));
    fireEvent.click(screen.getByRole("radio", { name: "Planilha" }));
    const table = screen.getByRole("table");
    fireEvent.click(within(table).getByRole("button", { name: "Paciente" }));
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent("Mel");
    fireEvent.click(within(table).getByRole("button", { name: "Paciente" }));
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent("Thor");
    expect(JSON.parse(window.localStorage.getItem("cvg.work-items.display.v1") ?? "{}")).toMatchObject({ layout: "spreadsheet" });
  });

  it("filters with Plane chips, searches and clears", async () => {
    await renderView();
    fireEvent.click(screen.getByRole("button", { name: "Filtros" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Emergência" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Somente atrasados" }));
    expect(screen.getByRole("button", { name: "Remover filtro Emergência" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Abrir Proteína C reativa — Mel" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Abrir RX de tórax — Thor" })).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Limpar filtros" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Buscar paciente ou exame" }), { target: { value: "zzz" } });
    expect(screen.getByText("Nenhum exame com estes filtros")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Limpar busca" }));
    expect(screen.getByRole("button", { name: "Abrir Proteína C reativa — Mel" })).toBeInTheDocument();
  });

  it("regroups and hides properties from the display menu", async () => {
    await renderView();
    fireEvent.click(screen.getByRole("button", { name: "Exibição" }));
    // "Prioridade" exists under both "Agrupar por" and "Ordenar por"; grouping comes first.
    fireEvent.click(screen.getAllByRole("radio", { name: "Prioridade" })[0]);
    expect(screen.getByRole("listitem", { name: "Emergência: 2 exames" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "ID" }));
    expect(screen.queryByText("LAB-0001")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Nenhum" }));
    expect(screen.getByRole("listitem", { name: "Todos os exames: 3 exames" })).toBeInTheDocument();
  });

  it("opens the side peek with properties, actions and activity", async () => {
    await renderView();
    fireEvent.click(screen.getByRole("button", { name: "Abrir Hemograma — Thor" }));
    const peek = screen.getByRole("dialog", { name: "Hemograma" });
    expect(within(peek).getByText("Bloqueado:")).toBeInTheDocument();
    expect(within(peek).getByText("Prazo vencido.")).toBeInTheDocument();
    expect(within(peek).getByText("Urgente")).toBeInTheDocument();
    expect(await within(peek).findByText("Amostra recebida", { selector: "strong" })).toBeInTheDocument();
    expect(within(peek).getByRole("link", { name: "EX-261006-0001" })).toHaveAttribute("href", "/requests/request-1#item-hem");
    fireEvent.click(within(peek).getByRole("button", { name: "Rejeitar" }));
    expect(within(peek).getByRole("form", { name: "Rejeitar exame" })).toBeInTheDocument();
    fireEvent.click(within(peek).getByRole("button", { name: "Fechar contexto" }));
    expect(screen.queryByRole("dialog", { name: "Hemograma" })).not.toBeInTheDocument();
  });

  it("moves an exam through an allowed transition and confirms with a toast", async () => {
    await renderView();
    fireEvent.click(screen.getByRole("button", { name: "Estado: Amostra recebida. Mudar estado" }));
    const menu = screen.getByRole("menu", { name: "Mover Hemograma de Thor" });
    expect(within(menu).queryByRole("menuitem", { name: "Concluído" })).not.toBeInTheDocument();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Em execução" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/diagnostic-items/item-hem/start-processing", expect.objectContaining({ method: "POST", body: JSON.stringify({ expectedVersion: 2 }) })));
    expect(await screen.findByText("Iniciar processamento", { selector: "strong" })).toBeInTheDocument();
  });

  it("routes transitions that need clinical data to the peek form", async () => {
    await renderView();
    fireEvent.click(screen.getByRole("button", { name: "Estado: Amostra recebida. Mudar estado" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Recoleta necessária" }));
    expect(await screen.findByRole("form", { name: "Solicitar recoleta" })).toBeInTheDocument();
    expect(apiFetch).not.toHaveBeenCalledWith(expect.stringContaining("/request-recollection"), expect.anything());
  });

  it("reports a failed move and restores the previous state", async () => {
    await renderView();
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      if (path === "/session/me") return { user: lab } as never;
      if (path.includes("/start-processing")) throw new Error("conflict");
      return [] as never;
    });
    fireEvent.click(screen.getByRole("button", { name: "Estado: Amostra recebida. Mudar estado" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Em execução" }));
    expect(await screen.findByText("Não foi possível mover o exame")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Estado: Amostra recebida. Mudar estado" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Fechar aviso" }));
    expect(screen.queryByText("Não foi possível mover o exame")).not.toBeInTheDocument();
  });

  it("preserves a newer realtime state when an older move fails", async () => {
    await renderView();
    let rejectMove!: (cause: Error) => void;
    vi.mocked(apiFetch).mockImplementation((path: string) => {
      if (path.includes("/start-processing")) return new Promise((_, reject) => { rejectMove = reject; }) as never;
      return Promise.resolve([]) as never;
    });
    fireEvent.click(screen.getByRole("button", { name: "Estado: Amostra recebida. Mudar estado" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Em execução" }));
    await waitFor(() => expect(rejectMove).toBeTypeOf("function"));
    const fresh = requests.map((request) => ({ ...request, items: request.items.map((entry) => entry.id === "item-hem" ? { ...entry, status: "RESULT_AVAILABLE" as const, version: 3, currentResultId: "result-fresh" } : entry) }));
    mockApi(lab, { requests: fresh });
    act(() => window.dispatchEvent(new Event("cvg:realtime-updated")));
    expect(await screen.findByRole("button", { name: /^Estado: Resultado disponível/ })).toBeInTheDocument();
    await act(async () => rejectMove(new Error("stale command")));
    expect(await screen.findByText("Não foi possível mover o exame")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Estado: Resultado disponível/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Estado: Amostra recebida/ })).not.toBeInTheDocument();
  });

  it("shows only the clinician's own requests in Meu trabalho and lets them create", async () => {
    navigation.params = new URLSearchParams("view=mine");
    mockApi(vet);
    await renderView();
    expect(screen.getByRole("navigation", { name: "Você está em" })).toHaveTextContent("Meu trabalho");
    expect(screen.queryByRole("button", { name: "Abrir Proteína C reativa — Mel" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Abrir RX de tórax — Thor" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Estado: Amostra recebida" })).toBeDisabled();
    expect(screen.getAllByRole("button", { name: "Nova solicitação" }).length).toBeGreaterThan(0);
    // The shortcut listener is a passive effect of the commit that loaded the
    // session; under CPU load the list can be found before it runs (DEP-AUD-01).
    // Opening the dialog is idempotent, so press again until it is armed.
    await waitFor(() => {
      act(() => { fireEvent.keyDown(window, { key: "c" }); });
      expect(screen.getByRole("dialog", { name: "Solicitar exames" })).toBeInTheDocument();
    });
  });

  it("opens a remembered request before the examination list finishes loading", async () => {
    mockApi(vet);
    window.history.replaceState(null, "", "/queues?create=request");
    let finishRequests!: (value: unknown) => void;
    vi.mocked(apiFetchWithMeta).mockImplementation(() => new Promise((resolve) => { finishRequests = resolve; }) as never);
    const view = render(<WorkItemsView />);
    await waitFor(() => expect(apiFetchWithMeta).toHaveBeenCalledWith("/diagnostic-requests?limit=100"));
    expect(await screen.findByRole("dialog", { name: "Solicitar exames" })).toBeInTheDocument();
    expect(view.container.querySelector(".work-items-canvas")).toHaveAttribute("aria-busy", "true");
    expect(window.location.search).toBe("");
    await act(async () => { finishRequests({ data: requests, meta: {} }); });
    await waitFor(() => expect(view.container.querySelector(".work-items-canvas")).toHaveAttribute("aria-busy", "false"));
    expect(screen.getByRole("dialog", { name: "Solicitar exames" })).toBeInTheDocument();
  });

  it("opens a deep-linked exam and scopes a sector preset", async () => {
    navigation.params = new URLSearchParams("dept=LABORATORY&preset=overdue&item=item-hem");
    await renderView();
    expect(screen.getByRole("navigation", { name: "Você está em" })).toHaveTextContent("Em atraso");
    expect(screen.queryByRole("button", { name: "Abrir Proteína C reativa — Mel" })).not.toBeInTheDocument();
    expect(await screen.findByRole("dialog", { name: "Hemograma" })).toBeInTheDocument();
  });

  it("shows an empty state and a retryable error", async () => {
    mockApi(vet, { requests: [] });
    render(<WorkItemsView />);
    // Creators keep the Solicitado group and its inline quick add, as in Plane.
    expect(await screen.findByText("Nenhum exame neste grupo.")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Nova solicitação" }).at(-1)!);
    expect(screen.getByRole("form", { name: "Adicionar exame à fila" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Fechar" }));
    cleanup();
    mockApi(lab, { requests: [] });
    vi.mocked(apiFetchWithMeta).mockImplementation(async () => ({ data: [], meta: {} }) as never);
    render(<WorkItemsView />);
    expect(await screen.findByText("Nenhum exame por aqui ainda")).toBeInTheDocument();
    cleanup();
    mockApi(vet, { fail: true });
    render(<WorkItemsView />);
    expect(await screen.findByText("Não foi possível carregar os exames")).toBeInTheDocument();
  });

  it.each(["{broken", "[]", "42", "null"])("recovers unusable persisted display %s", async (saved) => {
    window.localStorage.setItem("cvg.work-items.display.v1", saved);
    await renderView();
    expect(screen.getByRole("radio", { name: "Lista" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("button", { name: "Estado: Amostra recebida. Mudar estado" })).toBeInTheDocument();
  });

  it("restores valid preferences and normalizes an ungrouped board", async () => {
    window.localStorage.setItem("cvg.work-items.display.v1", JSON.stringify({ layout: "board", groupBy: "none", orderBy: "patient", properties: ["state", "unknown", 2], showEmptyGroups: true }));
    await renderView();
    await waitFor(() => expect(screen.getByRole("radio", { name: "Quadro" })).toHaveAttribute("aria-checked", "true"));
    expect(screen.getByRole("region", { name: "Amostra recebida" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Concluído" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Exibição" }));
    expect(screen.getByRole("radio", { name: "Estado" })).toBeChecked();
    const order = screen.getByRole("button", { name: "Ordenar por" }).closest("section")!;
    expect(within(order).getByRole("radio", { name: /Paciente/ })).toBeChecked();
    expect(screen.getByRole("button", { name: "ID" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("checkbox", { name: "Mostrar grupos vazios" })).toBeChecked();
  });

  it("continues to switch layouts when browser storage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    await renderView();
    fireEvent.click(screen.getByRole("radio", { name: "Planilha" }));
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("removes each applied filter chip without dropping other selected filters", async () => {
    await renderView();
    fireEvent.click(screen.getByRole("button", { name: "Filtros" }));
    for (const name of ["Amostra recebida", "Emergência", "Laboratório", "Hemograma", "Somente atrasados", "Ocultar concluídos e cancelados"]) fireEvent.click(screen.getByRole("checkbox", { name }));
    fireEvent.keyDown(document, { key: "Escape" });
    for (const name of ["Amostra recebida", "Emergência", "Laboratório", "Hemograma", "Somente atrasados", "Sem concluídos"]) {
      fireEvent.click(screen.getByRole("button", { name: `Remover filtro ${name}` }));
      expect(screen.queryByRole("button", { name: `Remover filtro ${name}` })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Abrir Hemograma — Thor" })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Abrir Proteína C reativa — Mel" })).toBeInTheDocument();
  });

  it.each(["results", "done"])("applies the %s preset and clears it within the locked sector", async (preset) => {
    navigation.params = new URLSearchParams(`dept=LABORATORY&preset=${preset}`);
    const data = requests.map((request) => ({ ...request, items: request.items.map((entry) => ({ ...entry, status: entry.id === "item-crp" ? "RESULT_AVAILABLE" as const : entry.id === "item-hem" ? "COMPLETED" as const : entry.status })) }));
    mockApi(vet, { requests: data });
    render(<WorkItemsView />);
    if (preset === "results") await screen.findByRole("button", { name: "Abrir Proteína C reativa — Mel" });
    else await screen.findByRole("button", { name: "Abrir Hemograma — Thor" });
    expect(screen.queryByRole("button", { name: "Abrir RX de tórax — Thor" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Limpar filtros" }));
    expect(screen.getByRole("button", { name: "Abrir Hemograma — Thor" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Abrir Proteína C reativa — Mel" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Abrir RX de tórax — Thor" })).not.toBeInTheDocument();
  });

  it.each(["MANAGER", "LAB_TECH"] as const)("scopes Meu trabalho for %s", async (role) => {
    navigation.params = new URLSearchParams("view=mine");
    mockApi({ ...lab, role });
    await renderView();
    expect(screen.queryByRole("button", { name: "Abrir Proteína C reativa — Mel" }) !== null).toBe(role === "LAB_TECH");
    expect(screen.queryByRole("button", { name: "Abrir RX de tórax — Thor" }) !== null).toBe(role === "MANAGER");
  });

  it("keeps row actions available while a background refresh is loading", async () => {
    await renderView();
    // Another user's activity triggers a refresh that is still loading.
    vi.mocked(apiFetchWithMeta).mockImplementation(() => new Promise(() => {}) as never);
    act(() => window.dispatchEvent(new Event("cvg:realtime-updated")));
    await waitFor(() => expect(document.querySelector(".work-items-canvas")).toHaveAttribute("aria-busy", "true"));
    const button = screen.getByRole("button", { name: "Iniciar processamento" });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path.endsWith("/start-processing"))).toBe(true));
  });

  it("runs the direct next action, blocks duplicate submissions and expires its confirmation", async () => {
    await renderView();
    let resolve!: (value: never) => void;
    const previous = vi.mocked(apiFetch).getMockImplementation()!;
    vi.mocked(apiFetch).mockImplementation((path, options) => path.endsWith("/start-processing") ? new Promise((yes) => { resolve = yes; }) : previous(path, options));
    const button = screen.getByRole("button", { name: "Iniciar processamento" });
    fireEvent.click(button);
    expect(button).toBeDisabled(); fireEvent.click(button);
    expect(vi.mocked(apiFetch).mock.calls.filter(([path]) => path.endsWith("/start-processing"))).toHaveLength(1);
    vi.useFakeTimers();
    await act(async () => resolve({} as never));
    expect(screen.getByText(/confirmado pelo servidor/)).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(4200));
    expect(screen.queryByText(/confirmado pelo servidor/)).not.toBeInTheDocument();
  });

  it("routes the next action to its clinical form and refreshes after confirmation", async () => {
    await renderView();
    fireEvent.click(screen.getByRole("button", { name: "Receber amostra" }));
    const form = screen.getByRole("form", { name: "Receber amostra" });
    expect(apiFetch).not.toHaveBeenCalledWith(expect.stringContaining("/receive-sample"), expect.anything());
    fireEvent.change(within(form).getByRole("textbox", { name: "Accession" }), { target: { value: "acc-1" } });
    vi.mocked(apiFetchWithMeta).mockClear();
    fireEvent.click(within(form).getByRole("button", { name: "Confirmar" }));
    await waitFor(() => expect(apiFetchWithMeta).toHaveBeenCalledWith("/diagnostic-requests?limit=100"));
    expect(screen.queryByRole("form", { name: "Receber amostra" })).not.toBeInTheDocument();
  });

  it("keeps the opener when an already open peek transitions to a clinical form", async () => {
    await renderView();
    const opener = screen.getByRole("button", { name: "Abrir Hemograma — Thor" });
    opener.focus(); fireEvent.click(opener);
    const peek = screen.getByRole("dialog", { name: "Hemograma" });
    fireEvent.click(within(peek).getByRole("button", { name: "Estado: Amostra recebida. Mudar estado" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Recoleta necessária" }));
    expect(screen.getByRole("form", { name: "Solicitar recoleta" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Fechar contexto" }));
    expect(opener).toHaveFocus();
    fireEvent.click(opener); fireEvent.click(opener);
    expect(screen.queryByRole("dialog", { name: "Hemograma" })).not.toBeInTheDocument();
  });

  it("reports direct action failure without changing the item state", async () => {
    await renderView();
    const previous = vi.mocked(apiFetch).getMockImplementation()!;
    vi.mocked(apiFetch).mockImplementation((path, options) => path.endsWith("/start-processing") ? Promise.reject(new Error("offline")) : previous(path, options));
    fireEvent.click(screen.getByRole("button", { name: "Iniciar processamento" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível iniciar processamento");
    expect(screen.getByRole("button", { name: "Estado: Amostra recebida. Mudar estado" })).toBeInTheDocument();
  });

  it("opens the editor when releasing a result lacks a valid clinical draft", async () => {
    mockApi(vet, { requests: [{ ...requests[0], items: [{ ...requests[0].items[1], status: "AWAITING_REPORT" }] }] });
    mockApi({ ...lab, role: "MANAGER" }, { requests: [{ ...requests[0], items: [{ ...requests[0].items[1], status: "AWAITING_REPORT" }] }] });
    vi.mocked(apiFetchWithMeta).mockImplementation(async (path) => ({ data: path.startsWith("/diagnostic-requests") ? [{ ...requests[0], items: [{ ...requests[0].items[1], status: "AWAITING_REPORT" }] }] : [], meta: {} }) as never);
    render(<WorkItemsView />);
    await screen.findByRole("button", { name: "Abrir RX de tórax — Thor" });
    fireEvent.click(screen.getByRole("button", { name: "Estado: Aguardando laudo. Mudar estado" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Resultado disponível" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Registre e preencha um rascunho válido");
    expect(screen.getByRole("button", { name: "Estado: Aguardando laudo. Mudar estado" })).toBeInTheDocument();
  });

  it("focuses search with / and ignores shortcuts in editable fields and with modifiers", async () => {
    mockApi(vet); await renderView();
    const search = screen.getByRole("textbox", { name: "Buscar paciente ou exame" });
    fireEvent.keyDown(window, { key: "/" }); expect(search).toHaveFocus();
    fireEvent.keyDown(search, { key: "c" });
    fireEvent.keyDown(window, { key: "c", ctrlKey: true });
    fireEvent.keyDown(window, { key: "c", metaKey: true });
    fireEvent.keyDown(window, { key: "c", altKey: true });
    expect(screen.queryByRole("dialog", { name: "Solicitar exames" })).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Nova solicitação" })[0]);
    const dialog = await screen.findByRole("dialog", { name: "Solicitar exames" });
    fireEvent.keyDown(window, { key: "/" }); expect(search).not.toHaveFocus();
    fireEvent.click(within(dialog).getByRole("button", { name: "Fechar" }));
    expect(screen.queryByRole("dialog", { name: "Solicitar exames" })).not.toBeInTheDocument();
  });

  it.each(["/queues?create=request&dept=LABORATORY#exam", "/queues?create=request#exam"])("opens creation from %s and consumes only its creation query", async (url) => {
    window.history.replaceState(null, "", url); mockApi(vet);
    render(<WorkItemsView />);
    await screen.findByRole("dialog", { name: "Solicitar exames" });
    expect(window.location.search).toBe(url.includes("dept=") ? "?dept=LABORATORY" : "");
    expect(window.location.hash).toBe("#exam");
  });

  it("opens creation on the shell event and renders a personal empty queue", async () => {
    navigation.params = new URLSearchParams("view=mine");
    mockApi(lab, { requests: [] }); vi.mocked(apiFetchWithMeta).mockResolvedValue({ data: [], meta: {} } as never);
    render(<WorkItemsView />);
    expect(await screen.findByText("Nada esperando por você")).toBeInTheDocument();
    cleanup(); mockApi(vet); await renderView();
    act(() => window.dispatchEvent(new Event("cvg:create-request")));
    expect(await screen.findByRole("dialog", { name: "Solicitar exames" })).toBeInTheDocument();
  });

  it("clears filters from the empty canvas to recover the exams", async () => {
    await renderView(); fireEvent.change(screen.getByRole("textbox", { name: "Buscar paciente ou exame" }), { target: { value: "missing" } });
    const empty = screen.getByText("Nenhum exame com estes filtros").closest("[role=status]")!;
    fireEvent.click(within(empty as HTMLElement).getByRole("button", { name: "Limpar filtros" }));
    expect(screen.getByRole("button", { name: "Abrir Hemograma — Thor" })).toBeInTheDocument();
  });
});
