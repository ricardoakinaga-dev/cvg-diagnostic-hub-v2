/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HospitalCapacityView, HospitalPlannerMetrics, SessionUser } from "@cvg/contracts";
import { HospitalMetricsView } from "./hospital-metrics-view";
import { apiFetch, ApiClientError } from "./api-client";
import { hospitalUser } from "./hospital-ui.test-helpers";
vi.mock("next/link", () => ({ default: ({ children, ...props }: { children: React.ReactNode; href: string }) => <a {...props}>{children}</a> }));
vi.mock("./api-client", async original => ({ ...await original<typeof import("./api-client")>(), apiFetch: vi.fn() }));
let user: SessionUser; let capacity: HospitalCapacityView; let denied: boolean;
const metrics: HospitalPlannerMetrics = { asOf: "2026-10-11T12:00:00Z", window: { from: "2026-10-11T00:00:00Z", to: "2026-10-12T00:00:00Z", convention: "START_INCLUSIVE_END_EXCLUSIVE" }, scope: { departmentCodes: ["INPATIENT"], policy: "CURRENT_OBJECT_AUTHORIZATION" }, values: [] };
beforeEach(() => {
  vi.mocked(apiFetch).mockReset(); denied = false;
  user = { ...hospitalUser, role: "MANAGER", permissions: ["hospital_metric.view", "hospital_capacity.view", "department.view"] };
  capacity = { from: metrics.window.from, to: metrics.window.to, asOf: metrics.asOf, authorizedLoad: { openDiagnosticItems: 0, overdueDiagnosticItems: 0, openHospitalTasks: 2, estimatedMinutes: 60 }, sla: { source: "REQUEST_CAPTURE", unit: "ELAPSED_HOURS", calendarPausesDeadline: false }, resources: [
    { resourceId: "room", code: "ROOM", name: "Sala autorizada", departmentCode: "INPATIENT", kind: "ROOM", unit: "MINUTES", nominal: 120, reserved: 30, available: 90, unavailable: 0, availabilityKnown: true },
    { resourceId: "bed", code: "BED", name: "Leito não conciliado", departmentCode: "INPATIENT", kind: "BED", unit: "BEDS", nominal: 1, reserved: 0, available: null, unavailable: 0, availabilityKnown: false, reason: "LEGACY_OCCUPANCY_NOT_LINKED" }
  ] };
  vi.mocked(apiFetch).mockImplementation(async path => {
    if (path === "/session/me") return { user } as never;
    if (path.startsWith("/departments")) return [{ id: "inpatient", code: "INPATIENT", name: "Internação", active: true }] as never;
    if (path.startsWith("/hospital-metrics?")) return metrics as never;
    if (path.startsWith("/hospital-capacity?")) {
      if (denied) throw new ApiClientError(404, { error: { code: "SCOPE_DENIED" } });
      return capacity as never;
    }
    throw new Error(`Unexpected capacity workflow ${path}`);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("shows actual capacity alongside indicators with distinct units, unknown availability and conservative effort provenance", async () => {
  render(<HospitalMetricsView />);
  const table = await screen.findByRole("table", { name: "Capacidade dos recursos autorizados" });
  expect(within(table).getByRole("rowheader", { name: /Sala autorizada/ }).closest("tr")).toHaveTextContent("120 min30 min90 min0 min");
  expect(within(table).getByRole("rowheader", { name: /Leito não conciliado/ }).closest("tr")).toHaveTextContent("1 leito(s)0 leito(s)Não informada0 leito(s)");
  expect(screen.getByText(/Estimativa de esforço: 60 min/)).toBeInTheDocument();
  expect(screen.getByText(/HPL-CAPACITY-1/)).toHaveTextContent("aceitação institucional");
  expect(screen.getByText(/Origem: inventário e janelas cadastradas/)).toHaveTextContent("Admission");
  expect(screen.getByText(/Denominador: toda a carga aberta atualmente autorizada/)).toHaveTextContent("sem estimativa");
  expect(screen.getByText(/Leitos representam a ocupação atual/)).toBeInTheDocument();
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method)).toBe(false);
});

it("applies the same sector and half-open period to both authorities without querying unsubmitted filters", async () => {
  render(<HospitalMetricsView />); await screen.findByRole("table", { name: "Capacidade dos recursos autorizados" });
  const form = screen.getByRole("form", { name: "Filtrar indicadores hospitalares" });
  await within(form).findByRole("option", { name: "Internação" });
  const previous = vi.mocked(apiFetch).mock.calls.filter(([path]) => path.startsWith("/hospital-capacity?")).length;
  fireEvent.change(within(form).getByLabelText("Setor dos indicadores"), { target: { value: "INPATIENT" } });
  fireEvent.change(within(form).getByLabelText("Período de"), { target: { value: "2026-10-12T08:00" } });
  fireEvent.change(within(form).getByLabelText("Período até"), { target: { value: "2026-10-13T08:00" } });
  expect(vi.mocked(apiFetch).mock.calls.filter(([path]) => path.startsWith("/hospital-capacity?"))).toHaveLength(previous);
  fireEvent.submit(form);
  const query = "from=2026-10-12T11%3A00%3A00.000Z&to=2026-10-13T11%3A00%3A00.000Z&departmentCode=INPATIENT";
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(`/hospital-capacity?${query}`));
  expect(apiFetch).toHaveBeenCalledWith(`/hospital-metrics?${query}`);
});

it("keeps unestimated effort unknown and zero legitimate without inferring execution from item counts", async () => {
  capacity.authorizedLoad = { openDiagnosticItems: 1, overdueDiagnosticItems: 1, openHospitalTasks: 2, estimatedMinutes: null };
  render(<HospitalMetricsView />);
  expect(await screen.findByText(/Estimativa de esforço: Não informada/)).toHaveTextContent("quantidade de itens não equivale");
  capacity = { ...capacity, authorizedLoad: { openDiagnosticItems: 0, overdueDiagnosticItems: 0, openHospitalTasks: 0, estimatedMinutes: 0 } };
  act(() => window.dispatchEvent(new Event("cvg:realtime-updated")));
  await screen.findByText(/Estimativa de esforço: 0 min/);
});

it("never queries capacity merely because metric access is granted", async () => {
  user = { ...user, permissions: ["hospital_metric.view", "department.view"] };
  render(<HospitalMetricsView />); await screen.findByRole("table", { name: "Definições e valores operacionais" });
  expect(screen.queryByRole("table", { name: "Capacidade dos recursos autorizados" })).not.toBeInTheDocument();
  expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path.startsWith("/hospital-capacity"))).toBe(false);
});

it("removes capacity on current scope refusal and after removal of its specific grant", async () => {
  render(<HospitalMetricsView />); await screen.findByRole("rowheader", { name: /Sala autorizada/ });
  denied = true; act(() => window.dispatchEvent(new Event("cvg:realtime-updated")));
  await waitFor(() => expect(screen.queryByRole("rowheader", { name: /Sala autorizada/ })).not.toBeInTheDocument());
  expect(screen.getByRole("table", { name: "Definições e valores operacionais" })).toBeInTheDocument();
  denied = false; act(() => window.dispatchEvent(new Event("cvg:realtime-updated")));
  await screen.findByRole("rowheader", { name: /Sala autorizada/ });
  user = { ...user, permissions: ["hospital_metric.view", "department.view"] };
  act(() => window.dispatchEvent(new Event("cvg:realtime-resync")));
  await screen.findByText("Capacidade fora do seu acesso.");
  expect(screen.queryByRole("table", { name: "Capacidade dos recursos autorizados" })).not.toBeInTheDocument();
  const count = vi.mocked(apiFetch).mock.calls.filter(([path]) => path.startsWith("/hospital-capacity?")).length;
  act(() => window.dispatchEvent(new Event("cvg:realtime-updated")));
  await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.filter(([path]) => path.startsWith("/hospital-metrics?")).length).toBeGreaterThan(2));
  expect(vi.mocked(apiFetch).mock.calls.filter(([path]) => path.startsWith("/hospital-capacity?"))).toHaveLength(count);
});
