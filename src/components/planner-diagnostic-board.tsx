"use client";

import Link from "next/link";
import { useEffect, useMemo } from "react";
import type { PlannerViewFilters, SessionUser } from "@cvg/contracts";
import { ActionButton } from "@cvg/ui";
import { formatHospitalDateTime } from "@/lib/hospital-time";
import { EmptyState, LoadingState, PartialNotice } from "./feedback-states";
import { usePlannerDiagnosticFilters } from "./planner-diagnostic-filters";
import { PRIORITY_LABELS, STATE_LABELS } from "./work-items/model";
import { useWorkItems } from "./work-items/use-work-items";

/** Native diagnostic rows retain their clinical states and open their own workspace. */
type DiagnosticBoardProps = { user: SessionUser; filters: PlannerViewFilters; query?: string; onDepartments?: (userId: string, codes: string[]) => void };
export function PlannerDiagnosticBoard({ user, filters, query = "", onDepartments }: DiagnosticBoardProps) {
  if (!user.permissions?.includes("request.list") && !user.permissions?.includes("queue.view")) return <section className="panel" aria-label="Exames diagnósticos no quadro"><h2>Exames diagnósticos</h2><p>Esta conta não tem acesso à listagem diagnóstica. As atividades hospitalares mantêm seu escopo próprio.</p></section>;
  return <AuthorizedDiagnosticBoard key={user.id} user={user} filters={filters} query={query} onDepartments={onDepartments} />;
}

function AuthorizedDiagnosticBoard({ user, filters, query, onDepartments }: DiagnosticBoardProps & { query: string }) {
  const feed = useWorkItems();
  const scope = usePlannerDiagnosticFilters(user, filters);
  const sameIdentity = feed.user?.id === user.id;
  const departments = useMemo(() => sameIdentity ? [...new Set(feed.items.map((item) => item.departmentCode))].sort() : [], [sameIdentity, feed.items]);
  useEffect(() => { onDepartments?.(user.id, departments); }, [onDepartments, user.id, departments]);
  const needle = query.trim().toLocaleLowerCase("pt-BR");
  const items = sameIdentity ? feed.items.filter((item) => scope.matches(item) && (!needle || `${item.requestCode} ${item.service.name} ${item.service.code} ${item.patient.displayName} ${item.patient.externalId}`.toLocaleLowerCase("pt-BR").includes(needle))) : [];
  const groups = [...new Set(items.map((item) => item.status))];
  return <section className="panel" aria-label="Exames diagnósticos no quadro">
    <h2>Exames diagnósticos</h2><p className="field-hint">Fonte: exames diagnósticos autorizados. Os estados abaixo pertencem ao fluxo clínico; abra o exame para executar sua próxima ação.</p>
    {feed.error && <PartialNotice message={feed.error} onRetry={feed.reload} retrying={feed.refreshing} />}{feed.partial && <p role="status">{feed.partial}</p>}{scope.error && <PartialNotice message={scope.error} onRetry={scope.reload} retrying={scope.loading} />}
    <p role="status">{items.length} exames nos itens carregados e compatíveis com os filtros{feed.truncated ? " · há mais exames para carregar" : ""}.</p>
    {scope.loading || feed.loading ? <LoadingState label="Carregando exames do quadro" /> : !items.length ? <EmptyState title="Nenhum exame nesta visão" message="Confira os filtros e o acesso atual ao plano. Tipos de atividade hospitalar não se aplicam a exames." /> : <div className="board-layout" role="list" aria-label="Estados clínicos dos exames">{groups.map((status) => <section className="board-column" key={status} role="listitem" aria-label={`${STATE_LABELS[status]}: ${items.filter((item) => item.status === status).length} exames`}><header className="list-group-header"><h3>{STATE_LABELS[status]}</h3></header><div className="board-cards">{items.filter((item) => item.status === status).map((item) => <article className="board-card" key={`diagnostic:${item.id}`}><span className="eyebrow">Exame diagnóstico · {item.requestCode}</span><h4><Link href={`/queues?view=all&item=${encodeURIComponent(item.id)}`}>{item.service.name} — {item.patient.displayName}</Link></h4><p>{item.departmentCode} · {PRIORITY_LABELS[item.priority]} · {STATE_LABELS[item.status]}</p><p>Prazo clínico: {formatHospitalDateTime(item.dueAt)}</p></article>)}</div></section>)}</div>}
    {feed.paginationError && <p role="alert">{feed.paginationError}</p>}{feed.truncated && <ActionButton tone="ghost" state={feed.loadingMore ? "pending" : "idle"} disabled={feed.loading || feed.refreshing || !sameIdentity} onClick={() => void feed.loadMore()}>Carregar mais exames do quadro</ActionButton>}
  </section>;
}
