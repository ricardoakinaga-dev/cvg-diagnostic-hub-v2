/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PlannerScopeFilters } from "./planner-scope-filters";
import { ApiClientError, apiFetch } from "./api-client";
import { hospitalPlan, hospitalShift, hospitalUser, uiPage } from "./hospital-ui.test-helpers";
vi.mock("./api-client", async (original) => ({ ...await original<typeof import("./api-client")>(), apiFetch: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it("pages plans and shifts independently, selects authorized records and clears both explicit filters", async () => {
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    const more = path.includes("cursor=");
    return (path.startsWith("/hospital-plans") ? uiPage([hospitalPlan({ id: more ? "plan-next" : "plan-first", title: more ? "Plano seguinte" : "Plano inicial" })], more ? undefined : "plan cursor") : uiPage([hospitalShift({ id: more ? "shift-next" : "shift-first", name: more ? "Plantão seguinte" : "Plantão inicial" })], more ? undefined : "shift cursor")) as never;
  });
  const onPlanChange = vi.fn(); const onShiftChange = vi.fn();
  render(<PlannerScopeFilters user={hospitalUser} onPlanChange={onPlanChange} onShiftChange={onShiftChange} />);
  await screen.findByRole("option", { name: /Plano inicial/ }); await screen.findByRole("option", { name: /Plantão inicial/ });
  fireEvent.click(screen.getByRole("button", { name: "Mais planos para filtrar" })); fireEvent.click(screen.getByRole("button", { name: "Mais plantões para filtrar" }));
  await screen.findByRole("option", { name: /Plano seguinte/ }); await screen.findByRole("option", { name: /Plantão seguinte/ });
  fireEvent.change(screen.getByRole("combobox", { name: /Plano assistencial/ }), { target: { value: "plan-next" } }); fireEvent.change(screen.getByRole("combobox", { name: /Plantão da atividade/ }), { target: { value: "shift-next" } });
  expect(onPlanChange).toHaveBeenLastCalledWith("plan-next"); expect(onShiftChange).toHaveBeenLastCalledWith("shift-next");
  fireEvent.change(screen.getByRole("combobox", { name: /Plano assistencial/ }), { target: { value: "" } }); fireEvent.change(screen.getByRole("combobox", { name: /Plantão da atividade/ }), { target: { value: "" } });
  expect(onPlanChange).toHaveBeenLastCalledWith(undefined); expect(onShiftChange).toHaveBeenLastCalledWith(undefined);
  expect(vi.mocked(apiFetch).mock.calls.map(([path]) => path)).toContain("/hospital-shifts?limit=50&cursor=shift%20cursor");
  expect(screen.queryByRole("button", { name: /Mais (planos|plantões)/ })).not.toBeInTheDocument();
});

it("keeps configured historical scopes visible without fetching directories that were not granted", async () => {
  const { rerender } = render(<PlannerScopeFilters user={{ ...hospitalUser, permissions: [] }} planId="old-plan" shiftId="old-shift" onPlanChange={vi.fn()} onShiftChange={vi.fn()} />);
  expect(screen.getByRole("option", { name: "Plano configurado fora das opções atuais" })).toBeDisabled(); expect(screen.getByRole("option", { name: "Plantão configurado fora das opções atuais" })).toBeDisabled();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); }); expect(apiFetch).not.toHaveBeenCalled();
  rerender(<PlannerScopeFilters user={{ ...hospitalUser, permissions: undefined }} onPlanChange={vi.fn()} />);
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument(); expect(apiFetch).not.toHaveBeenCalled();
});

it("retries a failed directory separately and removes old options when access is revoked", async () => {
  let failPlans = true; let denied = false;
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (denied) throw new ApiClientError(404, { error: { code: "SCOPE_DENIED" } });
    if (path.startsWith("/hospital-plans") && failPlans) throw new ApiClientError(503, { error: { code: "STORAGE_UNAVAILABLE" } });
    return (path.startsWith("/hospital-plans") ? uiPage([hospitalPlan()]) : uiPage([hospitalShift()])) as never;
  });
  render(<PlannerScopeFilters user={hospitalUser} onPlanChange={vi.fn()} onShiftChange={vi.fn()} />);
  await screen.findByRole("option", { name: /Plantão diurno/ }); await screen.findByRole("button", { name: "Tentar novamente" });
  failPlans = false; fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" })); await screen.findByRole("option", { name: /Plano do atendimento/ });
  denied = true; act(() => window.dispatchEvent(new Event("cvg:realtime-resync")));
  await waitFor(() => { expect(screen.queryByRole("option", { name: /Plano do atendimento/ })).not.toBeInTheDocument(); expect(screen.queryByRole("option", { name: /Plantão diurno/ })).not.toBeInTheDocument(); });
  expect(screen.getAllByRole("button", { name: "Tentar novamente" })).toHaveLength(2);
});
