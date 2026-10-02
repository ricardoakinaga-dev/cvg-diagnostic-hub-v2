"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AttachmentSession as AttachmentSessionDto, LaboratoryPanelTemplate, LaboratoryReferenceRange, PublicAttachment, ResultView as ResultViewDto, ResultVersionState, StructuredLaboratoryResultContent } from "@cvg/contracts";
import { ActionButton } from "@cvg/ui";
import { apiFetch, formatRelativeTime, getSafeErrorMessage } from "./api-client";
import { ErrorState, LoadingState } from "./feedback-states";
import { StatusBadge } from "./status-badge";
import { Icon } from "./ui-icons";

type ResultData = ResultViewDto;
type Attachment = PublicAttachment;
type AttachmentSession = AttachmentSessionDto;
type EditorMode = "DRAFT" | "AMEND" | "VOID" | undefined;
type PendingAction = "release" | "review" | "upload" | "editor";
const resultVersionLabels: Record<ResultVersionState, string> = { DRAFT: "Rascunho", RELEASED: "Liberado", SUPERSEDED: "Substituído", VOIDED: "Invalidado" };

function structuredResultFrom(content: Record<string, unknown>): StructuredLaboratoryResultContent | undefined {
  if (content.kind !== "LABORATORY_STRUCTURED" || typeof content.panelCode !== "string" || typeof content.panelVersion !== "number" || !Array.isArray(content.observations)) return undefined;
  return content as unknown as StructuredLaboratoryResultContent;
}

function laboratoryValuesFrom(content: Record<string, unknown>, template: LaboratoryPanelTemplate): Record<string, string> {
  const observations = structuredResultFrom(content)?.observations ?? [];
  const values = new Map(observations.map((observation) => [observation.analyteCode, String(observation.value)]));
  return Object.fromEntries(template.analytes.map((analyte) => [analyte.code, values.get(analyte.code) ?? ""]));
}

function referenceRangeLabel(referenceRange: LaboratoryReferenceRange | undefined): string {
  if (!referenceRange || referenceRange.kind === "PENDING_POLICY") return "Faixa pendente de aprovação";
  if (referenceRange.low !== undefined && referenceRange.high !== undefined) return `${referenceRange.low} – ${referenceRange.high} ${referenceRange.unitCode}`;
  if (referenceRange.low !== undefined) return `≥ ${referenceRange.low} ${referenceRange.unitCode}`;
  if (referenceRange.high !== undefined) return `≤ ${referenceRange.high} ${referenceRange.unitCode}`;
  return "Faixa configurada sem limites";
}

function flagLabel(flag: string): string {
  return ({ NORMAL: "Normal", LOW: "Baixo", HIGH: "Alto", UNINTERPRETED: "Não interpretado" } as Record<string, string>)[flag] ?? flag;
}

function LaboratoryResultPanel({ template, content }: { template: LaboratoryPanelTemplate; content?: StructuredLaboratoryResultContent }) {
  if (!content) {
    return <section className="laboratory-result" aria-label={`Painel laboratorial ${template.name}`}>
      <div className="laboratory-result-heading"><div><span className="eyebrow">Painel estruturado</span><h3>{template.name}</h3></div><small>revisão {template.version}</small></div>
      <p className="laboratory-legacy-note" role="status">Este draft ainda usa conteúdo legado e não representa um resultado laboratorial preenchido.</p>
      <p className="laboratory-legacy-note">Abra <strong>Editar draft</strong>, preencha os analitos obrigatórios e salve antes de liberar.</p>
    </section>;
  }
  const observations = new Map(content.observations.map((observation) => [observation.analyteCode, observation]));
  return <section className="laboratory-result" aria-label={`Painel laboratorial ${template.name}`}>
    <div className="laboratory-result-heading"><div><span className="eyebrow">Painel estruturado</span><h3>{template.name}</h3></div><small>revisão {template.version}</small></div>
    <div className="laboratory-table-wrap"><table className="laboratory-table"><thead><tr><th scope="col">Analito</th><th scope="col">Valor</th><th scope="col">Unidade</th><th scope="col">Faixa de referência</th><th scope="col">Interpretação</th></tr></thead><tbody>{template.analytes.map((analyte) => { const observation = observations.get(analyte.code); return <tr key={analyte.code}><th scope="row">{analyte.label}{analyte.required && <span aria-label="obrigatório"> *</span>}</th><td>{observation ? String(observation.value) : "—"}</td><td>{analyte.unitCode}</td><td>{referenceRangeLabel(observation?.referenceRange ?? analyte.referenceRange)}</td><td>{observation ? flagLabel(observation.flag) : "Pendente"}</td></tr>; })}</tbody></table></div>
    {template.analytes.some((analyte) => analyte.referenceRange?.source === "PENDING_HUMAN_POLICY") && <p className="laboratory-policy-note">As faixas exibidas como pendentes aguardam aprovação clínica humana; o sistema não infere limites nem criticidade.</p>}
  </section>;
}

function sha256Hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function fileBytes(file: File): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === "function") return file.arrayBuffer();
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "object" && reader.result !== null ? resolve(reader.result as ArrayBuffer) : reject(new Error("Não foi possível ler o anexo."));
    reader.onerror = () => reject(new Error("Não foi possível ler o anexo."));
    reader.readAsArrayBuffer(file);
  });
}

export function ResultView({ resultId }: { resultId: string }) {
  const [data, setData] = useState<ResultData | null>(null);
  const [versions, setVersions] = useState<Array<ResultData["version"]>>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [viewed, setViewed] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pendingAction, setPendingAction] = useState<PendingAction>();
  const busy = pendingAction !== undefined;
  const busyRef = useRef(false);
  const loadSequenceRef = useRef(0);
  const suppressEditorConflictRef = useRef(false);
  const noticeRef = useRef("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [invalidated, setInvalidated] = useState(false);
  const [editorMode, setEditorMode] = useState<EditorMode>();
  const [editorBaseVersion, setEditorBaseVersion] = useState<number>();
  const [editorConflict, setEditorConflict] = useState(false);
  const [reason, setReason] = useState("");
  const [narrative, setNarrative] = useState("");
  const [conclusion, setConclusion] = useState("");
  const [laboratoryValues, setLaboratoryValues] = useState<Record<string, string>>({});
  const [critical, setCritical] = useState(false);
  const [releaseCritical, setReleaseCritical] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File>();

  const writeNotice = useCallback((value: string) => {
    noticeRef.current = value;
    setNotice(value);
  }, []);

  const load = useCallback(async (detectEditorConflict = true) => {
    const loadSequence = loadSequenceRef.current + 1;
    loadSequenceRef.current = loadSequence;
    setLoading(true);
    setError("");
    const [resultResponse, versionResponse, reportResponse] = await Promise.allSettled([
      apiFetch<ResultData>(`/results/${resultId}`),
      apiFetch<Array<ResultData["version"]>>(`/results/${resultId}/versions`),
      apiFetch<{ attachments: Attachment[] }>(`/reports/${resultId}`)
    ]);
    if (loadSequenceRef.current !== loadSequence) return;
    if (resultResponse.status === "fulfilled") {
      if (detectEditorConflict && editorMode && editorBaseVersion !== undefined && resultResponse.value.result.version !== editorBaseVersion) {
        if (suppressEditorConflictRef.current) {
          // A reconciliation immediately after our own successful mutation can
          // observe the new result version while the editor state is still
          // closing. Keep this suppression until the next editing session so
          // duplicate realtime deliveries cannot turn the same save into a
          // false remote conflict.
        } else {
          setEditorConflict(true);
          writeNotice("");
          setError("O resultado mudou em outra sessão. Feche o editor, reconcilie e reabra a versão antes de salvar.");
        }
      }
      setData(resultResponse.value);
    }
    if (versionResponse.status === "fulfilled") setVersions(versionResponse.value);
    if (reportResponse.status === "fulfilled") setAttachments(reportResponse.value.attachments);
    if (resultResponse.status === "rejected") {
      setData(null);
      setVersions([]);
      setAttachments([]);
      setError(getSafeErrorMessage(resultResponse.reason, "Não foi possível carregar o resultado."));
    } else if ((versionResponse.status === "rejected" && resultResponse.value.version.status !== "DRAFT") || reportResponse.status === "rejected") {
      setError("Parte do histórico ou dos anexos está indisponível; os dados visíveis podem estar desatualizados.");
    }
    setLoading(false);
  }, [editorBaseVersion, editorMode, resultId, writeNotice]);

  useEffect(() => { const timer = window.setTimeout(() => { void load(); }, 0); return () => window.clearTimeout(timer); }, [load]);
  useEffect(() => () => { loadSequenceRef.current += 1; }, []);

  useEffect(() => {
    const refreshFromRealtime = () => {
      if (busyRef.current) return;
      if (!noticeRef.current) writeNotice("Atualização recebida; reconciliando o resultado com o servidor.");
      void load();
    };
    window.addEventListener("cvg:realtime-updated", refreshFromRealtime);
    window.addEventListener("cvg:realtime-resync", refreshFromRealtime);
    return () => {
      window.removeEventListener("cvg:realtime-updated", refreshFromRealtime);
      window.removeEventListener("cvg:realtime-resync", refreshFromRealtime);
    };
  }, [load, writeNotice]);

  useEffect(() => {
    if (!data || data.version.status === "DRAFT" || viewed) return;
    void apiFetch(`/results/${resultId}/view`, { method: "POST", body: JSON.stringify({ versionId: data.version.id, expectedVersion: data.item.version }) })
      .then(() => setViewed(true))
      .catch((cause) => setError(getSafeErrorMessage(cause, "Não foi possível registrar a visualização.")));
  }, [data, resultId, viewed]);

  function beginEditor(mode: Exclude<EditorMode, undefined>): void {
    suppressEditorConflictRef.current = false;
    setEditorMode(mode);
    setEditorBaseVersion(data?.result.version);
    setEditorConflict(false);
    setReason("");
    setNarrative(data?.version.narrative ?? "");
    setConclusion(data?.version.conclusion ?? "");
    if (data?.service.resultTemplate) setLaboratoryValues(laboratoryValuesFrom(data.version.content, data.service.resultTemplate));
    setCritical(data?.version.critical ?? false);
    setError("");
  }

  function closeEditor(): void {
    if (busy) return;
    setEditorMode(undefined);
    setEditorBaseVersion(undefined);
    setEditorConflict(false);
    setReason("");
    setError("");
  }

  async function submitEditor(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!data || !editorMode || busy) return;
    if (editorConflict) {
      setError("O resultado mudou em outra sessão. Feche o editor, reconcilie e reabra a versão antes de salvar.");
      return;
    }
    busyRef.current = true;
    setPendingAction("editor");
    setError("");
    writeNotice("");
    try {
      if (editorMode === "VOID") {
        if (!reason.trim()) throw new Error("Informe o motivo da invalidação.");
        await apiFetch(`/results/${resultId}/void`, { method: "POST", body: JSON.stringify({ reason: reason.trim(), expectedVersion: editorBaseVersion ?? data.result.version }) });
        setInvalidated(true);
        writeNotice("Resultado invalidado. Uma nova versão deverá ser registrada.");
      } else {
        if (!narrative.trim()) throw new Error("Informe o texto do resultado.");
        if (editorMode === "AMEND" && !reason.trim()) throw new Error("Informe o motivo da emenda.");
        const template = data.service.resultTemplate;
        const content = template && data.service.resultSchema === "NUMERIC_PANEL"
          ? {
            kind: "LABORATORY_STRUCTURED" as const,
            panelCode: template.code,
            panelVersion: template.version,
            observations: template.analytes.flatMap<{ analyteCode: string; value: number | string; unitCode: string }>((analyte) => {
              const rawValue = laboratoryValues[analyte.code]?.trim() ?? "";
              if (!rawValue) {
                if (analyte.required) throw new Error(`Informe o analito obrigatório: ${analyte.label}.`);
                return [];
              }
              if (analyte.valueType === "NUMERIC") {
                const numericValue = Number(rawValue);
                if (!Number.isFinite(numericValue)) throw new Error(`Informe um valor numérico válido para ${analyte.label}.`);
                return [{ analyteCode: analyte.code, value: numericValue, unitCode: analyte.unitCode }];
              }
              const textValue: number | string = rawValue;
              return [{ analyteCode: analyte.code, value: textValue, unitCode: analyte.unitCode }];
            })
          }
          : data.version.content;
        const body = { narrative: narrative.trim(), conclusion: conclusion.trim() || undefined, content, ...(editorMode === "AMEND" ? { reason: reason.trim(), critical } : {}), expectedVersion: editorBaseVersion ?? data.result.version };
        await apiFetch(editorMode === "AMEND" ? `/results/${resultId}/amend` : `/results/${resultId}/draft`, { method: editorMode === "AMEND" ? "POST" : "PATCH", body: JSON.stringify(body) });
        writeNotice(editorMode === "AMEND" ? "Emenda salva como nova versão em draft." : "Draft atualizado.");
      }
      setEditorMode(undefined);
      setEditorBaseVersion(undefined);
      setEditorConflict(false);
      suppressEditorConflictRef.current = true;
      await load(false);
    } catch (cause) {
      setError(getSafeErrorMessage(cause, cause instanceof Error ? cause.message : "Não foi possível salvar a alteração."));
    } finally {
      busyRef.current = false;
      setPendingAction(undefined);
    }
  }

  async function releaseDraft(): Promise<void> {
    if (!data || data.version.status !== "DRAFT" || busy) return;
    busyRef.current = true;
    setPendingAction("release");
    setError("");
    writeNotice("");
    try {
      await apiFetch(`/results/${resultId}/release`, { method: "POST", body: JSON.stringify({ critical: releaseCritical, expectedVersion: data.result.version }) });
      writeNotice("Resultado liberado e enviado para a fila de revisão.");
      await load();
    } catch (cause) {
      setError(getSafeErrorMessage(cause, "Não foi possível liberar o resultado."));
    } finally {
      busyRef.current = false;
      setPendingAction(undefined);
    }
  }

  async function uploadSelectedFile(): Promise<void> {
    if (!data || !selectedFile || busy) return;
    const allowed = new Set(["application/pdf", "image/jpeg", "image/png"]);
    if (!allowed.has(selectedFile.type)) {
      setError("Escolha um PDF, JPEG ou PNG.");
      return;
    }
    if (selectedFile.size < 1 || selectedFile.size > 25 * 1024 * 1024) {
      setError("O anexo deve ter entre 1 byte e 25 MB.");
      return;
    }
    busyRef.current = true;
    setPendingAction("upload");
    setError("");
    writeNotice("");
    try {
      const bytes = await fileBytes(selectedFile);
      const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
      const session = await apiFetch<AttachmentSession>(`/result-versions/${data.version.id}/attachments/upload-session`, { method: "POST", body: JSON.stringify({ filename: selectedFile.name, mimeType: selectedFile.type, sizeBytes: selectedFile.size, checksum: sha256Hex(digest), expectedVersion: data.version.version }) });
      const uploadPath = session.uploadUrl.replace(/^\/api\/v1/, "");
      await apiFetch<{ attachment: Attachment }>(uploadPath, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: bytes as unknown as BodyInit });
      await apiFetch(`/attachments/${session.attachment.id}/finalize`, { method: "POST", body: JSON.stringify({ expectedVersion: data.version.version }) });
      setSelectedFile(undefined);
      writeNotice("Anexo enviado, verificado e finalizado.");
      await load();
    } catch (cause) {
      setError(getSafeErrorMessage(cause, cause instanceof Error ? cause.message : "Não foi possível enviar o anexo."));
    } finally {
      busyRef.current = false;
      setPendingAction(undefined);
    }
  }

  async function review(): Promise<void> {
    if (!data || !viewed || reviewed || data.item.status !== "RESULT_AVAILABLE") return;
    busyRef.current = true;
    setPendingAction("review");
    try {
      await apiFetch(`/results/${resultId}/review`, { method: "POST", body: JSON.stringify({ versionId: data.version.id, expectedVersion: data.item.version }) });
      setReviewed(true);
      await load();
    } catch (cause) {
      setError(getSafeErrorMessage(cause, "Não foi possível registrar a revisão."));
    } finally {
      busyRef.current = false;
      setPendingAction(undefined);
    }
  }

  if (!data && loading) return <LoadingState label="Carregando resultado" />;
  if (!data) return <ErrorState title={invalidated ? "Resultado invalidado" : "Resultado indisponível"} message={notice || error} onRetry={load} retrying={loading} action={<Link className="button button-ghost" href="/notifications">Voltar às notificações</Link>} />;

  const isDraft = data.version.status === "DRAFT";
  const isReleased = data.version.status === "RELEASED";
  const laboratoryTemplate = data.service.workflowType === "LABORATORY" && data.service.resultSchema === "NUMERIC_PANEL" ? data.service.resultTemplate : undefined;
  const structuredContent = structuredResultFrom(data.version.content);
  const structuredObservationCodes = new Set((structuredContent?.observations ?? []).map((observation) => observation.analyteCode));
  const laboratoryDraftReady = !laboratoryTemplate || Boolean(structuredContent && laboratoryTemplate.analytes.every((analyte) => !analyte.required || structuredObservationCodes.has(analyte.code)));
  const cleanAttachments = attachments.filter((attachment) => attachment.scanStatus === "CLEAN" && attachment.uploadStatus === "FINALIZED");
  return <div className="result-page">
    <Link href={`/requests/${data.request.id}`} className="back-link"><Icon name="arrow-left" size={15} /> Solicitação {data.request.requestCode}</Link>
    <div className="page-heading"><div><p className="eyebrow">{data.service.name} · versão {data.version.sequence}</p><h1>Resultado de <em>{data.patient.displayName}.</em></h1><p className="page-lede">{data.patient.species} · {data.patient.sex} · {data.patient.externalId} · {data.version.releasedAt ? `liberado ${formatRelativeTime(data.version.releasedAt)}` : "em rascunho"}</p></div><StatusBadge status={data.item.status} /></div>
     {error && <ErrorState title="Resultado parcialmente indisponível" message={error} onRetry={load} retrying={loading} retryLabel="Reconciliar" />}
    {notice && <div className="form-notice" role="status">{notice}</div>}
    <div className="result-grid">
      <section className="panel result-content"><div className="panel-heading"><div><p className="eyebrow">Versão atual</p><h2>{data.version.critical ? "Resultado crítico" : isDraft ? "Draft em edição" : "Laudo confirmado"}</h2></div>{data.version.needsReReview && <span className="result-warning">Nova revisão necessária</span>}</div>
        <div className="result-copy"><p>{data.version.narrative}</p>{data.version.conclusion && <div className="result-conclusion"><span>Conclusão</span><strong>{data.version.conclusion}</strong></div>}{laboratoryTemplate ? <LaboratoryResultPanel template={laboratoryTemplate} content={structuredContent} /> : Object.keys(data.version.content).length > 0 && <dl className="result-fields">{Object.entries(data.version.content).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{typeof value === "string" ? value : JSON.stringify(value)}</dd></div>)}</dl>}</div>
        <div className="result-actions"><span className="result-view-state" role="status">{isDraft ? "Draft não liberado" : viewed ? "Visualização registrada" : "Registrando visualização…"}</span><div className="result-command-actions">{isDraft && <><button className="button button-ghost" type="button" onClick={() => beginEditor("DRAFT")}>Editar draft</button>{laboratoryTemplate && !laboratoryDraftReady ? <span className="laboratory-release-guidance">Preencha os analitos obrigatórios para liberar.</span> : <ActionButton state={pendingAction === "release" ? "pending" : "idle"} onClick={() => void releaseDraft()} disabled={busy && pendingAction !== "release"}>Liberar resultado</ActionButton>}</>}{isReleased && <><button className="button button-ghost" type="button" onClick={() => beginEditor("AMEND")}>Emendar resultado</button><button className="button button-danger-ghost" type="button" onClick={() => beginEditor("VOID")}>Invalidar</button></>}{data.item.status === "RESULT_AVAILABLE" && <ActionButton state={pendingAction === "review" ? "pending" : "idle"} onClick={() => void review()} disabled={!viewed || reviewed || (busy && pendingAction !== "review")}>{reviewed ? "Revisão registrada" : "Marcar como revisado"}</ActionButton>}</div></div>
        {isDraft && <div className="result-support-actions"><label className="checkbox-line"><input type="checkbox" checked={releaseCritical} onChange={(event) => setReleaseCritical(event.target.checked)} /> Liberar como resultado crítico</label>{data.service.allowsAttachment !== false && <div className="attachment-upload"><label htmlFor="result-attachment">Adicionar anexo (PDF, JPEG ou PNG)</label><input id="result-attachment" type="file" accept="application/pdf,image/jpeg,image/png" onChange={(event) => setSelectedFile(event.currentTarget.files?.[0])} /><ActionButton state={pendingAction === "upload" ? "pending" : "idle"} tone="ghost" onClick={() => void uploadSelectedFile()} disabled={!selectedFile || (busy && pendingAction !== "upload")}>Enviar anexo</ActionButton></div>}</div>}
        {editorMode && <form className="result-editor" onSubmit={(event) => void submitEditor(event)}><h3>{editorMode === "VOID" ? "Invalidar versão liberada" : editorMode === "AMEND" ? "Criar emenda" : "Editar draft"}</h3>{editorMode !== "DRAFT" && <label>Motivo<textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} required placeholder="Explique a alteração para a trilha de auditoria." /></label>}{editorMode !== "VOID" && <>{laboratoryTemplate && <fieldset className="laboratory-editor"><legend>Analitos do painel</legend>{laboratoryTemplate.analytes.map((analyte) => <label key={analyte.code}>{analyte.label}{analyte.required && " *"}<input aria-label={analyte.label} type={analyte.valueType === "NUMERIC" ? "number" : "text"} step={analyte.valueType === "NUMERIC" ? "any" : undefined} value={laboratoryValues[analyte.code] ?? ""} onChange={(event) => setLaboratoryValues((current) => ({ ...current, [analyte.code]: event.target.value }))} required={analyte.required} /><small>{analyte.unitCode} · {referenceRangeLabel(analyte.referenceRange)}</small></label>)}</fieldset>}<label>Narrativa<textarea value={narrative} onChange={(event) => setNarrative(event.target.value)} rows={5} required /></label><label>Conclusão<textarea value={conclusion} onChange={(event) => setConclusion(event.target.value)} rows={2} /></label>{editorMode === "AMEND" && <label className="checkbox-line"><input type="checkbox" checked={critical} onChange={(event) => setCritical(event.target.checked)} /> Manter como crítico</label>}</>}<div className="workflow-form-actions"><button className="button button-ghost" type="button" onClick={closeEditor}>Cancelar</button><ActionButton state={pendingAction === "editor" ? "pending" : "idle"} type="submit" disabled={editorConflict || (busy && pendingAction !== "editor")}>{pendingAction === "editor" ? "Salvando…" : "Confirmar"}</ActionButton></div></form>}
      </section>
      <aside className="result-side"><section className="panel"><div className="panel-heading"><div><p className="eyebrow">Histórico</p><h2>Versões</h2></div><span className="timeline-count">{versions.length}</span></div><ol className="version-list">{versions.map((version) => <li key={version.id} className={version.id === data.version.id ? "version-current" : ""}><strong>Versão {version.sequence}</strong><small>{resultVersionLabels[version.status]} · {formatRelativeTime(version.createdAt)}</small></li>)}</ol></section><section className="panel attachment-panel"><div className="panel-heading"><div><p className="eyebrow">Arquivos</p><h2>Anexos</h2></div><span className="timeline-count">{attachments.length}</span></div>{attachments.length === 0 ? <p className="panel-empty-copy">Nenhum anexo nesta versão.</p> : <ul className="attachment-list">{attachments.map((attachment) => <li key={attachment.id}><span><strong>{attachment.safeName}</strong><small>{attachment.detectedMime} · {Math.round(attachment.sizeBytes / 1024)} KB</small></span>{cleanAttachments.some((entry) => entry.id === attachment.id) && isReleased ? <a className="button button-ghost" href={`/api/v1/attachments/${attachment.id}/download`} aria-label={`Baixar ${attachment.safeName}`}>Baixar</a> : <span>{attachment.scanStatus === "CLEAN" && attachment.uploadStatus === "FINALIZED" ? "Disponível após liberação" : "Indisponível"}</span>}</li>)}</ul>}</section></aside>
    </div>
  </div>;
}
