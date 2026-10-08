"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ItemState, PatientDiagnosticsResult, PatientWorkspaceSample } from "@cvg/contracts";
import { ActionButton } from "@cvg/ui";
import { apiFetch, formatRelativeTime, getSafeErrorMessage } from "./api-client";
import { EmptyState, ErrorState, PartialNotice, StaleNotice } from "./feedback-states";
import { PatientArchive } from "./patient-archive";
import { PriorityBadge, StatusBadge, statusLabel } from "./status-badge";
import { Icon } from "./ui-icons";

type SampleSummary = PatientWorkspaceSample;
type DiagnosticsData = PatientDiagnosticsResult;

const sampleLabels: Record<SampleSummary["status"], string> = {
  EXPECTED: "Esperada",
  RECEIVED: "Recebida",
  REJECTED: "Rejeitada",
  REPLACED: "Substituída"
};

function formatSnapshotDate(value: string | null | undefined): string {
  if (!value) return "Não informado";
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

function formatBirthDate(value: string | undefined): string {
  if (!value) return "data de nascimento não informada";
  return `nascido em ${new Intl.DateTimeFormat("pt-BR", { dateStyle: "short" }).format(new Date(`${value}T12:00:00`))}`;
}

function formatFileSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  return `${Math.round(sizeBytes / 1024)} KB`;
}

const aggregateStatusLabels: Record<string, string> = {
  REQUESTED: "Solicitado",
  IN_PROGRESS: "Em andamento",
  PARTIALLY_AVAILABLE: "Parcialmente disponível",
  RESULTS_AVAILABLE: "Resultados disponíveis",
  COMPLETED: "Concluído",
  CANCELLED: "Cancelado"
};

const departmentLabels: Record<string, string> = {
  INPATIENT: "Internação",
  LABORATORY: "Laboratório",
  RADIOLOGY: "Radiologia",
  ULTRASOUND: "Ultrassom",
  OPERATIONS: "Operações"
};

const eventLabels: Record<string, string> = {
  AdmissionCreated: "Internação registrada",
  AdmissionTransferred: "Internação transferida",
  AdmissionBedChanged: "Acomodação atualizada",
  AdmissionResponsibilityChanged: "Responsabilidade atualizada",
  AdmissionDischarged: "Alta registrada",
  DiagnosticRequestCreated: "Solicitação de exame criada",
  DiagnosticRequestCancelled: "Solicitação de exame cancelada",
  DiagnosticItemRequested: "Exame solicitado",
  DiagnosticItemCancelled: "Exame cancelado",
  DiagnosticItemRejected: "Exame rejeitado",
  DiagnosticItemResultAvailable: "Resultado disponível",
  SampleReceived: "Amostra recebida",
  SampleRejected: "Amostra rejeitada",
  SampleRecollectionRequested: "Recoleta solicitada",
  SampleReplaced: "Amostra substituída",
  RecollectionRequested: "Recoleta solicitada",
  ProcedureScheduled: "Exame agendado",
  ProcedureRescheduled: "Exame reagendado",
  ProcedureStarted: "Exame iniciado",
  ProcedurePerformed: "Exame realizado",
  ProcessingStarted: "Processamento iniciado",
  RequestItemCompleted: "Item concluído",
  ScheduleCreated: "Agenda criada",
  ResultDraftCreated: "Rascunho de resultado criado",
  ResultDraftUpdated: "Rascunho de resultado atualizado",
  ResultDraftRead: "Rascunho de resultado consultado",
  ResultReleased: "Resultado liberado",
  ResultRead: "Resultado consultado",
  ResultViewed: "Resultado consultado",
  ResultReviewed: "Resultado revisado",
  ResultHistoryRead: "Histórico do resultado consultado",
  ResultVersionHistoryRead: "Histórico do resultado consultado",
  ResultAmended: "Resultado emendado",
  ResultVoided: "Resultado invalidado",
  ReportRead: "Laudo consultado",
  AttachmentUploadSessionCreated: "Anexo preparado",
  AttachmentFinalized: "Anexo finalizado",
  AttachmentDownloaded: "Anexo baixado",
  NotificationAcknowledged: "Notificação reconhecida",
  CriticalNotificationSuperseded: "Notificação crítica atualizada",
  PatientCreated: "Paciente cadastrado",
  EncounterCreated: "Atendimento registrado"
};

function eventLabel(eventType: string): string {
  return eventLabels[eventType] ?? "Ação registrada";
}

function aggregateStatusLabel(status: string): string {
  return aggregateStatusLabels[status] ?? "Estado não informado";
}

function departmentLabel(departmentCode: string | null): string {
  return departmentCode ? departmentLabels[departmentCode] ?? "Setor não informado" : "Não informado";
}

function eventStateLabel(value: string | undefined): string {
  if (!value) return "Ação registrada";
  const eventStateLabels: Record<string, string> = { DRAFT: "Em rascunho", RELEASED: "Liberado", VOIDED: "Invalidado" };
  if (eventStateLabels[value]) return `Estado: ${eventStateLabels[value]}`;
  const itemStates = ["REQUESTED", "RECEIVED", "SCHEDULED", "IN_PROGRESS", "AWAITING_REPORT", "RESULT_AVAILABLE", "REVIEWED", "COMPLETED", "RECOLLECTION_REQUIRED", "FAILED", "CANCELLED", "REJECTED", "RESULT_VOIDED"];
  return itemStates.includes(value) ? `Estado: ${statusLabel(value as ItemState)}` : `Estado: ${aggregateStatusLabel(value)}`;
}

function encounterContextLabel(type: string | undefined): string {
  if (type === "EMERGENCY") return "Atendimento de emergência";
  if (type === "OUTPATIENT") return "Atendimento ambulatorial";
  if (type === "INPATIENT") return "Internação";
  return "Contexto sem internação";
}

function PatientWorkspaceSkeleton() {
  return <div className="patient-workspace-loading" role="status" aria-label="Carregando workspace do paciente">
    <div className="patient-workspace-skeleton-back skeleton-block" aria-hidden="true" />
    <div className="patient-workspace-skeleton-heading" aria-hidden="true">
      <div className="patient-workspace-skeleton-heading-copy">
        <span className="skeleton-line skeleton-line-eyebrow" />
        <span className="skeleton-line skeleton-line-title" />
        <span className="skeleton-line skeleton-line-lede" />
        <span className="skeleton-line skeleton-line-tags" />
      </div>
      <span className="skeleton-button" />
    </div>
    <div className="workspace-context-grid" aria-hidden="true">
      <div className="panel patient-workspace-skeleton-panel">
        <div className="panel-heading"><span className="skeleton-line skeleton-line-panel-title" /><span className="skeleton-dot" /></div>
        <div className="patient-workspace-skeleton-context"><span /><span /><span /><span /></div>
      </div>
      <div className="panel patient-workspace-skeleton-panel">
        <div className="panel-heading"><span className="skeleton-line skeleton-line-panel-title" /><span className="skeleton-line skeleton-line-count" /></div>
        <div className="patient-workspace-skeleton-actions"><span /><span /><span /></div>
      </div>
    </div>
    <div className="workspace-summary-grid" aria-hidden="true">
      {[1, 2, 3, 4].map((item) => <div className="panel patient-workspace-skeleton-metric" key={item}><span /><strong /><small /></div>)}
    </div>
    <div className="patient-detail-grid workspace-main-grid" aria-hidden="true">
      <div className="panel patient-workspace-skeleton-main-panel"><div className="panel-heading"><span className="skeleton-line skeleton-line-panel-title" /><span className="skeleton-line skeleton-line-count" /></div><div className="patient-workspace-skeleton-request"><span /><span /><span /><span /></div></div>
      <div className="panel patient-workspace-skeleton-main-panel"><div className="panel-heading"><span className="skeleton-line skeleton-line-panel-title" /><span className="skeleton-line skeleton-line-count" /></div><div className="patient-workspace-skeleton-timeline"><span /><span /><span /><span /><span /></div></div>
    </div>
  </div>;
}

export function PatientDiagnostics({ patientId }: { patientId: string }) {
  const [data, setData] = useState<DiagnosticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [paginationError, setPaginationError] = useState("");
  const [compactTimeline, setCompactTimeline] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(max-width: 560px)").matches);
  const [timelineExpanded, setTimelineExpanded] = useState(false);
  const loadVersion = useRef(0);
  const load = useCallback(async () => {
    const version = loadVersion.current + 1;
    loadVersion.current = version;
    setLoading(true);
    setLoadingMore(false);
    setPaginationError("");
    try {
      const nextData = await apiFetch<DiagnosticsData>(`/patients/${patientId}/diagnostics?limit=50`);
      if (loadVersion.current !== version) return;
      if (nextData.patient.id !== patientId) throw new Error("Resposta de paciente inconsistente.");
      setData(nextData);
      setError("");
    } catch (cause) {
      if (loadVersion.current !== version) return;
      setError(getSafeErrorMessage(cause, "Não foi possível carregar o workspace do paciente."));
    } finally {
      if (loadVersion.current === version) setLoading(false);
    }
  }, [patientId]);

  const loadMore = useCallback(async () => {
    const cursor = data?.nextCursor;
    if (!cursor || loading || loadingMore) return;
    const version = loadVersion.current;
    setLoadingMore(true);
    setPaginationError("");
    try {
      const nextData = await apiFetch<DiagnosticsData>(`/patients/${patientId}/diagnostics?limit=50&cursor=${encodeURIComponent(cursor)}`);
      if (loadVersion.current !== version || nextData.patient.id !== patientId) return;
      setData((current) => {
        if (!current || current.patient.id !== patientId) return current;
        const existingRequestIds = new Set(current.items.map((request) => request.id));
        return {
          ...current,
          items: [...current.items, ...nextData.items.filter((request) => !existingRequestIds.has(request.id))],
          nextCursor: nextData.nextCursor,
          limit: nextData.limit,
          total: nextData.total
        };
      });
    } catch (cause) {
      if (loadVersion.current === version) setPaginationError(getSafeErrorMessage(cause, "Não foi possível carregar mais protocolos."));
    } finally {
      if (loadVersion.current === version) setLoadingMore(false);
    }
  }, [data, loading, loadingMore, patientId]);
  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => {
      window.clearTimeout(timer);
      loadVersion.current += 1;
    };
  }, [load]);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(max-width: 560px)");
    const update = () => setCompactTimeline(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  const activeData = data?.patient.id === patientId ? data : null;
  const activeLoading = loading || (data !== null && activeData === null && !error);
  if (!activeData && activeLoading) {
    return <PatientWorkspaceSkeleton />;
  }
  if (!activeData) {
    return <ErrorState page className="patient-workspace-error" title="Paciente indisponível" message={error} onRetry={load} retrying={loading} action={<Link className="button button-ghost" href="/patients">Voltar aos pacientes</Link>} />;
  }

  const context = activeData.workspace.currentContext;
  const summary = activeData.workspace.summary;
  const stale = Boolean(error);
  const dataQualityDegraded = activeData.workspace.dataQuality?.status === "DEGRADED";
  const degraded = !stale && dataQualityDegraded;
  const workspaceState = stale ? "stale" : degraded ? "degraded" : "ready";
  const contextStatusLabel = stale ? "Snapshot anterior preservado" : degraded ? "Leitura parcial" : "Snapshot atual";
  const currentEncounter = activeData.encounters.find((encounter) => encounter.id === context.encounterId);
  const contextHeading = context.admissionId
    ? [context.ward, context.bed].filter(Boolean).join(" · ") || "Internação sem acomodação informada"
    : encounterContextLabel(currentEncounter?.type);
  const timelinePreviewLimit = compactTimeline ? 8 : 20;
  const visibleTimelineEvents = activeData.events.slice(-(timelineExpanded ? 20 : timelinePreviewLimit)).reverse();
  const timelineScopeLabel = activeData.events.length > visibleTimelineEvents.length
    ? `últimos ${visibleTimelineEvents.length} de ${activeData.events.length}`
    : `${activeData.events.length} ${activeData.events.length === 1 ? "evento" : "eventos"}`;
  const totalRequestCount = activeData.total ?? summary.requestCount;
  const requestScopeLabel = activeData.items.length < totalRequestCount
    ? `mostrando ${activeData.items.length} de ${totalRequestCount}`
    : `${activeData.items.length} carregado${activeData.items.length === 1 ? "" : "s"}`;
  const auxiliaryDataUnavailable = dataQualityDegraded;
  return <div className="patient-detail-page patient-workspace" data-testid="patient-workspace" data-workspace-state={workspaceState} aria-busy={loading}>
    <Link href="/patients" className="back-link"><Icon name="arrow-left" size={15} /> Meus pacientes</Link>
    <div className="detail-heading patient-workspace-heading">
      <div>
        <p className="eyebrow">Área do paciente · contexto autorizado</p>
        <h1>{activeData.patient.displayName} <em>em acompanhamento.</em></h1>
        <p className="page-lede">{activeData.patient.species} · {activeData.patient.sex} · {activeData.patient.breed} · {activeData.patient.externalId} · tutor {activeData.patient.ownerLabel}</p>
        <div className="patient-identity-tags" aria-label="Identidade do paciente">
          <span>{activeData.patient.active ? "Ativo" : "Inativo"}</span>
          <span>{formatBirthDate(activeData.patient.birthDate)}</span>
          <span>snapshot {formatSnapshotDate(activeData.workspace.asOf)}</span>
        </div>
      </div>
      <ActionButton tone="ghost" state={loading ? "pending" : "idle"} onClick={() => void load()}><Icon name="refresh" size={15} /> {loading ? "Atualizando…" : "Atualizar"}</ActionButton>
    </div>

    {loading && <div className="workspace-refresh-status" role="status" aria-live="polite">Atualizando snapshot autorizado…</div>}
    {degraded && <PartialNotice className="workspace-partial-notice" title="Leitura parcial." accessibleLabel="Leitura parcial" message={activeData.workspace.dataQuality?.note ?? "A leitura auxiliar de amostras, resultados e anexos está indisponível; os itens autorizados continuam visíveis."} onRetry={load} retrying={loading} retryLabel="Reconciliar visão" />}
    {error && <StaleNotice className="workspace-stale-notice" title="Snapshot anterior preservado." accessibleLabel="Snapshot anterior preservado" message={`A última atualização não foi concluída; exibindo a leitura confirmada de ${formatSnapshotDate(activeData.workspace.asOf)}.`} onRetry={load} retrying={loading} retryLabel="Reconciliar visão" />}

    <section className="workspace-context-grid" aria-label="Contexto atual do paciente">
      <article className="panel workspace-context-card">
        <div className="panel-heading"><div><p className="eyebrow">Contexto atual</p><h2>{contextHeading}</h2></div><span className="context-live-status" role="status" aria-label={workspaceState === "ready" ? contextStatusLabel : undefined}><span className={`context-live-dot${stale || degraded ? " context-live-dot-stale" : ""}`} aria-hidden="true" /><span>{contextStatusLabel}</span></span></div>
        <dl className="workspace-context-list">
          <div><dt>Atendimento</dt><dd>{currentEncounter?.externalId ?? "Não informado"}</dd></div>
          <div><dt>Setor responsável</dt><dd>{departmentLabel(context.departmentCode)}</dd></div>
          <div><dt>Responsável</dt><dd>{context.responsibleLabel ?? "A definir"}</dd></div>
          <div><dt>Leitura confirmada</dt><dd>{formatRelativeTime(activeData.workspace.asOf)}</dd></div>
        </dl>
      </article>
      <article className="panel workspace-actions-card">
        <div className="panel-heading"><div><p className="eyebrow">Próximos passos</p><h2>{activeData.nextActions.length} {activeData.nextActions.length === 1 ? "ação autorizada" : "ações autorizadas"}</h2></div><span className="timeline-count">servidor</span></div>
        {activeData.nextActions.length === 0 ? <p className="panel-empty-copy">Nenhuma ação pendente no escopo visível.</p> : <ul className="workspace-action-list">{activeData.nextActions.map((action) => <li key={action.id}><Link href={action.deepLink}><span><strong>{action.label}</strong><small>{action.requestCode} · {formatRelativeTime(action.dueAt)}</small></span><PriorityBadge priority={action.priority} /><span className="row-arrow" aria-hidden="true"><Icon name="arrow-right" size={16} /></span></Link></li>)}</ul>}
      </article>
    </section>

    <section className="workspace-summary-grid" aria-label="Resumo do paciente">
      <article className="panel workspace-metric"><span>Solicitações</span><strong>{summary.requestCount}</strong><small>protocolos no escopo</small></article>
      <article className="panel workspace-metric"><span>Itens ativos</span><strong>{summary.activeItemCount}</strong><small>de {summary.itemCount} {summary.itemCount === 1 ? "item visível" : "itens visíveis"}</small></article>
      <article className="panel workspace-metric"><span>Resultados</span><strong aria-label={auxiliaryDataUnavailable ? "Indisponível" : undefined}>{auxiliaryDataUnavailable ? "—" : summary.availableResultCount}</strong><small>{auxiliaryDataUnavailable ? "Indisponível nesta leitura" : "versões liberadas"}</small></article>
      <article className="panel workspace-metric"><span>Amostras · anexos</span><strong aria-label={auxiliaryDataUnavailable ? "Indisponível" : undefined}>{auxiliaryDataUnavailable ? "—" : `${summary.sampleCount} · ${summary.attachmentCount}`}</strong><small>{auxiliaryDataUnavailable ? "Indisponível nesta leitura" : "vínculos reconciliados"}</small></article>
    </section>

    <div className="patient-detail-grid workspace-main-grid">
      <section className="panel workspace-requests-panel">
        <div className="panel-heading"><div><p className="eyebrow">Linha de cuidado</p><h2>{summary.requestCount} {summary.requestCount === 1 ? "protocolo autorizado" : "protocolos autorizados"}</h2></div><span className="timeline-count">{requestScopeLabel} · mais recente primeiro</span></div>
        {activeData.items.length === 0 ? <EmptyState title="Nenhum exame neste contexto" message="A identidade foi localizada, mas não há solicitações visíveis para este escopo." /> : <div className="patient-request-list">{activeData.items.map((request) => <article className="patient-request" key={request.id}>
          <div className="patient-request-heading"><Link href={`/requests/${request.id}`}><strong>{request.requestCode}</strong></Link><PriorityBadge priority={request.priority} /><span>{formatRelativeTime(request.createdAt)}</span></div>
          <small className="request-context-line">{request.encounter.externalId} · {aggregateStatusLabel(request.aggregateStatus)}</small>
          <div className="workspace-item-list">{request.items.map((item) => {
            const operation = item.workspaceContext.operationalContext;
            const sample = item.workspaceContext.sample;
            const result = item.workspaceContext.result;
            // The item state comes from the authorized request snapshot and
            // remains meaningful when auxiliary sample/result reads degrade.
            // Keep the domain state label, but neutralize its visual tone so
            // the UI never implies that clinical evidence was confirmed.
            const workflowStatusLabel = statusLabel(item.status);
            return <div className="workspace-item" key={item.id} id={item.id}>
              <div className="workspace-item-heading"><span className="workspace-item-icon" aria-hidden="true">{item.workflowType === "LABORATORY" ? <Icon name="lab" size={17} /> : <Icon name="imaging" size={17} />}</span><span><strong>{item.service.name}</strong><small>{item.workflowType === "LABORATORY" ? "Laboratório" : "Imagem"} · {workflowStatusLabel}</small></span><StatusBadge status={item.status} label={workflowStatusLabel} tone={auxiliaryDataUnavailable ? "neutral" : undefined} /></div>
              <div className="workspace-item-operation"><span><small>Próxima ação</small><strong>{operation.nextAction.label}</strong></span><span><small>Responsável</small><strong>{operation.currentOwner.label}</strong></span><span><small>Prazo</small><strong className={operation.escalationLevel === "URGENT" || operation.escalationLevel === "ATTENTION" ? "text-danger" : ""}>{formatSnapshotDate(operation.expectedBy ?? undefined)}</strong></span></div>
              <div className="workspace-item-links">
                {operation.blockedBy && <span className="workspace-inline-note">Bloqueado: {operation.blockedBy.label}</span>}
                {auxiliaryDataUnavailable ? <span className="workspace-inline-note workspace-inline-note-unavailable">Amostra indisponível nesta leitura</span> : sample && <span className="workspace-inline-note">Amostra {sample.accessionCode} · {sampleLabels[sample.status]}</span>}
                {auxiliaryDataUnavailable ? <span className="workspace-inline-note workspace-inline-note-unavailable">Resultado indisponível nesta leitura</span> : result ? <Link className="text-link" href={`/results/${result.id}`}>Resultado liberado{result.needsReReview ? " · revisar" : ""} <Icon name="arrow-right" size={15} /></Link> : <span className="workspace-inline-note">Resultado ainda não disponível</span>}
                {auxiliaryDataUnavailable ? <span className="workspace-inline-note workspace-inline-note-unavailable">Anexos indisponíveis nesta leitura</span> : item.workspaceContext.attachments.length > 0 && <span className="workspace-inline-note">{item.workspaceContext.attachments.length} anexo{item.workspaceContext.attachments.length === 1 ? "" : "s"} limpo{item.workspaceContext.attachments.length === 1 ? "" : "s"}</span>}
              </div>
              {!auxiliaryDataUnavailable && item.workspaceContext.attachments.length > 0 && <ul className="workspace-attachment-list" aria-label={`Anexos de ${item.service.name}`}>{item.workspaceContext.attachments.map((attachment) => <li key={attachment.id}><span><strong>{attachment.safeName}</strong><small>{attachment.detectedMime} · {formatFileSize(attachment.sizeBytes)}</small></span><span>Finalizado</span></li>)}</ul>}
            </div>;
          })}</div>
        </article>)}</div>}
        {paginationError && <ErrorState className="workspace-pagination-error" title="Não foi possível carregar mais protocolos" message={paginationError} onRetry={loadMore} retrying={loadingMore} />}
        {activeData.nextCursor && <div className="workspace-pagination"><span className="workspace-pagination-copy"><strong>{requestScopeLabel} protocolos</strong><small>O restante continua no mesmo escopo autorizado.</small></span><ActionButton tone="ghost" state={loadingMore ? "pending" : "idle"} onClick={() => void loadMore()} disabled={loading}>{loadingMore ? "Carregando…" : "Carregar mais protocolos"}</ActionButton></div>}
      </section>
      <section className="panel timeline-panel workspace-timeline-panel">
        <div className="panel-heading"><div><p className="eyebrow">Fonte de verdade</p><h2>Timeline auditável</h2></div><span className="timeline-count">{timelineScopeLabel}</span></div>
        {activeData.events.length === 0 ? <p className="panel-empty-copy">Nenhum evento disponível para o contexto autorizado.</p> : <>
          <ol className="timeline" id="patient-timeline-events">{visibleTimelineEvents.map((event) => <li key={event.id}><span className="timeline-marker" /><div><strong>{eventLabel(event.eventType)}</strong><small>{eventStateLabel(event.newState)} · {formatRelativeTime(event.occurredAt)}</small></div></li>)}</ol>
          {compactTimeline && activeData.events.length > timelinePreviewLimit && <button type="button" className="button button-ghost workspace-timeline-toggle" aria-expanded={timelineExpanded} aria-controls="patient-timeline-events" onClick={() => setTimelineExpanded((current) => !current)}>{timelineExpanded ? "Mostrar menos eventos" : "Mostrar mais eventos"}</button>}
        </>}
      </section>
    </div>
    <PatientArchive patientId={patientId} />
  </div>;
}
