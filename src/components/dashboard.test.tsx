/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardService } from "@cvg/contracts";
import { Dashboard, RequestDialog } from "./dashboard";
import * as apiClient from "./api-client";

vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) => <a {...props}>{children}</a>,
}));

const request = {
  id: "request-1",
  requestCode: "REQ-0001",
  patient: { displayName: "Thor", species: "Canino", sex: "M", externalId: "TH-001" },
  priority: "ROUTINE" as const,
  aggregateStatus: "IN_PROGRESS",
  createdAt: "2026-08-20T13:50:00.000Z",
  items: [{
    id: "item-1",
    status: "IN_PROGRESS" as const,
    priority: "ROUTINE" as const,
    dueAt: "2026-08-20T18:00:00.000Z",
    service: { name: "Hemograma", code: "HEMOGRAM" },
  }],
};

const stats = {
  overdue: 2,
  recollections: 1,
  newResults: 3,
  critical: 0,
  totalActive: 4,
  updatedAt: "2026-08-20T14:00:00.000Z",
};

const notifications = [{
  id: "notification-1",
  category: "ACTIONABLE",
  priority: "HIGH",
  title: "Amostra recebida",
  body: "A amostra de Thor aguarda processamento.",
  createdAt: "2026-08-20T13:58:00.000Z",
  state: "UNREAD",
  deepLink: "/requests/request-1",
}];

const services: DashboardService[] = [{
  id: "service-1",
  name: "Hemograma",
  code: "HEMOGRAM",
  workflowType: "LABORATORY",
  category: "LABORATORY",
  requiresSample: true,
  requiresSchedule: false,
}];

const patients = [{ id: "patient-thor", displayName: "Thor", species: "Canino", externalId: "HIS-THOR-001" }];

const encounters = [{
  id: "encounter-thor-2",
  patientId: "patient-thor",
  externalId: "ATD-THOR-002",
  type: "OUTPATIENT",
  status: "OPEN",
  openedAt: "2026-08-20T14:00:00.000Z",
}];

function mockDashboardResponses(override?: (path: string, init?: RequestInit) => Promise<unknown> | undefined) {
  return vi.spyOn(apiClient, "apiFetch").mockImplementation((path, init) => {
    const overridden = override?.(path, init);
    if (overridden) return overridden as never;
    if (path.startsWith("/diagnostic-requests")) return Promise.resolve(requestsValue()) as never;
    if (path === "/dashboard") return Promise.resolve(stats) as never;
    if (path.startsWith("/notifications")) return Promise.resolve(notifications) as never;
    if (path === "/diagnostic-services") return Promise.resolve(services) as never;
    if (path === "/session/me") return Promise.resolve({ user: { displayName: "Ana Silva" } }) as never;
    if (path === "/patients") return Promise.resolve(patients) as never;
    return Promise.reject(new Error("unexpected request")) as never;
  });
}

function requestsValue() {
  return [request];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function renderRequestDialog() {
  const onCreated = vi.fn();
  return {
    ...render(<RequestDialog canCreatePatient services={services} servicesError={null} onRetryServices={async () => {}} onClose={vi.fn()} onCreated={onCreated} />),
    onCreated,
  };
}

describe("RequestDialog patient search", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("finds and submits an authorized patient beyond the first 100 using an encoded server query", async () => {
    const first100 = Array.from({ length: 100 }, (_, index) => ({ ...patients[0], id: `patient-${index}`, displayName: `Paciente ${index}` }));
    const remotePatient = { ...patients[0], id: "patient-101", displayName: "Amora & 101", externalId: "HIS-101" };
    const remoteEncounter = { ...encounters[0], id: "encounter-101", patientId: remotePatient.id, externalId: "ATD-101" };
    const lookup = deferred<typeof patients>();
    const apiFetchMock = mockDashboardResponses((path, init) => {
      if (path === "/patients") return Promise.resolve(first100);
      if (path === "/patients?q=Amora%20%26%20101") return lookup.promise;
      if (path === "/patients/patient-101/encounters") return Promise.resolve([remoteEncounter]);
      if (path === "/diagnostic-requests" && init?.method === "POST") return Promise.resolve({ id: "request-101" });
      return undefined;
    });
    const { onCreated } = renderRequestDialog();

    const select = screen.getByRole("combobox", { name: "Paciente" });
    await waitFor(() => expect(select).toBeEnabled());
    expect(within(select).getAllByRole("option")).toHaveLength(101);
    expect(screen.queryByRole("option", { name: /Amora & 101/ })).not.toBeInTheDocument();
    const search = screen.getByRole("searchbox", { name: "Buscar pacientes" });
    expect(search).toHaveAttribute("aria-controls", select.id);
    fireEvent.change(search, { target: { value: "Amora & 101" } });
    expect(screen.getByText("Carregando pacientes…")).toHaveAttribute("role", "status");
    expect(select).toBeDisabled();
    expect(select).toHaveAttribute("aria-busy", "true");
    expect(search).toBeEnabled();
    const searchCall = apiFetchMock.mock.calls.find(([path]) => path === "/patients?q=Amora%20%26%20101");
    expect(searchCall?.[1]?.signal).toBeInstanceOf(AbortSignal);

    await act(async () => lookup.resolve([remotePatient]));
    expect(select).toBeEnabled();
    expect(within(select).getAllByRole("option")).toHaveLength(2);
    fireEvent.change(select, { target: { value: remotePatient.id } });
    await screen.findByRole("option", { name: /ATD-101/ });
    fireEvent.change(screen.getByLabelText("Atendimento"), { target: { value: remoteEncounter.id } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Hemograma/ }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar solicitação" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
    const createCall = apiFetchMock.mock.calls.find(([path, init]) => path === "/diagnostic-requests" && init?.method === "POST");
    expect(JSON.parse(createCall?.[1]?.body as string)).toEqual({ patientId: remotePatient.id, encounterId: remoteEncounter.id, priority: "ROUTINE", items: [{ serviceId: "service-1" }] });
    expect(createCall?.[1]?.headers).toMatchObject({ "x-correlation-id": expect.stringMatching(/^ui-/) });
  });

  it("announces an initial loading failure, disables choices and retries without fabricating a patient", async () => {
    let attempts = 0;
    const apiFetchMock = mockDashboardResponses((path) => {
      if (path === "/patients") {
        attempts += 1;
        return attempts === 1 ? Promise.reject(new Error("private patient SQL")) : Promise.resolve(patients);
      }
      return undefined;
    });
    renderRequestDialog();

    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível carregar os pacientes.");
    expect(screen.queryByText("private patient SQL")).not.toBeInTheDocument();
    const select = screen.getByRole("combobox", { name: "Paciente" });
    expect(select).toBeDisabled();
    expect(within(select).getAllByRole("option")).toHaveLength(1);
    expect(select).toHaveValue("");
    expect(screen.getByLabelText("Atendimento")).toBeDisabled();
    expect(screen.getByRole("searchbox", { name: "Buscar pacientes" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Confirmar solicitação" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Confirmar solicitação" }));
    expect(apiFetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Tentar carregar pacientes" }));
    await waitFor(() => expect(select).toBeEnabled());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Thor · Canino · HIS-THOR-001/ })).toBeInTheDocument();
    expect(attempts).toBe(2);
  });

  it("retries the current query and preserves the selected patient and encounter across errors, empty results and clearing", async () => {
    let attempts = 0;
    const apiFetchMock = mockDashboardResponses((path) => {
      if (path === "/patients/patient-thor/encounters") return Promise.resolve(encounters);
      if (path === "/patients?q=ausente") {
        attempts += 1;
        return attempts === 1 ? Promise.reject(new Error("private search detail")) : Promise.resolve([]);
      }
      return undefined;
    });
    renderRequestDialog();
    const select = screen.getByRole("combobox", { name: "Paciente" });
    await waitFor(() => expect(select).toBeEnabled());
    fireEvent.change(select, { target: { value: "patient-thor" } });
    await screen.findByRole("option", { name: /ATD-THOR-002/ });
    const encounterSelect = screen.getByLabelText("Atendimento");
    fireEvent.change(encounterSelect, { target: { value: "encounter-thor-2" } });
    const search = screen.getByRole("searchbox", { name: "Buscar pacientes" });
    fireEvent.change(search, { target: { value: "ausente" } });

    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível carregar os pacientes.");
    expect(screen.queryByText("private search detail")).not.toBeInTheDocument();
    expect(select).toBeDisabled();
    expect(encounterSelect).toBeDisabled();
    expect(select).toHaveValue("patient-thor");
    expect(encounterSelect).toHaveValue("encounter-thor-2");
    fireEvent.click(screen.getByRole("button", { name: "Tentar carregar pacientes" }));
    await screen.findByText("Nenhum paciente encontrado para esta busca.");
    expect(select).toBeEnabled();
    expect(encounterSelect).toBeEnabled();
    expect(within(select).getAllByRole("option")).toHaveLength(2);
    expect(select).toHaveValue("patient-thor");
    expect(encounterSelect).toHaveValue("encounter-thor-2");
    expect(attempts).toBe(2);

    fireEvent.change(search, { target: { value: "" } });
    await waitFor(() => expect(select).toBeEnabled());
    expect(select).toHaveValue("patient-thor");
    expect(encounterSelect).toHaveValue("encounter-thor-2");
    expect(within(select).getAllByRole("option")).toHaveLength(2);
    expect(apiFetchMock.mock.calls.filter(([path]) => path === "/patients")).toHaveLength(2);
    expect(apiFetchMock.mock.calls.filter(([path]) => path.endsWith("/encounters"))).toHaveLength(1);
    fireEvent.change(select, { target: { value: "" } });
    expect(encounterSelect).toHaveValue("");
    expect(encounterSelect).toBeDisabled();
  });

  it("ignores stale success, rejection and completion while keeping selection until the patient actually changes", async () => {
    const initial = deferred<typeof patients>();
    const slow = deferred<typeof patients>();
    const latest = deferred<typeof patients>();
    const thorEncounters = deferred<typeof encounters>();
    const amora = { ...patients[0], id: "patient-amora", displayName: "Amora" };
    const amoraEncounter = { ...encounters[0], id: "encounter-amora", patientId: amora.id, externalId: "ATD-AMORA" };
    const apiFetchMock = mockDashboardResponses((path) => {
      if (path === "/patients") return initial.promise;
      if (path === "/patients?q=slow") return slow.promise;
      if (path === "/patients?q=amora") return latest.promise;
      if (path === "/patients?q=thor") return Promise.resolve(patients);
      if (path === "/patients/patient-amora/encounters") return Promise.resolve([amoraEncounter]);
      if (path === "/patients/patient-thor/encounters") return thorEncounters.promise;
      return undefined;
    });
    renderRequestDialog();
    const search = screen.getByRole("searchbox", { name: "Buscar pacientes" });
    const select = screen.getByRole("combobox", { name: "Paciente" });
    const initialSignal = apiFetchMock.mock.calls.find(([path]) => path === "/patients")?.[1]?.signal;
    fireEvent.change(search, { target: { value: "slow" } });
    const slowSignal = apiFetchMock.mock.calls.find(([path]) => path === "/patients?q=slow")?.[1]?.signal;
    fireEvent.change(search, { target: { value: "amora" } });
    expect(initialSignal?.aborted).toBe(true);
    expect(slowSignal?.aborted).toBe(true);
    await act(async () => slow.reject(new Error("stale private failure")));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(select).toBeDisabled();
    expect(select).toHaveAttribute("aria-busy", "true");

    await act(async () => latest.resolve([amora]));
    fireEvent.change(select, { target: { value: amora.id } });
    await screen.findByRole("option", { name: /ATD-AMORA/ });
    const encounterSelect = screen.getByLabelText("Atendimento");
    fireEvent.change(encounterSelect, { target: { value: amoraEncounter.id } });
    await act(async () => initial.resolve(patients));
    expect(screen.queryByRole("option", { name: /Thor · Canino/ })).not.toBeInTheDocument();
    expect(select).toHaveValue(amora.id);
    expect(encounterSelect).toHaveValue(amoraEncounter.id);

    fireEvent.change(search, { target: { value: "thor" } });
    await waitFor(() => expect(select).toBeEnabled());
    expect(select).toHaveValue(amora.id);
    expect(encounterSelect).toHaveValue(amoraEncounter.id);
    expect(screen.getByRole("option", { name: /Amora · Canino/ })).toBeInTheDocument();
    expect(apiFetchMock.mock.calls.filter(([path]) => path.endsWith("/encounters"))).toHaveLength(1);
    fireEvent.change(select, { target: { value: "patient-thor" } });
    expect(encounterSelect).toHaveValue("");
    expect(encounterSelect).toBeDisabled();
    expect(screen.queryByRole("option", { name: /ATD-AMORA/ })).not.toBeInTheDocument();
    await act(async () => thorEncounters.resolve(encounters));
    expect(encounterSelect).toBeEnabled();
    expect(encounterSelect).toHaveValue("");
    expect(screen.getByRole("option", { name: /ATD-THOR-002/ })).toBeInTheDocument();
  });

  it.each(["resolve", "reject"] as const)("aborts on unmount and ignores a late %s when a fresh dialog opens", async (completion) => {
    const pending = deferred<typeof patients>();
    const apiFetchMock = mockDashboardResponses((path) => path === "/patients?q=slow" ? pending.promise : undefined);
    const { unmount } = renderRequestDialog();
    await waitFor(() => expect(screen.getByLabelText("Paciente")).toBeEnabled());
    fireEvent.change(screen.getByRole("searchbox", { name: "Buscar pacientes" }), { target: { value: "slow" } });
    const signal = apiFetchMock.mock.calls.find(([path]) => path === "/patients?q=slow")?.[1]?.signal;
    expect(signal?.aborted).toBe(false);
    unmount();
    expect(signal?.aborted).toBe(true);
    renderRequestDialog();
    await waitFor(() => expect(screen.getByLabelText("Paciente")).toBeEnabled());

    await act(async () => {
      if (completion === "resolve") pending.resolve([{ ...patients[0], id: "stale-patient", displayName: "Stale" }]);
      else pending.reject(new Error("late private failure"));
    });
    expect(screen.getByLabelText("Paciente")).toHaveValue("");
    expect(screen.getByRole("option", { name: /Thor · Canino/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Stale/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("Dashboard resilience", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-20T14:05:00.000Z"));
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("keeps successful blocks visible when the indicators request fails and retries only that block", async () => {
    let statsAttempts = 0;
    vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => {
      if (path.startsWith("/diagnostic-requests")) return Promise.resolve(requestsValue()) as never;
      if (path === "/dashboard") {
        statsAttempts += 1;
        return statsAttempts === 1 ? Promise.reject(new Error("database connection string")) as never : Promise.resolve({ ...stats, overdue: 7 }) as never;
      }
      if (path.startsWith("/notifications")) return Promise.resolve(notifications) as never;
      if (path === "/diagnostic-services") return Promise.resolve(services) as never;
      if (path === "/session/me") return Promise.resolve({ user: { displayName: "Ana Silva" } }) as never;
      return Promise.reject(new Error("unexpected request")) as never;
    });

    render(<Dashboard />);

    expect(await screen.findByText("Thor")).toBeInTheDocument();
    expect(screen.getByText("Amostra recebida")).toBeInTheDocument();
    expect(screen.getByText("Não foi possível atualizar os indicadores.")).toBeInTheDocument();
    expect(screen.queryByText("database connection string")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente: indicadores" }));

    await waitFor(() => expect(screen.getByText("7")).toBeInTheDocument());
    expect(screen.queryByText("Não foi possível atualizar os indicadores.")).not.toBeInTheDocument();
    expect(statsAttempts).toBe(2);
  });

  it("shows the technical administration landing without requesting clinical resources for ADMIN", async () => {
    const apiFetchMock = vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => {
      if (path === "/session/me") return Promise.resolve({ user: { displayName: "Administração Técnica", role: "ADMIN" } }) as never;
      return Promise.reject(new Error(`unexpected request: ${path}`)) as never;
    });

    render(<Dashboard />);

    expect(await screen.findByRole("heading", { name: /Administração técnica/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Abrir administração/ })).toHaveAttribute("href", "/admin");
    expect(screen.queryByText("Você não tem acesso a este recurso.")).not.toBeInTheDocument();
    expect(apiFetchMock.mock.calls.map(([path]) => path)).toEqual(["/session/me"]);
  });

  it("supports scoped search navigation, realtime resync and closing a request dialog", async () => {
    const apiFetchMock = mockDashboardResponses((path) => {
      if (path === "/search?q=thor") return Promise.resolve([{ id: "search-1", label: "EX-0001", patient: "Thor", deepLink: "#request-1", status: "Em execução" }]);
      return undefined;
    });

    render(<Dashboard />);
    await screen.findByText("Amostra recebida");
    fireEvent.change(screen.getByRole("combobox", { name: "Buscar no Hub" }), { target: { value: "thor" } });
    expect(await screen.findByText("EX-0001")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: /EX-0001/ }));
    expect(screen.getByRole("combobox", { name: "Buscar no Hub" })).toHaveValue("");

    fireEvent(window, new Event("cvg:realtime-resync"));
    await waitFor(() => expect(apiFetchMock.mock.calls.filter(([path]) => path === "/dashboard")).toHaveLength(2));

    fireEvent.click(screen.getByRole("button", { name: /Nova solicitação/i }));
    const dialog = await screen.findByRole("dialog", { name: "Solicitar exames" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Fechar" }));
    expect(screen.queryByRole("dialog", { name: "Solicitar exames" })).not.toBeInTheDocument();
  });

  it("implements the search shortcut and keyboard combobox navigation", async () => {
    const apiFetchMock = mockDashboardResponses((path) => {
      if (path === "/search?q=thor") return Promise.resolve([
        { id: "search-1", label: "EX-0001", patient: "Thor", deepLink: "#request-1", status: "IN_PROGRESS" },
        { id: "search-2", label: "EX-0002", patient: "Thor", deepLink: "#request-2", status: "RESULTS_AVAILABLE" }
      ]);
      return undefined;
    });

    render(<Dashboard />);
    await screen.findByText("Amostra recebida");
    const input = screen.getByRole("combobox", { name: "Buscar no Hub" });
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(document.activeElement).toBe(input);

    fireEvent.change(input, { target: { value: "thor" } });
    const listbox = await screen.findByRole("listbox", { name: "Resultados da busca" });
    expect(input).toHaveAttribute("aria-controls", listbox.id);
    expect(input).toHaveAttribute("aria-expanded", "true");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", "clinical-dashboard-search-result-0");
    expect(screen.getByRole("option", { name: /EX-0001/ })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input).toHaveValue("");
    expect(apiFetchMock.mock.calls.some(([path]) => path === "/search?q=thor")).toBe(true);
  });

  it("keeps stale data and its last update timestamp visible after a refresh failure", async () => {
    let statsAttempts = 0;
    vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => {
      if (path.startsWith("/diagnostic-requests")) return Promise.resolve(requestsValue()) as never;
      if (path === "/dashboard") {
        statsAttempts += 1;
        return statsAttempts === 1 ? Promise.resolve(stats) as never : Promise.reject(new Error("private server detail")) as never;
      }
      if (path.startsWith("/notifications")) return Promise.resolve(notifications) as never;
      if (path === "/diagnostic-services") return Promise.resolve(services) as never;
      if (path === "/session/me") return Promise.resolve({ user: { displayName: "Ana Silva" } }) as never;
      return Promise.reject(new Error("unexpected request")) as never;
    });

    render(<Dashboard />);
    expect(await screen.findByText("Amostra recebida")).toBeInTheDocument();

    fireEvent(window, new Event("cvg:realtime-updated"));

    await waitFor(() => expect(screen.getByText("Dados possivelmente desatualizados")).toBeInTheDocument());
    expect(screen.getByText("Leitura parcial")).toBeInTheDocument();
    expect(screen.getAllByText("Atualizado há 5 min").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.queryByText("private server detail")).not.toBeInTheDocument();
  });

  it("loads encounters for the selected patient and submits the chosen encounter id", async () => {
    let resolveEncounters!: (value: typeof encounters) => void;
    const pendingEncounters = new Promise<typeof encounters>((resolve) => { resolveEncounters = resolve; });
    const apiFetchMock = mockDashboardResponses((path, init) => {
      if (path === "/patients/patient-thor/encounters") return pendingEncounters;
      if (path === "/diagnostic-requests" && init?.method === "POST") return Promise.resolve({ id: "request-created" });
      return undefined;
    });

    render(<Dashboard />);
    await screen.findByText("Amostra recebida");
    fireEvent.click(screen.getByRole("button", { name: /Nova solicitação/i }));

    fireEvent.change(await screen.findByLabelText("Paciente"), { target: { value: "patient-thor" } });
    expect(screen.getByText("Carregando atendimentos…")).toBeInTheDocument();
    resolveEncounters(encounters);
    expect(await screen.findByText("ATD-THOR-002 · Atendimento externo · Em aberto")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Atendimento"), { target: { value: "encounter-thor-2" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Hemograma/i }));
    fireEvent.click(screen.getByRole("button", { name: /Confirmar solicitação/i }));

    await waitFor(() => expect(apiFetchMock.mock.calls.some(([path, init]) => path === "/diagnostic-requests" && init?.method === "POST")).toBe(true));
    const createCall = apiFetchMock.mock.calls.find(([path, init]) => path === "/diagnostic-requests" && init?.method === "POST");
    expect(JSON.parse(createCall?.[1]?.body as string)).toMatchObject({ encounterId: "encounter-thor-2" });
  });

  it("adds a new patient from the request dialog and keeps its encounter selected", async () => {
    const pendingSearch = deferred<typeof patients>();
    const createdPatient = {
      patient: { id: "patient-amora", displayName: "Amora", species: "Canino", breed: "Não informado", sex: "Não informado", ownerLabel: "M. Ribeiro", externalId: "CVG-AMORA", active: true },
      encounter: { id: "encounter-amora", patientId: "patient-amora", externalId: "ATD-AMORA", type: "OUTPATIENT", status: "OPEN", openedAt: "2026-08-20T14:00:00.000Z" }
    };
    const apiFetchMock = mockDashboardResponses((path, init) => {
      if (path === "/patients" && init?.method === "POST") return Promise.resolve(createdPatient);
      if (path === "/patients?q=thor") return pendingSearch.promise;
      if (path === "/patients?q=ausente") return Promise.resolve([]);
      if (path === "/diagnostic-requests" && init?.method === "POST") return Promise.resolve({ id: "request-amora" });
      return undefined;
    });

    render(<Dashboard />);
    await screen.findByText("Amostra recebida");
    fireEvent.click(screen.getByRole("button", { name: /Nova solicitação/i }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Buscar pacientes" }), { target: { value: "thor" } });
    fireEvent.click(screen.getByRole("button", { name: /Cadastrar paciente/i }));

    fireEvent.change(screen.getByPlaceholderText("Ex.: Amora"), { target: { value: "Amora" } });
    fireEvent.change(screen.getByPlaceholderText("Ex.: Canino"), { target: { value: "Canino" } });
    fireEvent.change(screen.getByPlaceholderText("Nome para identificação no atendimento"), { target: { value: "M. Ribeiro" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar cadastro de paciente" }));

    await waitFor(() => expect(screen.getByLabelText("Paciente")).toHaveValue("patient-amora"));
    const patientCall = apiFetchMock.mock.calls.find(([path, init]) => path === "/patients" && init?.method === "POST");
    expect(JSON.parse(patientCall?.[1]?.body as string)).toMatchObject({ displayName: "Amora", species: "Canino", ownerLabel: "M. Ribeiro", breed: "Não informado", sex: "Não informado", encounterType: "OUTPATIENT" });
    expect(screen.getByRole("option", { name: /Amora · Canino · CVG-AMORA/ })).toBeInTheDocument();
    expect(screen.getByLabelText("Atendimento")).toHaveValue("encounter-amora");
    await act(async () => pendingSearch.resolve(patients));
    expect(screen.getByLabelText("Paciente")).toHaveValue("patient-amora");
    expect(screen.getByLabelText("Atendimento")).toHaveValue("encounter-amora");
    fireEvent.change(screen.getByRole("searchbox", { name: "Buscar pacientes" }), { target: { value: "ausente" } });
    await screen.findByText("Nenhum paciente encontrado para esta busca.");
    expect(screen.getByLabelText("Paciente")).toHaveValue("patient-amora");
    expect(screen.getByLabelText("Atendimento")).toHaveValue("encounter-amora");
    expect(screen.getByRole("option", { name: /Amora · Canino · CVG-AMORA/ })).toBeInTheDocument();
    expect(apiFetchMock.mock.calls.some(([path]) => path.endsWith("/encounters"))).toBe(false);
    fireEvent.click(screen.getByRole("checkbox", { name: /Hemograma/i }));
    fireEvent.click(screen.getByRole("button", { name: /Confirmar solicitação/i }));

    await waitFor(() => expect(apiFetchMock.mock.calls.some(([path, init]) => path === "/diagnostic-requests" && init?.method === "POST")).toBe(true));
    const requestCall = apiFetchMock.mock.calls.find(([path, init]) => path === "/diagnostic-requests" && init?.method === "POST");
    expect(JSON.parse(requestCall?.[1]?.body as string)).toMatchObject({ patientId: "patient-amora", encounterId: "encounter-amora" });
  });

  it("requires an explicit reason before overriding a duplicate request warning", async () => {
    let createAttempts = 0;
    const apiFetchMock = mockDashboardResponses((path, init) => {
      if (path === "/patients/patient-thor/encounters") return Promise.resolve(encounters);
      if (path === "/diagnostic-requests" && init?.method === "POST") {
        createAttempts += 1;
        return createAttempts === 1
          ? Promise.reject(new apiClient.ApiClientError(409, { error: { code: "DUPLICATE_WARNING" } }))
          : Promise.resolve({ id: "request-overridden" });
      }
      return undefined;
    });

    render(<Dashboard />);
    await screen.findByText("Amostra recebida");
    fireEvent.click(screen.getByRole("button", { name: /Nova solicitação/i }));
    fireEvent.change(await screen.findByLabelText("Paciente"), { target: { value: "patient-thor" } });
    fireEvent.change(await screen.findByLabelText("Atendimento"), { target: { value: "encounter-thor-2" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Hemograma/i }));
    fireEvent.click(screen.getByRole("button", { name: /Confirmar solicitação/i }));

    expect(await screen.findByText(/Já existe um exame ativo compatível/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Confirmar duplicidade/ }));
    expect(await screen.findByText(/Explique por que o exame duplicado/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Motivo para prosseguir com a duplicidade"), { target: { value: "Exame solicitado novamente para confirmar a tendência clínica." } });
    fireEvent.click(screen.getByRole("button", { name: /Confirmar duplicidade/ }));

    await waitFor(() => expect(createAttempts).toBe(2));
    const overrideCall = apiFetchMock.mock.calls.filter(([path, init]) => path === "/diagnostic-requests" && init?.method === "POST").at(-1);
    expect(overrideCall?.[1]?.headers).toMatchObject({ "x-duplicate-override": "true" });
    expect(JSON.parse(overrideCall?.[1]?.body as string)).toMatchObject({ overrideReason: expect.stringContaining("confirmar") });
  });

  it("submits a request on a LAN origin without crypto.randomUUID", async () => {
    vi.stubGlobal("crypto", { getRandomValues: (bytes: Uint8Array) => { bytes.fill(7); return bytes; } });
    const apiFetchMock = mockDashboardResponses((path, init) => {
      if (path === "/patients/patient-thor/encounters") return Promise.resolve(encounters);
      if (path === "/diagnostic-requests" && init?.method === "POST") return Promise.resolve({ id: "request-created" });
      return undefined;
    });

    render(<Dashboard />);
    await screen.findByText("Amostra recebida");
    fireEvent.click(screen.getByRole("button", { name: /Nova solicitação/i }));
    fireEvent.change(await screen.findByLabelText("Paciente"), { target: { value: "patient-thor" } });
    fireEvent.change(await screen.findByLabelText("Atendimento"), { target: { value: "encounter-thor-2" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Hemograma/i }));
    fireEvent.click(screen.getByRole("button", { name: /Confirmar solicitação/i }));

    await waitFor(() => expect(apiFetchMock.mock.calls.some(([path, init]) => path === "/diagnostic-requests" && init?.method === "POST")).toBe(true));
    const createCall = apiFetchMock.mock.calls.find(([path, init]) => path === "/diagnostic-requests" && init?.method === "POST");
    expect((createCall?.[1]?.headers as Record<string, string>)["x-correlation-id"]).toMatch(/^ui-[0-9a-f]{32}$/);
  });

  it("shows a safe encounter loading error and retries the selected patient", async () => {
    let encounterAttempts = 0;
    mockDashboardResponses((path) => {
      if (path === "/patients/patient-thor/encounters") {
        encounterAttempts += 1;
        return encounterAttempts === 1 ? Promise.reject(new Error("private encounter query")) : Promise.resolve(encounters);
      }
      return undefined;
    });

    render(<Dashboard />);
    await screen.findByText("Amostra recebida");
    fireEvent.click(screen.getByRole("button", { name: /Nova solicitação/i }));
    fireEvent.change(await screen.findByLabelText("Paciente"), { target: { value: "patient-thor" } });

    expect(await screen.findByText("Não foi possível carregar os atendimentos.")).toBeInTheDocument();
    expect(screen.queryByText("private encounter query")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Tentar carregar atendimentos" }));
    expect(await screen.findByText("ATD-THOR-002 · Atendimento externo · Em aberto")).toBeInTheDocument();
    expect(encounterAttempts).toBe(2);
  });

  it("renders honest empty states and closes a new-request dialog without mutation", async () => {
    const apiFetchMock = mockDashboardResponses((path) => {
      if (path.startsWith("/diagnostic-requests")) return Promise.resolve([]);
      if (path.startsWith("/notifications")) return Promise.resolve([]);
      if (path === "/diagnostic-services") return Promise.resolve(services);
      return undefined;
    });

    render(<Dashboard />);
    expect(await screen.findByText("Nenhuma solicitação pendente")).toBeInTheDocument();
    expect(screen.getByText("Tudo em dia")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Nova solicitação/i }));
    expect(await screen.findByRole("dialog", { name: "Solicitar exames" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Solicitar exames" })).not.toBeInTheDocument());
    expect(apiFetchMock.mock.calls.some(([path, init]) => path === "/diagnostic-requests" && init?.method === "POST")).toBe(false);
  });
});
