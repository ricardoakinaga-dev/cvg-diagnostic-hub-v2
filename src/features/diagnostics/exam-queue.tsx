"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ItemState, OperationalContext, QueueItem, SessionResponse } from "@cvg/contracts";
import { buildQueueFilterQuery } from "@cvg/shared-state";
import { ActionButton } from "@cvg/ui";
import { apiFetch, apiFetchWithMeta, formatRelativeTime, getSafeErrorMessage } from "@/components/api-client";
import type { ApiFetchResult } from "@/components/api-client";
import { PriorityBadge, StatusBadge } from "@/components/status-badge";
import { WorkflowAction } from "@/components/workflow-action";
import { Icon } from "@/components/ui-icons";
import { useDialogFocus } from "@/components/use-dialog-focus";
import { EmptyState, ErrorState, LoadingState } from "@/components/feedback-states";

type QueueCursors = Record<string, string>;
type QueueTotals = Record<string, number>;

const escalationLabels: Record<OperationalContext["escalationLevel"], string> = { NONE: "No prazo", WATCH: "Acompanhar", ATTENTION: "Atenção", URGENT: "Urgente" };
const mobileQueueMediaQuery = "(max-width: 960px)";

function subscribeToMobileQueue(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
  const media = window.matchMedia(mobileQueueMediaQuery);
  const listener = () => onChange();
  media.addEventListener?.("change", listener);
  return () => media.removeEventListener?.("change", listener);
}

function getMobileQueueSnapshot(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof window.matchMedia !== "function") return true;
  return window.matchMedia(mobileQueueMediaQuery).matches;
}

function getServerMobileQueueSnapshot(): boolean {
  return false;
}

function queuePath(departmentCode: string, filters: { overdue: boolean; status: "ALL" | ItemState }, cursor?: string): string {
  const params = new URLSearchParams(buildQueueFilterQuery(filters));
  if (cursor) params.set("cursor", cursor);
  const suffix = params.toString();
  return `/queues/${encodeURIComponent(departmentCode)}/items${suffix ? `?${suffix}` : ""}`;
}

function nextCursorFromMeta(meta: Record<string, unknown>): string | undefined {
  return typeof meta.nextCursor === "string" && meta.nextCursor.length > 0 ? meta.nextCursor : undefined;
}

function totalFromMeta(meta: Record<string, unknown>, fallback: number): number {
  return typeof meta.total === "number" && Number.isSafeInteger(meta.total) && meta.total >= 0 ? meta.total : fallback;
}

function mergeQueueItems(current: QueueItem[], additions: QueueItem[]): QueueItem[] {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of additions) byId.set(item.id, item);
  return [...byId.values()];
}

export function ExamQueue() {
  const isMobileQueue = useSyncExternalStore(subscribeToMobileQueue, getMobileQueueSnapshot, getServerMobileQueueSnapshot);
  const [items, setItems] = useState<QueueItem[]>([]);
  const [departments, setDepartments] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [paginationError, setPaginationError] = useState("");
  const [nextCursors, setNextCursors] = useState<QueueCursors>({});
  const [totals, setTotals] = useState<QueueTotals>({});
  const [overdue, setOverdue] = useState(false);
  const [status, setStatus] = useState<"ALL" | ItemState>("ALL");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<QueueItem | null>(null);
  const loadVersion = useRef(0);

  const openDrawer = useCallback((item: QueueItem, opener: HTMLElement) => {
    opener.focus();
    setSelected(item);
  }, []);

  const closeDrawer = useCallback(() => setSelected(null), []);

  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    setLoading(true);
    setLoadingMore(false);
    setError("");
    setPaginationError("");
    try {
      const me = await apiFetch<SessionResponse>("/session/me");
      const scopedDepartments = me.user.role === "MANAGER" ? Array.from(new Set([me.user.departmentCode, ...(me.user.managedDepartmentCodes ?? [])])) : [me.user.departmentCode];
      const queueResults = await Promise.allSettled(scopedDepartments.map(async (code) => ({ code, page: await apiFetchWithMeta<QueueItem[]>(queuePath(code, { overdue, status })) })));
      if (loadVersion.current !== version) return;
      const queues = queueResults.filter((result): result is PromiseFulfilledResult<{ code: string; page: ApiFetchResult<QueueItem[]> }> => result.status === "fulfilled");
      const failures = queueResults.filter((result) => result.status === "rejected");
      if (queues.length === 0 && failures[0]?.status === "rejected") throw failures[0].reason;
      const loadedCursors = Object.fromEntries(queues.flatMap(({ value: { code, page } }) => {
        const cursor = nextCursorFromMeta(page.meta);
        return cursor ? [[code, cursor]] : [];
      })) as QueueCursors;
      const loadedTotals = Object.fromEntries(queues.map(({ value: { code, page } }) => [code, totalFromMeta(page.meta, page.data.length)])) as QueueTotals;
      setDepartments(scopedDepartments);
      setItems(mergeQueueItems([], queues.flatMap((result) => result.value.page.data)));
      setNextCursors(loadedCursors);
      setTotals(loadedTotals);
      if (failures.length > 0) setError("Parte das filas está indisponível; os itens visíveis podem estar desatualizados.");
    } catch (cause) {
      if (loadVersion.current === version) setError(getSafeErrorMessage(cause, "Não foi possível carregar a fila."));
    } finally {
      if (loadVersion.current === version) setLoading(false);
    }
  }, [overdue, status]);

  const loadMore = useCallback(async () => {
    if (loading || loadingMore) return;
    const cursorEntries = Object.entries(nextCursors);
    if (cursorEntries.length === 0) return;
    const version = loadVersion.current;
    setLoadingMore(true);
    setPaginationError("");
    const pageResults = await Promise.allSettled(cursorEntries.map(async ([code, cursor]) => ({ code, page: await apiFetchWithMeta<QueueItem[]>(queuePath(code, { overdue, status }, cursor)) })));
    if (loadVersion.current !== version) return;
    const pages = pageResults.filter((result): result is PromiseFulfilledResult<{ code: string; page: ApiFetchResult<QueueItem[]> }> => result.status === "fulfilled");
    const failures = pageResults.filter((result) => result.status === "rejected");
    if (pages.length > 0) {
      setItems((current) => mergeQueueItems(current, pages.flatMap((result) => result.value.page.data)));
      setNextCursors((current) => {
        const next = { ...current };
        for (const { value: { code, page } } of pages) {
          const cursor = nextCursorFromMeta(page.meta);
          if (cursor) next[code] = cursor;
          else delete next[code];
        }
        return next;
      });
      setTotals((current) => {
        const next = { ...current };
        for (const { value: { code, page } } of pages) next[code] = totalFromMeta(page.meta, page.data.length);
        return next;
      });
    }
    if (failures.length > 0) setPaginationError(pages.length > 0 ? "Parte das filas não pôde ser carregada; tente novamente." : "Não foi possível carregar mais itens da fila. Tente novamente.");
    setLoadingMore(false);
  }, [loading, loadingMore, nextCursors, overdue, status]);

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
  const totalItems = useMemo(() => Object.values(totals).reduce((sum, total) => sum + total, 0), [totals]);
  const hasMore = Object.keys(nextCursors).length > 0;

  return (
    <div className="queue-page">
      <div className="page-heading">
        <div><p className="eyebrow">Operação · {departments.join(" · ") || "escopo autorizado"}</p><h1>Central de <em>exames.</em></h1><p className="page-lede">Uma fila, contexto clínico preservado e a próxima ação explícita.</p></div>
        <div className="queue-actions"><label className="toggle"><input type="checkbox" checked={overdue} onChange={(event) => setOverdue(event.target.checked)} /><span />Somente atrasados</label><ActionButton tone="ghost" state={loading ? "pending" : "idle"} onClick={() => void load()}><Icon name="refresh" size={15} /> {loading ? "Atualizando…" : "Atualizar"}</ActionButton></div>
      </div>
      <section className="queue-filter-bar" aria-label="Filtros da fila">
        <label>Buscar na fila<input aria-label="Buscar paciente ou exame" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Paciente, protocolo ou exame…" /></label>
        <label>Status<select aria-label="Filtrar por status" value={status} onChange={(event) => setStatus(event.target.value as "ALL" | ItemState)}><option value="ALL">Todos os status</option><option value="REQUESTED">Solicitado</option><option value="RECEIVED">Amostra recebida</option><option value="IN_PROGRESS">Em execução</option><option value="AWAITING_REPORT">Aguardando laudo</option><option value="RESULT_AVAILABLE">Resultado disponível</option><option value="RECOLLECTION_REQUIRED">Recoleta necessária</option></select></label>
        <span className="queue-filter-count" aria-live="polite">{visibleItems.length} {visibleItems.length === 1 ? "item" : "itens"}</span>
      </section>
       {error && <ErrorState title="Fila parcialmente indisponível" message={error} onRetry={load} retrying={loading} />}
       <section className="panel queue-panel" aria-busy={loading}>
         <div className="queue-summary"><span><strong>{visibleItems.length}</strong>{hasMore ? ` de ${totalItems} itens na fila` : " itens na fila"}</span><span className="queue-note">Ordenação: prioridade · prazo · espera</span></div>
         {loading ? <LoadingState className="queue-loading" label="Carregando fila" /> : visibleItems.length === 0 ? <EmptyState title="Nenhum item nesta fila" message="Altere os filtros ou aguarde uma solicitação no escopo do setor." /> : isMobileQueue ? <div className="queue-mobile-list" role="list" aria-label="Itens da fila em cartões">
           {visibleItems.map((item) => <QueueCard key={item.id} item={item} onOpen={(opener) => openDrawer(item, opener)} onComplete={() => void load()} />)}
        </div> : <div className="queue-table-wrap queue-desktop-table">
          <table className="queue-table">
            <caption className="sr-only">Fila de exames</caption>
            <thead><tr><th>Paciente</th><th>Exame</th><th>Prioridade</th><th>Status</th><th>Prazo</th><th>Próxima ação</th><th>Ação</th><th /></tr></thead>
             <tbody>{visibleItems.map((item) => <QueueRow key={item.id} item={item} onOpen={(opener) => openDrawer(item, opener)} onComplete={() => void load()} />)}</tbody>
          </table>
        </div>}
         {paginationError && <ErrorState className="queue-pagination-error" title="Não foi possível carregar mais itens" message={paginationError} onRetry={loadMore} retrying={loadingMore} />}
        {hasMore && <div className="queue-pagination"><span className="queue-pagination-copy"><strong>Mostrando {items.length} de {totalItems} itens</strong><small>O restante continua no mesmo escopo autorizado.</small></span><ActionButton tone="ghost" state={loadingMore ? "pending" : "idle"} onClick={() => void loadMore()} disabled={loading}>{loadingMore ? "Carregando…" : "Carregar mais itens"}</ActionButton></div>}
      </section>
      {selected && <QueueDrawer item={selected} onClose={closeDrawer} onComplete={() => { closeDrawer(); void load(); }} />}
    </div>
  );
}

function QueueRow({ item, onOpen, onComplete }: { item: QueueItem; onOpen: (opener: HTMLElement) => void; onComplete: () => void }) {
  const owner = item.operationalContext?.currentOwner?.label ?? "A definir";
  return <tr className={item.overdue ? "row-overdue" : ""}><td><button type="button" className="queue-cell-button table-patient" onClick={(event) => onOpen(event.currentTarget)}><strong>{item.patient.displayName}</strong><small>{item.patient.species} · {item.patient.externalId}</small></button></td><td><button type="button" className="queue-cell-button table-service" onClick={(event) => onOpen(event.currentTarget)}><strong>{item.service.name}</strong><small>{item.requestCode}</small></button></td><td><PriorityBadge priority={item.priority} /></td><td><StatusBadge status={item.status} /></td><td><span className={item.overdue ? "text-danger" : ""}>{item.overdue ? "Atrasado" : formatRelativeTime(item.dueAt)}</span></td><td><span className="next-action">{item.nextAction}</span><small className="queue-owner"><span>Responsável</span><span>{owner}</span></small></td><td><WorkflowAction item={item} onComplete={onComplete} /></td><td><button type="button" className="row-arrow row-context-button" onClick={(event) => onOpen(event.currentTarget)} aria-label={`Abrir contexto de ${item.service.name}`}><Icon name="arrow-right" size={16} /></button></td></tr>;
}

function QueueCard({ item, onOpen, onComplete }: { item: QueueItem; onOpen: (opener: HTMLElement) => void; onComplete: () => void }) {
  const owner = item.operationalContext?.currentOwner?.label ?? "A definir";
  return <article className={`queue-card${item.overdue ? " queue-card-overdue" : ""}`} role="listitem">
    <div className="queue-card-heading">
       <button type="button" className="queue-card-patient" onClick={(event) => onOpen(event.currentTarget)}>
        <span className="patient-avatar" aria-hidden="true">{item.patient.displayName.slice(0, 1)}</span>
        <span><strong>{item.patient.displayName}</strong><small>{item.patient.species} · {item.patient.externalId}</small></span>
      </button>
       <button type="button" className="row-arrow row-context-button queue-card-context-button" onClick={(event) => onOpen(event.currentTarget)} aria-label={`Abrir contexto de ${item.service.name}`}><Icon name="arrow-right" size={16} /></button>
    </div>
    <div className="queue-card-service">
      <span className="queue-card-label">Exame solicitado</span>
       <button type="button" className="queue-card-service-button" onClick={(event) => onOpen(event.currentTarget)}>
        <strong>{item.service.name}</strong><small>{item.requestCode}</small>
      </button>
    </div>
    <div className="queue-card-signals">
      <div className="queue-card-signal"><span>Prioridade</span><PriorityBadge priority={item.priority} /></div>
      <div className="queue-card-signal"><span>Status</span><StatusBadge status={item.status} /></div>
      <div className="queue-card-signal queue-card-deadline"><span>Prazo</span><strong className={item.overdue ? "text-danger" : ""}>{item.overdue ? "Atrasado" : formatRelativeTime(item.dueAt)}</strong><small>{formatOptionalDate(item.dueAt)}</small></div>
    </div>
    <div className="queue-card-next">
      <span className="queue-card-label">Próxima ação</span>
      <strong>{item.nextAction}</strong>
      <small className="queue-card-owner"><span>Responsável atual</span><span>{owner}</span></small>
    </div>
    <div className="queue-card-actions"><WorkflowAction item={item} onComplete={onComplete} /><span className="queue-card-action-hint">Confirmação pelo servidor</span></div>
  </article>;
}

function QueueDrawer({ item, onClose, onComplete }: { item: QueueItem; onClose: () => void; onComplete: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const operation = item.operationalContext;
  useDialogFocus(drawerRef, onClose, closeRef);
  return <div className="drawer-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}><aside ref={drawerRef} className="context-drawer" role="dialog" aria-modal="true" aria-labelledby="queue-drawer-title"><div className="drawer-heading"><div><p className="eyebrow">Contexto do exame</p><h2 id="queue-drawer-title">{item.service.name}</h2><p>{item.requestCode} · {item.patient.displayName}</p></div><button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label="Fechar contexto"><Icon name="close" size={18} /></button></div><div className="drawer-patient-card"><span className="patient-avatar">{item.patient.displayName.slice(0, 1)}</span><span><strong>{item.patient.displayName}</strong><small>{item.patient.species} · {item.patient.externalId}</small></span><PriorityBadge priority={item.priority} /></div><dl className="operation-context-list"><div><dt>Responsável atual</dt><dd>{operation?.currentOwner.label ?? "A definir"}</dd></div><div><dt>Próxima ação</dt><dd>{operation?.nextAction.label ?? item.nextAction}</dd></div><div><dt>Bloqueado por</dt><dd>{operation?.blockedBy?.label ?? "Sem bloqueio registrado"}</dd></div><div><dt>Aguardando desde</dt><dd>{formatOptionalDate(operation?.waitingSince)}</dd></div><div><dt>Prazo esperado</dt><dd className={item.overdue ? "text-danger" : ""}>{formatOptionalDate(operation?.expectedBy ?? item.dueAt)}</dd></div><div><dt>Escalonamento operacional</dt><dd><span className={`escalation-badge escalation-${(operation?.escalationLevel ?? "NONE").toLowerCase()}`}>{escalationLabels[operation?.escalationLevel ?? "NONE"]}</span></dd></div></dl><div className="drawer-actions"><WorkflowAction item={item} onComplete={onComplete} /><Link href={`/requests/${item.requestId}#${item.id}`} className="button button-ghost">Abrir workspace completo <Icon name="arrow-right" size={15} /></Link></div><p className="drawer-note">As transições são confirmadas pelo servidor e permanecem na timeline auditável.</p></aside></div>;
}

function formatOptionalDate(value: string | null | undefined): string {
  if (!value) return "Não informado";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Não informado";
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(date);
}
