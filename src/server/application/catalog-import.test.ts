import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDemoState } from "../store/fixtures";
import { CsvSyntaxError, detectDelimiter, MAX_CATALOG_CHANGE_LENGTH, parseAnalyteSheet, parseCatalogSheet, parseCsv, planCatalogImport } from "./catalog-import";

const SERVICE_HEADER = "codigo;nome;categoria;setor;fluxo;exige_amostra;tipo_amostra;exige_agenda;permite_anexo;esquema_resultado;sla_rotina_h;sla_urgente_h;sla_emergencia_h;ativo";
const ANALYTE_HEADER = "codigo_exame;codigo_analito;nome;tipo_valor;unidade;obrigatorio;ordem;referencia_minima;referencia_maxima;observacao";
const state = () => createDemoState("catalog-import-test");
const serviceSheet = (...lines: string[]) => [SERVICE_HEADER, ...lines].join("\n");
const analyteSheet = (...lines: string[]) => [ANALYTE_HEADER, ...lines].join("\n");
const GLUCOSE = "GLUCOSE;Glicemia;LABORATORY;LABORATORY;LABORATORY;sim;Soro;não;não;NARRATIVE;8;4;2;sim";

describe("parseCsv", () => {
  it("handles quotes, doubled quotes, embedded newlines, CRLF, BOM, blank lines and trimming", () => {
    const records = parseCsv('﻿a;b;c\r\n\r\n  x  ;"y;1";"say ""hi"""\r\n"multi\nline";;z\r\n', ";");
    expect(records).toEqual([
      { line: 1, cells: ["a", "b", "c"] },
      { line: 3, cells: ["x", "y;1", 'say "hi"'] },
      { line: 4, cells: ["multi\nline", "", "z"] }
    ]);
  });

  it("accepts a lone CR as line break, quoted text after a space and a final record without newline", () => {
    expect(parseCsv('a,b\r1, "q"', ",")).toEqual([{ line: 1, cells: ["a", "b"] }, { line: 2, cells: ["1", "q"] }]);
  });

  it("rejects an unterminated quote with the starting line", () => {
    expect(() => parseCsv('a;b\n"open;1', ";")).toThrow(CsvSyntaxError);
    expect(() => parseCsv('a;b\n"open;1', ";")).toThrow(/linha 2/);
  });

  it("autodetects the delimiter from the header and ignores separators inside quotes", () => {
    expect(detectDelimiter("a;b;c\n1,2,3")).toBe(";");
    expect(detectDelimiter("﻿a,b,c\n1;2;3")).toBe(",");
    expect(detectDelimiter('"a;b;c",d\n')).toBe(",");
    expect(detectDelimiter("single")).toBe(",");
    expect(detectDelimiter("\n\na;b")).toBe(";");
    expect(parseCsv("a,b\n1,2")).toEqual([{ line: 1, cells: ["a", "b"] }, { line: 2, cells: ["1", "2"] }]);
  });
});

describe("parseCatalogSheet", () => {
  it("parses a row with booleans in every accepted spelling, accents and aliases", () => {
    const sheet = parseCatalogSheet(serviceSheet("glicemia; Glicemia ;Laboratório;lab;Laboratorio;S;Soro;não;N;painel numerico;8;4;2;"));
    expect(sheet.fatal).toBeUndefined();
    expect(sheet.rows[0]).toMatchObject({ line: 2, code: "GLICEMIA", errors: [], value: { name: "Glicemia", category: "LABORATORY", departmentCode: "LAB", workflowType: "LABORATORY", requiresSample: true, sampleType: "Soro", requiresSchedule: false, allowsAttachment: false, resultSchema: "NUMERIC_PANEL", active: true, slaHours: { ROUTINE: 8, URGENT: 4, EMERGENCY: 2 } } });
    const other = parseCatalogSheet(serviceSheet("RX_A;RX;imagem;RADIOLOGY;radiologia;0;;1;true;narrativo;24;8;4;false"));
    expect(other.rows[0]!.value).toMatchObject({ requiresSample: false, requiresSchedule: true, allowsAttachment: true, active: false, category: "IMAGING", workflowType: "RADIOLOGY" });
    expect(other.rows[0]!.value).not.toHaveProperty("sampleType");
  });

  it("accepts the comma delimiter, BOM and CRLF", () => {
    const text = `﻿${SERVICE_HEADER.replaceAll(";", ",")}\r\n${GLUCOSE.replaceAll(";", ",")}\r\n`;
    expect(parseCatalogSheet(text).rows[0]).toMatchObject({ code: "GLUCOSE", errors: [] });
  });

  it("reports unknown, missing and repeated header columns naming each column", () => {
    const sheet = parseCatalogSheet("codigo;nome;cor;codigo\nA;B;C;D");
    expect(sheet.fatal).toContain('Coluna desconhecida no cabeçalho: "cor"');
    expect(sheet.fatal).toContain('Coluna obrigatória ausente no cabeçalho: "setor"');
    expect(sheet.fatal).toContain('Coluna repetida no cabeçalho: "codigo"');
    expect(sheet.rows).toEqual([]);
  });

  it("reports empty files, syntax errors and oversized sheets", () => {
    expect(parseCatalogSheet("\n \n").fatal).toContain("vazia");
    expect(parseCatalogSheet('codigo;"nome').fatal).toContain("Aspas abertas");
    const many = serviceSheet(...Array.from({ length: 2001 }, (_, index) => `C${index}`));
    expect(parseCatalogSheet(many).fatal).toContain("limite de 2000");
    const failing = parseCatalogSheet(SERVICE_HEADER);
    expect(failing.rows).toEqual([]);
  });

  it("reports row errors with line numbers per column", () => {
    const sheet = parseCatalogSheet(serviceSheet(
      "x;;FOO;a b;BAR;talvez;" + "z".repeat(61) + ";?;?;XX;0;721;1.5;?",
      "SHORT;a;b",
      "OK_ROW;Nome;IMAGING;RADIOLOGY;RADIOLOGY;não;Soro;não;sim;NARRATIVE;1;2;3;sim"
    ));
    const errors = sheet.rows[0]!.errors.join("\n");
    for (const column of ["codigo", "nome", "categoria", "setor", "fluxo", "exige_amostra", "tipo_amostra", "exige_agenda", "permite_anexo", "esquema_resultado", "sla_rotina_h", "sla_urgente_h", "sla_emergencia_h", "ativo"]) expect(errors).toContain(`"${column}"`);
    expect(sheet.rows[0]!.line).toBe(2);
    expect(sheet.rows[1]).toMatchObject({ line: 3, code: "SHORT" });
    expect(sheet.rows[1]!.errors[0]).toContain("3 colunas");
    expect(sheet.rows[2]!.errors.join()).toContain("só pode ser preenchida em exames que exigem amostra");
  });
});

describe("parseAnalyteSheet", () => {
  it("builds analyte rows with decimal comma and defaults", () => {
    const sheet = parseAnalyteSheet(analyteSheet(
      "glicemia;glu;Glicose;numerico;mg/dL;sim;2;70,5;110;Cães: 70-110",
      "GLICEMIA;OBS;Observação;texto;;não;;;;"
    ));
    expect(sheet.rows[0]!.value).toEqual({ serviceCode: "GLICEMIA", code: "GLU", label: "Glicose", valueType: "NUMERIC", unitCode: "mg/dL", required: true, displayOrder: 2, low: 70.5, high: 110, note: "Cães: 70-110" });
    expect(sheet.rows[1]!.value).toEqual({ serviceCode: "GLICEMIA", code: "OBS", label: "Observação", valueType: "TEXT", unitCode: "TEXT", required: false });
  });

  it("validates analyte columns", () => {
    const sheet = parseAnalyteSheet(analyteSheet(
      "1;1;;numero;;talvez;0;abc;1;" + "n".repeat(501),
      "X1;A;Nome;texto;" + "u".repeat(31) + ";sim;1;1;2;",
      "X1;B;Nome;numerico;un;sim;1;5;2;"
    ));
    const first = sheet.rows[0]!.errors.join("\n");
    for (const column of ["codigo_exame", "codigo_analito", "nome", "tipo_valor", "obrigatorio", "ordem", "referencia_minima", "observacao"]) expect(first).toContain(`"${column}"`);
    expect(sheet.rows[1]!.errors.join()).toContain("só se aplica a analitos numéricos");
    expect(sheet.rows[1]!.errors.join()).toContain('"unidade"');
    expect(sheet.rows[2]!.errors.join()).toContain("não pode ser maior");
    const numericWithoutUnit = parseAnalyteSheet(analyteSheet("X1;A;Nome;numerico;;sim;;;;"));
    expect(numericWithoutUnit.rows[0]!.errors.join()).toContain("obrigatória para analitos numéricos");
    expect(parseAnalyteSheet("codigo_exame").fatal).toContain("Coluna obrigatória ausente");
    expect(parseAnalyteSheet(analyteSheet(...Array.from({ length: 10001 }, () => "X"))).fatal).toContain("limite de 10000");
  });
});

describe("download templates", () => {
  const read = (name: string) => readFileSync(path.join(process.cwd(), "public/templates", name), "utf8");

  it("ship valid headers and example rows that the importer refuses until they are removed", () => {
    const services = parseCatalogSheet(read("catalogo-exames.csv"));
    const analytes = parseAnalyteSheet(read("catalogo-analitos.csv"));
    expect(services.fatal).toBeUndefined();
    expect(analytes.fatal).toBeUndefined();
    expect(services.rows).toHaveLength(3);
    expect(analytes.rows).toHaveLength(3);
    for (const row of [...services.rows, ...analytes.rows]) expect(row.errors).toEqual([expect.stringContaining("EXEMPLO_")]);
    const plan = planCatalogImport(state(), services, analytes);
    expect(plan.summary).toMatchObject({ error: 6, create: 0 });
  });

  it("would import cleanly once the example prefix is replaced", () => {
    const services = parseCatalogSheet(read("catalogo-exames.csv").replaceAll("EXEMPLO_", "REAL_"));
    const analytes = parseAnalyteSheet(read("catalogo-analitos.csv").replaceAll("EXEMPLO_", "REAL_"));
    const plan = planCatalogImport(state(), services, analytes);
    expect(plan.summary).toEqual({ create: 3, update: 0, unchanged: 0, error: 0 });
  });
});

describe("planCatalogImport", () => {
  it("creates, detects UNCHANGED and reports each field change on update", () => {
    const base = state();
    const created = planCatalogImport(base, parseCatalogSheet(serviceSheet(GLUCOSE)));
    expect(created.rows).toEqual([{ line: 2, code: "GLUCOSE", action: "CREATE", changes: ["novo exame"] }]);
    expect(created.summary).toEqual({ create: 1, update: 0, unchanged: 0, error: 0 });
    expect(created.writes[0]!.next).toMatchObject({ code: "GLUCOSE", sampleType: "Soro", active: true });

    const crp = "CRP;Proteína C reativa;LABORATORY;LABORATORY;LABORATORY;sim;;não;não;NARRATIVE;8;4;2;sim";
    expect(planCatalogImport(base, parseCatalogSheet(serviceSheet(crp))).rows).toEqual([{ line: 2, code: "CRP", action: "UNCHANGED" }]);

    const updated = planCatalogImport(base, parseCatalogSheet(serviceSheet("CRP;PCR;LABORATORY;LABORATORY;LABORATORY;sim;Soro;não;sim;NARRATIVE;10;4;2;não")));
    expect(updated.rows[0]!.action).toBe("UPDATE");
    expect(updated.rows[0]!.changes).toEqual(['nome: Proteína C reativa → PCR', 'tipo_amostra: (vazio) → Soro', 'permite_anexo: não → sim', 'ativo: sim → não', 'sla_rotina_h: 8 → 10']);
    expect(updated.writes[0]).toMatchObject({ action: "UPDATE", existingId: "service-crp" });

    const cleared = planCatalogImport({ ...base, services: base.services.map((entry) => entry.code === "CRP" ? { ...entry, sampleType: "Soro" } : entry) }, parseCatalogSheet(serviceSheet(crp)));
    expect(cleared.rows[0]!.changes).toEqual(["tipo_amostra: Soro → (vazio)"]);
    expect(cleared.writes[0]!.next).not.toHaveProperty("sampleType");
  });

  it("leaves services absent from the sheet untouched", () => {
    const plan = planCatalogImport(state(), parseCatalogSheet(serviceSheet(GLUCOSE)));
    expect(plan.rows.map((row) => row.code)).toEqual(["GLUCOSE"]);
    expect(plan.writes).toHaveLength(1);
  });

  it("applies the cross-field, department permission and duplicate rules", () => {
    const plan = planCatalogImport(state(), parseCatalogSheet(serviceSheet(
      "BAD_PAIR;Par;IMAGING;LABORATORY;LABORATORY;não;;não;não;NARRATIVE;1;2;3;sim",
      GLUCOSE,
      GLUCOSE,
      "RX_OTHER;RX;IMAGING;RADIOLOGY;RADIOLOGY;não;;não;sim;NARRATIVE;1;2;3;sim",
      "XRAY_THORAX;RX;IMAGING;RADIOLOGY;RADIOLOGY;não;;não;sim;NARRATIVE;24;8;4;sim"
    )), undefined, { canManageDepartment: (department) => department !== "RADIOLOGY" });
    expect(plan.rows.map((row) => row.action)).toEqual(["ERROR", "CREATE", "ERROR", "ERROR", "ERROR"]);
    expect(plan.rows[0]!.errors?.join()).toContain("Categoria e workflow");
    expect(plan.rows[2]!.errors?.[0]).toContain("primeira ocorrência na linha 3");
    expect(plan.rows[3]!.errors?.[0]).toContain("setor RADIOLOGY");
    expect(plan.rows[4]!.errors).toHaveLength(1);
    expect(plan.summary).toEqual({ create: 1, update: 0, unchanged: 0, error: 4 });
  });

  it("blocks structural changes on referenced services with the CATALOG_IN_USE message but allows cosmetic ones", () => {
    const base = state();
    const withItem = { ...base, items: [{ id: "item-1", serviceId: "service-crp" } as (typeof base.items)[number]] };
    const structural = planCatalogImport(withItem, parseCatalogSheet(serviceSheet("CRP;Proteína C reativa;LABORATORY;LABORATORY;LABORATORY;não;;não;não;NARRATIVE;8;4;2;sim")));
    expect(structural.rows[0]).toMatchObject({ action: "ERROR", errors: ["A estrutura deste serviço já está referenciada por solicitações e não pode ser alterada."] });
    const cosmetic = planCatalogImport(withItem, parseCatalogSheet(serviceSheet("CRP;Nome novo;LABORATORY;LABORATORY;LABORATORY;sim;;não;não;NARRATIVE;12;4;2;não")));
    expect(cosmetic.rows[0]!.action).toBe("UPDATE");
  });

  it("returns a single error row for unreadable sheets", () => {
    const plan = planCatalogImport(state(), parseCatalogSheet("codigo"), parseAnalyteSheet("x"));
    expect(plan.rows).toHaveLength(2);
    expect(plan.rows[1]!.errors?.[0]).toContain("Planilha de analitos:");
    expect(plan.summary.error).toBe(2);
    expect(plan.writes).toEqual([]);
  });

  it("builds a versioned panel template from analytes and keeps the version when nothing changes", () => {
    const base = state();
    const panel = "PANEL_X;Painel X;LABORATORY;LABORATORY;LABORATORY;sim;Sangue total;não;não;NUMERIC_PANEL;8;4;2;sim";
    const analytes = analyteSheet(
      "PANEL_X;B_COMMENT;Observação;texto;;não;3;;;",
      "PANEL_X;A_VALUE;Valor A;numerico;g/dL;sim;1;1,5;3;Cães e gatos",
      "PANEL_X;B_VALUE;Valor B;numerico;g/dL;sim;2;;;Faixa pendente da diretoria",
      "PANEL_X;C_QUAL;Qualitativo;qualitativo;;não;4;;;"
    );
    const first = planCatalogImport(base, parseCatalogSheet(serviceSheet(panel)), parseAnalyteSheet(analytes));
    expect(first.summary.create).toBe(1);
    const template = first.writes[0]!.next.resultTemplate!;
    expect(template).toMatchObject({ kind: "LABORATORY_PANEL", code: "PANEL_X", name: "Painel X", version: 1, schemaVersion: "1.0", status: "ACTIVE" });
    expect(template.analytes.map((entry) => entry.code)).toEqual(["A_VALUE", "B_VALUE", "B_COMMENT", "C_QUAL"]);
    expect(template.analytes[0]!.referenceRange).toEqual({ kind: "NUMERIC", unitCode: "g/dL", low: 1.5, high: 3, source: "HUMAN_APPROVED", note: "Cães e gatos" });
    expect(template.analytes[1]!.referenceRange).toEqual({ kind: "PENDING_POLICY", unitCode: "g/dL", source: "PENDING_HUMAN_POLICY", note: "Faixa pendente da diretoria" });
    expect(template.analytes[2]!.referenceRange).toMatchObject({ kind: "PENDING_POLICY", unitCode: "TEXT", note: "Não interpretado clinicamente." });
    expect(template.analytes[3]).toMatchObject({ valueType: "QUALITATIVE", unitCode: "TEXT" });
    expect(first.writes[0]!.changes).toEqual(["novo exame", "painel de analitos: 4 analitos"]);

    const stored = { ...base, services: [...base.services, { id: "service-panel", ...first.writes[0]!.next, version: 1 }] };
    const same = planCatalogImport(stored, parseCatalogSheet(serviceSheet(panel)), parseAnalyteSheet(analytes));
    expect(same.rows[0]!.action).toBe("UNCHANGED");
    const withoutAnalytes = planCatalogImport(stored, parseCatalogSheet(serviceSheet(panel)));
    expect(withoutAnalytes.rows[0]!.action).toBe("UNCHANGED");

    const changed = planCatalogImport(stored, parseCatalogSheet(serviceSheet(panel)), parseAnalyteSheet(analytes.replace("1,5;3", "1,5;3,5")));
    expect(changed.rows[0]!.changes).toEqual(["painel de analitos: versão 1 → 2 (4 analitos)"]);
    expect(changed.writes[0]!.next.resultTemplate!.version).toBe(2);
    const rename = planCatalogImport(stored, parseCatalogSheet(serviceSheet(panel.replace("Painel X", "Painel Y"))), parseAnalyteSheet(analytes));
    expect(rename.writes[0]!.next.resultTemplate).toMatchObject({ name: "Painel Y", version: 2 });
  });

  it("lists the analytes removed and included by a panel replacement, and nothing when the panel is unchanged", () => {
    const panel = "PANEL_R;Painel R;LABORATORY;LABORATORY;LABORATORY;sim;;não;não;NUMERIC_PANEL;8;4;2;sim";
    const full = analyteSheet("PANEL_R;KEEP_A;Mantido A;numerico;g/dL;sim;1;;;", "PANEL_R;KEEP_B;Mantido B;texto;;não;2;;;", "PANEL_R;GONE_OPT;Opcional;texto;;não;3;;;", "PANEL_R;GONE_REQ;Obrigatório;numerico;g/dL;sim;4;;;");
    const base = state();
    const first = planCatalogImport(base, parseCatalogSheet(serviceSheet(panel)), parseAnalyteSheet(full));
    expect(first.rows[0]).not.toHaveProperty("removedAnalytes");
    const stored = { ...base, services: [...base.services, { id: "service-r", ...first.writes[0]!.next, version: 1 }] };
    const next = analyteSheet("PANEL_R;KEEP_A;Mantido A;numerico;g/dL;sim;1;;;", "PANEL_R;KEEP_B;Mantido B;texto;;não;2;;;", "PANEL_R;NEW_C;Novo C;texto;;não;5;;;");
    const plan = planCatalogImport(stored, parseCatalogSheet(serviceSheet(panel)), parseAnalyteSheet(next));
    expect(plan.rows[0]).toMatchObject({
      action: "UPDATE",
      removedAnalytes: [{ code: "GONE_OPT", label: "Opcional", required: false }, { code: "GONE_REQ", label: "Obrigatório", required: true }]
    });
    expect(plan.rows[0]!.changes).toEqual(["painel de analitos: versão 1 → 2 (3 analitos)", "analitos incluídos: NEW_C", "analitos removidos: GONE_OPT, GONE_REQ (obrigatório)"]);
    const unchanged = planCatalogImport(stored, parseCatalogSheet(serviceSheet(panel)), parseAnalyteSheet(full));
    expect(unchanged.rows[0]).toEqual({ line: 2, code: "PANEL_R", action: "UNCHANGED" });
    const onlyRemoval = planCatalogImport(stored, parseCatalogSheet(serviceSheet(panel)), parseAnalyteSheet(analyteSheet("PANEL_R;KEEP_A;Mantido A;numerico;g/dL;sim;1;;;", "PANEL_R;KEEP_B;Mantido B;texto;;não;2;;;", "PANEL_R;GONE_OPT;Opcional;texto;;não;3;;;")));
    expect(onlyRemoval.rows[0]!.changes?.some((line) => line.startsWith("analitos incluídos"))).toBe(false);
    expect(onlyRemoval.rows[0]!.removedAnalytes).toEqual([{ code: "GONE_REQ", label: "Obrigatório", required: true }]);
  });

  it("echoes at most 40 characters of a bad cell and keeps every message and code within the contract caps", () => {
    const huge = "A".repeat(20_000);
    const row = (overrides: Record<string, string>) => {
      const fields: Record<string, string> = { codigo: "AUDIT_PANEL", nome: "Painel", categoria: "LABORATORY", setor: "LABORATORY", fluxo: "LABORATORY", exige_amostra: "sim", tipo_amostra: "EDTA", exige_agenda: "não", permite_anexo: "não", esquema_resultado: "NARRATIVE", sla_rotina_h: "8", sla_urgente_h: "4", sla_emergencia_h: "2", ativo: "sim", ...overrides };
      return SERVICE_HEADER.split(";").map((column) => fields[column]).join(";");
    };
    const cases: Array<Record<string, string>> = [{ categoria: huge }, { exige_amostra: huge }, { sla_rotina_h: huge }, { codigo: huge }];
    for (const overrides of cases) {
      const [parsed] = parseCatalogSheet(serviceSheet(row(overrides))).rows;
      expect(parsed!.errors.length).toBeGreaterThan(0);
      for (const message of parsed!.errors) expect(Array.from(message).length).toBeLessThan(300);
      expect(Array.from(parsed!.code).length).toBeLessThanOrEqual(100);
    }
    const [categoria] = parseCatalogSheet(serviceSheet(row({ categoria: huge }))).rows[0]!.errors;
    expect(categoria).toContain(`"${"A".repeat(40)}…"`);
    const decimal = parseAnalyteSheet(analyteSheet(`HEMOGRAM;HB;Hemoglobina;numerico;g/dL;sim;1;${huge};;`)).rows[0]!.errors;
    expect(decimal.every((message) => Array.from(message).length < 300)).toBe(true);
    // A header full of long unknown columns names five of them and counts the rest.
    const header = parseCatalogSheet([`${SERVICE_HEADER};${Array.from({ length: 12 }, (_, index) => `${"X".repeat(5_000)}${index}`).join(";")}`, row({})].join("\n"));
    expect(Array.from(header.fatal!).length).toBeLessThanOrEqual(1000);
    expect(header.fatal).toContain("… e mais 7 coluna(s) desconhecida(s).");
    // Worst case (only junk columns, every expected one missing, junk repeated): still one line within the cap.
    const junk = Array.from({ length: 20 }, () => "Y".repeat(500)).join(";");
    const worst = parseCatalogSheet(`${junk};${junk}\nA`);
    expect(Array.from(worst.fatal!).length).toBeLessThanOrEqual(1000);
    expect(worst.fatal).toContain('Coluna obrigatória ausente no cabeçalho: "codigo".');
  });

  it("keeps the analyte lists of a large panel replacement within the contract cap of a changes line", () => {
    const panel = "PANEL_L;Painel L;LABORATORY;LABORATORY;LABORATORY;sim;;não;não;NUMERIC_PANEL;8;4;2;sim";
    const code = (prefix: string, index: number) => `${prefix}_${String(index).padStart(3, "0")}_${"X".repeat(50)}`;
    const lines = (prefix: string, required: boolean) => Array.from({ length: 70 }, (_, index) => `PANEL_L;${code(prefix, index)};Analito ${index};texto;;${required ? "sim" : "não"};${index + 1};;;`);
    const base = state();
    const first = planCatalogImport(base, parseCatalogSheet(serviceSheet(panel)), parseAnalyteSheet(analyteSheet(...lines("OLD", true))));
    const stored = { ...base, services: [...base.services, { id: "service-l", ...first.writes[0]!.next, version: 1 }] };
    const plan = planCatalogImport(stored, parseCatalogSheet(serviceSheet(panel)), parseAnalyteSheet(analyteSheet(...lines("NEW", false))));
    const changes = plan.rows[0]!.changes!;
    for (const line of changes) expect(Array.from(line).length).toBeLessThanOrEqual(MAX_CATALOG_CHANGE_LENGTH);
    const removed = changes.find((line) => line.startsWith("analitos removidos: "))!;
    const included = changes.find((line) => line.startsWith("analitos incluídos: "))!;
    const shownRemoved = removed.split(", ").length - 1;
    expect(removed).toMatch(new RegExp(`^analitos removidos: ${code("OLD", 0)} \\(obrigatório\\), .*, … e mais ${70 - shownRemoved}$`));
    expect(included).toMatch(/, … e mais \d+$/);
    // The structured list keeps every removed analyte for the screen and the CLI.
    expect(plan.rows[0]!.removedAnalytes).toHaveLength(70);
    expect(plan.writes[0]!.changes).toEqual(changes);
  });

  it("replaces the fixture panel (synthetic ranges) by the sheet panel with a version bump", () => {
    const plan = planCatalogImport(state(), parseCatalogSheet(serviceSheet("HEMOGRAM;Hemograma;LABORATORY;LABORATORY;LABORATORY;sim;;não;não;NUMERIC_PANEL;8;4;2;sim")), parseAnalyteSheet(analyteSheet("HEMOGRAM;HEMOGLOBIN;Hemoglobina;numerico;g/dL;sim;1;;;")));
    expect(plan.writes[0]!.next.resultTemplate).toMatchObject({ code: "HEMOGRAM", version: 2 });
    const kept = planCatalogImport(state(), parseCatalogSheet(serviceSheet("HEMOGRAM;Hemograma;LABORATORY;LABORATORY;LABORATORY;sim;;não;não;NUMERIC_PANEL;8;4;2;sim")));
    expect(kept.rows[0]!.action).toBe("UNCHANGED");
  });

  it("requires analytes for a new numeric panel and rejects them on narrative or imaging exams", () => {
    const base = state();
    const missing = planCatalogImport(base, parseCatalogSheet(serviceSheet("NEW_PANEL;Novo;LABORATORY;LABORATORY;LABORATORY;sim;;não;não;NUMERIC_PANEL;8;4;2;sim")));
    expect(missing.rows[0]!.errors?.[0]).toContain("exige linhas de analitos");
    const narrative = planCatalogImport(base, parseCatalogSheet(serviceSheet(GLUCOSE)), parseAnalyteSheet(analyteSheet("GLUCOSE;GLU;Glicose;numerico;mg/dL;sim;1;;;")));
    expect(narrative.rows[0]!.errors?.[0]).toContain("esquema_resultado NARRATIVE");
    const imaging = planCatalogImport(base, parseCatalogSheet(serviceSheet("IMG_PANEL;Img;IMAGING;RADIOLOGY;RADIOLOGY;não;;não;sim;NUMERIC_PANEL;8;4;2;sim")), parseAnalyteSheet(analyteSheet("IMG_PANEL;A;A;numerico;u;sim;1;;;")));
    expect(imaging.rows[0]!.errors?.join()).toContain("painel numérico exige");
  });

  it("flags analyte rows for exams outside the sheet, duplicates and unreadable rows", () => {
    const plan = planCatalogImport(state(), parseCatalogSheet(serviceSheet("PANEL_X;Painel X;LABORATORY;LABORATORY;LABORATORY;sim;;não;não;NUMERIC_PANEL;8;4;2;sim")), parseAnalyteSheet(analyteSheet(
      "PANEL_X;A;A;numerico;u;sim;1;;;",
      "PANEL_X;A;A;numerico;u;sim;2;;;",
      "OTHER_EXAM;A;A;numerico;u;sim;1;;;",
      "PANEL_X;B;B;numerico;;sim;1;;;"
    )));
    expect(plan.rows.map((row) => `${row.line}:${row.action}`)).toEqual(["2:CREATE", "3:ERROR", "4:ERROR", "5:ERROR"]);
    expect(plan.rows[1]!.errors?.[0]).toContain("repetido");
    expect(plan.rows[2]!.errors?.[0]).toContain("não consta na planilha de exames");
    expect(plan.rows[3]!.errors?.[0]).toContain("Planilha de analitos:");
    const onlyBroken = planCatalogImport(state(), parseCatalogSheet(serviceSheet("PANEL_Y;Painel Y;LABORATORY;LABORATORY;LABORATORY;sim;;não;não;NUMERIC_PANEL;8;4;2;sim")), parseAnalyteSheet(analyteSheet("PANEL_Y;B;B;numerico;;sim;1;;;")));
    expect(onlyBroken.rows[0]).toMatchObject({ code: "PANEL_Y", action: "ERROR", errors: [expect.stringContaining("Corrija as linhas de analitos")] });
  });
});
