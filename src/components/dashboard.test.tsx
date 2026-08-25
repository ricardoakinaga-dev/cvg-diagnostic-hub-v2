/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "./dashboard";
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

const services = [{
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
    const createdPatient = {
      patient: { id: "patient-amora", displayName: "Amora", species: "Canino", breed: "Labrador", sex: "Fêmea", ownerLabel: "M. Ribeiro", externalId: "CVG-AMORA", active: true },
      encounter: { id: "encounter-amora", patientId: "patient-amora", externalId: "ATD-AMORA", type: "OUTPATIENT", status: "OPEN", openedAt: "2026-08-20T14:00:00.000Z" }
    };
    const apiFetchMock = mockDashboardResponses((path, init) => {
      if (path === "/patients" && init?.method === "POST") return Promise.resolve(createdPatient);
      if (path === "/diagnostic-requests" && init?.method === "POST") return Promise.resolve({ id: "request-amora" });
      return undefined;
    });

    render(<Dashboard />);
    await screen.findByText("Amostra recebida");
    fireEvent.click(screen.getByRole("button", { name: /Nova solicitação/i }));
    fireEvent.click(screen.getByRole("button", { name: /Cadastrar paciente/i }));

    fireEvent.change(screen.getByPlaceholderText("Ex.: Amora"), { target: { value: "Amora" } });
    fireEvent.change(screen.getByPlaceholderText("Ex.: Labrador"), { target: { value: "Labrador" } });
    fireEvent.change(screen.getByPlaceholderText("Nome para identificação no atendimento"), { target: { value: "M. Ribeiro" } });
    fireEvent.click(screen.getByRole("button", { name: /^Cadastrar paciente/ }));

    await waitFor(() => expect(screen.getByLabelText("Paciente")).toHaveValue("patient-amora"));
    expect(screen.getByRole("option", { name: /Amora · Canino · CVG-AMORA/ })).toBeInTheDocument();
    expect(screen.getByLabelText("Atendimento")).toHaveValue("encounter-amora");
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
});
