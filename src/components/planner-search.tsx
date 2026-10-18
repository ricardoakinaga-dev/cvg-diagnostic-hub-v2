"use client";

import Link from "next/link";
import { useState } from "react";
import type { PlannerSearchResult, PlannerViewFilters } from "@cvg/contracts";
import { ActionButton } from "@cvg/ui";
import { formatHospitalDateTime, hospitalDateTimeInput, hospitalDateTimeInputToIso } from "@/lib/hospital-time";
import { usePlannerIdentity, usePlannerPage } from "./use-planner";
import { useQueuePreferences } from "./use-queue-preferences";
import { PLANNER_EMPTY_FILTERS, normalizePlannerFilters, plannerQuery } from "./planner-model";
import { EmptyState, ErrorState, LoadingState } from "./feedback-states";
import { PlannerScopeFilters } from "./planner-scope-filters";
import { useDepartments } from "./use-departments";
import { PlannerViewPicker } from "./planner-view-picker";

const entityLabels: Record<PlannerSearchResult["type"], string> = { HOSPITAL_TASK: "Atividade hospitalar", DIAGNOSTIC_REQUEST: "Solicitação diagnóstica", DIAGNOSTIC_ITEM: "Exame diagnóstico", PATIENT: "Paciente", ENCOUNTER: "Atendimento", HOSPITAL_PLAN: "Plano assistencial", HOSPITAL_SHIFT: "Plantão", CHECKLIST_TEMPLATE: "Modelo de checklist", HOSPITAL_RECURRENCE: "Rotina recorrente", HOSPITAL_DOCUMENT: "Documento operacional", HOSPITAL_RESOURCE: "Recurso hospitalar" };
export function PlannerSearch() {
  const { user, error } = usePlannerIdentity();
  const directory = useDepartments(user?.id, { includeInactive: true });
  const [query, setQuery] = useState(""); const [submitted, setSubmitted] = useState<{ userId: string; query: string }>();
  const [types, setTypes] = useState<PlannerSearchResult["type"][]>([]);
  const [archiveFilter, setArchiveFilter] = useState<{ userId: string; included: boolean }>();
  const includeArchived = archiveFilter?.userId === user?.id && archiveFilter?.included === true;
  const [filters, setFilters] = useQueuePreferences(user?.id, "/planner/search:filters", PLANNER_EMPTY_FILTERS, normalizePlannerFilters);
  const [shiftFilter, setShiftFilter] = useState<{ userId: string; id?: string }>();
  const initialShiftId = typeof window === "undefined" ? undefined : new URLSearchParams(window.location.search).get("shiftId") ?? undefined;
  const shiftId = shiftFilter?.userId === user?.id ? shiftFilter?.id : initialShiftId;
  const [dateError, setDateError] = useState("");
  const mayRead = ["hospital_task.view", "request.view", "item.view", "patient.view", "encounter.view", "plan.view", "shift.view", "checklist_template.view", "recurrence.view", "hospital_document.view", "hospital_resource.view"].some((permission) => user?.permissions?.some((entry) => entry === permission));
  const activeQuery = submitted?.userId === user?.id ? submitted?.query ?? "" : "";
  const results = usePlannerPage<PlannerSearchResult>(user?.id, `/planner/search?${plannerQuery({ ...filters, query: activeQuery, ...(shiftId ? { shiftId } : {}), ...(includeArchived ? { includeArchived: true } : {}), limit: 50 })}${types.length ? `&types=${types.join(",")}` : ""}`, mayRead && activeQuery.length >= 2);
  function updateDate(key: "from" | "to", value: string) { try { setFilters({ ...filters, [key]: value ? hospitalDateTimeInputToIso(value) : undefined }); setDateError(""); } catch (cause) { setDateError(cause instanceof Error ? cause.message : "Revise o período."); } }
  if (error) return <ErrorState page title="Busca indisponível" message={error} onRetry={() => window.location.reload()} />;
  if (!user) return <LoadingState label="Carregando busca autorizada" />;
  if (!mayRead) return <ErrorState page title="Busca fora do seu acesso" message="Você não tem acesso a este recurso." onRetry={() => window.location.reload()} />;
  return <div className="detail-page"><Link href="/planner" className="back-link">Voltar ao planner</Link><h1>Busca do planner</h1><p className="page-lede">Localize atividades e contexto assistencial que você pode abrir.</p>
    <PlannerViewPicker user={user} filters={filters} onApply={(next) => { setFilters(next); setShiftFilter({ userId: user.id }); setArchiveFilter({ userId: user.id, included: false }); setTypes([]); }} />
    <form className="panel" aria-label="Pesquisar no planner" onSubmit={(event) => { event.preventDefault(); if (query.trim().length >= 2) setSubmitted({ userId: user.id, query: query.trim() }); }}>
      <label>Texto, identificação ou paciente<input value={query} minLength={2} maxLength={200} required onChange={(event) => setQuery(event.target.value)} /></label>
      <fieldset><legend>Tipos de registro</legend>{Object.entries(entityLabels).map(([type, label]) => <label key={type}><input type="checkbox" checked={types.includes(type as PlannerSearchResult["type"])} onChange={(event) => setTypes((previous) => event.target.checked ? [...previous, type as PlannerSearchResult["type"]] : previous.filter((entry) => entry !== type))} />{label}</label>)}</fieldset>
      <label>Setor<select value={filters.departmentCode ?? ""} onChange={(event) => setFilters({ ...filters, departmentCode: event.target.value || undefined })}><option value="">Todos os setores autorizados</option>{directory.departments.map((department) => <option key={department.id} value={department.code}>{department.name}</option>)}</select></label>
      <PlannerScopeFilters user={user} planId={filters.planId} onPlanChange={(planId) => setFilters({ ...filters, planId })} shiftId={shiftId} onShiftChange={(id) => setShiftFilter({ userId: user.id, id })} />
      <label>Responsabilidade<select value={filters.responsibleUserId ?? ""} onChange={(event) => setFilters({ ...filters, responsibleUserId: event.target.value || undefined })}><option value="">Todo o escopo autorizado</option><option value={user.id}>Minhas atribuídas</option>{filters.responsibleUserId && filters.responsibleUserId !== user.id && <option value={filters.responsibleUserId}>Responsável configurado</option>}</select></label>
      <label>Prioridade<select value={filters.priority ?? ""} onChange={(event) => setFilters({ ...filters, priority: event.target.value as PlannerViewFilters["priority"] || undefined })}><option value="">Todas</option><option value="ROUTINE">Rotina</option><option value="URGENT">Urgente</option><option value="EMERGENCY">Emergência</option></select></label>
      <label>Período desde<input type="datetime-local" value={filters.from ? hospitalDateTimeInput(filters.from) : ""} onChange={(event) => updateDate("from", event.target.value)} /></label><label>Período até<input type="datetime-local" value={filters.to ? hospitalDateTimeInput(filters.to) : ""} onChange={(event) => updateDate("to", event.target.value)} /></label><p className="field-hint">Período no horário do hospital. Os filtros usam o contexto e a responsabilidade de cada entidade.</p>
      <p className="field-hint">Documentos e recursos usam a data de atualização. Responsabilidade corresponde ao responsável do documento ou ao profissional cadastrado; paciente, plano, plantão, fase, tipo de atividade e prioridade não se aplicam a esses registros. Documentos arquivados exigem inclusão explícita; recursos inativos continuam identificados como inativos.</p>
      <label><input type="checkbox" checked={includeArchived} onChange={(event) => setArchiveFilter({ userId: user.id, included: event.target.checked })} />Incluir documentos e atividades arquivados</label>
      {dateError && <p role="alert">{dateError}</p>}<ActionButton type="submit" state={results.loading ? "pending" : "idle"}>Buscar</ActionButton><button type="button" onClick={() => { setFilters({}); setTypes([]); setShiftFilter({ userId: user.id }); setArchiveFilter({ userId: user.id, included: false }); }}>Limpar filtros da busca</button>
    </form>
    {results.error && <ErrorState title="Resultados indisponíveis" message={results.error} onRetry={results.reload} />}
    {activeQuery.length >= 2 && <p role="status">{results.items.length} de {results.total} resultados autorizados para “{activeQuery}”.</p>}
    {results.loading ? <LoadingState label="Buscando registros autorizados" /> : activeQuery.length >= 2 && !results.items.length && !results.error ? <EmptyState title="Nenhum registro com estes critérios" message="Confira o texto e os filtros. Somente registros do seu acesso aparecem aqui." /> : <ul className="admin-list" aria-label="Resultados da busca">{results.items.map((entry) => <li key={`${entry.type}:${entry.id}`} className="admin-row"><small>{entityLabels[entry.type]}</small><h2><Link href={entry.deepLink}>{entry.label}</Link></h2>{entry.patient && <p>{entry.patient}</p>}<p>{entry.departmentCode ?? ""}{entry.status ? ` · ${entry.status}` : ""} · {formatHospitalDateTime(entry.updatedAt)}</p></li>)}</ul>}
    {results.nextCursor && <ActionButton tone="ghost" state={results.loadingMore ? "pending" : "idle"} onClick={() => void results.loadMore()}>Carregar mais resultados</ActionButton>}
  </div>;
}
