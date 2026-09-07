"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ItemState, Priority, WorkflowType } from "@cvg/contracts";
import { ActionButton } from "@cvg/ui";
import { apiFetch, formatRelativeTime, getSafeErrorMessage } from "./api-client";
import { PriorityBadge, statusLabel, StatusBadge } from "./status-badge";
import { WorkflowAction } from "./workflow-action";
import { Icon } from "./ui-icons";

interface Request {
  id: string;
  requestCode: string;
  priority: Priority;
  aggregateStatus: string;
  createdAt: string;
  patient: { displayName: string; species: string; sex: string; externalId: string; ownerLabel: string };
  items: Array<{ id: string; status: ItemState; workflowType: WorkflowType; priority: Priority; dueAt: string; version: number; currentResultId?: string; currentSampleId?: string; service: { name: string; workflowType: WorkflowType } }>;
}

interface Event { id: string; eventType: string; newState?: string; occurredAt: string }

const aggregateStatusLabels: Record<string, string> = { REQUESTED: "Solicitado", IN_PROGRESS: "Em execução", PARTIALLY_AVAILABLE: "Parcialmente disponível", RESULTS_AVAILABLE: "Resultados disponíveis", COMPLETED: "Concluído", CANCELLED: "Cancelado" };
const eventLabels: Record<string, string> = { ResultReleased: "Resultado liberado", ResultRead: "Resultado consultado", ResultReviewed: "Resultado revisado", ResultAmended: "Resultado emendado", ResultVoided: "Resultado invalidado", SampleReceived: "Amostra recebida", ProcedureScheduled: "Exame agendado", ProcedurePerformed: "Exame realizado" };

function aggregateStatusLabel(value: string): string {
  return aggregateStatusLabels[value] ?? value.replaceAll("_", " ").toLowerCase().replace(/^./, (letter) => letter.toUpperCase());
}

function eventLabel(value: string): string {
  return eventLabels[value] ?? value.replace(/([a-z])([A-Z])/g, "$1 $2");
}

function eventStateLabel(value: string | undefined): string {
  if (!value) return "Ação registrada";
  if (aggregateStatusLabels[value]) return `Estado: ${aggregateStatusLabel(value)}`;
  const label = statusLabel(value as Parameters<typeof statusLabel>[0]);
  return label ? `Estado: ${label}` : `Estado: ${value.replaceAll("_", " ").toLowerCase()}`;
}

export function RequestDetail({ requestId }: { requestId: string }) {
  const [request, setRequest] = useState<Request | null>(null);
  const [timeline, setTimeline] = useState<Event[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const loadVersion = useRef(0);

  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    setLoading(true);
    setError("");
    const [requestResult, timelineResult] = await Promise.allSettled([
      apiFetch<Request>(`/diagnostic-requests/${requestId}`),
      apiFetch<Event[]>(`/timeline?requestId=${encodeURIComponent(requestId)}`)
    ]);
    if (loadVersion.current !== version) return;
    if (requestResult.status === "fulfilled") setRequest(requestResult.value);
    if (timelineResult.status === "fulfilled") setTimeline(timelineResult.value);
    const failures = [requestResult, timelineResult].filter((result) => result.status === "rejected");
    const firstFailure = failures[0];
    const failureMessage = firstFailure?.status === "rejected" ? getSafeErrorMessage(firstFailure.reason, "Não foi possível carregar o contexto.") : "";
    setError(failures.length === 2 ? failureMessage : failures.length === 1 ? "Parte da timeline está indisponível. Os dados visíveis podem estar desatualizados." : "");
    setLoading(false);
  }, [requestId]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => { window.clearTimeout(timer); loadVersion.current += 1; };
  }, [load]);

  if (!request && loading) return <div className="loading-state" role="status">Carregando contexto…</div>;
  if (!request) return <div className="error-state" role="alert"><strong>Contexto indisponível</strong><span>{error || "A solicitação não foi encontrada."}</span><ActionButton tone="ghost" state={loading ? "pending" : "idle"} onClick={() => void load()}>{loading ? "Tentando novamente…" : "Tentar novamente"}</ActionButton><Link className="button button-ghost" href="/">Voltar à visão geral</Link></div>;

  return <div className="detail-page"><Link href="/" className="back-link"><Icon name="arrow-left" size={15} /> Visão geral</Link><div className="detail-heading"><div><p className="eyebrow">Solicitação {request.requestCode}</p><h1>{request.patient.displayName} <em>em acompanhamento.</em></h1><p className="page-lede">{request.patient.species} · {request.patient.sex} · {request.patient.externalId} · tutor {request.patient.ownerLabel}</p></div><PriorityBadge priority={request.priority} /></div>{error && <div className="error-state" role="status"><span>{error}</span><ActionButton tone="ghost" state={loading ? "pending" : "idle"} onClick={() => void load()}>{loading ? "Reconciliando…" : "Reconciliar visão"}</ActionButton></div>}<div className="detail-grid"><section className="panel detail-items"><div className="panel-heading"><div><p className="eyebrow">Itens independentes</p><h2>{request.items.length} exames nesta solicitação</h2></div><span className="aggregate-status">{aggregateStatusLabel(request.aggregateStatus)}</span></div>{request.items.map((item) => <article className="detail-item" key={item.id} id={item.id}><div className="detail-item-icon" aria-hidden="true">{item.service.workflowType === "LABORATORY" ? <Icon name="lab" size={17} /> : <Icon name="imaging" size={17} />}</div><div className="detail-item-copy"><h3>{item.service.name}</h3><small>{item.service.workflowType === "LABORATORY" ? "Laboratório" : "Imagem"} · prazo {formatRelativeTime(item.dueAt)}</small></div><StatusBadge status={item.status} /><WorkflowAction item={item} onComplete={() => void load()} /></article>)}</section><section className="panel timeline-panel"><div className="panel-heading"><div><p className="eyebrow">Fonte de verdade</p><h2>Timeline</h2></div><span className="timeline-count">{timeline.length} eventos</span></div>{timeline.length === 0 ? <div className="empty-state"><span aria-hidden="true"><Icon name="imaging" size={17} /></span><strong>Nenhum evento disponível</strong><p>A timeline será reconciliada quando a dependência voltar.</p></div> : <ol className="timeline">{timeline.map((event) => <li key={event.id}><span className="timeline-marker" /><div><strong>{eventLabel(event.eventType)}</strong><small>{eventStateLabel(event.newState)} · {formatRelativeTime(event.occurredAt)}</small></div></li>)}</ol>}</section></div></div>;
}
