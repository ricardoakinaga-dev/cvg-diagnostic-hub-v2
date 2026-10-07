"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ITEM_STATES, type ItemState, type QueueItem, type SessionResponse, type SessionRole } from "@cvg/contracts";
import { buildQueueFilterQuery } from "@cvg/shared-state";
import { ActionButton } from "@cvg/ui";
import { apiFetch, apiFetchWithMeta, getSafeErrorMessage } from "@/components/api-client";
import type { ApiFetchResult } from "@/components/api-client";
import { QueueBoard, queueColumnLabels } from "./queue-board";
import { QueueBoardRequestDialog } from "./queue-board-request-dialog";
import { Icon } from "@/components/ui-icons";
import { ErrorState, LoadingState } from "@/components/feedback-states";

type QueueCursors = Record<string, string>;
type QueueTotals = Record<string, number>;

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

export function QueueView() {
  const [role, setRole] = useState<SessionRole>("VIEWER");
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
  const [showRequest, setShowRequest] = useState(false);
  const loadVersion = useRef(0);

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
      setRole(me.user.role);
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
  useEffect(() => {
    const createRequest = () => setShowRequest(true);
    window.addEventListener("cvg:create-request", createRequest);
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams(window.location.search);
      if (params.get("create") !== "request") return;
      createRequest();
      params.delete("create");
      const query = params.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
    }, 0);
    return () => { window.clearTimeout(timer); window.removeEventListener("cvg:create-request", createRequest); };
  }, []);

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
        <label>Status<select aria-label="Filtrar por status" value={status} onChange={(event) => setStatus(event.target.value as "ALL" | ItemState)}><option value="ALL">Todos os status</option>{ITEM_STATES.map((state) => <option key={state} value={state}>{queueColumnLabels[state]}</option>)}</select></label>
        <span className="queue-filter-count" aria-live="polite">{visibleItems.length} {visibleItems.length === 1 ? "item" : "itens"}</span>
      </section>
       {error && <ErrorState title="Fila parcialmente indisponível" message={error} onRetry={load} retrying={loading} />}
       <section className="panel queue-panel" aria-busy={loading}>
         <div className="queue-summary"><span><strong>{visibleItems.length}</strong>{hasMore ? ` de ${totalItems} itens na fila` : " itens na fila"}</span><span className="queue-note">Ordenação: prioridade · prazo · espera</span></div>
         {loading && items.length === 0 ? <LoadingState className="queue-loading" label="Carregando fila" /> : <QueueBoard items={visibleItems} role={role} departments={departments} refreshing={loading} onComplete={() => void load()} />}
         {paginationError && <ErrorState className="queue-pagination-error" title="Não foi possível carregar mais itens" message={paginationError} onRetry={loadMore} retrying={loadingMore} />}
        {hasMore && <div className="queue-pagination"><span className="queue-pagination-copy"><strong>Mostrando {items.length} de {totalItems} itens</strong><small>O restante continua no mesmo escopo autorizado.</small></span><ActionButton tone="ghost" state={loadingMore ? "pending" : "idle"} onClick={() => void loadMore()} disabled={loading}>{loadingMore ? "Carregando…" : "Carregar mais itens"}</ActionButton></div>}
      </section>
      {showRequest && ["MANAGER", "VETERINARIAN", "VET", "INPATIENT_TEAM"].includes(role) && <QueueBoardRequestDialog departments={role === "MANAGER" ? departments : []} canCreatePatient={["VETERINARIAN", "VET", "INPATIENT_TEAM"].includes(role)} onClose={() => setShowRequest(false)} onCreated={() => { setShowRequest(false); void load(); }} />}
    </div>
  );
}
