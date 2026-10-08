"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import type { ItemState, OperationalContext, SessionRole, TimelineEvent } from "@cvg/contracts";
import { apiFetch, formatRelativeTime, getSafeErrorMessage } from "@/components/api-client";
import { Icon } from "@/components/ui-icons";
import { canUseWorkflowAction, WorkflowAction, workflowActionForTransition, type WorkflowActionKind } from "@/components/workflow-action";
import { eventLabel, eventStateLabel } from "@/components/request-detail";
import { SampleLabelLink } from "@/components/sample-label";
import { useDialogFocus } from "@/components/use-dialog-focus";
import { Avatar, DepartmentIcon, PriorityIcon } from "./icons";
import { StatePill, WorkItemKey } from "./properties";
import { PRIORITY_LABELS, departmentLabel, formatDateTime, type WorkItem } from "./model";

const escalationLabels: Record<OperationalContext["escalationLevel"], string> = { NONE: "No prazo", WATCH: "Acompanhar", ATTENTION: "Atenção", URGENT: "Urgente" };

const mobileQuery = "(max-width: 960px)";
function subscribeMobile(onChange: () => void) {
  if (typeof window.matchMedia !== "function") return () => undefined;
  const media = window.matchMedia(mobileQuery);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}
function isMobile() { return typeof window.matchMedia === "function" && window.matchMedia(mobileQuery).matches; }
function serverMobile() { return false; }

function MobilePeekFocus({ panel, heading, opener, onClose }: { panel: RefObject<HTMLElement | null>; heading: RefObject<HTMLHeadingElement | null>; opener: RefObject<HTMLElement | null>; onClose: () => void }) {
  useDialogFocus(panel, () => {
    if (!document.activeElement?.closest("form, [role=menu], .popover-panel")) onClose();
  }, heading, opener);
  return null;
}

function Property({ icon, label, children }: { icon: Parameters<typeof Icon>[0]["name"]; label: string; children: React.ReactNode }) {
  return <div className="peek-property"><dt><Icon name={icon} size={14} />{label}</dt><dd>{children}</dd></div>;
}

/**
 * Plane's side peek: the item opens beside the list, which stays visible and
 * interactive. Workflow commands reuse WorkflowAction, so every clinical rule
 * (reasons, accession, schedule window, drafts) is the same as the full page.
 */
export function PeekOverview({ item, role, initialAction, onClose, onChanged, onRefresh, onMove }: { item: WorkItem; role: SessionRole; initialAction?: WorkflowActionKind; onClose: () => void; onChanged: () => void; onRefresh: () => void; onMove: (item: WorkItem, target: ItemState) => void }) {
  const panelRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[] | null>(null);
  const [timelineError, setTimelineError] = useState("");
  const [secondaryAction, setAction] = useState<WorkflowActionKind>();
  const action = initialAction ?? secondaryAction;
  const [copied, setCopied] = useState(false);
  const operation = item.operationalContext;
  const mobile = useSyncExternalStore(subscribeMobile, isMobile, serverMobile);

  // Focus moves into the peek and returns to whatever opened it when it closes.
  // The opener is read on the first render, before any effect moves focus.
  const [opener] = useState(() => typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const openerRef = useRef(opener);
  useEffect(() => {
    headingRef.current?.focus();
    return () => { if (opener?.isConnected && !document.activeElement?.closest(".peek")) opener.focus(); };
  }, [opener]);

  // On phones the peek covers the screen; the shell makes its bottom bar inert meanwhile.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("cvg:peek", { detail: true }));
    return () => { window.dispatchEvent(new CustomEvent("cvg:peek", { detail: false })); };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector("[data-dialog-layer='true']")) return;
      if (event.target instanceof Element && event.target.closest("form, [role=menu], .popover-panel")) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let active = true;
    const load = () => apiFetch<TimelineEvent[]>(`/timeline?requestId=${encodeURIComponent(item.requestId)}`)
      .then((events) => { if (active) { setTimeline(events); setTimelineError(""); } })
      .catch((cause: unknown) => { if (active) setTimelineError(getSafeErrorMessage(cause, "Atividade indisponível no momento.")); });
    void load();
    window.addEventListener("cvg:realtime-updated", load);
    return () => { active = false; window.removeEventListener("cvg:realtime-updated", load); };
  }, [item.requestId, item.version]);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/requests/${item.requestId}#${item.id}`);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard is optional */ }
  }

  const canAmend = !action && item.currentResultId && ["RESULT_AVAILABLE", "REVIEWED", "COMPLETED"].includes(item.status) && canUseWorkflowAction(role, "AMEND", item);
  const canCancel = !action && workflowActionForTransition(item, "CANCELLED") === "CANCEL" && canUseWorkflowAction(role, "CANCEL", item);
  const canReject = !action && workflowActionForTransition(item, "REJECTED") === "REJECT" && canUseWorkflowAction(role, "REJECT", item);

  return <aside ref={panelRef} className="peek" role="dialog" aria-modal={mobile} aria-labelledby="peek-title">
    {mobile && <MobilePeekFocus panel={panelRef} heading={headingRef} opener={openerRef} onClose={onClose} />}
    <div className="peek-toolbar">
      <button type="button" className="icon-button" onClick={onClose} aria-label="Fechar contexto" title="Fechar (Esc)"><Icon name="arrow-right" size={16} /></button>
      <Link className="icon-button" href={`/requests/${item.requestId}#${item.id}`} aria-label="Abrir workspace completo" title="Abrir página completa"><Icon name="expand" size={15} /></Link>
      <span className="peek-toolbar-spacer" />
      <button type="button" className="header-button" onClick={() => void copyLink()} aria-live="polite"><Icon name="link" size={13} />{copied ? "Link copiado" : "Copiar link"}</button>
    </div>
    <div className="peek-body">
      <div className="peek-heading">
        <span className="peek-key"><DepartmentIcon code={item.departmentCode} size={13} /><WorkItemKey item={item} /></span>
        <h2 id="peek-title" ref={headingRef} tabIndex={-1}>{item.service.name}</h2>
        <p className="peek-subtitle"><Link href={`/patients/${item.patient.id}/diagnostics`}>{item.patient.displayName}</Link> · {item.patient.species}{item.patient.breed ? ` · ${item.patient.breed}` : ""} · {item.patient.externalId}{item.patient.ownerLabel ? ` · tutor ${item.patient.ownerLabel}` : ""}</p>
      </div>

      {item.overdue && <div className="peek-callout peek-callout-danger" role="note"><Icon name="clock" size={15} /><span><strong>Prazo vencido.</strong> Esperado até {formatDateTime(operation?.expectedBy ?? item.dueAt)}.</span></div>}
      {operation?.blockedBy && <div className="peek-callout" role="note"><Icon name="attention" size={15} /><span><strong>Bloqueado:</strong> {operation.blockedBy.label}</span></div>}

      <section className="peek-actions" aria-label="Ações do exame">
        <WorkflowAction key={`${item.id}:${action ?? "context"}`} item={item} initialAction={action} role={role} onComplete={() => { setAction(undefined); onChanged(); }} onDraftCreated={onRefresh} />
        {(canAmend || canCancel || canReject) && <div className="peek-secondary-actions">
          {canAmend && <button type="button" className="header-button" onClick={() => setAction("AMEND")}>Emendar resultado</button>}
          {canReject && <button type="button" className="header-button" onClick={() => setAction("REJECT")}>Rejeitar</button>}
          {canCancel && <button type="button" className="header-button header-button-danger" onClick={() => setAction("CANCEL")}>Cancelar exame</button>}
        </div>}
      </section>

      <section className="peek-section" aria-labelledby="peek-properties">
        <h3 id="peek-properties">Propriedades</h3>
        <dl className="peek-properties">
          <Property icon="layers" label="Estado"><StatePill item={item} role={role} onMove={onMove} /></Property>
          <Property icon="analytics" label="Prioridade"><span className="cell-inline"><PriorityIcon priority={item.priority} />{PRIORITY_LABELS[item.priority]}</span></Property>
          <Property icon="paw" label="Paciente"><Link className="peek-link" href={`/patients/${item.patient.id}/diagnostics`}>{item.patient.displayName}</Link></Property>
          <Property icon="hash" label="Exame">{item.service.name}</Property>
          <Property icon="building" label="Setor"><span className="cell-inline"><DepartmentIcon code={item.departmentCode} size={13} />{departmentLabel(item.departmentCode)}</span></Property>
          {operation && <Property icon="users" label="Responsável"><span className="cell-inline"><Avatar name={operation.currentOwner.label} size="xs" />{operation.currentOwner.label}</span></Property>}
          <Property icon="arrow-right" label="Próxima ação">{operation?.nextAction.label ?? item.nextAction ?? "Sem ação pendente"}</Property>
          <Property icon="calendar" label="Prazo"><span className={item.overdue ? "text-danger" : ""}>{formatDateTime(operation?.expectedBy ?? item.dueAt)}</span></Property>
          {operation?.waitingSince && <Property icon="clock" label="Aguardando desde">{formatDateTime(operation.waitingSince)}</Property>}
          {operation && <Property icon="attention" label="Escalonamento"><span className={`escalation-badge escalation-${operation.escalationLevel.toLowerCase()}`}>{escalationLabels[operation.escalationLevel]}</span></Property>}
          <Property icon="requests" label="Protocolo"><Link className="peek-link mono" href={`/requests/${item.requestId}#${item.id}`}>{item.requestCode}</Link></Property>
          <Property icon="calendar" label="Solicitado em">{formatDateTime(item.createdAt)}</Property>
          {item.currentSampleId && <Property icon="hash" label="Amostra"><SampleLabelLink sampleId={item.currentSampleId} /></Property>}
          {item.currentResultId && <Property icon="check" label="Resultado"><Link className="peek-link" href={`/results/${item.currentResultId}`}>Abrir resultado <Icon name="external" size={12} /></Link></Property>}
        </dl>
      </section>

      <section className="peek-section" aria-labelledby="peek-activity">
        <h3 id="peek-activity">Atividade</h3>
        {timelineError && <p className="peek-muted" role="status">{timelineError}</p>}
        {!timeline && !timelineError && <p className="peek-muted" role="status">Carregando atividade…</p>}
        {timeline && timeline.length === 0 && <p className="peek-muted">Nenhum evento registrado ainda.</p>}
        {timeline && timeline.length > 0 && <ol className="activity">
          {[...timeline].reverse().map((event) => <li key={event.id}><span className="activity-dot" aria-hidden="true" /><div><strong>{eventLabel(event.eventType)}</strong><span>{eventStateLabel(event.newState)}</span></div><time dateTime={event.occurredAt} title={formatDateTime(event.occurredAt)}>{formatRelativeTime(event.occurredAt)}</time></li>)}
        </ol>}
      </section>
    </div>
  </aside>;
}
