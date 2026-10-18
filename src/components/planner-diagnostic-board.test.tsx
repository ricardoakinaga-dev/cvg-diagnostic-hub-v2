/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HospitalPlanView, SessionUser } from "@cvg/contracts";
import { ApiClientError, apiFetch, apiFetchWithMeta } from "./api-client";
import { PlannerDiagnosticBoard } from "./planner-diagnostic-board";
import { PlannerView } from "./planner-view";
import { plannerUser, routineType, taskView } from "./planner.test-helpers";
import type { RequestListEntry } from "./work-items/model";

vi.mock("next/link", () => ({ default: ({ children, ...props }: { children: React.ReactNode; href: string }) => <a {...props}>{children}</a> }));
vi.mock("./api-client", async (original) => ({ ...await original<typeof import("./api-client")>(), apiFetch: vi.fn(), apiFetchWithMeta: vi.fn() }));
const user: SessionUser = { ...plannerUser, role: "VETERINARIAN", permissions: [...plannerUser.permissions!, "request.list", "plan.view"] };
const request: RequestListEntry = { id: "request-1", requestCode: "EX-1", requesterId: "other-author", priority: "ROUTINE", createdAt: "2026-10-11T12:00:00Z", patient: { id: "patient", displayName: "Thor", species: "Canino", externalId: "SYN-1" }, items: [{ id: "task-1", requestId: "request-1", status: "REQUESTED", priority: "ROUTINE", workflowType: "LABORATORY", departmentCode: "LABORATORY", version: 1, assignedUserId: user.id, plannedStartsAt: "2026-10-11T14:00:00Z", dueAt: "2026-10-12T12:00:00Z", service: { id: "service", code: "HEM", name: "Hemograma" } }] };
let denied = false; let planDenied = false; let more = false; let sessionUser = user;
beforeEach(() => {
  denied = false; planDenied = false; more = false; sessionUser = user; window.localStorage.clear();
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (path === "/session/me") return { user: sessionUser } as never;
    if (path.startsWith("/hospital-plans/")) { if (planDenied) throw new ApiClientError(404, { error: { code: "SCOPE_DENIED" } }); return { activities: [{ targetType: "DIAGNOSTIC_ITEM", targetId: "task-1" }] } as HospitalPlanView as never; }
    if (path === "/hospital-task-types") return [routineType] as never;
    if (path.startsWith("/hospital-plans?")) return { items: [], total: 0, limit: 50 } as never;
    if (path === "/hospital-tasks/options") return { departments: [], types: [routineType], assignees: [] } as never;
    if (path.startsWith("/hospital-tasks?")) { const outsideTaskSector = new URLSearchParams(path.split("?")[1]).get("departmentCode") === "LABORATORY"; return { items: outsideTaskSector ? [] : [taskView()], total: outsideTaskSector ? 0 : 1, limit: 50 } as never; }
    return [] as never;
  });
  vi.mocked(apiFetchWithMeta).mockImplementation(async (path) => {
    if (denied) throw new ApiClientError(404, { error: { code: "SCOPE_DENIED" } });
    return { data: path.includes("cursor=") ? [{ ...request, id: "request-2", requestCode: "EX-2", items: [{ ...request.items[0], id: "item-2", service: { ...request.items[0].service, name: "Bioquímica" } }] }] : [request], meta: more && !path.includes("cursor=") ? { nextCursor: "next" } : {} } as never;
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("shows a common board with native task and diagnostic origins, including another care-team author's routine examination", async () => {
  render(<PlannerView />); await screen.findByRole("link", { name: "Conferir materiais" });
  fireEvent.change(screen.getByRole("combobox", { name: "Visão" }), { target: { value: "BOARD" } });
  expect(await screen.findByRole("link", { name: "Hemograma — Thor" })).toHaveAttribute("href", "/queues?view=all&item=task-1");
  expect(screen.getByRole("link", { name: "Conferir materiais" })).toHaveAttribute("href", "/planner/tasks/task-1");
  const diagnostics = screen.getByRole("region", { name: "Exames diagnósticos no quadro" });
  expect(diagnostics).toHaveTextContent("Exame diagnóstico · EX-1"); expect(diagnostics).toHaveTextContent("Solicitado");
  expect(within(diagnostics).queryByRole("button", { name: /Iniciar|Concluir/ })).not.toBeInTheDocument();
});

it("lets a clinician without the department directory select the laboratory authorized by the examination feed, then removes revoked options", async () => {
  expect(user.permissions).not.toContain("department.view");
  render(<PlannerView />); await screen.findByRole("link", { name: "Conferir materiais" });
  fireEvent.change(screen.getByRole("combobox", { name: "Visão" }), { target: { value: "BOARD" } });
  await screen.findByRole("link", { name: "Hemograma — Thor" });
  const sectors = screen.getByRole("combobox", { name: "Setor" });
  expect(await within(sectors).findByRole("option", { name: "LABORATORY" })).toHaveValue("LABORATORY");
  fireEvent.change(sectors, { target: { value: "LABORATORY" } });
  await waitFor(() => expect(screen.queryByRole("link", { name: "Conferir materiais" })).not.toBeInTheDocument());
  expect(screen.getByRole("link", { name: "Hemograma — Thor" })).toBeVisible();
  expect(sectors).toHaveValue("LABORATORY");
  denied = true; act(() => window.dispatchEvent(new Event("cvg:realtime-resync")));
  await waitFor(() => expect(screen.queryByRole("link", { name: "Hemograma — Thor" })).not.toBeInTheDocument());
  await waitFor(() => expect(within(sectors).queryByRole("option", { name: "LABORATORY" })).not.toBeInTheDocument());
});

it.each([user.id, "different-authorized-actor"])("does not retain diagnostic department metadata after the current identity %s loses diagnostic permissions", async (userId) => {
  render(<PlannerView />); await screen.findByRole("link", { name: "Conferir materiais" });
  fireEvent.change(screen.getByRole("combobox", { name: "Visão" }), { target: { value: "BOARD" } });
  await screen.findByRole("link", { name: "Hemograma — Thor" });
  await within(screen.getByRole("combobox", { name: "Setor" })).findByRole("option", { name: "LABORATORY" });
  sessionUser = { ...user, id: userId, permissions: ["hospital_task.view"] };
  act(() => window.dispatchEvent(new Event("cvg:realtime-resync")));
  if (userId !== user.id) { await waitFor(() => expect(screen.getByRole("combobox", { name: "Visão" })).toHaveValue("LIST")); fireEvent.change(screen.getByRole("combobox", { name: "Visão" }), { target: { value: "BOARD" } }); }
  await screen.findByText(/Esta conta não tem acesso à listagem diagnóstica/);
  expect(screen.queryByRole("link", { name: "Hemograma — Thor" })).not.toBeInTheDocument();
  expect(within(screen.getByRole("combobox", { name: "Setor" })).queryByRole("option", { name: "LABORATORY" })).not.toBeInTheDocument();
});

it("applies department, current responsible, priority, planned period and shared phase filters while retaining the native diagnostic state", async () => {
  const filters = { departmentCode: "LABORATORY", responsibleUserId: user.id, priority: "ROUTINE" as const, phase: "PENDING" as const, from: "2026-10-11T14:00:00Z", to: "2026-10-11T14:00:00Z" };
  const { rerender } = render(<PlannerDiagnosticBoard user={user} filters={filters} query="thor" />);
  await screen.findByRole("link", { name: "Hemograma — Thor" });
  rerender(<PlannerDiagnosticBoard user={user} filters={{ ...filters, responsibleUserId: "other-author" }} />);
  expect(screen.queryByRole("link", { name: "Hemograma — Thor" })).not.toBeInTheDocument();
  rerender(<PlannerDiagnosticBoard user={user} filters={{ typeId: routineType.id }} />);
  expect(screen.getByRole("heading", { name: "Nenhum exame nesta visão" })).toBeInTheDocument();
});

it("does not mount or query diagnostic feeds when the current effective group only grants hospital task access", () => {
  render(<PlannerDiagnosticBoard user={{ ...user, permissions: ["hospital_task.view"] }} filters={{}} />);
  expect(screen.getByText(/não tem acesso à listagem diagnóstica/)).toBeInTheDocument();
  expect(apiFetchWithMeta).not.toHaveBeenCalled(); expect(apiFetch).not.toHaveBeenCalled();
});

it("revalidates plan membership and removes diagnostic cards after the plan permission is withdrawn", async () => {
  const { rerender } = render(<PlannerDiagnosticBoard user={user} filters={{ planId: "plan" }} />);
  await screen.findByRole("link", { name: "Hemograma — Thor" });
  planDenied = true; act(() => window.dispatchEvent(new Event("cvg:realtime-resync")));
  await waitFor(() => expect(screen.queryByRole("link", { name: "Hemograma — Thor" })).not.toBeInTheDocument());
  await screen.findByRole("button", { name: "Tentar novamente" });
  rerender(<PlannerDiagnosticBoard user={{ ...user, permissions: ["request.list"] }} filters={{ planId: "plan" }} />);
  expect(screen.getByText(/Esta visão exige acesso atual ao plano/)).toBeInTheDocument();
});

it("loads further authorized diagnostics and clears them when the feed is revoked", async () => {
  more = true; render(<PlannerDiagnosticBoard user={user} filters={{}} />);
  await screen.findByRole("link", { name: "Hemograma — Thor" }); fireEvent.click(screen.getByRole("button", { name: "Carregar mais exames do quadro" }));
  await screen.findByRole("link", { name: "Bioquímica — Thor" });
  denied = true; act(() => window.dispatchEvent(new Event("cvg:realtime-resync")));
  await waitFor(() => expect(screen.queryByRole("link", { name: "Bioquímica — Thor" })).not.toBeInTheDocument());
  expect(screen.queryByRole("link", { name: "Hemograma — Thor" })).not.toBeInTheDocument();
});
