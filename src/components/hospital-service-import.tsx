"use client";
import { useRef, useState } from "react";
import type { HospitalServiceImportReport } from "@cvg/contracts";
import { apiFetch, createClientUniqueId, getSafeErrorMessage } from "./api-client";

export function HospitalServiceImport({ onSaved }: { onSaved: () => void }) {
  const [csv, setCsv] = useState(""); const [previewCsv, setPreviewCsv] = useState(""); const [report, setReport] = useState<HospitalServiceImportReport>();
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const pending = useRef(false); const intent = useRef<{ csv: string; key: string } | undefined>(undefined);
  async function submit(dryRun: boolean) {
    if (pending.current || !csv || !dryRun && (previewCsv !== csv || !report || report.summary.error > 0)) return;
    pending.current = true; setBusy(true); setError("");
    if (intent.current?.csv !== csv) intent.current = { csv, key: createClientUniqueId() };
    try {
      const result = await apiFetch<HospitalServiceImportReport>("/hospital-services/import", { method: "POST", headers: { "idempotency-key": intent.current.key }, body: JSON.stringify({ csv, dryRun }) });
      setReport(result); if (dryRun) setPreviewCsv(csv); else { intent.current = undefined; setPreviewCsv(""); onSaved(); }
    } catch (cause) { setError(getSafeErrorMessage(cause, "Não foi possível importar os serviços hospitalares.")); }
    finally { pending.current = false; setBusy(false); }
  }
  return <section className="panel" aria-label="Importar serviços hospitalares"><h2>Importar serviços hospitalares</h2><p>Use CSV separado por ponto e vírgula: codigo;nome;tipo;setor;descricao;equipe_ids;recurso_ids;ativo;versao. Para alterar serviços, informe a revisão atual. Diagnósticos são importados no catálogo de exames.</p><label>Planilha de serviços<input type="file" accept=".csv,text/csv" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (!file) return; if (file.size > 2_000_000) { setError("A planilha deve ter até 2 MB."); return; } void file.text().then((text) => { setCsv(text); setReport(undefined); setPreviewCsv(""); }).catch(() => setError("Não foi possível ler a planilha.")); }} /></label><label>Conteúdo CSV<textarea value={csv} maxLength={2_000_000} disabled={busy} onChange={(event) => { setCsv(event.target.value); setReport(undefined); setPreviewCsv(""); }} /></label><button type="button" disabled={busy || !csv} onClick={() => void submit(true)}>Validar importação</button><button type="button" disabled={busy || previewCsv !== csv || !report || report.summary.error > 0 || report.applied} onClick={() => void submit(false)}>Aplicar importação validada</button>{error && <p role="alert">{error}</p>}{report && <><p role="status">{report.applied ? "Importação aplicada" : "Prévia sem alterações"}: {report.summary.create} novos, {report.summary.update} alterações, {report.summary.unchanged} iguais, {report.summary.error} erros.</p><table><thead><tr><th>Linha</th><th>Código</th><th>Resultado</th></tr></thead><tbody>{report.rows.map((row) => <tr key={row.line}><td>{row.line}</td><td>{row.code}</td><td>{({ CREATE: "Criar", UPDATE: "Alterar", UNCHANGED: "Sem alteração", ERROR: "Erro" } as const)[row.action]}{row.errors?.length ? `: ${row.errors.join(" ")}` : ""}</td></tr>)}</tbody></table></>}</section>;
}
