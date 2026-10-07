"use client";

import { useId, useMemo, useRef, useState } from "react";
import type { ItemState, Priority, SessionRole } from "@cvg/contracts";
import { Icon } from "@/components/ui-icons";
import { QueueBoardQuickAdd } from "@/components/queue-board-quick-add";
import { Avatar, DepartmentIcon, PriorityIcon, StateIcon } from "./icons";
import { NextActionButtons, WorkItemKey, WorkItemProperties, StatePill, allowedTransitions } from "./properties";
import type { WorkflowActionKind } from "@/components/workflow-action";
import { PRIORITY_LABELS, STATE_LABELS, departmentLabel, formatDateTime, formatDue, workItemTitle, type DisplayOptions, type WorkItem, type WorkItemGroup } from "./model";

export interface LayoutProps {
  groups: WorkItemGroup[];
  display: DisplayOptions;
  role: SessionRole;
  peekId?: string;
  busy: boolean;
  canCreate: boolean;
  onPeek: (item: WorkItem) => void;
  onMove: (item: WorkItem, target: ItemState) => void;
  onAction: (item: WorkItem, action: WorkflowActionKind) => void;
  onCreate: () => void;
  /** Scope for the inline quick add; managers are limited to their sectors. */
  quickAdd: { departments: string[]; onCreated: () => void };
}

/** Plane's inline "New work item" row: it opens a compact form in place. */
function InlineQuickAdd({ quickAdd, busy, onCreate }: { quickAdd: LayoutProps["quickAdd"]; busy: boolean; onCreate: () => void }) {
  const [open, setOpen] = useState(false);
  if (!open) return <button type="button" className="quick-add" onClick={() => setOpen(true)}><Icon name="add" size={14} />Nova solicitação</button>;
  return <div className="inline-quick-add">
    <QueueBoardQuickAdd departments={quickAdd.departments} onCreated={quickAdd.onCreated} disabled={false} refreshing={busy} />
    <div className="inline-quick-add-footer">
      <button type="button" className="link-button" onClick={onCreate}>Abrir formulário completo</button>
      <button type="button" className="header-button" onClick={() => setOpen(false)}>Fechar</button>
    </div>
  </div>;
}

export function GroupIcon({ group }: { group: WorkItemGroup }) {
  if (group.kind === "state") return <StateIcon state={group.value as ItemState} size={15} />;
  if (group.kind === "priority") return <PriorityIcon priority={group.value as Priority} size={15} />;
  if (group.kind === "department") return <DepartmentIcon code={group.value} size={15} />;
  if (group.kind === "patient") return <Icon name="paw" size={15} />;
  if (group.kind === "service") return <Icon name="hash" size={15} />;
  return <Icon name="layers" size={15} />;
}

function openFromRow(event: React.MouseEvent<HTMLElement>, item: WorkItem, onPeek: (item: WorkItem) => void) {
  if (event.target instanceof Element && event.target.closest("button, a, input, select, textarea, label, [role=menu]")) return;
  onPeek(item);
}

/* ---------- List ---------- */

export function ListLayout({ groups, display, role, peekId, busy, canCreate, onPeek, onMove, onAction, onCreate, quickAdd }: LayoutProps) {
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const showHeaders = display.groupBy !== "none";
  return <div className="list-layout" role="list" aria-label="Exames">
    {groups.map((group) => {
      const isCollapsed = collapsed.includes(group.id);
      return <section key={group.id} className="list-group" aria-label={`${group.label}: ${group.items.length} exames`} role="listitem">
        {showHeaders && <header className="list-group-header">
          <button type="button" className="group-toggle" aria-expanded={!isCollapsed} onClick={() => setCollapsed((current) => isCollapsed ? current.filter((id) => id !== group.id) : [...current, group.id])}>
            <GroupIcon group={group} /><h2>{group.label}</h2><span className="group-count">{group.items.length}</span>
          </button>
          {canCreate && group.kind === "state" && group.value === "REQUESTED" && <button type="button" className="icon-button group-add" onClick={onCreate} aria-label="Nova solicitação"><Icon name="add" size={15} /></button>}
        </header>}
        {!isCollapsed && <div className="list-rows" role="list" aria-label={`Exames: ${group.label}`}>
          {group.items.map((item) => <div key={item.id} role="listitem" data-item-row="" data-request-code={item.requestCode} className={`list-row${peekId === item.id ? " is-peeked" : ""}${item.overdue ? " is-overdue" : ""}`} onClick={(event) => openFromRow(event, item, onPeek)}>
            <div className="list-row-main">
              {display.properties.includes("key") && <WorkItemKey item={item} />}
              <button type="button" className="list-row-title" onClick={() => onPeek(item)} aria-label={`Abrir ${item.service.name} — ${item.patient.displayName}`}>
                <span className="title-patient">{item.patient.displayName}</span><span className="title-sep">—</span><span>{item.service.name}</span>
              </button>
              {display.properties.includes("patient") && <span className="list-row-sub">{item.patient.externalId}</span>}
            </div>
            <div className="list-row-side">
              <NextActionButtons item={item} role={role} onAction={onAction} disabled={busy} />
              <WorkItemProperties item={item} role={role} properties={display.properties.filter((property) => property !== "key")} onMove={onMove} disabled={busy} />
            </div>
          </div>)}
        </div>}
        {!isCollapsed && group.items.length === 0 && <p className="list-empty">Nenhum exame neste grupo.</p>}
        {!isCollapsed && canCreate && (!showHeaders || (group.kind === "state" && group.value === "REQUESTED")) && <InlineQuickAdd quickAdd={quickAdd} busy={busy} onCreate={onCreate} />}
      </section>;
    })}
  </div>;
}

/* ---------- Board ---------- */

export function BoardLayout({ groups, display, role, peekId, busy, canCreate, onPeek, onMove, onAction, onCreate, quickAdd }: LayoutProps) {
  const dragged = useRef<WorkItem | undefined>(undefined);
  const [overColumn, setOverColumn] = useState<string>();
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const statusBoard = display.groupBy === "status";
  return <div className="board-layout" aria-label="Quadro de exames">
    {groups.map((group) => {
      const isCollapsed = collapsed.includes(group.id);
      const target = group.value as ItemState;
      const canDrop = (item?: WorkItem) => Boolean(statusBoard && item && item.status !== target && allowedTransitions(item, role).some((transition) => transition.target === target));
      if (isCollapsed) {
        return <button key={group.id} type="button" className="board-column-collapsed" onClick={() => setCollapsed((current) => current.filter((id) => id !== group.id))} aria-label={`Expandir ${group.label}`}><GroupIcon group={group} /><span>{group.label}</span><span className="group-count">{group.items.length}</span></button>;
      }
      return <section key={group.id} className={`board-column${overColumn === group.id ? " is-drop-target" : ""}`} aria-label={group.label}
        onDragOver={(event) => { if (!busy && canDrop(dragged.current)) { event.preventDefault(); setOverColumn(group.id); } }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setOverColumn(undefined); }}
        onDrop={(event) => { event.preventDefault(); setOverColumn(undefined); const item = dragged.current; dragged.current = undefined; if (item && canDrop(item)) onMove(item, target); }}>
        <header className="board-column-header">
          <GroupIcon group={group} /><h2>{group.label}</h2><span className="group-count">{group.items.length}</span>
          <span className="board-column-actions">
            <button type="button" className="icon-button" onClick={() => setCollapsed((current) => [...current, group.id])} aria-label={`Recolher ${group.label}`}><Icon name="collapse" size={13} /></button>
            {canCreate && group.kind === "state" && group.value === "REQUESTED" && <button type="button" className="icon-button" onClick={onCreate} aria-label="Nova solicitação"><Icon name="add" size={14} /></button>}
          </span>
        </header>
        <div className="board-cards" role="list" aria-label={`Exames: ${group.label}`}>
          {group.items.map((item) => {
            const draggable = statusBoard && !busy && allowedTransitions(item, role).length > 0;
            return <article key={item.id} role="listitem" data-item-row="" data-request-code={item.requestCode} className={`board-card${peekId === item.id ? " is-peeked" : ""}${item.overdue ? " is-overdue" : ""}`} draggable={draggable}
              onDragStart={(event) => { dragged.current = item; event.dataTransfer.setData("text/plain", item.id); event.dataTransfer.effectAllowed = "move"; }}
              onDragEnd={() => { dragged.current = undefined; setOverColumn(undefined); }}
              onClick={(event) => openFromRow(event, item, onPeek)}>
              {display.properties.includes("key") && <WorkItemKey item={item} />}
              <button type="button" className="board-card-title" onClick={() => onPeek(item)} aria-label={`Abrir ${item.service.name} — ${item.patient.displayName}`}>{workItemTitle(item)}</button>
              <WorkItemProperties item={item} role={role} properties={display.properties.filter((property) => property !== "key")} onMove={onMove} disabled={busy} />
              <NextActionButtons item={item} role={role} onAction={onAction} disabled={busy} />
            </article>;
          })}
        </div>
        {canCreate && group.kind === "state" && group.value === "REQUESTED" && <InlineQuickAdd quickAdd={quickAdd} busy={busy} onCreate={onCreate} />}
      </section>;
    })}
  </div>;
}

/* ---------- Calendar ---------- */

const weekdayLabels = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

function startOf(mode: "month" | "week", date: Date): Date {
  return mode === "month" ? new Date(date.getFullYear(), date.getMonth(), 1) : new Date(date.getFullYear(), date.getMonth(), date.getDate() - date.getDay());
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function CalendarLayout({ items, role, peekId, onPeek, onMove, busy }: { items: WorkItem[]; role: SessionRole; peekId?: string; onPeek: (item: WorkItem) => void; onMove: (item: WorkItem, target: ItemState) => void; busy: boolean }) {
  const calendarId = useId();
  const [mode, setMode] = useState<"month" | "week">("month");
  const [anchor, setAnchor] = useState(() => startOf("month", new Date()));
  const [expandedDays, setExpandedDays] = useState<string[]>([]);
  const today = new Date();
  const days = useMemo(() => {
    if (mode === "week") return Array.from({ length: 7 }, (_, index) => new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + index));
    const start = new Date(anchor.getFullYear(), anchor.getMonth(), 1 - anchor.getDay());
    const weeks = Math.ceil((anchor.getDay() + new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0).getDate()) / 7);
    return Array.from({ length: weeks * 7 }, (_, index) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + index));
  }, [anchor, mode]);
  const byDay = useMemo(() => {
    const map = new Map<string, WorkItem[]>();
    for (const item of items) {
      const due = new Date(item.dueAt);
      if (Number.isNaN(due.getTime())) continue;
      const key = dayKey(due);
      map.set(key, [...(map.get(key) ?? []), item]);
    }
    return map;
  }, [items]);
  const title = mode === "month" ? new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric" }).format(anchor) : `${new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short" }).format(days[0])} – ${new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short", year: "numeric" }).format(days[6])}`;
  const shift = (step: number) => setAnchor((current) => mode === "month" ? new Date(current.getFullYear(), current.getMonth() + step, 1) : new Date(current.getFullYear(), current.getMonth(), current.getDate() + step * 7));
  const switchMode = (next: "month" | "week") => { setMode(next); setAnchor(startOf(next, new Date())); };
  return <div className="calendar-layout">
    <div className="calendar-toolbar">
      <h2>{title}</h2>
      <div className="calendar-nav">
        <button type="button" className="icon-button" onClick={() => shift(-1)} aria-label="Período anterior"><Icon name="chevron-left" size={15} /></button>
        <button type="button" className="header-button" onClick={() => setAnchor(startOf(mode, new Date()))}>Hoje</button>
        <button type="button" className="icon-button" onClick={() => shift(1)} aria-label="Próximo período"><Icon name="chevron-right" size={15} /></button>
        <div className="segmented" role="group" aria-label="Escala do calendário">
          <button type="button" aria-pressed={mode === "month"} className={mode === "month" ? "is-active" : ""} onClick={() => switchMode("month")}>Mês</button>
          <button type="button" aria-pressed={mode === "week"} className={mode === "week" ? "is-active" : ""} onClick={() => switchMode("week")}>Semana</button>
        </div>
      </div>
    </div>
    <div className={`calendar-grid calendar-${mode}`} role="grid" aria-label={`Exames por prazo — ${title}`}>
      <div className="calendar-row" role="row">
        {weekdayLabels.map((label) => <div key={label} className="calendar-weekday" role="columnheader">{label}</div>)}
      </div>
      {Array.from({ length: days.length / 7 }, (_, week) => <div key={dayKey(days[week * 7])} className="calendar-row" role="row">
        {days.slice(week * 7, week * 7 + 7).map((day) => {
          const key = dayKey(day);
          const entries = byDay.get(key) ?? [];
          const outside = mode === "month" && day.getMonth() !== anchor.getMonth();
          const isToday = key === dayKey(today);
          const limit = mode === "month" ? 3 : 12;
          const expanded = expandedDays.includes(key);
          const entriesId = `${calendarId}-${key}`;
          return <div key={day.toISOString()} role="gridcell" className={`calendar-day${outside ? " is-outside" : ""}${isToday ? " is-today" : ""}`} aria-label={`${day.toLocaleDateString("pt-BR")}: ${entries.length} exames`}>
            <span className="calendar-date">{day.getDate()}</span>
            <div id={entriesId} className="calendar-entries">
              {(expanded ? entries : entries.slice(0, limit)).map((item) => <div key={item.id} className={`calendar-entry${peekId === item.id ? " is-peeked" : ""}${item.overdue ? " is-overdue" : ""}`}>
                <StatePill item={item} role={role} onMove={onMove} showLabel={false} disabled={busy} />
                <button type="button" onClick={() => onPeek(item)} aria-label={`Abrir ${item.service.name} — ${item.patient.displayName}`}>{item.patient.displayName} · {item.service.name}</button>
              </div>)}
              {entries.length > limit && <button type="button" className="calendar-more" aria-expanded={expanded} aria-controls={entriesId} aria-label={`${expanded ? "Mostrar menos exames" : `+${entries.length - limit} exames`} em ${day.toLocaleDateString("pt-BR")}`} onClick={() => setExpandedDays((current) => current.includes(key) ? current.filter((value) => value !== key) : [...current, key])}>{expanded ? "Mostrar menos" : `+${entries.length - limit} exames`}</button>}
            </div>
          </div>;
        })}
      </div>)}
    </div>
  </div>;
}

/* ---------- Spreadsheet ---------- */

type SheetColumn = { id: string; label: string; render: (item: WorkItem) => React.ReactNode; sort?: (item: WorkItem) => string | number };

export function SpreadsheetLayout({ items, role, peekId, onPeek, onMove, busy }: { items: WorkItem[]; role: SessionRole; peekId?: string; onPeek: (item: WorkItem) => void; onMove: (item: WorkItem, target: ItemState) => void; busy: boolean }) {
  const [sort, setSort] = useState<{ column: string; direction: 1 | -1 }>();
  const columns: SheetColumn[] = [
    { id: "state", label: "Estado", render: (item) => <StatePill item={item} role={role} onMove={onMove} disabled={busy} />, sort: (item) => STATE_LABELS[item.status] },
    { id: "priority", label: "Prioridade", render: (item) => <span className="cell-inline"><PriorityIcon priority={item.priority} />{PRIORITY_LABELS[item.priority]}</span>, sort: (item) => ["EMERGENCY", "URGENT", "ROUTINE"].indexOf(item.priority) },
    { id: "patient", label: "Paciente", render: (item) => <span className="cell-stack"><strong>{item.patient.displayName}</strong><small>{item.patient.species} · {item.patient.externalId}</small></span>, sort: (item) => item.patient.displayName },
    { id: "department", label: "Setor", render: (item) => <span className="cell-inline"><DepartmentIcon code={item.departmentCode} size={13} />{departmentLabel(item.departmentCode)}</span>, sort: (item) => departmentLabel(item.departmentCode) },
    { id: "due", label: "Prazo", render: (item) => <span className={item.overdue ? "text-danger" : ""}>{item.overdue ? "Atrasado · " : ""}{formatDue(item.dueAt)}</span>, sort: (item) => Date.parse(item.dueAt) },
    { id: "next", label: "Próxima ação", render: (item) => item.nextAction ?? "—", sort: (item) => item.nextAction ?? "" },
    { id: "owner", label: "Responsável", render: (item) => item.operationalContext ? <span className="cell-inline"><Avatar name={item.operationalContext.currentOwner.label} size="xs" />{item.operationalContext.currentOwner.label}</span> : "—", sort: (item) => item.operationalContext?.currentOwner.label ?? "" },
    { id: "created", label: "Solicitado em", render: (item) => formatDateTime(item.createdAt), sort: (item) => Date.parse(item.createdAt) },
    { id: "protocol", label: "Protocolo", render: (item) => <span className="mono">{item.requestCode}</span>, sort: (item) => item.requestCode }
  ];
  const rows = useMemo(() => {
    const column = columns.find((entry) => entry.id === sort?.column);
    if (!column?.sort || !sort) return items;
    return [...items].sort((a, b) => {
      const left = column.sort!(a);
      const right = column.sort!(b);
      return (typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right), "pt-BR")) * sort.direction;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, sort]);
  return <div className="spreadsheet-layout">
    <table className="spreadsheet">
      <thead><tr>
        <th scope="col" className="sheet-sticky">Exame</th>
        {columns.map((column) => <th key={column.id} scope="col" aria-sort={sort?.column === column.id ? (sort.direction === 1 ? "ascending" : "descending") : undefined}>
          <button type="button" onClick={() => setSort((current) => current?.column === column.id ? (current.direction === 1 ? { column: column.id, direction: -1 } : undefined) : { column: column.id, direction: 1 })}>{column.label}{sort?.column === column.id && <Icon name={sort.direction === 1 ? "arrow-up" : "chevron-down"} size={12} />}</button>
        </th>)}
      </tr></thead>
      <tbody>
        {rows.map((item) => <tr key={item.id} className={`${peekId === item.id ? "is-peeked" : ""}${item.overdue ? " is-overdue" : ""}`}>
          <th scope="row" className="sheet-sticky"><span className="sheet-title"><WorkItemKey item={item} /><button type="button" onClick={() => onPeek(item)} aria-label={`Abrir ${item.service.name} — ${item.patient.displayName}`}>{workItemTitle(item)}</button></span></th>
          {columns.map((column) => <td key={column.id}>{column.render(item)}</td>)}
        </tr>)}
      </tbody>
    </table>
    {rows.length === 0 && <p className="list-empty">Nenhum exame com os filtros atuais.</p>}
  </div>;
}
