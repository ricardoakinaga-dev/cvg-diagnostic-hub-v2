"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { ItemState, Priority } from "@cvg/contracts";
import { Icon, type IconName } from "@/components/ui-icons";
import { DepartmentIcon, PriorityIcon, StateIcon } from "./icons";
import {
  DISPLAY_PROPERTY_LABELS, GROUP_BY_LABELS, ORDER_BY_LABELS, PRIORITY_LABELS, PRIORITY_ORDER, STATE_LABELS, STATE_ORDER,
  activeFilterCount, departmentLabel,
  type DisplayOptions, type DisplayProperty, type GroupBy, type OrderBy, type WorkItemFilters
} from "./model";

/** A Plane-style popover anchored to a header button. */
export function Popover({ label, icon, badge, active, align = "end", wide = false, children }: { label: string; icon?: IconName; badge?: number; active?: boolean; align?: "start" | "end"; wide?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const panelId = useId();
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); ref.current?.querySelector<HTMLButtonElement>("button")?.focus(); } return; }
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close, true);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", close, true); };
  }, [open]);
  return <div className="popover" ref={ref}>
    <button type="button" className={`header-button${active || open ? " is-active" : ""}`} aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((value) => !value)}>
      {icon && <Icon name={icon} size={14} />}<span>{label}</span>{badge ? <span className="header-button-badge">{badge}</span> : null}
    </button>
    {open && <div id={panelId} className={`dropdown popover-panel popover-${align}${wide ? " popover-wide" : ""}`} role="dialog" aria-label={label}>{children}</div>}
  </div>;
}

function Section({ title, children, defaultOpen = true }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return <section className="dropdown-section">
    <button type="button" className="dropdown-section-title" aria-expanded={open} onClick={() => setOpen((value) => !value)}><span>{title}</span><Icon name="chevron-down" size={13} /></button>
    {open && <div className="dropdown-section-body">{children}</div>}
  </section>;
}

function CheckRow({ checked, onChange, children }: { checked: boolean; onChange: () => void; children: React.ReactNode }) {
  return <label className={`check-row${checked ? " is-checked" : ""}`}><input type="checkbox" checked={checked} onChange={onChange} /><span className="check-box" aria-hidden="true">{checked && <Icon name="check" size={11} />}</span>{children}</label>;
}

function RadioRow({ checked, onChange, children, name }: { checked: boolean; onChange: () => void; children: React.ReactNode; name: string }) {
  return <label className={`check-row radio-row${checked ? " is-checked" : ""}`}><input type="radio" name={name} checked={checked} onChange={onChange} /><span className="radio-dot" aria-hidden="true" />{children}</label>;
}

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];
}

export function FiltersDropdown({ filters, onChange, departments, services, lockedDepartment }: { filters: WorkItemFilters; onChange: (next: WorkItemFilters) => void; departments: string[]; services: Array<{ code: string; name: string }>; lockedDepartment?: string }) {
  const [query, setQuery] = useState("");
  const count = activeFilterCount(filters) - (lockedDepartment ? filters.departments.filter((code) => code === lockedDepartment).length : 0);
  const term = query.trim().toLocaleLowerCase("pt-BR");
  const matches = (label: string) => !term || label.toLocaleLowerCase("pt-BR").includes(term);
  return <Popover label="Filtros" icon="filter" badge={count || undefined} active={count > 0} wide>
    <div className="dropdown-search"><Icon name="search" size={13} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar filtro" aria-label="Buscar filtro" /></div>
    <div className="dropdown-scroll">
      <Section title="Estado">
        {STATE_ORDER.filter((state) => matches(STATE_LABELS[state])).map((state: ItemState) => <CheckRow key={state} checked={filters.states.includes(state)} onChange={() => onChange({ ...filters, states: toggle(filters.states, state) })}><StateIcon state={state} />{STATE_LABELS[state]}</CheckRow>)}
      </Section>
      <Section title="Prioridade">
        {PRIORITY_ORDER.filter((priority) => matches(PRIORITY_LABELS[priority])).map((priority: Priority) => <CheckRow key={priority} checked={filters.priorities.includes(priority)} onChange={() => onChange({ ...filters, priorities: toggle(filters.priorities, priority) })}><PriorityIcon priority={priority} />{PRIORITY_LABELS[priority]}</CheckRow>)}
      </Section>
      {!lockedDepartment && departments.length > 1 && <Section title="Setor">
        {departments.filter((code) => matches(departmentLabel(code))).map((code) => <CheckRow key={code} checked={filters.departments.includes(code)} onChange={() => onChange({ ...filters, departments: toggle(filters.departments, code) })}><DepartmentIcon code={code} />{departmentLabel(code)}</CheckRow>)}
      </Section>}
      {services.length > 0 && <Section title="Exame" defaultOpen={services.length <= 8}>
        {services.filter((service) => matches(service.name)).map((service) => <CheckRow key={service.code} checked={filters.services.includes(service.code)} onChange={() => onChange({ ...filters, services: toggle(filters.services, service.code) })}><Icon name="hash" size={13} />{service.name}</CheckRow>)}
      </Section>}
      <Section title="Prazo e situação">
        <CheckRow checked={filters.overdueOnly} onChange={() => onChange({ ...filters, overdueOnly: !filters.overdueOnly })}><Icon name="clock" size={13} />Somente atrasados</CheckRow>
        <CheckRow checked={filters.hideClosed} onChange={() => onChange({ ...filters, hideClosed: !filters.hideClosed })}><Icon name="close" size={13} />Ocultar concluídos e cancelados</CheckRow>
      </Section>
    </div>
  </Popover>;
}

export function DisplayDropdown({ display, onChange }: { display: DisplayOptions; onChange: (next: DisplayOptions) => void }) {
  const groupOptions: GroupBy[] = ["status", "priority", "department", "service", "patient", "none"];
  const orderOptions: OrderBy[] = ["due", "priority", "recent", "patient"];
  const propertyOptions = Object.keys(DISPLAY_PROPERTY_LABELS) as DisplayProperty[];
  return <Popover label="Exibição" icon="sliders" wide>
    <div className="dropdown-scroll">
      <Section title="Propriedades exibidas">
        <div className="property-chips">
          {propertyOptions.map((property) => {
            const on = display.properties.includes(property);
            return <button key={property} type="button" className={`property-chip${on ? " is-on" : ""}`} aria-pressed={on} onClick={() => onChange({ ...display, properties: toggle(display.properties, property) })}>{DISPLAY_PROPERTY_LABELS[property]}</button>;
          })}
        </div>
      </Section>
      {display.layout !== "calendar" && <Section title="Agrupar por">
        {groupOptions.filter((option) => display.layout !== "board" || option !== "none").map((option) => <RadioRow key={option} name="group-by" checked={display.groupBy === option} onChange={() => onChange({ ...display, groupBy: option })}>{GROUP_BY_LABELS[option]}</RadioRow>)}
      </Section>}
      <Section title="Ordenar por">
        {orderOptions.map((option) => <RadioRow key={option} name="order-by" checked={display.orderBy === option} onChange={() => onChange({ ...display, orderBy: option })}>{ORDER_BY_LABELS[option]}</RadioRow>)}
      </Section>
      {display.layout !== "calendar" && <Section title="Opções">
        <CheckRow checked={display.showEmptyGroups} onChange={() => onChange({ ...display, showEmptyGroups: !display.showEmptyGroups })}>Mostrar grupos vazios</CheckRow>
      </Section>}
    </div>
  </Popover>;
}
