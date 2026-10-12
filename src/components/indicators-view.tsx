"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DashboardView } from "@cvg/contracts";
import { ActionButton } from "@cvg/ui";
import { apiFetch, formatRelativeTime } from "./api-client";
import { EmptyState, ErrorState, LoadingState, PartialNotice } from "./feedback-states";
import { priorityLabel, statusLabel } from "./status-badge";
import { Icon } from "./ui-icons";
import { useWorkItems } from "./work-items/use-work-items";
import { activeWorkItems } from "./work-items/model";

type IndicatorKey = DashboardView["indicators"][number]["key"];
type Stats = DashboardView;

interface IndicatorData {
  stats: Stats;
}

const departmentLabels: Record<string, string> = { INPATIENT: "Internação", LABORATORY: "Laboratório", RADIOLOGY: "Radiologia", ULTRASOUND: "Ultrassom", OPERATIONS: "Operações" };

const cards: Array<{ key: IndicatorKey; label: string; caption: string; tone: string; href: string }> = [
  { key: "overdue", label: "Atrasados", caption: "itens fora do SLA", tone: "danger", href: "/queues?preset=overdue" },
  { key: "recollections", label: "Recoletas", caption: "nova amostra necessária", tone: "warning", href: "/queues?preset=recollections" },
  { key: "newResults", label: "Resultados novos", caption: "aguardam revisão", tone: "success", href: "/queues?preset=results" },
  { key: "critical", label: "Críticos", caption: "confirmação necessária", tone: "critical", href: "/notifications" },
  { key: "totalActive", label: "Ativos", caption: "itens não terminais", tone: "info", href: "/queues?view=mine" },
];

export function IndicatorsView() {
  const [data, setData] = useState<IndicatorData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const work = useWorkItems();
  const queue = activeWorkItems(work.items);
  const dataRef = useRef<IndicatorData | null>(null);
  const loadVersion = useRef(0);

  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    setLoading(true);
    setError("");
    try {
      const stats = await apiFetch<Stats>("/dashboard");
      if (loadVersion.current !== version) return;
      const nextData = { stats };
      dataRef.current = nextData;
      setData(nextData);
    } catch {
      if (loadVersion.current !== version) return;
      setError(dataRef.current ? "Parte dos indicadores está indisponível; os dados visíveis podem estar desatualizados." : "Não foi possível carregar os indicadores.");
    }
    if (loadVersion.current === version) setLoading(false);
  }, []);

  useEffect(() => { const timer = window.setTimeout(() => { void load(); }, 0); return () => { window.clearTimeout(timer); loadVersion.current += 1; }; }, [load]);
  useEffect(() => { const refresh = () => { void load(); }; window.addEventListener("cvg:realtime-updated", refresh); window.addEventListener("cvg:realtime-resync", refresh); return () => { window.removeEventListener("cvg:realtime-updated", refresh); window.removeEventListener("cvg:realtime-resync", refresh); }; }, [load]);

  if (!data && loading) return <LoadingState label="Carregando indicadores" />;
  if (!data) return <ErrorState page title="Indicadores indisponíveis" message={error} onRetry={load} retrying={loading} />;

  return (
    <div className="indicators-page">
      <div className="page-heading">
        <div><p className="eyebrow">Operação · visão de capacidade</p><h1>Indicadores <em>operacionais.</em></h1><p className="page-lede">Leitura do escopo autorizado, sem transformar o Hub em um painel de BI.</p></div>
        <ActionButton tone="ghost" state={loading ? "pending" : "idle"} onClick={() => { void load(); void work.reload(); }}><Icon name="refresh" size={15} /> {loading ? "Atualizando…" : "Atualizar"}</ActionButton>
      </div>
      {error && <PartialNotice message={error} onRetry={load} retrying={loading} retryLabel="Reconciliar" />}
      {work.truncated && <button type="button" className="button button-ghost" disabled={work.loadingMore || work.refreshing} onClick={() => void work.loadMore()}>{work.loadingMore ? "Carregando exames…" : "Carregar mais exames da fila"}</button>}
      {work.paginationError && <p role="alert">{work.paginationError}</p>}
      <section className="indicator-meta" aria-label="Contexto dos indicadores"><span>Setores: {(data.stats.departments ?? []).map((department) => departmentLabels[department.departmentCode] ?? department.label).join(" · ") || "Escopo autorizado"}</span><span>Janela: {data.stats.window.label}</span><span>Fuso: {data.stats.window.timezone}</span><span>Atualizado {formatRelativeTime(data.stats.window.asOf)}</span></section>
      <section className="metric-grid indicator-grid" aria-label="Indicadores operacionais">{cards.map((card) => { const indicator = data.stats.indicators.find((entry) => entry.key === card.key); return <article className={`metric-card metric-${card.tone}`} key={card.key}><div className="metric-top"><span>{card.label}</span></div><strong>{data.stats[card.key]}</strong><small>{card.caption}</small><Link href={card.href}>Abrir {card.label.toLocaleLowerCase("pt-BR")}</Link>{indicator && <small>Denominador: {indicator.denominator}</small>}</article>; })}</section>
       <div className="indicator-columns">
        <section className="panel"><div className="panel-heading"><div><p className="eyebrow">Fila autorizada</p><h2>{queue.length} itens ativos no escopo</h2></div><span className="timeline-count">agora</span></div>{work.loading ? <LoadingState label="Carregando fila autorizada" /> : work.error && !work.items.length ? <ErrorState title="Fila indisponível" message={work.error} onRetry={work.reload} retrying={work.refreshing} /> : queue.length === 0 ? <EmptyState announce={!error && !loading} title="Nenhum item ativo no escopo autorizado" message="O estado vazio é real para o escopo atual; nenhuma métrica foi estimada." /> : <ul className="indicator-list">{queue.slice(0, 10).map((item) => <li key={item.id}><Link href={`/requests/${encodeURIComponent(item.requestId)}#${encodeURIComponent(item.id)}`}><strong>{item.patient.displayName} · {item.service.name}</strong></Link><span><strong>{statusLabel(item.status)}</strong><small>{priorityLabel(item.priority)}{item.overdue ? " · atrasado" : ""}</small></span><span className={item.overdue ? "text-danger" : "text-success"}>{item.overdue ? "Fora do SLA" : "No prazo"}</span></li>)}</ul>}<Link href="/queues?view=mine" className="text-link">Abrir todos os itens ativos</Link>{(work.partial || work.truncated || work.error) && <p role="status">{work.partial || work.error || "A lista carregada é parcial; carregue os próximos itens na fila."}</p>}</section>
        <section className="panel"><div className="panel-heading"><div><p className="eyebrow">Definições</p><h2>Leitura honesta</h2></div></div><div className="indicator-copy"><ul className="indicator-definition-list">{data.stats.indicators.map((indicator) => <li key={indicator.key}><p><strong>{indicator.label}</strong> {indicator.definition}</p><small>Denominador: {indicator.denominator} ({indicator.denominatorDefinition}). Próxima ação: {indicator.nextAction}</small></li>)}</ul><p className="indicator-muted">Não há distribuição de tempo de resposta disponível neste ambiente.</p></div></section>
      </div>
    </div>
  );
}
