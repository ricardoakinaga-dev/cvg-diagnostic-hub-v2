/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "./app-shell";
import { apiFetch } from "./api-client";

vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) => <a {...props}>{children}</a>,
}));

const replace = vi.fn();
const refresh = vi.fn();
const push = vi.fn();
const router = { replace, refresh, push };
const navigationState = { pathname: "/", searchParams: new URLSearchParams() };

vi.mock("next/navigation", () => ({
  usePathname: () => navigationState.pathname,
  useSearchParams: () => navigationState.searchParams,
  useRouter: () => router,
}));

vi.mock("./api-client", async (importOriginal) => ({ ...await importOriginal<typeof import("./api-client")>(), apiFetch: vi.fn() }));

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, () => void>();
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly close = vi.fn();
  readonly addEventListener = vi.fn((name: string, listener: () => void) => { this.listeners.set(name, listener); });

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  triggerError() {
    this.onerror?.();
  }

  triggerOpen() {
    this.onopen?.();
  }

  triggerNamed(name: string) {
    this.listeners.get(name)?.();
  }
}

const originalEventSource = globalThis.EventSource;

describe("AppShell", () => {
  beforeEach(() => {
    window.localStorage.clear();
    navigationState.pathname = "/";
    navigationState.searchParams = new URLSearchParams();
    FakeEventSource.instances = [];
    Object.defineProperty(globalThis, "EventSource", { configurable: true, writable: true, value: FakeEventSource });
    vi.mocked(apiFetch).mockResolvedValue({
      user: {
        id: "user-1",
        email: "vet@cvg.local",
        displayName: "Ana Silva",
        role: "VET",
        departmentCode: "LABORATORY",
        timezone: "America/Sao_Paulo",
      },
    });
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    if (originalEventSource) {
      Object.defineProperty(globalThis, "EventSource", { configurable: true, writable: true, value: originalEventSource });
    } else {
      Reflect.deleteProperty(globalThis, "EventSource");
    }
    vi.clearAllMocks();
  });

  it.each([
    ["/patients/patient-1/diagnostics", "Diagnósticos do paciente"],
    ["/patients", "Pacientes"],
    ["/notifications", "Caixa de entrada"],
    ["/account", "Minha conta"],
    ["/system", "Sistema"],
    ["/indicators", "Indicadores"],
    ["/results/result-1", "Resultado"],
    ["/requests/request-1", "Solicitação"],
    ["/management?view=requests", "Solicitações"],
    ["/other", "CVG"]
  ])("keeps the page breadcrumb coherent on %s", async (path, label) => {
    const url = new URL(path, "http://localhost");
    navigationState.pathname = url.pathname;
    navigationState.searchParams = url.searchParams;
    render(<AppShell><h1>Workspace</h1></AppShell>);
    const crumb = await screen.findByRole("navigation", { name: "Você está em" });
    expect(crumb).toHaveTextContent(label);
  });

  it("persists desktop collapse and sector expansion and dismisses mobile query navigation", async () => {
    navigationState.pathname = "/queues";
    render(<AppShell flush><h1>Workspace</h1></AppShell>);
    await screen.findByRole("heading", { name: "Workspace" });
    fireEvent.click(screen.getByRole("button", { name: "Recolher barra lateral" }));
    expect(window.localStorage.getItem("cvg.sidebar.collapsed")).toBe("1");
    fireEvent.click(screen.getByRole("button", { name: "Expandir barra lateral" }));
    expect(window.localStorage.getItem("cvg.sidebar.collapsed")).toBe("0");
    const sector = screen.getByRole("button", { name: "Laboratório" });
    fireEvent.click(sector);
    expect(sector).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(sector);
    expect(JSON.parse(window.localStorage.getItem("cvg.sidebar.sectors") ?? "[]")).toEqual(["LABORATORY"]);
    fireEvent.click(screen.getByRole("button", { name: "Abrir menu" }));
    expect(document.querySelector(".app-frame")).toHaveClass("sidebar-mobile-open");
    fireEvent.click(screen.getByRole("link", { name: "Em atraso", hidden: true }));
    expect(document.querySelector(".app-frame")).not.toHaveClass("sidebar-mobile-open");
    fireEvent.click(screen.getByRole("button", { name: "Abrir menu" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Fechar menu" }).at(-1)!);
    expect(document.querySelector(".app-frame")).not.toHaveClass("sidebar-mobile-open");
  });

  it("restores saved sector expansion and caps unread badge text", async () => {
    window.localStorage.setItem("cvg.sidebar.sectors", JSON.stringify(["LABORATORY", null]));
    vi.mocked(apiFetch).mockImplementation(async (path) => path.startsWith("/notifications") ? Array.from({ length: 101 }, (_, index) => ({ id: String(index) })) as never : { user: { id: "u", email: "vet@cvg.local", displayName: "Ana Silva", role: "VET", departmentCode: "LABORATORY", timezone: "UTC" } } as never);
    render(<AppShell><h1>Workspace</h1></AppShell>);
    await screen.findByText("99+");
    expect(screen.getAllByText("9+").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Laboratório" })).toHaveAttribute("aria-expanded", "true");
    act(() => { window.dispatchEvent(new Event("cvg:notifications-changed")); window.dispatchEvent(new CustomEvent("cvg:peek", { detail: true })); });
    expect(screen.getByRole("navigation", { name: "Navegação rápida" })).toHaveAttribute("inert");
  });

  it("navigates the account menu with keys and restores focus when dismissed", async () => {
    render(<AppShell><h1>Workspace</h1></AppShell>);
    await screen.findByRole("heading", { name: "Workspace" });
    const trigger = screen.getByRole("button", { name: "Menu de Ana Silva" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const account = screen.getByRole("menuitem", { name: "Minha conta" });
    const exit = screen.getByRole("menuitem", { name: "Sair" });
    expect(account).toHaveFocus();
    fireEvent.keyDown(account, { key: "ArrowDown" });
    expect(exit).toHaveFocus();
    fireEvent.keyDown(exit, { key: "ArrowUp" });
    expect(account).toHaveFocus();
    fireEvent.keyDown(account, { key: "End" });
    expect(exit).toHaveFocus();
    fireEvent.keyDown(exit, { key: "Home" });
    expect(account).toHaveFocus();
    fireEvent.keyDown(account, { key: "Escape" });
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Minha conta" }), { key: "Tab" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.click(trigger);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("exposes an uncertainty banner and reconciliation action when SSE degrades", async () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    const intervalSpy = vi.spyOn(globalThis, "setInterval");
    render(<AppShell><div>Conteúdo da página</div></AppShell>);

    await screen.findByRole("navigation", { name: "Navegação principal" });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];
    act(() => source.triggerNamed("diagnostic.updated"));
    await waitFor(() => expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({ type: "cvg:realtime-updated" })));
    act(() => source.triggerError());

    const banner = await screen.findByRole("status");
    expect(source.close).not.toHaveBeenCalled();
    expect(banner).toHaveTextContent("Uma reconciliação limitada ocorre periodicamente");
    expect(banner).toHaveTextContent("Conexão em tempo real indisponível");
    expect(intervalSpy).toHaveBeenCalledWith(expect.any(Function), 30_000);
    expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({ type: "cvg:realtime-updated" }));

    fireEvent.click(screen.getByRole("button", { name: "Atualizar agora" }));

    await waitFor(() => expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({ type: "cvg:realtime-resync" })));
    expect(source.close).toHaveBeenCalled();
  });

  it("refreshes at once and coalesces the rest of a replay burst into one trailing refresh", async () => {
    render(<AppShell><div>Conteúdo da página</div></AppShell>);
    await screen.findByRole("navigation", { name: "Navegação principal" });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];
    const refreshes = vi.fn();
    window.addEventListener("cvg:realtime-updated", refreshes);
    try {
      // A fresh connection replays the server window (20 events by default) at once.
      act(() => {
        for (let event = 0; event < 20; event += 1) {
          if (event % 2) source.onmessage?.();
          else source.triggerNamed("diagnostic.updated");
        }
      });
      // The first event refreshes immediately, with no added latency.
      expect(refreshes).toHaveBeenCalledOnce();
      await waitFor(() => expect(refreshes).toHaveBeenCalledTimes(2));
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(refreshes).toHaveBeenCalledTimes(2);
      // A later, separate event refreshes at once again.
      act(() => source.triggerNamed("diagnostic.updated"));
      expect(refreshes).toHaveBeenCalledTimes(3);
    } finally {
      window.removeEventListener("cvg:realtime-updated", refreshes);
    }
  });

  it("keeps the native EventSource reconnect path so Last-Event-ID survives a transient error", async () => {
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    render(<AppShell><div>Conteúdo da página</div></AppShell>);

    await screen.findByRole("navigation", { name: "Navegação principal" });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];

    act(() => source.triggerError());
    expect(source.close).not.toHaveBeenCalled();
    expect(await screen.findByRole("status")).toHaveTextContent("Conexão em tempo real indisponível");

    // A real browser invokes onopen on this same EventSource after its native
    // retry. Keeping the instance alive is what preserves its last event ID.
    act(() => source.triggerOpen());
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    expect(clearIntervalSpy).toHaveBeenCalled();
  });

  it("announces the shell session loading state while identity is unresolved", async () => {
    vi.mocked(apiFetch).mockImplementationOnce(() => new Promise(() => {}) as never);

    render(<AppShell><div>Conteúdo da página</div></AppShell>);

    const loadingState = await screen.findByRole("status", { name: "Carregando o espaço operacional." });
    expect(loadingState).toHaveAttribute("aria-busy", "true");
    expect(loadingState).toHaveAttribute("aria-live", "polite");
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });

  it("keeps the main navigation semantic and marks the current page", async () => {
    render(<AppShell><div>Conteúdo da página</div></AppShell>);

    const navigation = await screen.findByRole("navigation", { name: "Navegação principal" });
    expect(navigation).toBeInTheDocument();
    expect(screen.getByText("Veterinário", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText("VET", { exact: true })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Início" })).toHaveAttribute("aria-current", "page");
    expect(navigation.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Todos os exames" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "Todos os exames" })).toHaveAttribute("href", "/queues");
    expect(screen.getByRole("link", { name: "Meu trabalho" })).toHaveAttribute("href", "/queues?view=mine");
    expect(screen.getByRole("link", { name: "Caixa de entrada" })).toHaveAttribute("href", "/notifications");
    expect(screen.getByRole("link", { name: "Pacientes" })).toHaveAttribute("href", "/patients");
    expect(screen.queryByRole("link", { name: "Indicadores" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Administração" })).not.toBeInTheDocument();
  });

  it("exposes the operational management navigation to a manager", async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      user: {
        id: "user-management",
        email: "management@cvg.local",
        displayName: "Gestão",
        role: "MANAGER",
        departmentCode: "LABORATORY",
        timezone: "America/Sao_Paulo",
      },
    });

    render(<AppShell><div>Conteúdo da página</div></AppShell>);

    await screen.findByRole("navigation", { name: "Navegação principal" });
    expect(screen.getByRole("link", { name: "Todos os exames" })).toHaveAttribute("href", "/queues");
    expect(screen.getByRole("link", { name: "Painel gerencial" })).toHaveAttribute("href", "/management");
    expect(screen.getByRole("link", { name: "Solicitações" })).toHaveAttribute("href", "/management?view=requests");
    expect(screen.getByRole("link", { name: "Pendências" })).toHaveAttribute("href", "/management?view=pending");
    expect(screen.getByRole("link", { name: "Estatísticas" })).toHaveAttribute("href", "/management?view=stats");
    expect(screen.getByRole("link", { name: "Acessos" })).toHaveAttribute("href", "/admin#users");
    expect(screen.getByRole("link", { name: "Catálogos" })).toHaveAttribute("href", "/admin#catalog");
    expect(screen.queryByRole("link", { name: "Auditoria" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Administração" })).not.toBeInTheDocument();
  });

  it.each([
    ["requests", "Solicitações"],
    ["pending", "Atenção"],
    ["stats", "Estatísticas"]
  ])("keeps one mobile management destination active for view=%s", async (view, label) => {
    navigationState.pathname = "/management";
    navigationState.searchParams = new URLSearchParams(`view=${view}`);
    vi.mocked(apiFetch).mockResolvedValue({
      user: {
        id: "user-management",
        email: "management@cvg.local",
        displayName: "Gestão",
        role: "MANAGER",
        departmentCode: "LABORATORY",
        timezone: "America/Sao_Paulo",
      },
    });

    render(<AppShell><div>Conteúdo da página</div></AppShell>);

    const mobileNavigation = await screen.findByRole("navigation", { name: "Navegação rápida" });
    const activeLinks = mobileNavigation.querySelectorAll('[aria-current="page"]');
    expect(activeLinks).toHaveLength(1);
    expect(within(mobileNavigation).getByRole("link", { name: `Acesso rápido: ${label}` })).toHaveAttribute("aria-current", "page");
    expect(within(mobileNavigation).getByRole("link", { name: "Acesso rápido: Início" })).not.toHaveAttribute("aria-current", "page");
  });

  it("limits a technical administrator to the technical administration area", async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      user: {
        id: "user-admin",
        email: "admin@cvg.local",
        displayName: "Administração Técnica",
        role: "ADMIN",
        departmentCode: "IT",
        timezone: "America/Sao_Paulo",
      },
    });

    render(<AppShell><div>Conteúdo da página</div></AppShell>);

    await screen.findByRole("navigation", { name: "Navegação principal" });
    expect(screen.getByRole("link", { name: "Início" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Administração" })).toHaveAttribute("href", "/admin");
    expect(screen.getByRole("link", { name: "Sistema" })).toHaveAttribute("href", "/system");
    expect(screen.getByRole("link", { name: "Acesso rápido: Sistema" })).toHaveAttribute("href", "/system");
    expect(screen.queryByRole("link", { name: "Todos os exames" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Pacientes" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Indicadores" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Caixa de entrada" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Nova solicitação" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Abrir notificações" })).not.toBeInTheDocument();
  });

  it.each(["ADMIN", "MANAGER", "VETERINARIAN", "LAB_TECH"])("shows Sistema only to ADMIN (%s)", async (role) => {
    navigationState.pathname = "/system";
    vi.mocked(apiFetch).mockResolvedValue({ user: { id: "user-1", email: "user@cvg.local", displayName: "Equipe", role, departmentCode: "LABORATORY", timezone: "UTC" } });
    render(<AppShell><div>Conteúdo</div></AppShell>);
    await screen.findByRole("navigation", { name: "Navegação principal" });
    if (role === "ADMIN") {
      expect(screen.getByRole("link", { name: "Sistema" })).toHaveAttribute("aria-current", "page");
      expect(screen.getByRole("link", { name: "Acesso rápido: Sistema" })).toHaveAttribute("aria-current", "page");
      fireEvent.keyDown(window, { key: "k", ctrlKey: true });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    } else {
      expect(screen.queryByRole("link", { name: "Sistema" })).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Acesso rápido: Sistema" })).not.toBeInTheDocument();
    }
  });

  it.each([{ ctrlKey: true }, { metaKey: true }])("opens global search with %j and restores trigger focus on Escape", async (modifier) => {
    render(<AppShell><div>Conteúdo</div></AppShell>);
    const trigger = await screen.findByRole("button", { name: "Buscar paciente ou exame (Ctrl+K ou ⌘K)" });
    // The shortcut listener is a passive effect of the commit that renders the
    // trigger; under CPU load the trigger can be found before it runs. The
    // stream is opened by an effect of the same commit.
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    trigger.focus();
    fireEvent.keyDown(window, { key: "k", ...modifier });
    expect(screen.getByRole("dialog", { name: "Atalhos e busca" })).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toHaveFocus();
    expect(document.querySelector("main")).toHaveAttribute("inert");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(document.querySelector("main")).not.toHaveAttribute("inert");
  });

  it("opens the existing PatientDialog and returns to the palette when it is cancelled", async () => {
    vi.mocked(apiFetch).mockResolvedValue({ user: { id: "user-1", email: "vet@cvg.local", displayName: "Ana", role: "VETERINARIAN", departmentCode: "LABORATORY", timezone: "UTC" } });
    render(<AppShell><div>Conteúdo</div></AppShell>);
    fireEvent.click(await screen.findByRole("button", { name: /Buscar paciente ou exame/ }));
    fireEvent.click(screen.getByRole("option", { name: /Novo paciente/ }));
    expect(screen.getByRole("dialog", { name: "Cadastrar paciente" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Atalhos e busca" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Nome do paciente")).toHaveFocus();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Cadastrar paciente" })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveFocus());
    expect(screen.getByRole("dialog", { name: "Atalhos e busca" })).toBeInTheDocument();
  });

  it("refreshes clinical data after a patient is created from the global shortcut", async () => {
    vi.mocked(apiFetch).mockResolvedValue({ user: { id: "user-1", email: "vet@cvg.local", displayName: "Ana", role: "VETERINARIAN", departmentCode: "LABORATORY", timezone: "UTC" } });
    render(<AppShell><div>Conteúdo</div></AppShell>);
    fireEvent.click(await screen.findByRole("button", { name: /Buscar paciente ou exame/ }));
    fireEvent.click(screen.getByRole("option", { name: /Novo paciente/ }));
    const dispatch = vi.spyOn(window, "dispatchEvent");
    vi.mocked(apiFetch).mockResolvedValueOnce({ patient: { id: "p-1" }, encounter: { id: "e-1" } });
    fireEvent.change(screen.getByLabelText("Nome do paciente"), { target: { value: "Amora" } });
    fireEvent.change(screen.getByLabelText("Espécie"), { target: { value: "Canino" } });
    fireEvent.change(screen.getByLabelText("Tutor ou responsável"), { target: { value: "Maria" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar cadastro de paciente" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(refresh).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "cvg:realtime-updated" }));
    dispatch.mockRestore();
  });

  it.each(["MANAGER", "LAB_TECH", "VIEWER"])("preserves creation permissions in the palette (%s)", async (role) => {
    vi.mocked(apiFetch).mockResolvedValue({ user: { id: "user-1", email: "user@cvg.local", displayName: "Equipe", role, departmentCode: "LABORATORY", timezone: "UTC" } });
    render(<AppShell><div>Conteúdo</div></AppShell>);
    fireEvent.click(await screen.findByRole("button", { name: /Buscar paciente ou exame/ }));
    expect(screen.queryByRole("option", { name: /Novo paciente/ })).not.toBeInTheDocument();
    expect(Boolean(screen.queryByRole("option", { name: /Novo exame/ }))).toBe(role === "MANAGER");
  });

  it("dispatches request creation to the existing queue workflow", async () => {
    navigationState.pathname = "/queues";
    vi.mocked(apiFetch).mockResolvedValue({ user: { id: "user-1", email: "vet@cvg.local", displayName: "Ana", role: "VETERINARIAN", departmentCode: "LABORATORY", timezone: "UTC" } });
    const listener = vi.fn();
    window.addEventListener("cvg:create-request", listener);
    render(<AppShell><div>Fila</div></AppShell>);
    fireEvent.click(await screen.findByRole("button", { name: /Buscar paciente ou exame/ }));
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(listener).toHaveBeenCalledOnce();
    expect(push).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    window.removeEventListener("cvg:create-request", listener);
  });

  it("navigates to the queue creation workflow from other pages", async () => {
    navigationState.pathname = "/patients";
    vi.mocked(apiFetch).mockResolvedValue({ user: { id: "user-1", email: "vet@cvg.local", displayName: "Ana", role: "VETERINARIAN", departmentCode: "LABORATORY", timezone: "UTC" } });
    render(<AppShell><div>Pacientes</div></AppShell>);
    fireEvent.click(await screen.findByRole("button", { name: /Buscar paciente ou exame/ }));
    fireEvent.click(screen.getByRole("option", { name: /Novo exame/ }));
    expect(push).toHaveBeenCalledWith("/queues?create=request");
  });

  it.each(["/queues", "/account", "/login"])("gates a password-required session on %s without a redirect loop", async (pathname) => {
    navigationState.pathname = pathname;
    vi.mocked(apiFetch).mockResolvedValue({ user: { id: "user-1", email: "vet@cvg.local", displayName: "Ana", role: "VETERINARIAN", departmentCode: "LABORATORY", timezone: "UTC", mustChangePassword: true } });
    render(<AppShell><div>Conteúdo protegido</div></AppShell>);
    const nav = await screen.findByRole("navigation", { name: "Navegação principal" });
    expect(within(nav).getAllByRole("link")).toHaveLength(1);
    expect(within(nav).getByRole("link", { name: "Minha conta" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Buscar paciente ou exame/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Abrir notificações" })).not.toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Navegação rápida" })).toHaveTextContent("Conta");
    expect(FakeEventSource.instances).toHaveLength(0);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    if (pathname === "/queues") {
      expect(replace).toHaveBeenCalledWith("/account?password=required");
      expect(screen.queryByText("Conteúdo protegido")).not.toBeInTheDocument();
    } else {
      expect(replace).not.toHaveBeenCalled();
      expect(screen.getByText("Conteúdo protegido")).toBeInTheDocument();
    }
  });

  it("reloads session state after the password change when navigating away from account", async () => {
    navigationState.pathname = "/account";
    const user = { id: "user-1", email: "vet@cvg.local", displayName: "Ana", role: "VETERINARIAN", departmentCode: "LABORATORY", timezone: "UTC" };
    vi.mocked(apiFetch).mockResolvedValueOnce({ user: { ...user, mustChangePassword: true } }).mockResolvedValueOnce({ user: { ...user, mustChangePassword: false } });
    const { rerender } = render(<AppShell><div>Conta</div></AppShell>);
    await screen.findByRole("navigation", { name: "Navegação principal" });
    navigationState.pathname = "/queues";
    rerender(<AppShell><div>Fila</div></AppShell>);
    expect(await screen.findByRole("link", { name: "Todos os exames" })).toBeInTheDocument();
    // Identity loads once per route; the unread inbox count is a separate read.
    expect(vi.mocked(apiFetch).mock.calls.filter(([path]) => path === "/session/me")).toHaveLength(2);
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByText("Fila", { exact: true, selector: "div" })).toBeInTheDocument();
  });

  it("redirects a failed session to login and aborts identity loading on unmount", async () => {
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error("unauthorized"));
    const first = render(<AppShell><div>Conteúdo protegido</div></AppShell>);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
    expect(screen.queryByText("Conteúdo protegido")).not.toBeInTheDocument();
    first.unmount();
    vi.mocked(apiFetch).mockImplementationOnce(() => new Promise(() => {}));
    const second = render(<AppShell><div>Conteúdo</div></AppShell>);
    const signal = vi.mocked(apiFetch).mock.calls.at(-1)?.[1]?.signal;
    second.unmount();
    expect(signal?.aborted).toBe(true);
  });

  it("waits for the current route identity before redirecting a cached password-required session", async () => {
    navigationState.pathname = "/account";
    const user = { id: "user-1", email: "vet@cvg.local", displayName: "Ana", role: "VETERINARIAN", departmentCode: "LABORATORY", timezone: "UTC" };
    let resolveSession!: (value: { user: typeof user }) => void;
    const pendingSession = new Promise<{ user: typeof user }>((resolve) => { resolveSession = resolve; });
    vi.mocked(apiFetch).mockResolvedValueOnce({ user: { ...user, mustChangePassword: true } }).mockReturnValueOnce(pendingSession);
    const { rerender } = render(<AppShell><div>Conta</div></AppShell>);
    await screen.findByRole("navigation", { name: "Navegação principal" });
    navigationState.pathname = "/";
    rerender(<AppShell><div>Dashboard</div></AppShell>);
    expect(replace).not.toHaveBeenCalled();
    expect(screen.queryByText("Dashboard")).not.toBeInTheDocument();
    await act(async () => { resolveSession({ user }); await pendingSession; });
    expect(await screen.findByText("Dashboard")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("ignores a late identity from the previous route", async () => {
    let resolveOld!: (value: unknown) => void;
    const oldSession = new Promise((resolve) => { resolveOld = resolve; });
    vi.mocked(apiFetch).mockReturnValueOnce(oldSession).mockResolvedValueOnce({ user: { id: "user-2", email: "vet@cvg.local", displayName: "Ana", role: "VETERINARIAN", departmentCode: "LABORATORY", timezone: "UTC" } });
    const { rerender } = render(<AppShell><div>Primeira página</div></AppShell>);
    const oldSignal = vi.mocked(apiFetch).mock.calls[0][1]?.signal;
    navigationState.pathname = "/patients";
    rerender(<AppShell><div>Pacientes</div></AppShell>);
    await screen.findByRole("link", { name: "Pacientes" });
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => { resolveOld({ user: { role: "ADMIN", mustChangePassword: true } }); await oldSession; });
    expect(screen.getByRole("link", { name: "Pacientes" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Sistema" })).not.toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("keeps dashboard shortcut handlers from stealing focus from the global palette", async () => {
    const pageInput = document.createElement("input");
    document.body.appendChild(pageInput);
    const localShortcut = vi.fn(() => pageInput.focus());
    window.addEventListener("keydown", localShortcut);
    render(<AppShell><div>Dashboard</div></AppShell>);
    await screen.findByRole("button", { name: /Buscar paciente ou exame/ });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(await screen.findByRole("combobox")).toHaveFocus();
    expect(localShortcut).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.getByRole("combobox")).toHaveFocus();
    expect(localShortcut).not.toHaveBeenCalled();
    window.removeEventListener("keydown", localShortcut);
    pageInput.remove();
  });

  it("marks the realtime connection healthy and logs out through the server", async () => {
    vi.mocked(apiFetch).mockImplementation((path) => {
      if (path === "/session/logout") return Promise.resolve({}) as never;
      return Promise.resolve({ user: { id: "user-1", email: "vet@cvg.local", displayName: "Ana Silva", role: "VET", departmentCode: "LABORATORY", timezone: "UTC" } }) as never;
    });
    render(<AppShell><div>Conteúdo</div></AppShell>);
    await screen.findByRole("navigation", { name: "Navegação principal" });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    act(() => FakeEventSource.instances[0].triggerOpen());
    expect(screen.getByRole("img", { name: "Conexão em tempo real ativa" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Menu de Ana Silva" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Sair" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/session/logout", expect.objectContaining({ method: "POST" })));
    expect(replace).toHaveBeenCalledWith("/login");
  });
});
