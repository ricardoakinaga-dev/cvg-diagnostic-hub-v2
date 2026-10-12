/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PatientList } from "./patient-list";
import * as apiClient from "./api-client";
import { ApiClientError } from "./api-client";

vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) => <a {...props}>{children}</a>
}));

const patient = { id: "patient-1", displayName: "Thor", species: "Canino", breed: "Labrador", sex: "Macho", externalId: "HIS-THOR", ownerLabel: "Ana", active: true };

describe("PatientList", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it.each([401, 403, 404])("removes previously visible patients when the native patient read is denied with %s", async (status) => {
    let denied = false;
    vi.spyOn(apiClient, "apiFetch").mockImplementation(async (path) => {
      if (path === "/session/me") return { user: { id: "reader", role: "VIEWER", permissions: ["patient.view"] } } as never;
      if (denied) throw new ApiClientError(status, {});
      return [patient] as never;
    });
    render(<PatientList />); await screen.findByRole("link", { name: /Thor/ });
    denied = true; fireEvent.change(screen.getByRole("textbox", { name: "Buscar pacientes" }), { target: { value: "thor" } });
    await screen.findByRole("alert"); expect(screen.queryByRole("link", { name: /Thor/ })).not.toBeInTheDocument();
  });

  it("removes patient data on resync when patient.view is withdrawn even if the old read would succeed", async () => {
    let revoked = false;
    const api = vi.spyOn(apiClient, "apiFetch").mockImplementation(async (path) => path === "/session/me" ? { user: { id: "reader", role: "VETERINARIAN", permissions: revoked ? [] : ["patient.view"] } } as never : [patient] as never);
    render(<PatientList />); await screen.findByRole("link", { name: /Thor/ });
    revoked = true; fireEvent(window, new Event("cvg:realtime-resync"));
    expect(screen.queryByRole("link", { name: /Thor/ })).not.toBeInTheDocument();
    await screen.findByRole("alert"); expect(screen.queryByRole("link", { name: /Thor/ })).not.toBeInTheDocument();
    expect(api.mock.calls.filter(([path]) => path.startsWith("/patients?"))).toHaveLength(1);
  });

  it("ignores an old patient read after a newer resync has removed read authority", async () => {
    let stage = 0; let resolveOld!: (value: unknown) => void;
    const api = vi.spyOn(apiClient, "apiFetch").mockImplementation(async (path) => {
      if (path === "/session/me") return { user: { id: "reader", role: "VIEWER", permissions: stage === 2 ? [] : ["patient.view"] } } as never;
      return stage === 1 ? new Promise((resolve) => { resolveOld = resolve; }) as never : [patient] as never;
    });
    render(<PatientList />); await screen.findByRole("link", { name: /Thor/ });
    stage = 1; fireEvent(window, new Event("cvg:realtime-resync"));
    await waitFor(() => expect(api.mock.calls.filter(([path]) => path.startsWith("/patients?"))).toHaveLength(2));
    stage = 2; fireEvent(window, new Event("cvg:realtime-resync")); await screen.findByRole("alert");
    await act(async () => { resolveOld([patient]); });
    expect(screen.queryByRole("link", { name: /Thor/ })).not.toBeInTheDocument(); expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("preserves an authorized snapshot only for a temporary patient-read outage", async () => {
    let outage = false;
    vi.spyOn(apiClient, "apiFetch").mockImplementation(async (path) => {
      if (path === "/session/me") return { user: { id: "reader", role: "VIEWER", permissions: ["patient.view"] } } as never;
      if (outage) throw new ApiClientError(503, {});
      return [patient] as never;
    });
    render(<PatientList />); await screen.findByRole("link", { name: /Thor/ });
    outage = true; fireEvent.change(screen.getByRole("textbox", { name: "Buscar pacientes" }), { target: { value: "thor" } });
    await screen.findByRole("alert"); expect(screen.getByRole("link", { name: /Thor/ })).toBeInTheDocument();
    outage = false; fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it.each(["VETERINARIAN", "INPATIENT_TEAM", "SUPERADMIN"])("keeps readable patients without offering creation to reduced %s", async (role) => {
    const api = vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => Promise.resolve(path === "/session/me" ? { user: { role, permissions: ["patient.view"] } } : [patient]) as never);
    render(<PatientList />);
    await screen.findByRole("link", { name: /Thor/ });
    expect(screen.queryByRole("button", { name: /Novo paciente/ })).not.toBeInTheDocument();
    expect(api.mock.calls.some(([, init]) => init?.method)).toBe(false);
  });

  it("blocks an open patient composer while resync revalidates and withdraws its grant", async () => {
    let resolveIdentity!: (value: unknown) => void;
    let refreshing = false;
    vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => {
      if (path === "/session/me") return refreshing ? new Promise((resolve) => { resolveIdentity = resolve; }) as never : Promise.resolve({ user: { role: "VETERINARIAN", permissions: ["patient.view", "patient.create"] } }) as never;
      return Promise.resolve([patient]) as never;
    });
    render(<PatientList />); fireEvent.click(await screen.findByRole("button", { name: /Novo paciente/ }));
    expect(screen.getByRole("dialog", { name: "Cadastrar paciente" })).toBeInTheDocument();
    refreshing = true; fireEvent(window, new Event("cvg:realtime-resync"));
    expect(screen.queryByRole("button", { name: /Novo paciente/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Cadastrar paciente" })).not.toBeInTheDocument();
    await act(async () => { resolveIdentity({ user: { role: "VETERINARIAN", permissions: ["patient.view"] } }); });
    expect(screen.queryByRole("button", { name: /Novo paciente/ })).not.toBeInTheDocument();
    expect(await screen.findByRole("link", { name: /Thor/ })).toBeInTheDocument();
  });

  it.each(["VETERINARIAN", "SUPERADMIN"])("loads scoped patients and opens creation for %s", async (role) => {
    const apiFetchMock = vi.spyOn(apiClient, "apiFetch").mockImplementation((path, init) => {
      if (path === "/session/me") return Promise.resolve({ user: { role, permissions: ["patient.view", "patient.create"] } }) as never;
      if (path === "/patients" && init?.method === "POST") return Promise.resolve({ patient, encounter: { id: "encounter-1" } }) as never;
      return Promise.resolve([patient]) as never;
    });

    render(<PatientList />);

    expect(await screen.findByRole("link", { name: /Thor/ })).toHaveAttribute("href", "/patients/patient-1/diagnostics");
    fireEvent.change(screen.getByRole("textbox", { name: "Buscar pacientes" }), { target: { value: "thor" } });
    fireEvent.click(screen.getByRole("button", { name: /Novo paciente/ }));
    expect(screen.getByRole("dialog", { name: "Cadastrar paciente" })).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("Ex.: Amora"), { target: { value: "Amora" } });
    fireEvent.change(screen.getByPlaceholderText("Ex.: Canino"), { target: { value: "Canino" } });
    fireEvent.change(screen.getByPlaceholderText("Nome para identificação no atendimento"), { target: { value: "Joana" } });
    fireEvent.click(screen.getByRole("button", { name: /Confirmar cadastro de paciente/ }));

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith("/patients", expect.objectContaining({ method: "POST" })));
    const createCall = apiFetchMock.mock.calls.find(([path, init]) => path === "/patients" && init?.method === "POST");
    expect(JSON.parse(createCall?.[1]?.body as string)).toMatchObject({ displayName: "Amora", species: "Canino", ownerLabel: "Joana", breed: "Não informado", sex: "Não informado", encounterType: "OUTPATIENT" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Cadastrar paciente" })).not.toBeInTheDocument());
  });

  it("closes the scoped creation dialog without creating a record", async () => {
    vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => {
      if (path === "/session/me") return Promise.resolve({ user: { role: "INPATIENT_TEAM", permissions: ["patient.view", "patient.create"] } }) as never;
      return Promise.resolve([patient]) as never;
    });

    render(<PatientList />);
    fireEvent.click(await screen.findByRole("button", { name: /Novo paciente/ }));
    fireEvent.click(screen.getByRole("button", { name: "Fechar cadastro de paciente" }));

    expect(screen.queryByRole("dialog", { name: "Cadastrar paciente" })).not.toBeInTheDocument();
  });

  it.each(["VIEWER", "ADMIN"])("keeps an empty state and denies creation for %s", async (role) => {
    vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => {
      if (path === "/session/me") return Promise.resolve({ user: { role, permissions: ["patient.view", "patient.create"] } }) as never;
      return Promise.resolve([]) as never;
    });

    render(<PatientList />);

    expect(await screen.findByText("Nenhum paciente atribuído")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Novo paciente/ })).not.toBeInTheDocument();
  });

  it("keeps the newest search result when an older query resolves later", async () => {
    const pending: Array<{ path: string; resolve: (value: unknown) => void }> = [];
    const apiFetchMock = vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => {
      if (path === "/session/me") return Promise.resolve({ user: { role: "VIEWER", permissions: ["patient.view"] } }) as never;
      return new Promise((resolve) => { pending.push({ path, resolve }); }) as never;
    });

    render(<PatientList />);
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith("/patients?q="));
    fireEvent.change(screen.getByRole("textbox", { name: "Buscar pacientes" }), { target: { value: "thor" } });
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith("/patients?q=thor"));

    await act(async () => {
      pending.find(({ path }) => path === "/patients?q=thor")?.resolve([{ ...patient, displayName: "Mel" }]);
    });
    expect(await screen.findByRole("link", { name: /Mel/ })).toBeInTheDocument();

    await act(async () => {
      pending.find(({ path }) => path === "/patients?q=")?.resolve([patient]);
    });
    expect(screen.getByRole("link", { name: /Mel/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Thor/ })).not.toBeInTheDocument();
  });

  it("shows a safe load failure and recovers through the retry action", async () => {
    let attempts = 0;
    let resolveRetry!: (value: typeof patient[]) => void;
    const apiFetchMock = vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => {
      if (path === "/session/me") return Promise.resolve({ user: { role: "VIEWER", permissions: ["patient.view"] } }) as never;
      attempts += 1;
      if (attempts === 1) return Promise.reject(new Error("private patient storage detail"));
      return new Promise((resolve) => { resolveRetry = resolve; }) as never;
    });

    render(<PatientList />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível carregar os pacientes.");
    expect(screen.queryByText("private patient storage detail")).not.toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Carregando pacientes" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Carregando pacientes" })).toHaveAttribute("aria-busy", "true");
    await waitFor(() => expect(apiFetchMock.mock.calls.filter(([path]) => path === "/patients?q=")).toHaveLength(2));
    await act(async () => { resolveRetry([patient]); });

    expect(screen.getByRole("link", { name: /Thor/ })).toHaveAttribute("href", "/patients/patient-1/diagnostics");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Carregando pacientes" })).not.toBeInTheDocument();
    expect(apiFetchMock.mock.calls.filter(([path]) => path === "/patients?q=")).toHaveLength(2);
  });

  it("ignores a failed obsolete search while the newest search is still loading", async () => {
    let rejectOld!: (reason: Error) => void;
    let resolveLatest!: (value: typeof patient[]) => void;
    const apiFetchMock = vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => {
      if (path === "/session/me") return Promise.resolve({ user: { role: "VIEWER", permissions: ["patient.view"] } }) as never;
      if (path === "/patients?q=") return new Promise((_resolve, reject) => { rejectOld = reject; }) as never;
      return new Promise((resolve) => { resolveLatest = resolve; }) as never;
    });

    render(<PatientList />);
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith("/patients?q="));
    fireEvent.change(screen.getByRole("textbox", { name: "Buscar pacientes" }), { target: { value: "Thor & Ana" } });
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith("/patients?q=Thor%20%26%20Ana"));
    await act(async () => { rejectOld(new Error("obsolete search failed")); });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Carregando pacientes" })).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText("Nenhum paciente atribuído")).not.toBeInTheDocument();
    await act(async () => { resolveLatest([patient]); });
    expect(screen.getByRole("link", { name: /Thor/ })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Carregando pacientes" })).not.toBeInTheDocument();
  });

  it("blocks patient data and creation when the identity lookup fails", async () => {
    vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => {
      if (path === "/session/me") return Promise.reject(new Error("session unavailable"));
      return Promise.resolve([patient]) as never;
    });

    render(<PatientList />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível carregar os pacientes.");
    expect(screen.queryByRole("link", { name: /Thor/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Novo paciente/ })).not.toBeInTheDocument();
    expect(screen.queryByText("session unavailable")).not.toBeInTheDocument();
  });
});
