"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ItemState, OperationalContext, Priority, WorkflowType } from "@cvg/contracts";
import { buildQueueFilterQuery } from "@cvg/shared-state";
import { apiFetch, formatRelativeTime, getSafeErrorMessage } from "@/components/api-client";
import { PriorityBadge, StatusBadge } from "@/components/status-badge";
import { WorkflowAction } from "@/components/workflow-action";

interface QueueItem {
  id: string;
  requestId: string;
  status: ItemState;
  workflowType: WorkflowType;
  priority: Priority;
  version: number;
  currentResultId?: string;
  currentSampleId?: string;
  procedureId?: string;
  procedureVersion?: number;
  dueAt: string;
  createdAt: string;
  requestCode: string;
  nextAction: string;
  overdue: boolean;
  patient: { id?: string; displayName: string; species: string; externalId: string };
  service: { id?: string; code?: string; name: string };
  operationalContext?: OperationalContext;
}

interface SessionUser { role: string; departmentCode: string; managedDepartmentCodes?: string[] }

const escalationLabels: Record<OperationalContext["escalationLevel"], string> = { NONE: "No prazo", WATCH: "Acompanhar", ATTENTION: "Atenção", URGENT: "Urgente" };

export function ExamQueue() {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [departments, setDepartments] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [overdue, setOverdue] = useState(false);
  const [status, setStatus] = useState<"ALL" | ItemState>("ALL");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<QueueItem | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  const openDrawer = useCallback((item: QueueItem, opener: HTMLElement) => {
    openerRef.current = opener;
    setSelected(item);
  }, []);

  const closeDrawer = useCallback(() => {
    const opener = openerRef.current;
    setSelected(null);
    window.setTimeout(() => {
      opener?.focus();
      if (openerRef.current === opener) openerRef.current = null;
    }, 0);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const me = await apiFetch<{ user: SessionUser }>("/session/me");
      const scopedDepartments = me.user.role === "MANAGER" ? Array.from(new Set([me.user.departmentCode, ...(me.user.managedDepartmentCodes ?? [])])) : [me.user.departmentCode];
      setDepartments(scopedDepartments);
      const suffix = buildQueueFilterQuery({ overdue, status });
      const queueResults = await Promise.allSettled(scopedDepartments.map((code) => apiFetch<QueueItem[]>(`/queues/${encodeURIComponent(code)}/items${suffix ? `?${suffix}` : ""}`)));
      const queues = queueResults.filter((result): result is PromiseFulfilledResult<QueueItem[]> => result.status === "fulfilled");
      const failures = queueResults.filter((result) => result.status === "rejected");
      if (queues.length === 0 && failures[0]?.status === "rejected") throw failures[0].reason;
      setItems(queues.flatMap((result) => result.value));
      if (failures.length > 0) setError("Parte das filas está indisponível; os itens visíveis podem estar desatualizados.");
    } catch (cause) {
      setError(getSafeErrorMessage(cause, "Não foi possível carregar a fila."));
    } finally {
      setLoading(false);
    }
  }, [overdue, status]);

  useEffect(() => { const timer = window.setTimeout(() => { void load(); }, 0); return () => window.clearTimeout(timer); }, [load]);
  useEffect(() => {
    const refresh = () => { void load(); };
    window.addEventListener("cvg:realtime-updated", refresh);
    window.addEventListener("cvg:realtime-resync", refresh);
    return () => { window.removeEventListener("cvg:realtime-updated", refresh); window.removeEventListener("cvg:realtime-resync", refresh); };
  }, [load]);

  const visibleItems = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("pt-BR");
    if (!query) return items;
    return items.filter((item) => [item.patient.displayName, item.patient.externalId, item.service.name, item.requestCode].some((value) => value.toLocaleLowerCase("pt-BR").includes(query)));
  }, [items, search]);

  return (
    <div className="queue-page">
      <div className="page-heading">
        <div><p className="eyebrow">Operação · {departments.join(" · ") || "escopo autorizado"}</p><h1>Central de <em>exames.</em></h1><p className="page-lede">Uma fila, contexto clínico preservado e a próxima ação explícita.</p></div>
        <div className="queue-actions"><label className="toggle"><input type="checkbox" checked={overdue} onChange={(event) => setOverdue(event.target.checked)} /><span />Somente atrasados</label><button className="button button-ghost" onClick={() => void load()}>↻ Atualizar</button></div>
      </div>
      <section className="queue-filter-bar" aria-label="Filtros da fila">
        <label>Buscar na fila<input aria-label="Buscar paciente ou exame" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Paciente, protocolo ou exame…" /></label>
        <label>Status<select aria-label="Filtrar por status" value={status} onChange={(event) => setStatus(event.target.value as "ALL" | ItemState)}><option value="ALL">Todos os status</option><option value="REQUESTED">Solicitado</option><option value="RECEIVED">Amostra recebida</option><option value="IN_PROGRESS">Em execução</option><option value="AWAITING_REPORT">Aguardando laudo</option><option value="RESULT_AVAILABLE">Resultado disponível</option><option value="RECOLLECTION_REQUIRED">Recoleta necessária</option></select></label>
        <span className="queue-filter-count" aria-live="polite">{visibleItems.length} {visibleItems.length === 1 ? "item" : "itens"}</span>
      </section>
      {error && <div className="error-state" role="alert"><span>{error}</span><button className="button button-ghost" onClick={() => void load()}>Tentar novamente</button></div>}
      <section className="panel queue-panel" aria-busy={loading}>
        <div className="queue-summary"><span><strong>{visibleItems.length}</strong> itens na fila</span><span className="queue-note">Ordenação: prioridade · prazo · espera</span></div>
        {loading ? <div className="queue-loading" role="status" aria-live="polite">Carregando fila…</div> : visibleItems.length === 0 ? <div className="empty-state"><span aria-hidden="true">✓</span><strong>Nenhum item nesta fila</strong><p>Altere os filtros ou aguarde uma solicitação no escopo do setor.</p></div> : <div className="queue-table-wrap"><table className="queue-table"><caption className="sr-only">Fila de exames</caption><thead><tr><th>Paciente</th><th>Exame</th><th>Prioridade</th><th>Status</th><th>Prazo</th><th>Próxima ação</th><th>Ação</th><th /></tr></thead><tbody>{visibleItems.map((item) => <QueueRow key={item.id} item={item} onOpen={(opener) => openDrawer(item, opener)} onComplete={() => void load()} />)}</tbody></table></div>}
      </section>
      {selected && <QueueDrawer item={selected} onClose={closeDrawer} onComplete={() => { closeDrawer(); void load(); }} />}
    </div>
  );
}

function QueueRow({ item, onOpen, onComplete }: { item: QueueItem; onOpen: (opener: HTMLElement) => void; onComplete: () => void }) {
  return <tr className={item.overdue ? "row-overdue" : ""}><td><button type="button" className="queue-cell-button table-patient" onClick={(event) => onOpen(event.currentTarget)}><strong>{item.patient.displayName}</strong><small>{item.patient.species} · {item.patient.externalId}</small></button></td><td><button type="button" className="queue-cell-button table-service" onClick={(event) => onOpen(event.currentTarget)}><strong>{item.service.name}</strong><small>{item.requestCode}</small></button></td><td><PriorityBadge priority={item.priority} /></td><td><StatusBadge status={item.status} /></td><td><span className={item.overdue ? "text-danger" : ""}>{item.overdue ? "Atrasado" : formatRelativeTime(item.dueAt)}</span></td><td><span className="next-action">{item.nextAction}</span>{item.operationalContext?.currentOwner && <small className="queue-owner">{item.operationalContext.currentOwner.label}</small>}</td><td><WorkflowAction item={item} onComplete={onComplete} /></td><td><button type="button" className="row-arrow row-context-button" onClick={(event) => onOpen(event.currentTarget)} aria-label={`Abrir contexto de ${item.service.name}`}>→</button></td></tr>;
}

function QueueDrawer({ item, onClose, onComplete }: { item: QueueItem; onClose: () => void; onComplete: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const operation = item.operationalContext;
  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    const onTab = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusable = Array.from(drawerRef.current?.querySelectorAll<HTMLElement>("button, a[href], input, select, textarea, [tabindex]:not([tabindex='-1'])") ?? []).filter((element) => !element.hasAttribute("disabled"));
      if (focusable.length === 0) { event.preventDefault(); return; }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keydown", onTab);
    return () => { window.removeEventListener("keydown", onKeyDown); window.removeEventListener("keydown", onTab); };
  }, [onClose]);
  return <div className="drawer-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}><aside ref={drawerRef} className="context-drawer" role="dialog" aria-modal="true" aria-labelledby="queue-drawer-title"><div className="drawer-heading"><div><p className="eyebrow">Contexto do exame</p><h2 id="queue-drawer-title">{item.service.name}</h2><p>{item.requestCode} · {item.patient.displayName}</p></div><button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label="Fechar contexto">×</button></div><div className="drawer-patient-card"><span className="patient-avatar">{item.patient.displayName.slice(0, 1)}</span><span><strong>{item.patient.displayName}</strong><small>{item.patient.species} · {item.patient.externalId}</small></span><PriorityBadge priority={item.priority} /></div><dl className="operation-context-list"><div><dt>Responsável atual</dt><dd>{operation?.currentOwner.label ?? "A definir"}</dd></div><div><dt>Próxima ação</dt><dd>{operation?.nextAction.label ?? item.nextAction}</dd></div><div><dt>Bloqueado por</dt><dd>{operation?.blockedBy?.label ?? "Sem bloqueio registrado"}</dd></div><div><dt>Aguardando desde</dt><dd>{formatOptionalDate(operation?.waitingSince)}</dd></div><div><dt>Prazo esperado</dt><dd className={item.overdue ? "text-danger" : ""}>{formatOptionalDate(operation?.expectedBy ?? item.dueAt)}</dd></div><div><dt>Escalonamento operacional</dt><dd><span className={`escalation-badge escalation-${(operation?.escalationLevel ?? "NONE").toLowerCase()}`}>{escalationLabels[operation?.escalationLevel ?? "NONE"]}</span></dd></div></dl><div className="drawer-actions"><WorkflowAction item={item} onComplete={onComplete} /><Link href={`/requests/${item.requestId}#${item.id}`} className="button button-ghost">Abrir workspace completo <span>→</span></Link></div><p className="drawer-note">As transições são confirmadas pelo servidor e permanecem na timeline auditável.</p></aside></div>;
}

function formatOptionalDate(value: string | null | undefined): string {
  if (!value) return "Não informado";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Não informado";
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(date);
}
