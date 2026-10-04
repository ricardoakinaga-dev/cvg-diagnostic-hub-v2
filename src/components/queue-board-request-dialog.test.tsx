/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueueBoardRequestDialog } from "./queue-board-request-dialog";
import * as apiClient from "./api-client";

vi.mock("./dashboard", () => ({
  RequestDialog: ({ services, servicesError, onRetryServices, onClose, onCreated, canCreatePatient }: Parameters<typeof import("./dashboard")["RequestDialog"]>[0]) => <section aria-label="Solicitar exames">
    {services.map((service) => <span key={service.id}>{service.name}</span>)}
    {servicesError && <p role="alert">{servicesError}</p>}
    <span>{canCreatePatient ? "Cadastro disponível" : "Cadastro restrito"}</span>
    <button onClick={() => void onRetryServices()}>Recarregar serviços</button>
    <button onClick={onClose}>Fechar solicitação</button>
    <button onClick={onCreated}>Solicitação criada</button>
  </section>
}));

const services = [
  { id: "lab", name: "Hemograma", departmentCode: "LABORATORY", active: true },
  { id: "rx", name: "Radiografia", departmentCode: "RADIOLOGY", active: true },
  { id: "inactive", name: "Exame desativado", departmentCode: "LABORATORY", active: false }
];

describe("QueueBoardRequestDialog", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("loads only active services in the manager scope and delegates the existing request lifecycle", async () => {
    const api = vi.spyOn(apiClient, "apiFetch").mockResolvedValue(services);
    const onClose = vi.fn();
    const onCreated = vi.fn();
    render(<QueueBoardRequestDialog departments={["LABORATORY"]} canCreatePatient={false} onClose={onClose} onCreated={onCreated} />);
    expect(screen.getByRole("status")).toHaveTextContent("Carregando exames");
    await screen.findByText("Hemograma");
    expect(api).toHaveBeenCalledWith("/diagnostic-services");
    expect(screen.queryByText("Radiografia")).not.toBeInTheDocument();
    expect(screen.queryByText("Exame desativado")).not.toBeInTheDocument();
    expect(screen.getByText("Cadastro restrito")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Fechar solicitação" }));
    fireEvent.click(screen.getByRole("button", { name: "Solicitação criada" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onCreated).toHaveBeenCalledOnce();
  });

  it("allows veterinary requests across authorized catalog departments and recovers from a catalog outage", async () => {
    const api = vi.spyOn(apiClient, "apiFetch").mockRejectedValueOnce(new Error("catalog unavailable")).mockResolvedValue(services);
    render(<QueueBoardRequestDialog departments={[]} canCreatePatient onClose={vi.fn()} onCreated={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível carregar os exames disponíveis.");
    fireEvent.click(screen.getByRole("button", { name: "Recarregar serviços" }));
    await screen.findByText("Radiografia");
    expect(screen.getByText("Hemograma")).toBeInTheDocument();
    expect(screen.getByText("Cadastro disponível")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(api).toHaveBeenCalledTimes(2);
  });
});
