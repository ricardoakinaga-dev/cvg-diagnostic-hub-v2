/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HospitalTaskView } from "@cvg/contracts";
import { PlannerTaskDetail } from "./planner-task-detail";
import { ApiClientError, apiFetch, apiFetchWithMeta } from "./api-client";
import { plannerUser, routineType, taskView } from "./planner.test-helpers";
import { checklistSnapshot, hospitalPermissions, hospitalUser } from "./hospital-ui.test-helpers";

vi.mock("next/link", () => ({ default: ({ children, ...props }: { children: React.ReactNode; href: string }) => <a {...props}>{children}</a> }));
vi.mock("./api-client", async (original) => ({ ...await original<typeof import("./api-client")>(), apiFetch: vi.fn(), apiFetchWithMeta: vi.fn() }));
let current: HospitalTaskView;
beforeEach(() => {
  current = taskView();
  vi.mocked(apiFetchWithMeta).mockResolvedValue({ data: [], meta: { correlationId: "synthetic", requestId: "synthetic" } });
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === "/session/me") return { user: plannerUser } as never;
    if (path.startsWith("/departments")) return [] as never;
    if (path === "/hospital-tasks/options") return { departments: [], types: [], assignees: [] } as never;
    if (path === "/hospital-tasks/task-1" && !init?.method) return current as never;
    if (path === "/hospital-tasks/task-1/assignment") { current = taskView({ responsibleUserId: JSON.parse(init!.body as string).responsibleUserId, version: 5 }); return current as never; }
    if (path === "/hospital-tasks/task-1/commands") { const body = JSON.parse(init!.body as string); current = taskView({ ...current.task, version: current.task.version + 1, status: body.stateCode, phase: body.command === "START" ? "IN_PROGRESS" : body.command === "COMPLETE" ? "COMPLETED" : "CANCELLED" }, body.command === "START" ? current.permissions : ["hospital_task.view"]); return current as never; }
    throw new Error(`Unexpected synthetic API ${path}`);
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllEnvs(); });

it("assumes explicitly, starts with the task's configured state and completes through its own commands", async () => {
  render(<PlannerTaskDetail taskId="task-1" />);
  fireEvent.click(await screen.findByRole("button", { name: "Assumir atividade" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Assumir atividade" })).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "Iniciar atividade" }));
  expect(screen.getByLabelText("Estado de destino")).toHaveValue("DOING");
  fireEvent.click(screen.getByRole("button", { name: "Confirmar início" }));
  fireEvent.click(await screen.findByRole("button", { name: "Concluir atividade" }));
  fireEvent.change(screen.getByLabelText("Nota de execução (opcional)"), { target: { value: "Rotina conferida" } });
  fireEvent.click(screen.getByRole("button", { name: "Confirmar conclusão" }));
  await screen.findByText("Esta atividade está disponível somente para consulta.");
  const writes = vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method);
  expect(JSON.parse(writes[0][1]!.body as string)).toEqual({ responsibleUserId: plannerUser.id, expectedVersion: 4 });
  expect(JSON.parse(writes[1][1]!.body as string)).toEqual({ command: "START", stateCode: "DOING", expectedVersion: 5 });
  expect(JSON.parse(writes[2][1]!.body as string)).toEqual({ command: "COMPLETE", stateCode: "DONE", note: "Rotina conferida", expectedVersion: 6 });
  expect(writes.every(([path]) => path.startsWith("/hospital-tasks/"))).toBe(true);
});

it("obeys contextual read-only capabilities despite a manager's base grants", async () => {
  current = taskView({}, ["hospital_task.view"]);
  render(<PlannerTaskDetail taskId="task-1" />);
  await screen.findByRole("heading", { level: 1, name: "Conferir materiais" });
  expect(screen.queryByRole("button", { name: "Iniciar atividade" })).not.toBeInTheDocument();
  expect(screen.queryByRole("form")).not.toBeInTheDocument();
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method)).toBe(false);
});

it("keeps clinical care confirmation separate from the generic task COMPLETE command", async () => {
  current = taskView({ phase: "IN_PROGRESS", status: "DOING", checklistSnapshot }, hospitalPermissions);
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => path === "/session/me" ? { user: hospitalUser } as never : original(path, init));
  render(<PlannerTaskDetail taskId="task-1" />);
  expect(await screen.findByRole("form", { name: "Confirmar execução assistencial" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Concluir atividade" })).not.toBeInTheDocument();
  expect(vi.mocked(apiFetch).mock.calls.some(([path, init]) => path.endsWith("/commands") && init?.method)).toBe(false);
});

it("blocks the configured command on a restricted dependency without rendering its target or title", async () => {
  current = { ...taskView(), dependencies: [{ id: "restricted-link", restricted: true, satisfied: false, blocks: "START" }] };
  render(<PlannerTaskDetail taskId="task-1" />);
  expect(await screen.findByRole("button", { name: "Iniciar atividade" })).toBeDisabled();
  expect(screen.getByText(/Pendência fora do seu acesso/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Remover dependência" })).not.toBeInTheDocument();
  expect(document.body.innerHTML).not.toContain("restricted-link");
  expect(document.body.innerHTML).not.toContain("targetId");
});

it("requires a cancellation reason and never changes a clinical item", async () => {
  render(<PlannerTaskDetail taskId="task-1" />);
  fireEvent.click(await screen.findByRole("button", { name: "Cancelar atividade" }));
  fireEvent.submit(screen.getByRole("form", { name: "Confirmar comando da atividade" }));
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method)).toBe(false);
  fireEvent.change(screen.getByLabelText("Motivo do cancelamento"), { target: { value: "Demanda encerrada" } });
  fireEvent.click(screen.getByRole("button", { name: "Confirmar cancelamento" }));
  await screen.findByText("Esta atividade está disponível somente para consulta.");
  const call = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === "POST")!;
  expect(JSON.parse(call[1]!.body as string)).toEqual({ command: "CANCEL", stateCode: "CANCELLED", reason: "Demanda encerrada", expectedVersion: 4 });
});

it("preserves unsaved text and the original intent on a concurrency rejection", async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => { if (init?.method === "PATCH") throw new ApiClientError(409, { error: { code: "STALE_VERSION" } }); return original(path, init); });
  render(<PlannerTaskDetail taskId="task-1" />);
  fireEvent.change(await screen.findByLabelText("Título"), { target: { value: "Conferir materiais da emergência" } });
  fireEvent.click(screen.getByRole("button", { name: "Salvar atividade" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Os dados mudaram");
  expect(screen.getByLabelText("Título")).toHaveValue("Conferir materiais da emergência");
  fireEvent.click(screen.getByRole("button", { name: "Salvar atividade" }));
  await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(2));
  const writes = vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === "PATCH");
  expect(writes[0][1]!.headers).toEqual(writes[1][1]!.headers);
  expect(JSON.parse(writes[0][1]!.body as string)).not.toHaveProperty("phase");
});

it("preserves an unsaved edit when realtime receives a newer version and requires reconciliation", async () => {
  render(<PlannerTaskDetail taskId="task-1" />);
  fireEvent.change(await screen.findByLabelText("Título"), { target: { value: "Meu texto ainda não salvo" } });
  current = taskView({ title: "Título salvo por outro profissional", version: 5 });
  act(() => window.dispatchEvent(new Event("cvg:realtime-updated")));
  await screen.findByText(/A atividade mudou enquanto você editava/);
  expect(screen.getByLabelText("Título")).toHaveValue("Meu texto ainda não salvo");
  expect(screen.getByRole("button", { name: "Salvar atividade" })).toBeDisabled();
  fireEvent.submit(screen.getByRole("form", { name: "Editar atividade hospitalar" }));
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method)).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Recarregar e descartar minhas alterações" }));
  await waitFor(() => expect(screen.getByLabelText("Título")).toHaveValue("Título salvo por outro profissional"));
  expect(screen.getByRole("button", { name: "Salvar atividade" })).toBeEnabled();
});

it("removes an existing clinical context after the server withdraws access", async () => {
  current = { ...taskView({ patientId: "patient", encounterId: "encounter" }), patient: { id: "patient", externalId: "HIS-1", displayName: "Paciente sintético", species: "Canino", ownerLabel: "Tutor sintético" }, encounter: { id: "encounter", externalId: "AT-1", status: "OPEN", type: "OUTPATIENT" } };
  let denied = false; const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => { if (denied && path === "/hospital-tasks/task-1" && !init?.method) throw new ApiClientError(404, { error: { code: "SCOPE_DENIED" } }); return original(path, init); });
  render(<PlannerTaskDetail taskId="task-1" />);
  await screen.findByRole("link", { name: /Paciente sintético/ });
  denied = true; act(() => window.dispatchEvent(new Event("cvg:realtime-resync")));
  await waitFor(() => expect(screen.queryByRole("link", { name: /Paciente sintético/ })).not.toBeInTheDocument());
  expect(screen.queryByText(/Tutor sintético/)).not.toBeInTheDocument();
});

it("shows a patient's exact encounter and keeps pending children independent", async () => {
  current = { ...taskView({ patientId: "patient", encounterId: "encounter" }, ["hospital_task.view"]), patient: { id: "patient", externalId: "HIS-2", displayName: "Thor", species: "Canino", ownerLabel: "Tutor B" }, encounter: { id: "encounter", externalId: "AT-RECENTE", status: "OPEN", type: "INPATIENT" }, children: [taskView({ id: "child", title: "Rotina pendente", parentTaskId: "task-1" }).task] };
  render(<PlannerTaskDetail taskId="task-1" />);
  expect(await screen.findByText(/Atendimento AT-RECENTE/)).toBeInTheDocument();
  expect(screen.getByText(/tutor Tutor B/)).toBeInTheDocument();
  const children = screen.getByRole("heading", { name: "Subtarefas" }).closest("section")!;
  expect(within(children).getByRole("link", { name: "Rotina pendente" })).toHaveAttribute("href", "/planner/tasks/child");
  expect(children).toHaveTextContent("Pendente");
});

it("updates metadata and the hospital civil dates with the current revision, preserving the clinical command boundary", async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!; vi.mocked(apiFetch).mockImplementation(async (path, init) => { if (path === "/hospital-tasks/task-1" && init?.method === "PATCH") { current = taskView({ ...current.task, ...JSON.parse(init.body as string), version: 5 }); return current as never; } return original(path, init); });
  render(<PlannerTaskDetail taskId="task-1" />); fireEvent.change(await screen.findByLabelText("Título", { selector: "input" }), { target: { value: "  Rotina ajustada  " } }); fireEvent.change(screen.getByLabelText("Descrição", { selector: "textarea" }), { target: { value: "  Conferir itens do setor  " } }); const form = screen.getByRole("form", { name: "Editar atividade hospitalar" }); fireEvent.change(within(form).getByLabelText("Início planejado"), { target: { value: "2026-10-11T10:00" } }); fireEvent.change(within(form).getByLabelText("Fim planejado"), { target: { value: "2026-10-11T11:00" } }); fireEvent.submit(form); await screen.findByRole("heading", { level: 1, name: "Rotina ajustada" }); const write = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === "PATCH")!; expect(JSON.parse(write[1]!.body as string)).toEqual({ expectedVersion: 4, title: "Rotina ajustada", description: "Conferir itens do setor", plannedStartAt: "2026-10-11T13:00:00.000Z", plannedEndAt: "2026-10-11T14:00:00.000Z" }); expect(vi.mocked(apiFetch).mock.calls.some(([path, init]) => init?.method && /reservations|commands|diagnostic/.test(path))).toBe(false);
});

it("rejects backwards planning and a nonexistent hospital DST time before sending a mutation", async () => {
  render(<PlannerTaskDetail taskId="task-1" />); await screen.findByLabelText("Título", { selector: "input" }); const form = screen.getByRole("form", { name: "Editar atividade hospitalar" }); fireEvent.change(within(form).getByLabelText("Início planejado"), { target: { value: "2026-10-11T11:00" } }); fireEvent.change(within(form).getByLabelText("Fim planejado"), { target: { value: "2026-10-11T10:00" } }); fireEvent.submit(form); expect(await screen.findByRole("alert")).toHaveTextContent("O fim planejado não pode anteceder o início."); expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method)).toBe(false);
  vi.stubEnv("NEXT_PUBLIC_HOSPITAL_TIMEZONE", "America/New_York"); fireEvent.change(within(form).getByLabelText("Início planejado"), { target: { value: "2026-03-08T02:30" } }); fireEvent.submit(form); expect(await screen.findByRole("alert")).toHaveTextContent("Este horário não existe no fuso do hospital"); expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method)).toBe(false);
});

it("assigns only the available staff, keeps executor and participant choices independent, and never changes clinical authorship", async () => {
  const other = { id: "professional-c", displayName: "Profissional C", role: "INPATIENT_TEAM" as const, departmentCode: "INPATIENT" }; current = { ...taskView({ authorId: plannerUser.id, responsibleUserId: "unavailable", executorTeamUserIds: ["old-executor"], participantUserIds: ["old-participant"] }), eligibleAssignees: [...taskView().eligibleAssignees, other] }; const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => { if (path.endsWith("/assignment")) { current = { ...current, task: { ...current.task, ...JSON.parse(init!.body as string), version: 5 } }; return current as never; } return original(path, init); }); render(<PlannerTaskDetail taskId="task-1" />); const form = await screen.findByRole("form", { name: "Atribuir atividade" }); expect(within(form).getByRole("option", { name: "Atribuição existente indisponível" })).toBeDisabled(); fireEvent.change(within(form).getByLabelText("Responsável"), { target: { value: other.id } }); const executors = within(form).getByRole("group", { name: "Equipe executora" }); fireEvent.click(within(executors).getByLabelText(other.displayName)); fireEvent.click(within(executors).getByLabelText(other.displayName)); fireEvent.click(within(executors).getByLabelText(other.displayName)); const participants = within(form).getByRole("group", { name: "Participantes" }); fireEvent.click(within(participants).getByLabelText(plannerUser.displayName)); fireEvent.click(within(participants).getByLabelText(plannerUser.displayName)); fireEvent.submit(form);
  await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method)).toBe(true)); const body = JSON.parse(vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method)![1]!.body as string); expect(body).toEqual({ expectedVersion: 4, responsibleUserId: other.id, executorTeamUserIds: ["old-executor", other.id], participantUserIds: ["old-participant"] }); expect(screen.getByText(/Autoria:/)).toHaveTextContent(plannerUser.displayName); expect(body).not.toHaveProperty("patientIds");
});

it("changes priority only with contextual reason and keeps the original task revision in the command", async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!; vi.mocked(apiFetch).mockImplementation(async (path, init) => { if (path.endsWith("/priority")) { current = taskView({ priority: "EMERGENCY", version: 5 }); return current as never; } return original(path, init); }); render(<PlannerTaskDetail taskId="task-1" />); const form = await screen.findByRole("form", { name: "Reclassificar atividade" }); fireEvent.change(within(form).getByLabelText("Prioridade"), { target: { value: "EMERGENCY" } }); fireEvent.submit(form); expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method)).toBe(false); fireEvent.change(screen.getByLabelText("Motivo da prioridade"), { target: { value: "  Necessidade operacional reavaliada  " } }); fireEvent.submit(form); await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path.endsWith("/priority"))).toBe(true)); expect(JSON.parse(vi.mocked(apiFetch).mock.calls.find(([path]) => path.endsWith("/priority"))![1]!.body as string)).toEqual({ priority: "EMERGENCY", reason: "Necessidade operacional reavaliada", expectedVersion: 4 });
});

it("selects a configured execution state, can back out, and records the explicit note only when confirmed", async () => {
  current = taskView({ typeSnapshot: { ...routineType, states: [...routineType.states, { code: "VERIFYING", label: "Em conferência", phase: "IN_PROGRESS" }] } }); render(<PlannerTaskDetail taskId="task-1" />); fireEvent.click(await screen.findByRole("button", { name: "Iniciar atividade" })); fireEvent.change(screen.getByLabelText("Estado de destino"), { target: { value: "VERIFYING" } }); fireEvent.click(screen.getByRole("button", { name: "Voltar sem confirmar" })); expect(screen.queryByRole("form", { name: "Confirmar comando da atividade" })).not.toBeInTheDocument(); expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method)).toBe(false); fireEvent.click(screen.getByRole("button", { name: "Iniciar atividade" })); fireEvent.change(screen.getByLabelText("Estado de destino"), { target: { value: "VERIFYING" } }); fireEvent.change(screen.getByLabelText("Nota de execução (opcional)"), { target: { value: "  Início validado no setor  " } }); fireEvent.click(screen.getByRole("button", { name: "Confirmar início" })); await screen.findByRole("button", { name: "Concluir atividade" }); expect(JSON.parse(vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === "POST")![1]!.body as string)).toEqual({ command: "START", stateCode: "VERIFYING", note: "Início validado no setor", expectedVersion: 4 });
});

it("paginates authorized dependency targets, pins the selected record and removes only a visible relationship", async () => {
  current = { ...taskView(), dependencies: [{ id: "existing", taskId: "task-1", targetType: "DIAGNOSTIC_ITEM", targetId: "item-known", restricted: false, satisfied: false, label: "Exame permitido", blocks: "COMPLETE", active: true, version: 1, createdAt: "2026-10-11T12:00:00Z", updatedAt: "2026-10-11T12:00:00Z" }] }; const original = vi.mocked(apiFetch).getMockImplementation()!; vi.mocked(apiFetch).mockImplementation(async (path, init) => { if (path.startsWith("/planner/search?")) return { items: path.includes("cursor=") ? [{ id: "candidate-item", type: "DIAGNOSTIC_ITEM", label: "Exame candidato", deepLink: "/requests/request", updatedAt: current.task.createdAt }] : [{ id: "task-1", type: "HOSPITAL_TASK", label: "A própria atividade", deepLink: "/planner/tasks/task-1", updatedAt: current.task.createdAt }, { id: "other-task", type: "HOSPITAL_TASK", label: "Preparação permitida", deepLink: "/planner/tasks/other-task", updatedAt: current.task.createdAt }], total: 3, limit: 25, ...(path.includes("cursor=") ? {} : { nextCursor: "targets-next" }) } as never; if (path.endsWith("/dependencies") && init?.method) return current as never; return original(path, init); }); render(<PlannerTaskDetail taskId="task-1" />); await screen.findByRole("link", { name: "Exame permitido" }); expect(screen.getByRole("link", { name: "Exame permitido" })).toHaveAttribute("href", "/queues?item=item-known"); fireEvent.click(screen.getByRole("button", { name: "Remover dependência" })); await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method)).toBe(true));
  fireEvent.change(screen.getByLabelText("Buscar atividade ou exame"), { target: { value: "preparação" } }); await screen.findByRole("radio", { name: /Preparação permitida/ }); expect(screen.queryByRole("radio", { name: /A própria atividade/ })).not.toBeInTheDocument(); fireEvent.click(screen.getByRole("radio", { name: /Preparação permitida/ })); fireEvent.click(screen.getByRole("button", { name: "Mais opções de dependência" })); fireEvent.click(await screen.findByRole("radio", { name: /Exame candidato/ })); fireEvent.change(screen.getByLabelText("Comando bloqueado"), { target: { value: "COMPLETE" } }); fireEvent.submit(screen.getByRole("form", { name: "Vincular dependência" })); await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method)).toHaveLength(2)); const writes = vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method); expect(writes.map(([, init]) => JSON.parse(init!.body as string))).toEqual([{ targetType: "DIAGNOSTIC_ITEM", targetId: "item-known", blocks: "COMPLETE", active: false, expectedVersion: 4 }, { targetType: "DIAGNOSTIC_ITEM", targetId: "candidate-item", blocks: "COMPLETE", active: true, expectedVersion: 4 }]);
});

it("keeps dependency selection empty after a failed lookup and cannot submit a forged target", async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!; vi.mocked(apiFetch).mockImplementation(async (path, init) => { if (path.startsWith("/planner/search?")) throw new ApiClientError(404, { error: { code: "SCOPE_DENIED" } }); return original(path, init); }); render(<PlannerTaskDetail taskId="task-1" />); fireEvent.change(await screen.findByLabelText("Buscar atividade ou exame"), { target: { value: "negada" } }); await screen.findByRole("alert"); expect(screen.getByRole("button", { name: "Adicionar dependência" })).toBeDisabled(); fireEvent.submit(screen.getByRole("form", { name: "Vincular dependência" })); expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method)).toBe(false);
});

it("changes a pending task's care context only after selecting an authorized patient and their open encounter", async () => {
  const patient = { id: "new-patient", displayName: "Paciente autorizado", externalId: "PAT-NEW", ownerLabel: "Tutor autorizado", species: "Canino" }; const original = vi.mocked(apiFetch).getMockImplementation()!; vi.mocked(apiFetch).mockImplementation(async (path, init) => { if (path === "/patients") return [patient] as never; if (path === "/patients/new-patient/encounters") return [{ id: "new-encounter", patientId: patient.id, externalId: "ENC-OPEN", type: "OUTPATIENT", status: "OPEN" }, { id: "closed", externalId: "ENC-CLOSED", type: "OUTPATIENT", status: "CLOSED" }] as never; if (path.endsWith("/context") && init?.method) { current = { ...taskView({ patientId: patient.id, encounterId: "new-encounter", version: 5 }), patient, encounter: { id: "new-encounter", externalId: "ENC-OPEN", type: "OUTPATIENT", status: "OPEN" } }; return current as never; } return original(path, init); });
  render(<PlannerTaskDetail taskId="task-1" />); fireEvent.click(await screen.findByRole("button", { name: "Alterar paciente e atendimento" })); fireEvent.click(screen.getByRole("button", { name: "Alterar paciente e atendimento" })); expect(screen.queryByRole("form", { name: "Alterar contexto da atividade" })).not.toBeInTheDocument(); fireEvent.click(screen.getByRole("button", { name: "Alterar paciente e atendimento" })); await screen.findByRole("option", { name: /Paciente autorizado/ }); fireEvent.change(screen.getByLabelText("Paciente"), { target: { value: patient.id } }); const form = screen.getByRole("form", { name: "Alterar contexto da atividade" }); fireEvent.submit(form); expect(await screen.findByRole("alert")).toHaveTextContent("Informe paciente e atendimento juntos"); expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method)).toBe(false); await screen.findByRole("option", { name: "ENC-OPEN · Atendimento externo" }); expect(screen.queryByRole("option", { name: /ENC-CLOSED/ })).not.toBeInTheDocument(); fireEvent.change(screen.getByLabelText("Atendimento"), { target: { value: "new-encounter" } }); fireEvent.submit(form); await screen.findByRole("link", { name: /Paciente autorizado/ }); expect(JSON.parse(vi.mocked(apiFetch).mock.calls.find(([path]) => path.endsWith("/context"))![1]!.body as string)).toEqual({ patientId: patient.id, encounterId: "new-encounter", expectedVersion: 4 });
});

it("creates a real child with an independent revision and closes the composer without completing the parent", async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!; vi.mocked(apiFetch).mockImplementation(async (path, init) => { if (path === "/hospital-tasks/options") return { departments: [{ code: "INPATIENT", name: "Internação" }], types: [routineType], assignees: [] } as never; if (path === "/hospital-task-types") return [routineType] as never; if (path === "/patients") return [] as never; if (path === "/hospital-tasks" && init?.method) { current = { ...current, children: [taskView({ id: "child", title: "Checar uma etapa", parentTaskId: current.task.id }).task] }; return taskView({ id: "child", title: "Checar uma etapa", parentTaskId: current.task.id, version: 1 }) as never; } return original(path, init); }); render(<PlannerTaskDetail taskId="task-1" />); fireEvent.click(await screen.findByRole("button", { name: "Criar subtarefa" })); const dialog = await screen.findByRole("dialog", { name: "Nova subtarefa" }); fireEvent.change(within(dialog).getByLabelText("Título da atividade"), { target: { value: "Checar uma etapa" } }); fireEvent.click(within(dialog).getByRole("button", { name: "Criar atividade" })); await screen.findByRole("link", { name: "Checar uma etapa" }); expect(screen.queryByRole("dialog")).not.toBeInTheDocument(); const write = vi.mocked(apiFetch).mock.calls.find(([path, init]) => path === "/hospital-tasks" && init?.method)!; expect(JSON.parse(write[1]!.body as string)).toMatchObject({ parentTaskId: "task-1", title: "Checar uma etapa" }); expect(vi.mocked(apiFetch).mock.calls.some(([path, init]) => path.endsWith("/commands") && init?.method)).toBe(false);
});

it("reports an unavailable child type directory and allows closing it without creating a synthetic child", async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!; vi.mocked(apiFetch).mockImplementation(async (path, init) => { if (path === "/hospital-task-types") throw new Error("private directory error"); return original(path, init); }); render(<PlannerTaskDetail taskId="task-1" />); fireEvent.click(await screen.findByRole("button", { name: "Criar subtarefa" })); expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível consultar os tipos da subtarefa."); fireEvent.click(screen.getByRole("button", { name: "Fechar criação da subtarefa" })); expect(screen.queryByRole("alert")).not.toBeInTheDocument(); expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method)).toBe(false);
});

it("freezes metadata during a transient read failure and recovers the current server version on retry", async () => {
  let fail = false; const original = vi.mocked(apiFetch).getMockImplementation()!; vi.mocked(apiFetch).mockImplementation(async (path, init) => { if (fail && path === "/hospital-tasks/task-1" && !init?.method) throw new ApiClientError(503, {}); return original(path, init); }); render(<PlannerTaskDetail taskId="task-1" />); await screen.findByLabelText("Título", { selector: "input" }); fail = true; act(() => window.dispatchEvent(new Event("cvg:realtime-updated"))); await screen.findByText("Leitura parcial"); expect(screen.getByRole("button", { name: "Salvar atividade" })).toBeDisabled(); fireEvent.submit(screen.getByRole("form", { name: "Atribuir atividade" })); expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method)).toBe(false); fail = false; fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" })); await waitFor(() => expect(screen.getByRole("button", { name: "Salvar atividade" })).toBeEnabled());
});

it("refreshes the task revision after an operational reaction without claiming a clinical acknowledgement", async () => {
  const grant = ["hospital_task.view", "hospital_task.comment.create"] as const; current = taskView({}, [...grant]); const original = vi.mocked(apiFetch).getMockImplementation()!; vi.mocked(apiFetch).mockImplementation(async (path, init) => { if (path === "/session/me") return { user: { ...plannerUser, permissions: [...grant] } } as never; if (path.endsWith("/reactions") && init?.method) { current = taskView({ reactions: [{ userId: plannerUser.id, code: "LIKE", createdAt: "2026-10-11T12:00:00Z" }], version: 5 }, [...grant]); return current as never; } return original(path, init); }); render(<PlannerTaskDetail taskId="task-1" />); fireEvent.click(await screen.findByRole("button", { name: "Gostei · 0" })); expect(await screen.findByRole("button", { name: "Gostei · 1" })).toHaveAttribute("aria-pressed", "true"); expect(JSON.parse(vi.mocked(apiFetch).mock.calls.find(([path]) => path.endsWith("/reactions"))![1]!.body as string)).toEqual({ code: "LIKE", active: true, expectedVersion: 4 }); expect(screen.getByText(/Reações não confirmam leitura clínica/)).toBeInTheDocument();
});
