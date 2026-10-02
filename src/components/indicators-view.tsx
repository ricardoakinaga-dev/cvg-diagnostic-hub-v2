"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DashboardView, IndicatorQueueItem, SessionResponse } from "@cvg/contracts";
import { ActionButton } from "@cvg/ui";
import { apiFetch, formatRelativeTime } from "./api-client";
import { EmptyState, ErrorState, LoadingState, PartialNotice } from "./feedback-states";
import { priorityLabel, statusLabel } from "./status-badge";
import { Icon } from "./ui-icons";

type IndicatorKey = DashboardView["indicators"][number]["key"];
type Stats = DashboardView;

interface IndicatorData {
  stats: Stats;
  queue: IndicatorQueueItem[];
  department: string;
}

const departmentLabels: Record<string, string> = { INPATIENT: "Internação", LABORATORY: "Laboratório", RADIOLOGY: "Radiologia", ULTRASOUND: "Ultrassom", OPERATIONS: "Operações" };

const cards: Array<{ key: IndicatorKey; label: string; caption: string; tone: string }> = [
  { key: "overdue", label: "Atrasados", caption: "itens fora do SLA", tone: "danger" },
  { key: "recollections", label: "Recoletas", caption: "nova amostra necessária", tone: "warning" },
  { key: "newResults", label: "Resultados novos", caption: "aguardam revisão", tone: "success" },
  { key: "critical", label: "Críticos", caption: "confirmação necessária", tone: "critical" },
  { key: "totalActive", label: "Ativos", caption: "itens não terminais", tone: "info" },
];

export function IndicatorsView() {
  const [data, setData] = useState<IndicatorData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const dataRef = useRef<IndicatorData | null>(null);
  const loadVersion = useRef(0);

  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    setLoading(true);
    setError("");
    let sessionFailed = false;
    let department = dataRef.current?.department ?? "não identificado";
    try {
      const session = await apiFetch<SessionResponse>("/session/me");
      department = session.user.departmentCode;
    } catch {
      sessionFailed = true;
    }
    if (loadVersion.current !== version) return;
    const [stats, queue] = await Promise.allSettled([
      apiFetch<Stats>("/dashboard"),
      apiFetch<IndicatorQueueItem[]>(`/queues/${encodeURIComponent(department)}/items?limit=100`),
    ]);
    if (loadVersion.current !== version) return;
    if (stats.status === "fulfilled") {
      const nextData = { stats: stats.value, queue: queue.status === "fulfilled" ? queue.value : dataRef.current?.queue ?? [], department };
      dataRef.current = nextData;
      setData(nextData);
    }
    const failedCount = Number(sessionFailed) + Number(stats.status === "rejected") + Number(queue.status === "rejected");
    if (failedCount > 0) setError(failedCount === 3 ? "Não foi possível carregar os indicadores." : "Parte dos indicadores está indisponível; os dados visíveis podem estar desatualizados.");
    if (stats.status === "rejected" && !dataRef.current) setData(null);
    if (loadVersion.current === version) setLoading(false);
  }, []);

  useEffect(() => { const timer = window.setTimeout(() => { void load(); }, 0); return () => window.clearTimeout(timer); }, [load]);

  if (!data && loading) return <LoadingState label="Carregando indicadores" />;
  if (!data) return <ErrorState title="Indicadores indisponíveis" message={error} onRetry={load} retrying={loading} />;

  return (
    <div className="indicators-page">
      <div className="page-heading">
        <div><p className="eyebrow">Operação · visão de capacidade</p><h1>Indicadores <em>operacionais.</em></h1><p className="page-lede">Leitura do escopo autorizado, sem transformar o Hub em um painel de BI.</p></div>
        <ActionButton tone="ghost" state={loading ? "pending" : "idle"} onClick={() => void load()}><Icon name="refresh" size={15} /> {loading ? "Atualizando…" : "Atualizar"}</ActionButton>
      </div>
      {error && <PartialNotice message={error} onRetry={load} retrying={loading} retryLabel="Reconciliar" />}
      <section className="indicator-meta" aria-label="Contexto dos indicadores"><span>Setor: {departmentLabels[data.department] ?? data.department}</span><span>Janela: {data.stats.window.label}</span><span>Fuso: {data.stats.window.timezone}</span><span>Atualizado {formatRelativeTime(data.stats.window.asOf)}</span></section>
      <section className="metric-grid indicator-grid" aria-label="Indicadores operacionais">{cards.map((card) => { const indicator = data.stats.indicators.find((entry) => entry.key === card.key); return <article className={`metric-card metric-${card.tone}`} key={card.key}><div className="metric-top"><span>{card.label}</span></div><strong>{data.stats[card.key]}</strong><small>{card.caption}</small>{indicator && <small>Denominador: {indicator.denominator}</small>}</article>; })}</section>
       <div className="indicator-columns">
        <section className="panel"><div className="panel-heading"><div><p className="eyebrow">Fila autorizada</p><h2>{data.queue.length} itens no setor</h2></div><span className="timeline-count">agora</span></div>{data.queue.length === 0 ? <EmptyState announce={!error && !loading} title="Nenhum item na fila deste setor" message="O estado vazio é real para o escopo atual; nenhuma métrica foi estimada." /> : <ul className="indicator-list">{data.queue.slice(0, 10).map((item) => <li key={item.id}><span><strong>{statusLabel(item.status)}</strong><small>{priorityLabel(item.priority)}{item.overdue ? " · atrasado" : ""}</small></span><span className={item.overdue ? "text-danger" : "text-success"}>{item.overdue ? "Fora do SLA" : "No prazo"}</span></li>)}</ul>}</section>
        <section className="panel"><div className="panel-heading"><div><p className="eyebrow">Definições</p><h2>Leitura honesta</h2></div></div><div className="indicator-copy"><ul className="indicator-definition-list">{data.stats.indicators.map((indicator) => <li key={indicator.key}><p><strong>{indicator.label}</strong> {indicator.definition}</p><small>Denominador: {indicator.denominator} ({indicator.denominatorDefinition}). Próxima ação: {indicator.nextAction}</small></li>)}</ul><p className="indicator-muted">Não há distribuição de tempo de resposta disponível neste ambiente.</p></div></section>
      </div>
    </div>
  );
}
