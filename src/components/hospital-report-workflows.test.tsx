/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HospitalReportDefinition, HospitalReportJobView, SessionUser } from "@cvg/contracts";
import { HospitalReportView } from "./hospital-report-view";
import { apiFetch, ApiClientError } from "./api-client";
import { hospitalUser } from "./hospital-ui.test-helpers";

vi.mock("./api-client", async (original) => ({ ...await original<typeof import("./api-client")>(), apiFetch: vi.fn() }));
const filters = { from: "2026-10-11T10:00:00.000Z", to: "2026-10-12T10:00:00.000Z", departmentCode: "INPATIENT" };
const definition: HospitalReportDefinition = { id: "report-one", name: "Pendências da equipe", ownerId: hospitalUser.id, metricCode: "TASK_PENDING", metricDefinitionVersion: "HPL-OPERATIONAL-1", filters, format: "CSV", sharedDepartmentCode: "INPATIENT", active: true, version: 4, createdAt: filters.from, updatedAt: filters.from };
let user: SessionUser;
let reports: HospitalReportDefinition[];
let jobs: HospitalReportJobView[];
const writes = () => vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method);
function job(status: "FAILED" | "SUCCEEDED"): HospitalReportJobView {
  const { name, metricCode, metricDefinitionVersion, format, version } = definition;
  return { job: { id: "job-one", reportId: definition.id, ownerId: user.id, definitionSnapshot: { name, metricCode, metricDefinitionVersion, filters, format, version }, status, attempts: 1, version: 3, rowCount: 1, ...(status === "FAILED" ? { errorCode: "SOURCE_UNAVAILABLE" } : { generatedAt: filters.to }), createdAt: filters.from, updatedAt: filters.to }, downloadAvailable: status === "SUCCEEDED" };
}
beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  user = { ...hospitalUser, permissions: ["hospital_report.view", "hospital_report.manage", "hospital_report.export", "department.view"] };
  reports = [structuredClone(definition)]; jobs = [];
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === "/session/me") return { user } as never;
    if (path === "/hospital-reports" && !init?.method) return reports as never;
    if (path === "/hospital-report-jobs" && !init?.method) return jobs as never;
    if (path.startsWith("/departments")) return [{ id: "dept-one", code: "INPATIENT", name: "Internação", active: true }, { id: "dept-old", code: "LEGACY", name: "Setor antigo", active: false }] as never;
    throw new Error(`Unexpected report workflow ${init?.method ?? "GET"} ${path}`);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("creates a filtered shared definition with hospital dates and rejects an inverted window before posting", async () => {
  const read = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => init?.method ? { ...definition, id: "new-report" } as never : read(path, init));
  render(<HospitalReportView />);
  fireEvent.click(await screen.findByRole("button", { name: "Nova definição de relatório" }));
  const form = screen.getByRole("form", { name: "Definir relatório hospitalar" });
  fireEvent.change(within(form).getByLabelText("Nome do relatório"), { target: { value: "  Rotinas do turno  " } });
  fireEvent.change(within(form).getByLabelText("Indicador do relatório"), { target: { value: "TASK_COMPLETED" } });
  await within(within(form).getByLabelText("Setor do relatório")).findByRole("option", { name: "Internação" });
  fireEvent.change(within(form).getByLabelText("Setor do relatório"), { target: { value: "INPATIENT" } });
  fireEvent.change(within(form).getByLabelText("Compartilhar definição com setor"), { target: { value: "INPATIENT" } });
  fireEvent.change(within(form).getByLabelText("Formato do arquivo"), { target: { value: "JSONL" } });
  fireEvent.change(within(form).getByLabelText("Período de"), { target: { value: "2026-10-12T08:00" } });
  fireEvent.change(within(form).getByLabelText("Período até"), { target: { value: "2026-10-11T08:00" } });
  fireEvent.submit(form);
  expect(await screen.findByRole("alert")).toHaveTextContent("O fim deve ser posterior");
  expect(writes()).toHaveLength(0);
  fireEvent.change(within(form).getByLabelText("Período até"), { target: { value: "2026-10-13T08:00" } });
  fireEvent.submit(form);
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writes()[0][0]).toBe("/hospital-reports");
  expect(JSON.parse(writes()[0][1]!.body as string)).toEqual({ name: "Rotinas do turno", metricCode: "TASK_COMPLETED", filters: { from: "2026-10-12T11:00:00.000Z", to: "2026-10-13T11:00:00.000Z", departmentCode: "INPATIENT" }, format: "JSONL", sharedDepartmentCode: "INPATIENT" });
  await waitFor(() => expect(screen.queryByRole("form")).not.toBeInTheDocument());
});

it("edits the captured definition version, can remove sharing and deactivate it, and preserves unsaved text on conflict", async () => {
  const read = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => { if (init?.method) throw new ApiClientError(409, { error: { code: "STALE_VERSION" } }); return read(path, init); });
  render(<HospitalReportView />);
  fireEvent.click(await screen.findByRole("button", { name: "Editar definição" }));
  const form = screen.getByRole("form", { name: "Definir relatório hospitalar" });
  fireEvent.change(within(form).getByLabelText("Nome do relatório"), { target: { value: "Minha revisão não salva" } });
  fireEvent.change(within(form).getByLabelText("Compartilhar definição com setor"), { target: { value: "" } });
  fireEvent.change(within(form).getByLabelText("Setor do relatório"), { target: { value: "" } });
  fireEvent.click(within(form).getByLabelText("Definição ativa"));
  fireEvent.submit(form);
  await screen.findByRole("alert");
  expect(JSON.parse(writes()[0][1]!.body as string)).toMatchObject({ name: "Minha revisão não salva", active: false, sharedDepartmentCode: null, expectedVersion: 4, filters: { from: filters.from, to: filters.to } });
  expect(within(form).getByLabelText("Nome do relatório")).toHaveValue("Minha revisão não salva");
  fireEvent.click(within(form).getByRole("button", { name: "Fechar definição" }));
  expect(screen.queryByRole("form")).not.toBeInTheDocument();
});

it("enqueues the current report version and explicitly retries a failed job using its own version", async () => {
  jobs = [job("FAILED")]; const read = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => init?.method ? job("SUCCEEDED") as never : read(path, init));
  const changed = vi.fn(); window.addEventListener("cvg:realtime-updated", changed);
  try {
    render(<HospitalReportView />);
    fireEvent.click(await screen.findByRole("button", { name: "Enfileirar CSV" }));
    await screen.findByText(/Exportação enfileirada/);
    expect(JSON.parse(writes()[0][1]!.body as string)).toEqual({ reportId: "report-one", expectedReportVersion: 4 });
    expect(changed).toHaveBeenCalledOnce();
    fireEvent.click(await screen.findByRole("button", { name: "Reenfileirar exportação com falha" }));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1][0]).toBe("/hospital-report-jobs/job-one/retry");
    expect(JSON.parse(writes()[1][1]!.body as string)).toEqual({ expectedVersion: 3 });
  } finally { window.removeEventListener("cvg:realtime-updated", changed); }
});

it("downloads the authorized artifact, sanitizes the file name and releases the blob URL", async () => {
  jobs = [job("SUCCEEDED")]; const read = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => path.endsWith("/download") ? { jobId: "job-one", name: "../relatorio.csv", content: "id,label\r\n1,atividade\r\n", contentType: "text/csv", format: "CSV", rowCount: 1, generatedAt: filters.to, definition: jobs[0].job.definitionSnapshot } as never : read(path, init));
  const create = vi.fn((_blob: Blob) => "blob:authorized-report"); const revoke = vi.fn();
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: create }); Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revoke });
  let fileName = ""; vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { fileName = this.download; });
  render(<HospitalReportView />);
  fireEvent.click(await screen.findByRole("button", { name: "Baixar CSV" }));
  await waitFor(() => expect(create).toHaveBeenCalledOnce());
  expect(create.mock.calls[0][0]).toBeInstanceOf(Blob);
  expect(fileName).toBe(".._relatorio.csv");
  await waitFor(() => expect(revoke).toHaveBeenCalledWith("blob:authorized-report"));
  expect(document.querySelector('a[href="blob:authorized-report"]')).toBeNull();
});

it("keeps a rejected download unavailable and lets the owner refresh job state before trying again", async () => {
  jobs = [job("SUCCEEDED")]; const read = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => { if (path.endsWith("/download")) throw new ApiClientError(404, { error: { code: "SCOPE_DENIED" } }); return read(path, init); });
  render(<HospitalReportView />);
  fireEvent.click(await screen.findByRole("button", { name: "Baixar CSV" }));
  await screen.findByRole("alert");
  jobs = [];
  fireEvent.click(screen.getByRole("button", { name: "Atualizar exportações" }));
  await screen.findByText("Nenhuma exportação autorizada.");
  expect(screen.queryByRole("button", { name: "Baixar CSV" })).not.toBeInTheDocument();
});

it("does not expose an open private editor after another authorized account replaces the session", async () => {
  render(<HospitalReportView />);
  fireEvent.click(await screen.findByRole("button", { name: "Editar definição" }));
  expect(screen.getByLabelText("Nome do relatório")).toHaveValue(definition.name);
  user = { ...user, id: "another-report-owner" }; reports = [];
  act(() => window.dispatchEvent(new Event("cvg:realtime-resync")));
  await screen.findByText("Nenhuma definição autorizada.");
  expect(screen.queryByRole("form", { name: "Definir relatório hospitalar" })).not.toBeInTheDocument();
  expect(screen.queryByDisplayValue(definition.name)).not.toBeInTheDocument();
});

it("withdraws an open definition editor when the report leaves the current authorized list", async () => {
  render(<HospitalReportView />);
  fireEvent.click(await screen.findByRole("button", { name: "Editar definição" }));
  reports = [];
  act(() => window.dispatchEvent(new Event("cvg:realtime-updated")));
  await screen.findByText("Nenhuma definição autorizada.");
  expect(screen.queryByRole("form", { name: "Definir relatório hospitalar" })).not.toBeInTheDocument();
});

it("allows reading shared definitions without offering mutations or private export jobs", async () => {
  user = { ...user, permissions: ["hospital_report.view"] };
  reports = [{ ...definition, ownerId: "another-owner", active: false }];
  render(<HospitalReportView />);
  await screen.findByRole("heading", { name: definition.name });
  expect(screen.getByText(/Inativo/)).toBeInTheDocument();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path === "/hospital-report-jobs")).toBe(false);
});
