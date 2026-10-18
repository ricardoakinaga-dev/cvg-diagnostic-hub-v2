/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Department, Permission, SavedPlannerView } from "@cvg/contracts";
import * as api from "./api-client";
import { PlannerSavedViews } from "./planner-saved-views";
import { PlannerTaskBatch } from "./planner-task-batch";
import { PLANNER_DEFAULT_DISPLAY } from "./planner-model";
import { plannerUser, taskView } from "./planner.test-helpers";

vi.mock("next/link", () => ({ default: ({ children, ...props }: { children: React.ReactNode; href: string }) => <a {...props}>{children}</a> }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
const permissions: Permission[] = [...plannerUser.permissions!, "planner_view.share", "hospital_task.archive", "hospital_task.restore"];
const user = { ...plannerUser, permissions };
const department: Department = { id: "dept", code: "INPATIENT", name: "Internação", type: "CLINICAL", active: true, memberUserIds: [], version: 1, createdAt: "2026-10-11T12:00:00Z", updatedAt: "2026-10-11T12:00:00Z" };
const savedView: SavedPlannerView = { id: "saved", name: "Passagem do turno", ownerId: user.id, filters: {}, display: PLANNER_DEFAULT_DISPLAY, active: true, version: 7, createdAt: department.createdAt, updatedAt: department.updatedAt };
const filters = { departmentCode: "INPATIENT", phase: "PENDING" as const };
const display = { ...PLANNER_DEFAULT_DISPLAY, layout: "TABLE" as const };
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const writes = (mock: { mock: { calls: Array<Parameters<typeof api.apiFetch>> } }) => mock.mock.calls.filter(([, init]) => init?.method);

it("saves a shared configuration without persisting clinical rows and reloads only active views", async () => {
  let views = [{ ...savedView, active: false }]; const apply = vi.fn();
  const mock = vi.spyOn(api, "apiFetch").mockImplementation(async (_path, init) => { if (init?.method) { views = [savedView]; return savedView; } return views; });
  render(<PlannerSavedViews user={user} filters={filters} display={display} departments={[department, { ...department, id: "inactive", code: "OLD", active: false }]} onApply={apply} />);
  fireEvent.click(screen.getByText("Visões salvas")); await waitFor(() => expect(mock).toHaveBeenCalled());
  expect(screen.queryByRole("button", { name: savedView.name })).not.toBeInTheDocument(); expect(screen.queryByRole("option", { name: "Compartilhada · OLD" })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Nome da visão"), { target: { value: "  Passagem do turno  " } }); fireEvent.change(screen.getByLabelText("Visibilidade"), { target: { value: "INPATIENT" } }); fireEvent.submit(screen.getByRole("form", { name: "Salvar visão do planner" }));
  fireEvent.click(await screen.findByRole("button", { name: savedView.name })); expect(apply).toHaveBeenCalledWith(savedView);
  expect(JSON.parse(writes(mock)[0][1]!.body as string)).toEqual({ name: savedView.name, filters, display, sharedDepartmentCode: "INPATIENT" }); expect(screen.getByLabelText("Nome da visão")).toHaveValue("");
});

it("updates the owner's configuration then deactivates only after explicit confirmation with the latest version", async () => {
  let current = savedView; let active = true;
  const mock = vi.spyOn(api, "apiFetch").mockImplementation(async (path, init) => {
    if (!init?.method) return active ? [current] : [];
    if (path.endsWith("/deactivate")) active = false; else current = { ...current, version: 8 };
    return current;
  });
  render(<PlannerSavedViews user={user} filters={filters} display={display} departments={[department]} onApply={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Atualizar com esta configuração" })); await waitFor(() => expect(writes(mock)).toHaveLength(1));
  await waitFor(() => expect(mock.mock.calls.filter(([, init]) => !init?.method)).toHaveLength(2));
  expect(JSON.parse(writes(mock)[0][1]!.body as string)).toEqual({ filters, display, expectedVersion: 7 });
  fireEvent.click(screen.getByRole("button", { name: `Desativar ${savedView.name}` })); fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancelar" })); expect(writes(mock)).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: `Desativar ${savedView.name}` })); fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Desativar visão" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: savedView.name })).not.toBeInTheDocument()); expect(JSON.parse(writes(mock)[1][1]!.body as string)).toEqual({ expectedVersion: 8 });
});

it("preserves visibility unless explicitly changed and retains a conflicting rename for an idempotent retry", async () => {
  let fail = true; const mock = vi.spyOn(api, "apiFetch").mockImplementation(async (_path, init) => { if (!init?.method) return [{ ...savedView, sharedDepartmentCode: "OLD" }]; if (fail) throw new api.ApiClientError(409, { error: { code: "STALE_VERSION" } }); return savedView; });
  render(<PlannerSavedViews user={{ ...user, permissions: user.permissions.filter((permission) => permission !== "planner_view.share") }} filters={filters} display={display} departments={[department]} onApply={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: `Editar nome e visibilidade de ${savedView.name}` })); expect(screen.queryByLabelText("Nova visibilidade")).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Novo nome da visão"), { target: { value: "  Nome local  " } }); fireEvent.submit(screen.getByRole("form", { name: `Editar visão ${savedView.name}` })); await screen.findByRole("alert");
  expect(screen.getByLabelText("Novo nome da visão")).toHaveValue("  Nome local  "); fail = false; fireEvent.submit(screen.getByRole("form", { name: `Editar visão ${savedView.name}` })); await waitFor(() => expect(writes(mock)).toHaveLength(2));
  expect(writes(mock)[0][1]!.headers).toEqual(writes(mock)[1][1]!.headers); expect(JSON.parse(writes(mock)[1][1]!.body as string)).toEqual({ name: "Nome local", expectedVersion: 7 });
});

it("keeps a historical sharing sector as read-only and allows explicitly sharing with an active destination", async () => {
  const mock = vi.spyOn(api, "apiFetch").mockImplementation(async (_path, init) => init?.method ? savedView : [{ ...savedView, sharedDepartmentCode: "OLD" }]);
  render(<PlannerSavedViews user={user} filters={filters} display={display} departments={[department]} onApply={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: `Editar nome e visibilidade de ${savedView.name}` })); expect(screen.getByRole("option", { name: "Compartilhamento existente · OLD" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Nova visibilidade"), { target: { value: "INPATIENT" } }); fireEvent.submit(screen.getByRole("form", { name: `Editar visão ${savedView.name}` })); await waitFor(() => expect(writes(mock)).toHaveLength(1)); expect(JSON.parse(writes(mock)[0][1]!.body as string)).toEqual({ name: savedView.name, sharedDepartmentCode: "INPATIENT", expectedVersion: 7 });
});

it("never offers editing another owner's view and does not read a directory for a create-only grant", async () => {
  const mock = vi.spyOn(api, "apiFetch").mockResolvedValue([{ ...savedView, ownerId: "other" }]);
  const ui = render(<PlannerSavedViews user={user} filters={filters} display={display} departments={[]} onApply={vi.fn()} />); await screen.findByRole("button", { name: savedView.name }); expect(screen.queryByRole("button", { name: "Atualizar com esta configuração" })).not.toBeInTheDocument(); expect(screen.queryByRole("button", { name: `Desativar ${savedView.name}` })).not.toBeInTheDocument(); ui.unmount(); mock.mockClear();
  render(<PlannerSavedViews user={{ ...user, permissions: ["planner_view.create"] }} filters={filters} display={display} departments={[]} onApply={vi.fn()} />); expect(mock).not.toHaveBeenCalled(); expect(screen.queryByLabelText("Visibilidade")).not.toBeInTheDocument(); fireEvent.submit(screen.getByRole("form", { name: "Salvar visão do planner" })); expect(mock).not.toHaveBeenCalled();
});

it("removes unavailable saved configurations after a refused directory read", async () => {
  const mock = vi.spyOn(api, "apiFetch").mockRejectedValue(new api.ApiClientError(403, { error: { code: "SCOPE_DENIED" } }));
  render(<PlannerSavedViews user={user} filters={filters} display={display} departments={[]} onApply={vi.fn()} />); expect(await screen.findByRole("alert")).toHaveTextContent("Você não tem acesso"); expect(screen.queryByRole("button", { name: savedView.name })).not.toBeInTheDocument(); expect(mock).toHaveBeenCalledTimes(1);
});

function batchItem(id = "one") { return taskView({ id, taskCode: id.toUpperCase() }, permissions); }
function selectBatch(action: string, taskCode = "ONE") { fireEvent.change(screen.getByLabelText("Ação do lote"), { target: { value: action } }); fireEvent.click(screen.getByRole("checkbox", { name: new RegExp(`${taskCode} ·`) })); }
function confirmBatch() { fireEvent.click(screen.getByRole("checkbox", { name: /Confirmo a ação/ })); fireEvent.click(screen.getByRole("button", { name: "Aplicar lote confirmado" })); }

it.each(["START", "COMPLETE", "CANCEL"])("uses the explicit %s command only for eligible phases and demands a cancellation reason", async (action) => {
  const mock = vi.spyOn(api, "apiFetch").mockResolvedValue({ items: [{ taskId: "one", ok: true }], successCount: 1, failureCount: 0 }); const changed = vi.fn();
  const allowed = taskView({ id: "one", taskCode: "ONE", phase: action === "COMPLETE" ? "IN_PROGRESS" : "PENDING" }, permissions);
  const denied = taskView({ id: "wrong", taskCode: "WRONG", phase: "COMPLETED" }, permissions);
  render(<PlannerTaskBatch user={user} items={[allowed, denied]} disabled={false} onChanged={changed} />); selectBatch(action); expect(screen.queryByRole("checkbox", { name: /WRONG ·/ })).not.toBeInTheDocument();
  if (action === "CANCEL") { confirmBatch(); expect(mock).not.toHaveBeenCalled(); fireEvent.change(screen.getByLabelText("Motivo do lote"), { target: { value: "  Duplicidade operacional  " } }); fireEvent.click(screen.getByRole("button", { name: "Aplicar lote confirmado" })); } else confirmBatch();
  await screen.findByText("1 confirmadas · 0 com falha."); expect(changed).toHaveBeenCalledOnce(); expect(JSON.parse(writes(mock)[0][1]!.body as string).operations).toEqual([{ taskId: "one", expectedVersion: 4, action: "COMMAND", command: action, ...(action === "CANCEL" ? { reason: "Duplicidade operacional" } : {}) }]);
});

it("reclassifies priorities only with a reason and resets confirmation when selection changes", async () => {
  const mock = vi.spyOn(api, "apiFetch").mockResolvedValue({ items: [{ taskId: "one", ok: true }], successCount: 1, failureCount: 0 }); render(<PlannerTaskBatch user={user} items={[batchItem()]} disabled={false} onChanged={vi.fn()} />); selectBatch("PRIORITY"); confirmBatch(); expect(mock).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox", { name: /ONE ·/ })); expect(screen.getByRole("checkbox", { name: /Confirmo a ação/ })).not.toBeChecked(); fireEvent.click(screen.getByRole("checkbox", { name: /ONE ·/ })); fireEvent.change(screen.getByLabelText("Prioridade do lote"), { target: { value: "EMERGENCY" } }); fireEvent.change(screen.getByLabelText("Motivo do lote"), { target: { value: "  Plano reavaliado  " } }); confirmBatch(); await screen.findByText("1 confirmadas · 0 com falha."); expect(JSON.parse(writes(mock)[0][1]!.body as string).operations).toEqual([{ taskId: "one", expectedVersion: 4, action: "PRIORITY", priority: "EMERGENCY", reason: "Plano reavaliado" }]);
});

it("requires an executor to select themself and restores a terminal task through a separate capability", async () => {
  const mock = vi.spyOn(api, "apiFetch").mockResolvedValue({ items: [{ taskId: "one", ok: true }], successCount: 1, failureCount: 0 }); const ui = render(<PlannerTaskBatch user={{ ...user, role: "LAB_TECH" }} items={[batchItem()]} disabled={false} onChanged={vi.fn()} />); selectBatch("ASSIGN"); confirmBatch(); expect(mock).not.toHaveBeenCalled(); fireEvent.change(screen.getByLabelText("Responsável elegível para todas"), { target: { value: user.id } }); fireEvent.click(screen.getByRole("button", { name: "Aplicar lote confirmado" })); await screen.findByText("1 confirmadas · 0 com falha."); ui.unmount(); mock.mockClear();
  render(<PlannerTaskBatch user={user} items={[taskView({ id: "one", taskCode: "ONE", phase: "COMPLETED", archivedAt: "2026-10-11T12:00:00Z" }, ["hospital_task.restore"])]} disabled={false} onChanged={vi.fn()} />); selectBatch("RESTORE"); confirmBatch(); await screen.findByText("1 confirmadas · 0 com falha."); expect(JSON.parse(writes(mock)[0][1]!.body as string).operations).toEqual([{ taskId: "one", expectedVersion: 4, action: "ARCHIVE", archived: false }]);
});

it("does not bypass dependencies, clinical confirmation or per-item grants in a batch", () => {
  const mock = vi.spyOn(api, "apiFetch"); const blocked = batchItem("blocked"); blocked.dependencies = [{ id: "restricted", restricted: true, blocks: "START", satisfied: false }]; const running = taskView({ id: "clinical", taskCode: "CLINICAL", phase: "IN_PROGRESS", checklistSnapshot: { clinicalProcess: { modality: "CARE" } } as never }, permissions);
  render(<PlannerTaskBatch user={user} items={[blocked, running, taskView({ id: "no-grant", taskCode: "NO-GRANT" }, [])]} disabled={false} onChanged={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("Ação do lote"), { target: { value: "START" } }); expect(screen.queryByRole("checkbox", { name: /BLOCKED ·|NO-GRANT ·/ })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Ação do lote"), { target: { value: "COMPLETE" } }); expect(screen.queryByRole("checkbox", { name: /CLINICAL ·/ })).not.toBeInTheDocument(); expect(screen.getByRole("button", { name: "Aplicar lote confirmado" })).toBeDisabled(); expect(mock).not.toHaveBeenCalled();
});

it("bounds selection to fifty tasks and prevents duplicate in-flight commands", async () => {
  let resolve!: (value: unknown) => void; const mock = vi.spyOn(api, "apiFetch").mockImplementation(() => new Promise<unknown>((done) => { resolve = done; }));
  const items = Array.from({ length: 51 }, (_, index) => taskView({ id: String(index), taskCode: `ROW-${index}`, phase: "COMPLETED" }, permissions)); render(<PlannerTaskBatch user={user} items={items} disabled={false} onChanged={vi.fn()} />);
  const rowChoices = screen.getAllByRole("checkbox").slice(0, 51); for (const choice of rowChoices.slice(0, 50)) fireEvent.click(choice); expect(screen.getByRole("checkbox", { name: /^ROW-50 ·/ })).toBeDisabled();
  confirmBatch(); fireEvent.click(screen.getByRole("button", { name: /Salvando|Aplicando|Aplicar lote confirmado/ })); expect(mock).toHaveBeenCalledTimes(1);
  await act(async () => resolve({ items: [{ taskId: "0", ok: false }], successCount: 49, failureCount: 1 })); await screen.findByText("49 confirmadas · 1 com falha."); expect(screen.getByText(/Falha desconhecida/)).toBeInTheDocument(); expect(JSON.parse(writes(mock)[0][1]!.body as string).operations).toHaveLength(50);
});
