/** @vitest-environment jsdom */
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HospitalDocumentContent, HospitalDocumentView, Permission, SessionUser } from "@cvg/contracts";
import { HospitalDocumentContentEditor, HospitalDocumentRenderer, safeDocumentLink } from "./hospital-document-content";
import { HospitalDocumentDetail } from "./hospital-document-detail";
import { HospitalDocumentLibrary } from "./hospital-document-library";
import { apiFetch, ApiClientError } from "./api-client";
import { hospitalUser, uiPage } from "./hospital-ui.test-helpers";
vi.mock("next/link", () => ({ default: ({ children, ...props }: { children: React.ReactNode; href: string }) => <a {...props}>{children}</a> }));
vi.mock("./api-client", async (original) => ({ ...await original<typeof import("./api-client")>(), apiFetch: vi.fn() }));
const permissions: Permission[] = ["hospital_document.view", "hospital_document.create", "hospital_document.update", "hospital_document.approve", "hospital_document.retire", "hospital_document.lock", "hospital_document.archive"];
const content: HospitalDocumentContent = { type: "hospital-document", version: 1, blocks: [{ type: "paragraph", content: [{ text: "Texto preservado" }] }] };
export function documentFixture(): HospitalDocumentView { return { favorite: false, permissions, document: { id: "doc-1", code: "PROTOCOLO", title: "Protocolo vigente", departmentCode: "INPATIENT", responsibleUserId: hospitalUser.id, locked: false, archived: false, version: 5, createdBy: hospitalUser.id, createdAt: "2026-10-11T12:00:00Z", updatedAt: "2026-10-11T12:00:00Z", currentPublishedRevisionId: "revision-approved", draftRevisionId: "revision-draft", revisions: [{ id: "revision-approved", revision: 1, title: "Publicação original", content, status: "APPROVED", version: 2, createdBy: hospitalUser.id, updatedBy: hospitalUser.id, createdAt: "2026-10-10T12:00:00Z", updatedAt: "2026-10-10T12:00:00Z", approvedBy: hospitalUser.id, approvedAt: "2026-10-10T12:00:00Z", policyReference: "POL-CLINICA" }, { id: "revision-draft", revision: 2, title: "Rascunho clínico", content, status: "DRAFT", version: 3, createdBy: hospitalUser.id, updatedBy: hospitalUser.id, createdAt: "2026-10-11T12:00:00Z", updatedAt: "2026-10-11T12:00:00Z" }] } }; }
let current: HospitalDocumentView; let user: SessionUser;
beforeEach(() => { current = documentFixture(); user = { ...hospitalUser, permissions }; vi.mocked(apiFetch).mockImplementation(async (path, init) => { if (path === "/session/me") return { user } as never; if (path === "/hospital-documents/doc-1" && !init?.method) return current as never; if (path === "/hospital-documents/doc-1/history") return current.document.revisions as never; if (path === "/hospital-assistance/capability") return { configured: false, requiresHumanReview: true, deploymentVerified: false } as never; if (path.endsWith("/assistance")) return [] as never; if (path === "/hospital-documents/options") return { departments: [{ code: "INPATIENT", name: "Internação" }], responsibles: [{ id: user.id, displayName: user.displayName, departmentCode: "INPATIENT" }] } as never; throw new Error(`Unexpected synthetic document path ${path}`); }); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it("renders text and code literally, rejects credential and script links, and keeps a valid HTTPS link", () => { render(<HospitalDocumentRenderer content={{ ...content, blocks: [{ type: "paragraph", content: [{ text: "<script>não executar</script>", href: "javascript:alert(1)" }, { text: "URL segura", href: "https://example.invalid/protocolo", marks: ["strong", "emphasis"] }, { text: "Credencial oculta", href: "https://secret@example.invalid" }] }, { type: "code", text: "<img src=x onerror=alert(1)>" }] }} />); expect(document.querySelector("script")).toBeNull(); expect(document.querySelector("img")).toBeNull(); expect(screen.getAllByRole("link")).toHaveLength(1); expect(screen.getByRole("link")).toHaveAttribute("rel", "noopener noreferrer"); expect(safeDocumentLink("https://name:secret@example.invalid")).toBeUndefined(); });
it("edits a structured table with rectangular rows and inline formatting", () => { function Editor() { const [value, setValue] = useState(content); return <><HospitalDocumentContentEditor value={value} onChange={setValue} /><output>{JSON.stringify(value)}</output></>; } render(<Editor />); fireEvent.click(screen.getByRole("button", { name: "Adicionar tabela" })); fireEvent.change(screen.getByLabelText("Tabela 2, linha 1, coluna 1, texto 1"), { target: { value: "Cabeçalho" } }); fireEvent.click(screen.getByRole("button", { name: "Adicionar coluna à tabela 2" })); fireEvent.click(screen.getByRole("button", { name: "Adicionar linha à tabela 2" })); const value = JSON.parse(screen.getByRole("status").textContent!); expect(value.blocks[1].rows).toHaveLength(3); expect(value.blocks[1].rows.every((row: unknown[]) => row.length === 3)).toBe(true); expect(value.blocks[1].rows[0][0][0].text).toBe("Cabeçalho"); });
it("preserves local draft content across a realtime concurrent edit and requires explicit reconciliation", async () => { render(<HospitalDocumentDetail documentId="doc-1" />); fireEvent.click(await screen.findByRole("button", { name: "Editar rascunho existente" })); fireEvent.change(screen.getByLabelText("Bloco 1, texto 1"), { target: { value: "Meu texto não salvo" } }); current = { ...current, document: { ...current.document, version: 6, revisions: current.document.revisions.map((entry) => entry.status === "DRAFT" ? { ...entry, version: 4, title: "Outro rascunho salvo" } : entry) } }; act(() => window.dispatchEvent(new Event("cvg:realtime-updated"))); await screen.findByText(/Outra alteração foi confirmada/); expect(screen.getByLabelText("Bloco 1, texto 1")).toHaveValue("Meu texto não salvo"); expect(screen.getByRole("button", { name: "Salvar revisão em rascunho" })).toBeDisabled(); fireEvent.click(screen.getByRole("button", { name: "Recarregar rascunho e descartar meu texto" })); expect(screen.getByLabelText("Título da revisão")).toHaveValue("Outro rascunho salvo"); });
it("requires approval evidence and uses document plus draft versions", async () => { const original = vi.mocked(apiFetch).getMockImplementation()!; vi.mocked(apiFetch).mockImplementation(async (path, init) => path.endsWith("/approve") ? current as never : original(path, init)); render(<HospitalDocumentDetail documentId="doc-1" />); fireEvent.click(await screen.findByRole("button", { name: "Aprovar e publicar revisão" })); fireEvent.submit(screen.getByRole("form", { name: "Confirmar comando do documento" })); expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method)).toBe(false); fireEvent.click(screen.getByRole("checkbox", { name: /Confirmo a aprovação/ })); fireEvent.change(screen.getByLabelText("Referência da política de aprovação"), { target: { value: "POL-2026" } }); fireEvent.submit(screen.getByRole("form", { name: "Confirmar comando do documento" })); await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/hospital-documents/doc-1/approve", expect.objectContaining({ method: "POST" }))); const write = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method)!; expect(JSON.parse(write[1]!.body as string)).toEqual({ confirm: true, policyReference: "POL-2026", expectedVersion: 5, expectedDraftVersion: 3 }); });
it("duplicates to a separate draft link while keeping the source document on its original route", async () => { const original = vi.mocked(apiFetch).getMockImplementation()!; vi.mocked(apiFetch).mockImplementation(async (path, init) => path.endsWith("/duplicate") ? { ...current, document: { ...current.document, id: "copy", title: "Cópia nova" } } as never : original(path, init)); render(<HospitalDocumentDetail documentId="doc-1" />); fireEvent.click(await screen.findByRole("button", { name: "Duplicar como rascunho" })); fireEvent.change(screen.getByLabelText("Código da cópia"), { target: { value: "COPIA" } }); await waitFor(() => expect(screen.getByLabelText("Novo responsável")).toHaveTextContent(user.displayName)); fireEvent.submit(screen.getByRole("form", { name: "Confirmar comando do documento" })); expect(await screen.findByRole("link", { name: "Abrir a cópia" })).toHaveAttribute("href", "/planner/documents/copy"); expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Protocolo vigente"); });
it("disables an already opened privileged command when contextual grants are withdrawn", async () => { render(<HospitalDocumentDetail documentId="doc-1" />); fireEvent.click(await screen.findByRole("button", { name: "Aprovar e publicar revisão" })); current = { ...current, permissions: ["hospital_document.view"] }; act(() => window.dispatchEvent(new Event("cvg:realtime-updated"))); await waitFor(() => expect(screen.getByRole("button", { name: "Confirmar comando do documento" })).toBeDisabled()); fireEvent.submit(screen.getByRole("form", { name: "Confirmar comando do documento" })); expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method)).toBe(false); });
it("removes document content after scope denial and loads library cursor pages without losing entries", async () => { let denied = false; const original = vi.mocked(apiFetch).getMockImplementation()!; vi.mocked(apiFetch).mockImplementation(async (path, init) => { if (denied && path === "/hospital-documents/doc-1") throw new ApiClientError(404, { error: { code: "SCOPE_DENIED" } }); return original(path, init); }); const view = render(<HospitalDocumentDetail documentId="doc-1" />); await screen.findByRole("heading", { name: "Protocolo vigente" }); denied = true; act(() => window.dispatchEvent(new Event("cvg:realtime-updated"))); await screen.findByText("Documento indisponível"); expect(screen.queryByText("Texto preservado")).not.toBeInTheDocument(); view.unmount(); vi.mocked(apiFetch).mockImplementation(async (path) => path === "/session/me" ? { user } as never : path.startsWith("/hospital-documents?") ? uiPage([{ id: path.includes("cursor=") ? "second" : "first", title: path.includes("cursor=") ? "Documento B" : "Documento A", hasDraft: true, updatedAt: "2026-10-11T12:00:00Z" }], path.includes("cursor=") ? undefined : "next") as never : [] as never); render(<HospitalDocumentLibrary />); await screen.findByRole("link", { name: "Documento A" }); fireEvent.click(screen.getByRole("button", { name: "Carregar mais documentos" })); await screen.findByRole("link", { name: "Documento B" }); expect(screen.getByRole("link", { name: "Documento A" })).toBeInTheDocument(); expect(within(screen.getByRole("list")).getAllByRole("listitem")).toHaveLength(2); });

it.each([
  { action: "lock", name: "Bloquear documento", fields: { locked: true } },
  { action: "lock", name: "Desbloquear documento", fields: { locked: false } },
  { action: "archive", name: "Arquivar documento", fields: { archived: true } },
  { action: "archive", name: "Desarquivar documento", fields: { archived: false } },
  { action: "retire", name: "Retirar publicação vigente", fields: { expectedRevisionId: "revision-approved" } }
])("requires an explicit reason and captured document version for $name", async ({ action, name, fields }) => {
  if (name.startsWith("Desbloquear")) current.document.locked = true;
  if (name.startsWith("Desarquivar")) current.document.archived = true;
  const read = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => init?.method ? { ...current, document: { ...current.document, ...fields, version: 6 } } as never : read(path, init));
  render(<HospitalDocumentDetail documentId="doc-1" />);
  fireEvent.click(await screen.findByRole("button", { name }));
  const form = screen.getByRole("form", { name: "Confirmar comando do documento" });
  fireEvent.submit(form);
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method)).toBe(false);
  fireEvent.change(within(form).getByLabelText("Motivo do comando"), { target: { value: "  Revisão institucional  " } });
  fireEvent.submit(form);
  await waitFor(() => expect(screen.queryByRole("form", { name: "Confirmar comando do documento" })).not.toBeInTheDocument());
  const write = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method)!;
  expect(write[0]).toBe(`/hospital-documents/doc-1/${action}`);
  expect(JSON.parse(write[1]!.body as string)).toEqual({ ...fields, reason: "Revisão institucional", expectedVersion: 5 });
});

it("prepares a new draft from a published document and saves content with both document and draft versions", async () => {
  current.document.draftRevisionId = undefined;
  current.document.revisions = current.document.revisions.filter((revision) => revision.status === "APPROVED");
  const draft = documentFixture().document.revisions[1];
  const read = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path.endsWith("/revisions") && init?.method) { current = { ...current, document: { ...current.document, draftRevisionId: draft.id, revisions: [...current.document.revisions, draft], version: 6 } }; return current as never; }
    if (path.endsWith("/draft") && init?.method) return { ...current, document: { ...current.document, version: 7 } } as never;
    return read(path, init);
  });
  render(<HospitalDocumentDetail documentId="doc-1" />);
  fireEvent.click(await screen.findByRole("button", { name: "Preparar nova revisão" }));
  const form = await screen.findByRole("form", { name: "Editar rascunho do documento" });
  fireEvent.change(within(form).getByLabelText("Título da revisão"), { target: { value: "  Revisão do plantão  " } });
  fireEvent.change(within(form).getByLabelText("Bloco 1, texto 1"), { target: { value: "Verificação atualizada" } });
  fireEvent.submit(form);
  await waitFor(() => expect(screen.queryByRole("form", { name: "Editar rascunho do documento" })).not.toBeInTheDocument());
  const writes = vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method);
  expect(JSON.parse(writes[0][1]!.body as string)).toEqual({ expectedVersion: 5 });
  expect(JSON.parse(writes[1][1]!.body as string)).toEqual({ title: "Revisão do plantão", content: { ...content, blocks: [{ type: "paragraph", content: [{ text: "Verificação atualizada" }] }] }, expectedVersion: 6, expectedDraftVersion: 3 });
});

it("changes the responsible using current options and can leave a command or editor without writing", async () => {
  const read = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => path === "/hospital-documents/options" ? { departments: [], responsibles: [{ id: user.id, displayName: user.displayName }, { id: "new-responsible", displayName: "Responsável novo" }] } as never : init?.method ? { ...current, document: { ...current.document, responsibleUserId: "new-responsible", version: 6 } } as never : read(path, init));
  render(<HospitalDocumentDetail documentId="doc-1" />);
  fireEvent.click(await screen.findByRole("button", { name: "Alterar responsável pelo documento" }));
  fireEvent.click(screen.getByRole("button", { name: "Voltar sem confirmar" }));
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method)).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Editar rascunho existente" }));
  fireEvent.click(screen.getByRole("button", { name: "Fechar editor de revisão" }));
  fireEvent.change(screen.getByLabelText("Revisão para consultar"), { target: { value: "revision-approved" } });
  expect(screen.getByRole("heading", { name: "Publicação original" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Alterar responsável pelo documento" }));
  await screen.findByRole("option", { name: "Responsável novo" });
  fireEvent.change(screen.getByLabelText("Novo responsável"), { target: { value: "new-responsible" } });
  fireEvent.submit(screen.getByRole("form", { name: "Confirmar comando do documento" }));
  await waitFor(() => expect(screen.queryByRole("form", { name: "Confirmar comando do documento" })).not.toBeInTheDocument());
  const write = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method)!;
  expect(write[0]).toBe("/hospital-documents/doc-1/metadata");
  expect(JSON.parse(write[1]!.body as string)).toEqual({ responsibleUserId: "new-responsible", expectedVersion: 5 });
});

it("shows a withdrawn publication as historical while preserving its content and approval record", async () => {
  const read = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path.endsWith("/retire") && init?.method) {
      current = { ...current, document: { ...current.document, version: 6, revisions: current.document.revisions.map((revision) => revision.id === current.document.currentPublishedRevisionId ? { ...revision, status: "RETIRED", version: 3, retiredAt: "2026-10-11T13:00:00Z", retiredBy: user.id, retirementReason: "Substituição do protocolo" } : revision) } };
      return current as never;
    }
    return read(path, init);
  });
  render(<HospitalDocumentDetail documentId="doc-1" />);
  expect(await screen.findByRole("option", { name: "Revisão 1 · Aprovada · publicação vigente" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retirar publicação vigente" }));
  fireEvent.change(screen.getByLabelText("Motivo do comando"), { target: { value: "Substituição do protocolo" } });
  fireEvent.submit(screen.getByRole("form", { name: "Confirmar comando do documento" }));
  expect(await screen.findByRole("option", { name: "Revisão 1 · Retirada · última publicação histórica" })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: /publicação vigente/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Retirar publicação vigente" })).not.toBeInTheDocument();
  expect(current.document.currentPublishedRevisionId).toBe("revision-approved");
  expect(screen.getByText("Texto preservado")).toBeInTheDocument();
  expect(screen.getByText(/Aprovação em.*POL-CLINICA/)).toBeInTheDocument();
  expect(screen.getByText(/Retirada em.*Substituição do protocolo/)).toBeInTheDocument();
});
