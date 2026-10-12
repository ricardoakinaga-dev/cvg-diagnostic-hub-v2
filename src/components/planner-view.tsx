"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { HospitalTaskType, HospitalTaskView, PlannerViewFilters, SavedPlannerView } from "@cvg/contracts";
import { PLANNER_VIEW_COLUMNS } from "@cvg/contracts";
import { ActionButton } from "@cvg/ui";
import { hospitalDateTimeInput, hospitalDateTimeInputToIso } from "@/lib/hospital-time";
import { apiFetch, getSafeErrorMessage } from "./api-client";
import { EmptyState, ErrorState, LoadingState, PartialNotice } from "./feedback-states";
import { departmentOptions, useDepartments } from "./use-departments";
import { useQueuePreferences } from "./use-queue-preferences";
import { usePlannerIdentity, usePlannerOptions, usePlannerPage } from "./use-planner";
import { PlannerTaskForm } from "./planner-task-form";
import { PlannerTaskBatch } from "./planner-task-batch";
import { PlannerTaskLayouts } from "./planner-task-layouts";
import { PlannerDiagnosticBoard } from "./planner-diagnostic-board";
import { PlannerSavedViews } from "./planner-saved-views";
import { PlannerScopeFilters } from "./planner-scope-filters";
import { COLUMN_LABELS, PHASE_LABELS, PLANNER_DEFAULT_DISPLAY, PLANNER_EMPTY_FILTERS, normalizePlannerDisplay, normalizePlannerFilters, plannerQuery, taskMatchesFilters } from "./planner-model";

export function PlannerView() {
  const { user, error: sessionError } = usePlannerIdentity();
  const creationOptions = usePlannerOptions(user);
  const directory = useDepartments(user?.id, { includeInactive: true });
  const [typesState, setTypes] = useState<{ userId: string; items: HospitalTaskType[] }>({ userId: "", items: [] });
  const [typesError, setTypesError] = useState("");
  const types = typesState.userId === user?.id ? typesState.items : [];
  const [filters, setFilters] = useQueuePreferences(user?.id, "/planner:filters", PLANNER_EMPTY_FILTERS, normalizePlannerFilters);
  const [display, setDisplay] = useQueuePreferences(user?.id, "/planner:display", PLANNER_DEFAULT_DISPLAY, normalizePlannerDisplay);
  const [includeArchived, setIncludeArchived] = useState(false); const [includeDrafts, setIncludeDrafts] = useState(false); const [label, setLabel] = useState("");
  const [query, setQuery] = useState(""); const [debouncedQuery, setDebouncedQuery] = useState("");
  const [dateError, setDateError] = useState("");
  const [createFor, setCreateFor] = useState<string>(); const [created, setCreated] = useState<{ userId: string; view: HospitalTaskView }>();
  const [diagnosticDepartments, setDiagnosticDepartments] = useState<{ userId: string; codes: string[] }>({ userId: "", codes: [] });
  const receiveDiagnosticDepartments = useCallback((userId: string, codes: string[]) => {
    setDiagnosticDepartments((previous) => previous.userId === userId && previous.codes.join("\0") === codes.join("\0") ? previous : { userId, codes });
  }, []);
  const permissions = user?.permissions ?? [];
  const mayRead = permissions.includes("hospital_task.view");
  const page = usePlannerPage<HospitalTaskView>(user?.id, `/hospital-tasks?${plannerQuery({ ...filters, ...(includeArchived ? { includeArchived: true } : {}), ...(includeDrafts ? { includeDrafts: true } : {}), ...(label.trim() ? { label: label.trim() } : {}), ...(debouncedQuery ? { query: debouncedQuery } : {}), limit: 50 })}&orderBy=${display.orderBy}&direction=${display.direction}`, mayRead);
  const mayReadDiagnostics = permissions.includes("request.list") || permissions.includes("queue.view");
  const options = useMemo(() => departmentOptions(directory.departments, [...page.items.map((view) => view.task.departmentCode), ...(mayReadDiagnostics && diagnosticDepartments.userId === user?.id ? diagnosticDepartments.codes : [])]), [directory.departments, page.items, mayReadDiagnostics, diagnosticDepartments, user?.id]);
  const departmentNames = useMemo(() => Object.fromEntries(options.map((department) => [department.code, department.name])), [options]);
  const assignees = new Map(page.items.flatMap((view) => view.eligibleAssignees).map((entry) => [entry.id, entry]));
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 220);
    return () => window.clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    if (!user || !mayRead) return;
    const userId = user.id; const controller = new AbortController();
    void apiFetch<HospitalTaskType[]>("/hospital-task-types", { signal: controller.signal }).then((items) => { if (!controller.signal.aborted) { setTypes({ userId, items }); setTypesError(""); } }).catch((cause: unknown) => { if (!controller.signal.aborted) { setTypes({ userId, items: [] }); setTypesError(getSafeErrorMessage(cause, "Não foi possível consultar os tipos de atividade.")); } });
    return () => controller.abort();
  }, [user, mayRead]);
  function applyView(view: SavedPlannerView) {
    setFilters(view.filters); setDisplay(view.display); setQuery(""); setDebouncedQuery(""); setDateError("");
  }
  function changeDate(key: "from" | "to", value: string) {
    try { setFilters({ ...filters, [key]: value ? hospitalDateTimeInputToIso(value) : undefined }); setDateError(""); }
    catch (cause) { setDateError(cause instanceof Error ? cause.message : "Revise o período."); }
  }
  function clearFilters() { setIncludeArchived(false); setIncludeDrafts(false); setLabel(""); setFilters({}); setQuery(""); setDebouncedQuery(""); setDateError(""); }
  if (sessionError) return <ErrorState page title="Planner indisponível" message={sessionError} onRetry={() => window.location.reload()} />;
  if (!user) return <LoadingState label="Carregando seu planner" />;
  if (!mayRead) return <ErrorState page title="Planner fora do seu acesso" message="Você não tem acesso a este recurso." onRetry={() => window.location.reload()} />;
  const ownCreated = created?.userId === user.id ? created.view : undefined;
  const createdHidden = ownCreated && (ownCreated.task.isDraft && !includeDrafts || Boolean(label.trim() && !ownCreated.task.labels?.includes(label.trim())) || !taskMatchesFilters(ownCreated, filters, debouncedQuery));
  return <div className="work-items">
    <div className="page-heading"><div><h1>Planner hospitalar</h1><p className="page-lede">Atividades gerais e assistenciais no seu escopo autorizado.</p></div>{permissions.includes("hospital_task.create") && <ActionButton onClick={() => setCreateFor(user.id)} disabled={!types.some((type) => type.active)}>Nova atividade</ActionButton>}</div>
    <nav aria-label="Áreas do planner"><Link className="button button-ghost" href="/queues?view=mine">Exames ativos</Link>{permissions.includes("hospital_intake.view") && <Link className="button button-ghost" href="/planner/intake">Demandas para triagem</Link>}<Link className="button button-ghost" href="/planner/search">Busca do planner</Link>{permissions.includes("hospital_task_type.manage") && <Link className="button button-ghost" href="/planner/types">Tipos de atividade</Link>}</nav>
    {ownCreated && <div role="status" className="form-notice">{ownCreated.task.isDraft ? "Rascunho privado" : "Atividade"} {ownCreated.task.taskCode} criada. <Link href={`/planner/tasks/${encodeURIComponent(ownCreated.task.id)}`}>Abrir {ownCreated.task.title}</Link>{createdHidden && <> Os filtros atuais ocultam esta atividade. <button type="button" onClick={() => { clearFilters(); if (ownCreated.task.isDraft) setIncludeDrafts(true); }}>Limpar filtros para ver a atividade</button></>}</div>}
    <section className="panel" aria-label="Filtros ativos do planner">
      <label><input type="checkbox" checked={includeArchived} onChange={(event) => setIncludeArchived(event.target.checked)} />Incluir arquivadas</label><label><input type="checkbox" checked={includeDrafts} onChange={(event) => setIncludeDrafts(event.target.checked)} />Incluir rascunhos autorizados</label><label>Etiqueta exata<input maxLength={50} value={label} onChange={(event) => setLabel(event.target.value)} /></label>
      <label>Buscar atividade<input value={query} onChange={(event) => setQuery(event.target.value)} maxLength={200} /></label>
      <label>Setor<select value={filters.departmentCode ?? ""} onChange={(event) => setFilters({ ...filters, departmentCode: event.target.value || undefined })}><option value="">Todos os setores autorizados</option>{options.map((department) => <option key={department.code} value={department.code}>{department.name}</option>)}</select></label>
      <label>Responsável<select value={filters.responsibleUserId ?? ""} onChange={(event) => setFilters({ ...filters, responsibleUserId: event.target.value || undefined })}><option value="">Todos os responsáveis</option><option value={user.id}>Minhas atribuídas</option>{[...assignees.values()].filter((entry) => entry.id !== user.id).map((entry) => <option key={entry.id} value={entry.id}>{entry.displayName}</option>)}{filters.responsibleUserId && filters.responsibleUserId !== user.id && !assignees.has(filters.responsibleUserId) && <option value={filters.responsibleUserId}>Responsável configurado na visão</option>}</select></label>
      <PlannerScopeFilters user={user} planId={filters.planId} onPlanChange={(planId) => setFilters({ ...filters, planId })} />
      <label>Tipo<select value={filters.typeId ?? ""} onChange={(event) => setFilters({ ...filters, typeId: event.target.value || undefined })}><option value="">Todos os tipos</option>{types.map((type) => <option key={type.id} value={type.id}>{type.name}{!type.active ? " (inativo)" : ""}</option>)}</select></label>
      <label>Fase<select value={filters.phase ?? ""} onChange={(event) => setFilters({ ...filters, phase: event.target.value as PlannerViewFilters["phase"] || undefined })}><option value="">Todas as fases</option>{Object.entries(PHASE_LABELS).map(([phase, label]) => <option key={phase} value={phase}>{label}</option>)}</select></label>
      <label>Prioridade<select value={filters.priority ?? ""} onChange={(event) => setFilters({ ...filters, priority: event.target.value as PlannerViewFilters["priority"] || undefined })}><option value="">Todas as prioridades</option><option value="ROUTINE">Rotina</option><option value="URGENT">Urgente</option><option value="EMERGENCY">Emergência</option></select></label>
      <label>Período desde<input type="datetime-local" value={filters.from ? hospitalDateTimeInput(filters.from) : ""} onChange={(event) => changeDate("from", event.target.value)} /></label><label>Período até<input type="datetime-local" value={filters.to ? hospitalDateTimeInput(filters.to) : ""} onChange={(event) => changeDate("to", event.target.value)} /></label>
      <p className="field-hint">Período no horário do hospital: início planejado ou criação quando não planejada. “Minhas atribuídas” filtra o responsável; “Meu trabalho” mantém todos os exames ativos autorizados.</p>
      <button type="button" className="button button-ghost" onClick={clearFilters}>Limpar filtros</button>{dateError && <p role="alert">{dateError}</p>}
    </section>
    <details className="panel"><summary>Apresentação</summary>
      <label>Visão<select value={display.layout} onChange={(event) => setDisplay({ ...display, layout: event.target.value as typeof display.layout })}><option value="LIST">Lista</option><option value="BOARD">Quadro</option><option value="TABLE">Planilha</option><option value="CALENDAR">Calendário planejado</option></select></label>
      <label>Agrupar por<select value={display.groupBy} onChange={(event) => setDisplay({ ...display, groupBy: event.target.value as typeof display.groupBy })}>{(["NONE", "DEPARTMENT", "RESPONSIBLE", "TYPE", "PHASE"] as const).map((value) => <option key={value} value={value}>{{ NONE: "Sem agrupamento", DEPARTMENT: "Setor", RESPONSIBLE: "Responsável", TYPE: "Tipo", PHASE: "Fase" }[value]}</option>)}</select></label>
      <label>Ordenar por<select value={display.orderBy} onChange={(event) => setDisplay({ ...display, orderBy: event.target.value as typeof display.orderBy })}><option value="UPDATED">Atualização</option><option value="PRIORITY">Prioridade</option><option value="PLANNED_START">Início planejado</option></select></label><label>Direção<select value={display.direction} onChange={(event) => setDisplay({ ...display, direction: event.target.value as typeof display.direction })}><option value="DESC">Decrescente</option><option value="ASC">Crescente</option></select></label>
      <fieldset><legend>Colunas visíveis</legend>{PLANNER_VIEW_COLUMNS.map((column) => <label key={column}><input type="checkbox" checked={display.columns.includes(column)} disabled={column === "title"} onChange={(event) => setDisplay({ ...display, columns: event.target.checked ? [...display.columns, column] : display.columns.filter((entry) => entry !== column) })} />{COLUMN_LABELS[column]}</label>)}</fieldset>
    </details>
    <PlannerSavedViews key={`saved-views:${user.id}`} user={user} filters={filters} display={display} departments={directory.departments} onApply={applyView} />
    {creationOptions.error && <p role="alert">{creationOptions.error}</p>}{typesError && <p role="alert">{typesError}</p>}{page.error && <PartialNotice message={page.error} onRetry={page.reload} retrying={page.loading} />}
    <p role="status">Mostrando {page.items.length} de {page.total} atividades autorizadas{page.loading ? " · atualizando…" : ""}.</p>
    {page.loading && !page.items.length ? <LoadingState label="Carregando atividades" /> : !page.items.length ? <EmptyState title="Nenhuma atividade nesta visão" message="Confira os filtros ou crie uma atividade no seu setor." /> : <PlannerTaskLayouts items={page.items} display={display} departmentNames={departmentNames} user={user} readOnly={Boolean(page.error)} onChanged={() => void page.reload()} />}
    {display.layout === "BOARD" && <PlannerDiagnosticBoard user={user} filters={filters} query={debouncedQuery} onDepartments={receiveDiagnosticDepartments} />}
    <PlannerTaskBatch key={`task-batch:${user.id}`} user={user} items={page.items} disabled={Boolean(page.error)} onChanged={() => void page.reload()} />
    {page.nextCursor && <ActionButton tone="ghost" state={page.loadingMore ? "pending" : "idle"} onClick={() => void page.loadMore()} disabled={page.loading}>Carregar mais atividades</ActionButton>}
    {createFor === user.id && permissions.includes("hospital_task.create") && <PlannerTaskForm key={`task-create:${user.id}`} user={user} types={creationOptions.data?.types ?? types} departments={creationOptions.data?.departments.map((entry) => ({ ...entry, active: true })) ?? directory.departments} onClose={() => setCreateFor(undefined)} onCreated={(view) => { setCreated({ userId: user.id, view }); setCreateFor(undefined); void page.reload(); }} />}
  </div>;
}
