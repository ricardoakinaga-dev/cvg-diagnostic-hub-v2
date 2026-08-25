"use client";

import Link from "next/link";
import { useState } from "react";
import type { ItemState, WorkflowType } from "@cvg/contracts";
import { apiFetch, getSafeErrorMessage } from "./api-client";

export type WorkflowActionKind =
  | "RECEIVE_SAMPLE"
  | "START_PROCESSING"
  | "START_PROCEDURE"
  | "SCHEDULE"
  | "MARK_PERFORMED"
  | "CREATE_RESULT"
  | "REVIEW_RESULT"
  | "RECEIVE_REPLACEMENT"
  | "REQUEST_RECOLLECTION"
  | "RESCHEDULE";

export interface WorkflowActionItem {
  id: string;
  status: ItemState;
  workflowType: WorkflowType;
  version: number;
  currentResultId?: string;
  currentSampleId?: string;
  procedureId?: string;
  procedureVersion?: number;
}

export function workflowActionFor(item: Pick<WorkflowActionItem, "status" | "workflowType" | "currentResultId" | "currentSampleId">): WorkflowActionKind | undefined {
  if (item.status === "REQUESTED" && item.workflowType === "LABORATORY") return "RECEIVE_SAMPLE";
  if (item.status === "REQUESTED" && item.workflowType === "RADIOLOGY") return "START_PROCEDURE";
  if (item.status === "REQUESTED" && item.workflowType === "ULTRASOUND") return "SCHEDULE";
  if (item.status === "RECEIVED") return "START_PROCESSING";
  if (item.status === "SCHEDULED") return "START_PROCEDURE";
  if ((item.status === "IN_PROGRESS" || item.status === "RESULT_VOIDED") && item.workflowType === "LABORATORY") return "CREATE_RESULT";
  if (item.status === "RESULT_VOIDED" && item.workflowType !== "LABORATORY") return "CREATE_RESULT";
  if (item.status === "IN_PROGRESS" && item.workflowType !== "LABORATORY") return "MARK_PERFORMED";
  if (item.status === "AWAITING_REPORT") return "CREATE_RESULT";
  if (item.status === "RESULT_AVAILABLE" && item.currentResultId) return "REVIEW_RESULT";
  if (item.status === "RECOLLECTION_REQUIRED" && item.currentSampleId) return "RECEIVE_REPLACEMENT";
  return undefined;
}

const actionLabel: Record<WorkflowActionKind, string> = {
  RECEIVE_SAMPLE: "Receber amostra",
  START_PROCESSING: "Iniciar processamento",
  START_PROCEDURE: "Iniciar procedimento",
  SCHEDULE: "Agendar exame",
  MARK_PERFORMED: "Marcar realizado",
  CREATE_RESULT: "Registrar resultado",
  REVIEW_RESULT: "Abrir resultado",
  RECEIVE_REPLACEMENT: "Receber recoleta",
  REQUEST_RECOLLECTION: "Solicitar recoleta",
  RESCHEDULE: "Remarcar procedimento"
};

export function secondaryWorkflowActionFor(item: WorkflowActionItem): WorkflowActionKind | undefined {
  if (item.workflowType === "LABORATORY" && ["RECEIVED", "IN_PROGRESS"].includes(item.status) && item.currentSampleId) return "REQUEST_RECOLLECTION";
  if (item.status === "SCHEDULED" && item.procedureId && item.procedureVersion) return "RESCHEDULE";
  return undefined;
}

export function apiDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Informe uma data e hora válidas.");
  return date.toISOString();
}

export function WorkflowAction({ item, onComplete }: { item: WorkflowActionItem; onComplete?: () => void }) {
  const action = workflowActionFor(item);
  const secondaryAction = secondaryWorkflowActionFor(item);
  const [open, setOpen] = useState(false);
  const [selectedAction, setSelectedAction] = useState<WorkflowActionKind | undefined>(action);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [accessionCode, setAccessionCode] = useState("");
  const [sampleType, setSampleType] = useState("EDTA");
  const [narrative, setNarrative] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [resource, setResource] = useState("");
  const [reasonCode, setReasonCode] = useState("HEMOLYZED");
  const [reasonNote, setReasonNote] = useState("");
  const [rescheduleReason, setRescheduleReason] = useState("");
  const [draft, setDraft] = useState<{ id: string; version: number }>();

  if (!action) return <span className="next-action">Sem ação disponível</span>;
  if (action === "REVIEW_RESULT" && item.currentResultId) {
    return <Link className="button button-ghost workflow-action-link" href={`/results/${item.currentResultId}`}>{actionLabel[action]} →</Link>;
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    if (!selectedAction) return;
    if ((selectedAction === "RECEIVE_SAMPLE" || selectedAction === "RECEIVE_REPLACEMENT") && !accessionCode.trim()) {
      setError("Informe o accession da amostra.");
      setBusy(false);
      return;
    }
    if ((selectedAction === "SCHEDULE" || selectedAction === "RESCHEDULE") && (!startsAt || !endsAt || !resource.trim())) {
      setError("Informe janela e recurso da agenda.");
      setBusy(false);
      return;
    }
    if (selectedAction === "CREATE_RESULT" && !narrative.trim()) {
      setError("Informe o texto do resultado.");
      setBusy(false);
      return;
    }
    try {
      if (selectedAction === "RECEIVE_SAMPLE" || selectedAction === "RECEIVE_REPLACEMENT") {
        const path = selectedAction === "RECEIVE_SAMPLE" ? `/diagnostic-items/${item.id}/receive-sample` : `/samples/${item.currentSampleId}/receive-replacement`;
        await apiFetch(path, { method: "POST", body: JSON.stringify({ accessionCode: accessionCode.trim().toUpperCase(), sampleType, expectedVersion: item.version }) });
      } else if (selectedAction === "SCHEDULE") {
        await apiFetch(`/diagnostic-items/${item.id}/schedule`, { method: "POST", body: JSON.stringify({ startsAt: apiDateTime(startsAt), endsAt: apiDateTime(endsAt), resource: resource.trim(), expectedVersion: item.version }) });
      } else if (selectedAction === "RESCHEDULE" && item.procedureId && item.procedureVersion) {
        await apiFetch(`/procedures/${item.procedureId}/reschedule`, { method: "POST", body: JSON.stringify({ startsAt: apiDateTime(startsAt), endsAt: apiDateTime(endsAt), resource: resource.trim(), reason: rescheduleReason.trim() || undefined, expectedVersion: item.procedureVersion }) });
      } else if (selectedAction === "REQUEST_RECOLLECTION" && item.currentSampleId) {
        if (!reasonCode.trim()) throw new Error("Informe o motivo da recoleta.");
        await apiFetch(`/diagnostic-items/${item.id}/request-recollection`, { method: "POST", body: JSON.stringify({ reasonCode: reasonCode.trim().toUpperCase(), note: reasonNote.trim() || undefined, expectedVersion: item.version }) });
      } else if (selectedAction === "CREATE_RESULT") {
        const result = await apiFetch<{ result: { id: string; version: number } }>(`/diagnostic-items/${item.id}/results`, { method: "POST", body: JSON.stringify({ narrative: narrative.trim(), content: {}, expectedVersion: item.version }) });
        setDraft(result.result);
        setNotice("Draft salvo. Confirme a liberação quando estiver pronto.");
        return;
      } else if (selectedAction === "START_PROCESSING") {
        await apiFetch(`/diagnostic-items/${item.id}/start-processing`, { method: "POST", body: JSON.stringify({ expectedVersion: item.version }) });
      } else if (selectedAction === "START_PROCEDURE") {
        await apiFetch(`/diagnostic-items/${item.id}/start-procedure`, { method: "POST", body: JSON.stringify({ expectedVersion: item.version }) });
      } else if (selectedAction === "MARK_PERFORMED") {
        await apiFetch(`/diagnostic-items/${item.id}/mark-performed`, { method: "POST", body: JSON.stringify({ expectedVersion: item.version }) });
      }
      setOpen(false);
      onComplete?.();
    } catch (cause) {
      setError(getSafeErrorMessage(cause, "Não foi possível confirmar a ação."));
    } finally {
      setBusy(false);
    }
  }

  async function releaseDraft() {
    if (!draft || busy) return;
    setBusy(true);
    setError("");
    try {
      await apiFetch(`/results/${draft.id}/release`, { method: "POST", body: JSON.stringify({ expectedVersion: draft.version }) });
      setDraft(undefined);
      setNotice("");
      setOpen(false);
      onComplete?.();
    } catch (cause) {
      setError(getSafeErrorMessage(cause, "Não foi possível liberar o resultado."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="workflow-action">
      <button className="button button-primary" type="button" onClick={() => { setSelectedAction(action); setOpen((value) => !value); setError(""); }} aria-expanded={open}>
        {actionLabel[action]}
      </button>
      {secondaryAction && <button className="button button-ghost workflow-secondary-action" type="button" onClick={() => { setSelectedAction(secondaryAction); setOpen(true); setError(""); }} aria-expanded={open}>{actionLabel[secondaryAction]}</button>}
      {open && selectedAction && <form className="workflow-form" onSubmit={(event) => void submit(event)}>
        {selectedAction === "RECEIVE_SAMPLE" || selectedAction === "RECEIVE_REPLACEMENT" ? <>
          <label>Accession<input value={accessionCode} onChange={(event) => setAccessionCode(event.target.value)} autoComplete="off" placeholder="ACC-2026-001" /></label>
          <label>Tipo de amostra<input value={sampleType} onChange={(event) => setSampleType(event.target.value)} /></label>
        </> : null}
        {selectedAction === "SCHEDULE" || selectedAction === "RESCHEDULE" ? <>
          <label>Início<input type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} /></label>
          <label>Fim<input type="datetime-local" value={endsAt} onChange={(event) => setEndsAt(event.target.value)} /></label>
          <label>Recurso<input value={resource} onChange={(event) => setResource(event.target.value)} placeholder="US-01" /></label>
          {selectedAction === "RESCHEDULE" && <label>Motivo<input value={rescheduleReason} onChange={(event) => setRescheduleReason(event.target.value)} placeholder="Conflito de agenda" /></label>}
        </> : null}
        {selectedAction === "REQUEST_RECOLLECTION" ? <>
          <label>Código do motivo<input value={reasonCode} onChange={(event) => setReasonCode(event.target.value)} placeholder="HEMOLYZED" /></label>
          <label>Observação<textarea value={reasonNote} onChange={(event) => setReasonNote(event.target.value)} rows={3} placeholder="Descreva o motivo operacional." /></label>
        </> : null}
        {selectedAction === "CREATE_RESULT" ? <label>Resultado<textarea value={narrative} onChange={(event) => setNarrative(event.target.value)} rows={4} placeholder="Descreva o resultado confirmado pelo setor." /></label> : null}
        {error && <p className="form-alert" role="alert">{error}</p>}
        {notice && <p className="form-notice" role="status">{notice}</p>}
        <div className="workflow-form-actions"><button className="button button-ghost" type="button" onClick={() => setOpen(false)}>Cancelar</button><button className="button button-primary" type="submit" disabled={busy}>{busy ? "Confirmando…" : "Confirmar"}</button></div>
        {draft && <div className="workflow-draft-actions"><Link className="button button-ghost" href={`/results/${draft.id}`}>Abrir draft</Link>{item.workflowType === "LABORATORY" ? <span className="workflow-draft-guidance">Abra o editor para preencher e liberar o painel.</span> : <button className="button button-primary" type="button" onClick={() => void releaseDraft()} disabled={busy}>Liberar resultado</button>}</div>}
      </form>}
    </div>
  );
}
