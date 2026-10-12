/** @vitest-environment jsdom */
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HospitalDocumentContent, HospitalDocumentView, SessionUser } from "@cvg/contracts";
import { HospitalDocumentLibrary } from "./hospital-document-library";
import { EMPTY_DOCUMENT, HospitalDocumentContentEditor, HospitalDocumentRenderer } from "./hospital-document-content";
import { apiFetch, ApiClientError } from "./api-client";
import { hospitalUser, uiPage } from "./hospital-ui.test-helpers";

vi.mock("next/link", () => ({ default: ({ children, ...props }: { children: React.ReactNode; href: string }) => <a {...props}>{children}</a> }));
vi.mock("./api-client", async (original) => ({ ...await original<typeof import("./api-client")>(), apiFetch: vi.fn() }));
let user: SessionUser;
const created: HospitalDocumentView = { favorite: false, permissions: [], document: { id: "new-protocol", code: "PLANTAO", title: "Protocolo do plantão", departmentCode: "INPATIENT", responsibleUserId: hospitalUser.id, locked: false, archived: false, version: 1, createdBy: hospitalUser.id, createdAt: "2026-10-11T12:00:00Z", updatedAt: "2026-10-11T12:00:00Z", revisions: [] } };
const writes = () => vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method);
beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  user = { ...hospitalUser, permissions: ["hospital_document.view", "hospital_document.create"] };
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === "/session/me") return { user } as never;
    if (path === "/hospital-documents/options") return { departments: [{ code: "INPATIENT", name: "Internação" }, { code: "WARD_B", name: "Enfermaria B" }], responsibles: [{ id: user.id, displayName: user.displayName }] } as never;
    if (path.startsWith("/hospital-documents?")) return uiPage([]) as never;
    if (path === "/hospital-documents" && init?.method === "POST") return created as never;
    throw new Error(`Unexpected library workflow ${path}`);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("creates a structured document under restrictive filters and provides an exact link and a way to see it", async () => {
  render(<HospitalDocumentLibrary />);
  await screen.findByRole("heading", { name: "Protocolos e documentos" });
  fireEvent.change(screen.getByLabelText("Buscar documento"), { target: { value: "outro protocolo" } });
  fireEvent.click(screen.getByLabelText("Somente meus favoritos"));
  fireEvent.click(screen.getByLabelText("Incluir documentos arquivados"));
  await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path.includes("query=outro%20protocolo") && path.includes("favoritesOnly=true") && path.includes("includeArchived=true"))).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "Novo documento" }));
  const form = screen.getByRole("form", { name: "Criar documento operacional" });
  fireEvent.change(within(form).getByLabelText("Código do documento"), { target: { value: "PLANTAO" } });
  fireEvent.change(within(form).getByLabelText("Título do documento"), { target: { value: "  Protocolo do plantão  " } });
  await within(within(form).getByLabelText("Setor do documento")).findByRole("option", { name: "Internação" });
  fireEvent.change(within(form).getByLabelText("Setor do documento"), { target: { value: "INPATIENT" } });
  fireEvent.change(within(form).getByLabelText("Responsável pelo documento"), { target: { value: user.id } });
  fireEvent.change(within(form).getByLabelText("Bloco 1, texto 1"), { target: { value: "Conferir os materiais do plantão." } });
  fireEvent.submit(form);
  expect(await screen.findByRole("link", { name: "Abrir Protocolo do plantão" })).toHaveAttribute("href", "/planner/documents/new-protocol");
  expect(JSON.parse(writes()[0][1]!.body as string)).toEqual({ code: "PLANTAO", title: "Protocolo do plantão", departmentCode: "INPATIENT", responsibleUserId: user.id, content: { ...EMPTY_DOCUMENT, blocks: [{ type: "paragraph", content: [{ text: "Conferir os materiais do plantão." }] }] } });
  fireEvent.click(screen.getByRole("button", { name: "Limpar filtros da biblioteca" }));
  expect(screen.getByLabelText("Buscar documento")).toHaveValue("");
  expect(screen.getByLabelText("Somente meus favoritos")).not.toBeChecked();
  expect(screen.getByLabelText("Incluir documentos arquivados")).toBeChecked();
});

it("clears the responsible when changing sectors, preserves a rejected draft and permits canceling it", async () => {
  const read = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => { if (init?.method) throw new ApiClientError(409, { error: { code: "DOCUMENT_CODE_EXISTS" } }); return read(path, init); });
  render(<HospitalDocumentLibrary />);
  fireEvent.click(await screen.findByRole("button", { name: "Novo documento" }));
  const form = screen.getByRole("form");
  await within(within(form).getByLabelText("Responsável pelo documento")).findByRole("option", { name: user.displayName });
  fireEvent.change(within(form).getByLabelText("Responsável pelo documento"), { target: { value: user.id } });
  fireEvent.change(within(form).getByLabelText("Setor do documento"), { target: { value: "WARD_B" } });
  expect(within(form).getByLabelText("Responsável pelo documento")).toHaveValue("");
  fireEvent.submit(form);
  expect(writes()).toHaveLength(0);
  fireEvent.change(within(form).getByLabelText("Responsável pelo documento"), { target: { value: user.id } });
  fireEvent.change(within(form).getByLabelText("Título do documento"), { target: { value: "Meu rascunho" } });
  fireEvent.submit(form);
  await screen.findByRole("alert");
  expect(within(form).getByLabelText("Título do documento")).toHaveValue("Meu rascunho");
  expect(screen.queryByRole("link", { name: /Abrir Protocolo/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Voltar sem criar documento" }));
  expect(screen.queryByRole("form")).not.toBeInTheDocument();
});

it("blocks creation when its authorized options fail and removes the open form when access is withdrawn", async () => {
  const read = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => { if (path.endsWith("/options")) throw new ApiClientError(403, { error: { code: "SCOPE_DENIED" } }); return read(path, init); });
  render(<HospitalDocumentLibrary />);
  fireEvent.click(await screen.findByRole("button", { name: "Novo documento" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Salvar rascunho do documento" })).toBeDisabled());
  fireEvent.submit(screen.getByRole("form"));
  expect(writes()).toHaveLength(0);
  user = { ...user, permissions: ["hospital_document.view"] };
  act(() => window.dispatchEvent(new Event("cvg:realtime-resync")));
  await waitFor(() => expect(screen.queryByRole("form")).not.toBeInTheDocument());
});

it("identifies archived, locked and unpublished documents while keeping library readers free of creation controls", async () => {
  user = { ...user, permissions: ["hospital_document.view"] };
  const read = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => path.startsWith("/hospital-documents?") ? uiPage([
    { id: "archived", title: "Protocolo retirado", code: "OLD", departmentCode: "INPATIENT", archived: true, currentRevision: 3, currentStatus: "RETIRED", favorite: true, hasDraft: true, updatedAt: "2026-10-11T12:00:00Z" },
    { id: "locked", title: "Protocolo bloqueado", code: "LOCKED", departmentCode: "INPATIENT", locked: true, currentRevision: 2, currentStatus: "APPROVED", updatedAt: "2026-10-11T12:00:00Z" },
    { id: "draft", title: "Documento inicial", code: "DRAFT", departmentCode: "INPATIENT", archived: false, locked: false, updatedAt: "2026-10-11T12:00:00Z" }
  ]) as never : read(path, init));
  render(<HospitalDocumentLibrary />);
  const archived = (await screen.findByRole("link", { name: "Protocolo retirado" })).closest("li")!;
  expect(archived).toHaveTextContent("Arquivado · Favorito");
  expect(archived).toHaveTextContent("Revisão publicada 3 · Retirada · rascunho em preparação");
  expect(screen.getByRole("link", { name: "Protocolo bloqueado" }).closest("li")).toHaveTextContent("Bloqueado para edição");
  expect(screen.getByRole("link", { name: "Documento inicial" }).closest("li")).toHaveTextContent("Sem revisão publicada");
  expect(screen.queryByRole("button", { name: "Novo documento" })).not.toBeInTheDocument();
});

function Editor({ initial = EMPTY_DOCUMENT }: { initial?: HospitalDocumentContent }) {
  const [value, setValue] = useState(initial);
  return <><HospitalDocumentContentEditor value={value} onChange={setValue} /><output aria-label="Documento salvo">{JSON.stringify(value)}</output><HospitalDocumentRenderer content={value} /></>;
}
const saved = (): HospitalDocumentContent => JSON.parse(screen.getByRole("status", { name: "Documento salvo" }).textContent!);

it("authors headings, lists, quotations and literal code, then reorders and removes complete blocks", () => {
  render(<Editor />);
  fireEvent.click(screen.getByRole("button", { name: "Adicionar título" }));
  fireEvent.change(screen.getByLabelText("Nível do título"), { target: { value: "3" } });
  fireEvent.change(screen.getByLabelText("Bloco 2, texto 1"), { target: { value: "Materiais" } });
  fireEvent.click(screen.getByRole("button", { name: "Adicionar lista" }));
  fireEvent.click(screen.getByLabelText("Lista numerada"));
  fireEvent.change(screen.getByLabelText("Bloco 3, item 1, texto 1"), { target: { value: "Verificar estoque" } });
  fireEvent.click(screen.getByRole("button", { name: "Adicionar item à lista 3" }));
  fireEvent.change(screen.getByLabelText("Bloco 3, item 2, texto 1"), { target: { value: "Descartável" } });
  fireEvent.click(screen.getByRole("button", { name: "Remover item 2" }));
  fireEvent.click(screen.getByRole("button", { name: "Adicionar citação" }));
  fireEvent.change(screen.getByLabelText("Bloco 4, texto 1"), { target: { value: "Aguardar validação do responsável" } });
  fireEvent.click(screen.getByRole("button", { name: "Adicionar código" }));
  fireEvent.change(screen.getByLabelText("Código do bloco 5"), { target: { value: "<script>não executar</script>" } });
  fireEvent.click(screen.getByRole("button", { name: "Mover bloco 5 acima" }));
  fireEvent.click(screen.getByRole("button", { name: "Remover bloco 1" }));
  expect(saved().blocks.map((block) => block.type)).toEqual(["heading", "list", "code", "quote"]);
  expect(saved().blocks[1]).toEqual({ type: "list", ordered: true, items: [[{ text: "Verificar estoque" }]] });
  expect(screen.getByRole("heading", { name: "Materiais", level: 4 })).toBeInTheDocument();
  expect(document.querySelector("article ol li")).toHaveTextContent("Verificar estoque");
  expect(document.querySelector("article pre code")).toHaveTextContent("<script>não executar</script>");
  expect(document.querySelector("script")).toBeNull();
});

it("edits independently formatted inline spans and retains only safe HTTPS links in the rendered document", () => {
  render(<Editor />);
  fireEvent.change(screen.getByLabelText("Bloco 1, texto 1"), { target: { value: "Consultar " } });
  fireEvent.click(screen.getByLabelText("Negrito — Bloco 1, trecho 1"));
  fireEvent.click(screen.getByLabelText("Itálico — Bloco 1, trecho 1"));
  fireEvent.click(screen.getByLabelText("Negrito — Bloco 1, trecho 1"));
  fireEvent.change(screen.getByLabelText("Link HTTPS — Bloco 1, trecho 1"), { target: { value: "https://example.invalid/politica" } });
  fireEvent.click(screen.getByRole("button", { name: "Adicionar trecho a Bloco 1" }));
  fireEvent.change(screen.getByLabelText("Bloco 1, texto 2"), { target: { value: "trecho removido" } });
  fireEvent.click(screen.getByRole("button", { name: "Remover trecho 2 de Bloco 1" }));
  expect(saved().blocks[0]).toEqual({ type: "paragraph", content: [{ text: "Consultar ", marks: ["emphasis"], href: "https://example.invalid/politica" }] });
  expect(screen.getByRole("link", { name: "Consultar" })).toHaveAttribute("href", "https://example.invalid/politica");
  fireEvent.change(screen.getByLabelText("Link HTTPS — Bloco 1, trecho 1"), { target: { value: "javascript:alert(1)" } });
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Link HTTPS — Bloco 1, trecho 1"), { target: { value: "" } });
  expect(saved().blocks[0]).toEqual({ type: "paragraph", content: [{ text: "Consultar ", marks: ["emphasis"] }] });
});

it("adds, edits and removes rectangular table rows and columns and can switch off the header", () => {
  render(<Editor initial={{ ...EMPTY_DOCUMENT, blocks: [] }} />);
  fireEvent.click(screen.getByRole("button", { name: "Adicionar tabela" }));
  fireEvent.change(screen.getByLabelText("Tabela 1, linha 2, coluna 2, texto 1"), { target: { value: "2 unidades" } });
  fireEvent.click(screen.getByRole("button", { name: "Adicionar linha à tabela 1" }));
  fireEvent.click(screen.getByRole("button", { name: "Adicionar coluna à tabela 1" }));
  fireEvent.click(screen.getByRole("button", { name: "Remover linha 3" }));
  fireEvent.click(screen.getByRole("button", { name: "Remover última coluna da tabela 1" }));
  fireEvent.click(screen.getByLabelText("Primeira linha como cabeçalho"));
  const block = saved().blocks[0];
  expect(block.type).toBe("table");
  if (block.type !== "table") throw new Error("Expected authored table");
  expect(block.header).toBe(false);
  expect(block.rows.map((row) => row.length)).toEqual([2, 2]);
  expect(block.rows[1][1]).toEqual([{ text: "2 unidades" }]);
  expect(within(screen.getByRole("table")).getAllByRole("cell")).toHaveLength(4);
  expect(screen.queryByRole("columnheader")).not.toBeInTheDocument();
});
