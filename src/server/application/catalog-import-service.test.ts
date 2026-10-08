import { describe, expect, it } from "vitest";
import { createApplicationService } from "./service";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";

const SERVICE_HEADER = "codigo;nome;categoria;setor;fluxo;exige_amostra;tipo_amostra;exige_agenda;permite_anexo;esquema_resultado;sla_rotina_h;sla_urgente_h;sla_emergencia_h;ativo";
const ANALYTE_HEADER = "codigo_exame;codigo_analito;nome;tipo_valor;unidade;obrigatorio;ordem;referencia_minima;referencia_maxima;observacao";
const SHEET = [
  SERVICE_HEADER,
  "URINALYSIS;Urinálise;LABORATORY;LABORATORY;LABORATORY;sim;Urina;não;não;NUMERIC_PANEL;8;4;2;sim",
  "CRP;Proteína C reativa (PCR);LABORATORY;LABORATORY;LABORATORY;sim;Soro;não;não;NARRATIVE;8;4;2;sim",
  "RX_ABDOMEN;RX de abdome;IMAGING;RADIOLOGY;RADIOLOGY;não;;não;sim;NARRATIVE;24;8;4;sim"
].join("\n");
const ANALYTES = [ANALYTE_HEADER, "URINALYSIS;DENSITY;Densidade;numerico;g/mL;sim;1;1,015;1,045;Cães", "URINALYSIS;COLOR;Cor;texto;;não;2;;;"].join("\n");

function setup() {
  const store = new MemoryStore(createDemoState("catalog-import-service-test"));
  const service = createApplicationService(store);
  const user = (email: string) => store.getState().users.find((entry) => entry.email === email)!;
  return { store, service, admin: user("admin@cvg.local"), manager: user("manager@cvg.local"), vet: user("vet@cvg.local"), lab: user("lab@cvg.local") };
}

describe("catalog import command (D10)", () => {
  it("dry run plans without writing, even with a valid idempotency key", async () => {
    const { store, service, admin } = setup();
    const before = store.getState();
    const report = await service.importCatalog(admin, { services: SHEET, analytes: ANALYTES, dryRun: true, idempotencyKey: "dry-1" });
    expect(report).toMatchObject({ applied: false, dryRun: true, summary: { create: 2, update: 1, unchanged: 0, error: 0 } });
    expect(report).not.toHaveProperty("writes");
    expect(store.getState()).toEqual(before);
  });

  it("applies creates and updates with one audit per service, a summary audit and version bumps", async () => {
    const { store, service, admin } = setup();
    const report = await service.importCatalog(admin, { services: SHEET, analytes: ANALYTES, idempotencyKey: "apply-1", correlationId: "corr-import" });
    expect(report).toMatchObject({ applied: true, dryRun: false, summary: { create: 2, update: 1, error: 0 } });
    const state = store.getState();
    const urinalysis = state.services.find((entry) => entry.code === "URINALYSIS")!;
    expect(urinalysis).toMatchObject({ version: 1, sampleType: "Urina", active: true, resultSchema: "NUMERIC_PANEL" });
    expect(urinalysis.resultTemplate).toMatchObject({ code: "URINALYSIS", version: 1, status: "ACTIVE" });
    expect(urinalysis.resultTemplate!.analytes[0]!.referenceRange).toMatchObject({ kind: "NUMERIC", low: 1.015, high: 1.045, source: "HUMAN_APPROVED" });
    expect(state.services.find((entry) => entry.code === "CRP")).toMatchObject({ name: "Proteína C reativa (PCR)", sampleType: "Soro", version: 2 });
    const events = state.auditEvents.filter((event) => event.correlationId === "corr-import");
    expect(events.map((event) => event.eventType).sort()).toEqual(["CatalogImported", "DiagnosticServiceCreated", "DiagnosticServiceCreated", "DiagnosticServiceUpdated"]);
    expect(events.find((event) => event.eventType === "CatalogImported")?.metadata).toMatchObject({ created: 2, updated: 1, unchanged: 0 });
    // executors who held every exam of the department receive the new ones
    expect(state.users.find((user) => user.email === "lab@cvg.local")!.serviceCodes).toEqual(expect.arrayContaining(["URINALYSIS"]));
    expect((await service.listServices(admin)).find((entry) => entry.code === "URINALYSIS")?.resultTemplate?.analytes).toHaveLength(2);
    // replay with the same key returns the stored report
    const replay = await service.importCatalog(admin, { services: SHEET, analytes: ANALYTES, idempotencyKey: "apply-1" });
    expect(replay).toEqual(report);
  });

  it("re-importing the same sheet is idempotent: everything unchanged and nothing written", async () => {
    const { store, service, admin } = setup();
    await service.importCatalog(admin, { services: SHEET, analytes: ANALYTES, idempotencyKey: "apply-1" });
    const before = store.getState();
    const again = await service.importCatalog(admin, { services: SHEET, analytes: ANALYTES, idempotencyKey: "apply-2" });
    expect(again).toMatchObject({ applied: true, summary: { create: 0, update: 0, unchanged: 3, error: 0 } });
    expect(store.getState()).toEqual(before);
  });

  it("bumps the panel version when analytes change and deactivates only when the sheet says so", async () => {
    const { store, service, admin } = setup();
    await service.importCatalog(admin, { services: SHEET, analytes: ANALYTES, idempotencyKey: "apply-1" });
    const revised = SHEET.replace("URINALYSIS;Urinálise;LABORATORY;LABORATORY;LABORATORY;sim;Urina;não;não;NUMERIC_PANEL;8;4;2;sim", "URINALYSIS;Urinálise;LABORATORY;LABORATORY;LABORATORY;sim;Urina;não;não;NUMERIC_PANEL;8;4;2;não");
    const report = await service.importCatalog(admin, { services: revised, analytes: ANALYTES.replace("1,045", "1,050"), idempotencyKey: "apply-2" });
    expect(report.summary).toMatchObject({ create: 0, update: 1, unchanged: 2 });
    expect(store.getState().services.find((entry) => entry.code === "URINALYSIS")).toMatchObject({ active: false, version: 2, resultTemplate: { version: 2 } });
    expect(store.getState().services.find((entry) => entry.code === "HEMOGRAM")?.active).toBe(true);
    // inactive new service does not grant executor access
    const inactive = await service.importCatalog(admin, { services: `${SERVICE_HEADER}\nOLD_EXAM;Antigo;LABORATORY;LABORATORY;LABORATORY;sim;;não;não;NARRATIVE;8;4;2;não`, idempotencyKey: "apply-3" });
    expect(inactive.summary.create).toBe(1);
    expect(store.getState().users.find((user) => user.email === "lab@cvg.local")!.serviceCodes).not.toContain("OLD_EXAM");
  });

  it("rejects the whole sheet with 422 when any row has an error, writing nothing", async () => {
    const { store, service, admin } = setup();
    const before = store.getState();
    const broken = `${SHEET}\nBAD;Ruim;IMAGING;LABORATORY;LABORATORY;não;;não;não;NARRATIVE;8;4;2;sim`;
    await expect(service.importCatalog(admin, { services: broken, analytes: ANALYTES, idempotencyKey: "bad-1" })).rejects.toMatchObject({
      code: "CATALOG_IMPORT_INVALID", status: 422,
      details: { importReport: { applied: false, summary: { create: 2, update: 1, error: 1 } } }
    });
    expect(store.getState()).toEqual(before);
  });

  it("blocks structural changes of an exam that already has items", async () => {
    const { store, service, admin } = setup();
    const crp = store.getState().services.find((entry) => entry.code === "CRP")!;
    await store.transaction(async (state) => ({ state: { ...state, items: [...state.items, { id: "item-seed", serviceId: crp.id } as never] }, result: null }));
    const structural = SHEET.replace("CRP;Proteína C reativa (PCR);LABORATORY;LABORATORY;LABORATORY;sim;Soro", "CRP;Proteína C reativa (PCR);LABORATORY;LABORATORY;LABORATORY;não;");
    const report = await service.importCatalog(admin, { services: structural, analytes: ANALYTES, dryRun: true, idempotencyKey: "struct-1" });
    expect(report.summary.error).toBe(1);
    expect(report.rows.find((row) => row.code === "CRP")?.errors?.[0]).toContain("já está referenciada");
    await expect(service.importCatalog(admin, { services: structural, analytes: ANALYTES, idempotencyKey: "struct-2" })).rejects.toMatchObject({ code: "CATALOG_IMPORT_INVALID" });
  });

  it("limits a manager to delegated departments and denies other roles", async () => {
    const { store, service, manager, vet, lab } = setup();
    await store.transaction(async (state) => ({
      state: { ...state, users: state.users.map((user) => user.id === manager.id ? { ...user, managedDepartmentCodes: ["LABORATORY"], version: user.version + 1 } : user) },
      result: null
    }));
    const limited = store.getState().users.find((user) => user.id === manager.id)!;
    const dry = await service.importCatalog(limited, { services: SHEET, analytes: ANALYTES, dryRun: true, idempotencyKey: "mgr-1" });
    expect(dry.rows.find((row) => row.code === "RX_ABDOMEN")).toMatchObject({ action: "ERROR", errors: [expect.stringContaining("RADIOLOGY")] });
    expect(dry.summary).toMatchObject({ create: 1, update: 1, error: 1 });
    await expect(service.importCatalog(limited, { services: SHEET, analytes: ANALYTES, idempotencyKey: "mgr-2" })).rejects.toMatchObject({ code: "CATALOG_IMPORT_INVALID", status: 422 });
    const onlyLab = SHEET.split("\n").slice(0, 3).join("\n");
    await expect(service.importCatalog(limited, { services: onlyLab, analytes: ANALYTES, idempotencyKey: "mgr-3" })).resolves.toMatchObject({ applied: true, summary: { create: 1, update: 1 } });
    for (const actor of [vet, lab]) {
      await expect(service.importCatalog(actor, { services: SHEET, dryRun: true, idempotencyKey: "deny" })).rejects.toMatchObject({ status: 404 });
      await expect(service.importCatalog(actor, { services: SHEET, idempotencyKey: "deny" })).rejects.toMatchObject({ status: 404 });
    }
  });

  it("requires an idempotency key and reports unreadable sheets as a 422 error row", async () => {
    const { service, admin } = setup();
    await expect(service.importCatalog(admin, { services: SHEET })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED" });
    await expect(service.importCatalog(admin, { services: "codigo;nome", idempotencyKey: "bad-header" })).rejects.toMatchObject({ status: 422, details: { importReport: { summary: { error: 1 } } } });
    await expect(service.importCatalog(admin, { services: SHEET, analytes: ANALYTES, idempotencyKey: "reuse" })).resolves.toMatchObject({ applied: true });
    await expect(service.importCatalog(admin, { services: SHEET, idempotencyKey: "reuse" })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });
});
