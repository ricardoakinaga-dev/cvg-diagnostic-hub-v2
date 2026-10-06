/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch, apiFetchWithMeta } from "./api-client";
import { Home } from "./home-view";

vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) => <a {...props}>{children}</a>
}));
vi.mock("./dashboard", () => ({ Dashboard: () => <p>Painel técnico protegido</p> }));
vi.mock("./api-client", async (importOriginal) => ({ ...await importOriginal<typeof import("./api-client")>(), apiFetch: vi.fn(), apiFetchWithMeta: vi.fn() }));

const future = new Date(Date.now() + 4 * 3600_000).toISOString();
const request = {
  id: "request-1", requestCode: "EX-261006-0003", priority: "URGENT", createdAt: "2026-10-06T10:00:00.000Z", requesterId: "user-vet",
  patient: { id: "patient-1", displayName: "Bob", species: "Canino", externalId: "HIS-BOB" },
  items: [
    { id: "item-1", requestId: "request-1", status: "REQUESTED", priority: "URGENT", workflowType: "LABORATORY", departmentCode: "LABORATORY", version: 1, dueAt: future, service: { id: "s-1", code: "HEMOGRAM", name: "Hemograma" } },
    { id: "item-2", requestId: "request-1", status: "RESULT_AVAILABLE", priority: "URGENT", workflowType: "RADIOLOGY", departmentCode: "RADIOLOGY", version: 5, dueAt: future, currentResultId: "result-1", service: { id: "s-2", code: "XRAY", name: "RX de tórax" } }
  ]
};
const dashboard = {
  overdue: 2, recollections: 1, newResults: 3, critical: 0, totalActive: 9, updatedAt: "", window: {}, indicators: [], attention: [], dataQuality: { status: "FRESH", asOf: "" },
  departments: [
    { departmentCode: "INPATIENT", label: "Internação", activeItems: 0, overdue: 0, attention: 0, state: "CLEAR" },
    { departmentCode: "LABORATORY", label: "Laboratório", activeItems: 5, overdue: 2, attention: 3, state: "ATTENTION" },
    { departmentCode: "RADIOLOGY", label: "Radiologia", activeItems: 4, overdue: 0, attention: 0, state: "ACTIVE" }
  ]
};

function mockSession(role: string, options: { dashboardFails?: boolean } = {}) {
  vi.mocked(apiFetch).mockImplementation(async (path: string) => {
    if (path === "/session/me") return { user: { id: "user-vet", email: "vet@cvg.local", displayName: "Dra. Marina Costa", role, departmentCode: "INPATIENT", timezone: "UTC" } } as never;
    if (path === "/dashboard") { if (options.dashboardFails) throw new Error("down"); return dashboard as never; }
    return [] as never;
  });
  vi.mocked(apiFetchWithMeta).mockImplementation(async (path: string) => ({ data: path.startsWith("/diagnostic-requests") ? [request] : [], meta: {} }) as never);
}

describe("Home", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); });

  it("greets the clinician and summarises work like Plane's home", async () => {
    mockSession("VETERINARIAN");
    render(<Home />);
    expect(await screen.findByRole("heading", { level: 1, name: /, Marina$/ })).toBeInTheDocument();
    const shortcuts = screen.getByRole("navigation", { name: "Atalhos" });
    expect(await within(shortcuts).findByRole("link", { name: /Atrasados\s*2/ })).toHaveAttribute("href", "/queues?preset=overdue");
    expect(within(shortcuts).getByRole("link", { name: /Minhas solicitações\s*2/ })).toHaveAttribute("href", "/queues?view=mine");
    expect(within(shortcuts).getByRole("link", { name: /Resultados novos\s*3/ })).toBeInTheDocument();
    const [attention] = await screen.findAllByRole("link", { name: /LAB-0003\s*Bob — Hemograma/ });
    expect(attention).toHaveAttribute("href", "/queues?dept=LABORATORY&item=item-1");
    expect(screen.getAllByRole("link", { name: /RX-0003\s*Bob — RX de tórax/ }).length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: /Laboratório\s*Atenção/ })).toHaveAttribute("href", "/queues?dept=LABORATORY");
    expect(screen.getByRole("link", { name: /Radiologia\s*Ativo/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Internação/ })).not.toBeInTheDocument();
  });

  it("keeps working when indicators are unavailable", async () => {
    mockSession("LAB_TECH", { dashboardFails: true });
    render(<Home />);
    expect(await screen.findByText("Indicadores indisponíveis no momento.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Na minha fila/ })).toBeInTheDocument();
  });

  it("does not report a clear workload when exam loading fails and allows recovery", async () => {
    mockSession("VETERINARIAN");
    vi.mocked(apiFetchWithMeta).mockRejectedValue(new Error("offline"));
    render(<Home />);
    expect(await screen.findByText("Não foi possível carregar os exames")).toBeInTheDocument();
    expect(screen.queryByText("Nenhum exame exige atenção imediata.")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Minhas solicitações\s*0/ })).not.toBeInTheDocument();
    mockSession("VETERINARIAN");
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(await screen.findByRole("link", { name: /Minhas solicitações\s*2/ })).toBeInTheDocument();
  });

  it("reconciles indicators when the realtime stream requests a resync", async () => {
    mockSession("VETERINARIAN");
    render(<Home />);
    await screen.findByRole("link", { name: /Atrasados\s*2/ });
    vi.mocked(apiFetch).mockClear();
    act(() => { window.dispatchEvent(new Event("cvg:realtime-resync")); });
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/dashboard"));
  });

  it("keeps the protected landing for technical administrators", async () => {
    mockSession("ADMIN");
    render(<Home />);
    expect(await screen.findByText("Painel técnico protegido")).toBeInTheDocument();
    expect(apiFetch).not.toHaveBeenCalledWith("/dashboard");
  });

  it("explains a session failure", async () => {
    vi.mocked(apiFetch).mockRejectedValue(new Error("offline"));
    render(<Home />);
    expect(await screen.findByText("Identidade indisponível")).toBeInTheDocument();
  });

  it.each([[8, "Bom dia"], [14, "Boa tarde"], [21, "Boa noite"]])("greets a clinician at hour %s", async (hour, greeting) => {
    vi.spyOn(Date.prototype, "getHours").mockReturnValue(Number(hour));
    mockSession("VET"); render(<Home />);
    expect(await screen.findByRole("heading", { level: 1, name: `${greeting}, Marina` })).toBeInTheDocument();
    await screen.findByRole("link", { name: /Minhas solicitações\s*2/ });
  });

  it("shows empty work and zero fallback counts when both feeds contain no work", async () => {
    mockSession("VETERINARIAN", { dashboardFails: true });
    vi.mocked(apiFetchWithMeta).mockResolvedValue({ data: [], meta: {} } as never);
    render(<Home />);
    expect(await screen.findByText("Nenhuma solicitação ainda.")).toBeInTheDocument();
    expect(screen.getByText("Nenhum exame exige atenção imediata.")).toBeInTheDocument();
    expect(screen.getByText("Nenhum resultado aguardando revisão.")).toBeInTheDocument();
    const shortcuts = screen.getByRole("navigation", { name: "Atalhos" });
    for (const label of ["Minhas solicitações", "Atrasados", "Resultados novos", "Recoletas"]) expect(within(shortcuts).getByRole("link", { name: new RegExp(`${label}\\s*0`) })).toBeInTheDocument();
  });

  it.each(["LAB_TECH", "MANAGER", "INPATIENT_TEAM"])("counts active personal work for %s without including terminal or another owner's exams", async (role) => {
    mockSession(role);
    const prior = vi.mocked(apiFetch).getMockImplementation()!;
    vi.mocked(apiFetch).mockImplementation(async (path, options) => path === "/session/me" ? { user: { id: "user-vet", email: "vet@cvg.local", displayName: "Equipe Marina", role, departmentCode: "LABORATORY", timezone: "UTC" } } as never : prior(path, options));
    const own = { ...request, items: [request.items[0], { ...request.items[0], id: "terminal", status: "COMPLETED" }] };
    const other = { ...request, id: "other", requesterId: "someone-else", items: [{ ...request.items[1], id: "other-rx" }] };
    vi.mocked(apiFetchWithMeta).mockImplementation(async (path) => ({ data: path.startsWith("/diagnostic-requests") ? [own, other] : [], meta: {} }) as never);
    render(<Home />);
    const label = role === "INPATIENT_TEAM" ? "Minhas solicitações" : "Na minha fila";
    expect(await screen.findByRole("link", { name: new RegExp(`${label}\\s*1`) })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Nova solicitação" }) !== null).toBe(role !== "LAB_TECH");
  });

  it("computes fallback counts from overdue, recollection and available result states", async () => {
    mockSession("VETERINARIAN", { dashboardFails: true });
    const data = [{ ...request, items: [
      { ...request.items[0], priority: "ROUTINE", dueAt: "2000-01-01T12:00:00Z", status: "RECOLLECTION_REQUIRED" },
      { ...request.items[1], priority: "EMERGENCY" },
      { ...request.items[0], id: "closed", status: "CANCELLED", dueAt: "2000-01-01T12:00:00Z" }
    ] }];
    vi.mocked(apiFetchWithMeta).mockImplementation(async (path) => ({ data: path.startsWith("/diagnostic-requests") ? data : [], meta: {} }) as never);
    render(<Home />);
    expect(await screen.findByRole("link", { name: /Minhas solicitações\s*2/ })).toBeInTheDocument();
    for (const label of ["Atrasados", "Resultados novos", "Recoletas"]) expect(screen.getByRole("link", { name: new RegExp(`${label}\\s*1`) })).toBeInTheDocument();
    const attention = screen.getByRole("region", { name: "Precisa de atenção" });
    expect(within(attention).getByText("Rotina")).toBeInTheDocument();
    expect(within(attention).getByText("Emergência")).toBeInTheDocument();
    expect(within(attention).getAllByRole("link").filter((link) => link.classList.contains("home-row"))).toHaveLength(2);
  });

  it("recognizes routine recollection and escalation as attention and shows a clear clinical sector", async () => {
    mockSession("LAB_TECH");
    const prior = vi.mocked(apiFetch).getMockImplementation()!;
    vi.mocked(apiFetch).mockImplementation(async (path, options) => path === "/dashboard" ? { ...dashboard, departments: [{ ...dashboard.departments[1], state: "CLEAR", overdue: 0 }] } as never : prior(path, options));
    const entries = [{ ...request, priority: "ROUTINE", items: [{ ...request.items[0], priority: "ROUTINE", status: "RECOLLECTION_REQUIRED" }, { ...request.items[0], id: "escalated", priority: "ROUTINE" }] }];
    vi.mocked(apiFetchWithMeta).mockImplementation(async (path) => ({ data: path.startsWith("/diagnostic-requests") ? entries : path.startsWith("/queues/INPATIENT") ? [{ ...request.items[0], id: "escalated", requestCode: request.requestCode, patient: request.patient, priority: "ROUTINE", createdAt: request.createdAt, overdue: false, operationalContext: { currentOwner: { label: "Equipe", code: "DEPARTMENT" }, nextAction: { label: "Receber", code: "RECEIVE_SAMPLE" }, blockedBy: null, waitingSince: null, expectedBy: future, escalationLevel: "ATTENTION" } }] : [], meta: {} }) as never);
    render(<Home />);
    const attention = await screen.findByRole("region", { name: "Precisa de atenção" });
    await waitFor(() => expect(within(attention).getAllByRole("link").filter((link) => link.classList.contains("home-row"))).toHaveLength(2));
    expect(screen.getByRole("link", { name: /Laboratório\s*Em dia/ })).toBeInTheDocument();
  });

  it.each(["partial", "truncated"])("warns that %s data cannot supply a complete summary", async (kind) => {
    mockSession("LAB_TECH");
    vi.mocked(apiFetchWithMeta).mockImplementation(async (path) => {
      if (kind === "partial" && path.startsWith("/queues/")) throw new Error("unavailable");
      return { data: path.startsWith("/diagnostic-requests") && !path.includes("cursor=") ? [request] : [], meta: kind === "truncated" && path.startsWith("/diagnostic-requests") ? { nextCursor: "next" } : {} } as never;
    });
    render(<Home />);
    const message = kind === "partial" ? "Parte das filas do setor não respondeu" : "Lista limitada a 1.000 solicitações";
    expect(await screen.findByText(new RegExp(message))).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Resultados novos\s*3/ })).toBeInTheDocument();
  });

  it("preserves work with a stale warning after refresh fails and recovers both feeds", async () => {
    mockSession("VETERINARIAN"); render(<Home />);
    await screen.findByRole("link", { name: /Minhas solicitações\s*2/ });
    vi.mocked(apiFetchWithMeta).mockRejectedValue(new Error("offline"));
    act(() => window.dispatchEvent(new Event("cvg:realtime-updated")));
    expect(await screen.findByRole("status", { name: "Dados desatualizados" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Minhas solicitações\s*2/ })).toBeInTheDocument();
    mockSession("VETERINARIAN");
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    await waitFor(() => expect(screen.queryByRole("status", { name: "Dados desatualizados" })).not.toBeInTheDocument());
  });

  it.each(["resolve", "reject"])("ignores session %s after the landing page unmounts", async (outcome) => {
    let resolve!: (value: never) => void; let reject!: (error: Error) => void;
    vi.mocked(apiFetch).mockImplementation(() => new Promise((yes, no) => { resolve = yes; reject = no; }));
    const view = render(<Home />); view.unmount();
    await act(async () => { if (outcome === "resolve") resolve({ user: {} } as never); else reject(new Error("offline")); });
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });
});
