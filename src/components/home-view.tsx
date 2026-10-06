"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { DashboardView, SessionResponse, SessionUser } from "@cvg/contracts";
import { apiFetch, getSafeErrorMessage } from "./api-client";
import { Dashboard } from "./dashboard";
import { ErrorState, StaleNotice } from "./feedback-states";
import { PageHeader } from "./page-header";
import { Icon, type IconName } from "./ui-icons";
import { DepartmentIcon, PriorityIcon, StateIcon } from "./work-items/icons";
import { useWorkItems } from "./work-items/use-work-items";
import { CLINICAL_DEPARTMENTS, STATE_GROUP, STATE_LABELS, departmentLabel, formatDue, isTerminal, sortItems, workItemKey, type WorkItem } from "./work-items/model";

function greeting(date: Date): string {
  const hour = date.getHours();
  return hour < 12 ? "Bom dia" : hour < 18 ? "Boa tarde" : "Boa noite";
}

/** Plane-style workspace home; technical admins keep their protected landing. */
export function Home() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void apiFetch<SessionResponse>("/session/me")
      .then((result) => { if (active) setUser(result.user); })
      .catch((cause) => { if (active) setError(getSafeErrorMessage(cause, "Não foi possível identificar a sessão.")); });
    return () => { active = false; };
  }, []);
  if (error) return <div className="page-body"><ErrorState page title="Identidade indisponível" message={error} onRetry={() => window.location.reload()} /></div>;
  if (!user) return <><PageHeader crumbs={[{ label: "Início", icon: "home" }]} heading={false} /><div className="home" aria-busy="true"><div className="skeleton skeleton-line" style={{ width: 240, height: 22, margin: "0 auto" }} /></div></>;
  if (user.role === "ADMIN") return <><PageHeader crumbs={[{ label: "Início", icon: "home" }]} heading={false} /><div className="page-body"><Dashboard /></div></>;
  return <ClinicalHome user={user} />;
}

interface QuickCard { label: string; value: number; hint: string; href: string; icon: IconName; tone: string }

function ClinicalHome({ user }: { user: SessionUser }) {
  const [dashboard, setDashboard] = useState<DashboardView | null>(null);
  const [dashboardError, setDashboardError] = useState("");
  const { items, loading, refreshing, error: itemsError, partial, truncated, reload } = useWorkItems();
  const now = new Date();
  const firstName = user.displayName.replace(/^(Dra?\.|Técnica|Equipe)\s+/i, "").split(" ")[0];

  const loadDashboard = useCallback(async () => {
    try { setDashboard(await apiFetch<DashboardView>("/dashboard")); setDashboardError(""); }
    catch (cause) { setDashboardError(getSafeErrorMessage(cause, "Indicadores indisponíveis no momento.")); }
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => { void loadDashboard(); }, 0);
    const refresh = () => { void loadDashboard(); };
    window.addEventListener("cvg:realtime-updated", refresh);
    window.addEventListener("cvg:realtime-resync", refresh);
    return () => { window.clearTimeout(timer); window.removeEventListener("cvg:realtime-updated", refresh); window.removeEventListener("cvg:realtime-resync", refresh); };
  }, [loadDashboard]);

  const isClinician = ["VETERINARIAN", "VET", "INPATIENT_TEAM"].includes(user.role);
  const active = useMemo(() => items.filter((item) => !isTerminal(item.status)), [items]);
  const attention = useMemo(() => sortItems(active.filter((item) => item.overdue || item.priority !== "ROUTINE" || ["ATTENTION", "URGENT"].includes(item.operationalContext?.escalationLevel ?? "NONE") || item.status === "RECOLLECTION_REQUIRED"), "priority").slice(0, 6), [active]);
  const results = useMemo(() => sortItems(items.filter((item) => item.status === "RESULT_AVAILABLE"), "recent").slice(0, 5), [items]);
  const recent = useMemo(() => sortItems(items, "recent").slice(0, 6), [items]);
  const myScope = useMemo(() => isClinician ? items.filter((item) => item.requesterId === user.id && !isTerminal(item.status)) : active.filter((item) => item.departmentCode === user.departmentCode), [active, isClinician, items, user]);

  const quick: QuickCard[] = [
    { label: isClinician ? "Minhas solicitações" : "Na minha fila", value: myScope.length, hint: "ativos agora", href: "/queues?view=mine", icon: "user-check", tone: "accent" },
    { label: "Atrasados", value: dashboard?.overdue ?? active.filter((item) => item.overdue).length, hint: "precisam de intervenção", href: "/queues?preset=overdue", icon: "clock", tone: "danger" },
    { label: "Resultados novos", value: dashboard?.newResults ?? results.length, hint: "aguardando revisão", href: "/queues?preset=results", icon: "check", tone: "review" },
    { label: "Recoletas", value: dashboard?.recollections ?? active.filter((item) => item.status === "RECOLLECTION_REQUIRED").length, hint: "aguardando nova amostra", href: "/queues", icon: "refresh", tone: "warning" }
  ];

  const sectors = (dashboard?.departments ?? []).filter((department) => CLINICAL_DEPARTMENTS.includes(department.departmentCode as typeof CLINICAL_DEPARTMENTS[number]));

  return <>
    <PageHeader crumbs={[{ label: "Início", icon: "home" }]} heading={false}>
      <Link href="/queues" className="header-button"><Icon name="layers" size={14} />Ver todos os exames</Link>
      {["VETERINARIAN", "VET", "INPATIENT_TEAM", "MANAGER"].includes(user.role) && <Link href="/queues?create=request" className="button-primary-sm home-create"><Icon name="add" size={14} />Nova solicitação</Link>}
    </PageHeader>
    <div className="home">
      <div className="home-greeting">
        <h1>{greeting(now)}, {firstName}</h1>
        <p><Icon name="calendar" size={14} />{new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "numeric", month: "long" }).format(now)}</p>
      </div>

      {itemsError && items.length === 0 ? <ErrorState title="Não foi possível carregar os exames" message={itemsError} onRetry={reload} retrying={refreshing || loading} /> : <>
      {itemsError && <StaleNotice onRetry={reload} retrying={refreshing} />}
      {(partial || truncated) && <p className="inline-notice" role="status"><Icon name="attention" size={14} />{partial || "Lista limitada a 1.000 solicitações e 1.000 itens por fila; os resumos de exames podem estar incompletos."}</p>}

      <nav className="home-quick" aria-label="Atalhos">
        {quick.map((card) => <Link key={card.label} href={card.href} className={`home-quick-card tone-${card.tone}`}>
          <header><span>{card.label}</span><Icon name={card.icon} size={15} /></header>
          <strong>{loading && !dashboard ? "–" : card.value}</strong>
          <small>{card.hint}</small>
        </Link>)}
      </nav>

      {dashboardError && <p className="inline-notice" role="status"><Icon name="attention" size={14} />{dashboardError}</p>}

      <div className="home-columns">
        <section className="home-widget" aria-labelledby="home-attention">
          <div className="home-widget-head"><h2 id="home-attention">Precisa de atenção</h2><Link href="/queues?view=mine">Meu trabalho <Icon name="arrow-right" size={13} /></Link></div>
          <div className="home-list">
            {loading ? <HomeRowsSkeleton /> : attention.length === 0 ? <p className="home-empty"><Icon name="check" size={16} />Nenhum exame exige atenção imediata.</p> : attention.map((item) => <HomeRow key={item.id} item={item} />)}
          </div>
        </section>

        <section className="home-widget" aria-labelledby="home-results">
          <div className="home-widget-head"><h2 id="home-results">Resultados para revisar</h2><Link href="/queues?preset=results">Ver todos <Icon name="arrow-right" size={13} /></Link></div>
          <div className="home-list">
            {loading ? <HomeRowsSkeleton rows={3} /> : results.length === 0 ? <p className="home-empty"><Icon name="check" size={16} />Nenhum resultado aguardando revisão.</p> : results.map((item) => <HomeRow key={item.id} item={item} compact />)}
          </div>
        </section>
      </div>

      {sectors.length > 0 && <section className="home-widget" aria-labelledby="home-sectors">
        <div className="home-widget-head"><h2 id="home-sectors">Setores</h2></div>
        <div className="home-sectors">
          {sectors.map((sector) => {
            const sectorItems = active.filter((item) => item.departmentCode === sector.departmentCode);
            const total = Math.max(sectorItems.length, 1);
            const share = (group: string) => `${(sectorItems.filter((item) => STATE_GROUP[item.status] === group).length / total) * 100}%`;
            return <Link key={sector.departmentCode} href={`/queues?dept=${sector.departmentCode}`} className="home-sector">
              <header><DepartmentIcon code={sector.departmentCode} size={15} /><span>{departmentLabel(sector.departmentCode)}</span><span className={`sector-state sector-state-${sector.state.toLowerCase()}`}>{sector.state === "CLEAR" ? "Em dia" : sector.state === "ATTENTION" ? "Atenção" : "Ativo"}</span></header>
              <div className="home-sector-stats"><span><b>{sector.activeItems}</b>ativos</span><span><b>{sector.attention}</b>atenção</span><span><b className={sector.overdue ? "text-danger" : ""}>{sector.overdue}</b>atrasados</span></div>
              <div className="home-sector-bar" aria-hidden="true"><span style={{ width: share("unstarted"), background: "var(--state-unstarted)" }} /><span style={{ width: share("started"), background: "var(--state-started)" }} /><span style={{ width: share("review"), background: "var(--state-review)" }} /><span style={{ width: share("attention"), background: "var(--state-attention)" }} /></div>
            </Link>;
          })}
        </div>
      </section>}

      <section className="home-widget" aria-labelledby="home-recent">
        <div className="home-widget-head"><h2 id="home-recent">Solicitações recentes</h2><Link href="/queues?view=mine">Ver mais <Icon name="arrow-right" size={13} /></Link></div>
        <div className="home-list">
          {loading ? <HomeRowsSkeleton rows={4} /> : recent.length === 0 ? <p className="home-empty">Nenhuma solicitação ainda.</p> : recent.map((item) => <HomeRow key={item.id} item={item} compact />)}
        </div>
      </section>
      </>}
    </div>
  </>;
}

function HomeRow({ item, compact = false }: { item: WorkItem; compact?: boolean }) {
  return <Link className="home-row" href={`/queues?dept=${item.departmentCode}&item=${encodeURIComponent(item.id)}`}>
    <span className="home-row-title"><StateIcon state={item.status} /><span className="work-item-key">{workItemKey(item)}</span><strong>{item.patient.displayName} — {item.service.name}</strong></span>
    {!compact && <span className="pill"><PriorityIcon priority={item.priority} /><span>{item.priority === "ROUTINE" ? "Rotina" : item.priority === "URGENT" ? "Urgente" : "Emergência"}</span></span>}
    <span className={`pill${item.overdue ? " pill-danger" : ""}`}><Icon name="calendar" size={12} /><span>{compact ? STATE_LABELS[item.status] : formatDue(item.dueAt)}</span></span>
  </Link>;
}

function HomeRowsSkeleton({ rows = 5 }: { rows?: number }) {
  return <div role="status" aria-label="Carregando">{Array.from({ length: rows }, (_, index) => <div key={index} className="home-row"><div className="skeleton skeleton-line" style={{ width: `${45 + ((index * 17) % 35)}%` }} /></div>)}</div>;
}
