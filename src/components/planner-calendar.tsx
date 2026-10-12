"use client";

import Link from "next/link";
import { useState } from "react";
import type { HospitalTaskView } from "@cvg/contracts";
import { formatHospitalDateTime, hospitalDateKey } from "@/lib/hospital-time";

/** A civil-date calendar of planned activity starts, independent of the browser timezone. */
export function PlannerCalendar({ items }: { items: HospitalTaskView[] }) {
  const [month, setMonth] = useState(() => `${hospitalDateKey(new Date()).slice(0, 7)}-01`);
  const first = new Date(`${month}T12:00:00Z`);
  const start = new Date(first); start.setUTCDate(start.getUTCDate() - (first.getUTCDay() + 6) % 7);
  const days = Array.from({ length: 42 }, (_, offset) => { const day = new Date(start); day.setUTCDate(start.getUTCDate() + offset); return day; });
  const monthLabel = new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC", month: "long", year: "numeric" }).format(first);
  const dateLabel = (day: Date) => new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC", dateStyle: "short" }).format(day);
  const unplanned = items.filter((view) => !view.task.plannedStartAt);
  function moveMonth(delta: number) { const next = new Date(first); next.setUTCMonth(next.getUTCMonth() + delta); setMonth(next.toISOString().slice(0, 10)); }
  return <section className="calendar-layout" aria-label="Calendário de atividades planejadas"><div className="calendar-toolbar"><button type="button" onClick={() => moveMonth(-1)} aria-label="Mês anterior">Anterior</button><h2 aria-live="polite">{monthLabel}</h2><button type="button" onClick={() => moveMonth(1)} aria-label="Mês seguinte">Próximo</button></div>
    <p className="field-hint">Início planejado no horário do hospital. Este calendário não representa reservas.</p>
    <div className="calendar-grid" role="grid" aria-label={monthLabel}>
      <div className="calendar-row calendar-weekdays" role="row">{["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"].map((label) => <div role="columnheader" key={label}>{label}</div>)}</div>
      {Array.from({ length: 6 }, (_, week) => <div className="calendar-row" role="row" key={week}>{days.slice(week * 7, week * 7 + 7).map((day) => {
        const key = day.toISOString().slice(0, 10); const entries = items.filter((view) => view.task.plannedStartAt && hospitalDateKey(view.task.plannedStartAt) === key);
        return <div key={key} className={`calendar-cell${key.slice(0, 7) !== month.slice(0, 7) ? " is-outside" : ""}`} role="gridcell" aria-label={`${dateLabel(day)}: ${entries.length} atividades`}><time dateTime={key}>{day.getUTCDate()}</time><div className="calendar-entries">{entries.map((view) => <div key={view.task.id} className="calendar-entry"><Link href={`/planner/tasks/${view.task.id}`} title={`${view.task.title} · ${formatHospitalDateTime(view.task.plannedStartAt)}`}>{view.task.title}</Link></div>)}</div></div>;
      })}</div>)}
    </div>
    {unplanned.length > 0 && <section aria-label="Atividades sem data planejada"><h3>Sem data planejada · {unplanned.length}</h3><ul>{unplanned.map((view) => <li key={view.task.id}><Link href={`/planner/tasks/${view.task.id}`}>{view.task.title}</Link></li>)}</ul></section>}
  </section>;
}
