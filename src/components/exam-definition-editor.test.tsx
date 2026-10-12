/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiagnosticService, ExamDefinitionVersion } from "@cvg/contracts";
import { ExamDefinitionEditor } from "./exam-definition-editor";
import * as apiClient from "./api-client";

const service: DiagnosticService = { id: "synthetic-service", code: "FIXTURE", name: "Exame sintético", category: "LABORATORY", departmentCode: "LAB", workflowType: "LABORATORY", requiresSample: true, requiresSchedule: false, allowsAttachment: false, active: true, version: 4, slaHours: { ROUTINE: 8, URGENT: 4, EMERGENCY: 2 }, resultSchema: "NUMERIC_PANEL", resultTemplate: { kind: "LABORATORY_PANEL", code: "FIXTURE", name: "Painel sintético", schemaVersion: "1", version: 2, status: "DRAFT", analytes: [{ code: "VALUE", label: "Analito sintético", valueType: "NUMERIC", unitCode: "fixture/unit", required: true, displayOrder: 1, referenceRange: { kind: "NUMERIC", unitCode: "fixture/unit", low: 1, high: 10, source: "PENDING_HUMAN_POLICY" } }] } };
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe("exam definition administration", () => {
  it("lets technical administrators prepare a draft without offering clinical publication", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    vi.spyOn(apiClient, "apiFetch").mockImplementation((path, init) => { calls.push([path, init]); return Promise.resolve(init ? service : []) as never; });
    const saved = vi.fn();
    render(<ExamDefinitionEditor service={service} permissions={["service.catalog.manage", "service.catalog.view"]} onSaved={saved} />);
    fireEvent.click(screen.getByRole("button", { name: /Definição, faixas e histórico/ }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(screen.queryByRole("button", { name: "Aprovar e publicar painel" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Limite superior 1"), { target: { value: "12" } });
    fireEvent.submit(screen.getByRole("form", { name: /Preparar definição/ }));
    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    const command = calls.find(([path, init]) => path.endsWith("/template") && init?.method === "PUT")!;
    const body = JSON.parse(command[1]!.body as string);
    expect(body).toMatchObject({ expectedVersion: 4, template: { analytes: [{ referenceRange: { high: 12, source: "PENDING_HUMAN_POLICY" } }] } });
    expect(body.template).not.toHaveProperty("approval"); expect(body.template).not.toHaveProperty("status");
  });
  it("requires explicit clinical confirmation and sends population without claimed approval identity", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    vi.spyOn(apiClient, "apiFetch").mockImplementation((path, init) => { calls.push([path, init]); return Promise.resolve(init ? service : []) as never; });
    render(<ExamDefinitionEditor service={service} permissions={["exam_definition.approve", "service.catalog.view"]} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Definição, faixas e histórico/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Aprovar e publicar painel" })).toBeDisabled());
    expect(screen.queryByRole("form", { name: /Preparar definição/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Referência da política clínica"), { target: { value: "SYNTHETIC_TEST_ONLY" } });
    fireEvent.change(screen.getByLabelText("Espécies atendidas"), { target: { value: "Canino, Felino" } });
    fireEvent.click(screen.getByLabelText("Confirmo a configuração clínica e a população atendida"));
    fireEvent.submit(screen.getByRole("form", { name: /Aprovar definição/ }));
    await waitFor(() => expect(calls.some(([path]) => path.endsWith("/publish"))).toBe(true));
    const body = JSON.parse(calls.find(([path]) => path.endsWith("/publish"))![1]!.body as string);
    expect(body).toEqual({ expectedVersion: 4, confirm: true, policyReference: "SYNTHETIC_TEST_ONLY", population: { species: ["Canino", "Felino"] } });
  });
  it("shows immutable historical analytes instead of replacing the current editing form", async () => {
    const revision = { id: "revision-1", serviceVersion: 1, serviceId: service.id, status: "ACTIVE", recordedAt: "2026-10-01T12:00:00Z", recordedBy: "clinical-test", provenance: "CATALOG_OBSERVATION", definition: { ...service, name: "Nome anterior", resultTemplate: { ...service.resultTemplate!, analytes: [{ ...service.resultTemplate!.analytes[0], label: "Analito anterior", referenceRange: { ...service.resultTemplate!.analytes[0].referenceRange!, low: 2, high: 3 } }] } } } as ExamDefinitionVersion;
    vi.spyOn(apiClient, "apiFetch").mockResolvedValue([revision] as never);
    render(<ExamDefinitionEditor service={service} permissions={["service.catalog.view"]} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Definição, faixas e histórico/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Abrir definição 1" }));
    const history = screen.getByRole("region", { name: "Definição conservada 1" });
    expect(within(history).getByText("Analito anterior")).toBeInTheDocument();
    expect(within(history).getByText("2 a 3")).toBeInTheDocument();
    expect(within(history).getByText(/Somente leitura/)).toBeInTheDocument();
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
  });

  it("prepares a new panel with independent numeric, qualitative and optional text analytes without inventing ranges", async () => {
    const mock = vi.spyOn(apiClient, "apiFetch").mockResolvedValue([] as never); const saved = vi.fn();
    render(<ExamDefinitionEditor service={{ ...service, resultTemplate: undefined }} permissions={["service.catalog.update"]} onSaved={saved} />);
    fireEvent.click(screen.getByRole("button", { name: /Definição, faixas e histórico/ })); await screen.findByText(/Sem painel configurado/);
    await waitFor(() => expect(screen.getByRole("button", { name: "Salvar rascunho do painel" })).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Nome do painel"), { target: { value: "  Painel editado  " } }); fireEvent.change(screen.getByLabelText("Código do painel"), { target: { value: "  panel_code  " } });
    fireEvent.change(screen.getByLabelText("Código do analito 1"), { target: { value: " number " } }); fireEvent.change(screen.getByLabelText("Nome do analito 1"), { target: { value: " Número sem faixa " } }); fireEvent.change(screen.getByLabelText("Unidade do analito 1"), { target: { value: " unit/test " } });
    fireEvent.click(screen.getByRole("button", { name: "Adicionar analito" })); fireEvent.change(screen.getByLabelText("Código do analito 2"), { target: { value: " qual " } }); fireEvent.change(screen.getByLabelText("Nome do analito 2"), { target: { value: " Qualitativo " } }); fireEvent.change(screen.getByLabelText("Unidade do analito 2"), { target: { value: " status " } }); fireEvent.change(screen.getByLabelText("Tipo do valor 2"), { target: { value: "QUALITATIVE" } }); fireEvent.change(screen.getByLabelText("Valores permitidos 2"), { target: { value: " positivo, negativo, positivo, , " } }); fireEvent.click(screen.getByLabelText("Analito 2 obrigatório"));
    fireEvent.click(screen.getByRole("button", { name: "Adicionar analito" })); fireEvent.change(screen.getByLabelText("Tipo do valor 3"), { target: { value: "TEXT" } }); fireEvent.change(screen.getByLabelText("Código do analito 3"), { target: { value: " discarded " } }); fireEvent.click(screen.getByRole("button", { name: "Remover analito 3" }));
    expect(screen.queryByLabelText("Código do analito 3")).not.toBeInTheDocument(); fireEvent.submit(screen.getByRole("form", { name: /Preparar definição/ })); await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    const body = JSON.parse(mock.mock.calls.find(([, init]) => init?.method === "PUT")![1]!.body as string);
    expect(body).toEqual({ expectedVersion: 4, template: { code: "PANEL_CODE", name: "Painel editado", schemaVersion: "1.0", analytes: [{ code: "NUMBER", label: "Número sem faixa", valueType: "NUMERIC", unitCode: "unit/test", required: true, displayOrder: 1, referenceRange: { kind: "PENDING_POLICY", unitCode: "unit/test", source: "PENDING_HUMAN_POLICY" } }, { code: "QUAL", label: "Qualitativo", valueType: "QUALITATIVE", unitCode: "status", required: false, displayOrder: 2, allowedValues: ["positivo", "negativo"] }] } });
  });

  it("captures one-sided reference limits and a complete publication population with explicit confirmation", async () => {
    const mock = vi.spyOn(apiClient, "apiFetch").mockResolvedValue([] as never); render(<ExamDefinitionEditor service={service} permissions={["service.catalog.update", "exam_definition.approve"]} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Definição, faixas e histórico/ })); await waitFor(() => expect(screen.getByRole("button", { name: "Salvar rascunho do painel" })).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Limite inferior 1"), { target: { value: "0" } }); fireEvent.change(screen.getByLabelText("Limite superior 1"), { target: { value: "" } }); fireEvent.submit(screen.getByRole("form", { name: /Preparar definição/ })); await screen.findByText(/Rascunho preparado/);
    expect(JSON.parse(mock.mock.calls.find(([, init]) => init?.method === "PUT")![1]!.body as string).template.analytes[0].referenceRange).toEqual({ kind: "NUMERIC", unitCode: "fixture/unit", source: "PENDING_HUMAN_POLICY", low: 0 });
    fireEvent.change(screen.getByLabelText("Referência da política clínica"), { target: { value: " TEST_POLICY " } }); fireEvent.change(screen.getByLabelText("Espécies atendidas"), { target: { value: " Canino, Felino, Canino " } }); fireEvent.change(screen.getByLabelText("Sexos atendidos (vazio para todos)"), { target: { value: " Fêmea, Macho, Fêmea " } }); fireEvent.change(screen.getByLabelText("Idade mínima em dias"), { target: { value: "0" } }); fireEvent.change(screen.getByLabelText("Idade máxima em dias"), { target: { value: "365" } }); fireEvent.click(screen.getByLabelText("Confirmo a configuração clínica e a população atendida")); fireEvent.submit(screen.getByRole("form", { name: /Aprovar definição/ })); await screen.findByText(/Publicação registrada/);
    expect(JSON.parse(mock.mock.calls.find(([path]) => path.endsWith("/publish"))![1]!.body as string)).toEqual({ expectedVersion: 4, policyReference: "TEST_POLICY", population: { species: ["Canino", "Felino"], sex: ["Fêmea", "Macho"], minAgeDays: 0, maxAgeDays: 365 }, confirm: true });
  });

  it("retires only a published panel with contextual reason and the catalog revision", async () => {
    const mock = vi.spyOn(apiClient, "apiFetch").mockResolvedValue([] as never); const saved = vi.fn(); render(<ExamDefinitionEditor service={{ ...service, resultTemplate: { ...service.resultTemplate!, status: "ACTIVE" } }} permissions={["service.catalog.update"]} onSaved={saved} />);
    fireEvent.click(screen.getByRole("button", { name: /Definição, faixas e histórico/ })); const retire = await screen.findByRole("button", { name: "Retirar painel de novos pedidos" }); expect(retire).toBeDisabled(); expect(screen.queryByRole("form", { name: /Aprovar definição/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Motivo da retirada"), { target: { value: "  Política clínica substituída  " } }); await waitFor(() => expect(retire).toBeEnabled()); fireEvent.submit(screen.getByRole("form", { name: /Retirar definição/ })); await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    expect(mock).toHaveBeenCalledWith(`/diagnostic-services/${service.id}/template/retire`, { method: "POST", body: JSON.stringify({ reason: "Política clínica substituída", expectedVersion: 4 }) }); expect(screen.getByRole("status")).toHaveTextContent("registros existentes preservados");
  });

  it("retains an edited definition on version conflict and prevents a second command while one is pending", async () => {
    let reject = true; let complete: (() => void) | undefined; const mock = vi.spyOn(apiClient, "apiFetch").mockImplementation(async <T,>(path: string, init?: RequestInit) => { if (!init) return [] as T; if (reject) throw new apiClient.ApiClientError(409, { error: { code: "STALE_VERSION" } }); await new Promise<void>((resolve) => { complete = resolve; }); return service as T; }); const saved = vi.fn(); render(<ExamDefinitionEditor service={service} permissions={["service.catalog.manage"]} onSaved={saved} />);
    fireEvent.click(screen.getByRole("button", { name: /Definição, faixas e histórico/ })); await waitFor(() => expect(screen.getByRole("button", { name: "Salvar rascunho do painel" })).toBeEnabled()); fireEvent.change(screen.getByLabelText("Nome do painel"), { target: { value: "Edição preservada" } }); const form = screen.getByRole("form", { name: /Preparar definição/ }); fireEvent.submit(form); await screen.findByRole("alert"); expect(saved).not.toHaveBeenCalled(); expect(screen.getByLabelText("Nome do painel")).toHaveValue("Edição preservada");
    reject = false; fireEvent.submit(form); expect(screen.getByRole("button", { name: "Salvar rascunho do painel" })).toBeDisabled(); fireEvent.submit(form); expect(mock.mock.calls.filter(([, init]) => init?.method)).toHaveLength(2); await act(async () => { complete!(); }); expect(saved).toHaveBeenCalledOnce();
  });

  it("reports a safe history failure, can close and reopen, and exposes no editor after grants are revoked", async () => {
    let denied = true; const mock = vi.spyOn(apiClient, "apiFetch").mockImplementation(async <T,>() => { if (denied) throw new Error("private database detail"); return [] as T; }); const saved = vi.fn(); const view = render(<ExamDefinitionEditor service={service} permissions={["service.catalog.view"]} onSaved={saved} />); const toggle = screen.getByRole("button", { name: /Definição, faixas e histórico/ });
    fireEvent.click(toggle); expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível consultar as revisões do exame."); expect(screen.queryByText(/private database/)).not.toBeInTheDocument(); fireEvent.click(toggle); expect(toggle).toHaveAttribute("aria-expanded", "false"); expect(mock).toHaveBeenCalledOnce();
    denied = false; fireEvent.click(toggle); await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument()); expect(screen.queryByRole("form")).not.toBeInTheDocument(); view.rerender(<ExamDefinitionEditor service={service} permissions={[]} onSaved={saved} />); expect(screen.queryByRole("button")).not.toBeInTheDocument(); expect(mock).toHaveBeenCalledTimes(2);
  });

  it("shows observed qualitative history and server-recorded approval without substituting the current panel", async () => {
    const revision: ExamDefinitionVersion = { id: "published", serviceId: service.id, serviceVersion: 2, status: "RETIRED", recordedAt: "2026-10-11T12:00:00Z", recordedBy: "clinical", provenance: "CATALOG_WRITE", definition: { ...service, resultTemplate: { ...service.resultTemplate!, status: "RETIRED", approval: { approvedBy: "clinical-approver", approvedAt: "2026-10-01T12:00:00Z", policyReference: "SYNTHETIC_POLICY", population: { species: ["Canino"] } }, analytes: [{ code: "QUALITY", label: "Descrição histórica", valueType: "QUALITATIVE", unitCode: "status", required: false, displayOrder: 1, allowedValues: ["normal"] }, { code: "OPEN_RANGE", label: "Faixa unilateral histórica", valueType: "NUMERIC", unitCode: "test", required: true, displayOrder: 2, referenceRange: { kind: "NUMERIC", unitCode: "test", source: "PENDING_HUMAN_POLICY" } }] } } };
    vi.spyOn(apiClient, "apiFetch").mockResolvedValue([revision] as never); render(<ExamDefinitionEditor service={service} permissions={["service.catalog.view"]} onSaved={vi.fn()} />); fireEvent.click(screen.getByRole("button", { name: /Definição, faixas e histórico/ })); fireEvent.click(await screen.findByRole("button", { name: "Abrir definição 2" })); const history = screen.getByRole("region", { name: "Definição conservada 2" }); expect(history).toHaveTextContent("SYNTHETIC_POLICY"); expect(history).toHaveTextContent("clinical-approver"); expect(history).toHaveTextContent("Pendente"); expect(history).toHaveTextContent("— a —"); expect(history).toHaveTextContent("Não"); expect(screen.getByText(/Estado atual/)).toHaveTextContent("Rascunho");
  });

  it("does not offer laboratory panel controls for an imaging service", () => {
    const mock = vi.spyOn(apiClient, "apiFetch"); render(<ExamDefinitionEditor service={{ ...service, workflowType: "RADIOLOGY" }} permissions={["service.catalog.manage", "exam_definition.approve"]} onSaved={vi.fn()} />); expect(screen.queryByRole("button")).not.toBeInTheDocument(); expect(mock).not.toHaveBeenCalled();
  });
});
