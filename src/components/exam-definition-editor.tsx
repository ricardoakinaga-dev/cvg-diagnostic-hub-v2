"use client";

import { useState } from "react";
import type { DiagnosticService, ExamDefinitionVersion, LaboratoryAnalyteDefinition, Permission } from "@cvg/contracts";
import { apiFetch, getSafeErrorMessage } from "./api-client";
import { formatHospitalDateTime } from "@/lib/hospital-time";

type EditableService = Pick<DiagnosticService, "id" | "code" | "name" | "version"> & Partial<Pick<DiagnosticService, "resultTemplate" | "workflowType">>;
type AnalyteDraft = { code: string; label: string; valueType: LaboratoryAnalyteDefinition["valueType"]; unitCode: string; required: boolean; low: string; high: string; allowedValues: string };
const emptyAnalyte = (): AnalyteDraft => ({ code: "", label: "", valueType: "NUMERIC", unitCode: "", required: true, low: "", high: "", allowedValues: "" });
const split = (value: string) => [...new Set(value.split(",").map((part) => part.trim()).filter(Boolean))];
const statusLabel = { DRAFT: "Rascunho", ACTIVE: "Publicado", RETIRED: "Retirado" };

export function ExamDefinitionEditor({ service, permissions, onSaved }: { service: EditableService; permissions: readonly Permission[]; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<ExamDefinitionVersion[]>([]);
  const [selected, setSelected] = useState<ExamDefinitionVersion>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const template = service.resultTemplate;
  const [name, setName] = useState(template?.name ?? service.name);
  const [code, setCode] = useState(template?.code ?? service.code);
  const [schemaVersion] = useState(template?.schemaVersion ?? "1.0");
  const [analytes, setAnalytes] = useState<AnalyteDraft[]>(() => template?.analytes.map((entry) => ({ code: entry.code, label: entry.label, valueType: entry.valueType, unitCode: entry.unitCode, required: entry.required, low: entry.referenceRange?.low === undefined ? "" : String(entry.referenceRange.low), high: entry.referenceRange?.high === undefined ? "" : String(entry.referenceRange.high), allowedValues: entry.allowedValues?.join(", ") ?? "" })) ?? [emptyAnalyte()]);
  const [policyReference, setPolicyReference] = useState("");
  const [species, setSpecies] = useState("");
  const [sex, setSex] = useState("");
  const [minAge, setMinAge] = useState("");
  const [maxAge, setMaxAge] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [reason, setReason] = useState("");
  const canPrepare = permissions.includes("service.catalog.manage") || permissions.includes("service.catalog.update");
  const canApprove = permissions.includes("exam_definition.approve");
  const canRead = permissions.includes("service.catalog.view");
  if (service.workflowType !== "LABORATORY" || (!canPrepare && !canApprove && !canRead)) return null;

  async function toggle() {
    if (open) { setOpen(false); return; }
    setOpen(true); setError(""); setBusy(true);
    try { setHistory(await apiFetch<ExamDefinitionVersion[]>(`/diagnostic-services/${service.id}/definitions`)); }
    catch (cause) { setError(getSafeErrorMessage(cause, "Não foi possível consultar as revisões do exame.")); }
    finally { setBusy(false); }
  }
  async function command(path: string, method: string, body: Record<string, unknown>, success: string) {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try { await apiFetch(`/diagnostic-services/${service.id}/template${path}`, { method, body: JSON.stringify({ ...body, expectedVersion: service.version }) }); setNotice(success); onSaved(); }
    catch (cause) { setError(getSafeErrorMessage(cause, "Não foi possível salvar a definição do exame. Atualize a revisão antes de tentar novamente.")); }
    finally { setBusy(false); }
  }
  function update(index: number, patch: Partial<AnalyteDraft>) { setAnalytes((current) => current.map((entry, position) => position === index ? { ...entry, ...patch } : entry)); }
  async function prepare(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const rows = analytes.map((entry, index) => ({ code: entry.code.trim().toUpperCase(), label: entry.label.trim(), valueType: entry.valueType, unitCode: entry.unitCode.trim(), required: entry.required, displayOrder: index + 1, ...(entry.allowedValues.trim() ? { allowedValues: split(entry.allowedValues) } : {}), ...(entry.valueType === "NUMERIC" ? { referenceRange: { kind: entry.low !== "" || entry.high !== "" ? "NUMERIC" : "PENDING_POLICY", unitCode: entry.unitCode.trim(), source: "PENDING_HUMAN_POLICY", ...(entry.low === "" ? {} : { low: Number(entry.low) }), ...(entry.high === "" ? {} : { high: Number(entry.high) }) } } : {}) }));
    await command("", "PUT", { template: { code: code.trim().toUpperCase(), name: name.trim(), schemaVersion, analytes: rows } }, "Rascunho preparado. A publicação exige aprovação clínica separada.");
  }
  async function publish(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await command("/publish", "POST", { policyReference: policyReference.trim(), population: { species: split(species), ...(sex.trim() ? { sex: split(sex) } : {}), ...(minAge === "" ? {} : { minAgeDays: Number(minAge) }), ...(maxAge === "" ? {} : { maxAgeDays: Number(maxAge) }) }, confirm: confirmed }, "Publicação registrada com sua autoria e população configurada.");
  }
  const shown = selected?.definition.resultTemplate;
  return <section className="exam-definition-editor" aria-label={`Definição do exame ${service.name}`}>
    <button type="button" className="button button-ghost" aria-expanded={open} onClick={() => void toggle()}>Definição, faixas e histórico de {service.name}</button>
    {open && <div>
      <p>Estado atual: {template ? statusLabel[template.status] : "Sem painel configurado"}. Revisões anteriores e definições de pedidos existentes são preservadas.</p>
      {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
      {canPrepare && <form aria-label={`Preparar definição de ${service.name}`} onSubmit={(event) => void prepare(event)}>
        <label>Nome do painel<input value={name} onChange={(event) => setName(event.target.value)} maxLength={160} required /></label>
        <label>Código do painel<input value={code} onChange={(event) => setCode(event.target.value)} maxLength={60} required /></label>
        {analytes.map((entry, index) => <fieldset key={index}><legend>Analito {index + 1}</legend><label>Código do analito {index + 1}<input value={entry.code} onChange={(event) => update(index, { code: event.target.value })} maxLength={60} required /></label><label>Nome do analito {index + 1}<input value={entry.label} onChange={(event) => update(index, { label: event.target.value })} maxLength={160} required /></label><label>Tipo do valor {index + 1}<select value={entry.valueType} onChange={(event) => update(index, { valueType: event.target.value as AnalyteDraft["valueType"] })}><option value="NUMERIC">Numérico</option><option value="QUALITATIVE">Qualitativo</option><option value="TEXT">Texto</option></select></label><label>Unidade do analito {index + 1}<input value={entry.unitCode} onChange={(event) => update(index, { unitCode: event.target.value })} maxLength={80} required /></label><label><input type="checkbox" checked={entry.required} onChange={(event) => update(index, { required: event.target.checked })} />Analito {index + 1} obrigatório</label>{entry.valueType === "NUMERIC" && <><label>Limite inferior {index + 1}<input type="number" step="any" value={entry.low} onChange={(event) => update(index, { low: event.target.value })} /></label><label>Limite superior {index + 1}<input type="number" step="any" value={entry.high} onChange={(event) => update(index, { high: event.target.value })} /></label></>}{entry.valueType === "QUALITATIVE" && <label>Valores permitidos {index + 1}<input value={entry.allowedValues} onChange={(event) => update(index, { allowedValues: event.target.value })} placeholder="Separe as opções por vírgula" /></label>}<button type="button" disabled={busy || analytes.length === 1} onClick={() => setAnalytes((current) => current.filter((_, position) => position !== index))}>Remover analito {index + 1}</button></fieldset>)}
        <button type="button" disabled={busy || analytes.length >= 200} onClick={() => setAnalytes((current) => [...current, emptyAnalyte()])}>Adicionar analito</button><button type="submit" disabled={busy}>Salvar rascunho do painel</button>
      </form>}
      {canApprove && template?.status === "DRAFT" && <form aria-label={`Aprovar definição de ${service.name}`} onSubmit={(event) => void publish(event)}><p>A confirmação registra sua responsabilidade por esta configuração. O aceite clínico institucional continua necessário antes de usar em produção.</p><label>Referência da política clínica<input value={policyReference} onChange={(event) => setPolicyReference(event.target.value)} maxLength={500} required /></label><label>Espécies atendidas<input value={species} onChange={(event) => setSpecies(event.target.value)} placeholder="Separe as espécies por vírgula" required /></label><label>Sexos atendidos (vazio para todos)<input value={sex} onChange={(event) => setSex(event.target.value)} /></label><label>Idade mínima em dias<input type="number" min={0} step={1} value={minAge} onChange={(event) => setMinAge(event.target.value)} /></label><label>Idade máxima em dias<input type="number" min={0} step={1} value={maxAge} onChange={(event) => setMaxAge(event.target.value)} /></label><label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />Confirmo a configuração clínica e a população atendida</label><button type="submit" disabled={busy || !confirmed}>Aprovar e publicar painel</button></form>}
      {canPrepare && template?.status === "ACTIVE" && <form aria-label={`Retirar definição de ${service.name}`} onSubmit={(event) => { event.preventDefault(); void command("/retire", "POST", { reason: reason.trim() }, "Painel retirado de novos pedidos; registros existentes preservados."); }}><label>Motivo da retirada<input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} required /></label><button type="submit" disabled={busy || !reason.trim()}>Retirar painel de novos pedidos</button></form>}
      {history.length > 0 ? <ul aria-label="Revisões conservadas">{history.map((entry) => <li key={entry.id}><button type="button" onClick={() => setSelected(entry)}>Abrir definição {entry.serviceVersion}</button> · {statusLabel[entry.status]} · {formatHospitalDateTime(entry.recordedAt)} · {entry.provenance === "CATALOG_OBSERVATION" ? "observada nesta data" : "registrada pelo comando"}</li>)}</ul> : <p>Nenhuma revisão anterior registrada; o catálogo atual não reconstrói definições históricas ausentes.</p>}
      {selected && <section aria-label={`Definição conservada ${selected.serviceVersion}`}><h3>{selected.definition.name} · revisão {selected.serviceVersion}</h3><p>Somente leitura · {statusLabel[selected.status]}.</p>{shown && <table><thead><tr><th>Analito</th><th>Unidade</th><th>Faixa configurada</th><th>Obrigatório</th></tr></thead><tbody>{shown.analytes.map((entry) => <tr key={entry.code}><td>{entry.label}</td><td>{entry.unitCode}</td><td>{entry.referenceRange?.kind === "NUMERIC" ? `${entry.referenceRange.low ?? "—"} a ${entry.referenceRange.high ?? "—"}` : "Pendente"}</td><td>{entry.required ? "Sim" : "Não"}</td></tr>)}</tbody></table>}{shown?.approval && <p>Política: {shown.approval.policyReference} · responsável {shown.approval.approvedBy} · espécies {shown.approval.population.species.join(", ")}</p>}</section>}
    </div>}
  </section>;
}
