"use client";

import { useRef, useState, type ChangeEvent } from "react";
import { ActionButton } from "@cvg/ui";
import { apiFetch, getSafeErrorMessage } from "./api-client";
import { Icon } from "./ui-icons";

type ImportAction = "CREATE" | "UPDATE" | "UNCHANGED" | "ERROR";
interface RemovedAnalyte { code: string; label: string; required: boolean }
interface ImportRow { line: number; code: string; action: ImportAction; changes?: string[]; errors?: string[]; removedAnalytes?: RemovedAnalyte[] }
export interface CatalogImportReport { applied: boolean; dryRun: boolean; summary: { create: number; update: number; unchanged: number; error: number }; rows: ImportRow[] }

const ACTION_LABELS: Record<ImportAction, string> = { CREATE: "Criar", UPDATE: "Atualizar", UNCHANGED: "Sem mudança", ERROR: "Erro" };
const removalText = (removed: RemovedAnalyte[]): string => `Remove: ${removed.map((analyte) => analyte.required ? `${analyte.code} (obrigatório)` : analyte.code).join(", ")}`;
const MAX_FILE_BYTES = 900_000;

class FileProblem extends Error {}

function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new FileProblem("Não foi possível ler o arquivo."));
    reader.readAsText(file, "utf-8");
  });
}

/**
 * D10: validate (dry run) and apply the catalog CSV templates. Applying is only possible after a clean validation of
 * the same content: the file inputs are locked while a request runs, and a validation whose selection changed while
 * it ran is discarded (REM-01), so "Aplicar" never sends a sheet other than the one on screen.
 */
export function CatalogImportPanel({ onApplied }: { onApplied: () => void }) {
  const [servicesFile, setServicesFile] = useState<File | null>(null);
  const [analytesFile, setAnalytesFile] = useState<File | null>(null);
  const [validated, setValidated] = useState<{ report: CatalogImportReport; services: string; analytes?: string } | null>(null);
  const [busy, setBusy] = useState<"validate" | "apply" | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  // Bumped on every file selection; a validation only lands if the selection is still the one it read.
  const selection = useRef(0);

  function pick(setter: (file: File | null) => void) {
    return (event: ChangeEvent<HTMLInputElement>) => {
      selection.current += 1;
      setter(event.target.files?.[0] ?? null);
      setValidated(null); setError(""); setMessage("");
    };
  }

  async function validate() {
    if (!servicesFile) return;
    const started = selection.current;
    const current = () => selection.current === started;
    setBusy("validate"); setError(""); setMessage(""); setValidated(null);
    try {
      if (servicesFile.size > MAX_FILE_BYTES || (analytesFile?.size ?? 0) > MAX_FILE_BYTES) throw new FileProblem("Arquivo grande demais: divida a planilha em partes de até 900 KB.");
      const services = await readFileText(servicesFile);
      const analytes = analytesFile ? await readFileText(analytesFile) : undefined;
      const report = await apiFetch<CatalogImportReport>("/diagnostic-services/import", { method: "POST", body: JSON.stringify({ services, ...(analytes === undefined ? {} : { analytes }), dryRun: true }) });
      if (current()) setValidated({ report, services, ...(analytes === undefined ? {} : { analytes }) });
    } catch (cause) {
      if (current()) setError(cause instanceof FileProblem ? cause.message : getSafeErrorMessage(cause, "Não foi possível validar a planilha."));
    } finally { setBusy(null); }
  }

  async function apply() {
    if (!validated || validated.report.summary.error > 0) return;
    setBusy("apply"); setError("");
    try {
      const report = await apiFetch<CatalogImportReport>("/diagnostic-services/import", { method: "POST", body: JSON.stringify({ services: validated.services, ...(validated.analytes === undefined ? {} : { analytes: validated.analytes }), dryRun: false }) });
      setValidated(null);
      setMessage(`Importação aplicada: ${report.summary.create} criado(s), ${report.summary.update} atualizado(s), ${report.summary.unchanged} sem mudança.`);
      onApplied();
    } catch (cause) {
      setError(getSafeErrorMessage(cause, "Não foi possível aplicar a importação."));
    } finally { setBusy(null); }
  }

  const report = validated?.report;
  const losingExams = report ? report.rows.filter((row) => (row.removedAnalytes?.length ?? 0) > 0).length : 0;
  return <details className="admin-create"><summary><Icon name="table" size={14} /> Importar catálogo por planilha</summary>
    <div className="admin-create-form">
      <p className="page-lede">Baixe os modelos, preencha no Excel e salve como CSV. A importação valida tudo antes de gravar e pode ser repetida.</p>
      <p><a href="/templates/catalogo-exames.csv" download>Baixar modelo de exames (CSV)</a> · <a href="/templates/catalogo-analitos.csv" download>Baixar modelo de analitos (CSV)</a></p>
      <label>Planilha de exames (.csv)<input type="file" accept=".csv,text/csv" disabled={busy !== null} onChange={pick(setServicesFile)} /></label>
      <label>Planilha de analitos (.csv, opcional)<input type="file" accept=".csv,text/csv" disabled={busy !== null} onChange={pick(setAnalytesFile)} /></label>
      <ActionButton type="button" tone="ghost" state={busy === "validate" ? "pending" : "idle"} disabled={!servicesFile || busy !== null} onClick={() => void validate()}>{busy === "validate" ? "Validando…" : "Validar"}</ActionButton>
      {error && <p className="form-alert" role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      {report && <>
        <p role="status">Resultado da validação: {report.summary.create} a criar, {report.summary.update} a atualizar, {report.summary.unchanged} sem mudança, {report.summary.error} com erro.{losingExams > 0 ? ` ${losingExams} ${losingExams === 1 ? "exame perde" : "exames perdem"} analitos: confira a coluna Detalhes antes de aplicar.` : ""}{report.summary.error > 0 ? " Corrija as linhas com erro e valide novamente; nada é gravado enquanto houver erro." : ""}</p>
        <div className="laboratory-table-wrap"><table className="laboratory-table"><caption className="sr-only">Resultado da validação da planilha</caption><thead><tr><th scope="col">Linha</th><th scope="col">Código</th><th scope="col">Ação</th><th scope="col">Detalhes</th></tr></thead><tbody>{report.rows.map((row, index) => <tr key={`${row.line}:${row.code}:${index}`}><td>{row.line}</td><th scope="row">{row.code || "—"}</th><td>{ACTION_LABELS[row.action]}</td><td>{[...(row.changes ?? []).filter((line) => !(row.removedAnalytes?.length && line.startsWith("analitos removidos:"))), ...(row.removedAnalytes?.length ? [removalText(row.removedAnalytes)] : []), ...(row.errors ?? [])].join(" · ") || "—"}</td></tr>)}</tbody></table></div>
        <ActionButton type="button" state={busy === "apply" ? "pending" : "idle"} disabled={report.summary.error > 0 || busy !== null} onClick={() => void apply()}>{busy === "apply" ? "Aplicando…" : "Aplicar importação"}</ActionButton>
      </>}
    </div>
  </details>;
}
