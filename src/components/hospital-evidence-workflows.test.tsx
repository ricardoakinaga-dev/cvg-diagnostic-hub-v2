/** @vitest-environment jsdom */
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HospitalDocumentSnapshot, HospitalTaskPublicAttachment, Permission } from "@cvg/contracts";
import { HospitalTaskAttachments } from "./hospital-task-attachments";
import { HospitalTaskReactions } from "./hospital-task-reactions";
import { HospitalDocumentPicker, HospitalDocumentSnapshots } from "./hospital-document-bindings";
import { apiFetch, ApiClientError } from "./api-client";
import { hospitalUser, uiPage } from "./hospital-ui.test-helpers";
import { taskView } from "./planner.test-helpers";
vi.mock("next/link", () => ({ default: ({ children, ...props }: { children: React.ReactNode; href: string }) => <a {...props}>{children}</a> }));
vi.mock("./api-client", async (original) => ({ ...await original<typeof import("./api-client")>(), apiFetch: vi.fn() }));
const permissions: Permission[] = ["hospital_task.attachment.view", "hospital_task.attachment.upload", "hospital_task.attachment.download", "hospital_task.comment.create", "hospital_document.view"];
const user = { ...hospitalUser, permissions };
const view = taskView({}, permissions);
const attachment: HospitalTaskPublicAttachment = { id: "evidence-one", taskId: view.task.id, safeName: "evidencia.pdf", declaredMime: "application/pdf", sizeBytes: 5, checksum: "a".repeat(64), scanStatus: "CLEAN", uploadStatus: "INITIATED", expiresAt: "2026-10-11T13:00:00Z", createdBy: user.id, createdAt: "2026-10-11T12:00:00Z", updatedAt: "2026-10-11T12:00:00Z", version: 1 };
const writes = () => vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method);
beforeEach(() => { vi.mocked(apiFetch).mockReset(); vi.mocked(apiFetch).mockResolvedValue(uiPage([]) as never); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("rejects empty, oversized and unsupported task evidence before hashing or requesting an upload", async () => {
  render(<HospitalTaskAttachments user={user} view={view} />);
  const input = screen.getByLabelText(/Anexar PDF/);
  for (const file of [new File([], "empty.pdf", { type: "application/pdf" }), new File(["x"], "unsafe.html", { type: "text/html" }), new File([new Uint8Array(10 * 1024 * 1024 + 1)], "big.pdf", { type: "application/pdf" })]) {
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar ou retomar anexo" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Escolha PDF, JPEG ou PNG");
  }
  expect(writes()).toHaveLength(0);
});

it("resumes the same upload intent after transport and finalization failures without repeating a confirmed PUT", async () => {
  let putAttempts = 0; let finalAttempts = 0;
  vi.stubGlobal("crypto", { subtle: { digest: vi.fn().mockResolvedValue(new Uint8Array(32).buffer) }, randomUUID: () => "evidence-intent" });
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path.includes("/attachments?")) return uiPage([]) as never;
    if (path.endsWith("upload-sessions")) return { attachment, uploadUrl: "/api/v1/hospital-task-attachments/evidence-one/content", expiresAt: attachment.expiresAt } as never;
    if (path.endsWith("/content")) { if (++putAttempts === 1) throw new ApiClientError(503, { error: { code: "SOURCE_UNAVAILABLE" } }); return { attachment: { ...attachment, uploadStatus: "UPLOADED", version: 2 } } as never; }
    if (path.endsWith("/finalize")) { if (++finalAttempts === 1) throw new ApiClientError(503, { error: { code: "SOURCE_UNAVAILABLE" } }); return { attachment: { ...attachment, uploadStatus: "FINALIZED", scanStatus: "PENDING", version: 3 } } as never; }
    throw new Error(`Unexpected evidence ${path} ${init?.method}`);
  });
  render(<HospitalTaskAttachments user={user} view={view} />);
  fireEvent.change(screen.getByLabelText(/Anexar PDF/), { target: { files: [new File(["hello"], "evidencia.pdf", { type: "application/pdf" })] } });
  const upload = screen.getByRole("button", { name: "Enviar ou retomar anexo" });
  fireEvent.click(upload); await screen.findByRole("alert");
  await waitFor(() => expect(upload).toHaveAttribute("data-action-state", "idle"));
  fireEvent.click(upload); await waitFor(() => expect(finalAttempts).toBe(1));
  await waitFor(() => expect(upload).toHaveAttribute("data-action-state", "idle"));
  fireEvent.click(upload); await screen.findByText("Envio registrado. Consulte o estado real da verificação antes do download.");
  const commands = writes();
  expect(commands.filter(([path]) => path.endsWith("upload-sessions"))).toHaveLength(1);
  const puts = commands.filter(([path]) => path.endsWith("/content"));
  expect(puts).toHaveLength(2);
  expect(new Headers(puts[0][1]!.headers).get("idempotency-key")).toBe(new Headers(puts[1][1]!.headers).get("idempotency-key"));
  expect(commands.filter(([path]) => path.endsWith("/finalize")).map(([, init]) => JSON.parse(init!.body as string))).toEqual([{ expectedVersion: 2 }, { expectedVersion: 2 }]);
  expect(screen.queryByRole("link", { name: /Baixar/ })).not.toBeInTheDocument();
});

it("pages verified attachment references and offers a download only for a finalized clean file", async () => {
  vi.mocked(apiFetch).mockImplementation(async (path) => uiPage([{ ...attachment, id: path.includes("cursor=") ? "next-file" : attachment.id, safeName: path.includes("cursor=") ? "proxima.pdf" : attachment.safeName, uploadStatus: "FINALIZED", scanStatus: path.includes("cursor=") ? "FAILED" : "CLEAN" }], path.includes("cursor=") ? undefined : "next") as never);
  render(<HospitalTaskAttachments user={user} view={{ ...view, permissions: ["hospital_task.attachment.view", "hospital_task.attachment.download"] }} />);
  expect(await screen.findByRole("link", { name: "Baixar evidencia.pdf" })).toHaveAttribute("href", "/api/v1/hospital-task-attachments/evidence-one/content");
  fireEvent.click(screen.getByRole("button", { name: "Carregar mais anexos" }));
  await screen.findByText("proxima.pdf");
  expect(screen.queryByRole("link", { name: "Baixar proxima.pdf" })).not.toBeInTheDocument();
  expect(screen.queryByLabelText(/Anexar PDF/)).not.toBeInTheDocument();
});

it("toggles only the current user's reaction with its task version and keeps read-only reactions disabled", async () => {
  const changed = vi.fn(); vi.mocked(apiFetch).mockResolvedValue({ changed: true } as never);
  const reactionView = taskView({ reactions: [{ userId: user.id, code: "LIKE", createdAt: "2026-10-11T12:00:00Z" }, { userId: "another", code: "THANKS", createdAt: "2026-10-11T12:00:00Z" }] }, permissions);
  const rendered = render(<HospitalTaskReactions user={user} view={reactionView} onChanged={changed} />);
  fireEvent.click(screen.getByRole("button", { name: "Gostei · 1" }));
  await waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(JSON.parse(writes()[0][1]!.body as string)).toEqual({ code: "LIKE", active: false, expectedVersion: view.task.version });
  rendered.rerender(<HospitalTaskReactions user={user} view={reactionView} onChanged={changed} disabled />);
  expect(screen.getByRole("button", { name: "Obrigado · 1" })).toBeDisabled();
  rendered.rerender(<HospitalTaskReactions user={user} view={taskView({ isDraft: true }, permissions)} onChanged={changed} />);
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});

it("selects only currently approved document links, pages options and permits explicitly removing a withdrawn binding", async () => {
  vi.mocked(apiFetch).mockImplementation(async (path) => uiPage([{ id: path.includes("cursor=") ? "next-doc" : "approved", title: path.includes("cursor=") ? "Protocolo adicional" : "Protocolo aprovado", currentRevision: 2, currentStatus: "APPROVED", archived: false }, { id: "retired", title: "Publicação retirada", currentStatus: "RETIRED" }, { id: "archived", title: "Publicação arquivada", currentStatus: "APPROVED", archived: true }], path.includes("cursor=") ? undefined : "next") as never);
  function Picker() { const [ids, setIds] = useState(["withdrawn"]); return <><HospitalDocumentPicker user={user} departmentCode="INPATIENT" value={ids} onChange={setIds} /><output aria-label="Documentos vinculados">{JSON.stringify(ids)}</output></>; }
  render(<Picker />);
  await screen.findByLabelText("Protocolo aprovado · revisão 2");
  expect(screen.queryByText("Publicação retirada")).not.toBeInTheDocument();
  expect(screen.queryByText("Publicação arquivada")).not.toBeInTheDocument();
  fireEvent.click(screen.getByLabelText("Vínculo existente fora das opções atuais"));
  fireEvent.click(screen.getByLabelText("Protocolo aprovado · revisão 2"));
  fireEvent.click(screen.getByLabelText("Protocolo aprovado · revisão 2"));
  fireEvent.click(screen.getByRole("button", { name: "Mais protocolos disponíveis" }));
  fireEvent.click(await screen.findByLabelText("Protocolo adicional · revisão 2"));
  expect(screen.getByRole("status", { name: "Documentos vinculados" })).toHaveTextContent('["next-doc"]');
});

it("shows the captured approved protocol content and references without replacing it with the current document", () => {
  const snapshot: HospitalDocumentSnapshot = { documentId: "protocol", revisionId: "approved-v2", code: "PROTO", title: "Protocolo capturado", revision: 2, departmentCode: "INPATIENT", approvedBy: user.id, approvedAt: "2026-10-11T11:00:00Z", policyReference: "POL-SYNTHETIC", capturedAt: "2026-10-11T12:00:00Z", content: { type: "hospital-document", version: 1, blocks: [{ type: "paragraph", content: [{ text: "Conteúdo da publicação aprovada" }] }] } };
  render(<HospitalDocumentSnapshots snapshots={[snapshot]} />);
  fireEvent.click(screen.getByText("Protocolo capturado · revisão 2"));
  expect(screen.getByText("Conteúdo da publicação aprovada")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Consultar documento e revisões atuais" })).toHaveAttribute("href", "/planner/documents/protocol");
  expect(within(screen.getByRole("article")).queryByRole("textbox")).not.toBeInTheDocument();
});

it("keeps an empty or unauthorized protocol picker free of write choices", async () => {
  const rendered = render(<HospitalDocumentPicker user={user} departmentCode="INPATIENT" value={[]} onChange={vi.fn()} />);
  await screen.findByText("Nenhum documento autorizado neste setor.");
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  rendered.rerender(<HospitalDocumentPicker user={{ ...user, permissions: [] }} departmentCode="INPATIENT" value={[]} onChange={vi.fn()} />);
  expect(screen.queryByRole("group")).not.toBeInTheDocument();
  rendered.rerender(<HospitalDocumentSnapshots snapshots={[]} />);
  expect(screen.queryByRole("heading")).not.toBeInTheDocument();
});
