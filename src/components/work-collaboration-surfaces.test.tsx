/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HospitalTaskAttachmentSession, HospitalTaskCommentView, HospitalTaskPublicAttachment, Permission, SessionUser, WorkActivityPreferenceView, WorkNotificationView } from "@cvg/contracts";
import { WorkInbox } from "./work-inbox";
import { WorkActivityLibrary } from "./work-activity-library";
import { WorkActivityControls, WorkActivityDisclosure } from "./work-activity-controls";
import { HospitalTaskComments } from "./hospital-task-comments";
import { HospitalTaskAttachments, attachmentUploadPath } from "./hospital-task-attachments";
import { apiFetch, ApiClientError } from "./api-client";
import { hospitalUser, uiPage } from "./hospital-ui.test-helpers";
import { taskView } from "./planner.test-helpers";
vi.mock("next/link", () => ({ default: ({ children, ...props }: { children: React.ReactNode; href: string }) => <a {...props}>{children}</a> }));
vi.mock("./api-client", async (original) => ({ ...await original<typeof import("./api-client")>(), apiFetch: vi.fn() }));
const permissions: Permission[] = ["work_notification.view", "work_notification.read", "work_notification.archive", "work_activity.preference.manage", "hospital_task.comment.view", "hospital_task.comment.create", "hospital_task.comment.edit_own", "hospital_task.comment.moderate", "hospital_task.attachment.view", "hospital_task.attachment.upload", "hospital_task.attachment.download"];
let user: SessionUser;
const notice = (id: string): WorkNotificationView => ({ notification: { id, sourceKey: id, userId: hospitalUser.id, targetType: "HOSPITAL_TASK", targetId: "task-1", eventType: "TASK_CHANGED", version: 3, createdAt: "2026-10-11T12:00:00Z" }, target: { targetType: "HOSPITAL_TASK", targetId: "task-1", label: `Atividade ${id}`, deepLink: "/planner/tasks/task-1" }, permissions: ["work_notification.read", "work_notification.archive"] });
const comment = (): HospitalTaskCommentView => ({ comment: { id: "comment-1", taskId: "task-1", authorId: hospitalUser.id, body: "Comentário anterior", mentionedUserIds: [], revisions: [], version: 8, createdAt: "2026-10-11T12:00:00Z", updatedAt: "2026-10-11T12:00:00Z" }, author: { id: hospitalUser.id, displayName: hospitalUser.displayName }, permissions: ["hospital_task.comment.view", "hospital_task.comment.edit_own", "hospital_task.comment.moderate"] });
const attachment: HospitalTaskPublicAttachment = { id: "attachment-1", taskId: "task-1", safeName: "evidencia.pdf", declaredMime: "application/pdf", sizeBytes: 5, checksum: "a".repeat(64), scanStatus: "PENDING", uploadStatus: "INITIATED", expiresAt: "2026-10-11T13:00:00Z", createdBy: hospitalUser.id, createdAt: "2026-10-11T12:00:00Z", updatedAt: "2026-10-11T12:00:00Z", version: 1 };
beforeEach(() => { user = { ...hospitalUser, permissions }; vi.mocked(apiFetch).mockImplementation(async (path) => { if (path === "/session/me") return { user } as never; throw new Error(`Unexpected collaboration API ${path}`); }); });
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });
it("does not register every listed reference as recent and records the explicitly opened one with body version zero", async () => {
  vi.mocked(apiFetch).mockImplementation(async (_path, init) => init?.method ? { preference: { id: "pref", version: 1 }, target: { targetType: "HOSPITAL_RESOURCE", targetId: "resource" } } as never : uiPage([]) as never);
  render(<WorkActivityDisclosure user={user} targetType="HOSPITAL_RESOURCE" targetId="resource" />); expect(apiFetch).not.toHaveBeenCalled(); const disclosure = screen.getByText("Seu acompanhamento desta referência").closest("details")!; disclosure.open = true; fireEvent(disclosure, new Event("toggle")); await screen.findByLabelText("Sua nota privada"); const write = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method)!; expect(JSON.parse(write[1]!.body as string)).toEqual({ targetType: "HOSPITAL_RESOURCE", targetId: "resource", opened: true, hiddenFromRecents: false, expectedVersion: 0 }); expect(new Headers(write[1]!.headers).has("if-match")).toBe(false);
});
it("keeps a late private-note response from an earlier identity out of the current editor", async () => {
  let resolveOld: ((value: unknown) => void) | undefined;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path.includes("targetId=old")) return new Promise<unknown>((resolve) => { resolveOld = resolve; }) as never;
    const entry = { preference: { id: "new-pref", version: init?.method ? 2 : 1, privateNote: "Nota particular atual" }, target: { targetType: "HOSPITAL_TASK", targetId: "new" } };
    return init?.method ? entry as never : uiPage([entry]) as never;
  });
  const ui = render(<WorkActivityControls user={user} targetType="HOSPITAL_TASK" targetId="old" />); await waitFor(() => expect(resolveOld).toBeDefined()); ui.rerender(<WorkActivityControls user={{ ...user, id: "another-authorized-user" }} targetType="HOSPITAL_TASK" targetId="new" />); await screen.findByLabelText("Sua nota privada"); await act(async () => resolveOld?.(uiPage([{ preference: { id: "old-pref", version: 8, privateNote: "Nota sigilosa da outra conta" } }]))); expect(screen.getByLabelText("Sua nota privada")).toHaveValue("Nota particular atual"); expect(screen.queryByText("Nota sigilosa da outra conta")).not.toBeInTheDocument();
});
it("pages the inbox by notification identity and uses personal read/archive commands independently from clinical acknowledgement", async () => { const original = vi.mocked(apiFetch).getMockImplementation()!; let archived = false; vi.mocked(apiFetch).mockImplementation(async (path, init) => { if (path.startsWith("/work-notifications?")) return uiPage(path.includes("cursor=") ? [notice("one"), notice("two")] : [{ ...notice("one"), notification: { ...notice("one").notification, ...(archived ? { archivedAt: "2026-10-11T12:10:00Z" } : {}) } }], path.includes("cursor=") ? undefined : "next") as never; if (path.endsWith("/archive")) { archived = true; return notice("one") as never; } if (path === "/work-notifications/read") return { marked: 1 } as never; return original(path, init); }); render(<WorkInbox />); await screen.findByRole("link", { name: "Atividade one" }); fireEvent.click(screen.getByRole("button", { name: "Carregar mais avisos" })); await screen.findByRole("link", { name: "Atividade two" }); expect(screen.getAllByRole("link", { name: "Atividade one" })).toHaveLength(1); fireEvent.click(screen.getAllByRole("button", { name: "Marcar como lida" })[0]); await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/work-notifications/read", expect.objectContaining({ body: JSON.stringify({ notificationIds: ["one"], read: true }) }))); fireEvent.click(screen.getAllByRole("button", { name: "Arquivar na minha caixa" })[0]); await screen.findByRole("button", { name: "Restaurar na caixa" }); const writes = vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method); expect(writes.every(([path]) => path.startsWith("/work-notifications"))).toBe(true); expect(JSON.parse(writes.at(-1)![1]!.body as string)).toEqual({ archived: true, expectedVersion: 3 }); });
it("removes inbox targets after a scope denial and does not show actions to read-only recipients", async () => { user = { ...user, permissions: ["work_notification.view"] }; let denied = false; const original = vi.mocked(apiFetch).getMockImplementation()!; vi.mocked(apiFetch).mockImplementation(async (path, init) => { if (path.startsWith("/work-notifications?")) { if (denied) throw new ApiClientError(403, { error: { code: "SCOPE_DENIED" } }); return uiPage([notice("restricted-later")]) as never; } return original(path, init); }); render(<WorkInbox />); await screen.findByRole("link", { name: "Atividade restricted-later" }); expect(screen.queryByRole("button", { name: "Marcar como lida" })).not.toBeInTheDocument(); denied = true; act(() => window.dispatchEvent(new Event("cvg:realtime-updated"))); await waitFor(() => expect(screen.queryByRole("link", { name: "Atividade restricted-later" })).not.toBeInTheDocument()); });
it("reads the exact private preference before initializing version zero and never emits If-Match zero", async () => { vi.mocked(apiFetch).mockImplementation(async (path, init) => path.startsWith("/work-activity-preferences?") ? uiPage([]) as never : init?.method ? { preference: { id: "pref-1", version: 1, favorite: false, following: false, hiddenFromRecents: false }, target: { targetType: "HOSPITAL_TASK", targetId: "target-after-page-100" } } as never : [] as never); render(<WorkActivityControls user={user} targetType="HOSPITAL_TASK" targetId="target-after-page-100" />); fireEvent.change(await screen.findByLabelText("Sua nota privada"), { target: { value: "Minha nota" } }); fireEvent.submit(screen.getByRole("form", { name: "Nota privada" })); await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/work-activity-preferences", expect.objectContaining({ method: "PUT" }))); expect(vi.mocked(apiFetch).mock.calls[0][0]).toContain("targetId=target-after-page-100"); const write = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method && String(init.body).includes("privateNote"))!; expect(JSON.parse(write[1]!.body as string)).toEqual({ targetType: "HOSPITAL_TASK", targetId: "target-after-page-100", privateNote: "Minha nota", expectedVersion: 1 }); expect(new Headers(write[1]!.headers).has("if-match")).toBe(false); });
it("edits with the comment version, preserves its text on conflict and requires a reason to moderate another author", async () => { const own = comment(); vi.mocked(apiFetch).mockImplementation(async (path, init) => { if (!init?.method) return uiPage([own]) as never; throw new ApiClientError(409, { error: { code: "STALE_VERSION" } }); }); const view = taskView({}, permissions); const ui = render(<HospitalTaskComments user={user} view={view} />); fireEvent.click(await screen.findByRole("button", { name: "Editar meu comentário" })); fireEvent.change(within(screen.getByRole("form", { name: "Editar comentário" })).getByLabelText("Texto do comentário"), { target: { value: "Meu texto editado" } }); fireEvent.submit(screen.getByRole("form", { name: "Editar comentário" })); await screen.findByRole("alert"); expect(screen.getByRole("form", { name: "Editar comentário" })).toHaveTextContent("Os dados mudaram"); expect(JSON.parse(vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method)![1]!.body as string).expectedVersion).toBe(8); ui.unmount(); const other = { ...own, comment: { ...own.comment, authorId: "other" }, permissions: ["hospital_task.comment.view", "hospital_task.comment.moderate"] as Permission[] }; vi.mocked(apiFetch).mockImplementation(async () => uiPage([other]) as never); render(<HospitalTaskComments user={user} view={view} />); fireEvent.click(await screen.findByRole("button", { name: "Remover comentário" })); expect(screen.getByLabelText("Motivo da remoção")).toBeRequired(); });
it("a removed comment is a tombstone even if a malformed source contains old body or revisions", async () => { const entry = comment(); entry.comment.deletedAt = "2026-10-11T12:10:00Z"; entry.comment.body = "Texto privado removido"; entry.comment.revisions = [{ version: 2, body: "Histórico privado removido", mentionedUserIds: [], editedBy: "other", editedAt: "2026-10-11T12:00:00Z" }]; vi.mocked(apiFetch).mockResolvedValue(uiPage([entry]) as never); render(<HospitalTaskComments user={user} view={taskView({}, permissions)} />); await screen.findByText(/Comentário removido/); expect(screen.queryByText("Texto privado removido")).not.toBeInTheDocument(); expect(screen.queryByText("Histórico privado removido")).not.toBeInTheDocument(); });
it("uploads bounded task evidence and finalizes the uploaded attachment version without fabricating a result version", async () => { const session: HospitalTaskAttachmentSession = { attachment, uploadUrl: "/api/v1/hospital-task-attachments/attachment-1/content", expiresAt: attachment.expiresAt }; const digest = vi.fn().mockResolvedValue(new Uint8Array(32).buffer); vi.stubGlobal("crypto", { subtle: { digest }, randomUUID: () => "synthetic-intent" }); vi.mocked(apiFetch).mockImplementation(async (path, init) => { if (path.includes("attachments?")) return uiPage([]) as never; if (path.endsWith("upload-sessions")) return session as never; if (path.endsWith("/content")) return { attachment: { ...attachment, version: 2, uploadStatus: "UPLOADED", scanStatus: "CLEAN" } } as never; if (path.endsWith("/finalize")) return { attachment: { ...attachment, version: 3, uploadStatus: "FINALIZED", scanStatus: "CLEAN" } } as never; throw new Error(`Unexpected ${path} ${init?.method}`); }); render(<HospitalTaskAttachments user={user} view={taskView({}, permissions)} />); const file = new File(["hello"], "evidencia.pdf", { type: "application/pdf" }); fireEvent.change(screen.getByLabelText(/Anexar PDF/), { target: { files: [file] } }); fireEvent.click(screen.getByRole("button", { name: "Enviar ou retomar anexo" })); await screen.findByText("Arquivo finalizado e verificado."); const calls = vi.mocked(apiFetch).mock.calls; expect(JSON.parse(calls.find(([path]) => path.endsWith("upload-sessions"))![1]!.body as string)).toMatchObject({ expectedVersion: 4, sizeBytes: 5, checksum: "0".repeat(64) }); expect(JSON.parse(calls.find(([path]) => path.endsWith("/finalize"))![1]!.body as string)).toEqual({ expectedVersion: 2 }); expect(calls.some(([path]) => path.includes("result-version"))).toBe(false); expect(() => attachmentUploadPath({ ...session, uploadUrl: "https://external.invalid/upload" })).toThrow("Destino de envio inválido"); });
it("keeps quarantined and unfinalized attachments unavailable for download", async () => { vi.mocked(apiFetch).mockResolvedValue(uiPage([{ ...attachment, scanStatus: "QUARANTINED", uploadStatus: "UPLOADED" }, { ...attachment, id: "clean-not-final", safeName: "ainda.pdf", scanStatus: "CLEAN", uploadStatus: "UPLOADED" }]) as never); render(<HospitalTaskAttachments user={user} view={taskView({}, permissions)} />); await screen.findByText(/Em quarentena/); expect(screen.queryByRole("link", { name: /Baixar/ })).not.toBeInTheDocument(); });

it("shows private favorite notes only for authorized targets, filters and pages by preference identity", async () => {
  const read = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => path.startsWith("/work-activity-preferences?") ? uiPage([{ preference: { id: path.includes("cursor=") ? "pref-two" : "pref-one", favoriteGroup: "Meu plantão", privateNote: "Nota pessoal sintética", lastOpenedAt: "2026-10-11T12:00:00Z" }, target: { targetType: "HOSPITAL_TASK", targetId: "task-1", label: path.includes("cursor=") ? "Atividade adicional" : "Atividade acompanhada", deepLink: "/planner/tasks/task-1" } }], path.includes("cursor=") ? undefined : "next") as never : read(path, init));
  render(<WorkActivityLibrary />);
  await screen.findByRole("link", { name: "Atividade acompanhada" });
  expect(screen.getByText("Nota pessoal sintética")).toBeInTheDocument();
  expect(screen.getByText("Grupo pessoal: Meu plantão")).toBeInTheDocument();
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method)).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Carregar mais acompanhamentos" }));
  await screen.findByRole("link", { name: "Atividade adicional" });
  for (const mode of ["RECENTS", "FOLLOWING", "NOTES", "ALL"]) {
    fireEvent.change(screen.getByLabelText("Mostrar"), { target: { value: mode } });
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(`/work-activity-preferences?mode=${mode}&limit=50`));
  }
});

it("removes personal notes on a current scope refusal and does not query preferences for an ungranted account", async () => {
  let denied = false; const read = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path.startsWith("/work-activity-preferences?")) { if (denied) throw new ApiClientError(404, { error: { code: "SCOPE_DENIED" } }); return uiPage([{ preference: { id: "private", privateNote: "Nota retirada do acesso" }, target: { targetType: "HOSPITAL_TASK", targetId: "task-1", label: "Alvo privado", deepLink: "/planner/tasks/task-1" } }]) as never; }
    return read(path, init);
  });
  const rendered = render(<WorkActivityLibrary />);
  await screen.findByText("Nota retirada do acesso");
  denied = true; act(() => window.dispatchEvent(new Event("cvg:realtime-updated")));
  await waitFor(() => expect(screen.queryByText("Nota retirada do acesso")).not.toBeInTheDocument());
  expect(screen.queryByRole("link", { name: "Alvo privado" })).not.toBeInTheDocument();
  rendered.unmount(); user = { ...user, permissions: [] }; vi.mocked(apiFetch).mockClear();
  render(<WorkActivityLibrary />);
  await screen.findByText("Recurso fora do seu acesso");
  expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path.startsWith("/work-activity-preferences"))).toBe(false);
});

it("persists personal favorites, following, recent visibility, group and cleared notes without changing the target", async () => {
  let state: WorkActivityPreferenceView = { preference: { id: "preference", userId: user.id, targetType: "HOSPITAL_TASK", targetId: "task-1", favorite: false, following: false, hiddenFromRecents: false, lastOpenedAt: "2026-10-11T12:00:00Z", privateNote: "Nota anterior", version: 4, createdAt: "2026-10-11T12:00:00Z", updatedAt: "2026-10-11T12:00:00Z" }, target: { targetType: "HOSPITAL_TASK", targetId: "task-1", label: "Atividade autorizada", deepLink: "/planner/tasks/task-1" } };
  vi.mocked(apiFetch).mockImplementation(async (_path, init) => { if (!init?.method) return uiPage([state]) as never; const { expectedVersion: _version, targetType: _targetType, targetId: _targetId, opened: _opened, ...fields } = JSON.parse(init.body as string); state = { ...state, preference: { ...state.preference, ...fields, favoriteGroup: fields.favoriteGroup === null ? undefined : fields.favoriteGroup ?? state.preference.favoriteGroup, privateNote: fields.privateNote === null ? undefined : fields.privateNote ?? state.preference.privateNote, version: state.preference.version + 1 } }; return state as never; });
  render(<WorkActivityControls user={user} targetType="HOSPITAL_TASK" targetId="task-1" />);
  await screen.findByLabelText("Sua nota privada");
  fireEvent.click(screen.getByRole("button", { name: "Adicionar aos favoritos" }));
  await screen.findByRole("button", { name: "Remover dos favoritos" });
  fireEvent.click(screen.getByRole("button", { name: "Remover dos favoritos" }));
  await screen.findByRole("button", { name: "Adicionar aos favoritos" });
  fireEvent.click(screen.getByRole("button", { name: "Acompanhar alterações" }));
  await screen.findByRole("button", { name: "Deixar de acompanhar" });
  fireEvent.click(screen.getByRole("button", { name: "Deixar de acompanhar" }));
  await screen.findByRole("button", { name: "Acompanhar alterações" });
  fireEvent.click(screen.getByRole("button", { name: "Remover dos recentes" }));
  await waitFor(() => expect(state.preference.hiddenFromRecents).toBe(true));
  await waitFor(() => expect(screen.getByRole("button", { name: "Registrar nos meus recentes" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Registrar nos meus recentes" }));
  await waitFor(() => expect(state.preference.hiddenFromRecents).toBe(false));
  fireEvent.change(screen.getByLabelText("Grupo pessoal do favorito"), { target: { value: "  Plantão da manhã  " } });
  fireEvent.submit(screen.getByRole("form", { name: "Agrupar favorito" }));
  await waitFor(() => expect(state.preference.favoriteGroup).toBe("Plantão da manhã"));
  await waitFor(() => expect(screen.getByLabelText("Grupo pessoal do favorito")).toHaveValue("Plantão da manhã"));
  fireEvent.change(screen.getByLabelText("Grupo pessoal do favorito"), { target: { value: "" } });
  fireEvent.submit(screen.getByRole("form", { name: "Agrupar favorito" }));
  await waitFor(() => expect(state.preference.favoriteGroup).toBeUndefined());
  await waitFor(() => expect(screen.getByLabelText("Sua nota privada")).toBeEnabled());
  fireEvent.change(screen.getByLabelText("Sua nota privada"), { target: { value: "  " } });
  fireEvent.submit(screen.getByRole("form", { name: "Nota privada" }));
  await waitFor(() => expect(state.preference.privateNote).toBeUndefined());
  const writes = vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method);
  expect(writes.every(([path]) => path === "/work-activity-preferences")).toBe(true);
  expect(JSON.parse(writes[8][1]!.body as string).favoriteGroup).toBeNull();
  expect(JSON.parse(writes[9][1]!.body as string).privateNote).toBeNull();
  expect(writes.map(([, init]) => JSON.parse(init!.body as string).expectedVersion)).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
});

it("recovers a failed private-preference read and keeps a read-only preference free of opening or saving commands", async () => {
  let failed = true;
  vi.mocked(apiFetch).mockImplementation(async () => { if (failed) throw new ApiClientError(503, { error: { code: "SOURCE_UNAVAILABLE" } }); return uiPage([]) as never; });
  const rendered = render(<WorkActivityControls user={user} targetType="HOSPITAL_TASK" targetId="task-1" readOnly />);
  const retry = await screen.findByRole("button", { name: "Recarregar preferências privadas" });
  failed = false;
  fireEvent.click(retry);
  const form = await screen.findByRole("form", { name: "Nota privada" });
  expect(screen.getByLabelText("Sua nota privada")).toBeDisabled();
  fireEvent.submit(form);
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method)).toBe(false);
  rendered.rerender(<WorkActivityControls user={{ ...user, permissions: [] }} targetType="HOSPITAL_TASK" targetId="task-1" />);
  expect(screen.queryByRole("form")).not.toBeInTheDocument();
});
