/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExamQueue } from "./exam-queue";
import * as apiClient from "@/components/api-client";

vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) => <a {...props}>{children}</a>
}));

const item = {
  id: "item-1",
  requestId: "request-1",
  status: "REQUESTED" as const,
  workflowType: "LABORATORY" as const,
  priority: "URGENT" as const,
  version: 1,
  dueAt: "2026-08-25T12:00:00.000Z",
  createdAt: "2026-08-25T08:00:00.000Z",
  requestCode: "EX-0001",
  nextAction: "Receber amostra",
  overdue: false,
  patient: { id: "patient-1", displayName: "Thor", species: "Canino", externalId: "HIS-THOR" },
  service: { id: "service-1", code: "HEMOGRAM", name: "Hemograma" },
  operationalContext: {
    currentOwner: { code: "REQUESTING_TEAM" as const, label: "Equipe solicitante · Internação" },
    nextAction: { code: "COLLECT_SAMPLE" as const, label: "Receber amostra" },
    blockedBy: { code: "WAITING_SAMPLE" as const, label: "Aguardando amostra" },
    waitingSince: "2026-08-25T08:00:00.000Z",
    expectedBy: "2026-08-25T12:00:00.000Z",
    escalationLevel: "WATCH" as const
  }
};

describe("ExamQueue", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("opens a contextual drawer without leaving the queue and closes it with Escape", async () => {
    vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => {
      if (path === "/session/me") return Promise.resolve({ user: { role: "LAB_TECH", departmentCode: "LABORATORY" } }) as never;
      return Promise.reject(new Error(`unexpected request: ${path}`)) as never;
    });
    const queueFetchMock = vi.spyOn(apiClient, "apiFetchWithMeta").mockImplementation((path) => {
      if (path.startsWith("/queues/LABORATORY/items")) return Promise.resolve({ data: [item], meta: { correlationId: "corr_queue", requestId: "req_queue", total: 1 } }) as never;
      return Promise.reject(new Error(`unexpected request: ${path}`)) as never;
    });

    render(<ExamQueue />);
    expect(await screen.findAllByText("Thor")).not.toHaveLength(0);
    expect(queueFetchMock).toHaveBeenCalledWith("/queues/LABORATORY/items");
    const opener = screen.getAllByRole("button", { name: "Abrir contexto de Hemograma" })[0]!;
    fireEvent.click(opener);

    const dialog = screen.getByRole("dialog", { name: "Hemograma" });
    expect(dialog).toBeInTheDocument();
    const closeButton = within(dialog).getByRole("button", { name: "Fechar contexto" });
    expect(closeButton).toHaveFocus();
    expect(within(dialog).getByText("Equipe solicitante · Internação")).toBeInTheDocument();
    expect(within(dialog).getByText("Aguardando amostra")).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: /Abrir workspace completo/ })).toHaveAttribute("href", "/requests/request-1#item-1");

    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(within(dialog).getByRole("link", { name: /Abrir workspace completo/ })).toHaveFocus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(closeButton).toHaveFocus();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Hemograma" })).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("keeps the full operational context and primary action in the mobile card renderer", async () => {
    vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => {
      if (path === "/session/me") return Promise.resolve({ user: { role: "LAB_TECH", departmentCode: "LABORATORY" } }) as never;
      return Promise.reject(new Error(`unexpected request: ${path}`)) as never;
    });
    const queueFetchMock = vi.spyOn(apiClient, "apiFetchWithMeta").mockImplementation((path) => {
      if (path.startsWith("/queues/LABORATORY/items")) return Promise.resolve({ data: [item], meta: { correlationId: "corr_queue", requestId: "req_queue", total: 1 } }) as never;
      return Promise.reject(new Error(`unexpected request: ${path}`)) as never;
    });

    render(<ExamQueue />);
    const card = await waitFor(() => {
      const element = document.querySelector(".queue-mobile-list .queue-card");
      if (!(element instanceof HTMLElement)) throw new Error("mobile queue card not rendered");
      return element;
    });
    const cardView = within(card);

    expect(cardView.getByText("Thor")).toBeInTheDocument();
    expect(cardView.getByText("Canino · HIS-THOR")).toBeInTheDocument();
    expect(cardView.getByText("Hemograma")).toBeInTheDocument();
    expect(cardView.getByText("Urgente")).toBeInTheDocument();
    expect(cardView.getByText("Solicitado")).toBeInTheDocument();
    expect(cardView.getAllByText(/25\/08\/2026/)).not.toHaveLength(0);
    expect(cardView.getByText("Receber amostra", { selector: "strong" })).toBeInTheDocument();
    expect(cardView.getByRole("button", { name: "Receber amostra" })).toBeInTheDocument();
    expect(cardView.getByRole("button", { name: "Abrir contexto de Hemograma" })).toBeInTheDocument();
    expect(queueFetchMock).toHaveBeenCalledWith("/queues/LABORATORY/items");

    fireEvent.click(cardView.getByRole("button", { name: /Thor Canino/ }));
    const drawer = await screen.findByRole("dialog", { name: "Hemograma" });
    fireEvent.click(within(drawer).getByRole("button", { name: "Fechar contexto" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Hemograma" })).not.toBeInTheDocument());

    fireEvent.click(cardView.getByRole("button", { name: /Hemograma EX-0001/ }));
    expect(await screen.findByRole("dialog", { name: "Hemograma" })).toBeInTheDocument();
    const backdrop = screen.getByRole("presentation");
    fireEvent.mouseDown(backdrop, { target: backdrop });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Hemograma" })).not.toBeInTheDocument());
  });

  it("loads the next page for every scoped queue without losing the first page", async () => {
    const secondItem = { ...item, id: "item-2", requestId: "request-2", requestCode: "EX-0002", patient: { ...item.patient, id: "patient-2", displayName: "Mel" } };
    const radiologyItem = { ...item, id: "item-rx-1", requestId: "request-rx-1", requestCode: "EX-RX-0001", patient: { ...item.patient, id: "patient-rx-1", displayName: "Luna" }, service: { ...item.service, id: "service-rx", code: "XRAY", name: "RX de tórax" } };
    const operationsItem = { ...item, id: "item-op-1", requestId: "request-op-1", requestCode: "EX-OP-0001", patient: { ...item.patient, id: "patient-op-1", displayName: "Nina" }, service: { ...item.service, id: "service-op", code: "OPS", name: "Triagem operacional" } };
    const secondRadiologyItem = { ...radiologyItem, id: "item-rx-2", requestId: "request-rx-2", requestCode: "EX-RX-0002", patient: { ...radiologyItem.patient, id: "patient-rx-2", displayName: "Bento" } };
    const secondOperationsItem = { ...operationsItem, id: "item-op-2", requestId: "request-op-2", requestCode: "EX-OP-0002", patient: { ...operationsItem.patient, id: "patient-op-2", displayName: "Jade" } };
    vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => {
      if (path === "/session/me") return Promise.resolve({ user: { role: "MANAGER", departmentCode: "OPERATIONS", managedDepartmentCodes: ["LABORATORY", "RADIOLOGY"] } }) as never;
      return Promise.reject(new Error(`unexpected request: ${path}`)) as never;
    });
    const queueFetchMock = vi.spyOn(apiClient, "apiFetchWithMeta").mockImplementation((path) => {
      if (path === "/queues/OPERATIONS/items") return Promise.resolve({ data: [operationsItem], meta: { correlationId: "corr_operations", requestId: "req_operations", nextCursor: "operations-cursor", total: 2 } }) as never;
      if (path === "/queues/LABORATORY/items") return Promise.resolve({ data: [item], meta: { correlationId: "corr_laboratory", requestId: "req_laboratory", nextCursor: "cursor-2", total: 2 } }) as never;
      if (path === "/queues/RADIOLOGY/items") return Promise.resolve({ data: [radiologyItem], meta: { correlationId: "corr_radiology", requestId: "req_radiology", nextCursor: "radiology-cursor", total: 2 } }) as never;
      if (path === "/queues/OPERATIONS/items?cursor=operations-cursor") return Promise.resolve({ data: [secondOperationsItem], meta: { correlationId: "corr_operations_2", requestId: "req_operations_2", total: 2 } }) as never;
      if (path === "/queues/LABORATORY/items?cursor=cursor-2") return Promise.resolve({ data: [secondItem], meta: { correlationId: "corr_laboratory_2", requestId: "req_laboratory_2", total: 2 } }) as never;
      if (path === "/queues/RADIOLOGY/items?cursor=radiology-cursor") return Promise.resolve({ data: [secondRadiologyItem], meta: { correlationId: "corr_radiology_2", requestId: "req_radiology_2", total: 2 } }) as never;
      return Promise.reject(new Error(`unexpected request: ${path}`)) as never;
    });

    render(<ExamQueue />);
    const loadMoreButton = await screen.findByRole("button", { name: "Carregar mais itens" });
    expect(screen.getByText((_, element) => element?.textContent === "3 de 6 itens na fila")).toBeInTheDocument();
    fireEvent.click(loadMoreButton);

    await waitFor(() => expect(screen.getByText("Mel")).toBeInTheDocument());
    expect(screen.getByText("Luna")).toBeInTheDocument();
    expect(screen.getByText("Bento")).toBeInTheDocument();
    expect(screen.getByText("Nina")).toBeInTheDocument();
    expect(screen.getByText("Jade")).toBeInTheDocument();
    expect(screen.getByText("Thor")).toBeInTheDocument();
    expect(queueFetchMock).toHaveBeenCalledWith("/queues/OPERATIONS/items?cursor=operations-cursor");
    expect(queueFetchMock).toHaveBeenCalledWith("/queues/LABORATORY/items?cursor=cursor-2");
    expect(queueFetchMock).toHaveBeenCalledWith("/queues/RADIOLOGY/items?cursor=radiology-cursor");
    expect(screen.queryByRole("button", { name: "Carregar mais itens" })).not.toBeInTheDocument();
  });

  it("covers mobile filters, drawer activation and the responsive media subscription", async () => {
    let mediaListener: (() => void) | undefined;
    const media = {
      matches: false,
      addEventListener: vi.fn((_type: string, listener: () => void) => { mediaListener = listener; }),
      removeEventListener: vi.fn()
    };
    vi.stubGlobal("matchMedia", vi.fn(() => media));
    vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => {
      if (path === "/session/me") return Promise.resolve({ user: { role: "LAB_TECH", departmentCode: "LABORATORY" } }) as never;
      return Promise.reject(new Error(`unexpected request: ${path}`)) as never;
    });
    vi.spyOn(apiClient, "apiFetchWithMeta").mockResolvedValue({ data: [item], meta: { total: 1 } } as never);

    render(<ExamQueue />);
    expect(await screen.findByRole("table", { name: "Fila de exames" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Buscar paciente ou exame" }), { target: { value: "thor" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Filtrar por status" }), { target: { value: "REQUESTED" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Somente atrasados" }));

    const patientOpener = screen.getByRole("button", { name: /Thor Canino/ });
    fireEvent.click(patientOpener);
    expect(await screen.findByRole("dialog", { name: "Hemograma" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Fechar contexto" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Hemograma" })).not.toBeInTheDocument());

    media.matches = true;
    act(() => mediaListener?.());
    expect(await screen.findByRole("list", { name: "Itens da fila em cartões" })).toBeInTheDocument();
  });

  it("reports partial queue failures and a mixed pagination failure without hiding visible work", async () => {
    vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => {
      if (path === "/session/me") return Promise.resolve({ user: { role: "MANAGER", departmentCode: "LABORATORY", managedDepartmentCodes: ["RADIOLOGY", "ULTRASOUND"] } }) as never;
      return Promise.reject(new Error(`unexpected request: ${path}`)) as never;
    });
    const queueFetchMock = vi.spyOn(apiClient, "apiFetchWithMeta").mockImplementation((path) => {
      if (path === "/queues/LABORATORY/items") return Promise.resolve({ data: [item], meta: { nextCursor: "lab-next", total: 2 } }) as never;
      if (path === "/queues/RADIOLOGY/items") return Promise.resolve({ data: [{ ...item, id: "item-rx", service: { ...item.service, name: "RX de tórax" } }], meta: { nextCursor: "rx-next", total: 2 } }) as never;
      if (path === "/queues/ULTRASOUND/items") return Promise.reject(new Error("ultrasound offline")) as never;
      if (path === "/queues/LABORATORY/items?cursor=lab-next") return Promise.resolve({ data: [{ ...item, id: "item-2", patient: { ...item.patient, displayName: "Mel" } }], meta: { total: 2 } }) as never;
      if (path === "/queues/RADIOLOGY/items?cursor=rx-next") return Promise.reject(new Error("radiology page offline")) as never;
      return Promise.reject(new Error(`unexpected request: ${path}`)) as never;
    });

    render(<ExamQueue />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Parte das filas está indisponível");
    const loadMore = await screen.findByRole("button", { name: "Carregar mais itens" });
    fireEvent.click(loadMore);
    await waitFor(() => expect(screen.getByText("Mel")).toBeInTheDocument());
    expect(queueFetchMock).toHaveBeenCalledWith("/queues/LABORATORY/items?cursor=lab-next");
  });

  it("fails closed when every queue is unavailable and retries after the dependency returns", async () => {
    let attempts = 0;
    vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => {
      if (path === "/session/me") return Promise.resolve({ user: { role: "LAB_TECH", departmentCode: "LABORATORY" } }) as never;
      return Promise.reject(new Error(`unexpected request: ${path}`)) as never;
    });
    vi.spyOn(apiClient, "apiFetchWithMeta").mockImplementation(() => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error("queue unavailable")) as never : Promise.resolve({ data: [item], meta: { total: 1 } }) as never;
    });

    render(<ExamQueue />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível carregar a fila.");
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(await screen.findByText("Thor")).toBeInTheDocument();
    expect(attempts).toBe(2);
  });
});
