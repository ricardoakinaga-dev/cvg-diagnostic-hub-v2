/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SampleLabel } from "@cvg/contracts";
import { code128Geometry } from "../server/domain/barcode-code128";
import { SampleLabelLink, SampleLabelView } from "./sample-label";
import * as apiClient from "./api-client";

vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) => <a {...props}>{children}</a>
}));

const label: SampleLabel = {
  sample: { id: "sample-1", accessionCode: "A261008-00015", sampleType: "EDTA", status: "EXPECTED" },
  request: { id: "request-1", requestCode: "EX-261008-0001", priority: "URGENT" },
  patient: { id: "patient-1", displayName: "Thor", species: "Canino", externalId: "HIS-THOR-001" },
  services: [{ code: "HEMOGRAM", name: "Hemograma" }, { code: "CRP", name: "Proteína C reativa" }],
  encounter: { externalId: "ATD-THOR-001" },
  requestedAt: "2026-10-08T12:00:00.000Z",
  label: { widthMm: 60, heightMm: 40, barcode: { symbology: "code128", ...code128Geometry("A261008-00015") } }
};

describe("SampleLabelView", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders the label content, sizes the print page and prints on demand", async () => {
    const apiFetchMock = vi.spyOn(apiClient, "apiFetch").mockResolvedValue(label as never);
    const print = vi.spyOn(window, "print").mockImplementation(() => undefined);
    const { container } = render(<SampleLabelView sampleId="sample-1" />);

    expect(await screen.findByRole("heading", { name: "Etiqueta da amostra" })).toBeInTheDocument();
    expect(apiFetchMock).toHaveBeenCalledWith("/samples/sample-1/label");
    const sheet = screen.getByLabelText("Etiqueta A261008-00015");
    expect(sheet).toHaveTextContent("A261008-00015");
    expect(sheet).toHaveTextContent("Thor");
    expect(sheet).toHaveTextContent("Canino · HIS-THOR-001");
    expect(sheet).toHaveTextContent("EX-261008-0001 · EDTA");
    expect(sheet).toHaveTextContent("Hemograma, Proteína C reativa");
    expect(sheet).toHaveTextContent(/Solicitado em .*2026/);
    expect(screen.getByRole("img", { name: "Código de barras A261008-00015" }).querySelectorAll("rect").length).toBeGreaterThan(10);
    expect(screen.getByText("Esperada")).toBeInTheDocument();
    expect(screen.getByText(/Status da amostra:/)).toHaveTextContent("etiqueta 60 × 40 mm");
    expect(container.querySelector("style")?.textContent).toContain("@page { size: 60mm 40mm; margin: 0; }");
    expect(screen.getByRole("link", { name: "Voltar" })).toHaveAttribute("href", "/requests/request-1");

    fireEvent.click(screen.getByRole("button", { name: "Imprimir" }));
    expect(print).toHaveBeenCalledOnce();
  });

  it("keeps an unparseable request date as received", async () => {
    vi.spyOn(apiClient, "apiFetch").mockResolvedValue({ ...label, requestedAt: "ontem" } as never);
    render(<SampleLabelView sampleId="sample-1" />);
    expect(await screen.findByLabelText("Etiqueta A261008-00015")).toHaveTextContent("Solicitado em ontem");
  });

  it("offers a retry when the label is unavailable", async () => {
    const apiFetchMock = vi.spyOn(apiClient, "apiFetch").mockRejectedValueOnce(new Error("offline")).mockResolvedValue(label as never);
    render(<SampleLabelView sampleId="sample-1" />);

    expect(await screen.findByRole("heading", { name: "Etiqueta indisponível" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Tentar novamente/ }));
    await waitFor(() => expect(screen.getByLabelText("Etiqueta A261008-00015")).toBeInTheDocument());
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("SampleLabelLink", () => {
  afterEach(cleanup);

  it("names the sample when the code is known", () => {
    render(<><SampleLabelLink sampleId="sample-1" accessionCode="A261008-00015" /><SampleLabelLink sampleId="sample-2" /></>);
    expect(screen.getByRole("link", { name: "Etiqueta da amostra A261008-00015" })).toHaveAttribute("href", "/samples/sample-1/label");
    expect(screen.getByRole("link", { name: "Etiqueta da amostra" })).toHaveAttribute("href", "/samples/sample-2/label");
  });
});
