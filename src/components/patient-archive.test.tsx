/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PatientArchive } from "./patient-archive";
import * as apiClient from "./api-client";

vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) => <a {...props}>{children}</a>
}));

const entry = {
  requestId: "request-old", requestCode: "EX-OLD-1", archivedAt: "2026-10-08T12:00:00.000Z", completedAt: "2024-06-01T12:00:00.000Z",
  services: [{ code: "HEMOGRAM", name: "Hemograma" }, { code: "XRAY_THORAX", name: "RX de tórax" }], attachmentCount: 1
};

describe("PatientArchive", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("stays collapsed and does not load anything until expanded", () => {
    const fetch = vi.spyOn(apiClient, "apiFetch").mockResolvedValue([] as never);
    render(<PatientArchive patientId="patient-thor" />);
    expect(screen.getByRole("heading", { name: "Arquivo (exames com mais de 24 meses)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Expandir arquivo" })).toHaveAttribute("aria-expanded", "false");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("loads lazily on expand, lists the summaries with a link to the read-only page and does not reload", async () => {
    const fetch = vi.spyOn(apiClient, "apiFetch").mockResolvedValue([entry] as never);
    render(<PatientArchive patientId="patient-thor" />);
    fireEvent.click(screen.getByRole("button", { name: "Expandir arquivo" }));

    const link = await screen.findByRole("link", { name: "EX-OLD-1" });
    expect(link).toHaveAttribute("href", "/archive/request-old");
    expect(screen.getByText("Hemograma, RX de tórax")).toBeInTheDocument();
    expect(screen.getByText(/1 anexo/)).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith("/patients/patient-thor/archive?limit=50");

    fireEvent.click(screen.getByRole("button", { name: "Recolher arquivo" }));
    fireEvent.click(screen.getByRole("button", { name: "Expandir arquivo" }));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("pluralizes attachments and tolerates an entry without services", async () => {
    vi.spyOn(apiClient, "apiFetch").mockResolvedValue([{ ...entry, services: [], attachmentCount: 3 }] as never);
    render(<PatientArchive patientId="patient-thor" />);
    fireEvent.click(screen.getByRole("button", { name: "Expandir arquivo" }));
    expect(await screen.findByText("Sem exames")).toBeInTheDocument();
    expect(screen.getByText(/3 anexos/)).toBeInTheDocument();
  });

  it("explains an empty archive", async () => {
    vi.spyOn(apiClient, "apiFetch").mockResolvedValue([] as never);
    render(<PatientArchive patientId="patient-thor" />);
    fireEvent.click(screen.getByRole("button", { name: "Expandir arquivo" }));
    expect(await screen.findByText("Nenhum exame arquivado")).toBeInTheDocument();
  });

  it("shows a safe error and retries", async () => {
    const fetch = vi.spyOn(apiClient, "apiFetch").mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce([entry] as never);
    render(<PatientArchive patientId="patient-thor" />);
    fireEvent.click(screen.getByRole("button", { name: "Expandir arquivo" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Arquivo indisponível");
    fireEvent.click(screen.getByRole("button", { name: /tentar novamente/i }));
    await waitFor(() => expect(screen.getByRole("link", { name: "EX-OLD-1" })).toBeInTheDocument());
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
