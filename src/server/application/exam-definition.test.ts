import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { createApplicationService } from "./service";
import { recordExamDefinition } from "./exam-definition";
import { assertApprovedLaboratoryReferences } from "./laboratory-reference-policy";
import type { ExamDefinitionSnapshot, LaboratoryPanelTemplate } from "@cvg/contracts";

const fixtureTemplate = { code: "FIXTURE_PANEL", name: "Painel sintético de regressão", schemaVersion: "1", analytes: [{ code: "VALUE", label: "Analito sintético", valueType: "NUMERIC" as const, unitCode: "fixture/unit", required: true, displayOrder: 1, referenceRange: { kind: "NUMERIC" as const, unitCode: "fixture/unit", low: 1, high: 10, source: "PENDING_HUMAN_POLICY" as const } }] };
async function setup() {
  const store = new MemoryStore(createDemoState("definition-test-password"));
  const service = createApplicationService(store);
  const user = (email: string) => store.getState().users.find((entry) => entry.email === email)!;
  return { store, service, user };
}
async function published() {
  const c = await setup();
  const prepared = await c.service.prepareExamTemplate(c.user("admin@cvg.local"), "service-hemogram", { expectedVersion: 1, template: fixtureTemplate, idempotencyKey: "prepare-fixture" });
  const saved = await c.service.publishExamTemplate(c.user("vet@cvg.local"), prepared.id, { expectedVersion: prepared.version, policyReference: "SYNTHETIC_TEST_ONLY_NO_CLINICAL_APPROVAL", population: { species: ["Canino"] }, confirm: true, idempotencyKey: "publish-fixture" });
  return { ...c, saved };
}
async function released() {
  const c = await published();
  const vet = c.user("vet@cvg.local"); const lab = c.user("lab@cvg.local");
  const request = await c.service.createRequest(vet, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: c.saved.id }] }, { idempotencyKey: "frozen-request" });
  const receipt = await c.service.receiveSample(lab, [request.items[0].id], { sampleType: "FIXTURE", expectedVersion: 1, idempotencyKey: "frozen-receive" });
  const started = await c.service.startProcessing(lab, receipt.items[0].id, { expectedVersion: receipt.items[0].version, idempotencyKey: "frozen-start" });
  const draft = await c.service.createResultDraft(lab, started.item.id, { expectedVersion: started.item.version, narrative: "Synthetic regression only", content: { kind: "LABORATORY_STRUCTURED", panelCode: fixtureTemplate.code, panelVersion: c.saved.resultTemplate!.version, observations: [{ analyteCode: "VALUE", value: 5, unitCode: "fixture/unit" }] }, idempotencyKey: "frozen-draft" });
  const result = await c.service.releaseResult(lab, draft.result.id, { expectedVersion: draft.result.version, idempotencyKey: "frozen-release" });
  return { ...c, request, result };
}
afterEach(() => vi.unstubAllEnvs());

describe("immutable exam definitions", () => {
  it("requires clinical publication, rejects technical approval and does not trust claimed approver metadata", async () => {
    const c = await setup();
    const admin = c.user("admin@cvg.local");
    const prepared = await c.service.prepareExamTemplate(admin, "service-hemogram", { expectedVersion: 1, template: fixtureTemplate, idempotencyKey: "prepare" });
    expect(prepared.resultTemplate).toMatchObject({ status: "DRAFT", version: 2 });
    await expect(c.service.createRequest(c.user("vet@cvg.local"), { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: prepared.id }] }, { idempotencyKey: "unpublished" })).rejects.toMatchObject({ code: "EXAM_DEFINITION_NOT_PUBLISHED" });
    const before = await c.store.readStateSnapshot();
    await expect(c.service.publishExamTemplate(admin, prepared.id, { expectedVersion: prepared.version, policyReference: "fixture", population: { species: ["Canino"] }, confirm: true, idempotencyKey: "technical-denied" })).rejects.toMatchObject({ status: 404 });
    await expect(c.service.prepareExamTemplate(admin, prepared.id, { expectedVersion: prepared.version, template: { ...fixtureTemplate, approval: { approvedBy: admin.id } }, idempotencyKey: "spoof-approval" } as never)).rejects.toMatchObject({ status: 400 });
    expect(await c.store.readStateSnapshot()).toEqual(before);
  });
  it("preserves the requested template and released content through later edits and retirement", async () => {
    const c = await released();
    const before = structuredClone(c.result.version);
    const admin = c.user("admin@cvg.local");
    const changed = await c.service.updateDiagnosticService(admin, c.saved.id, { expectedVersion: c.saved.version, name: "Nome futuro", idempotencyKey: "rename" });
    await c.service.retireExamTemplate(admin, c.saved.id, { expectedVersion: changed.version, reason: "Synthetic retirement", idempotencyKey: "retire" });
    const view = await c.service.getResult(c.user("vet@cvg.local"), c.result.result.id);
    expect(view.service.name).toBe("Hemograma");
    expect(view.version).toEqual(before);
    expect(view.definitionProvenance).toBe("REQUEST_CAPTURE");
    expect(view.service.resultTemplate!.analytes[0].referenceRange).toMatchObject({ low: 1, high: 10 });
    expect(c.store.getState().examDefinitions.filter((entry) => entry.serviceId === c.saved.id)).toHaveLength(5);
    await expect(c.service.createRequest(c.user("vet@cvg.local"), { patientId: "patient-mel", encounterId: "encounter-mel", priority: "ROUTINE", items: [{ serviceId: c.saved.id }] }, { idempotencyKey: "retired" })).rejects.toMatchObject({ code: "EXAM_DEFINITION_NOT_PUBLISHED" });
  });
  it("never reconstructs an old version from a later legacy-command capture", async () => {
    const c = await released();
    await c.store.transaction((state) => ({ state: { ...state, items: state.items.map(({ definitionSnapshot: _snapshot, ...item }) => item), resultVersions: state.resultVersions.map(({ definitionSnapshot: _snapshot, ...version }) => version) }, result: undefined }));
    const legacy = await c.service.getResult(c.user("vet@cvg.local"), c.result.result.id);
    expect(legacy.definitionProvenance).toBe("UNKNOWN_LEGACY");
    expect(legacy.service.resultTemplate).toBeUndefined();
    const amended = await c.service.amendResult(c.user("lab@cvg.local"), c.result.result.id, { expectedVersion: c.result.result.version, reason: "Synthetic correction", narrative: "Synthetic corrected", content: legacy.version.content, idempotencyKey: "legacy-amend" });
    expect(amended.version.definitionSnapshot?.provenance).toBe("COMMAND_CAPTURE_LEGACY_REQUEST");
    const historical = await c.service.getResult(c.user("vet@cvg.local"), c.result.result.id, { versionId: legacy.version.id });
    expect(historical.definitionProvenance).toBe("UNKNOWN_LEGACY");
    expect(historical.version.definitionSnapshot).toBeUndefined();
  });
  it("denies reusing a revision identity for different catalog bytes", async () => {
    const c = await published();
    const state = c.store.getState();
    expect(() => recordExamDefinition(state, undefined, { ...c.saved, name: "Alteração sem versão" }, "synthetic", new Date().toISOString(), "corr")).toThrow("não pode ser sobrescrita");
  });
  it("keeps pending commands bound to the request after the live service is changed and deactivated", async () => {
    const c = await published();
    const vet = c.user("vet@cvg.local"); const lab = c.user("lab@cvg.local"); const admin = c.user("admin@cvg.local");
    const request = await c.service.createRequest(vet, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: c.saved.id }] }, { idempotencyKey: "pending-request" });
    const changed = await c.service.prepareExamTemplate(admin, c.saved.id, { expectedVersion: c.saved.version, template: { ...fixtureTemplate, analytes: fixtureTemplate.analytes.map((entry) => ({ ...entry, label: "Analito futuro", referenceRange: { ...entry.referenceRange, low: 100, high: 200 } })) }, idempotencyKey: "pending-new-definition" });
    await c.service.updateDiagnosticService(admin, c.saved.id, { expectedVersion: changed.version, active: false, idempotencyKey: "pending-deactivate" });
    const receipt = await c.service.receiveSample(lab, [request.items[0].id], { sampleType: "FIXTURE", expectedVersion: 1, idempotencyKey: "pending-receive" });
    const started = await c.service.startProcessing(lab, request.items[0].id, { expectedVersion: receipt.items[0].version, idempotencyKey: "pending-start" });
    const draft = await c.service.createResultDraft(lab, request.items[0].id, { expectedVersion: started.item.version, narrative: "Synthetic pending result", content: { kind: "LABORATORY_STRUCTURED", panelCode: fixtureTemplate.code, panelVersion: c.saved.resultTemplate!.version, observations: [{ analyteCode: "VALUE", value: 5, unitCode: "fixture/unit" }] }, idempotencyKey: "pending-draft" });
    const result = await c.service.releaseResult(lab, draft.result.id, { expectedVersion: draft.result.version, idempotencyKey: "pending-release" });
    expect(result.version.definitionSnapshot).toEqual(request.items[0].definitionSnapshot);
    expect(result.version.content).toMatchObject({ observations: [{ flag: "NORMAL", referenceRange: { low: 1, high: 10 } }] });
    const view = await c.service.getResult(vet, result.result.id);
    expect(view.service.resultTemplate!.analytes[0].label).toBe("Analito sintético");
    await expect(c.service.createRequest(vet, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: c.saved.id }] }, { idempotencyKey: "inactive-new" })).rejects.toMatchObject({ status: 404 });
  });
  it("preserves released snapshots across CSV replacement and never treats import as clinical approval", async () => {
    const c = await released(); const old = structuredClone(c.result.version);
    const header = "codigo;nome;categoria;setor;fluxo;exige_amostra;tipo_amostra;exige_agenda;permite_anexo;esquema_resultado;sla_rotina_h;sla_urgente_h;sla_emergencia_h;ativo";
    const service = c.saved;
    const row = [service.code, "Nome importado futuro", service.category, service.departmentCode, service.workflowType, service.requiresSample ? "sim" : "não", service.sampleType ?? "", service.requiresSchedule ? "sim" : "não", service.allowsAttachment ? "sim" : "não", service.resultSchema, service.slaHours.ROUTINE, service.slaHours.URGENT, service.slaHours.EMERGENCY, "sim"].join(";");
    const analytes = "codigo_exame;codigo_analito;nome;tipo_valor;unidade;obrigatorio;ordem;referencia_minima;referencia_maxima;observacao\nHEMOGRAM;VALUE;Analito importado;numerico;fixture/unit;sim;1;100;200;Synthetic fixture";
    await c.service.importCatalog(c.user("admin@cvg.local"), { services: `${header}\n${row}`, analytes, idempotencyKey: "replace-approved-import" });
    const live = c.store.getState().services.find((entry) => entry.id === service.id)!;
    expect(live.resultTemplate?.approval).toBeUndefined();
    expect(live.resultTemplate?.analytes[0].referenceRange).toMatchObject({ low: 100, high: 200, source: "PENDING_HUMAN_POLICY" });
    const historical = await c.service.getResult(c.user("vet@cvg.local"), c.result.result.id);
    expect(historical.version).toEqual(old);
    expect(historical.service.resultTemplate).toEqual(c.saved.resultTemplate);
    const before = c.store.getState();
    await c.service.importCatalog(c.user("admin@cvg.local"), { services: `${header}\n${row}`, analytes, idempotencyKey: "replace-approved-import-again" });
    expect(c.store.getState()).toEqual(before);
  });
  it("denies a publication replay after its clinical approval grant is revoked", async () => {
    const c = await published(); const vet = c.user("vet@cvg.local");
    await c.store.transaction((state) => ({ state: { ...state, accessGroups: state.accessGroups.map((group) => group.id === vet.accessGroupId ? { ...group, version: group.version + 1, permissions: group.permissions.filter((permission) => permission !== "exam_definition.approve") } : group) }, result: undefined }));
    const before = c.store.getState();
    await expect(c.service.publishExamTemplate(vet, c.saved.id, { expectedVersion: c.saved.version - 1, policyReference: "SYNTHETIC_TEST_ONLY_NO_CLINICAL_APPROVAL", population: { species: ["Canino"] }, confirm: true, idempotencyKey: "publish-fixture" })).rejects.toMatchObject({ status: 404 });
    expect(c.store.getState()).toEqual(before);
  });
  it("requires homologated patient applicability in production and leaves pending demo content uninterpreted", async () => {
    const c = await released();
    const snapshot = c.result.version.definitionSnapshot!;
    assertApprovedLaboratoryReferences(snapshot.definition.resultTemplate, snapshot, c.result.version.content, true);
    const other: ExamDefinitionSnapshot = { ...snapshot, patientContext: { species: "Felino" } };
    expect(() => assertApprovedLaboratoryReferences(snapshot.definition.resultTemplate, other, c.result.version.content, true)).toThrow("contexto");
    const pending: LaboratoryPanelTemplate = { ...snapshot.definition.resultTemplate!, approval: undefined };
    expect(() => assertApprovedLaboratoryReferences(pending, snapshot, c.result.version.content, true)).toThrow("homologada");
    expect(() => assertApprovedLaboratoryReferences(pending, snapshot, c.result.version.content, false)).not.toThrow();
    const bounded = { ...snapshot.definition.resultTemplate!, approval: { ...snapshot.definition.resultTemplate!.approval!, population: { species: ["Canino"], minAgeDays: 30 } } };
    expect(() => assertApprovedLaboratoryReferences(bounded, { ...snapshot, patientContext: { species: "Canino" } }, c.result.version.content, true)).toThrow("contexto");
  });
  it("blocks actual production release of pending references without changing result or workflow state", async () => {
    const c = await setup(); const vet = c.user("vet@cvg.local"); const lab = c.user("lab@cvg.local");
    const request = await c.service.createRequest(vet, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-hemogram" }] }, { idempotencyKey: "production-pending-request" });
    const receipt = await c.service.receiveSample(lab, [request.items[0].id], { sampleType: "FIXTURE", expectedVersion: 1, idempotencyKey: "production-pending-receive" });
    const started = await c.service.startProcessing(lab, request.items[0].id, { expectedVersion: receipt.items[0].version, idempotencyKey: "production-pending-start" });
    const template = request.items[0].definitionSnapshot!.definition.resultTemplate!;
    const draft = await c.service.createResultDraft(lab, request.items[0].id, { expectedVersion: started.item.version, narrative: "Synthetic pending approval", content: { kind: "LABORATORY_STRUCTURED", panelCode: template.code, panelVersion: template.version, observations: template.analytes.filter((entry) => entry.required).map((entry) => ({ analyteCode: entry.code, value: entry.valueType === "NUMERIC" ? 5 : "fixture", unitCode: entry.unitCode })) }, idempotencyKey: "production-pending-draft" });
    expect((draft.version.content.observations as Array<{ flag: string }>).every((observation) => observation.flag === "UNINTERPRETED")).toBe(true);
    const before = c.store.getState();
    vi.stubEnv("NODE_ENV", "production");
    await expect(c.service.releaseResult(lab, draft.result.id, { expectedVersion: draft.result.version, idempotencyKey: "production-pending-release" })).rejects.toMatchObject({ code: "REFERENCE_POLICY_MISSING", status: 422 });
    expect(c.store.getState()).toEqual(before);
  });
});

describe("publication boundary states and historical definitions", () => {
  it("rejects nonlaboratory services and in-use narrative upgrades without changing clinical data", async () => {
    const c = await setup(); const admin = c.user("admin@cvg.local");
    await expect(c.service.prepareExamTemplate(admin, "service-xray", { expectedVersion: 1, template: fixtureTemplate, idempotencyKey: "wrong-workflow" })).rejects.toMatchObject({ status: 422 });
    const service = await c.service.createDiagnosticService(admin, { code: "NARRATIVE_USED", name: "Narrativo usado", category: "LABORATORY", departmentCode: "LABORATORY", workflowType: "LABORATORY", requiresSample: false, requiresSchedule: false, allowsAttachment: false, resultSchema: "NARRATIVE", slaHours: { ROUTINE: 8, URGENT: 4, EMERGENCY: 2 }, idempotencyKey: "narrative" });
    await c.service.createRequest(c.user("vet@cvg.local"), { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: service.id }] }, { idempotencyKey: "use-narrative" });
    const before = c.store.getState();
    await expect(c.service.prepareExamTemplate(admin, service.id, { expectedVersion: 1, template: fixtureTemplate, idempotencyKey: "in-use" })).rejects.toMatchObject({ code: "CATALOG_IN_USE" });
    expect(c.store.getState()).toEqual(before);
  });
  it("publishes an unused qualitative/text panel, freezes its approval and replays preparation once", async () => {
    const c = await setup(); const admin = c.user("admin@cvg.local");
    const service = await c.service.createDiagnosticService(admin, { code: "QUAL_FIRST", name: "Qualitativo sintético", category: "LABORATORY", departmentCode: "LABORATORY", workflowType: "LABORATORY", requiresSample: false, requiresSchedule: false, allowsAttachment: false, resultSchema: "NARRATIVE", slaHours: { ROUTINE: 8, URGENT: 4, EMERGENCY: 2 }, idempotencyKey: "new-qual" });
    const template = { ...fixtureTemplate, analytes: [{ code: "QUALITY", label: "Qualidade", valueType: "QUALITATIVE" as const, unitCode: "none", required: true, displayOrder: 1, allowedValues: ["OK", "NOK"] }, { code: "NOTES", label: "Nota", valueType: "TEXT" as const, unitCode: "none", required: false, displayOrder: 2 }] };
    const input = { template, expectedVersion: 1, idempotencyKey: "qual-prepare", correlationId: "qual-correlation" };
    const prepared = await c.service.prepareExamTemplate(admin, service.id, input);
    expect(prepared.resultTemplate).toMatchObject({ version: 1, status: "DRAFT" });
    expect(await c.service.prepareExamTemplate(admin, service.id, input)).toEqual(prepared);
    const pub = { expectedVersion: 2, policyReference: "SYNTHETIC_ONLY", population: { species: ["Canino"] }, confirm: true as const, idempotencyKey: "qual-publish" };
    const published = await c.service.publishExamTemplate(c.user("vet@cvg.local"), service.id, pub);
    expect(published.resultTemplate!.analytes[1].referenceRange).toBeUndefined();
    expect(await c.service.publishExamTemplate(c.user("vet@cvg.local"), service.id, pub)).toEqual(published);
    const versions = await c.service.listExamDefinitions(admin, service.id);
    expect(versions.map((entry) => entry.serviceVersion)).toEqual([3, 2, 1]);
    expect(versions[0].definition.resultTemplate?.approval?.approvedBy).toBe("user-vet");
  });
  it("requires prepared active services and active sectors before clinical publication", async () => {
    const c = await setup(); const admin = c.user("admin@cvg.local"); const vet = c.user("vet@cvg.local");
    const publication = { expectedVersion: 1, policyReference: "SYNTHETIC_ONLY", population: { species: ["Canino"] }, confirm: true as const, idempotencyKey: "no-draft" };
    await expect(c.service.publishExamTemplate(vet, "service-hemogram", publication)).rejects.toMatchObject({ status: 409 });
    const prepared = await c.service.prepareExamTemplate(admin, "service-hemogram", { expectedVersion: 1, template: fixtureTemplate, idempotencyKey: "prepare-boundary" });
    await expect(c.service.retireExamTemplate(admin, prepared.id, { expectedVersion: 2, reason: "Não publicado", idempotencyKey: "draft-retire" })).rejects.toMatchObject({ status: 409 });
    await c.service.updateDiagnosticService(admin, prepared.id, { active: false, expectedVersion: 2, idempotencyKey: "off" });
    await expect(c.service.publishExamTemplate(vet, prepared.id, { ...publication, expectedVersion: 3, idempotencyKey: "service-off" })).rejects.toMatchObject({ status: 422 });
    await c.service.updateDiagnosticService(admin, prepared.id, { active: true, expectedVersion: 3, idempotencyKey: "on" });
    await c.store.transaction((state) => ({ state: { ...state, departments: state.departments.map((department) => department.code === "LABORATORY" ? { ...department, active: false } : department) }, result: undefined }));
    await expect(c.service.publishExamTemplate(vet, prepared.id, { ...publication, expectedVersion: 4, idempotencyKey: "department-off" })).rejects.toMatchObject({ status: 422 });
  });
  it.each([{ referenceRange: undefined }, { referenceRange: { kind: "PENDING_POLICY" as const, unitCode: "fixture/unit", source: "PENDING_HUMAN_POLICY" as const } }])("blocks numeric publication with uninterpretable references: %j", async (fields) => {
    const c = await setup(); const template = { ...fixtureTemplate, analytes: [{ ...fixtureTemplate.analytes[0], ...fields }] };
    await c.service.prepareExamTemplate(c.user("admin@cvg.local"), "service-hemogram", { expectedVersion: 1, template, idempotencyKey: "missing-range" });
    await expect(c.service.publishExamTemplate(c.user("vet@cvg.local"), "service-hemogram", { expectedVersion: 2, policyReference: "SYNTHETIC_ONLY", population: { species: ["Canino"] }, confirm: true, idempotencyKey: "missing-range-publish" })).rejects.toMatchObject({ code: "REFERENCE_POLICY_MISSING" });
    expect(c.store.getState().services.find((entry) => entry.id === "service-hemogram")?.resultTemplate?.status).toBe("DRAFT");
  });
});
