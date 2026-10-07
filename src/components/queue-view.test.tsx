/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueueItem } from "@cvg/contracts";
import { QueueView } from "./queue-view";
import * as apiClient from "./api-client";

const item = (id = "item-1", name = "Hemograma", version = 3): QueueItem => ({
  id, version, requestId: "request-1", status: "RECEIVED", workflowType: "LABORATORY", priority: "ROUTINE", dueAt: "2026-10-03T12:00:00Z", createdAt: "2026-10-03T08:00:00Z", requestCode: `EX-${id}`, nextAction: "Iniciar processamento", overdue: false,
  patient: { id: "patient-1", displayName: "Thor", species: "Canino", externalId: "P-1" }, service: { id: `service-${id}`, code: `SERVICE_${id}`, name }, operationalContext: { currentOwner: { code: "LABORATORY", label: "Laboratório" }, nextAction: { code: "START_PROCESSING", label: "Iniciar processamento" }, blockedBy: null, waitingSince: null, expectedBy: null, escalationLevel: "NONE" }
});

const page = (items: QueueItem[], nextCursor?: string, total = items.length) => ({ data: items, meta: { requestId: "request", correlationId: "correlation", total, ...(nextCursor ? { nextCursor } : {}) } });
const session = (role = "LAB_TECH", managedDepartmentCodes?: string[]) => ({ user: { role, departmentCode: "LABORATORY", managedDepartmentCodes } });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

describe("QueueView board integration", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); window.history.replaceState(null, "", "/queues"); });

  it("keeps manager department scope, pagination cursors and item deduplication", async () => {
    vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => Promise.resolve(path === "/session/me" ? session("MANAGER", ["LABORATORY", "RADIOLOGY"]) : []) as never);
    const api = vi.spyOn(apiClient, "apiFetchWithMeta").mockImplementation((path) => Promise.resolve(path.includes("cursor=") ? page([item(), item("item-2", "Bioquímica")], undefined, 2) : path.includes("RADIOLOGY") ? page([]) : page([item()], "next-page", 2)) as never);
    render(<QueueView />);
    await screen.findByRole("button", { name: "Abrir contexto de Hemograma — Thor" });
    expect(api.mock.calls.filter(([path]) => path === "/queues/LABORATORY/items")).toHaveLength(1);
    expect(api).toHaveBeenCalledWith("/queues/RADIOLOGY/items");
    fireEvent.click(screen.getByRole("button", { name: "Carregar mais itens" }));
    await screen.findByRole("button", { name: "Abrir contexto de Bioquímica — Thor" });
    expect(api).toHaveBeenCalledWith("/queues/LABORATORY/items?cursor=next-page");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Carregar mais itens" })).not.toBeInTheDocument();
  });

  it("retains available queues when one managed department fails", async () => {
    vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => Promise.resolve(path === "/session/me" ? session("MANAGER", ["RADIOLOGY"]) : []) as never);
    vi.spyOn(apiClient, "apiFetchWithMeta").mockImplementation((path) => path.includes("RADIOLOGY") ? Promise.reject(new Error("unavailable")) : Promise.resolve(page([item()])) as never);
    render(<QueueView />);
    await screen.findByRole("button", { name: "Abrir contexto de Hemograma — Thor" });
    expect(screen.getByRole("alert")).toHaveTextContent("Parte das filas está indisponível");
    expect(screen.getByRole("listitem")).toBeInTheDocument();
  });

  it("refreshes via realtime and uses the current item version for the next mutation", async () => {
    const api = vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => Promise.resolve(path === "/session/me" ? session() : {}) as never);
    const read = vi.spyOn(apiClient, "apiFetchWithMeta").mockResolvedValue(page([item()]) as never);
    render(<QueueView />);
    await screen.findByRole("button", { name: "Iniciar processamento" });
    read.mockResolvedValue(page([item("item-1", "Hemograma", 9)]) as never);
    act(() => { window.dispatchEvent(new Event("cvg:realtime-updated")); });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("button", { name: "Iniciar processamento" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Iniciar processamento" }));
    await waitFor(() => expect(api).toHaveBeenCalledWith("/diagnostic-items/item-1/start-processing", { method: "POST", body: JSON.stringify({ expectedVersion: 9 }) }));
  });

  it("searches loaded cards locally and exposes all workflow states as filters", async () => {
    vi.spyOn(apiClient, "apiFetch").mockResolvedValue(session() as never);
    const api = vi.spyOn(apiClient, "apiFetchWithMeta").mockResolvedValue(page([item(), item("item-2", "Bioquímica")]) as never);
    render(<QueueView />);
    await screen.findByRole("button", { name: "Abrir contexto de Bioquímica — Thor" });
    fireEvent.change(screen.getByLabelText("Buscar paciente ou exame"), { target: { value: "bioquímica" } });
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(api).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByLabelText("Filtrar por status"), { target: { value: "SCHEDULED" } });
    await waitFor(() => expect(api).toHaveBeenCalledWith("/queues/LABORATORY/items?status=SCHEDULED"));
  });

  it.each(["MANAGER", "VETERINARIAN", "VET", "INPATIENT_TEAM"])("opens the existing request dialog from the global event for %s", async (role) => {
    vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => Promise.resolve(path === "/session/me" ? session(role) : []) as never);
    vi.spyOn(apiClient, "apiFetchWithMeta").mockResolvedValue(page([]) as never);
    render(<QueueView />);
    await screen.findByRole("form", { name: "Adicionar exame à fila" });
    act(() => { window.dispatchEvent(new CustomEvent("cvg:create-request")); });
    expect(await screen.findByRole("dialog", { name: "Solicitar exames" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Fechar" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens a requested dialog from the URL and consumes only its create parameter", async () => {
    window.history.replaceState(null, "", "/queues?create=request&view=board#requested");
    vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => Promise.resolve(path === "/session/me" ? session("VETERINARIAN") : []) as never);
    vi.spyOn(apiClient, "apiFetchWithMeta").mockResolvedValue(page([]) as never);
    render(<QueueView />);
    expect(await screen.findByRole("dialog", { name: "Solicitar exames" })).toBeInTheDocument();
    expect(window.location.search).toBe("?view=board");
    expect(window.location.hash).toBe("#requested");
  });

  it.each(["VIEWER", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM"])("ignores the global request event for %s", async (role) => {
    const api = vi.spyOn(apiClient, "apiFetch").mockResolvedValue(session(role) as never);
    vi.spyOn(apiClient, "apiFetchWithMeta").mockResolvedValue(page([item()]) as never);
    render(<QueueView />);
    await screen.findByRole("button", { name: "Abrir contexto de Hemograma — Thor" });
    act(() => { window.dispatchEvent(new CustomEvent("cvg:create-request")); });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api).toHaveBeenCalledOnce();
  });

  it.each(["VETERINARIAN", "VET", "INPATIENT_TEAM"])("uses all authorized catalog services for %s while retaining the INPATIENT queue scope", async (role) => {
    const services = [{ id: "service-lab", name: "Hemograma", code: "HEMOGRAM", departmentCode: "LABORATORY", active: true, workflowType: "LABORATORY", category: "LABORATORY", requiresSample: true, requiresSchedule: false }];
    vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => Promise.resolve(path === "/session/me" ? { user: { role, departmentCode: "INPATIENT" } } : path === "/diagnostic-services" ? services : []) as never);
    const queues = vi.spyOn(apiClient, "apiFetchWithMeta").mockResolvedValue(page([]) as never);
    render(<QueueView />);
    expect(await screen.findByRole("option", { name: "Hemograma" })).toBeInTheDocument();
    expect(queues).toHaveBeenCalledWith("/queues/INPATIENT/items");
    expect(queues).not.toHaveBeenCalledWith("/queues/LABORATORY/items");
    act(() => { window.dispatchEvent(new CustomEvent("cvg:create-request")); });
    const dialog = await screen.findByRole("dialog", { name: "Solicitar exames" });
    expect(await within(dialog).findByRole("checkbox", { name: /Hemograma/ })).toBeInTheDocument();
  });

  it("combines overdue and status filters and manually refreshes the current scoped query", async () => {
    vi.spyOn(apiClient, "apiFetch").mockResolvedValue(session("LAB_TECH", ["RADIOLOGY"]) as never);
    const api = vi.spyOn(apiClient, "apiFetchWithMeta").mockResolvedValue(page([item()]) as never);
    render(<QueueView />);
    await screen.findByRole("button", { name: "Abrir contexto de Hemograma — Thor" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Somente atrasados" }));
    await waitFor(() => expect(api).toHaveBeenCalledWith("/queues/LABORATORY/items?overdue=true"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Atualizar" })).not.toBeDisabled());
    fireEvent.change(screen.getByLabelText("Filtrar por status"), { target: { value: "IN_PROGRESS" } });
    await waitFor(() => expect(api).toHaveBeenCalledWith("/queues/LABORATORY/items?overdue=true&status=IN_PROGRESS"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Atualizar" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Atualizar" }));
    await waitFor(() => expect(api).toHaveBeenCalledTimes(4));
    expect(api.mock.calls[3][0]).toBe("/queues/LABORATORY/items?overdue=true&status=IN_PROGRESS");
    expect(api.mock.calls.every(([path]) => !path.includes("RADIOLOGY"))).toBe(true);
  });

  it("offers a safe retry after every scoped queue fails", async () => {
    vi.spyOn(apiClient, "apiFetch").mockResolvedValue(session() as never);
    const api = vi.spyOn(apiClient, "apiFetchWithMeta").mockRejectedValueOnce(new Error("private database detail")).mockResolvedValue(page([item()]) as never);
    render(<QueueView />);
    expect(screen.getByRole("status", { name: "Carregando fila" })).toBeInTheDocument();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Não foi possível carregar a fila.");
    expect(screen.queryByText("private database detail")).not.toBeInTheDocument();
    fireEvent.click(within(alert).getByRole("button", { name: "Tentar novamente" }));
    await screen.findByRole("button", { name: "Abrir contexto de Hemograma — Thor" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(api).toHaveBeenCalledTimes(2);
  });

  it("keeps loaded cards and retries the same cursor after pagination fails", async () => {
    vi.spyOn(apiClient, "apiFetch").mockResolvedValue(session() as never);
    const pending = deferred<ReturnType<typeof page>>();
    const api = vi.spyOn(apiClient, "apiFetchWithMeta").mockResolvedValueOnce(page([item()], "page-two", 2) as never).mockImplementationOnce(() => pending.promise as never).mockResolvedValueOnce(page([item("item-2", "Bioquímica")], undefined, 2) as never);
    render(<QueueView />);
    const more = await screen.findByRole("button", { name: "Carregar mais itens" });
    fireEvent.click(more);
    fireEvent.click(more);
    expect(api).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Carregando…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Abrir contexto de Hemograma — Thor" })).toBeInTheDocument();
    await act(async () => { pending.reject(new Error("private page detail")); });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Não foi possível carregar mais itens da fila. Tente novamente.");
    expect(screen.queryByText("private page detail")).not.toBeInTheDocument();
    fireEvent.click(within(alert).getByRole("button", { name: "Tentar novamente" }));
    await screen.findByRole("button", { name: "Abrir contexto de Bioquímica — Thor" });
    expect(api.mock.calls.slice(1).map(([path]) => path)).toEqual(["/queues/LABORATORY/items?cursor=page-two", "/queues/LABORATORY/items?cursor=page-two"]);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Carregar mais itens" })).not.toBeInTheDocument();
  });

  it("merges successful managed pages and retries only the failed department while advancing other cursors", async () => {
    vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => Promise.resolve(path === "/session/me" ? session("MANAGER", ["RADIOLOGY"]) : []) as never);
    const api = vi.spyOn(apiClient, "apiFetchWithMeta").mockImplementation((path) => {
      if (path === "/queues/LABORATORY/items") return Promise.resolve(page([item()], "lab-2", 3)) as never;
      if (path === "/queues/RADIOLOGY/items") return Promise.resolve(page([], "rx-2", 1)) as never;
      if (path.includes("cursor=lab-2")) return Promise.resolve(page([item("item-2", "Bioquímica")], "lab-3", 3)) as never;
      if (path.includes("cursor=lab-3")) return Promise.resolve(page([item("item-3", "Urina")], undefined, 3)) as never;
      return Promise.reject(new Error("radiology unavailable"));
    });
    render(<QueueView />);
    fireEvent.click(await screen.findByRole("button", { name: "Carregar mais itens" }));
    await screen.findByRole("button", { name: "Abrir contexto de Bioquímica — Thor" });
    expect(screen.getByRole("alert")).toHaveTextContent("Parte das filas não pôde ser carregada; tente novamente.");
    api.mockImplementation((path) => Promise.resolve(path.includes("LABORATORY") ? page([item("item-3", "Urina")], undefined, 3) : page([item("item-4", "Radiografia")])) as never);
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Tentar novamente" }));
    await screen.findByRole("button", { name: "Abrir contexto de Radiografia — Thor" });
    expect(api.mock.calls.slice(4).map(([path]) => path)).toEqual(["/queues/LABORATORY/items?cursor=lab-3", "/queues/RADIOLOGY/items?cursor=rx-2"]);
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    expect(screen.queryByRole("button", { name: "Carregar mais itens" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("ignores late pagination responses when filters start a new queue load", async () => {
    vi.spyOn(apiClient, "apiFetch").mockResolvedValue(session() as never);
    const oldPage = deferred<ReturnType<typeof page>>();
    const api = vi.spyOn(apiClient, "apiFetchWithMeta").mockResolvedValueOnce(page([item()], "old-cursor", 2) as never).mockImplementationOnce(() => oldPage.promise as never).mockResolvedValueOnce(page([item("filtered", "Exame atrasado")]) as never);
    render(<QueueView />);
    fireEvent.click(await screen.findByRole("button", { name: "Carregar mais itens" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Somente atrasados" }));
    await screen.findByRole("button", { name: "Abrir contexto de Exame atrasado — Thor" });
    await act(async () => { oldPage.resolve(page([item("obsolete", "Página antiga")], "obsolete-cursor", 99)); });
    expect(screen.queryByRole("button", { name: "Abrir contexto de Página antiga — Thor" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Carregar mais itens" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(api.mock.calls[2][0]).toBe("/queues/LABORATORY/items?overdue=true");
  });

  it.each(["resolve", "reject"] as const)("ignores an obsolete initial load that later %ss after realtime resync", async (outcome) => {
    const obsolete = deferred<ReturnType<typeof page>>();
    vi.spyOn(apiClient, "apiFetch").mockResolvedValue(session() as never);
    const api = vi.spyOn(apiClient, "apiFetchWithMeta").mockImplementationOnce(() => obsolete.promise as never).mockResolvedValue(page([item("fresh", "Exame atual")]) as never);
    render(<QueueView />);
    await waitFor(() => expect(api).toHaveBeenCalledOnce());
    act(() => { window.dispatchEvent(new Event("cvg:realtime-resync")); });
    await screen.findByRole("button", { name: "Abrir contexto de Exame atual — Thor" });
    await act(async () => { if (outcome === "resolve") obsolete.resolve(page([item("old", "Exame antigo")], "obsolete-cursor")); else obsolete.reject(new Error("obsolete failure")); });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Abrir contexto de Exame antigo — Thor" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Atualizar" })).not.toBeDisabled();
  });

  it.each([-1, 1.5, "99", Number.MAX_SAFE_INTEGER + 1])("falls back to loaded counts when total metadata is invalid: %s", async (total) => {
    vi.spyOn(apiClient, "apiFetch").mockResolvedValue(session() as never);
    vi.spyOn(apiClient, "apiFetchWithMeta").mockResolvedValue({ data: [item()], meta: { total, nextCursor: "next" } } as never);
    render(<QueueView />);
    await screen.findByRole("button", { name: "Carregar mais itens" });
    expect(screen.getByText("Mostrando 1 de 1 itens")).toBeInTheDocument();
  });

  it("removes realtime and creation listeners on unmount", async () => {
    const api = vi.spyOn(apiClient, "apiFetch").mockResolvedValue(session() as never);
    const read = vi.spyOn(apiClient, "apiFetchWithMeta").mockResolvedValue(page([item()]) as never);
    const { unmount } = render(<QueueView />);
    await screen.findByRole("button", { name: "Abrir contexto de Hemograma — Thor" });
    unmount();
    await act(async () => {
      window.dispatchEvent(new Event("cvg:realtime-updated"));
      window.dispatchEvent(new Event("cvg:realtime-resync"));
      window.dispatchEvent(new Event("cvg:create-request"));
    });
    expect(api).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes the real request dialog and refreshes the queue only after the server confirms creation", async () => {
    const creation = deferred<object>();
    const api = vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => {
      if (path === "/session/me") return Promise.resolve(session("VETERINARIAN")) as never;
      if (path === "/diagnostic-services") return Promise.resolve([{ id: "service-1", code: "HEM", name: "Hemograma", departmentCode: "LABORATORY", active: true, workflowType: "LABORATORY" }]) as never;
      if (path === "/patients") return Promise.resolve([{ id: "patient-1", displayName: "Thor", species: "Canino", externalId: "P-1" }]) as never;
      if (path === "/patients/patient-1/encounters") return Promise.resolve([{ id: "encounter-1", type: "OUTPATIENT", status: "OPEN", openedAt: "2026-10-03T10:00:00Z" }]) as never;
      if (path === "/diagnostic-requests") return creation.promise as never;
      return Promise.resolve([]) as never;
    });
    const read = vi.spyOn(apiClient, "apiFetchWithMeta").mockResolvedValue(page([]) as never);
    render(<QueueView />);
    await screen.findByRole("form", { name: "Adicionar exame à fila" });
    act(() => { window.dispatchEvent(new Event("cvg:create-request")); });
    const dialog = await screen.findByRole("dialog", { name: "Solicitar exames" });
    await within(dialog).findByRole("option", { name: "Thor · Canino · P-1" });
    fireEvent.change(within(dialog).getByLabelText("Paciente"), { target: { value: "patient-1" } });
    await waitFor(() => expect(within(dialog).getByLabelText("Atendimento")).not.toBeDisabled());
    fireEvent.change(within(dialog).getByLabelText("Atendimento"), { target: { value: "encounter-1" } });
    fireEvent.click(await within(dialog).findByRole("checkbox", { name: /Hemograma/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirmar solicitação" }));
    expect(api).toHaveBeenCalledWith("/diagnostic-requests", expect.objectContaining({ method: "POST", body: JSON.stringify({ patientId: "patient-1", encounterId: "encounter-1", priority: "ROUTINE", items: [{ serviceId: "service-1" }] }) }));
    expect(within(dialog).getByRole("button", { name: "Confirmando…" })).toBeDisabled();
    expect(read).toHaveBeenCalledOnce();
    read.mockResolvedValue(page([item()]) as never);
    await act(async () => { creation.resolve({}); });
    await screen.findByRole("button", { name: "Abrir contexto de Hemograma — Thor" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(read).toHaveBeenCalledTimes(2);
  });
});
