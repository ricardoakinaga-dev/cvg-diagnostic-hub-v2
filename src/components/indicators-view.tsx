"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ActionButton } from "@cvg/ui";
import { apiFetch, formatRelativeTime } from "./api-client";
import { priorityLabel, statusLabel } from "./status-badge";
import { Icon } from "./ui-icons";

type IndicatorKey = "overdue" | "recollections" | "newResults" | "critical" | "totalActive";

interface DashboardIndicator {
  key: IndicatorKey;
  label: string;
  count: number;
  denominator: number;
  denominatorDefinition: string;
  definition: string;
  nextAction: string;
}

interface DashboardWindow {
  kind: "CURRENT_STATE";
  label: string;
  timezone: string;
  asOf: string;
}

interface Stats {
  overdue: number;
  recollections: number;
  newResults: number;
  critical: number;
  totalActive: number;
  updatedAt: string;
  window: DashboardWindow;
  indicators: DashboardIndicator[];
}

interface QueueItem {
  id: string;
  status: string;
  priority: string;
  overdue: boolean;
  nextAction: string;
}

interface IndicatorData {
  stats: Stats;
  queue: QueueItem[];
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
      const session = await apiFetch<{ user: { departmentCode: string } }>("/session/me");
      department = session.user.departmentCode;
    } catch {
      sessionFailed = true;
    }
    if (loadVersion.current !== version) return;
    const [stats, queue] = await Promise.allSettled([
      apiFetch<Stats>("/dashboard"),
      apiFetch<QueueItem[]>(`/queues/${encodeURIComponent(department)}/items?limit=100`),
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

  if (!data && loading) return <div className="loading-state" role="status">Carregando indicadores…</div>;
  if (!data) return <div className="error-state" role="alert"><strong>Indicadores indisponíveis</strong><span>{error}</span><ActionButton tone="ghost" state={loading ? "pending" : "idle"} onClick={() => void load()}>{loading ? "Tentando novamente…" : "Tentar novamente"}</ActionButton></div>;

  return (
    <div className="indicators-page">
      <div className="page-heading">
        <div><p className="eyebrow">Operação · visão de capacidade</p><h1>Indicadores <em>operacionais.</em></h1><p className="page-lede">Leitura do escopo autorizado, sem transformar o Hub em um painel de BI.</p></div>
        <ActionButton tone="ghost" state={loading ? "pending" : "idle"} onClick={() => void load()}><Icon name="refresh" size={15} /> {loading ? "Atualizando…" : "Atualizar"}</ActionButton>
      </div>
      {error && <div className="error-state" role="status"><span>{error}</span><ActionButton tone="ghost" state={loading ? "pending" : "idle"} onClick={() => void load()}>{loading ? "Reconciliando…" : "Reconciliar"}</ActionButton></div>}
      <section className="indicator-meta" aria-label="Contexto dos indicadores"><span>Setor: {departmentLabels[data.department] ?? data.department}</span><span>Janela: {data.stats.window.label}</span><span>Fuso: {data.stats.window.timezone}</span><span>Atualizado {formatRelativeTime(data.stats.window.asOf)}</span></section>
      <section className="metric-grid indicator-grid" aria-label="Indicadores operacionais">{cards.map((card) => { const indicator = data.stats.indicators.find((entry) => entry.key === card.key); return <article className={`metric-card metric-${card.tone}`} key={card.key}><div className="metric-top"><span>{card.label}</span></div><strong>{data.stats[card.key]}</strong><small>{card.caption}</small>{indicator && <small>Denominador: {indicator.denominator}</small>}</article>; })}</section>
      <div className="indicator-columns">
        <section className="panel"><div className="panel-heading"><div><p className="eyebrow">Fila autorizada</p><h2>{data.queue.length} itens no setor</h2></div><span className="timeline-count">agora</span></div>{data.queue.length === 0 ? <div className="empty-state"><span aria-hidden="true"><Icon name="check" size={16} /></span><strong>Nenhum item na fila deste setor</strong><p>O estado vazio é real para o escopo atual; nenhuma métrica foi estimada.</p></div> : <ul className="indicator-list">{data.queue.slice(0, 10).map((item) => <li key={item.id}><span><strong>{statusLabel(item.status as Parameters<typeof statusLabel>[0])}</strong><small>{priorityLabel(item.priority as Parameters<typeof priorityLabel>[0])}{item.overdue ? " · atrasado" : ""}</small></span><span className={item.overdue ? "text-danger" : "text-success"}>{item.overdue ? "Fora do SLA" : "No prazo"}</span></li>)}</ul>}</section>
        <section className="panel"><div className="panel-heading"><div><p className="eyebrow">Definições</p><h2>Leitura honesta</h2></div></div><div className="indicator-copy"><ul className="indicator-definition-list">{data.stats.indicators.map((indicator) => <li key={indicator.key}><p><strong>{indicator.label}</strong> {indicator.definition}</p><small>Denominador: {indicator.denominator} ({indicator.denominatorDefinition}). Próxima ação: {indicator.nextAction}</small></li>)}</ul><p className="indicator-muted">Não há distribuição de tempo de resposta disponível neste ambiente.</p></div></section>
      </div>
    </div>
  );
}
