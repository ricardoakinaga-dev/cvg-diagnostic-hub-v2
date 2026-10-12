/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HospitalPlannerMetrics, SessionUser } from "@cvg/contracts";
import { HospitalMetricsView } from "./hospital-metrics-view";
import { apiFetch, ApiClientError } from "./api-client";
import { hospitalUser, uiPage } from "./hospital-ui.test-helpers";
vi.mock("next/link", () => ({ default: ({ children, ...props }: { children: React.ReactNode; href: string }) => <a {...props}>{children}</a> }));
vi.mock("./api-client", async (original) => ({ ...await original<typeof import("./api-client")>(), apiFetch: vi.fn() }));
let user: SessionUser;
const metric: HospitalPlannerMetrics = { asOf: "2026-10-11T12:00:00Z", window: { from: "2026-10-11T00:00:00Z", to: "2026-10-12T00:00:00Z", convention: "START_INCLUSIVE_END_EXCLUSIVE" }, scope: { departmentCodes: ["INPATIENT", "HISTORICAL"], policy: "CURRENT_OBJECT_AUTHORIZATION" }, values: [{ definition: { code: "TASK_PENDING", label: "Atividades pendentes", version: "HPL-OPERATIONAL-1", unit: "COUNT", source: "HospitalTask", denominator: "AUTHORIZED_UNIQUE_ACTIVITIES", timeBasis: "COHORT_IN_WINDOW_CURRENT_STATE", description: "Atividades do período em aberto", approval: "TECHNICAL_DEFINITION_REQUIRES_PILOT_ACCEPTANCE" }, value: 0, availability: "AUTHORIZED" }] };
beforeEach(() => {
  vi.mocked(apiFetch).mockReset(); user = { ...hospitalUser, permissions: ["hospital_metric.view", "department.view"] };
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (path === "/session/me") return { user } as never;
    if (path.startsWith("/departments")) return [{ id: "dept", code: "INPATIENT", name: "Internação", active: true }] as never;
    if (path.startsWith("/hospital-metrics?")) return metric as never;
    if (path.includes("/rows?")) return uiPage([]) as never;
    throw new Error(`Unexpected metric workflow ${path}`);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("applies an explicit hospital interval and sector, distinguishes zero from unavailable, and clears a previous drilldown", async () => {
  render(<HospitalMetricsView />);
  await screen.findByRole("rowheader", { name: "Atividades pendentes" });
  expect(screen.getByRole("rowheader").closest("tr")).toHaveTextContent("0");
  fireEvent.click(screen.getByRole("button", { name: "Ver itens de Atividades pendentes" }));
  await screen.findByText("Nenhum item autorizado no período");
  const form = screen.getByRole("form", { name: "Filtrar indicadores hospitalares" });
  await within(within(form).getByLabelText("Setor dos indicadores")).findByRole("option", { name: "Internação" });
  expect(within(form).getByRole("option", { name: "HISTORICAL" })).toBeInTheDocument();
  fireEvent.change(within(form).getByLabelText("Setor dos indicadores"), { target: { value: "INPATIENT" } });
  fireEvent.change(within(form).getByLabelText("Período de"), { target: { value: "2026-10-12T08:00" } });
  fireEvent.change(within(form).getByLabelText("Período até"), { target: { value: "2026-10-11T08:00" } });
  const count = vi.mocked(apiFetch).mock.calls.filter(([path]) => path.startsWith("/hospital-metrics?")).length;
  fireEvent.submit(form);
  expect(await screen.findByRole("alert")).toHaveTextContent("O fim deve ser posterior");
  expect(vi.mocked(apiFetch).mock.calls.filter(([path]) => path.startsWith("/hospital-metrics?"))).toHaveLength(count);
  fireEvent.change(within(form).getByLabelText("Período até"), { target: { value: "2026-10-13T08:00" } });
  fireEvent.submit(form);
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/hospital-metrics?from=2026-10-12T11%3A00%3A00.000Z&to=2026-10-13T11%3A00%3A00.000Z&departmentCode=INPATIENT"));
  expect(screen.queryByRole("heading", { name: "Itens que compõem o indicador" })).not.toBeInTheDocument();
  fireEvent.change(within(form).getByLabelText("Setor dos indicadores"), { target: { value: "" } });
  fireEvent.submit(form);
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/hospital-metrics?from=2026-10-12T11%3A00%3A00.000Z&to=2026-10-13T11%3A00%3A00.000Z"));
});

it("withdraws drilldown links after scope refusal and recovers a transient read without offering writes", async () => {
  let denied = false; let transient = false; const read = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path.startsWith("/hospital-metrics?") && (denied || transient)) throw new ApiClientError(denied ? 403 : 503, { error: { code: denied ? "SCOPE_DENIED" : "SOURCE_UNAVAILABLE" } });
    if (path.includes("/rows?")) return uiPage([{ targetType: "HOSPITAL_TASK", id: "metric-task", label: "Atividade autorizada", deepLink: "/planner/tasks/metric-task", occurredAt: metric.asOf, status: "PENDING", departmentCode: "INPATIENT" }]) as never;
    return read(path, init);
  });
  render(<HospitalMetricsView />);
  fireEvent.click(await screen.findByRole("button", { name: "Ver itens de Atividades pendentes" }));
  await screen.findByRole("link", { name: "Atividade autorizada" });
  transient = true; act(() => window.dispatchEvent(new Event("cvg:realtime-updated")));
  await screen.findByRole("button", { name: "Tentar novamente" });
  expect(screen.queryByRole("link", { name: "Atividade autorizada" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Ver itens/ })).not.toBeInTheDocument();
  transient = false; fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
  await screen.findByRole("link", { name: "Atividade autorizada" });
  denied = true; act(() => window.dispatchEvent(new Event("cvg:realtime-updated")));
  await waitFor(() => expect(screen.queryByRole("table")).not.toBeInTheDocument());
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method)).toBe(false);
});

it("does not query metrics for an account without the permission", async () => {
  user = { ...user, permissions: [] };
  render(<HospitalMetricsView />);
  await screen.findByText("Indicadores fora do seu acesso");
  expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path.startsWith("/hospital-metrics"))).toBe(false);
});
