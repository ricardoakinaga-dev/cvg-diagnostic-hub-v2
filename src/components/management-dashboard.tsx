"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { Priority } from "@cvg/contracts";
import { ActionButton } from "@cvg/ui";
import { apiFetch, formatRelativeTime, getSafeErrorMessage } from "./api-client";
import { ErrorState, LoadingState, StaleNotice } from "./feedback-states";
import { Icon } from "./ui-icons";

type ManagementView = "overview" | "requests" | "pending" | "stats";
type ItemState = "REQUESTED" | "RECEIVED" | "SCHEDULED" | "IN_PROGRESS" | "AWAITING_REPORT" | "RESULT_AVAILABLE" | "REVIEWED" | "RECOLLECTION_REQUIRED" | "FAILED" | "CANCELLED" | "REJECTED" | "COMPLETED";

interface ManagementOverview {
  asOf: string;
  scope: { departments: string[]; label: string };
  summary: { totalRequests: number; activeItems: number; overdue: number; recollections: number; newResults: number; critical: number; pendingRequests: number; completedToday: number };
  departments: Array<{ departmentCode: string; serviceCount: number; totalRequests: number; activeItems: number; overdue: number; pending: number }>;
  pending: Array<{ id: string; requestId: string; requestCode: string; patient: string; service: string; departmentCode: string; status: ItemState; priority: Priority; dueAt: string; overdue: boolean; nextAction: string; deepLink: string }>;
  recentRequests: Array<{ id: string; requestCode: string; patient: string; aggregateStatus: string; priority: Priority; updatedAt: string; itemCount: number; deepLink: string }>;
}

const viewLabels: Record<ManagementView, string> = { overview: "Controle", requests: "Solicitações", pending: "Pendências", stats: "Estatísticas" };
const departmentLabels: Record<string, string> = { INPATIENT: "Internação", LABORATORY: "Laboratório", RADIOLOGY: "Radiologia", ULTRASOUND: "Ultrassom", IMAGING: "Imagem", OPERATIONS: "Operações" };
const priorityLabels: Record<Priority, string> = { ROUTINE: "Rotina", URGENT: "Urgente", EMERGENCY: "Emergência" };
const stateLabels: Record<string, string> = {
  REQUESTED: "Solicitado",
  RECEIVED: "Amostra recebida",
  SCHEDULED: "Agendado",
  IN_PROGRESS: "Em execução",
  AWAITING_REPORT: "Aguardando laudo",
  RESULT_AVAILABLE: "Resultado disponível",
  REVIEWED: "Revisado",
  RECOLLECTION_REQUIRED: "Recoleta necessária",
  FAILED: "Pendente",
  CANCELLED: "Cancelado",
  REJECTED: "Rejeitado",
  COMPLETED: "Concluído"
};

function departmentLabel(code: string): string {
  return departmentLabels[code] ?? code.replaceAll("_", " ").toLowerCase().replace(/^./, (letter) => letter.toUpperCase());
}

function scopeLabel(departments: string[], fallback: string): string {
  const labels = departments.map(departmentLabel);
  return labels.length > 0 ? labels.join(" · ") : fallback;
}

function stateLabel(code: string): string {
  return stateLabels[code] ?? code.replaceAll("_", " ").toLowerCase().replace(/^./, (letter) => letter.toUpperCase());
}

export function ManagementDashboard() {
  const searchParams = useSearchParams();
  const requestedView = searchParams.get("view");
  const view: ManagementView = requestedView === "requests" || requestedView === "pending" || requestedView === "stats" ? requestedView : "overview";
  const [data, setData] = useState<ManagementOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [lastConfirmedAt, setLastConfirmedAt] = useState<string | null>(null);
  const loadVersion = useRef(0);

  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    setLoading(true);
    setError("");
    try {
      const nextData = await apiFetch<ManagementOverview>("/management/overview");
      if (loadVersion.current !== version) return;
      setData(nextData);
      setLastConfirmedAt(nextData.asOf);
    }
    catch (cause) {
      if (loadVersion.current === version) setError(getSafeErrorMessage(cause, "Não foi possível carregar o centro operacional."));
    }
    finally {
      if (loadVersion.current === version) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => { window.clearTimeout(timer); loadVersion.current += 1; };
  }, [load]);

  if (!data && loading) return <LoadingState label="Carregando controle operacional" />;
  if (!data) return <ErrorState title="Controle operacional indisponível" message={error || "Tente novamente em instantes."} onRetry={load} retrying={loading} />;

  const title = view === "overview" ? "Controle operacional." : `${viewLabels[view]}.`;
  return <div className="management-page">
    <div className="page-heading"><div><p className="eyebrow">Gestão · {data.scope.departments.length} setores autorizados</p><h1>{title}</h1><p className="page-lede">Acompanhe solicitações, capacidade e próximos passos em uma única visão operacional.</p></div><ActionButton tone="ghost" state={loading ? "pending" : "idle"} onClick={() => void load()}><Icon name="refresh" size={15} /> {loading ? "Atualizando…" : "Atualizar"}</ActionButton></div>
    {error && <StaleNotice title="Controle operacional desatualizado" message={`${error} Os dados exibidos continuam sendo o último snapshot confirmado.`} lastConfirmedAt={lastConfirmedAt ? formatRelativeTime(lastConfirmedAt) : undefined} onRetry={load} retrying={loading} />}
    <nav className="management-tabs" aria-label="Visões de gestão">{(Object.keys(viewLabels) as ManagementView[]).map((key) => <Link key={key} href={key === "overview" ? "/management" : `/management?view=${key}`} className={view === key ? "active" : ""} aria-current={view === key ? "page" : undefined}>{viewLabels[key]}</Link>)}<Link href="/admin#users">Acessos</Link><Link href="/admin#catalog">Catálogos</Link><Link href="/admin#audit">Auditoria</Link></nav>
    <section className="management-scope" aria-label="Escopo da gestão"><span className="scope-icon" aria-hidden="true"><Icon name="spark" size={16} /></span><span><strong>Escopo ativo</strong><small>{scopeLabel(data.scope.departments, data.scope.label)}</small></span><span className="scope-updated">Atualizado {formatRelativeTime(data.asOf)}</span></section>
    <section className="metric-grid management-metric-grid" aria-label="Resumo operacional"><ManagementMetric label="Solicitações" value={data.summary.totalRequests} caption="no escopo atual" tone="info" /><ManagementMetric label="Itens ativos" value={data.summary.activeItems} caption="não terminais" tone="info" /><ManagementMetric label="Atrasados" value={data.summary.overdue} caption="exigem intervenção" tone="danger" /><ManagementMetric label="Recoletas" value={data.summary.recollections} caption="aguardam nova amostra" tone="warning" /><ManagementMetric label="Resultados novos" value={data.summary.newResults} caption="aguardam revisão" tone="success" /><ManagementMetric label="Críticos" value={data.summary.critical} caption="confirmação necessária" tone="critical" /></section>
    {view === "stats" ? <StatsPanel data={data} /> : view === "requests" ? <RequestsPanel data={data} /> : view === "pending" ? <PendingPanel data={data} /> : <OverviewPanels data={data} />}
  </div>;
}

function ManagementMetric({ label, value, caption, tone }: { label: string; value: number; caption: string; tone: string }) {
  return <article className={`metric-card metric-${tone}`}><div className="metric-top"><span>{label}</span><b aria-hidden="true"><Icon name="spark" size={14} /></b></div><strong>{value}</strong><small>{caption}</small></article>;
}

function OverviewPanels({ data }: { data: ManagementOverview }) {
  return <div className="management-columns"><PendingPanel data={data} compact /><section className="panel"><div className="panel-heading"><div><p className="eyebrow">Capacidade por setor</p><h2>Onde está a pressão</h2></div><Link href="/management?view=stats" className="text-link">Ver estatísticas <Icon name="arrow-right" size={15} /></Link></div><DepartmentTable data={data} /></section><RequestsPanel data={data} compact /></div>;
}

function PendingPanel({ data, compact = false }: { data: ManagementOverview; compact?: boolean }) {
  const items = compact ? data.pending.slice(0, 6) : data.pending;
  return <section className="panel management-list-panel"><div className="panel-heading"><div><p className="eyebrow">Ação necessária</p><h2>Pendências de fluxo</h2></div>{compact ? <Link href="/management?view=pending" className="text-link">Ver todas <Icon name="arrow-right" size={15} /></Link> : <span className="timeline-count">{data.pending.length}</span>}</div>{items.length === 0 ? <div className="empty-state"><span aria-hidden="true"><Icon name="check" size={16} /></span><strong>Operação em dia</strong><p>Nenhum item pendente no escopo dos setores autorizados.</p></div> : <ul className="management-item-list">{items.map((item) => <li key={item.id}><Link href={item.deepLink}><span className="management-item-main"><strong>{item.service}</strong><small>{item.requestCode} · {item.patient} · {departmentLabel(item.departmentCode)}</small></span><span className="management-item-action"><b className={item.overdue ? "text-danger" : "text-success"}>{item.nextAction}</b><small>{priorityLabels[item.priority]} · {item.overdue ? "fora do SLA" : `vence ${formatRelativeTime(item.dueAt)}`}</small></span><span aria-hidden="true"><Icon name="arrow-right" size={16} /></span></Link></li>)}</ul>}</section>;
}

function RequestsPanel({ data, compact = false }: { data: ManagementOverview; compact?: boolean }) {
  const requests = compact ? data.recentRequests.slice(0, 6) : data.recentRequests;
  return <section className="panel management-list-panel"><div className="panel-heading"><div><p className="eyebrow">Acompanhamento</p><h2>Solicitações recentes</h2></div>{compact ? <Link href="/management?view=requests" className="text-link">Ver todas <Icon name="arrow-right" size={15} /></Link> : <span className="timeline-count">{requests.length}</span>}</div>{requests.length === 0 ? <div className="empty-state"><span aria-hidden="true"><Icon name="check" size={16} /></span><strong>Nenhuma solicitação no escopo</strong><p>Quando um exame for criado nos setores autorizados, ele aparecerá aqui.</p></div> : <ul className="management-request-list">{requests.map((request) => <li key={request.id}><Link href={request.deepLink}><span><strong>{request.requestCode}</strong><small>{request.patient} · {request.itemCount} itens · {formatRelativeTime(request.updatedAt)}</small></span><span className="request-state-text">{stateLabel(request.aggregateStatus)}</span><span aria-hidden="true"><Icon name="arrow-right" size={16} /></span></Link></li>)}</ul>}</section>;
}

function StatsPanel({ data }: { data: ManagementOverview }) {
  const total = useMemo(() => data.departments.reduce((sum, department) => sum + department.activeItems, 0), [data.departments]);
  return <div className="management-stats-grid"><section className="panel"><div className="panel-heading"><div><p className="eyebrow">Distribuição de trabalho</p><h2>Setores monitorados</h2></div><span className="timeline-count">{data.departments.length}</span></div><DepartmentTable data={data} /></section><section className="panel management-definitions"><div className="panel-heading"><div><p className="eyebrow">Leitura honesta</p><h2>Indicadores de gestão</h2></div></div><ul><li><strong>Itens ativos</strong><span>{total} itens em estados não terminais.</span></li><li><strong>Atrasados</strong><span>Itens ativos cuja data de SLA já passou no relógio do servidor.</span></li><li><strong>Pendências</strong><span>Próxima ação derivada do estado confirmado do item, sem estimativa no cliente.</span></li><li><strong>Atualização</strong><span>Snapshot único do servidor em {new Date(data.asOf).toLocaleString("pt-BR")}.</span></li></ul></section></div>;
}

function DepartmentTable({ data }: { data: ManagementOverview }) {
  if (data.departments.length === 0) return <div className="empty-state"><span aria-hidden="true"><Icon name="check" size={16} /></span><strong>Nenhum setor diagnóstico configurado</strong><p>Cadastre serviços no catálogo para que a capacidade seja distribuída.</p></div>;
  return <div className="department-table" role="table" aria-label="Resumo por setor"><div className="department-table-head" role="row"><span>Setor</span><span>Ativos</span><span>Atrasados</span><span>Serviços</span></div>{data.departments.map((department) => <div className="department-table-row" role="row" key={department.departmentCode}><strong>{departmentLabel(department.departmentCode)}</strong><span>{department.activeItems}</span><span className={department.overdue > 0 ? "text-danger" : "text-success"}>{department.overdue}</span><span>{department.serviceCount}</span></div>)}</div>;
}
