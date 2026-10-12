/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IndicatorsView } from "./indicators-view";
import * as apiClient from "./api-client";

const scopedRequest = { id: "request-1", requestCode: "EX-1", priority: "ROUTINE", createdAt: "2026-10-11T12:00:00Z", patient: { id: "patient-1", displayName: "Thor", species: "Canino", externalId: "P1" }, items: [{ id: "lab-item", requestId: "request-1", status: "REQUESTED", priority: "ROUTINE", workflowType: "LABORATORY", departmentCode: "LABORATORY", version: 1, dueAt: "2099-10-11T15:00:00Z", service: { id: "service-1", code: "HEM", name: "Hemograma" } }] };

function mockFeed(requests = [scopedRequest]) {
  return vi.spyOn(apiClient, "apiFetchWithMeta").mockImplementation((path) => Promise.resolve({ data: path.startsWith("/diagnostic-requests") ? requests : [], meta: {} }) as never);
}

vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) => <a {...props}>{children}</a>,
}));

describe("IndicatorsView", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows scoped indicators and labels unavailable distributions instead of inventing them", async () => {
    mockFeed();
    vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => {
      if (path === "/session/me") return Promise.resolve({ user: { departmentCode: "LABORATORY" } }) as never;
      if (path === "/dashboard") return Promise.resolve({
        overdue: 2,
        recollections: 1,
        newResults: 3,
        critical: 1,
        totalActive: 8,
        updatedAt: "2026-08-20T14:00:00.000Z",
        departments: [{ departmentCode: "LABORATORY", label: "Laboratório", activeItems: 1 }],
        window: { kind: "CURRENT_STATE", label: "Estado atual", timezone: "America/Sao_Paulo", asOf: "2026-08-20T14:00:00.000Z" },
        indicators: [
          { key: "overdue", label: "Atrasados", count: 2, denominator: 8, definition: "Itens não terminais cujo prazo já passou.", nextAction: "Abrir a fila e tratar por prioridade." },
          { key: "recollections", label: "Recoletas", count: 1, denominator: 4, definition: "Itens laboratoriais que aguardam nova amostra.", nextAction: "Receber a nova amostra." },
          { key: "newResults", label: "Resultados novos", count: 3, denominator: 8, definition: "Itens com resultado liberado aguardando revisão.", nextAction: "Revisar resultado." },
          { key: "critical", label: "Críticos", count: 1, denominator: 1, definition: "Notificações críticas não confirmadas.", nextAction: "Seguir a política aprovada." },
          { key: "totalActive", label: "Ativos", count: 8, denominator: 8, definition: "Itens não terminais no escopo.", nextAction: "Acompanhar a fila." }
        ]
      }) as never;
      if (path.startsWith("/queues/LABORATORY/items")) return Promise.resolve([{ id: "item-1", status: "IN_PROGRESS", priority: "URGENT", overdue: false }]) as never;
      return Promise.reject(new Error("unexpected request")) as never;
    });

    render(<IndicatorsView />);

    expect(await screen.findByRole("heading", { name: /Indicadores operacionais/ })).toBeInTheDocument();
    expect(screen.getByText("Não há distribuição de tempo de resposta disponível neste ambiente.")).toBeInTheDocument();
    expect(screen.getByText("Setores: Laboratório")).toBeInTheDocument();
    expect(screen.getAllByText("Denominador: 8").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Próxima ação:/).length).toBeGreaterThan(0);
    expect(screen.getByText("8")).toBeInTheDocument();
  });

  it("offers retry and reconciliation when the scoped reads fail or become partial", async () => {
    mockFeed([]);
    let mode: "failed" | "ready" | "partial" = "failed";
    const stats = { overdue: 0, recollections: 0, newResults: 0, critical: 0, totalActive: 0, updatedAt: "2026-08-20T14:00:00.000Z", window: { kind: "CURRENT_STATE" as const, label: "Estado atual", timezone: "UTC", asOf: "2026-08-20T14:00:00.000Z" }, indicators: [] };
    const apiFetchMock = vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => {
      if (mode === "failed") return Promise.reject(new Error("private details")) as never;
      if (path === "/session/me") return Promise.resolve({ user: { departmentCode: "LABORATORY" } }) as never;
      if (path === "/dashboard") return mode === "partial" ? Promise.reject(new Error("dashboard unavailable")) as never : Promise.resolve(stats) as never;
      return Promise.resolve([]) as never;
    });

    render(<IndicatorsView />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Indicadores indisponíveis");
    mode = "ready";
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: /Indicadores operacionais/ })).toBeInTheDocument());

    mode = "partial";
    fireEvent.click(screen.getByRole("button", { name: /Atualizar/ }));
    expect(await screen.findByText(/Parte dos indicadores está indisponível/)).toBeInTheDocument();
    mode = "ready";
    fireEvent.click(screen.getByRole("button", { name: "Reconciliar" }));
    await waitFor(() => expect(apiFetchMock.mock.calls.filter(([path]) => path === "/dashboard").length).toBeGreaterThanOrEqual(3));
  });

  it.each(["MANAGER", "SUPERADMIN"])("shows %s's delegated clinical population even when the primary department is IT", async (role) => {
    const radiology = { ...scopedRequest.items[0], id: "rx-item", departmentCode: "RADIOLOGY", workflowType: "RADIOLOGY", service: { id: "rx", code: "RX", name: "Radiografia" } };
    mockFeed([{ ...scopedRequest, items: [...scopedRequest.items, radiology, { ...radiology, id: "closed", status: "COMPLETED" }] }]);
    vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => Promise.resolve(path === "/diagnostic-services?includeInactive=true" ? [{ departmentCode: "LABORATORY" }, { departmentCode: "RADIOLOGY" }] : path === "/session/me" ? { user: { id: "manager", role, departmentCode: "IT", managedDepartmentCodes: ["LABORATORY", "RADIOLOGY"] } } : { totalActive: 2, overdue: 0, recollections: 0, newResults: 0, critical: 0, indicators: [], window: { label: "Estado atual", timezone: "America/Sao_Paulo", asOf: "2026-10-11T12:00:00Z" }, departments: [{ departmentCode: "LABORATORY", label: "Laboratório" }, { departmentCode: "RADIOLOGY", label: "Radiologia" }] }) as never);
    render(<IndicatorsView />);
    expect(await screen.findByRole("heading", { name: "2 itens ativos no escopo" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Thor · Hemograma" })).toHaveAttribute("href", "/requests/request-1#lab-item");
    expect(screen.getByRole("link", { name: "Thor · Radiografia" })).toHaveAttribute("href", "/requests/request-1#rx-item");
    expect(screen.getByRole("link", { name: "Abrir todos os itens ativos" })).toHaveAttribute("href", "/queues?view=mine");
    expect(screen.getAllByRole("link").filter((link) => link.getAttribute("href")?.startsWith("/requests/"))).toHaveLength(2);
    expect(screen.getByText("Setores: Laboratório · Radiologia")).toBeInTheDocument();
    expect(screen.queryByText("Setor: IT")).not.toBeInTheDocument();
  });
});
