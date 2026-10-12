import type { HospitalService, HospitalServiceImportReport } from "@cvg/contracts";
import type { StoreState, User } from "../domain/models";
import { ApiError } from "../http/envelope";
import { parseCsv } from "./catalog-import";
import { catalogPermission, createHospitalServiceDefinition, updateHospitalServiceDefinition } from "./hospital-service-policy";
import { ensureExpectedVersion, id } from "./service-common";

export const HOSPITAL_SERVICE_COLUMNS = ["codigo", "nome", "tipo", "setor", "descricao", "equipe_ids", "recurso_ids", "ativo", "versao"] as const;
const split = (value: string) => value ? value.split(",").map((part) => part.trim()).filter(Boolean) : [];

export function authorizeHospitalServiceImportReplay(state: StoreState, actor: User, csv: string, report: HospitalServiceImportReport): void {
  const rows = parseCsv(csv);
  for (const outcome of report.rows) {
    const row = rows.find((entry) => entry.line === outcome.line);
    if (!row) throw new ApiError("SCOPE_DENIED", "A importação não está mais disponível.", 404);
    const departmentCode = row.cells[3].toUpperCase();
    const current = state.hospitalServices.find((entry) => entry.code === outcome.code);
    const action = outcome.action === "CREATE" ? "service.catalog.create" : "service.catalog.update";
    catalogPermission(actor, action, departmentCode);
    if (current) catalogPermission(actor, action, current.departmentCode);
    if (outcome.action === "UPDATE" && ["não", "nao", "false"].includes(row.cells[7].toLowerCase())) catalogPermission(actor, "service.catalog.deactivate", departmentCode);
  }
}

export function planHospitalServiceImport(state: StoreState, actor: User, csv: string, timestamp: string) {
  const report: HospitalServiceImportReport = { dryRun: true, applied: false, rows: [], summary: { create: 0, update: 0, unchanged: 0, error: 0 } };
  const changes: Array<{ previous?: HospitalService; next: HospitalService }> = [];
  let rows: ReturnType<typeof parseCsv>;
  try {
    rows = parseCsv(csv);
    if (rows.length < 2 || rows.length > 2001 || rows[0].cells.join(";") !== HOSPITAL_SERVICE_COLUMNS.join(";")) throw new Error("Use o modelo de serviços hospitalares com até 2000 linhas.");
  } catch (error) {
    report.rows.push({ line: 1, code: "", action: "ERROR", errors: [error instanceof Error ? error.message : "Planilha inválida."] }); report.summary.error = 1;
    return { report, changes };
  }
  const codes = new Set<string>();
  let planning = state;
  for (const row of rows.slice(1)) {
    const [code = "", name, kind, departmentCode, description, team, resources, active, version] = row.cells;
    const normalized = code.toUpperCase();
    try {
      if (row.cells.length !== HOSPITAL_SERVICE_COLUMNS.length || codes.has(normalized)) throw new ApiError("VALIDATION_ERROR", "Colunas inválidas ou código repetido na planilha.", 400);
      codes.add(normalized);
      if (!["sim", "não", "nao", "true", "false"].includes(active.toLowerCase())) throw new ApiError("VALIDATION_ERROR", "Ativo deve informar sim ou não.", 400);
      const input = { code, name, kind, departmentCode, ...(description ? { description } : {}), teamUserIds: split(team), resourceIds: split(resources), active: ["sim", "true"].includes(active.toLowerCase()) };
      const previous = planning.hospitalServices.find((entry) => entry.code === normalized);
      const { code: _code, ...fields } = input;
      const next = previous ? updateHospitalServiceDefinition(planning, actor, previous, { ...fields, expectedVersion: previous.version, description: description || null } as never, timestamp) : createHospitalServiceDefinition(planning, actor, input as never, id("hospital-service"), timestamp);
      if (previous) {
        const comparable = (service: HospitalService) => JSON.stringify([service.code, service.name, service.kind, service.departmentCode, service.description ?? "", [...service.teamUserIds].sort(), [...service.resourceIds].sort(), service.active]);
        if (comparable(previous) === comparable(next)) { report.rows.push({ line: row.line, code: normalized, action: "UNCHANGED" }); report.summary.unchanged += 1; continue; }
        ensureExpectedVersion(previous.version, version ? Number(version) : undefined);
      }
      changes.push({ previous, next });
      planning = { ...planning, hospitalServices: previous ? planning.hospitalServices.map((entry) => entry.id === previous.id ? next : entry) : [...planning.hospitalServices, next] };
      const action = previous ? "UPDATE" : "CREATE";
      report.rows.push({ line: row.line, code: normalized, action }); report.summary[previous ? "update" : "create"] += 1;
    } catch (error) {
      report.rows.push({ line: row.line, code: normalized, action: "ERROR", errors: [error instanceof ApiError ? error.message : "Não foi possível validar esta linha." ] }); report.summary.error += 1;
    }
  }
  return { report, changes };
}
