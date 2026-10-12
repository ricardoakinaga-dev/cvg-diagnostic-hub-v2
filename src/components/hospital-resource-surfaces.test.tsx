/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HospitalCalendarEvent, HospitalCapacityView as Capacity, Patient } from "@cvg/contracts";
import { HospitalCalendarView } from "./hospital-calendar-view";
import { HospitalCapacityView } from "./hospital-capacity-view";
import { HospitalBedCensus } from "./hospital-bed-census";
import { HospitalResourceConsole } from "./hospital-resource-console";
import { usePlannerResource } from "./use-planner-resource";
import { apiFetch, ApiClientError } from "./api-client";
import { bedCensus, hospitalBed, hospitalOptions, hospitalPermissions, hospitalResource, hospitalSchedule, hospitalUser, uiPage } from "./hospital-ui.test-helpers";
import { taskView } from "./planner.test-helpers";
vi.mock("next/link", () => ({ default: ({ children, ...props }: { children: React.ReactNode; href: string }) => <a {...props}>{children}</a> }));
vi.mock("./api-client", async (original) => ({ ...await original<typeof import("./api-client")>(), apiFetch: vi.fn() }));
beforeEach(() => { vi.mocked(apiFetch).mockImplementation(async (path) => { if (path === "/session/me") return { user: hospitalUser } as never; if (path.startsWith("/departments")) return [] as never; throw new Error(`Unexpected synthetic path ${path}`); }); });
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.unstubAllGlobals(); });
const patient: Patient = { id: "patient", externalId: "P-1", displayName: "Paciente autorizado", species: "Canino", breed: "Sem raça definida", sex: "FEMALE", ownerLabel: "Tutor sintético", active: true };
const occupancy = { admissionId: "admission", encounterId: "encounter", patientId: patient.id, patientName: patient.displayName, admittedAt: "2026-10-11T12:00:00Z", version: 6, openDiagnosticItemCount: 2, openHospitalTaskCount: 1 };
function writes() { return vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method); }
function change(label: string, value: string) { fireEvent.change(screen.getByLabelText(label), { target: { value } }); }

it("reports a failed session before querying capacity and offers a full reload to recover current access", async () => {
  const reload = vi.fn(); const realWindow = window;
  vi.stubGlobal("window", new Proxy(realWindow, { get(target, property) { if (property === "location") return { reload }; const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value; } }));
  vi.mocked(apiFetch).mockRejectedValue(new ApiClientError(503, { error: { code: "UNAVAILABLE" } })); render(<HospitalCapacityView />); await screen.findByRole("heading", { name: "Capacidade indisponível" }); expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path.startsWith("/hospital-capacity?"))).toBe(false); fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" })); expect(reload).toHaveBeenCalledOnce();
});

it("keeps reconciled bed counts, unavailable resources and estimated effort distinct while applying an institutional capacity period", async () => {
  const capacity: Capacity = { from: "2026-10-11T12:00:00Z", to: "2026-10-12T12:00:00Z", asOf: "2026-10-11T12:00:00Z", resources: [{ resourceId: "bed", code: "BED", name: "Leitos do setor", kind: "BED", departmentCode: "INPATIENT", unit: "BEDS", nominal: 3, reserved: 1, available: 2, unavailable: 0, availabilityKnown: true }, { resourceId: "legacy", code: "LEGACY", name: "Leitos por conciliar", kind: "BED", departmentCode: "INPATIENT", unit: "BEDS", nominal: 2, reserved: 0, available: null, unavailable: null, availabilityKnown: false, reason: "LEGACY_OCCUPANCY_NOT_LINKED" }, { resourceId: "blocked", code: "BLOCKED", name: "Sala em manutenção", kind: "ROOM", departmentCode: "EMERGENCY", unit: "MINUTES", nominal: 60, reserved: 0, available: 0, unavailable: 60, availabilityKnown: true, reason: "RESOURCE_UNAVAILABLE" }], authorizedLoad: { openDiagnosticItems: 0, overdueDiagnosticItems: 0, openHospitalTasks: 3, estimatedMinutes: 45 }, sla: { source: "REQUEST_CAPTURE", unit: "ELAPSED_HOURS", calendarPausesDeadline: false } };
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => path.startsWith("/departments") ? [{ id: "inpatient", code: "INPATIENT", name: "Internação cadastrada", active: true }] as never : path.startsWith("/hospital-capacity?") ? capacity as never : original(path, init));
  render(<HospitalCapacityView />); const bed = (await screen.findByRole("rowheader", { name: /Leitos do setor/ })).closest("tr")!; expect(within(bed).getByRole("cell", { name: "2 leito(s)" })).toBeInTheDocument(); expect(screen.getByRole("rowheader", { name: /Leitos por conciliar/ })).toHaveTextContent("internações sem conciliação"); expect(screen.getByRole("rowheader", { name: /Sala em manutenção/ })).toHaveTextContent("recurso indisponível"); expect(screen.getByText("Estimativa de esforço: 45 min")).toBeInTheDocument();
  change("Setor da capacidade", "INPATIENT"); change("Período de", "2026-10-12T12:00"); change("Período até", "2026-10-11T12:00"); fireEvent.submit(screen.getByRole("form", { name: "Filtrar capacidade" })); expect(await screen.findByRole("alert")).toHaveTextContent("fim do período"); change("Período até", "2026-10-13T12:00"); fireEvent.click(screen.getByRole("button", { name: "Aplicar período" })); await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path.includes("departmentCode=INPATIENT") && path.includes(encodeURIComponent("2026-10-12T15:00:00.000Z")))).toBe(true)); expect(writes()).toHaveLength(0);
});

it("retains confirmed capacity during temporary degradation but removes it after scope revocation and retries into a truly empty inventory", async () => {
  let mode = "fresh"; const original = vi.mocked(apiFetch).getMockImplementation()!;
  const capacity: Capacity = { from: "2026-10-11T12:00:00Z", to: "2026-10-12T12:00:00Z", asOf: "2026-10-11T12:00:00Z", resources: [], authorizedLoad: { openDiagnosticItems: 0, overdueDiagnosticItems: 0, openHospitalTasks: 0, estimatedMinutes: 0 }, sla: { source: "REQUEST_CAPTURE", unit: "ELAPSED_HOURS", calendarPausesDeadline: false } };
  vi.mocked(apiFetch).mockImplementation(async (path, init) => { if (path.startsWith("/hospital-capacity?")) { if (mode !== "fresh") throw new ApiClientError(mode === "revoked" ? 404 : 503, { error: { code: mode === "revoked" ? "SCOPE_DENIED" : "UNAVAILABLE" } }); return capacity as never; } return original(path, init); });
  render(<HospitalCapacityView />); await screen.findByText("Nenhum recurso autorizado neste período."); expect(screen.getByText("Estimativa de esforço: 0 min")).toBeInTheDocument(); mode = "degraded"; act(() => window.dispatchEvent(new Event("cvg:realtime-resync"))); await screen.findByRole("status", { name: "Leitura parcial" }); expect(screen.getByRole("region", { name: "Carga autorizada" })).toBeInTheDocument();
  mode = "revoked"; fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" })); await waitFor(() => expect(screen.queryByRole("region", { name: "Carga autorizada" })).not.toBeInTheDocument()); expect(screen.queryByRole("table")).not.toBeInTheDocument(); mode = "fresh"; fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" })); await screen.findByText("Nenhum recurso autorizado neste período."); expect(writes()).toHaveLength(0);
});

it("fails closed for capacity without its effective permission and does not query operational aggregates", async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!; vi.mocked(apiFetch).mockImplementation(async (path, init) => path === "/session/me" ? { user: { ...hospitalUser, permissions: ["hospital_task.view"] } } as never : original(path, init));
  render(<HospitalCapacityView />); await screen.findByRole("heading", { name: "Capacidade fora do seu acesso" }); expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path.startsWith("/hospital-capacity"))).toBe(false); expect(screen.queryByRole("table")).not.toBeInTheDocument();
});

it("reconciles legacy occupancy only through an explicit eligible bed ID, admission version and hospital-time reason", async () => {
  let census = bedCensus({ beds: [{ resource: hospitalBed(), state: "UNRECONCILED" }], unregisteredAdmissions: [{ admissionId: "admission", patientId: patient.id, patientName: patient.displayName, departmentCode: "INPATIENT", ward: "Legado", bed: "Texto antigo", version: 6 }] });
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === "/patients/patient") return patient as never;
    if (path.startsWith("/admissions/admission/context-options")) return { departments: hospitalOptions.departments, eligibleResponsibles: hospitalOptions.staff } as never;
    if (path === "/admissions/admission/context") { census = bedCensus({ beds: [{ resource: hospitalBed(), state: "OCCUPIED", occupancy: { ...occupancy, version: 7 } }] }); return {} as never; }
    if (path.startsWith("/bed-census")) return census as never;
    return original(path, init);
  });
  render(<HospitalBedCensus />);
  fireEvent.click(await screen.findByRole("button", { name: "Conciliar leito de Paciente autorizado" }));
  expect(screen.getByLabelText("Operação da acomodação")).toBeDisabled();
  await screen.findByLabelText("Leito cadastrado");
  change("Motivo da mudança", "Conciliação do inventário legado");
  fireEvent.submit(screen.getByRole("form", { name: "Alterar leito da internação" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Selecione o leito"); expect(writes()).toHaveLength(0);
  change("Leito cadastrado", "bed-1"); change("Vigência da mudança", "2026-10-11T10:00");
  fireEvent.click(screen.getByRole("button", { name: "Confirmar alteração de leito" }));
  await waitFor(() => expect(screen.queryByRole("form", { name: "Alterar leito da internação" })).not.toBeInTheDocument());
  expect(JSON.parse(writes()[0][1]!.body as string)).toEqual({ action: "BED_CHANGE", bedResourceId: "bed-1", effectiveAt: "2026-10-11T13:00:00.000Z", reason: "Conciliação do inventário legado", expectedVersion: 6 });
  expect(writes()[0][0]).toBe("/admissions/admission/context");
  expect(await screen.findByRole("button", { name: "Alterar acomodação de Paciente autorizado" })).toBeInTheDocument();
});

it("transfers an admission using destination census, an eligible responsible and an explicit effective time", async () => {
  const census = bedCensus({ beds: [{ resource: hospitalBed(), state: "OCCUPIED", occupancy }] });
  const destination = bedCensus({ beds: [{ resource: hospitalBed({ id: "bed-emergency", name: "Destino cadastrado", departmentCode: "EMERGENCY" }), state: "AVAILABLE" }] });
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => path === "/patients/patient" ? patient as never : path.startsWith("/admissions/admission/context-options") ? { departments: hospitalOptions.departments, eligibleResponsibles: [{ id: "destination-professional", displayName: "Responsável no destino", departmentCode: "EMERGENCY" }] } as never : path === "/admissions/admission/context" ? {} as never : path.startsWith("/bed-census") ? (path.includes("EMERGENCY") ? destination : census) as never : original(path, init));
  render(<HospitalBedCensus />); fireEvent.click(await screen.findByRole("button", { name: "Alterar acomodação de Paciente autorizado" }));
  change("Operação da acomodação", "TRANSFER"); await screen.findByRole("option", { name: "Emergência" }); change("Setor de transferência", "EMERGENCY");
  await screen.findByRole("option", { name: /Destino cadastrado/ });
  change("Leito cadastrado", "bed-emergency"); change("Motivo da mudança", "Cobertura assistencial no destino");
  fireEvent.submit(screen.getByRole("form", { name: "Alterar leito da internação" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("responsável"); expect(writes()).toHaveLength(0);
  change("Responsável no destino", "destination-professional"); change("Vigência da mudança", "2026-10-11T11:00");
  fireEvent.click(screen.getByRole("button", { name: "Confirmar alteração de leito" }));
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(JSON.parse(writes()[0][1]!.body as string)).toEqual({ action: "TRANSFER", bedResourceId: "bed-emergency", departmentCode: "EMERGENCY", responsibleUserId: "destination-professional", effectiveAt: "2026-10-11T14:00:00.000Z", reason: "Cobertura assistencial no destino", expectedVersion: 6 });
});

it("retains a bed-change intent after a concurrent rejection and closes it without altering admission history", async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (init?.method) throw new ApiClientError(409, { error: { code: "STALE_VERSION" } });
    if (path === "/patients/patient") return patient as never;
    if (path.startsWith("/admissions/")) return { departments: hospitalOptions.departments, eligibleResponsibles: [] } as never;
    if (path.startsWith("/bed-census")) return bedCensus({ beds: [{ resource: hospitalBed(), state: "OCCUPIED", occupancy }, { resource: hospitalBed({ id: "free-bed", name: "Leito livre" }), state: "AVAILABLE" }] }) as never;
    return original(path, init);
  });
  render(<HospitalBedCensus />); fireEvent.click(await screen.findByRole("button", { name: "Alterar acomodação de Paciente autorizado" }));
  await screen.findByLabelText("Leito cadastrado"); change("Leito cadastrado", "free-bed"); change("Motivo da mudança", "Intenção preservada");
  fireEvent.click(screen.getByRole("button", { name: "Confirmar alteração de leito" })); await screen.findByRole("alert");
  expect(screen.getByLabelText("Motivo da mudança")).toHaveValue("Intenção preservada");
  fireEvent.click(screen.getByRole("button", { name: "Confirmar alteração de leito" })); await waitFor(() => expect(writes()).toHaveLength(2));
  expect(writes()[0][1]!.headers).toEqual(writes()[1][1]!.headers);
  fireEvent.click(screen.getByRole("button", { name: "Voltar sem alterar internação" }));
  expect(screen.queryByRole("form", { name: "Alterar leito da internação" })).not.toBeInTheDocument();
  change("Setor do censo", "INPATIENT"); await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/bed-census?departmentCode=INPATIENT"));
});

it("blocks accommodation changes while patient or contextual options are denied and retries metadata without writing", async () => {
  let denied = true; const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === "/patients/patient") { if (denied) throw new ApiClientError(404, { error: { code: "SCOPE_DENIED" } }); return patient as never; }
    if (path.startsWith("/admissions/")) return { departments: hospitalOptions.departments, eligibleResponsibles: [] } as never;
    if (path.startsWith("/bed-census")) return bedCensus({ beds: [{ resource: hospitalBed(), state: "OCCUPIED", occupancy }] }) as never;
    return original(path, init);
  });
  render(<HospitalBedCensus />); fireEvent.click(await screen.findByRole("button", { name: "Alterar acomodação de Paciente autorizado" }));
  await screen.findByRole("status", { name: "Leitura parcial" }); expect(screen.queryByLabelText("Leito cadastrado")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Confirmar alteração de leito" })).toBeDisabled();
  denied = false; fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" })); await screen.findByLabelText("Leito cadastrado");
  expect(writes()).toHaveLength(0);
});

it("removes census identities and command affordances after the server revokes census access", async () => {
  let denied = false; const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => { if (path.startsWith("/bed-census")) { if (denied) throw new ApiClientError(404, { error: { code: "SCOPE_DENIED" } }); return bedCensus({ beds: [{ resource: hospitalBed(), state: "OCCUPIED", occupancy }] }) as never; } return original(path, init); });
  render(<HospitalBedCensus />); await screen.findByRole("link", { name: "Paciente autorizado" }); denied = true;
  act(() => window.dispatchEvent(new Event("cvg:realtime-updated"))); await screen.findByRole("status", { name: "Leitura parcial" });
  expect(screen.queryByRole("link", { name: "Paciente autorizado" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Alterar acomodação/ })).not.toBeInTheDocument(); expect(document.body.innerHTML).not.toContain("encounter");
  denied = false; fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" })); await screen.findByRole("link", { name: "Paciente autorizado" });
});

it("creates a professional resource only after validating institutional availability windows and its current department", async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => path === "/hospital-resources/options" ? { departments: hospitalOptions.departments, professionals: hospitalOptions.staff } as never : path.startsWith("/hospital-resources?") ? uiPage([]) as never : path === "/hospital-resources" && init?.method ? hospitalResource({ kind: "PROFESSIONAL", userId: "professional-c", name: "Cobertura registrada" }) as never : original(path, init));
  render(<HospitalResourceConsole />); await waitFor(() => expect(screen.getByRole("button", { name: "Novo recurso" })).toBeEnabled()); fireEvent.click(screen.getByRole("button", { name: "Novo recurso" }));
  change("Código do recurso", "PROFESSIONAL_ONE"); change("Nome do recurso", "Cobertura registrada"); change("Tipo do cadastro", "PROFESSIONAL");
  fireEvent.submit(screen.getByRole("form", { name: "Criar recurso hospitalar" })); expect(await screen.findByRole("alert")).toHaveTextContent("profissional cadastrado");
  change("Profissional cadastrado", "professional-c"); fireEvent.click(screen.getByRole("button", { name: "Adicionar janela" }));
  change("Início da janela 1", "2026-10-11T12:00"); change("Fim da janela 1", "2026-10-11T11:00");
  fireEvent.submit(screen.getByRole("form", { name: "Criar recurso hospitalar" })); expect(screen.getByRole("alert")).toHaveTextContent("fim de cada janela"); expect(writes()).toHaveLength(0);
  change("Fim da janela 1", "2026-10-11T13:00"); change("Disponibilidade", "MAINTENANCE");
  fireEvent.click(screen.getByRole("button", { name: "Adicionar janela" })); fireEvent.click(screen.getByRole("button", { name: "Remover janela 2" }));
  fireEvent.click(screen.getByRole("button", { name: "Salvar recurso" })); await screen.findByText("Recurso Cobertura registrada salvo.");
  expect(JSON.parse(writes()[0][1]!.body as string)).toEqual({ code: "PROFESSIONAL_ONE", name: "Cobertura registrada", kind: "PROFESSIONAL", userId: "professional-c", departmentCode: "INPATIENT", availability: "MAINTENANCE", availabilityWindows: [{ startsAt: "2026-10-11T15:00:00.000Z", endsAt: "2026-10-11T16:00:00.000Z" }] });
});

it("edits versioned resource metadata without changing immutable kind/code, then requires confirmation to deactivate", async () => {
  let resource = hospitalResource(); const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === "/hospital-resources/options") return { departments: hospitalOptions.departments, professionals: hospitalOptions.staff } as never;
    if (path.startsWith("/hospital-resources?")) return uiPage([resource]) as never;
    if (path === "/hospital-resources/room-1" && init?.method) { const body = JSON.parse(init.body as string); resource = { ...resource, ...body, version: resource.version + 1 }; return resource as never; }
    return original(path, init);
  });
  render(<HospitalResourceConsole />); fireEvent.click(await screen.findByRole("button", { name: "Editar recurso Sala de procedimentos" }));
  expect(screen.getByLabelText("Tipo do cadastro")).toBeDisabled(); expect(screen.queryByLabelText("Código do recurso")).not.toBeInTheDocument();
  change("Nome do recurso", "Sala reorganizada"); change("Disponibilidade", "BLOCKED"); change("Setor do recurso", "EMERGENCY");
  fireEvent.click(screen.getByRole("button", { name: "Remover janela 1" })); fireEvent.click(screen.getByRole("button", { name: "Salvar recurso" }));
  await screen.findByRole("heading", { name: "Sala reorganizada" }); expect(JSON.parse(writes()[0][1]!.body as string)).toEqual({ name: "Sala reorganizada", departmentCode: "EMERGENCY", availability: "BLOCKED", availabilityWindows: [], expectedVersion: 2 });
  fireEvent.click(screen.getByRole("button", { name: "Desativar Sala reorganizada" })); fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancelar" })); expect(writes()).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Desativar Sala reorganizada" })); fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Desativar recurso" }));
  await screen.findByRole("button", { name: "Reativar Sala reorganizada" }); expect(JSON.parse(writes()[1][1]!.body as string)).toEqual({ active: false, expectedVersion: 3 });
  fireEvent.click(screen.getByRole("button", { name: "Reativar Sala reorganizada" })); fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Reativar recurso" }));
  await screen.findByRole("button", { name: "Desativar Sala reorganizada" }); expect(JSON.parse(writes()[2][1]!.body as string)).toEqual({ active: true, expectedVersion: 4 });
});

it("keeps a conflicted resource edit, uses cursor-backed inventory filters and clears them only after confirmation", async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!; let conflict = true;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === "/hospital-resources/options") return { departments: hospitalOptions.departments, professionals: hospitalOptions.staff } as never;
    if (path.startsWith("/hospital-resources?")) return uiPage(path.includes("cursor=") ? [hospitalResource({ id: "equipment", name: "Equipamento autorizado", kind: "EQUIPMENT", availabilityWindows: [] })] : [hospitalResource()], path.includes("cursor=") ? undefined : "next") as never;
    if (init?.method) { if (conflict) throw new ApiClientError(409, { error: { code: "STALE_VERSION" } }); return hospitalResource({ name: "Texto conservado" }) as never; }
    return original(path, init);
  });
  render(<HospitalResourceConsole />); fireEvent.click(await screen.findByRole("button", { name: "Carregar mais recursos" })); await screen.findByRole("heading", { name: "Equipamento autorizado" });
  change("Buscar recurso", "Sala"); change("Tipo de recurso", "ROOM"); fireEvent.click(screen.getByRole("checkbox", { name: "Incluir recursos inativos" }));
  fireEvent.click(await screen.findByRole("button", { name: "Editar recurso Sala de procedimentos" })); change("Nome do recurso", "Texto conservado");
  fireEvent.click(screen.getByRole("button", { name: "Salvar recurso" })); await screen.findByRole("alert"); expect(screen.getByLabelText("Nome do recurso")).toHaveValue("Texto conservado");
  conflict = false; fireEvent.click(screen.getByRole("button", { name: "Salvar recurso" })); await screen.findByRole("button", { name: "Limpar filtros para localizar" });
  fireEvent.click(screen.getByRole("button", { name: "Limpar filtros para localizar" })); expect(screen.getByLabelText("Buscar recurso")).toHaveValue(""); expect(screen.getByLabelText("Tipo de recurso")).toHaveValue("");
  expect(writes()[0][1]!.headers).toEqual(writes()[1][1]!.headers);
});

it("filters calendar source/resource and validates its period without changing diagnostic deadlines", async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  const event: HospitalCalendarEvent = { id: "deadline", kind: "DEADLINE", targetType: "DIAGNOSTIC_ITEM", targetId: "item", departmentCode: "INPATIENT", label: "Prazo existente", startsAt: "2026-10-11T12:00:00Z", deepLink: "/requests/request#item" };
  vi.mocked(apiFetch).mockImplementation(async (path, init) => path.startsWith("/hospital-calendar?") ? uiPage([event]) as never : path.startsWith("/hospital-resources?") ? uiPage(path.includes("cursor=") ? [hospitalResource({ id: "equipment", name: "Equipamento autorizado" })] : [hospitalResource(), hospitalBed()], path.includes("cursor=") ? undefined : "next") as never : original(path, init));
  render(<HospitalCalendarView />); await screen.findByRole("link", { name: "Prazo existente" });
  change("Setor da agenda", "INPATIENT"); fireEvent.click(await screen.findByRole("button", { name: "Carregar mais opções de recursos" })); await screen.findByRole("option", { name: /Equipamento autorizado/ });
  expect(screen.queryByRole("option", { name: /Leito cadastrado/ })).not.toBeInTheDocument();
  change("Recurso da agenda", "equipment"); change("Fonte do evento", "DEADLINE");
  await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path.includes("resourceId=equipment") && path.includes("kinds=DEADLINE"))).toBe(true));
  change("Período de", "2026-10-12T12:00"); change("Período até", "2026-10-11T12:00"); fireEvent.submit(screen.getByRole("form", { name: "Filtros da agenda" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("fim do período"); change("Período até", "2026-10-13T12:00"); fireEvent.click(screen.getByRole("button", { name: "Aplicar período" }));
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  expect(await screen.findByRole("link", { name: "Prazo existente" })).toHaveAttribute("href", "/requests/request#item"); expect(writes()).toHaveLength(0);
});

it("manages a persisted reservation from the agenda only after revalidating task capabilities", async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!; let changed = false;
  const schedule = hospitalSchedule({ resourceSnapshots: [] });
  const event: HospitalCalendarEvent = { id: "reservation-event", kind: "RESERVATION", targetType: "HOSPITAL_TASK", targetId: "task-1", departmentCode: "INPATIENT", label: "Rotina reservada", startsAt: schedule.startsAt, endsAt: schedule.endsAt, schedule, deepLink: "/planner/tasks/task-1" };
  vi.mocked(apiFetch).mockImplementation(async (path, init) => path.startsWith("/hospital-calendar?") ? uiPage(changed ? [] : [event]) as never : path.startsWith("/hospital-resources?") ? uiPage([hospitalResource()]) as never : path === "/hospital-tasks/task-1" ? taskView({}, hospitalPermissions) as never : path.endsWith("/cancel") ? (changed = true, hospitalSchedule({ status: "CANCELLED" })) as never : original(path, init));
  render(<HospitalCalendarView />); fireEvent.click(await screen.findByRole("button", { name: "Gerenciar reserva de Rotina reservada" }));
  fireEvent.click(await screen.findByRole("button", { name: "Cancelar reserva" })); change("Motivo da reserva", "Indisponibilidade confirmada"); fireEvent.click(screen.getByRole("button", { name: "Voltar sem alterar reserva" })); expect(writes()).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Cancelar reserva" })); fireEvent.click(screen.getByRole("button", { name: "Confirmar cancelamento da reserva" }));
  await screen.findByRole("heading", { name: "Nenhum evento neste período" });
  expect(writes()[0][0]).toBe("/hospital-reservations/reservation-1/cancel"); expect(JSON.parse(writes()[0][1]!.body as string)).toEqual({ reason: "Indisponibilidade confirmada", expectedVersion: 7 });
});

it("keeps reservation commands hidden when contextual task access is denied and retries without changing the persisted snapshot", async () => {
  let denied = true; const original = vi.mocked(apiFetch).getMockImplementation()!;
  const event: HospitalCalendarEvent = { id: "reservation", kind: "RESERVATION", targetType: "HOSPITAL_TASK", targetId: "task-1", departmentCode: "INPATIENT", label: "Reserva vigente", startsAt: "2026-10-11T14:00:00Z", endsAt: "2026-10-11T15:00:00Z", schedule: hospitalSchedule(), deepLink: "/planner/tasks/task-1" };
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path.startsWith("/departments")) return [{ id: "inpatient", code: "INPATIENT", name: "Internação cadastrada", active: true }] as never;
    if (path.startsWith("/hospital-calendar?")) return uiPage([event]) as never;
    if (path.startsWith("/hospital-resources?")) return uiPage([]) as never;
    if (path === "/hospital-tasks/task-1") { if (denied) throw new ApiClientError(404, { error: { code: "SCOPE_DENIED" } }); return taskView({}, ["hospital_task.view"]) as never; }
    return original(path, init);
  });
  render(<HospitalCalendarView />); await screen.findByRole("option", { name: "Internação cadastrada" }); fireEvent.click(await screen.findByRole("button", { name: "Gerenciar reserva de Reserva vigente" }));
  await screen.findByRole("status", { name: "Leitura parcial" }); expect(screen.queryByRole("button", { name: "Cancelar reserva" })).not.toBeInTheDocument();
  denied = false; fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" })); await waitFor(() => expect(screen.queryByRole("status", { name: "Leitura parcial" })).not.toBeInTheDocument());
  expect(screen.queryByRole("button", { name: "Cancelar reserva" })).not.toBeInTheDocument(); expect(screen.getByText(/Recurso: Sala de procedimentos/)).toBeInTheDocument(); expect(writes()).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Gerenciar reserva de Reserva vigente" })); expect(screen.getByRole("button", { name: "Gerenciar reserva de Reserva vigente" })).toHaveAttribute("aria-expanded", "false");
});
it("calendar labels actual reservations, deadlines and executions separately and loads the next page without duplicates", async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!; const events: HospitalCalendarEvent[] = ["RESERVATION", "DEADLINE", "EXECUTION"].map((kind, index) => ({ id: `event-${index}`, kind: kind as HospitalCalendarEvent["kind"], targetType: "HOSPITAL_TASK", targetId: `task-${index}`, departmentCode: "INPATIENT", label: `Registro ${index}`, startsAt: "2026-10-11T01:30:00.000Z", deepLink: `/planner/tasks/task-${index}` }));
  vi.mocked(apiFetch).mockImplementation(async (path, init) => path.startsWith("/hospital-calendar?") ? uiPage(path.includes("cursor=") ? [events[0], { ...events[2], id: "event-3", label: "Outro registro" }] : events, path.includes("cursor=") ? undefined : "next") as never : path.startsWith("/hospital-resources?") ? uiPage([]) as never : original(path, init)); render(<HospitalCalendarView />);
  expect(await screen.findByRole("link", { name: "Registro 0" })).toBeInTheDocument(); const reservation = screen.getByRole("link", { name: "Registro 0" }).closest("article")!; expect(reservation).toHaveTextContent("Reserva"); expect(screen.getByRole("link", { name: "Registro 1" }).closest("article")).toHaveTextContent("Prazo"); expect(screen.getByRole("link", { name: "Registro 2" }).closest("article")).toHaveTextContent("Execução registrada"); expect(screen.getByRole("region", { name: "Agenda 2026-10-10" })).toBeInTheDocument(); fireEvent.click(screen.getByRole("button", { name: "Carregar mais eventos" })); await screen.findByRole("link", { name: "Outro registro" }); expect(screen.getAllByRole("link", { name: "Registro 0" })).toHaveLength(1);
});
it("capacity preserves unknown availability and effort as unknown, with elapsed-hour SLA independent from calendar", async () => {
  const capacity: Capacity = { from: "2026-10-11T12:00:00Z", to: "2026-10-12T12:00:00Z", asOf: "2026-10-11T12:00:00Z", resources: [{ resourceId: "room", code: "ROOM", name: "Sala sem calendário", kind: "ROOM", departmentCode: "INPATIENT", unit: "MINUTES", nominal: null, reserved: 0, available: null, unavailable: null, availabilityKnown: false, reason: "CALENDAR_NOT_CONFIGURED" }], authorizedLoad: { openDiagnosticItems: 3, overdueDiagnosticItems: 1, openHospitalTasks: 2, estimatedMinutes: null }, sla: { source: "REQUEST_CAPTURE", unit: "ELAPSED_HOURS", calendarPausesDeadline: false } };
  const original = vi.mocked(apiFetch).getMockImplementation()!; vi.mocked(apiFetch).mockImplementation(async (path, init) => path.startsWith("/hospital-capacity?") ? capacity as never : original(path, init)); render(<HospitalCapacityView />); const row = (await screen.findByRole("rowheader", { name: /Sala sem calendário/ })).closest("tr")!; expect(within(row).getAllByText("Não informada")).toHaveLength(3); expect(screen.getByRole("region", { name: "Carga autorizada" })).toHaveTextContent("3 exames ativos · 1 exames atrasados · 2 atividades hospitalares ativas"); expect(screen.getByText(/SLA diagnóstico/)).toHaveTextContent("horas corridas desde a solicitação"); expect(screen.getByText(/Estimativa de esforço/)).toHaveTextContent("Não informada");
});
it("census distinguishes restricted occupancy and unreconciled inventory while preserving discharged pending work", async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!; const census = bedCensus({ beds: [{ resource: hospitalBed(), state: "UNRECONCILED" }, { resource: hospitalBed({ id: "restricted-bed", name: "Leito restrito" }), state: "RESTRICTED_OCCUPANCY", occupancy: { admissionId: "private-admission", encounterId: "private-encounter", patientId: "private-patient", patientName: "Nome que deve permanecer oculto", admittedAt: "2026-10-11T12:00:00Z", version: 2, openDiagnosticItemCount: 3, openHospitalTaskCount: 1 } }], unregisteredAdmissions: [{ admissionId: "legacy", patientId: "patient", patientName: "Paciente legado autorizado", departmentCode: "INPATIENT", ward: "UTI antiga", bed: "03", version: 4 }], dischargedWithPendingWork: [{ admissionId: "discharged", patientId: "other", patientName: "Paciente com alta", openDiagnosticItemCount: 2, openHospitalTaskCount: 1 }] });
  vi.mocked(apiFetch).mockImplementation(async (path, init) => path.startsWith("/bed-census") ? census as never : original(path, init)); render(<HospitalBedCensus />); await screen.findByRole("heading", { name: "Leito cadastrado" }); expect(screen.getByText(/Ocupação ainda não conciliada/)).toBeInTheDocument(); expect(screen.getByText(/identificação restrita/)).toBeInTheDocument(); expect(screen.queryByText("Nome que deve permanecer oculto")).not.toBeInTheDocument(); expect(document.body.innerHTML).not.toContain("private-patient"); expect(screen.getByRole("region", { name: "Alta com pendências" })).toHaveTextContent("2 exames e 1 atividades ainda ativos"); expect(screen.getByRole("button", { name: "Conciliar leito de Paciente legado autorizado" })).toBeInTheDocument();
});
it("inventory creates a real bed with species and no hourly windows", async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!; vi.mocked(apiFetch).mockImplementation(async (path, init) => path === "/hospital-resources/options" ? { departments: hospitalOptions.departments, professionals: hospitalOptions.staff } as never : path.startsWith("/hospital-resources?") ? uiPage([]) as never : path === "/hospital-resources" && init?.method === "POST" ? hospitalBed() as never : original(path, init)); render(<HospitalResourceConsole />); await waitFor(() => expect(screen.getByRole("button", { name: "Novo recurso" })).toBeEnabled()); fireEvent.click(screen.getByRole("button", { name: "Novo recurso" })); fireEvent.change(screen.getByLabelText("Código do recurso"), { target: { value: "BED_ONE" } }); fireEvent.change(screen.getByLabelText("Nome do recurso"), { target: { value: "Leito novo" } }); fireEvent.change(screen.getByLabelText("Tipo do cadastro"), { target: { value: "BED" } }); fireEvent.change(screen.getByLabelText("Ala"), { target: { value: "Ala A" } }); fireEvent.change(screen.getByLabelText("Identificação do leito"), { target: { value: "Box 1" } }); fireEvent.change(screen.getByLabelText("Espécies compatíveis"), { target: { value: "Canino\nFelino" } }); expect(screen.queryByRole("button", { name: "Adicionar janela" })).not.toBeInTheDocument(); fireEvent.click(screen.getByRole("button", { name: "Salvar recurso" })); await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/hospital-resources", expect.objectContaining({ method: "POST" }))); const call = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === "POST")!; expect(JSON.parse(call[1]!.body as string)).toEqual({ code: "BED_ONE", name: "Leito novo", kind: "BED", departmentCode: "INPATIENT", availability: "AVAILABLE", availabilityWindows: [], ward: "Ala A", bedLabel: "Box 1", allowedSpecies: ["Canino", "Felino"] });
});
it("detail resource cannot restore a previously authorized patient after a newer denied response or identity change", async () => {
  let resolveOld!: (value: { patient: string }) => void; const old = new Promise<{ patient: string }>((resolve) => { resolveOld = resolve; }); let calls = 0; vi.mocked(apiFetch).mockImplementation(async () => { calls++; if (calls === 1) return { patient: "Antes" } as never; if (calls === 2) return old as never; throw new ApiClientError(404, { error: { code: "SCOPE_DENIED" } }); }); const hook = renderHook(({ userId }) => usePlannerResource<{ patient: string }>(userId, "/synthetic-authorized-resource"), { initialProps: { userId: "first" } }); await waitFor(() => expect(hook.result.current.data?.patient).toBe("Antes")); let pending: Promise<void>; act(() => { pending = hook.result.current.reload(); }); await act(async () => { await hook.result.current.reload(); }); expect(hook.result.current.data).toBeUndefined(); await act(async () => { resolveOld({ patient: "Não deve retornar" }); await pending!; }); expect(hook.result.current.data).toBeUndefined(); hook.rerender({ userId: "second" }); expect(hook.result.current.data).toBeUndefined();
});
