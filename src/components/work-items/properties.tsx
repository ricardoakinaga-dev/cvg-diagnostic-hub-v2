"use client";

import { useEffect, useRef, useState } from "react";
import { ITEM_STATES, type ItemState, type SessionRole } from "@cvg/contracts";
import { Icon } from "@/components/ui-icons";
import { actionLabel, canUseWorkflowAction, workflowActionFor, workflowActionForTransition, type WorkflowActionKind } from "@/components/workflow-action";
import { Avatar, DepartmentIcon, PriorityIcon, StateIcon } from "./icons";
import { PRIORITY_LABELS, STATE_LABELS, STATE_ORDER, departmentLabel, formatDue, workItemKey, type DisplayProperty, type WorkItem } from "./model";

export interface Transition { target: ItemState; action: WorkflowActionKind }

export function allowedTransitions(item: WorkItem, role: SessionRole): Transition[] {
  return ITEM_STATES.flatMap((target) => {
    const action = workflowActionForTransition(item, target);
    return action && canUseWorkflowAction(role, action, item) ? [{ target, action }] : [];
  }).sort((a, b) => STATE_ORDER.indexOf(a.target) - STATE_ORDER.indexOf(b.target));
}

/** Plane's state pill: shows the state and opens the allowed transitions. */
export function StatePill({ item, role, onMove, showLabel = true, disabled = false }: { item: WorkItem; role: SessionRole; onMove: (item: WorkItem, target: ItemState) => void; showLabel?: boolean; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const transitions = allowedTransitions(item, role);
  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); ref.current?.querySelector<HTMLButtonElement>("button")?.focus(); } return; }
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close, true);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", close, true); };
  }, [open]);
  const canOpen = transitions.length > 0 && !disabled;
  return <div className="pill-menu" ref={ref} onClick={(event) => event.stopPropagation()}>
    <button type="button" className={`pill${canOpen ? " pill-interactive" : ""}`} aria-haspopup={canOpen ? "menu" : undefined} aria-expanded={canOpen ? open : undefined} disabled={!canOpen} onClick={() => setOpen((value) => !value)} onKeyDown={(event) => { if (canOpen && !open && ["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); setOpen(true); } }} aria-label={`Estado: ${STATE_LABELS[item.status]}${canOpen ? ". Mudar estado" : ""}`} title={STATE_LABELS[item.status]}>
      <StateIcon state={item.status} />{showLabel && <span>{STATE_LABELS[item.status]}</span>}
    </button>
    {open && <div className="dropdown pill-dropdown" role="menu" aria-label={`Mover ${item.service.name} de ${item.patient.displayName}`} onKeyDown={(event) => {
      const entries = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[role=menuitem]"));
      if (event.key === "Tab") { setOpen(false); ref.current?.querySelector<HTMLButtonElement>("button")?.focus(); return; }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const index = entries.indexOf(document.activeElement as HTMLElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? entries.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + entries.length) % entries.length;
      entries[next]?.focus();
    }}>
      <div className="dropdown-caption">Mover para</div>
      <div className="dropdown-item is-current" aria-disabled="true"><StateIcon state={item.status} />{STATE_LABELS[item.status]}<Icon name="check" size={13} className="dropdown-check" /></div>
      {transitions.map(({ target }) => <button key={target} role="menuitem" type="button" className="dropdown-item" onClick={() => { ref.current?.querySelector<HTMLButtonElement>("button")?.focus(); setOpen(false); onMove(item, target); }}><StateIcon state={target} />{STATE_LABELS[target]}</button>)}
    </div>}
  </div>;
}

export function WorkItemProperties({ item, role, properties, onMove, disabled }: { item: WorkItem; role: SessionRole; properties: DisplayProperty[]; onMove: (item: WorkItem, target: ItemState) => void; disabled?: boolean }) {
  const show = (property: DisplayProperty) => properties.includes(property);
  const owner = item.operationalContext?.currentOwner.label;
  return <div className="properties">
    {show("state") && <StatePill item={item} role={role} onMove={onMove} disabled={disabled} />}
    {show("priority") && <span className={`pill pill-icon priority-pill priority-pill-${item.priority.toLowerCase()}`} title={`Prioridade: ${PRIORITY_LABELS[item.priority]}`}><PriorityIcon priority={item.priority} />{item.priority !== "ROUTINE" ? <span>{PRIORITY_LABELS[item.priority]}</span> : <span className="sr-only">Prioridade: {PRIORITY_LABELS[item.priority]}</span>}</span>}
    {show("patient") && <span className="pill" title={`${item.patient.displayName} · ${item.patient.species}`}><Icon name="paw" size={12} /><span>{item.patient.species}</span></span>}
    {show("department") && <span className="pill" title={departmentLabel(item.departmentCode)}><DepartmentIcon code={item.departmentCode} size={12} /><span>{departmentLabel(item.departmentCode)}</span></span>}
    {show("due") && <span className={`pill${item.overdue ? " pill-danger" : ""}`} title={item.overdue ? "Prazo vencido" : "Prazo"}><Icon name="calendar" size={12} /><span>{item.overdue ? `Atrasado · ${formatDue(item.dueAt)}` : formatDue(item.dueAt)}</span></span>}
    {show("nextAction") && item.nextAction && <span className="pill pill-muted" title="Próxima ação"><Icon name="arrow-right" size={12} /><span>{item.nextAction}</span></span>}
    {show("owner") && owner && <span className="pill pill-owner" title={`Responsável: ${owner}`}><Avatar name={owner} size="xs" /><span>{owner.split(" · ")[0]}</span></span>}
  </div>;
}

export function WorkItemKey({ item }: { item: WorkItem }) {
  return <span className="work-item-key" title={`Protocolo ${item.requestCode}`}>{workItemKey(item)}</span>;
}

/**
 * The next clinical step as one button on the row or card, so the most common
 * action (receive, start, release) stays a single interaction.
 */
export function nextActions(item: WorkItem, role: SessionRole): WorkflowActionKind[] {
  const primary = workflowActionFor(item);
  const actions: WorkflowActionKind[] = [];
  if (primary && primary !== "REVIEW_RESULT" && primary !== "EDIT_RESULT" && canUseWorkflowAction(role, primary, item)) actions.push(primary);
  if (primary !== "RELEASE_RESULT" && item.currentResultId && workflowActionForTransition(item, "RESULT_AVAILABLE") === "RELEASE_RESULT" && canUseWorkflowAction(role, "RELEASE_RESULT", item)) actions.push("RELEASE_RESULT");
  return actions;
}

export function NextActionButtons({ item, role, onAction, disabled }: { item: WorkItem; role: SessionRole; onAction: (item: WorkItem, action: WorkflowActionKind) => void; disabled?: boolean }) {
  const actions = nextActions(item, role);
  if (!actions.length) return null;
  return <span className="next-actions" onClick={(event) => event.stopPropagation()}>
    {actions.map((action) => <button key={action} type="button" className="next-action-button" disabled={disabled} onClick={() => onAction(item, action)}>{actionLabel[action]}</button>)}
  </span>;
}
