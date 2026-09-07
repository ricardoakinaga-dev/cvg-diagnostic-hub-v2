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
const router = { replace, refresh };
const navigationState = { pathname: "/", searchParams: new URLSearchParams() };

vi.mock("next/navigation", () => ({
  usePathname: () => navigationState.pathname,
  useSearchParams: () => navigationState.searchParams,
  useRouter: () => router,
}));

vi.mock("./api-client", () => ({ apiFetch: vi.fn() }));

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
    if (originalEventSource) {
      Object.defineProperty(globalThis, "EventSource", { configurable: true, writable: true, value: originalEventSource });
    } else {
      Reflect.deleteProperty(globalThis, "EventSource");
    }
    vi.clearAllMocks();
  });

  it("exposes an uncertainty banner and reconciliation action when SSE degrades", async () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    const intervalSpy = vi.spyOn(globalThis, "setInterval");
    render(<AppShell><div>Conteúdo da página</div></AppShell>);

    await screen.findByRole("navigation", { name: "Navegação principal" });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];
    act(() => source.triggerNamed("diagnostic.updated"));
    expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({ type: "cvg:realtime-updated" }));
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
    expect(screen.getByRole("link", { name: "Visão geral" })).toHaveAttribute("aria-current", "page");
    expect(navigation.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Central de exames" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "Central de exames" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Notificações" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Meus pacientes" })).toHaveAttribute("href", "/patients");
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
    expect(screen.getByRole("link", { name: "Central de exames" })).toHaveAttribute("href", "/queues");
    expect(screen.getByRole("link", { name: "Solicitações" })).toHaveAttribute("href", "/management?view=requests");
    expect(screen.getByRole("link", { name: "Pendências" })).toHaveAttribute("href", "/management?view=pending");
    expect(screen.getByRole("link", { name: "Estatísticas" })).toHaveAttribute("href", "/management?view=stats");
    expect(screen.getByRole("link", { name: "Acessos" })).toHaveAttribute("href", "/admin#users");
    expect(screen.getByRole("link", { name: "Catálogos" })).toHaveAttribute("href", "/admin#catalog");
    expect(screen.getByRole("link", { name: "Auditoria" })).toHaveAttribute("href", "/admin#audit");
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
    expect(screen.getByRole("link", { name: "Visão geral" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Administração" })).toHaveAttribute("href", "/admin");
    expect(screen.queryByRole("link", { name: "Central de exames" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Meus pacientes" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Indicadores" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Notificações" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Abrir notificações" })).not.toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: "Sair" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/session/logout", expect.objectContaining({ method: "POST" })));
    expect(replace).toHaveBeenCalledWith("/login");
  });
});
