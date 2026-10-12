/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Permission } from "@cvg/contracts";
import { PlannerTaskForm } from "./planner-task-form";
import * as api from "./api-client";
import { checklistTemplate, uiPage } from "./hospital-ui.test-helpers";
import { careType, plannerUser, routineType, taskView } from "./planner.test-helpers";

vi.mock("next/link", () => ({ default: ({ children, ...props }: { children: React.ReactNode; href: string }) => <a {...props}>{children}</a> }));
vi.mock("./api-client", async (original) => ({ ...await original<typeof import("./api-client")>(), apiFetch: vi.fn() }));
const permissions: Permission[] = [...plannerUser.permissions!, "service.catalog.view", "checklist_template.view", "hospital_document.view"];
const user = { ...plannerUser, permissions };
const departments = [{ code: "INPATIENT", name: "Internação", active: true }, { code: "SUPPORT", name: "Apoio", active: true }];
const patient = { id: "patient", displayName: "Paciente autorizado", externalId: "HIS-7", ownerLabel: "Tutor", species: "Canino" };
const service = { id: "service", code: "CARE", source: "HOSPITAL_SERVICE", name: "Cuidado real", departmentCode: "INPATIENT", active: true };
beforeEach(() => { vi.mocked(api.apiFetch).mockImplementation(async (path, init) => {
  if (init?.method) return taskView() as never;
  if (path.startsWith("/hospital-services?")) return uiPage([service]) as never;
  if (path.startsWith("/hospital-checklist-templates?")) return uiPage([checklistTemplate()]) as never;
  if (path.startsWith("/hospital-documents?")) return uiPage([{ id: "protocol", title: "Protocolo aprovado", currentRevision: 3, currentStatus: "APPROVED", archived: false }]) as never;
  if (path.startsWith("/patients?") || path === "/patients") return [patient] as never;
  if (path === "/patients/patient/encounters") return [{ id: "encounter", externalId: "AT-7", status: "OPEN", type: "INPATIENT" }] as never;
  throw new Error(`Unexpected synthetic ${path}`);
}); });
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllEnvs(); });
const writes = () => vi.mocked(api.apiFetch).mock.calls.filter(([, init]) => init?.method);
function form(props: Partial<React.ComponentProps<typeof PlannerTaskForm>> = {}) { const created = vi.fn(); const close = vi.fn(); render(<PlannerTaskForm user={user} types={[routineType, careType]} departments={departments} onCreated={created} onClose={close} {...props} />); return { created, close }; }
function title() { fireEvent.change(screen.getByLabelText("Título da atividade"), { target: { value: "  Cuidado do turno  " } }); }
async function selectContext() { await screen.findByRole("option", { name: /Paciente autorizado/ }); fireEvent.change(screen.getByLabelText("Paciente"), { target: { value: "patient" } }); await screen.findByRole("option", { name: "AT-7 · Internação" }); fireEvent.change(screen.getByLabelText("Atendimento"), { target: { value: "encounter" } }); }

it("creates a real care task with authorized context, service, approved checklist and frozen protocol references", async () => {
  const created = vi.fn(); form({ parentTaskId: "parent", onCreated: created }); title(); fireEvent.change(screen.getByRole("combobox", { name: /^Tipo de atividade/ }), { target: { value: careType.id } });
  await screen.findByRole("option", { name: "Cuidado real" }); fireEvent.change(screen.getByRole("combobox", { name: /^Serviço hospitalar/ }), { target: { value: "service" } }); await screen.findByRole("option", { name: /Cuidado aprovado/ });
  const template = checklistTemplate(); fireEvent.change(screen.getByRole("combobox", { name: /^Checklist aprovado/ }), { target: { value: template.template.id } }); await selectContext();
  fireEvent.click(await screen.findByLabelText("Protocolo aprovado · revisão 3")); fireEvent.change(screen.getByLabelText("Descrição", { exact: true }), { target: { value: "  Texto operacional  " } }); fireEvent.change(screen.getByRole("combobox", { name: /^Prioridade$/ }), { target: { value: "URGENT" } });
  fireEvent.change(screen.getByLabelText("Início planejado"), { target: { value: "2026-10-11T09:00" } }); fireEvent.change(screen.getByLabelText("Fim planejado"), { target: { value: "2026-10-11T10:00" } }); fireEvent.submit(screen.getByRole("form", { name: "Criar atividade hospitalar" }));
  await waitFor(() => expect(created).toHaveBeenCalledOnce()); expect(JSON.parse(writes()[0][1]!.body as string)).toEqual({ title: "Cuidado do turno", description: "Texto operacional", typeId: careType.id, departmentCode: "INPATIENT", priority: "URGENT", patientId: "patient", encounterId: "encounter", documentIds: ["protocol"], serviceId: "service", checklistTemplateId: template.template.id, plannedStartAt: "2026-10-11T12:00:00.000Z", plannedEndAt: "2026-10-11T13:00:00.000Z", parentTaskId: "parent" });
});

it("requires both patient and open encounter for an assistential type and retains the draft when validation fails", async () => {
  form(); title(); fireEvent.change(screen.getByRole("combobox", { name: /^Tipo de atividade/ }), { target: { value: careType.id } }); fireEvent.submit(screen.getByRole("form", { name: "Criar atividade hospitalar" })); expect(screen.getByRole("alert")).toHaveTextContent("Uma atividade assistencial exige paciente e atendimento aberto."); expect(writes()).toHaveLength(0);
  await screen.findByRole("option", { name: /Paciente autorizado/ }); fireEvent.change(screen.getByLabelText("Paciente"), { target: { value: "patient" } }); await screen.findByRole("option", { name: "AT-7 · Internação" }); fireEvent.submit(screen.getByRole("form", { name: "Criar atividade hospitalar" })); expect(writes()).toHaveLength(0); expect(screen.getByLabelText("Título da atividade")).toHaveValue("  Cuidado do turno  ");
});

it("resets sector-bound catalog choices and protocol selection when the user explicitly changes the activity sector", async () => {
  form(); title(); await screen.findByRole("option", { name: "Cuidado real" }); fireEvent.change(screen.getByRole("combobox", { name: /^Serviço hospitalar/ }), { target: { value: "service" } }); await screen.findByRole("option", { name: /Cuidado aprovado/ }); fireEvent.change(screen.getByRole("combobox", { name: /^Checklist aprovado/ }), { target: { value: checklistTemplate().template.id } }); fireEvent.click(await screen.findByLabelText("Protocolo aprovado · revisão 3"));
  fireEvent.change(screen.getByRole("combobox", { name: /^Setor da atividade/ }), { target: { value: "SUPPORT" } }); expect(screen.getByRole("combobox", { name: /^Serviço hospitalar/ })).toHaveValue(""); expect(screen.getByRole("combobox", { name: /^Checklist aprovado/ })).toHaveValue(""); await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith(expect.stringContaining("departmentCode=SUPPORT")));
  fireEvent.submit(screen.getByRole("form", { name: "Criar atividade hospitalar" })); await waitFor(() => expect(writes()).toHaveLength(1)); const body = JSON.parse(writes()[0][1]!.body as string); expect(body).toMatchObject({ departmentCode: "SUPPORT" }); for (const key of ["documentIds", "serviceId", "checklistTemplateId"]) expect(body).not.toHaveProperty(key);
});

it("loads further authorized catalog choices without offering the diagnostic projection or inactive service as a new task", async () => {
  const original = vi.mocked(api.apiFetch).getMockImplementation()!;
  vi.mocked(api.apiFetch).mockImplementation(async (path, init) => {
    if (path.startsWith("/hospital-services?")) return uiPage(path.includes("cursor=") ? [service] : [{ ...service, id: "projection", name: "Exame projetado", source: "DIAGNOSTIC_SERVICE" }, { ...service, id: "inactive", name: "Serviço inativo", active: false }], path.includes("cursor=") ? undefined : "next") as never;
    if (path.startsWith("/hospital-checklist-templates?")) return uiPage(path.includes("cursor=") ? [checklistTemplate()] : [], path.includes("cursor=") ? undefined : "next") as never;
    return original(path, init);
  }); form(); expect(await screen.findByRole("button", { name: "Mais serviços deste setor" })).toBeEnabled(); expect(screen.queryByRole("option", { name: "Exame projetado" })).not.toBeInTheDocument(); expect(screen.queryByRole("option", { name: "Serviço inativo" })).not.toBeInTheDocument(); fireEvent.click(screen.getByRole("button", { name: "Mais serviços deste setor" })); await screen.findByRole("option", { name: "Cuidado real" }); fireEvent.click(await screen.findByRole("button", { name: "Mais modelos deste setor" })); await screen.findByRole("option", { name: /Cuidado aprovado/ });
});

it("refuses reversed planning dates and nonexistent hospital times without sending a disguised reservation", () => {
  form({ user: { ...user, permissions: ["hospital_task.create"] } }); title(); fireEvent.change(screen.getByLabelText("Início planejado"), { target: { value: "2026-10-11T10:00" } }); fireEvent.change(screen.getByLabelText("Fim planejado"), { target: { value: "2026-10-11T09:00" } }); fireEvent.submit(screen.getByRole("form", { name: "Criar atividade hospitalar" })); expect(screen.getByRole("alert")).toHaveTextContent("O fim planejado não pode anteceder o início."); expect(writes()).toHaveLength(0);
  vi.stubEnv("NEXT_PUBLIC_HOSPITAL_TIMEZONE", "America/New_York"); fireEvent.change(screen.getByLabelText("Início planejado"), { target: { value: "2026-03-08T02:30" } }); fireEvent.submit(screen.getByRole("form", { name: "Criar atividade hospitalar" })); expect(screen.getByRole("alert")).toHaveTextContent("Este horário não existe no fuso do hospital"); expect(writes()).toHaveLength(0);
});

it("preserves ambiguous creation intent, blocks repeat submission while pending and starts a new key only for changed content", async () => {
  let resolve!: (value: unknown) => void; let reject = true;
  const original = vi.mocked(api.apiFetch).getMockImplementation()!; vi.mocked(api.apiFetch).mockImplementation(async (path, init) => { if (!init?.method) return original(path, init); if (reject) throw new Error("private offline"); return new Promise<unknown>((done) => { resolve = done; }) as never; });
  const created = vi.fn(); form({ user: { ...user, permissions: ["hospital_task.create"] }, onCreated: created }); title(); const element = screen.getByRole("form", { name: "Criar atividade hospitalar" }); fireEvent.submit(element); await screen.findByRole("alert"); const firstHeaders = writes()[0][1]!.headers;
  reject = false; fireEvent.submit(element); fireEvent.submit(element); expect(writes()).toHaveLength(2); expect(writes()[1][1]!.headers).toEqual(firstHeaders); await act(async () => resolve(taskView())); expect(created).toHaveBeenCalledOnce();
  fireEvent.change(screen.getByLabelText("Título da atividade"), { target: { value: "Outra intenção explícita" } }); fireEvent.submit(element); expect(writes()).toHaveLength(3); expect(writes()[2][1]!.headers).not.toEqual(firstHeaders); await act(async () => resolve(taskView())); expect(created).toHaveBeenCalledTimes(2);
});

it("keeps missing metadata choices explicit and closes the dialog only through cancel, close or its own backdrop", () => {
  const { close } = form({ user: { ...user, departmentCode: "EXISTING", permissions: ["hospital_task.create"] }, types: [], departments: [] }); title(); expect(screen.getByRole("option", { name: "EXISTING" })).toBeInTheDocument(); fireEvent.submit(screen.getByRole("form", { name: "Criar atividade hospitalar" })); expect(screen.getByRole("alert")).toHaveTextContent("Informe título, tipo e setor válidos."); expect(writes()).toHaveLength(0);
  fireEvent.mouseDown(screen.getByRole("dialog")); expect(close).not.toHaveBeenCalled(); fireEvent.mouseDown(screen.getByRole("dialog").parentElement!); expect(close).toHaveBeenCalledTimes(1); fireEvent.click(screen.getByRole("button", { name: "Cancelar" })); fireEvent.click(screen.getByRole("button", { name: "Fechar" })); expect(close).toHaveBeenCalledTimes(3);
});

it("does not send creation without an effective grant even if a stale form is submitted programmatically", () => {
  form({ user: { ...user, permissions: [] } }); title(); fireEvent.submit(screen.getByRole("form", { name: "Criar atividade hospitalar" })); expect(api.apiFetch).not.toHaveBeenCalled(); expect(screen.queryByRole("combobox", { name: /^Serviço hospitalar/ })).not.toBeInTheDocument();
});

it.each(["service", "template"])("refuses a previously selected %s after its authorized catalog refresh fails", async (kind) => {
  let denied = false; const original = vi.mocked(api.apiFetch).getMockImplementation()!;
  vi.mocked(api.apiFetch).mockImplementation(async (path, init) => { if (denied && path.startsWith(kind === "service" ? "/hospital-services?" : "/hospital-checklist-templates?")) throw new api.ApiClientError(503, {}); return original(path, init); });
  form(); title();
  if (kind === "service") { await screen.findByRole("option", { name: "Cuidado real" }); fireEvent.change(screen.getByRole("combobox", { name: /^Serviço hospitalar/ }), { target: { value: "service" } }); }
  else { await screen.findByRole("option", { name: /Cuidado aprovado/ }); fireEvent.change(screen.getByRole("combobox", { name: /^Checklist aprovado/ }), { target: { value: checklistTemplate().template.id } }); await selectContext(); }
  denied = true; act(() => window.dispatchEvent(new Event("cvg:realtime-updated"))); await screen.findByRole("alert"); fireEvent.submit(screen.getByRole("form", { name: "Criar atividade hospitalar" }));
  expect(screen.getAllByRole("alert").some((alert) => alert.textContent?.includes("Atualize e escolha um serviço ativo e um modelo aprovado"))).toBe(true); expect(writes()).toHaveLength(0);
});
