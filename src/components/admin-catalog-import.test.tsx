/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminConsole } from "./admin-console";
import { CatalogImportPanel, type CatalogImportReport } from "./admin-catalog-import";
import * as apiClient from "./api-client";

vi.mock("next/link", () => ({ default: ({ children, ...props }: { children: React.ReactNode; href: string }) => <a {...props}>{children}</a> }));

const clean: CatalogImportReport = { applied: false, dryRun: true, summary: { create: 1, update: 1, unchanged: 1, error: 0 }, rows: [
  { line: 2, code: "GLUCOSE", action: "CREATE", changes: ["novo exame"] },
  { line: 3, code: "CRP", action: "UPDATE", changes: ["nome: A → B", "ativo: sim → não"] },
  { line: 4, code: "HEMOGRAM", action: "UNCHANGED" }
] };
const withErrors: CatalogImportReport = { applied: false, dryRun: true, summary: { create: 0, update: 0, unchanged: 0, error: 1 }, rows: [{ line: 5, code: "", action: "ERROR", errors: ["Coluna \"setor\": informe o código do setor."] }] };

const csv = (name: string, text = "codigo;nome\nX;Y") => new File([text], name, { type: "text/csv" });
function choose(label: string, file: File) { fireEvent.change(screen.getByLabelText(label), { target: { files: [file] } }); }
function open() { fireEvent.click(screen.getByText("Importar catálogo por planilha")); }

describe("CatalogImportPanel", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("links both templates and keeps Validar disabled until the exam sheet is chosen", () => {
    render(<CatalogImportPanel onApplied={vi.fn()} />);
    open();
    expect(screen.getByRole("link", { name: /modelo de exames/ })).toHaveAttribute("href", "/templates/catalogo-exames.csv");
    expect(screen.getByRole("link", { name: /modelo de analitos/ })).toHaveAttribute("href", "/templates/catalogo-analitos.csv");
    expect(screen.getByRole("button", { name: "Validar" })).toBeDisabled();
  });

  it("validates as dry run, renders the report with Portuguese labels, then applies the same content and refreshes", async () => {
    const onApplied = vi.fn();
    const mock = vi.spyOn(apiClient, "apiFetch").mockImplementation(async <T,>(_path: string, init?: RequestInit): Promise<T> => {
      const body = JSON.parse(init?.body as string) as { dryRun: boolean };
      return (body.dryRun ? clean : { ...clean, applied: true, dryRun: false }) as T;
    });
    render(<CatalogImportPanel onApplied={onApplied} />);
    open();
    choose("Planilha de exames (.csv)", csv("exames.csv", "EXAMES"));
    choose("Planilha de analitos (.csv, opcional)", csv("analitos.csv", "ANALITOS"));
    expect(screen.queryByRole("button", { name: "Aplicar importação" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Validar" }));
    const table = await screen.findByRole("table");
    expect(within(table).getByText("Criar")).toBeInTheDocument();
    expect(within(table).getByText("Atualizar")).toBeInTheDocument();
    expect(within(table).getByText("Sem mudança")).toBeInTheDocument();
    expect(within(table).getByText("nome: A → B · ativo: sim → não")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("1 a criar, 1 a atualizar, 1 sem mudança, 0 com erro");
    expect(JSON.parse(mock.mock.calls[0]![1]!.body as string)).toEqual({ services: "EXAMES", analytes: "ANALITOS", dryRun: true });
    expect(onApplied).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Aplicar importação" }));
    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
    expect(mock.mock.calls[0]![0]).toBe("/diagnostic-services/import");
    expect(JSON.parse(mock.mock.calls[1]![1]!.body as string)).toEqual({ services: "EXAMES", analytes: "ANALITOS", dryRun: false });
    expect(await screen.findByText(/Importação aplicada: 1 criado\(s\), 1 atualizado\(s\), 1 sem mudança/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("shows errors and offers no way to apply while any row has an error; changing a file discards the validation", async () => {
    const mock = vi.spyOn(apiClient, "apiFetch").mockResolvedValue(withErrors);
    render(<CatalogImportPanel onApplied={vi.fn()} />);
    open();
    choose("Planilha de exames (.csv)", csv("exames.csv"));
    fireEvent.click(screen.getByRole("button", { name: "Validar" }));
    const table = await screen.findByRole("table");
    expect(within(table).getByText("Erro")).toBeInTheDocument();
    expect(within(table).getByText("—", { selector: "th" })).toBeInTheDocument();
    expect(within(table).getByText(/informe o código do setor/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Aplicar importação" })).toBeDisabled();
    expect(JSON.parse(mock.mock.calls[0]![1]!.body as string)).not.toHaveProperty("analytes");
    fireEvent.change(screen.getByLabelText("Planilha de exames (.csv)"), { target: { files: [] } });
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("explains failures: API error, unreadable huge file and failed apply", async () => {
    const failure = new apiClient.ApiClientError(422, { error: { code: "CATALOG_IMPORT_INVALID" } });
    const mock = vi.spyOn(apiClient, "apiFetch").mockRejectedValueOnce(new Error("offline"));
    render(<CatalogImportPanel onApplied={vi.fn()} />);
    open();
    choose("Planilha de exames (.csv)", csv("exames.csv"));
    fireEvent.click(screen.getByRole("button", { name: "Validar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível validar a planilha.");

    const huge = csv("grande.csv");
    Object.defineProperty(huge, "size", { value: 950_000 });
    choose("Planilha de exames (.csv)", huge);
    fireEvent.click(screen.getByRole("button", { name: "Validar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Arquivo grande demais");

    choose("Planilha de exames (.csv)", csv("exames.csv"));
    mock.mockResolvedValueOnce(clean).mockRejectedValueOnce(failure);
    fireEvent.click(screen.getByRole("button", { name: "Validar" }));
    fireEvent.click(await screen.findByRole("button", { name: "Aplicar importação" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("nada foi importado");
  });

  it("is available inside the administration console and reloads the catalog after applying", async () => {
    const identity = { id: "admin", email: "admin@cvg.local", displayName: "Admin", role: "ADMIN", departmentCode: "INPATIENT", timezone: "America/Sao_Paulo" };
    let catalogLoads = 0;
    vi.spyOn(apiClient, "apiFetch").mockImplementation(async <T,>(path: string): Promise<T> => {
      if (path === "/session/me") return { user: identity } as T;
      if (path === "/diagnostic-services?includeInactive=true") { catalogLoads += 1; return [] as T; }
      if (path === "/reason-codes" || path === "/users") return [] as T;
      return { ...clean, applied: true, dryRun: false } as T;
    });
    render(<AdminConsole />);
    await screen.findByText("Importar catálogo por planilha");
    expect(catalogLoads).toBe(1);
    open();
    choose("Planilha de exames (.csv)", csv("exames.csv"));
    fireEvent.click(screen.getByRole("button", { name: "Validar" }));
    fireEvent.click(await screen.findByRole("button", { name: "Aplicar importação" }));
    await waitFor(() => expect(catalogLoads).toBe(2));
  });
});
