/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HospitalTaskCommentView, Permission } from "@cvg/contracts";
import { HospitalTaskComments } from "./hospital-task-comments";
import { apiFetch } from "./api-client";
import { hospitalUser, uiPage } from "./hospital-ui.test-helpers";
import { taskView } from "./planner.test-helpers";
vi.mock("./api-client", async (original) => ({ ...await original<typeof import("./api-client")>(), apiFetch: vi.fn() }));
const permissions: Permission[] = ["hospital_task.comment.view", "hospital_task.comment.create", "hospital_task.comment.edit_own", "hospital_task.comment.moderate"];
const user = { ...hospitalUser, permissions };
const view = { ...taskView({}, permissions), eligibleAssignees: [{ id: "person-one", displayName: "Profissional de plantão", role: "INPATIENT_TEAM" as const, departmentCode: "INPATIENT" }] };
let comments: HospitalTaskCommentView[];
const writes = () => vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method);
beforeEach(() => {
  vi.mocked(apiFetch).mockReset(); comments = [];
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (!init?.method && path.includes("/comments?")) return uiPage(comments) as never;
    if (init?.method) return { id: "saved-comment" } as never;
    throw new Error(`Unexpected comment workflow ${path}`);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function existing(authorId = user.id): HospitalTaskCommentView { return { comment: { id: "comment-one", taskId: view.task.id, authorId, body: "Conferência pendente", mentionedUserIds: ["person-one", "person-no-longer-visible"], revisions: [{ version: 4, body: "Mensagem anterior", mentionedUserIds: [], editedBy: authorId, editedAt: "2026-10-11T10:00:00Z" }], version: 5, createdAt: "2026-10-11T10:00:00Z", updatedAt: "2026-10-11T11:00:00Z" }, author: { id: authorId, displayName: "Autor do comentário" }, permissions }; }

it("publishes an operational comment with only selected authorized mentions and clears the form after confirmation", async () => {
  render(<HospitalTaskComments user={user} view={view} />);
  const form = screen.getByRole("form", { name: "Adicionar comentário" });
  fireEvent.submit(form); expect(writes()).toHaveLength(0);
  fireEvent.change(within(form).getByLabelText("Texto do comentário"), { target: { value: "  Conferir material antes do turno.  " } });
  fireEvent.click(within(form).getByLabelText("Profissional de plantão"));
  fireEvent.click(within(form).getByLabelText("Profissional de plantão"));
  fireEvent.click(within(form).getByLabelText("Profissional de plantão"));
  fireEvent.submit(form);
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(JSON.parse(writes()[0][1]!.body as string)).toEqual({ body: "Conferir material antes do turno.", mentionedUserIds: ["person-one"], expectedVersion: view.task.version });
  await waitFor(() => expect(within(form).getByLabelText("Texto do comentário")).toHaveValue(""));
  expect(within(form).getByLabelText("Profissional de plantão")).not.toBeChecked();
});

it("reads revision history, revises the author's version and closes the editor only on a confirmed save", async () => {
  comments = [existing()];
  render(<HospitalTaskComments user={user} view={view} />);
  await screen.findByText("Conferência pendente");
  expect(screen.getByText(/Menções:/)).toHaveTextContent("Profissional de plantão, Profissional autorizado na publicação");
  fireEvent.click(screen.getByText("Histórico do comentário"));
  expect(screen.getByText(/Mensagem anterior/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Editar meu comentário" }));
  fireEvent.click(screen.getByRole("button", { name: "Editar meu comentário" }));
  expect(screen.queryByRole("form", { name: "Editar comentário" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Editar meu comentário" }));
  const form = screen.getByRole("form", { name: "Editar comentário" });
  fireEvent.change(within(form).getByLabelText("Texto do comentário"), { target: { value: "Material conferido" } });
  fireEvent.submit(form);
  await waitFor(() => expect(screen.queryByRole("form", { name: "Editar comentário" })).not.toBeInTheDocument());
  expect(writes()[0][0]).toBe(`/hospital-tasks/${view.task.id}/comments/comment-one`);
  expect(JSON.parse(writes()[0][1]!.body as string)).toMatchObject({ body: "Material conferido", expectedVersion: 5 });
});

it("requires a reason to moderate another author and permits removal of the author's own version without one", async () => {
  comments = [{ ...existing("another-author"), permissions: ["hospital_task.comment.view", "hospital_task.comment.moderate"] }];
  const rendered = render(<HospitalTaskComments user={user} view={view} />);
  fireEvent.click(await screen.findByRole("button", { name: "Remover comentário" }));
  const form = screen.getByRole("form", { name: "Remover comentário" });
  fireEvent.submit(form); expect(writes()).toHaveLength(0);
  fireEvent.change(within(form).getByLabelText("Motivo da remoção"), { target: { value: "  Informação publicada na atividade errada  " } });
  fireEvent.submit(form);
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writes()[0][1]?.method).toBe("DELETE");
  expect(JSON.parse(writes()[0][1]!.body as string)).toEqual({ expectedVersion: 5, reason: "Informação publicada na atividade errada" });
  rendered.unmount(); comments = [existing()];
  render(<HospitalTaskComments user={user} view={view} />);
  fireEvent.click(await screen.findByRole("button", { name: "Remover comentário" }));
  fireEvent.submit(screen.getByRole("form", { name: "Remover comentário" }));
  await waitFor(() => expect(writes()).toHaveLength(2));
  expect(JSON.parse(writes()[1][1]!.body as string)).toEqual({ expectedVersion: 5 });
});

it("requires both session and contextual permissions and disables an open writer during degraded reads", async () => {
  const rendered = render(<HospitalTaskComments user={user} view={{ ...view, permissions: [] }} />);
  expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  expect(apiFetch).not.toHaveBeenCalled();
  rendered.rerender(<HospitalTaskComments user={user} view={view} readOnly />);
  const form = screen.getByRole("form", { name: "Adicionar comentário" });
  expect(within(form).getByLabelText("Texto do comentário")).toBeDisabled();
  fireEvent.submit(form);
  expect(writes()).toHaveLength(0);
  rendered.rerender(<HospitalTaskComments user={{ ...user, permissions: ["hospital_task.comment.view"] }} view={view} />);
  expect(screen.queryByRole("form")).not.toBeInTheDocument();
});
