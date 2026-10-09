import type { LaboratoryAnalyteDefinition, LaboratoryPanelTemplate, LaboratoryValueType, Priority, WorkflowType } from "@cvg/contracts";
import type { DiagnosticService, StoreState } from "../domain/models";
import type { CatalogImportRemovedAnalyte, CatalogImportAction, CatalogImportReport, CatalogImportRow, CatalogImportSummary } from "./service-types";
import { validateServiceDefinition, validateServiceResultSchema, validatedSlaHours } from "./service-common";

/**
 * Catalog import (PROD-407 / D10): pure parsing and planning of the CSV templates. Nothing here touches the
 * store; the management service applies the plan inside one transaction.
 */

export const CATALOG_SERVICE_COLUMNS = ["codigo", "nome", "categoria", "setor", "fluxo", "exige_amostra", "tipo_amostra", "exige_agenda", "permite_anexo", "esquema_resultado", "sla_rotina_h", "sla_urgente_h", "sla_emergencia_h", "ativo"] as const;
export const CATALOG_ANALYTE_COLUMNS = ["codigo_exame", "codigo_analito", "nome", "tipo_valor", "unidade", "obrigatorio", "ordem", "referencia_minima", "referencia_maxima", "observacao"] as const;

export const MAX_CATALOG_SERVICE_ROWS = 2000;
export const MAX_CATALOG_ANALYTE_ROWS = 10000;
const PENDING_RANGE_NOTE = "Faixa dependente de aprovação clínica e população atendida.";
const EXAMPLE_PREFIX = "EXEMPLO_";
const EXAMPLE_MESSAGE = 'Linha de exemplo do modelo (código iniciado por "EXEMPLO_"): apague-a ou troque o código antes de importar.';
const IN_USE_MESSAGE = "A estrutura deste serviço já está referenciada por solicitações e não pode ser alterada.";

export interface CsvRecord { line: number; cells: string[] }

export class CsvSyntaxError extends Error {
  constructor(message: string, public readonly line: number) {
    super(message);
    this.name = "CsvSyntaxError";
  }
}

/** Picks `;` (Brazilian Excel) or `,` from the first non-empty line, ignoring quoted text. */
export function detectDelimiter(text: string): ";" | "," {
  let inQuotes = false;
  let semicolons = 0;
  let commas = 0;
  for (const char of text.replace(/^﻿/, "")) {
    if (char === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (char === "\n" || char === "\r")) { if (semicolons + commas > 0) break; }
    else if (!inQuotes && char === ";") semicolons += 1;
    else if (!inQuotes && char === ",") commas += 1;
  }
  return semicolons >= commas && semicolons > 0 ? ";" : ",";
}

/** RFC 4180 reader: quoted cells, doubled quotes, embedded newlines, BOM, CRLF; trims cells and drops empty lines. */
export function parseCsv(text: string, delimiter: string = detectDelimiter(text)): CsvRecord[] {
  const source = text.replace(/^﻿/, "");
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let cell = "";
  let inQuotes = false;
  let quoted = false;
  let line = 1;
  let startLine = 1;
  const endCell = () => { cells.push(cell.trim()); cell = ""; quoted = false; };
  const endRecord = () => {
    endCell();
    if (cells.some((entry) => entry !== "")) records.push({ line: startLine, cells });
    cells = [];
  };
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (inQuotes) {
      if (char === '"') {
        if (source[index + 1] === '"') { cell += '"'; index += 1; } else inQuotes = false;
      } else {
        if (char === "\n") line += 1;
        cell += char;
      }
      continue;
    }
    if (char === '"' && cell.trim() === "" && !quoted) { inQuotes = true; quoted = true; cell = ""; continue; }
    if (char === delimiter) { endCell(); continue; }
    if (char === "\r" || char === "\n") {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      endRecord();
      line += 1;
      startLine = line;
      continue;
    }
    cell += char;
  }
  if (inQuotes) throw new CsvSyntaxError(`Aspas abertas sem fechamento na linha ${startLine}.`, startLine);
  endRecord();
  return records;
}

export interface ParsedRow<T> { line: number; code: string; errors: string[]; value?: T }
export interface ParsedSheet<T> { fatal?: string; rows: ParsedRow<T>[] }

export interface CatalogServiceRow {
  code: string;
  name: string;
  category: DiagnosticService["category"];
  departmentCode: string;
  workflowType: WorkflowType;
  requiresSample: boolean;
  sampleType?: string;
  requiresSchedule: boolean;
  allowsAttachment: boolean;
  resultSchema: DiagnosticService["resultSchema"];
  slaHours: Record<Priority, number>;
  active: boolean;
}

export interface CatalogAnalyteRow {
  serviceCode: string;
  code: string;
  label: string;
  valueType: LaboratoryValueType;
  unitCode: string;
  required: boolean;
  displayOrder?: number;
  low?: number;
  high?: number;
  note?: string;
}

const fold = (value: string): string => value.normalize("NFD").replace(/\p{M}/gu, "").trim().toLowerCase();

/**
 * A cell echoed in a message keeps at most 40 characters: a 20,000-character cell used to become a 20,000-character
 * error, past the 1000-character contract cap of a report line and unreadable on screen.
 */
const MAX_ECHOED_CHARACTERS = 40;
function quoted(raw: string): string {
  const characters = Array.from(raw);
  return `"${characters.length <= MAX_ECHOED_CHARACTERS ? raw : `${characters.slice(0, MAX_ECHOED_CHARACTERS).join("")}…`}"`;
}

/** The report's `code` of a row (contract cap 100); valid codes have at most 60 characters, so only junk is cut. */
const rowCode = (code: string): string => Array.from(code).slice(0, 100).join("");

/** At most five unknown or repeated header columns are named, the rest counted (the missing ones are at most 14). */
function firstFive(problems: readonly string[], noun: string): string[] {
  return problems.length <= 5 ? [...problems] : [...problems.slice(0, 5), `… e mais ${problems.length - 5} ${noun}.`];
}

/** A whole-sheet message is one report line: kept within the same contract cap as a `changes` line. */
const capped = (message: string): string => Array.from(message).length <= MAX_CATALOG_CHANGE_LENGTH ? message : `${Array.from(message).slice(0, MAX_CATALOG_CHANGE_LENGTH - 1).join("")}…`;

function parseBoolean(raw: string, column: string, errors: string[], fallback?: boolean): boolean {
  const value = fold(raw);
  if (["sim", "s", "true", "1", "yes", "y"].includes(value)) return true;
  if (["nao", "n", "false", "0", "no"].includes(value)) return false;
  if (value === "" && fallback !== undefined) return fallback;
  errors.push(`Coluna "${column}": informe sim/não, s/n, true/false ou 1/0 (recebido ${quoted(raw)}).`);
  return false;
}

function parseEnum<T extends string>(raw: string, column: string, allowed: readonly T[], aliases: Record<string, T>, errors: string[]): T {
  const value = fold(raw).toUpperCase().replace(/[\s-]+/g, "_");
  const direct = allowed.find((entry) => entry === value);
  const resolved = direct ?? aliases[fold(raw).replace(/[\s-]+/g, "_")];
  if (!resolved) errors.push(`Coluna "${column}": valor ${quoted(raw)} inválido; use ${allowed.join(", ")}.`);
  return resolved ?? allowed[0]!;
}

function parseDecimal(raw: string, column: string, errors: string[]): number | undefined {
  if (raw === "") return undefined;
  if (!/^-?\d+([.,]\d+)?$/.test(raw)) { errors.push(`Coluna "${column}": ${quoted(raw)} não é um número válido.`); return undefined; }
  return Number(raw.replace(",", "."));
}

function parseInteger(raw: string, column: string, min: number, max: number, errors: string[]): number {
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    errors.push(`Coluna "${column}": informe um número inteiro entre ${min} e ${max} (recebido ${quoted(raw)}).`);
    return min;
  }
  return Number(raw);
}

function readSheet<T>(text: string, columns: readonly string[], maxRows: number, build: (get: (column: string) => string, errors: string[]) => { code: string; value: T }): ParsedSheet<T> {
  let records: CsvRecord[];
  try {
    records = parseCsv(text);
  } catch (error) {
    return { fatal: error instanceof CsvSyntaxError ? error.message : "Não foi possível ler o arquivo CSV.", rows: [] };
  }
  const header = records[0];
  if (!header) return { fatal: "A planilha está vazia: informe a linha de cabeçalho e ao menos uma linha de dados.", rows: [] };
  const names = header.cells.map(fold);
  const unknown = header.cells.filter((cell, index) => !columns.includes(names[index]!));
  const missing = columns.filter((column) => !names.includes(column));
  const duplicated = names.filter((name, index) => names.indexOf(name) !== index);
  const problems = [
    ...firstFive(unknown.map((cell) => `Coluna desconhecida no cabeçalho: ${quoted(cell)}.`), "coluna(s) desconhecida(s)"),
    ...missing.map((column) => `Coluna obrigatória ausente no cabeçalho: "${column}".`),
    ...firstFive(duplicated.map((name) => `Coluna repetida no cabeçalho: ${quoted(name)}.`), "coluna(s) repetida(s)")
  ];
  if (problems.length > 0) return { fatal: capped(`Cabeçalho inválido na linha ${header.line}. ${problems.join(" ")} Colunas esperadas: ${columns.join(";")}.`), rows: [] };
  const dataRecords = records.slice(1);
  if (dataRecords.length > maxRows) return { fatal: `A planilha excede o limite de ${maxRows} linhas por importação.`, rows: [] };
  const rows = dataRecords.map((record): ParsedRow<T> => {
    const errors: string[] = [];
    if (record.cells.length !== names.length) {
      return { line: record.line, code: rowCode(fold(record.cells[0] ?? "").toUpperCase()), errors: [`A linha tem ${record.cells.length} colunas; o cabeçalho tem ${names.length}. Se um texto contém o separador, coloque-o entre aspas.`] };
    }
    const get = (column: string): string => record.cells[names.indexOf(column)] ?? "";
    const built = build(get, errors);
    return errors.length > 0 ? { line: record.line, code: rowCode(built.code), errors } : { line: record.line, code: built.code, errors, value: built.value };
  });
  return { rows };
}

const CATEGORY_ALIASES: Record<string, "LABORATORY" | "IMAGING"> = { laboratorio: "LABORATORY", imagem: "IMAGING", imagens: "IMAGING", imagem_diagnostica: "IMAGING" };
const WORKFLOW_ALIASES: Record<string, WorkflowType> = { laboratorio: "LABORATORY", radiologia: "RADIOLOGY", raio_x: "RADIOLOGY", ultrassom: "ULTRASOUND", ultrassonografia: "ULTRASOUND" };
const SCHEMA_ALIASES: Record<string, DiagnosticService["resultSchema"]> = { painel_numerico: "NUMERIC_PANEL", painel: "NUMERIC_PANEL", narrativo: "NARRATIVE", laudo: "NARRATIVE" };
const VALUE_TYPE_ALIASES: Record<string, LaboratoryValueType> = { numerico: "NUMERIC", qualitativo: "QUALITATIVE", texto: "TEXT" };

export function parseCatalogSheet(text: string): ParsedSheet<CatalogServiceRow> {
  return readSheet<CatalogServiceRow>(text, CATALOG_SERVICE_COLUMNS, MAX_CATALOG_SERVICE_ROWS, (get, errors) => {
    const code = get("codigo").toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{1,59}$/.test(code)) errors.push('Coluna "codigo": use 2 a 60 caracteres (letras maiúsculas, números e _), começando por letra.');
    if (code.startsWith(EXAMPLE_PREFIX)) errors.push(EXAMPLE_MESSAGE);
    const name = get("nome");
    if (!name || Array.from(name).length > 120) errors.push('Coluna "nome": obrigatório, até 120 caracteres.');
    const departmentCode = get("setor").toUpperCase();
    if (!/^[A-Z0-9_-]{1,60}$/.test(departmentCode)) errors.push('Coluna "setor": informe o código do setor (letras, números, _ ou -).');
    const requiresSample = parseBoolean(get("exige_amostra"), "exige_amostra", errors);
    const sampleType = get("tipo_amostra");
    if (Array.from(sampleType).length > 60) errors.push('Coluna "tipo_amostra": até 60 caracteres.');
    if (sampleType && !requiresSample) errors.push('Coluna "tipo_amostra": só pode ser preenchida em exames que exigem amostra.');
    const slaHours = {
      ROUTINE: parseInteger(get("sla_rotina_h"), "sla_rotina_h", 1, 720, errors),
      URGENT: parseInteger(get("sla_urgente_h"), "sla_urgente_h", 1, 720, errors),
      EMERGENCY: parseInteger(get("sla_emergencia_h"), "sla_emergencia_h", 1, 720, errors)
    };
    const value: CatalogServiceRow = {
      code,
      name,
      category: parseEnum(get("categoria"), "categoria", ["LABORATORY", "IMAGING"], CATEGORY_ALIASES, errors),
      departmentCode,
      workflowType: parseEnum(get("fluxo"), "fluxo", ["LABORATORY", "RADIOLOGY", "ULTRASOUND"], WORKFLOW_ALIASES, errors),
      requiresSample,
      ...(sampleType ? { sampleType } : {}),
      requiresSchedule: parseBoolean(get("exige_agenda"), "exige_agenda", errors),
      allowsAttachment: parseBoolean(get("permite_anexo"), "permite_anexo", errors),
      resultSchema: parseEnum(get("esquema_resultado"), "esquema_resultado", ["NUMERIC_PANEL", "NARRATIVE"], SCHEMA_ALIASES, errors),
      slaHours,
      active: parseBoolean(get("ativo"), "ativo", errors, true)
    };
    return { code, value };
  });
}

export function parseAnalyteSheet(text: string): ParsedSheet<CatalogAnalyteRow> {
  return readSheet<CatalogAnalyteRow>(text, CATALOG_ANALYTE_COLUMNS, MAX_CATALOG_ANALYTE_ROWS, (get, errors) => {
    const serviceCode = get("codigo_exame").toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{1,59}$/.test(serviceCode)) errors.push('Coluna "codigo_exame": código de exame inválido.');
    if (serviceCode.startsWith(EXAMPLE_PREFIX)) errors.push(EXAMPLE_MESSAGE);
    const code = get("codigo_analito").toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{0,59}$/.test(code)) errors.push('Coluna "codigo_analito": use até 60 caracteres (letras maiúsculas, números e _), começando por letra.');
    const label = get("nome");
    if (!label || Array.from(label).length > 120) errors.push('Coluna "nome": obrigatório, até 120 caracteres.');
    const valueType = parseEnum(get("tipo_valor"), "tipo_valor", ["NUMERIC", "QUALITATIVE", "TEXT"], VALUE_TYPE_ALIASES, errors);
    const unit = get("unidade");
    if (valueType === "NUMERIC" && !unit) errors.push('Coluna "unidade": obrigatória para analitos numéricos.');
    if (Array.from(unit).length > 30) errors.push('Coluna "unidade": até 30 caracteres.');
    const rawOrder = get("ordem");
    const displayOrder = rawOrder === "" ? undefined : parseInteger(rawOrder, "ordem", 1, 1000, errors);
    const low = parseDecimal(get("referencia_minima"), "referencia_minima", errors);
    const high = parseDecimal(get("referencia_maxima"), "referencia_maxima", errors);
    if ((low !== undefined || high !== undefined) && valueType !== "NUMERIC") errors.push("Faixa de referência só se aplica a analitos numéricos.");
    if (low !== undefined && high !== undefined && low > high) errors.push('A "referencia_minima" não pode ser maior que a "referencia_maxima".');
    const note = get("observacao");
    if (Array.from(note).length > 500) errors.push('Coluna "observacao": até 500 caracteres.');
    const value: CatalogAnalyteRow = {
      serviceCode,
      code,
      label,
      valueType,
      unitCode: unit || "TEXT",
      required: parseBoolean(get("obrigatorio"), "obrigatorio", errors),
      ...(displayOrder === undefined ? {} : { displayOrder }),
      ...(low === undefined ? {} : { low }),
      ...(high === undefined ? {} : { high }),
      ...(note ? { note } : {})
    };
    return { code: serviceCode, value };
  });
}

export type { CatalogImportRemovedAnalyte, CatalogImportAction, CatalogImportReport, CatalogImportRow, CatalogImportSummary };

export interface CatalogImportWrite {
  action: "CREATE" | "UPDATE";
  line: number;
  code: string;
  existingId?: string;
  changes: string[];
  next: Omit<DiagnosticService, "id" | "version">;
}
export interface CatalogImportPlan extends CatalogImportReport { writes: CatalogImportWrite[] }
export interface CatalogImportPlanOptions { canManageDepartment?: (departmentCode: string) => boolean }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a < b ? -1 : 1).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function analyteDefinition(row: CatalogAnalyteRow, position: number): LaboratoryAnalyteDefinition {
  const hasRange = row.low !== undefined || row.high !== undefined;
  const note = row.note ?? (row.valueType === "NUMERIC" ? PENDING_RANGE_NOTE : "Não interpretado clinicamente.");
  return {
    code: row.code,
    label: row.label,
    valueType: row.valueType,
    unitCode: row.unitCode,
    required: row.required,
    displayOrder: row.displayOrder ?? position,
    referenceRange: hasRange
      ? { kind: "NUMERIC", unitCode: row.unitCode, ...(row.low === undefined ? {} : { low: row.low }), ...(row.high === undefined ? {} : { high: row.high }), source: "HUMAN_APPROVED", ...(row.note ? { note: row.note } : {}) }
      : { kind: "PENDING_POLICY", unitCode: row.unitCode, source: "PENDING_HUMAN_POLICY", note }
  };
}

function buildTemplate(service: CatalogServiceRow, analytes: CatalogAnalyteRow[], existing: LaboratoryPanelTemplate | undefined): { template: LaboratoryPanelTemplate; changed: boolean } {
  const definitions = analytes.map((row, index) => analyteDefinition(row, index + 1)).sort((a, b) => a.displayOrder - b.displayOrder);
  const base = { kind: "LABORATORY_PANEL" as const, code: service.code, name: service.name, schemaVersion: existing?.schemaVersion ?? "1.0", status: "ACTIVE" as const, analytes: definitions };
  const unchanged = existing && existing.status === "ACTIVE" && canonical({ ...base, version: 0 }) === canonical({ ...existing, version: 0 });
  return unchanged ? { template: existing, changed: false } : { template: { ...base, version: (existing?.version ?? 0) + 1 }, changed: true };
}

const FIELD_LABELS: Array<[keyof CatalogServiceRow, string]> = [["name", "nome"], ["category", "categoria"], ["departmentCode", "setor"], ["workflowType", "fluxo"], ["requiresSample", "exige_amostra"], ["sampleType", "tipo_amostra"], ["requiresSchedule", "exige_agenda"], ["allowsAttachment", "permite_anexo"], ["resultSchema", "esquema_resultado"], ["active", "ativo"]];
const STRUCTURAL_FIELDS = new Set<keyof CatalogServiceRow>(["category", "departmentCode", "workflowType", "requiresSample", "requiresSchedule", "resultSchema"]);
const SLA_LABELS: Array<[Priority, string]> = [["ROUTINE", "sla_rotina_h"], ["URGENT", "sla_urgente_h"], ["EMERGENCY", "sla_emergencia_h"]];

const show = (value: unknown): string => value === undefined || value === "" ? "(vazio)" : typeof value === "boolean" ? (value ? "sim" : "não") : String(value);

/** Longest line the report contract accepts (CatalogImportReport.rows[].changes[] and errors[], maxLength). */
export const MAX_CATALOG_CHANGE_LENGTH = 1000;

/**
 * "prefix: a, b, c" within the contract cap: entries that do not fit become "… e mais N". Only the
 * analyte lists can grow past it (a panel of 60+ long codes); the full removed list stays in `removedAnalytes`.
 */
function listChange(prefix: string, entries: readonly string[]): string {
  const fits = (line: string) => Array.from(line).length <= MAX_CATALOG_CHANGE_LENGTH;
  const full = `${prefix}: ${entries.join(", ")}`;
  if (fits(full)) return full;
  const shown: string[] = [];
  for (const entry of entries) {
    if (!fits(`${prefix}: ${[...shown, entry, `… e mais ${entries.length - shown.length - 1}`].join(", ")}`)) break;
    shown.push(entry);
  }
  return `${prefix}: ${[...shown, `… e mais ${entries.length - shown.length}`].join(", ")}`;
}

function errorRow(line: number, code: string, ...errors: string[]): CatalogImportRow { return { line, code, action: "ERROR", errors }; }

/** Compares the sheet against the current catalog. The sheet is authoritative only for the fields it carries. */
export function planCatalogImport(state: StoreState, sheet: ParsedSheet<CatalogServiceRow>, analytesSheet?: ParsedSheet<CatalogAnalyteRow>, options: CatalogImportPlanOptions = {}): CatalogImportPlan {
  const canManage = options.canManageDepartment ?? (() => true);
  const finish = (rows: CatalogImportRow[], writes: CatalogImportWrite[]): CatalogImportPlan => ({
    rows,
    writes,
    summary: {
      create: rows.filter((row) => row.action === "CREATE").length,
      update: rows.filter((row) => row.action === "UPDATE").length,
      unchanged: rows.filter((row) => row.action === "UNCHANGED").length,
      error: rows.filter((row) => row.action === "ERROR").length
    }
  });
  const fatal = [sheet.fatal, analytesSheet?.fatal ? capped(`Planilha de analitos: ${analytesSheet.fatal}`) : undefined].filter((entry): entry is string => entry !== undefined);
  if (fatal.length > 0) return finish(fatal.map((message) => errorRow(1, "", message)), []);

  const analyteRows: Array<ParsedRow<CatalogAnalyteRow>> = analytesSheet?.rows ?? [];
  const analyteIssueRows: CatalogImportRow[] = [];
  const rows: CatalogImportRow[] = [];
  const writes: CatalogImportWrite[] = [];
  const sheetCodes = new Map<string, number>();
  for (const row of sheet.rows) if (row.code && !sheetCodes.has(row.code)) sheetCodes.set(row.code, row.line);
  const analyteErrorCodes = new Set<string>();
  const analytesByService = new Map<string, Array<ParsedRow<CatalogAnalyteRow> & { value: CatalogAnalyteRow }>>();
  const seenAnalytes = new Set<string>();
  for (const row of analyteRows) {
    if (row.errors.length > 0 || !row.value) {
      analyteErrorCodes.add(row.code);
      analyteIssueRows.push(errorRow(row.line, row.code, ...row.errors.map((message) => `Planilha de analitos: ${message}`)));
      continue;
    }
    const key = `${row.value.serviceCode}/${row.value.code}`;
    const problem = !sheetCodes.has(row.value.serviceCode) ? `o exame ${row.value.serviceCode} não consta na planilha de exames.`
      : seenAnalytes.has(key) ? `o analito ${row.value.code} está repetido para o exame ${row.value.serviceCode}.`
        : undefined;
    if (problem) {
      analyteErrorCodes.add(row.value.serviceCode);
      analyteIssueRows.push(errorRow(row.line, row.value.serviceCode, `Planilha de analitos: ${problem}`));
      continue;
    }
    seenAnalytes.add(key);
    analytesByService.set(row.value.serviceCode, [...(analytesByService.get(row.value.serviceCode) ?? []), { ...row, value: row.value }]);
  }

  const existingByCode = new Map(state.services.map((service) => [service.code, service]));
  const referenced = new Set(state.items.map((item) => item.serviceId));
  const handled = new Set<string>();
  for (const parsed of sheet.rows) {
    if (parsed.errors.length > 0 || !parsed.value) { rows.push(errorRow(parsed.line, parsed.code, ...parsed.errors)); continue; }
    const wanted = parsed.value;
    if (handled.has(wanted.code)) {
      rows.push(errorRow(parsed.line, wanted.code, `Código repetido na planilha (primeira ocorrência na linha ${sheetCodes.get(wanted.code)}).`));
      continue;
    }
    handled.add(wanted.code);
    const errors: string[] = [];
    const existing = existingByCode.get(wanted.code);
    for (const department of new Set([wanted.departmentCode, existing?.departmentCode])) {
      if (department && !canManage(department)) errors.push(`Você não tem permissão para gerenciar o catálogo do setor ${department}.`);
    }
    try { validateServiceDefinition(wanted.category, wanted.workflowType); } catch (error) { errors.push(messageOf(error)); }
    try { validatedSlaHours(wanted.slaHours); } catch (error) { errors.push(messageOf(error)); }

    const analytes = analytesByService.get(wanted.code) ?? [];
    let template: LaboratoryPanelTemplate | undefined;
    let templateChanged = false;
    if (wanted.resultSchema === "NARRATIVE" && analytes.length > 0) {
      errors.push("Há analitos na planilha de analitos para um exame com esquema_resultado NARRATIVE.");
    } else if (wanted.resultSchema === "NUMERIC_PANEL") {
      if (analytes.length > 0) {
        ({ template, changed: templateChanged } = buildTemplate(wanted, analytes.map((entry) => entry.value), existing?.resultTemplate));
      } else if (existing?.resultTemplate?.status === "ACTIVE") {
        template = existing.resultTemplate;
      } else {
        errors.push(analyteErrorCodes.has(wanted.code)
          ? "Corrija as linhas de analitos deste exame na planilha de analitos."
          : "O esquema NUMERIC_PANEL exige linhas de analitos na planilha de analitos (ou um painel ativo já cadastrado).");
      }
      if (template) {
        try { validateServiceResultSchema(wanted.category, wanted.workflowType, wanted.resultSchema, template); } catch (error) { errors.push(messageOf(error)); }
      }
    }

    const changes: string[] = [];
    let removedAnalytes: CatalogImportRemovedAnalyte[] = [];
    let structural = false;
    if (existing) {
      for (const [field, label] of FIELD_LABELS) {
        if (existing[field as keyof DiagnosticService] !== wanted[field]) {
          changes.push(`${label}: ${show(existing[field as keyof DiagnosticService])} → ${show(wanted[field])}`);
          structural ||= STRUCTURAL_FIELDS.has(field);
        }
      }
      for (const [priority, label] of SLA_LABELS) {
        if (existing.slaHours[priority] !== wanted.slaHours[priority]) changes.push(`${label}: ${existing.slaHours[priority]} → ${wanted.slaHours[priority]}`);
      }
      if (templateChanged && template) {
        changes.push(`painel de analitos: versão ${existing.resultTemplate?.version ?? 0} → ${template.version} (${template.analytes.length} analitos)`);
        const nextCodes = new Set(template.analytes.map((analyte) => analyte.code));
        const previousCodes = new Set((existing.resultTemplate?.analytes ?? []).map((analyte) => analyte.code));
        removedAnalytes = (existing.resultTemplate?.analytes ?? []).filter((analyte) => !nextCodes.has(analyte.code)).map((analyte) => ({ code: analyte.code, label: analyte.label, required: analyte.required }));
        const added = template.analytes.filter((analyte) => !previousCodes.has(analyte.code)).map((analyte) => analyte.code);
        if (added.length > 0) changes.push(listChange("analitos incluídos", added));
        if (removedAnalytes.length > 0) changes.push(listChange("analitos removidos", removedAnalytes.map((analyte) => analyte.required ? `${analyte.code} (obrigatório)` : analyte.code)));
      }
      if (structural && referenced.has(existing.id)) errors.push(IN_USE_MESSAGE);
    } else {
      changes.push("novo exame");
      if (template) changes.push(`painel de analitos: ${template.analytes.length} analitos`);
    }
    if (errors.length > 0) { rows.push(errorRow(parsed.line, wanted.code, ...errors)); continue; }
    if (existing && changes.length === 0) { rows.push({ line: parsed.line, code: wanted.code, action: "UNCHANGED" }); continue; }
    const { code, name, category, departmentCode, workflowType, requiresSample, sampleType, requiresSchedule, allowsAttachment, resultSchema, slaHours, active } = wanted;
    const kept = wanted.resultSchema === "NUMERIC_PANEL" ? template : existing?.resultTemplate;
    writes.push({
      action: existing ? "UPDATE" : "CREATE",
      line: parsed.line,
      code,
      ...(existing ? { existingId: existing.id } : {}),
      changes,
      next: { code, name, category, departmentCode, workflowType, requiresSample, ...(sampleType ? { sampleType } : {}), requiresSchedule, allowsAttachment, active, resultSchema, ...(kept ? { resultTemplate: kept } : {}), slaHours: { ...slaHours } }
    });
    rows.push({ line: parsed.line, code: wanted.code, action: existing ? "UPDATE" : "CREATE", changes, ...(removedAnalytes.length > 0 ? { removedAnalytes } : {}) });
  }
  return finish([...rows, ...analyteIssueRows], writes);
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
