"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { ITEM_STATES, type ItemState, type OperationalContext, type QueueItem, type SessionRole } from "@cvg/contracts";
import { ActionButton } from "@cvg/ui";
import { formatRelativeTime, getSafeErrorMessage } from "./api-client";
import { PriorityBadge, StatusBadge } from "./status-badge";
import { actionLabel, canUseWorkflowAction, executeSimpleWorkflowAction, WorkflowAction, WorkflowInputError, workflowActionFor, workflowActionForTransition, type WorkflowActionKind } from "./workflow-action";
import { QueueBoardQuickAdd } from "./queue-board-quick-add";
import { useDialogFocus } from "./use-dialog-focus";

export const queueColumnLabels: Record<ItemState, string> = {
  REQUESTED: "Solicitado", RECEIVED: "Amostra recebida", SCHEDULED: "Agendado", IN_PROGRESS: "Em execução", AWAITING_REPORT: "Aguardando laudo", RESULT_AVAILABLE: "Resultado disponível", REVIEWED: "Revisado", COMPLETED: "Concluído", RECOLLECTION_REQUIRED: "Recoleta necessária", FAILED: "Falha", CANCELLED: "Cancelado", REJECTED: "Rejeitado", RESULT_VOIDED: "Resultado invalidado"
};

const directActions: WorkflowActionKind[] = ["START_PROCESSING", "START_PROCEDURE", "MARK_PERFORMED", "RELEASE_RESULT", "COMPLETE"];
const escalationLabels: Record<OperationalContext["escalationLevel"], string> = { NONE: "No prazo", WATCH: "Acompanhar", ATTENTION: "Atenção", URGENT: "Urgente" };

function formatOptionalDate(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "Não informado";
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

export function QueueBoard({ items, role, departments, refreshing, onComplete }: { items: QueueItem[]; role: SessionRole; departments: string[]; refreshing: boolean; onComplete: () => void }) {
  const [peek, setPeek] = useState<{ id: string; action?: WorkflowActionKind }>();
  const [pendingId, setPendingId] = useState<string>();
  const pendingRef = useRef(false);
  const draggedId = useRef<string | undefined>(undefined);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const selected = items.find((item) => item.id === peek?.id);
  const closePeek = () => setPeek(undefined);
  const columns = ITEM_STATES.filter((state) => ["REQUESTED", "IN_PROGRESS", "RESULT_AVAILABLE", "CANCELLED", "REJECTED"].includes(state) || items.some((item) => item.status === state || Boolean(workflowActionForTransition(item, state))) || ((departments.includes("LABORATORY") || items.some((item) => item.workflowType === "LABORATORY")) && ["RECEIVED", "RECOLLECTION_REQUIRED"].includes(state)) || ((departments.some((department) => ["RADIOLOGY", "ULTRASOUND"].includes(department)) || items.some((item) => item.workflowType !== "LABORATORY")) && ["SCHEDULED", "AWAITING_REPORT"].includes(state)));

  async function run(item: QueueItem, action: WorkflowActionKind, opener?: HTMLElement) {
    if (pendingRef.current || refreshing) return;
    setError("");
    setNotice("");
    if (!canUseWorkflowAction(role, action, item)) { setError("Seu perfil não permite esta ação."); return; }
    if (!directActions.includes(action)) {
      opener?.focus();
      setPeek({ id: item.id, action: action === "REVIEW_RESULT" || action === "EDIT_RESULT" ? undefined : action });
      return;
    }
    pendingRef.current = true;
    setPendingId(item.id);
    try {
      await executeSimpleWorkflowAction(item, action);
      setNotice(`${actionLabel[action]}: confirmado pelo servidor.`);
      onComplete();
    } catch (cause) {
      setError(cause instanceof WorkflowInputError ? cause.message : getSafeErrorMessage(cause, "Não foi possível mover o exame. Atualize a fila e tente novamente."));
    } finally {
      pendingRef.current = false;
      setPendingId(undefined);
    }
  }

  function move(item: QueueItem, target: ItemState, opener?: HTMLElement) {
    if (target === item.status) return;
    const action = workflowActionForTransition(item, target);
    if (!action) { setError("Esta mudança não é permitida no fluxo do exame. Use a próxima ação disponível."); return; }
    void run(item, action, opener);
  }

  return <>
    {error && <p className="form-alert" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {!refreshing && items.length === 0 && <p className="queue-board-empty" role="status">Nenhum item nesta fila. Ajuste os filtros ou adicione um exame em Solicitado.</p>}
    <div className="queue-board" aria-label="Fila de exames por estado">
      {columns.map((state) => <section key={state} className="queue-board-column" aria-label={queueColumnLabels[state]} onDragOver={(event) => { if (draggedId.current && !pendingRef.current && !refreshing) event.preventDefault(); }} onDrop={(event) => {
        event.preventDefault();
        const id = draggedId.current;
        draggedId.current = undefined;
        const item = items.find((entry) => entry.id === id);
        if (item) move(item, state);
      }}>
        <header><h2>{queueColumnLabels[state]}</h2><small aria-label={`${items.filter((item) => item.status === state).length} exames`}>{items.filter((item) => item.status === state).length}</small></header>
        <div role="list" aria-label={`Exames: ${queueColumnLabels[state]}`}>
          {items.filter((item) => item.status === state).map((item) => {
            const primary = workflowActionFor(item);
            const actions = ITEM_STATES.flatMap((target) => { const action = workflowActionForTransition(item, target); return action && canUseWorkflowAction(role, action, item) ? [{ target, action }] : []; });
            return <article key={item.id} role="listitem" className={`queue-card queue-board-card${item.overdue ? " queue-card-overdue" : ""}`} draggable={!refreshing && !pendingId && actions.length > 0} onClick={(event) => {
              if (event.target instanceof Element && event.target.closest("button, a, input, select, textarea, label")) return;
              event.currentTarget.querySelector<HTMLElement>("button")?.focus();
              setPeek({ id: item.id });
            }} onDragStart={(event) => { draggedId.current = item.id; event.currentTarget.querySelector<HTMLElement>("button")?.focus(); event.dataTransfer.setData("text/plain", item.id); event.dataTransfer.effectAllowed = "move"; }} onDragEnd={() => { draggedId.current = undefined; }}>
              <button className="queue-card-patient" type="button" onClick={(event) => { event.currentTarget.focus(); setPeek({ id: item.id }); }} aria-label={`Abrir contexto de ${item.service.name} — ${item.patient.displayName}`}><span><strong>{item.patient.displayName}</strong><small>{item.service.name} · {item.requestCode}</small></span></button>
              <div className="queue-board-card-signals"><PriorityBadge priority={item.priority} /><StatusBadge status={item.status} /></div>
              <p className={item.overdue ? "text-danger" : ""}>{item.overdue ? "Atrasado" : formatRelativeTime(item.dueAt)}</p>
              <p>{item.nextAction}</p>
              {primary && canUseWorkflowAction(role, primary, item) && <ActionButton disabled={Boolean(pendingId) || refreshing} state={pendingId === item.id ? "pending" : "idle"} onClick={(event) => void run(item, primary, event.currentTarget)}>{actionLabel[primary]}</ActionButton>}
              {primary !== "RELEASE_RESULT" && actions.some(({ action }) => action === "RELEASE_RESULT") && <ActionButton disabled={Boolean(pendingId) || refreshing} state={pendingId === item.id ? "pending" : "idle"} onClick={() => void run(item, "RELEASE_RESULT")}>Liberar resultado</ActionButton>}
              <label className="queue-board-move"><span>Mover exame</span><select className="queue-board-move-select" aria-label={`Mover ${item.service.name} de ${item.patient.displayName}`} value="" disabled={Boolean(pendingId) || refreshing || actions.length === 0} onChange={(event) => move(item, event.target.value as ItemState, event.currentTarget)}><option value="">Escolha o estado…</option>{actions.map(({ target }) => <option key={target} value={target}>{queueColumnLabels[target]}</option>)}</select></label>
            </article>;
          })}
        </div>
        {state === "REQUESTED" && ["MANAGER", "VETERINARIAN", "VET", "INPATIENT_TEAM"].includes(role) && <QueueBoardQuickAdd departments={role === "MANAGER" ? departments : []} refreshing={refreshing} onCreated={onComplete} disabled={refreshing || Boolean(pendingId)} />}
      </section>)}
    </div>
    {selected && <QueuePeek key={`${selected.id}:${peek?.action ?? "context"}`} item={selected} role={role} initialAction={peek?.action} onClose={closePeek} onComplete={() => { closePeek(); onComplete(); }} onDraftCreated={onComplete} />}
  </>;
}

function QueuePeek({ item, role, initialAction, onClose, onComplete, onDraftCreated }: { item: QueueItem; role: SessionRole; initialAction?: WorkflowActionKind; onClose: () => void; onComplete: () => void; onDraftCreated: () => void }) {
  const drawerRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [action, setAction] = useState(initialAction);
  const operation = item.operationalContext;
  useDialogFocus(drawerRef, onClose, closeRef);
  return <div className="drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><aside ref={drawerRef} className="context-drawer" role="dialog" aria-modal="true" aria-labelledby="queue-peek-title">
    <div className="drawer-heading"><h2 id="queue-peek-title">{item.service.name}</h2><button ref={closeRef} type="button" onClick={onClose} aria-label="Fechar contexto">Fechar</button></div>
    <p>{item.patient.displayName} · {item.patient.species} · {item.patient.externalId}</p><p>{item.requestCode}</p>
    <StatusBadge status={item.status} /><PriorityBadge priority={item.priority} />
    <dl className="operation-context-list"><div><dt>Responsável atual</dt><dd>{operation.currentOwner.label}</dd></div><div><dt>Próxima ação</dt><dd>{operation.nextAction.label}</dd></div><div><dt>Bloqueado por</dt><dd>{operation.blockedBy?.label ?? "Sem bloqueio registrado"}</dd></div><div><dt>Aguardando desde</dt><dd>{formatOptionalDate(operation.waitingSince)}</dd></div><div><dt>Prazo esperado</dt><dd className={item.overdue ? "text-danger" : ""}>{formatOptionalDate(operation.expectedBy ?? item.dueAt)}</dd></div><div><dt>Escalonamento operacional</dt><dd><span className={`escalation-badge escalation-${operation.escalationLevel.toLowerCase()}`}>{escalationLabels[operation.escalationLevel]}</span></dd></div></dl>
    <WorkflowAction key={action ?? "context"} item={item} initialAction={action} role={role} onComplete={onComplete} onDraftCreated={onDraftCreated} />
    {!action && item.currentResultId && ["RESULT_AVAILABLE", "REVIEWED", "COMPLETED"].includes(item.status) && canUseWorkflowAction(role, "AMEND", item) && <button type="button" className="button button-ghost" onClick={() => setAction("AMEND")}>Emendar resultado</button>}
    <Link className="button button-ghost" href={`/requests/${item.requestId}#${item.id}`}>Abrir workspace completo</Link>
  </aside></div>;
}
