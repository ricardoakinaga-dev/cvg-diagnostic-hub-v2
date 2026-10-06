"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ItemState } from "@cvg/contracts";
import { getSafeErrorMessage } from "@/components/api-client";
import { ErrorState, StaleNotice } from "@/components/feedback-states";
import { PageHeader, type Crumb } from "@/components/page-header";
import { QueueBoardRequestDialog } from "@/components/queue-board-request-dialog";
import { Icon, type IconName } from "@/components/ui-icons";
import { actionLabel, canUseWorkflowAction, executeSimpleWorkflowAction, WorkflowInputError, workflowActionForTransition, type WorkflowActionKind } from "@/components/workflow-action";
import { DisplayDropdown, FiltersDropdown } from "./dropdowns";
import { DepartmentIcon, PriorityIcon, StateIcon } from "./icons";
import { BoardLayout, CalendarLayout, ListLayout, SpreadsheetLayout } from "./layouts";
import { PeekOverview } from "./peek-overview";
import { useWorkItems } from "./use-work-items";
import {
  DEFAULT_DISPLAY, DISPLAY_PROPERTY_LABELS, EMPTY_FILTERS, GROUP_BY_LABELS, LAYOUT_LABELS, ORDER_BY_LABELS, PRIORITY_LABELS, STATE_LABELS, STATE_ORDER, activeFilterCount, applyFilters, departmentLabel, groupItems, isTerminal, sortItems,
  type DisplayOptions, type Layout, type WorkItem, type WorkItemFilters
} from "./model";

const DISPLAY_STORAGE_KEY = "cvg.work-items.display.v1";
const DIRECT_ACTIONS: WorkflowActionKind[] = ["START_PROCESSING", "START_PROCEDURE", "MARK_PERFORMED", "RELEASE_RESULT", "COMPLETE"];
const CREATOR_ROLES = ["MANAGER", "VETERINARIAN", "VET", "INPATIENT_TEAM"];
const layoutIcons: Record<Layout, IconName> = { list: "list", board: "board", calendar: "calendar", spreadsheet: "table" };

type Preset = "overdue" | "results" | "done" | null;

function presetFilters(preset: Preset, dept: string | null): WorkItemFilters {
  const base: WorkItemFilters = { ...EMPTY_FILTERS, departments: dept ? [dept] : [] };
  if (preset === "overdue") return { ...base, overdueOnly: true };
  if (preset === "results") return { ...base, states: ["RESULT_AVAILABLE", "REVIEWED"] };
  if (preset === "done") return { ...base, states: ["COMPLETED", "CANCELLED", "REJECTED"] };
  return base;
}

const presetLabels: Record<Exclude<Preset, null>, string> = { overdue: "Em atraso", results: "Resultados", done: "Concluídos" };

function readDisplay(): DisplayOptions {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(DISPLAY_STORAGE_KEY) ?? "null");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return DEFAULT_DISPLAY;
    const saved = parsed as Record<string, unknown>;
    const layout = typeof saved.layout === "string" && Object.hasOwn(LAYOUT_LABELS, saved.layout) ? saved.layout as DisplayOptions["layout"] : DEFAULT_DISPLAY.layout;
    const groupBy = typeof saved.groupBy === "string" && Object.hasOwn(GROUP_BY_LABELS, saved.groupBy) ? saved.groupBy as DisplayOptions["groupBy"] : DEFAULT_DISPLAY.groupBy;
    return {
      layout,
      groupBy: layout === "board" && groupBy === "none" ? "status" : groupBy,
      orderBy: typeof saved.orderBy === "string" && Object.hasOwn(ORDER_BY_LABELS, saved.orderBy) ? saved.orderBy as DisplayOptions["orderBy"] : DEFAULT_DISPLAY.orderBy,
      properties: Array.isArray(saved.properties) ? saved.properties.filter((property): property is DisplayOptions["properties"][number] => typeof property === "string" && Object.hasOwn(DISPLAY_PROPERTY_LABELS, property)) : DEFAULT_DISPLAY.properties,
      showEmptyGroups: typeof saved.showEmptyGroups === "boolean" ? saved.showEmptyGroups : DEFAULT_DISPLAY.showEmptyGroups
    };
  } catch { return DEFAULT_DISPLAY; }
}

interface Toast { id: number; tone: "success" | "error"; title: string; message?: string }

export function WorkItemsView() {
  const router = useRouter();
  const params = useSearchParams();
  const dept = params.get("dept");
  const preset = (["overdue", "results", "done"].includes(params.get("preset") ?? "") ? params.get("preset") : null) as Preset;
  const mine = params.get("view") === "mine";
  const { user, items, loading, refreshing, error, partial, truncated, reload, patch } = useWorkItems();
  const [filters, setFilters] = useState<WorkItemFilters>(() => presetFilters(preset, dept));
  const [display, setDisplay] = useState<DisplayOptions>(DEFAULT_DISPLAY);
  const [peek, setPeek] = useState<{ id: string; action?: WorkflowActionKind }>();
  const [busyId, setBusyId] = useState<string>();
  const [showCreate, setShowCreate] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const role = user?.role ?? "VIEWER";
  const canCreate = CREATOR_ROLES.includes(role);

  useEffect(() => { const timer = window.setTimeout(() => setDisplay(readDisplay()), 0); return () => window.clearTimeout(timer); }, []);
  useEffect(() => { const timer = window.setTimeout(() => { setFilters(presetFilters(preset, dept)); setPeek(undefined); }, 0); return () => window.clearTimeout(timer); }, [preset, dept, mine]);

  const updateDisplay = useCallback((next: DisplayOptions) => {
    const normalized = next.layout === "board" && next.groupBy === "none" ? { ...next, groupBy: "status" as const } : next;
    setDisplay(normalized);
    try { window.localStorage.setItem(DISPLAY_STORAGE_KEY, JSON.stringify(normalized)); } catch { /* per-viewer convenience */ }
  }, []);

  const notify = useCallback((toast: Omit<Toast, "id">) => {
    const id = ++toastId.current;
    setToasts((current) => [...current.slice(-2), { ...toast, id }]);
    window.setTimeout(() => setToasts((current) => current.filter((entry) => entry.id !== id)), 4200);
  }, []);

  // Create from the shell (sidebar button, Ctrl+K) or from ?create=request.
  useEffect(() => {
    const open = () => setShowCreate(true);
    window.addEventListener("cvg:create-request", open);
    const timer = window.setTimeout(() => {
      const search = new URLSearchParams(window.location.search);
      if (search.get("create") !== "request") return;
      open();
      search.delete("create");
      const query = search.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
    }, 0);
    return () => { window.clearTimeout(timer); window.removeEventListener("cvg:create-request", open); };
  }, []);

  // Plane keyboard shortcuts: C creates, / focuses search.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input, textarea, select, [contenteditable=true]") || document.querySelector("[data-dialog-layer='true']")) return;
      if (event.key === "c" && canCreate) { event.preventDefault(); setShowCreate(true); }
      if (event.key === "/") { event.preventDefault(); searchRef.current?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canCreate]);

  const scoped = useMemo(() => {
    if (!mine || !user) return items;
    if (["VETERINARIAN", "VET", "INPATIENT_TEAM"].includes(user.role)) return items.filter((item) => item.requesterId === user.id);
    if (user.role === "MANAGER") return items.filter((item) => !isTerminal(item.status) && (item.overdue || ["ATTENTION", "URGENT"].includes(item.operationalContext?.escalationLevel ?? "NONE") || item.priority !== "ROUTINE"));
    return items.filter((item) => item.departmentCode === user.departmentCode && !isTerminal(item.status));
  }, [items, mine, user]);
  const visible = useMemo(() => sortItems(applyFilters(scoped, filters), display.orderBy), [scoped, filters, display.orderBy]);
  const departments = useMemo(() => Array.from(new Set(scoped.map((item) => item.departmentCode))).sort(), [scoped]);
  const services = useMemo(() => Array.from(new Map(scoped.map((item) => [item.service.code, { code: item.service.code, name: item.service.name }])).values()).sort((a, b) => a.name.localeCompare(b.name, "pt-BR")), [scoped]);
  const groups = useMemo(() => groupItems(visible, display.layout === "board" && display.groupBy === "none" ? "status" : display.groupBy, display.showEmptyGroups || (display.layout === "board" && display.groupBy === "status" && visible.length === 0), { departments: departments.length ? departments : dept ? [dept] : [] }), [visible, display, departments, dept]);
  const boardGroups = useMemo(() => {
    // The board always shows the workflow spine so cards have somewhere to go.
    if (display.layout !== "board" || display.groupBy !== "status" || display.showEmptyGroups) return groups;
    const spine = new Set<ItemState>(["REQUESTED", "IN_PROGRESS", "RESULT_AVAILABLE", "COMPLETED"]);
    for (const item of visible) {
      for (const state of STATE_ORDER) {
        const action = workflowActionForTransition(item, state);
        if (action && canUseWorkflowAction(role, action, item)) spine.add(state);
      }
    }
    const present = new Set(groups.map((group) => group.value));
    const extra = [...spine].filter((state) => !present.has(state)).map((state) => ({ id: state, label: STATE_LABELS[state], kind: "state" as const, value: state, items: [] }));
    return [...groups, ...extra].sort((a, b) => STATE_ORDER.indexOf(a.value as ItemState) - STATE_ORDER.indexOf(b.value as ItemState));
  }, [display.groupBy, display.layout, display.showEmptyGroups, groups, role, visible]);
  // Like Plane's always-present "New work item" row, creators always see the
  // Solicitado group in the list so the inline quick add is reachable.
  const listGroups = useMemo(() => {
    if (!canCreate || display.groupBy !== "status" || groups.some((group) => group.value === "REQUESTED")) return groups;
    return [{ id: "REQUESTED", label: STATE_LABELS.REQUESTED, kind: "state" as const, value: "REQUESTED", items: [] }, ...groups];
  }, [canCreate, display.groupBy, groups]);
  const peeked = peek ? items.find((item) => item.id === peek.id) : undefined;
  const linkedItem = params.get("item");

  const [consumedLink, setConsumedLink] = useState<string | null>(null);

  // Deep link (?item=) from Home, Inbox or a copied link opens the side peek once.
  useEffect(() => {
    if (!linkedItem || linkedItem === consumedLink || loading || !items.some((item) => item.id === linkedItem)) return;
    const timer = window.setTimeout(() => { setPeek({ id: linkedItem }); setConsumedLink(linkedItem); }, 0);
    return () => window.clearTimeout(timer);
  }, [consumedLink, items, linkedItem, loading]);

  // Only an in-flight command blocks the list. Background refreshes run on
  // every realtime event; disabling actions during them silently dropped
  // clicks, and a stale version is still rejected by the server.
  const move = useCallback(async (item: WorkItem, target: ItemState) => {
    if (busyId) return;
    const action = workflowActionForTransition(item, target);
    if (!action || !canUseWorkflowAction(role, action, item)) { notify({ tone: "error", title: "Mudança não permitida", message: "Use a próxima ação disponível no fluxo deste exame." }); return; }
    if (!DIRECT_ACTIONS.includes(action)) { setPeek({ id: item.id, action }); return; }
    setBusyId(item.id);
    const previous = item.status;
    patch(item.id, { status: target }, item.version);
    try {
      await executeSimpleWorkflowAction(item, action);
      notify({ tone: "success", title: actionLabel[action], message: `${item.patient.displayName} — ${item.service.name} agora está em “${STATE_LABELS[target]}”.` });
      await reload();
    } catch (cause) {
      patch(item.id, { status: previous }, item.version);
      notify({ tone: "error", title: "Não foi possível mover o exame", message: cause instanceof WorkflowInputError ? cause.message : getSafeErrorMessage(cause, "Atualize a lista e tente novamente.") });
    } finally {
      setBusyId(undefined);
    }
  }, [busyId, notify, patch, reload, role]);

  const onMove = useCallback((item: WorkItem, target: ItemState) => { void move(item, target); }, [move]);

  const runAction = useCallback(async (item: WorkItem, action: WorkflowActionKind) => {
    if (busyId) return;
    if (!DIRECT_ACTIONS.includes(action)) { setPeek({ id: item.id, action }); return; }
    setBusyId(item.id);
    try {
      await executeSimpleWorkflowAction(item, action);
      notify({ tone: "success", title: actionLabel[action], message: `${item.patient.displayName} — ${item.service.name}: confirmado pelo servidor.` });
      await reload();
    } catch (cause) {
      notify({ tone: "error", title: `Não foi possível ${actionLabel[action].toLocaleLowerCase("pt-BR")}`, message: cause instanceof WorkflowInputError ? cause.message : getSafeErrorMessage(cause, "Atualize a lista e tente novamente.") });
      if (cause instanceof WorkflowInputError) setPeek({ id: item.id });
    } finally {
      setBusyId(undefined);
    }
  }, [busyId, notify, reload]);
  const onAction = useCallback((item: WorkItem, action: WorkflowActionKind) => { void runAction(item, action); }, [runAction]);
  const onPeek = useCallback((item: WorkItem) => setPeek((current) => current?.id === item.id && !current.action ? undefined : { id: item.id }), []);

  const crumbs: Crumb[] = mine
    ? [{ label: "Meu trabalho", icon: "user-check" }]
    : dept
      ? [{ label: departmentLabel(dept), icon: <DepartmentIcon code={dept} size={15} />, href: `/queues?dept=${dept}` }, { label: preset ? presetLabels[preset] : "Exames", icon: preset ? undefined : "layers" }]
      : [{ label: "Workspace", icon: "home", href: "/" }, { label: "Todos os exames", icon: "layers" }];

  const chips = [
    ...filters.states.map((state) => ({ key: `s-${state}`, icon: <StateIcon state={state} />, label: STATE_LABELS[state], remove: () => setFilters({ ...filters, states: filters.states.filter((value) => value !== state) }) })),
    ...filters.priorities.map((priority) => ({ key: `p-${priority}`, icon: <PriorityIcon priority={priority} />, label: PRIORITY_LABELS[priority], remove: () => setFilters({ ...filters, priorities: filters.priorities.filter((value) => value !== priority) }) })),
    ...filters.departments.filter((code) => code !== dept).map((code) => ({ key: `d-${code}`, icon: <DepartmentIcon code={code} size={12} />, label: departmentLabel(code), remove: () => setFilters({ ...filters, departments: filters.departments.filter((value) => value !== code) }) })),
    ...filters.services.map((code) => ({ key: `e-${code}`, icon: <Icon name="hash" size={12} />, label: services.find((service) => service.code === code)?.name ?? code, remove: () => setFilters({ ...filters, services: filters.services.filter((value) => value !== code) }) })),
    ...(filters.overdueOnly ? [{ key: "overdue", icon: <Icon name="clock" size={12} />, label: "Somente atrasados", remove: () => setFilters({ ...filters, overdueOnly: false }) }] : []),
    ...(filters.hideClosed ? [{ key: "closed", icon: <Icon name="close" size={12} />, label: "Sem concluídos", remove: () => setFilters({ ...filters, hideClosed: false }) }] : [])
  ];
  const filterCount = activeFilterCount(filters) - (dept && filters.departments.includes(dept) ? 1 : 0);

  // Inside a sector the sector pill is redundant, as in a Plane project.
  const effectiveDisplay = dept ? { ...display, properties: display.properties.filter((property) => property !== "department") } : display;
  const layoutProps = { groups: display.layout === "board" ? boardGroups : listGroups, display: effectiveDisplay, role, peekId: peek?.id, busy: Boolean(busyId), canCreate, onPeek, onMove, onAction, onCreate: () => setShowCreate(true), quickAdd: { departments: role === "MANAGER" ? (user?.managedDepartmentCodes ?? []) : [], onCreated: () => { void reload(); } } };

  return <div className={`work-items${peeked ? " has-peek" : ""}`}>
    <PageHeader crumbs={crumbs} count={loading ? undefined : visible.length}>
      <div className="header-search">
        <Icon name="search" size={13} />
        <input ref={searchRef} value={filters.search} onChange={(event) => setFilters({ ...filters, search: event.target.value })} placeholder="Buscar" aria-label="Buscar paciente ou exame" aria-keyshortcuts="/" />
        {filters.search && <button type="button" className="icon-button" onClick={() => setFilters({ ...filters, search: "" })} aria-label="Limpar busca"><Icon name="close" size={12} /></button>}
      </div>
      <div className="layout-switcher" role="radiogroup" aria-label="Layout">
        {(Object.keys(LAYOUT_LABELS) as Layout[]).map((layout) => <button key={layout} type="button" role="radio" aria-checked={display.layout === layout} className={display.layout === layout ? "is-active" : ""} onClick={() => updateDisplay({ ...display, layout })} title={LAYOUT_LABELS[layout]} aria-label={LAYOUT_LABELS[layout]}><Icon name={layoutIcons[layout]} size={15} /></button>)}
      </div>
      <FiltersDropdown filters={filters} onChange={setFilters} departments={departments} services={services} lockedDepartment={dept ?? undefined} />
      <DisplayDropdown display={display} onChange={updateDisplay} />
      <button type="button" className="icon-button header-refresh" onClick={() => void reload()} aria-label="Atualizar" title="Atualizar"><Icon name="refresh" size={14} className={refreshing ? "spin" : undefined} /></button>
      {canCreate && <button type="button" className="button-primary-sm" onClick={() => setShowCreate(true)} aria-keyshortcuts="c"><Icon name="add" size={14} /><span>Nova solicitação</span></button>}
    </PageHeader>

    {(chips.length > 0 || filterCount > 0) && <div className="applied-filters" aria-label="Filtros aplicados">
      {chips.map((chip) => <span key={chip.key} className="filter-chip">{chip.icon}<span>{chip.label}</span><button type="button" onClick={chip.remove} aria-label={`Remover filtro ${chip.label}`}><Icon name="close" size={11} /></button></span>)}
      <button type="button" className="link-button" onClick={() => setFilters(presetFilters(null, dept))}>Limpar filtros</button>
    </div>}

    {error && items.length > 0 && <StaleNotice onRetry={reload} retrying={refreshing} />}
    {(partial || truncated) && <div className="inline-notice" role="status"><Icon name="attention" size={14} />{partial || "Lista limitada a 1.000 solicitações e 1.000 itens por fila; os filtros se aplicam apenas aos exames carregados."}</div>}

    <div className="work-items-body">
      <div className="work-items-canvas" aria-busy={loading || refreshing}>
        {error && !loading && items.length === 0 ? <div className="page-body"><ErrorState title="Não foi possível carregar os exames" message={error} onRetry={reload} retrying={refreshing} /></div>
          : loading ? <WorkItemsSkeleton layout={display.layout} />
            : visible.length === 0 && display.layout !== "board" && display.layout !== "calendar" && !(display.layout === "list" && canCreate && display.groupBy === "status" && !filterCount && !filters.search) ? <WorkItemsEmpty filtered={filterCount > 0 || Boolean(filters.search)} mine={mine} canCreate={canCreate} onClear={() => setFilters(presetFilters(null, dept))} onCreate={() => setShowCreate(true)} />
              : display.layout === "list" ? <ListLayout {...layoutProps} />
                : display.layout === "board" ? <BoardLayout {...layoutProps} />
                  : display.layout === "calendar" ? <CalendarLayout items={visible} role={role} peekId={peek?.id} onPeek={onPeek} onMove={onMove} busy={Boolean(busyId)} />
                    : <SpreadsheetLayout items={visible} role={role} peekId={peek?.id} onPeek={onPeek} onMove={onMove} busy={Boolean(busyId)} />}
      </div>
      {peeked && user && <PeekOverview key={peeked.id} item={peeked} role={role} initialAction={peek?.action} onClose={() => setPeek(undefined)} onChanged={() => { setPeek((current) => current ? { id: current.id } : current); void reload(); }} onRefresh={() => { void reload(); }} onMove={onMove} />}
    </div>

    <div className="toast-stack" aria-live="polite">
      {toasts.map((toast) => <div key={toast.id} className={`toast toast-${toast.tone}`} role={toast.tone === "error" ? "alert" : "status"}><Icon name={toast.tone === "success" ? "check" : "attention"} size={15} /><div><strong>{toast.title}</strong>{toast.message && <span>{toast.message}</span>}</div><button type="button" className="icon-button" onClick={() => setToasts((current) => current.filter((entry) => entry.id !== toast.id))} aria-label="Fechar aviso"><Icon name="close" size={12} /></button></div>)}
    </div>

    {showCreate && canCreate && <QueueBoardRequestDialog departments={role === "MANAGER" ? (user?.managedDepartmentCodes ?? []) : []} canCreatePatient={["VETERINARIAN", "VET", "INPATIENT_TEAM"].includes(role)} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); notify({ tone: "success", title: "Solicitação criada", message: "Os exames entraram em “Solicitado”." }); void reload(); router.refresh(); }} />}
  </div>;
}

function WorkItemsSkeleton({ layout }: { layout: Layout }) {
  if (layout === "board") return <div className="board-layout" aria-hidden="true">{[0, 1, 2, 3].map((column) => <div key={column} className="board-column"><div className="skeleton skeleton-line" style={{ width: "40%" }} />{[0, 1, 2].map((card) => <div key={card} className="skeleton skeleton-card" />)}</div>)}</div>;
  return <div className="list-layout" role="status" aria-label="Carregando exames">{[0, 1].map((group) => <div key={group} className="list-group"><div className="list-group-header"><div className="skeleton skeleton-line" style={{ width: 160 }} /></div>{[0, 1, 2, 3].map((row) => <div key={row} className="list-row"><div className="skeleton skeleton-line" style={{ width: `${40 + ((row * 13) % 30)}%` }} /></div>)}</div>)}</div>;
}

function WorkItemsEmpty({ filtered, mine, canCreate, onClear, onCreate }: { filtered: boolean; mine: boolean; canCreate: boolean; onClear: () => void; onCreate: () => void }) {
  return <div className="empty-panel" role="status">
    <span className="empty-panel-icon" aria-hidden="true"><Icon name={filtered ? "filter" : "layers"} size={26} /></span>
    <h2>{filtered ? "Nenhum exame com estes filtros" : mine ? "Nada esperando por você" : "Nenhum exame por aqui ainda"}</h2>
    <p>{filtered ? "Ajuste ou limpe os filtros para ver mais exames." : mine ? "Quando um exame precisar da sua ação, ele aparece aqui." : "Exames solicitados para os setores que você acompanha aparecem nesta lista."}</p>
    <div className="empty-panel-actions">
      {filtered && <button type="button" className="header-button" onClick={onClear}>Limpar filtros</button>}
      {canCreate && !filtered && <button type="button" className="button-primary-sm" onClick={onCreate}><Icon name="add" size={14} />Nova solicitação</button>}
    </div>
  </div>;
}
