"use client";

import Link from "next/link";
import type { HospitalTaskView, PlannerViewDisplay, SessionUser } from "@cvg/contracts";
import { formatHospitalDateTime } from "@/lib/hospital-time";
import { PlannerInlineEdit } from "./planner-inline-edit";
import { PlannerCalendar } from "./planner-calendar";
import { COLUMN_LABELS, PHASE_LABELS } from "./planner-model";

const priorityLabel = { ROUTINE: "Rotina", URGENT: "Urgente", EMERGENCY: "Emergência" };
const ownerName = (view: HospitalTaskView) => view.eligibleAssignees.find((entry) => entry.id === view.task.responsibleUserId)?.displayName ?? (view.task.responsibleUserId ? "Responsável atribuído" : "Sem responsável");
export function PlannerTaskLayouts({ items, display, departmentNames, user, readOnly = false, onChanged }: { user?: SessionUser; readOnly?: boolean; onChanged?: () => void; items: HospitalTaskView[]; display: PlannerViewDisplay; departmentNames: Record<string, string> }) {
  function cell(view: HospitalTaskView, column: PlannerViewDisplay["columns"][number]) {
    const { task } = view;
    if (column === "title") return <Link href={`/planner/tasks/${encodeURIComponent(task.id)}`}>{task.title}</Link>;
    if (column === "department") return departmentNames[task.departmentCode] ?? task.departmentCode;
    if (column === "responsible") return ownerName(view);
    if (column === "type") return task.typeSnapshot.name;
    if (column === "priority") return priorityLabel[task.priority];
    if (column === "phase") return task.typeSnapshot.states.find((state) => state.code === task.status)?.label ?? PHASE_LABELS[task.phase];
    return formatHospitalDateTime(column === "plannedStart" ? task.plannedStartAt : column === "plannedEnd" ? task.plannedEndAt : task.updatedAt);
  }
  function card(view: HospitalTaskView) {
    return <article className="board-card" key={view.task.id}><small>Atividade hospitalar · {view.task.taskCode}</small><h3><Link href={`/planner/tasks/${encodeURIComponent(view.task.id)}`}>{view.task.title}</Link></h3>
      {view.patient && <p><Link href={`/patients/${encodeURIComponent(view.patient.id)}/diagnostics`}>{view.patient.displayName} · {view.patient.externalId}</Link> · tutor {view.patient.ownerLabel}</p>}
      <dl>{display.columns.filter((column) => column !== "title").map((column) => <div key={column}><dt>{COLUMN_LABELS[column]}</dt><dd>{cell(view, column)}</dd></div>)}</dl>
    </article>;
  }
  if (display.layout === "TABLE") return <div className="queue-table-wrap"><table className="queue-table"><caption>Atividades hospitalares autorizadas</caption><thead><tr>{display.columns.map((column) => <th key={column} scope="col">{COLUMN_LABELS[column]}</th>)}{user && onChanged && <th scope="col">Edição autorizada</th>}</tr></thead><tbody>{items.map((view) => <tr key={view.task.id}>{display.columns.map((column) => <td key={column}>{cell(view, column)}</td>)}{user && onChanged && <td><PlannerInlineEdit user={user} view={view} disabled={readOnly} onChanged={onChanged} /></td>}</tr>)}</tbody></table></div>;
  if (display.layout === "CALENDAR") return <PlannerCalendar items={items} />;
  const groups = new Map<string, HospitalTaskView[]>();
  if (display.layout === "BOARD" && ["NONE", "PHASE"].includes(display.groupBy)) for (const phase of Object.keys(PHASE_LABELS)) groups.set(PHASE_LABELS[phase as keyof typeof PHASE_LABELS], []);
  for (const view of items) {
    const key = display.groupBy === "DEPARTMENT" ? departmentNames[view.task.departmentCode] ?? view.task.departmentCode
        : display.groupBy === "RESPONSIBLE" ? ownerName(view)
          : display.groupBy === "TYPE" ? view.task.typeSnapshot.name
            : display.groupBy === "PHASE" || display.layout === "BOARD" ? PHASE_LABELS[view.task.phase] : "Atividades";
    groups.set(key, [...(groups.get(key) ?? []), view]);
  }
  const entries = [...groups];
  return <div className={display.layout === "BOARD" ? "board-layout" : "list-layout"} aria-label={display.layout === "BOARD" ? "Quadro de atividades hospitalares" : "Lista de atividades hospitalares"}>
    {entries.map(([label, views]) => <section key={label} className={display.layout === "BOARD" ? "board-column" : "list-group"} aria-label={label}><header className="list-group-header"><h2>{label}</h2><span className="group-count">{views.length}</span></header><div className="board-cards">{views.map(card)}</div>{!views.length && <p className="list-empty">Nenhuma atividade neste grupo.</p>}</section>)}
  </div>;
}
