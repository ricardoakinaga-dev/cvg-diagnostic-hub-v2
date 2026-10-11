"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ItemState, QueueItem, ReasonCode, ResultView, SampleLabel, SessionRole } from "@cvg/contracts";
import { ActionButton } from "@cvg/ui";
import { ApiClientError, apiFetch, getSafeErrorMessage } from "./api-client";
import { Icon } from "./ui-icons";

export type WorkflowActionKind =
  | "RECEIVE_SAMPLE"
  | "START_PROCESSING"
  | "START_PROCEDURE"
  | "SCHEDULE"
  | "MARK_PERFORMED"
  | "CREATE_RESULT"
  | "EDIT_RESULT"
  | "REVIEW_RESULT"
  | "RECEIVE_REPLACEMENT"
  | "REQUEST_RECOLLECTION"
  | "RESCHEDULE"
  | "RELEASE_RESULT"
  | "CANCEL"
  | "REJECT"
  | "AMEND"
  | "COMPLETE";

type WorkflowPendingAction = "submit" | "release" | null;

export type WorkflowActionItem = Pick<QueueItem, "id" | "status" | "workflowType" | "version" | "currentResultId" | "currentSampleId" | "procedureId" | "procedureVersion">;

export function workflowActionFor(item: Pick<WorkflowActionItem, "status" | "workflowType" | "currentResultId" | "currentSampleId">): WorkflowActionKind | undefined {
  if (item.currentResultId && ["IN_PROGRESS", "AWAITING_REPORT"].includes(item.status)) return "EDIT_RESULT";
  if (["REQUESTED", "FAILED"].includes(item.status) && item.workflowType === "LABORATORY") return "RECEIVE_SAMPLE";
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

export const actionLabel: Record<WorkflowActionKind, string> = {
  RECEIVE_SAMPLE: "Receber amostra",
  START_PROCESSING: "Iniciar processamento",
  START_PROCEDURE: "Iniciar procedimento",
  SCHEDULE: "Agendar exame",
  MARK_PERFORMED: "Marcar realizado",
  CREATE_RESULT: "Registrar resultado",
  EDIT_RESULT: "Abrir draft",
  REVIEW_RESULT: "Abrir resultado",
  RECEIVE_REPLACEMENT: "Receber recoleta",
  REQUEST_RECOLLECTION: "Solicitar recoleta",
  RESCHEDULE: "Remarcar procedimento",
  RELEASE_RESULT: "Liberar resultado",
  CANCEL: "Cancelar exame",
  REJECT: "Rejeitar exame",
  AMEND: "Emendar resultado",
  COMPLETE: "Concluir exame"
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

export function workflowActionForTransition(item: WorkflowActionItem, target: ItemState): WorkflowActionKind | undefined {
  if (target === item.status) return undefined;
  if (target === "CANCELLED" && ["REQUESTED", "RECEIVED", "SCHEDULED", "IN_PROGRESS", "AWAITING_REPORT", "RECOLLECTION_REQUIRED", "FAILED"].includes(item.status)) return "CANCEL";
  if (target === "REJECTED" && (item.status === "REQUESTED" || (item.status === "RECEIVED" && item.workflowType === "LABORATORY"))) return "REJECT";
  if (target === "RECOLLECTION_REQUIRED") return secondaryWorkflowActionFor(item) === "REQUEST_RECOLLECTION" ? "REQUEST_RECOLLECTION" : undefined;
  if (target === "RESULT_AVAILABLE" && ["IN_PROGRESS", "AWAITING_REPORT", "RESULT_VOIDED"].includes(item.status) && (item.workflowType === "LABORATORY" || item.status !== "IN_PROGRESS")) return "RELEASE_RESULT";
  if (target === "COMPLETED" && item.status === "REVIEWED") return "COMPLETE";
  const action = workflowActionFor(item);
  const targets: Partial<Record<WorkflowActionKind, ItemState>> = { RECEIVE_SAMPLE: "RECEIVED", RECEIVE_REPLACEMENT: "RECEIVED", START_PROCESSING: "IN_PROGRESS", START_PROCEDURE: "IN_PROGRESS", SCHEDULE: "SCHEDULED", MARK_PERFORMED: "AWAITING_REPORT" };
  if (item.status === "REQUESTED" && item.workflowType === "RADIOLOGY" && target === "SCHEDULED") return "SCHEDULE";
  return action && targets[action] === target ? action : undefined;
}

export function canUseWorkflowAction(role: SessionRole, action: WorkflowActionKind, item?: WorkflowActionItem): boolean {
  if (role === "MANAGER") return true;
  if (action === "CANCEL" && item && ["RECEIVED", "IN_PROGRESS", "AWAITING_REPORT", "FAILED"].includes(item.status)) return false;
  if (["VETERINARIAN", "VET", "INPATIENT_TEAM"].includes(role)) return action === "CANCEL" || action === "REVIEW_RESULT";
  if (role === "VIEWER" || role === "ADMIN") return action === "REVIEW_RESULT";
  if (["RELEASE_RESULT", "CREATE_RESULT", "EDIT_RESULT", "REVIEW_RESULT", "AMEND"].includes(action)) return true;
  return role === "LAB_TECH" ? ["RECEIVE_SAMPLE", "START_PROCESSING", "RECEIVE_REPLACEMENT", "REQUEST_RECOLLECTION", "REJECT"].includes(action) : ["SCHEDULE", "RESCHEDULE", "START_PROCEDURE", "MARK_PERFORMED"].includes(action);
}

export class WorkflowInputError extends Error {}

export async function releaseExistingDraft(item: WorkflowActionItem): Promise<void> {
  if (!item.currentResultId) throw new WorkflowInputError("Registre e preencha um rascunho válido antes de liberar o resultado.");
  const view = await apiFetch<ResultView>(`/results/${item.currentResultId}`);
  if (view.version.status !== "DRAFT") throw new WorkflowInputError("Somente um rascunho pode ser liberado.");
  if (!view.version.narrative.trim()) throw new WorkflowInputError("Preencha o texto clínico do resultado antes de liberar.");
  if (view.service.resultSchema === "NUMERIC_PANEL") {
    if (view.version.content.kind !== "LABORATORY_STRUCTURED" || !Array.isArray(view.version.content.observations) || view.version.content.observations.length === 0) throw new WorkflowInputError("Preencha o conteúdo clínico obrigatório do painel antes de liberar o resultado.");
  }
  try {
    await apiFetch(`/results/${view.result.id}/release`, { method: "POST", body: JSON.stringify({ expectedVersion: view.result.version, ...(view.version.critical ? { critical: true } : {}) }) });
  } catch (cause) {
    if (cause instanceof ApiClientError && cause.code === "VALIDATION_ERROR") throw new WorkflowInputError("O conteúdo clínico do resultado está incompleto ou inválido. Preencha os campos obrigatórios no editor antes de liberar.");
    throw cause;
  }
}

export async function executeSimpleWorkflowAction(item: WorkflowActionItem, action: WorkflowActionKind): Promise<void> {
  if (action === "RELEASE_RESULT") return releaseExistingDraft(item);
  const paths: Partial<Record<WorkflowActionKind, string>> = { START_PROCESSING: "start-processing", START_PROCEDURE: "start-procedure", MARK_PERFORMED: "mark-performed", COMPLETE: "complete" };
  const path = paths[action];
  if (!path) throw new WorkflowInputError("Esta ação precisa de dados clínicos antes de confirmar.");
  await apiFetch(`/diagnostic-items/${item.id}/${path}`, { method: "POST", body: JSON.stringify({ expectedVersion: item.version }) });
}

export function WorkflowAction({ item, onComplete, onDraftCreated, initialAction, role }: { item: WorkflowActionItem; onComplete?: () => void; onDraftCreated?: () => void; initialAction?: WorkflowActionKind; role?: SessionRole }) {
  const action = workflowActionFor(item);
  const secondaryAction = secondaryWorkflowActionFor(item);
  const formId = useId();
  const firstFieldNodeRef = useRef<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null>(null);
  const setFirstFieldRef = useCallback((element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null) => {
    firstFieldNodeRef.current = element;
  }, []);
  const [open, setOpen] = useState(Boolean(initialAction));
  const [selectedAction, setSelectedAction] = useState<WorkflowActionKind | undefined>(initialAction ?? action);
  const [pendingAction, setPendingAction] = useState<WorkflowPendingAction>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [accessionCode, setAccessionCode] = useState("");
  const [sampleType, setSampleType] = useState("EDTA");
  const [sampleLabel, setSampleLabel] = useState<SampleLabel["sample"] | null>(null);
  const [narrative, setNarrative] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [resource, setResource] = useState("");
  const [reasonCode, setReasonCode] = useState("");
  const [reasons, setReasons] = useState<ReasonCode[]>([]);
  const [reasonLoading, setReasonLoading] = useState(Boolean(initialAction && ["REQUEST_RECOLLECTION", "CANCEL", "REJECT", "AMEND"].includes(initialAction)));
  const [reasonError, setReasonError] = useState("");
  const [reasonRetry, setReasonRetry] = useState(0);
  const [reasonNote, setReasonNote] = useState("");
  const [rescheduleReason, setRescheduleReason] = useState("");
  const [draft, setDraft] = useState<{ id: string; version: number }>();

  useEffect(() => {
    if (open && !reasonLoading) firstFieldNodeRef.current?.focus();
  }, [open, selectedAction, reasonLoading]);

  // D8: a pre-assigned sample already carries the code printed on the label.
  const receiving = selectedAction === "RECEIVE_SAMPLE" || selectedAction === "RECEIVE_REPLACEMENT";
  const expectedSampleId = receiving || selectedAction === "REQUEST_RECOLLECTION" ? item.currentSampleId : undefined;
  const expectedSample = receiving && sampleLabel?.id === expectedSampleId && sampleLabel?.status === "EXPECTED" ? sampleLabel : null;
  const sampleVersion = sampleLabel?.id === expectedSampleId ? sampleLabel?.version : undefined;
  useEffect(() => {
    if (!open || !expectedSampleId) return;
    let active = true;
    void apiFetch<SampleLabel>(`/samples/${expectedSampleId}/label`).then((label) => {
      if (!active) return;
      setSampleLabel(label.sample);
      if (label.sample.status !== "EXPECTED") return;
      // Keep what the user already typed; the catalog type replaces only the untouched default.
      setSampleType((current) => current !== "EDTA" ? current : label.sample.sampleType === "A definir" ? "" : label.sample.sampleType);
    }).catch(() => { /* the expected code is a convenience; the server still validates the receipt */ });
    return () => { active = false; };
  }, [open, expectedSampleId]);

  const reasonType = selectedAction === "REQUEST_RECOLLECTION" ? "RECOLLECTION" : selectedAction === "CANCEL" ? "CANCEL" : selectedAction === "REJECT" ? "REJECT" : selectedAction === "AMEND" ? "AMEND" : undefined;
  useEffect(() => {
    if (!open || !reasonType) return;
    let active = true;
    void apiFetch<ReasonCode[]>("/clinical-reasons").then((catalog) => {
      if (active) setReasons(catalog.filter((reason) => reason.active && reason.type === reasonType));
    }).catch((cause: unknown) => {
      if (active) setReasonError(getSafeErrorMessage(cause, "Não foi possível carregar os motivos autorizados. Solicite acesso ao catálogo."));
    }).finally(() => { if (active) setReasonLoading(false); });
    return () => { active = false; };
  }, [open, reasonType, reasonRetry]);

  function openAction(nextAction: WorkflowActionKind, toggle = false) {
    if (open && selectedAction === nextAction && !toggle) { firstFieldNodeRef.current?.focus(); return; }
    setSelectedAction(nextAction);
    setOpen(toggle && selectedAction === nextAction ? !open : true);
    setError("");
    setReasonError("");
    setReasonCode("");
    setReasons([]);
    setReasonLoading(["REQUEST_RECOLLECTION", "CANCEL", "REJECT", "AMEND"].includes(nextAction));
  }

  if (!action && !initialAction) return <span className="next-action">Sem ação disponível</span>;
  if (action === "REVIEW_RESULT" && item.currentResultId && !initialAction) {
    return <Link className="button button-ghost workflow-action-link" href={`/results/${item.currentResultId}`}>{actionLabel[action]} <Icon name="arrow-right" size={15} /></Link>;
  }
  if (action === "EDIT_RESULT" && item.currentResultId && (!initialAction || initialAction === "CREATE_RESULT")) {
    return !role || canUseWorkflowAction(role, action, item) ? <Link className="button button-ghost workflow-action-link" href={`/results/${item.currentResultId}`}>Abrir draft <Icon name="arrow-right" size={15} /></Link> : <span className="next-action">Sem ação disponível</span>;
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pendingAction) return;
    setPendingAction("submit");
    setError("");
    setNotice("");
    if (!selectedAction) { setPendingAction(null); return; }
    if (selectedAction === "CREATE_RESULT" && (draft || (item.currentResultId && item.status !== "RESULT_VOIDED"))) {
      setError("Este exame já possui um rascunho. Abra o draft existente para editar.");
      setPendingAction(null);
      return;
    }
    if (receiving && !sampleType.trim() && (!expectedSample || expectedSample.sampleType === "A definir")) {
      setError("Informe o tipo de amostra.");
      setPendingAction(null);
      return;
    }
    if ((selectedAction === "SCHEDULE" || selectedAction === "RESCHEDULE") && (!startsAt || !endsAt || !resource.trim())) {
      setError("Informe janela e recurso da agenda.");
      setPendingAction(null);
      return;
    }
    if (selectedAction === "CREATE_RESULT" && !narrative.trim()) {
      setError("Informe o texto do resultado.");
      setPendingAction(null);
      return;
    }
    if (reasonType && !reasons.some((reason) => reason.code === reasonCode)) {
      setError("Escolha um motivo da lista autorizada.");
      setPendingAction(null);
      return;
    }
    if (selectedAction === "AMEND" && !narrative.trim()) {
      setError("Informe o texto clínico da emenda.");
      setPendingAction(null);
      return;
    }
    try {
      if (selectedAction === "CANCEL" || selectedAction === "REJECT") {
        await apiFetch(`/diagnostic-items/${item.id}/${selectedAction === "CANCEL" ? "cancel" : "reject"}`, { method: "POST", body: JSON.stringify({ reasonCode, ...(reasonNote.trim() ? selectedAction === "CANCEL" ? { reason: reasonNote.trim() } : { note: reasonNote.trim() } : {}), expectedVersion: item.version }) });
      } else if (selectedAction === "AMEND" && item.currentResultId) {
        const view = await apiFetch<ResultView>(`/results/${item.currentResultId}`);
        await apiFetch(`/results/${item.currentResultId}/amend`, { method: "POST", body: JSON.stringify({ narrative: narrative.trim(), content: view.version.content, conclusion: view.version.conclusion, reason: reasons.find((reason) => reason.code === reasonCode)?.label, critical: view.version.critical, expectedVersion: view.result.version }) });
      } else if (selectedAction === "RECEIVE_SAMPLE" || selectedAction === "RECEIVE_REPLACEMENT") {
        const path = selectedAction === "RECEIVE_SAMPLE" ? `/diagnostic-items/${item.id}/receive-sample` : `/samples/${item.currentSampleId}/receive-replacement`;
        const replacementVersion = selectedAction === "RECEIVE_REPLACEMENT" ? sampleVersion ?? (await apiFetch<SampleLabel>(`/samples/${item.currentSampleId}/label`)).sample.version : undefined;
        await apiFetch(path, { method: "POST", body: JSON.stringify({ ...(accessionCode.trim() ? { accessionCode: accessionCode.trim().toUpperCase() } : {}), ...(sampleType.trim() ? { sampleType: sampleType.trim() } : {}), expectedVersion: item.version, ...(replacementVersion !== undefined ? { expectedSampleVersion: replacementVersion } : {}) }) });
      } else if (selectedAction === "SCHEDULE") {
        await apiFetch(`/diagnostic-items/${item.id}/schedule`, { method: "POST", body: JSON.stringify({ startsAt: apiDateTime(startsAt), endsAt: apiDateTime(endsAt), resource: resource.trim(), expectedVersion: item.version }) });
      } else if (selectedAction === "RESCHEDULE" && item.procedureId && item.procedureVersion) {
        await apiFetch(`/procedures/${item.procedureId}/reschedule`, { method: "POST", body: JSON.stringify({ startsAt: apiDateTime(startsAt), endsAt: apiDateTime(endsAt), resource: resource.trim(), reason: rescheduleReason.trim() || undefined, expectedVersion: item.procedureVersion }) });
      } else if (selectedAction === "REQUEST_RECOLLECTION" && item.currentSampleId) {
        await apiFetch(`/diagnostic-items/${item.id}/request-recollection`, { method: "POST", body: JSON.stringify({ reasonCode, note: reasonNote.trim() || undefined, expectedVersion: item.version, ...(sampleVersion !== undefined ? { expectedSampleVersion: sampleVersion } : {}) }) });
      } else if (selectedAction === "CREATE_RESULT") {
        // Voided versions are intentionally unreadable. The versioned create
        // command validates the existing lineage inside its transaction.
        const result = await apiFetch<{ result: { id: string; version: number } }>(`/diagnostic-items/${item.id}/results`, { method: "POST", body: JSON.stringify({ narrative: narrative.trim(), content: {}, expectedVersion: item.version }) });
        setDraft(result.result);
        setNotice("Draft salvo. Confirme a liberação quando estiver pronto.");
        onDraftCreated?.();
        return;
      } else if (selectedAction === "RELEASE_RESULT" || selectedAction === "COMPLETE") {
        await executeSimpleWorkflowAction(item, selectedAction);
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
      setError(cause instanceof WorkflowInputError ? cause.message : getSafeErrorMessage(cause, "Não foi possível confirmar a ação."));
    } finally {
      setPendingAction(null);
    }
  }

  async function releaseDraft() {
    if (!draft || pendingAction) return;
    setPendingAction("release");
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
      setPendingAction(null);
    }
  }

  return (
    <div className="workflow-action">
      {action && (!role || canUseWorkflowAction(role, action, item)) && <ActionButton className="workflow-primary-action" type="button" onClick={() => openAction(action, true)} aria-expanded={open && selectedAction === action} aria-controls={formId} disabled={pendingAction !== null} state={pendingAction === "submit" && selectedAction === action ? "pending" : "idle"}>
        {actionLabel[action]}
      </ActionButton>}
      {action === "CREATE_RESULT" && item.status === "RESULT_VOIDED" && item.currentResultId && (!role || canUseWorkflowAction(role, "EDIT_RESULT", item)) && <Link className="button button-ghost" href={`/results/${item.currentResultId}`}>Abrir resultado atual</Link>}
      {secondaryAction && (!role || canUseWorkflowAction(role, secondaryAction, item)) && <ActionButton tone="ghost" className="workflow-secondary-action" type="button" onClick={() => openAction(secondaryAction)} aria-expanded={open && selectedAction === secondaryAction} aria-controls={formId} disabled={pendingAction !== null} state={pendingAction === "submit" && selectedAction === secondaryAction ? "pending" : "idle"}>{actionLabel[secondaryAction]}</ActionButton>}
      {open && selectedAction && <form id={formId} className="workflow-form" aria-label={actionLabel[selectedAction]} onSubmit={(event) => void submit(event)}>
        {reasonType && <h3>{actionLabel[selectedAction]}</h3>}
        {selectedAction === "RECEIVE_SAMPLE" || selectedAction === "RECEIVE_REPLACEMENT" ? <>
          {expectedSample && <p className="workflow-expected-sample">Amostra esperada: <strong className="mono">{expectedSample.accessionCode}</strong></p>}
          <label>Accession<input ref={setFirstFieldRef} value={accessionCode} onChange={(event) => setAccessionCode(event.target.value)} autoComplete="off" placeholder={expectedSample ? "Leia o código de barras ou deixe em branco" : "Leia o código de barras ou digite o accession"} /></label>
          <label>Tipo de amostra<input value={sampleType} onChange={(event) => setSampleType(event.target.value)} placeholder="EDTA" /></label>
        </> : null}
        {selectedAction === "SCHEDULE" || selectedAction === "RESCHEDULE" ? <>
          <label>Início<input ref={setFirstFieldRef} type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} /></label>
          <label>Fim<input type="datetime-local" value={endsAt} onChange={(event) => setEndsAt(event.target.value)} /></label>
          <label>Recurso<input value={resource} onChange={(event) => setResource(event.target.value)} placeholder="US-01" /></label>
          {selectedAction === "RESCHEDULE" && <label>Motivo<input value={rescheduleReason} onChange={(event) => setRescheduleReason(event.target.value)} placeholder="Conflito de agenda" /></label>}
        </> : null}
        {reasonType ? <>
          <label>Motivo<select ref={setFirstFieldRef} value={reasonCode} onChange={(event) => setReasonCode(event.target.value)} disabled={reasonLoading || reasons.length === 0} aria-busy={reasonLoading}><option value="">Escolha um motivo…</option>{reasons.map((reason) => <option key={reason.id} value={reason.code}>{reason.label}</option>)}</select></label>
          {reasonLoading && <p role="status">Carregando motivos…</p>}
          {reasonError && <p role="alert">{reasonError}<button type="button" onClick={() => { setReasonError(""); setReasonLoading(true); setReasonRetry((value) => value + 1); }}>Tentar novamente</button></p>}
          {!reasonLoading && !reasonError && reasons.length === 0 && <p role="alert">Nenhum motivo ativo disponível para esta ação.</p>}
          <label>Observação (opcional)<textarea value={reasonNote} onChange={(event) => setReasonNote(event.target.value)} rows={3} placeholder="Acrescente contexto clínico, se necessário." /></label>
        </> : null}
        {selectedAction === "CREATE_RESULT" || selectedAction === "AMEND" ? <label>Resultado<textarea ref={setFirstFieldRef} value={narrative} onChange={(event) => setNarrative(event.target.value)} rows={4} placeholder="Descreva o resultado confirmado pelo setor." /></label> : null}
        {error && <p className="form-alert" role="alert">{error}</p>}
        {notice && <p className="form-notice" role="status">{notice}</p>}
        <div className="workflow-form-actions"><button className="button button-ghost" type="button" onClick={() => setOpen(false)} disabled={pendingAction !== null}>Cancelar</button><ActionButton state={pendingAction === "submit" ? "pending" : "idle"} disabled={pendingAction !== null || (Boolean(reasonType) && (reasonLoading || !reasonCode)) || (selectedAction === "CREATE_RESULT" && Boolean(draft))} type="submit">{pendingAction === "submit" ? "Confirmando…" : "Confirmar"}</ActionButton></div>
        {draft && <div className="workflow-draft-actions"><Link className="button button-ghost" href={`/results/${draft.id}`}>Abrir draft</Link>{item.workflowType === "LABORATORY" ? <span className="workflow-draft-guidance">Abra o editor para preencher e liberar o painel.</span> : <ActionButton state={pendingAction === "release" ? "pending" : "idle"} disabled={pendingAction !== null} onClick={() => void releaseDraft()}>{pendingAction === "release" ? "Liberando…" : "Liberar resultado"}</ActionButton>}</div>}
      </form>}
    </div>
  );
}
