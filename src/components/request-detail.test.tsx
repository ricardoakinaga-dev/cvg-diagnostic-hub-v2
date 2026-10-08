/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RequestDetail } from "./request-detail";
import * as apiClient from "./api-client";

vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) => <a {...props}>{children}</a>
}));

const request = {
  id: "request-1",
  requestCode: "EX-0001",
  priority: "URGENT" as const,
  aggregateStatus: "IN_PROGRESS",
  createdAt: "2026-08-20T12:00:00.000Z",
  patient: { displayName: "Thor", species: "Canino", sex: "Macho", externalId: "HIS-THOR", ownerLabel: "Ana" },
  items: [{ id: "item-1", status: "COMPLETED" as const, workflowType: "LABORATORY" as const, priority: "URGENT" as const, dueAt: "2026-08-20T14:00:00.000Z", version: 2, service: { name: "Hemograma", workflowType: "LABORATORY" as const } }]
};

describe("RequestDetail", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("joins request and timeline context and keeps terminal items visible", async () => {
    vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => {
      if (path === "/diagnostic-requests/request-1") return Promise.resolve(request) as never;
      if (path === "/timeline?requestId=request-1") return Promise.resolve([{ id: "event-1", eventType: "ResultRead", newState: "RELEASED", occurredAt: "2026-08-20T13:00:00.000Z" }]) as never;
      return Promise.reject(new Error("unexpected request")) as never;
    });

    render(<RequestDetail requestId="request-1" />);

    expect(await screen.findByRole("heading", { name: /Thor em acompanhamento/ })).toBeInTheDocument();
    expect(screen.getByText("Hemograma")).toBeInTheDocument();
    expect(screen.getByText("Resultado consultado")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Visão geral" })).toHaveAttribute("href", "/");
  });

  it("shows each item's sample with its status and an Etiqueta link", async () => {
    const withSamples = {
      ...request,
      items: [{ ...request.items[0], status: "REQUESTED" as const, currentSampleId: "sample-1" }, { ...request.items[0], id: "item-2", currentSampleId: "sample-missing" }],
      samples: [{ id: "sample-1", requestId: "request-1", accessionCode: "A261008-00015", sampleType: "EDTA", status: "EXPECTED" as const, itemIds: ["item-1"] }]
    };
    vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => (path === "/diagnostic-requests/request-1" ? Promise.resolve(withSamples) : Promise.resolve([])) as never);

    render(<RequestDetail requestId="request-1" />);

    expect(await screen.findByText("A261008-00015")).toBeInTheDocument();
    expect(screen.getByText(/Esperada/)).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /^Etiqueta da amostra/ })).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Etiqueta da amostra A261008-00015" })).toHaveAttribute("href", "/samples/sample-1/label");
  });

  it("reports a partial timeline dependency failure without hiding the request", async () => {
    let timelineAttempts = 0;
    vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => {
      if (path === "/diagnostic-requests/request-1") return Promise.resolve(request) as never;
      timelineAttempts += 1;
      if (timelineAttempts > 1) return Promise.resolve([]) as never;
      return Promise.reject(new Error("timeline unavailable")) as never;
    });

    render(<RequestDetail requestId="request-1" />);

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Parte da timeline está indisponível"));
    expect(screen.getByText("Thor")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reconciliar visão" }));
    await waitFor(() => expect(screen.queryByText("Parte da timeline está indisponível")).not.toBeInTheDocument());
  });

  it("offers a retry when the request itself is unavailable", async () => {
    const apiFetchMock = vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => {
      if (path === "/diagnostic-requests/request-1") return Promise.reject(new Error("request unavailable")) as never;
      return Promise.reject(new Error("timeline unavailable")) as never;
    });

    render(<RequestDetail requestId="request-1" />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Contexto indisponível");
    apiFetchMock.mockImplementation((path) => path === "/diagnostic-requests/request-1" ? Promise.resolve(request) as never : Promise.resolve([]) as never);
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: /Thor em acompanhamento/ })).toBeInTheDocument());
    expect(apiFetchMock).toHaveBeenCalled();
  });

  it("does not let an obsolete request response replace the active route", async () => {
    const pending: Array<{ path: string; resolve: (value: unknown) => void }> = [];
    const apiFetchMock = vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => new Promise((resolve) => {
      pending.push({ path, resolve });
    }) as never);
    const secondRequest = { ...request, id: "request-2", requestCode: "EX-0002", patient: { ...request.patient, displayName: "Mel" } };

    const { rerender } = render(<RequestDetail requestId="request-1" />);
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2));
    rerender(<RequestDetail requestId="request-2" />);
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(4));

    await act(async () => {
      pending.find(({ path }) => path === "/diagnostic-requests/request-2")?.resolve(secondRequest);
      pending.find(({ path }) => path === "/timeline?requestId=request-2")?.resolve([]);
    });
    expect(await screen.findByRole("heading", { name: /Mel em acompanhamento/ })).toBeInTheDocument();

    await act(async () => {
      pending.find(({ path }) => path === "/diagnostic-requests/request-1")?.resolve(request);
      pending.find(({ path }) => path === "/timeline?requestId=request-1")?.resolve([]);
    });
    expect(screen.getByRole("heading", { name: /Mel em acompanhamento/ })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Thor em acompanhamento/ })).not.toBeInTheDocument();
  });
});
