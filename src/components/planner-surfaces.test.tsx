/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HospitalIntakeView, SavedPlannerView } from "@cvg/contracts";
import { PlannerIntake } from "./planner-intake";
import { PlannerSearch } from "./planner-search";
import { PlannerSavedViews } from "./planner-saved-views";
import { PlannerTaskTypes } from "./planner-task-types";
import { usePlannerPage } from "./use-planner";
import { ApiClientError, apiFetch } from "./api-client";
import { PLANNER_DEFAULT_DISPLAY } from "./planner-model";
import { careType, plannerUser, routineType } from "./planner.test-helpers";

vi.mock("next/link", () => ({ default: ({ children, ...props }: { children: React.ReactNode; href: string }) => <a {...props}>{children}</a> }));
vi.mock("./api-client", async (original) => ({ ...await original<typeof import("./api-client")>(), apiFetch: vi.fn() }));
const intake: HospitalIntakeView = { id: "intake", title: "Revisar materiais", source: "MANUAL", departmentCode: "INPATIENT", priority: "ROUTINE", state: "RECEIVED", submittedBy: "author", createdAt: "2026-10-11T12:00:00Z", updatedAt: "2026-10-11T12:00:00Z", version: 3, permissions: ["hospital_intake.triage"] };
const saved: SavedPlannerView = { id: "view", name: "Rotinas de plantão", ownerId: plannerUser.id, filters: { departmentCode: "INPATIENT", phase: "PENDING" }, display: PLANNER_DEFAULT_DISPLAY, active: true, version: 2, createdAt: "2026-10-11T12:00:00Z", updatedAt: "2026-10-11T12:00:00Z" };
beforeEach(() => { window.localStorage.clear(); vi.mocked(apiFetch).mockImplementation(async (path) => path === "/session/me" ? { user: plannerUser } as never : path.startsWith("/hospital-intakes?") ? { items: [intake], total: 1, limit: 50 } as never : path === "/hospital-task-types" ? [routineType] as never : path === "/planner-views" ? [saved] as never : [] as never); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });
function change(label: string, value: string) { fireEvent.change(screen.getByLabelText(label), { target: { value } }); }
function writes() { return vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method); }

it("records an operational demand with its real type and keeps explicit filters visible until the user clears them", async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => path.startsWith("/departments") ? [{ id: "inpatient", code: "INPATIENT", name: "Internação cadastrada", active: true }, { id: "emergency", code: "EMERGENCY", name: "Emergência cadastrada", active: true }, { id: "retired", code: "RETIRED", name: "Setor retirado", active: false }] as never : path === "/hospital-intakes" && init?.method ? { ...intake, title: "Preparar transferência" } as never : original(path, init));
  render(<PlannerIntake />); await screen.findByLabelText("Buscar demanda"); change("Buscar demanda", "Filtro incompatível"); change("Estado da demanda", "REJECTED"); fireEvent.click(await screen.findByRole("button", { name: "Nova demanda" }));
  await screen.findByRole("option", { name: "Rotina geral" }); await within(screen.getByLabelText("Setor de destino")).findByRole("option", { name: "Internação cadastrada" }); expect(within(screen.getByLabelText("Setor de destino")).queryByRole("option", { name: "Setor retirado" })).not.toBeInTheDocument(); change("Título da demanda", "Preparar transferência"); change("Descrição da demanda", "Conferir materiais do setor"); change("Prioridade da demanda", "URGENT"); change("Tipo da atividade", routineType.id); change("Setor de destino", "INPATIENT");
  fireEvent.click(screen.getByRole("button", { name: "Registrar demanda" })); await screen.findByRole("button", { name: "Limpar filtros para localizar" });
  expect(JSON.parse(writes()[0][1]!.body as string)).toEqual({ title: "Preparar transferência", description: "Conferir materiais do setor", departmentCode: "INPATIENT", priority: "URGENT", source: "MANUAL", typeId: routineType.id }); expect(screen.getByLabelText("Buscar demanda")).toHaveValue("Filtro incompatível");
  fireEvent.click(screen.getByRole("button", { name: "Limpar filtros para localizar" })); expect(screen.getByLabelText("Buscar demanda")).toHaveValue(""); expect(screen.getByLabelText("Estado da demanda")).toHaveValue("");
});

it("requires an existing diagnostic request selection, resets it when searching again and registers the original request without duplicating exams", async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => path.startsWith("/planner/search?") ? { items: [{ type: "DIAGNOSTIC_REQUEST", id: path.includes("cursor=") ? "request-other" : "request-existing", label: path.includes("cursor=") ? "Protocolo autorizado 2" : "Protocolo autorizado 1", patient: "Paciente autorizado", deepLink: "/requests/request-existing", updatedAt: "2026-10-11T12:00:00Z" }], total: 2, limit: 25, ...(path.includes("cursor=") ? {} : { nextCursor: "next" }) } as never : path === "/hospital-intakes" && init?.method ? { ...intake, title: "Triar protocolo" } as never : original(path, init));
  render(<PlannerIntake />); fireEvent.click(await screen.findByRole("button", { name: "Nova demanda" })); change("Título da demanda", "Triar protocolo"); change("Origem", "DIAGNOSTIC_REQUEST");
  fireEvent.submit(screen.getByRole("form", { name: "Criar demanda de triagem" })); expect(await screen.findByRole("alert")).toHaveTextContent("contexto exigido"); expect(writes()).toHaveLength(0);
  change("Buscar solicitação", "Protocolo"); fireEvent.click(await screen.findByRole("radio", { name: /Protocolo autorizado 1/ })); change("Buscar solicitação", "Protocolo atualizado");
  expect(await screen.findByRole("radio", { name: /Protocolo autorizado 1/ })).not.toBeChecked(); fireEvent.click(await screen.findByRole("button", { name: "Mais solicitações" })); fireEvent.click(await screen.findByRole("radio", { name: /Protocolo autorizado 2/ })); fireEvent.click(screen.getByRole("button", { name: "Registrar demanda" }));
  await waitFor(() => expect(writes()).toHaveLength(1)); expect(JSON.parse(writes()[0][1]!.body as string)).toEqual({ title: "Triar protocolo", source: "DIAGNOSTIC_REQUEST", sourceRequestId: "request-other", departmentCode: "INPATIENT", priority: "ROUTINE" }); expect(writes()[0][0]).toBe("/hospital-intakes");
});

it("rejects incomplete care context and retains a conflicted manual demand for a deliberate retry", async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => path === "/hospital-task-types" ? [routineType, careType] as never : init?.method ? Promise.reject(new ApiClientError(409, { error: { code: "STALE_VERSION" } })) : original(path, init));
  render(<PlannerIntake />); fireEvent.click(await screen.findByRole("button", { name: "Nova demanda" })); await screen.findByRole("option", { name: "Atividade assistencial" }); change("Título da demanda", "Demanda assistencial"); change("Tipo da atividade", careType.id);
  fireEvent.submit(screen.getByRole("form", { name: "Criar demanda de triagem" })); expect(await screen.findByRole("alert")).toHaveTextContent("contexto exigido"); expect(writes()).toHaveLength(0);
  change("Tipo da atividade", routineType.id); fireEvent.click(screen.getByRole("button", { name: "Registrar demanda" })); await waitFor(() => expect(writes()).toHaveLength(1)); await screen.findByRole("alert"); expect(screen.getByLabelText("Título da demanda")).toHaveValue("Demanda assistencial");
  fireEvent.click(screen.getByRole("button", { name: "Registrar demanda" })); await waitFor(() => expect(writes()).toHaveLength(2)); expect(writes()[0][1]!.headers).toEqual(writes()[1][1]!.headers); fireEvent.click(screen.getByRole("button", { name: "Nova demanda" })); expect(screen.queryByRole("form", { name: "Criar demanda de triagem" })).not.toBeInTheDocument();
});

it("marks a duplicate only against a demand with matching patient, encounter and source, with reason and captured version", async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => path.startsWith("/hospital-intakes?") ? { items: [intake, { ...intake, id: "same", title: "Demanda original" }, { ...intake, id: "other-patient", title: "Paciente diferente", patientId: "other" }, { ...intake, id: "other-encounter", title: "Atendimento diferente", encounterId: "other" }, { ...intake, id: "diagnostic", title: "Fonte diferente", source: "DIAGNOSTIC_REQUEST" }], total: 5, limit: 50 } as never : path === "/hospital-intakes/intake/triage" ? { ...intake, state: "DUPLICATE" } as never : original(path, init));
  render(<PlannerIntake />); const row = await screen.findByRole("article", { name: "Demanda Revisar materiais" }); fireEvent.click(within(row).getByRole("button", { name: "Marcar duplicidade" }));
  const form = within(row).getByRole("form", { name: "Decidir demanda Revisar materiais" }); expect(within(form).getAllByRole("option").map((option) => option.textContent)).toEqual(["Selecione a demanda…", "Demanda original"]);
  fireEvent.change(within(form).getByLabelText("Motivo da decisão"), { target: { value: "Mesmo trabalho já recebido" } }); fireEvent.submit(form); expect(writes()).toHaveLength(0); fireEvent.change(within(form).getByLabelText("Demanda original"), { target: { value: "same" } }); fireEvent.click(within(form).getByRole("button", { name: "Confirmar decisão" }));
  await waitFor(() => expect(writes()).toHaveLength(1)); expect(JSON.parse(writes()[0][1]!.body as string)).toEqual({ decision: "DUPLICATE", duplicateOfIntakeId: "same", reason: "Mesmo trabalho já recebido", expectedVersion: 3 });
});

it("routes acceptance to an authorized existing activity and clears an old destination after changing the target sector", async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => path.startsWith("/departments") ? [{ id: "emergency", code: "EMERGENCY", name: "Emergência", active: true }] as never : path.startsWith("/planner/search?") ? { items: [{ type: "HOSPITAL_TASK", id: "destination", label: "Atividade existente", departmentCode: path.includes("EMERGENCY") ? "EMERGENCY" : "INPATIENT", deepLink: "/planner/tasks/destination", updatedAt: "2026-10-11T12:00:00Z" }], total: 1, limit: 25, ...(path.includes("cursor=") ? {} : { nextCursor: "next" }) } as never : path === "/hospital-intakes/intake/triage" ? { ...intake, destinationTaskId: "destination", state: "ACCEPTED" } as never : original(path, init));
  render(<PlannerIntake />); await screen.findByRole("button", { name: "Aceitar demanda" }); change("Vincular atividade existente", "Atividade"); fireEvent.click(await screen.findByRole("radio", { name: "Atividade existente" }));
  change("Setor para aceite", "EMERGENCY"); expect(screen.getByRole("radio", { name: "Criar atividade para esta demanda" })).toBeChecked(); await screen.findByRole("radio", { name: "Atividade existente" }); fireEvent.click(screen.getByRole("radio", { name: "Atividade existente" }));
  fireEvent.click(screen.getByRole("button", { name: "Mais atividades de destino" })); await waitFor(() => expect(screen.queryByRole("button", { name: "Mais atividades de destino" })).not.toBeInTheDocument()); fireEvent.click(screen.getByRole("button", { name: "Aceitar demanda" }));
  await waitFor(() => expect(writes()).toHaveLength(1)); expect(JSON.parse(writes()[0][1]!.body as string)).toEqual({ decision: "ACCEPT", destinationDepartmentCode: "EMERGENCY", destinationTaskId: "destination", expectedVersion: 3 });
});

it("preserves a refused triage decision and pages authorized destinations without leaking rows after read revocation", async () => {
  let denied = false; const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => { if (init?.method) throw new ApiClientError(409, { error: { code: "STALE_VERSION" } }); if (path.startsWith("/hospital-intakes?")) { if (denied) throw new ApiClientError(404, { error: { code: "SCOPE_DENIED" } }); return { items: [path.includes("cursor=") ? { ...intake, id: "past", title: "Demanda anterior", state: "ACCEPTED", description: "Texto operacional", reason: "Encaminhada", destinationTaskId: "task", destinationRequestId: "request", permissions: [] } : intake], total: 2, limit: 50, ...(path.includes("cursor=") ? {} : { nextCursor: "next" }) } as never; } return original(path, init); });
  render(<PlannerIntake />); fireEvent.click(await screen.findByRole("button", { name: "Carregar mais demandas" })); expect(await screen.findByRole("link", { name: "Abrir atividade de destino" })).toHaveAttribute("href", "/planner/tasks/task"); expect(screen.getByRole("link", { name: "Abrir solicitação original" })).toHaveAttribute("href", "/requests/request");
  fireEvent.click(screen.getByRole("button", { name: "Rejeitar demanda" })); change("Motivo da decisão", "Sem condições seguras"); fireEvent.click(screen.getByRole("button", { name: "Confirmar decisão" })); await screen.findByRole("alert"); expect(screen.getByLabelText("Motivo da decisão")).toHaveValue("Sem condições seguras"); fireEvent.click(screen.getByRole("button", { name: "Voltar" }));
  expect(screen.queryByRole("form", { name: "Decidir demanda Revisar materiais" })).not.toBeInTheDocument(); denied = true; act(() => window.dispatchEvent(new Event("cvg:realtime-resync"))); await waitFor(() => expect(screen.queryByRole("heading", { name: "Revisar materiais" })).not.toBeInTheDocument()); expect(screen.queryByRole("link", { name: "Abrir atividade de destino" })).not.toBeInTheDocument(); denied = false; fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" })); await screen.findByRole("heading", { name: "Revisar materiais" });
});

it("accepts an operational demand in one interaction with its version and a durable intent", async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => path === "/hospital-intakes/intake/triage" ? { ...intake, state: "ACCEPTED", destinationTaskId: "target-task", version: 4 } as never : original(path, init));
  render(<PlannerIntake />); fireEvent.click(await screen.findByRole("button", { name: "Aceitar demanda" }));
  await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalledWith("/hospital-intakes/intake/triage", expect.objectContaining({ method: "POST", body: JSON.stringify({ decision: "ACCEPT", expectedVersion: 3 }), headers: { "idempotency-key": expect.any(String) } })));
  expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path.includes("diagnostic-items"))).toBe(false);
});

it("requires a reason for defer/reject and keeps a diagnostic destination tied to its original request", async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path.startsWith("/hospital-intakes?")) return { items: [{ ...intake, source: "DIAGNOSTIC_REQUEST", sourceRequestId: "request" }], total: 1, limit: 50 } as never;
    if (path === "/hospital-intakes/intake/triage") return { ...intake, state: "DEFERRED", reason: "Aguardar insumo", version: 4 } as never;
    return original(path, init);
  });
  render(<PlannerIntake />); fireEvent.click(await screen.findByRole("button", { name: "Adiar demanda" }));
  fireEvent.submit(screen.getByRole("form", { name: "Decidir demanda Revisar materiais" }));
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method)).toBe(false);
  fireEvent.change(screen.getByLabelText("Motivo da decisão"), { target: { value: "Aguardar insumo" } }); fireEvent.click(screen.getByRole("button", { name: "Confirmar decisão" }));
  await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === "POST")).toBe(true));
  const write = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === "POST")!;
  expect(JSON.parse(write[1]!.body as string)).toEqual({ decision: "DEFER", reason: "Aguardar insumo", expectedVersion: 3 });
  expect(vi.mocked(apiFetch).mock.calls.some(([path]) => /release|cancel|diagnostic-items|\/hospital-tasks$/.test(path))).toBe(false);
});

it("keeps a VIEWER demand read-only even if a stale entry still carries triage capabilities", async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => path === "/session/me" ? { user: { ...plannerUser, role: "VIEWER", permissions: ["hospital_intake.view"] } } as never : original(path, init));
  render(<PlannerIntake />); await screen.findByRole("heading", { name: "Revisar materiais" });
  expect(screen.queryByRole("button", { name: "Aceitar demanda" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Nova demanda" })).not.toBeInTheDocument();
});

it("paginates authorized search results and clears their titles after access is withdrawn", async () => {
  let denied = false; const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path.startsWith("/planner/search?")) {
      if (denied) throw new ApiClientError(404, { error: { code: "SCOPE_DENIED" } });
      return { items: [{ type: "HOSPITAL_TASK", id: path.includes("cursor=") ? "second" : "first", label: path.includes("cursor=") ? "Conferir material" : "Organizar turno", deepLink: "/planner/tasks/first", updatedAt: "2026-10-11T12:00:00Z" }], total: 2, limit: 50, ...(path.includes("cursor=") ? {} : { nextCursor: "opaque" }) } as never;
    }
    return original(path, init);
  });
  render(<PlannerSearch />); fireEvent.change(await screen.findByLabelText("Texto, identificação ou paciente"), { target: { value: "turno" } }); fireEvent.click(screen.getByRole("button", { name: "Buscar" }));
  expect(await screen.findByRole("link", { name: "Organizar turno" })).toHaveAttribute("href", "/planner/tasks/first");
  fireEvent.click(screen.getByRole("button", { name: "Carregar mais resultados" })); await screen.findByRole("link", { name: "Conferir material" });
  denied = true; act(() => window.dispatchEvent(new Event("cvg:realtime-updated")));
  await waitFor(() => expect(screen.queryByRole("link", { name: "Organizar turno" })).not.toBeInTheDocument());
  expect(screen.queryByRole("link", { name: "Conferir material" })).not.toBeInTheDocument();
});

it("applies a stored view in one interaction and reserves editing for its owner", async () => {
  const onApply = vi.fn();
  vi.mocked(apiFetch).mockResolvedValue([{ ...saved, ownerId: "another-professional", sharedDepartmentCode: "INPATIENT" }]);
  render(<PlannerSavedViews user={plannerUser} filters={{}} display={PLANNER_DEFAULT_DISPLAY} departments={[]} onApply={onApply} />);
  fireEvent.click(await screen.findByRole("button", { name: saved.name }));
  expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ filters: saved.filters }));
  expect(screen.queryByRole("button", { name: "Atualizar com esta configuração" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: `Desativar ${saved.name}` })).not.toBeInTheDocument();
});

it("persists the current filters and display as configuration, without storing returned patients", async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => init?.method === "POST" ? saved as never : original(path, init));
  render(<PlannerSavedViews user={plannerUser} filters={{ phase: "PENDING", responsibleUserId: plannerUser.id }} display={PLANNER_DEFAULT_DISPLAY} departments={[]} onApply={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("Nome da visão"), { target: { value: "Minhas rotinas" } }); fireEvent.submit(screen.getByRole("form", { name: "Salvar visão do planner" }));
  await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === "POST")).toBe(true));
  const write = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === "POST")!;
  expect(JSON.parse(write[1]!.body as string)).toEqual({ name: "Minhas rotinas", filters: { phase: "PENDING", responsibleUserId: plannerUser.id }, display: PLANNER_DEFAULT_DISPLAY });
});

it("keeps task type changes under their own versioned command and preserves permanent codes", async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => init?.method === "PATCH" ? routineType as never : original(path, init));
  render(<PlannerTaskTypes />); const form = await screen.findByRole("form", { name: "Editar tipo Rotina geral" });
  expect(within(form).queryByLabelText("Código do tipo")).not.toBeInTheDocument();
  fireEvent.change(within(form).getByLabelText("Nome do estado 2"), { target: { value: "Em conferência" } }); fireEvent.click(within(form).getByRole("button", { name: "Salvar tipo" }));
  await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalledWith(`/hospital-task-types/${routineType.id}`, expect.objectContaining({ method: "PATCH" })));
  const write = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === "PATCH")!;
  const body = JSON.parse(write[1]!.body as string); expect(body.expectedVersion).toBe(1); expect(body.states[1].label).toBe("Em conferência"); expect(body).not.toHaveProperty("code");
});

it("ignores an older identity's late response and deduplicates IDs separately by entity type", async () => {
  let releaseOld: (page: unknown) => void = () => undefined;
  vi.mocked(apiFetch).mockImplementation(async (path) => path === "/old" ? await new Promise<unknown>((resolve) => { releaseOld = resolve; }) as never : { items: [{ id: "same", type: "PATIENT" }], total: 2, limit: 50, nextCursor: path.includes("cursor") ? undefined : "next" } as never);
  const hook = renderHook(({ userId, path }) => usePlannerPage<{ id: string; type: string }>(userId, path), { initialProps: { userId: "old-user", path: "/old" } });
  await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalledWith("/old"));
  hook.rerender({ userId: "new-user", path: "/new" }); await waitFor(() => expect(hook.result.current.items).toEqual([{ id: "same", type: "PATIENT" }]));
  act(() => releaseOld({ items: [{ id: "private-old", type: "HOSPITAL_TASK" }], total: 1, limit: 50 }));
  await act(async () => { await Promise.resolve(); }); expect(hook.result.current.items).toEqual([{ id: "same", type: "PATIENT" }]);
  vi.mocked(apiFetch).mockResolvedValue({ items: [{ id: "same", type: "HOSPITAL_TASK" }], total: 2, limit: 50 });
  await act(() => hook.result.current.loadMore()); expect(hook.result.current.items).toHaveLength(2);
});
