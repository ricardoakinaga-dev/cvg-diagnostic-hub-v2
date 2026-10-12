"use client";

import { useEffect, useState } from "react";
import type { DiagnosticPlanning, ItemState, Permission, Priority, SessionUser } from "@cvg/contracts";
import { ActionButton } from "@cvg/ui";
import { formatHospitalDateTime, hospitalDateTimeInput, hospitalDateTimeInputToIso } from "@/lib/hospital-time";
import { apiFetch, getSafeErrorMessage } from "./api-client";
import { usePlannerCommand } from "./planner-command";

type PlanningItem = DiagnosticPlanning & { id: string; version: number; status: ItemState; priority: Priority; dueAt: string };
type Assignee = { id: string; displayName: string; departmentCode: string };
const terminal = new Set<ItemState>(["COMPLETED", "CANCELLED", "REJECTED", "FAILED", "RESULT_VOIDED"]);

export function DiagnosticPlanningControls({ item, user, onChanged }: { item: PlanningItem; user?: SessionUser; onChanged: () => void }) {
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [directoryError, setDirectoryError] = useState("");
  const [directoryLoaded, setDirectoryLoaded] = useState(false);
  const [responsible, setResponsible] = useState(item.assignedUserId ?? "");
  const [startsAt, setStartsAt] = useState(item.plannedStartsAt ? hospitalDateTimeInput(item.plannedStartsAt) : "");
  const [endsAt, setEndsAt] = useState(item.plannedEndsAt ? hospitalDateTimeInput(item.plannedEndsAt) : "");
  const [priority, setPriority] = useState(item.priority);
  const [reason, setReason] = useState("");
  const [inputError, setInputError] = useState("");
  const command = usePlannerCommand();
  const may = (permission: Permission) => Boolean(user?.permissions?.includes(permission) && !terminal.has(item.status));
  const canAssign = may("item.assignment.update");
  const manager = user?.role === "MANAGER" || user?.role === "SUPERADMIN";
  const canPlan = may("item.plan.update") && (manager || item.assignedUserId === user?.id);
  const canPrioritize = may("item.priority.update");
  useEffect(() => {
    if (!canAssign) return;
    const controller = new AbortController();
    void apiFetch<Assignee[]>(`/diagnostic-items/${item.id}/assignees`, { signal: controller.signal }).then((users) => {
      if (!controller.signal.aborted) { setAssignees(users); setDirectoryLoaded(true); setDirectoryError(""); }
    }).catch((cause: unknown) => { if (!controller.signal.aborted) { setAssignees([]); setDirectoryLoaded(false); setDirectoryError(getSafeErrorMessage(cause, "Não foi possível consultar os profissionais elegíveis.")); } });
    return () => controller.abort();
  }, [item.id, item.version, canAssign, user?.id]);
  async function save(action: "assignment" | "planning" | "priority", body: object) {
    setInputError("");
    if (!may(action === "assignment" ? "item.assignment.update" : action === "planning" ? "item.plan.update" : "item.priority.update")) return;
    if (await command.execute(`/diagnostic-items/${item.id}/${action}`, "PUT", { ...body, expectedVersion: item.version })) onChanged();
  }
  async function saveDates() {
    if (!canPlan) return;
    try {
      if (Boolean(startsAt) !== Boolean(endsAt)) throw new Error("Informe início e fim ou remova ambos.");
      const plannedStartsAt = startsAt ? hospitalDateTimeInputToIso(startsAt) : null;
      const plannedEndsAt = endsAt ? hospitalDateTimeInputToIso(endsAt) : null;
      if (plannedStartsAt && plannedEndsAt && Date.parse(plannedStartsAt) >= Date.parse(plannedEndsAt)) throw new Error("O fim deve ocorrer depois do início.");
      await save("planning", { plannedStartsAt, plannedEndsAt });
    } catch (cause) { setInputError(cause instanceof Error ? cause.message : "Revise as datas."); }
  }
  return <section className="peek-section" aria-label="Planejamento do exame"><h3>Planejamento do exame</h3>
    <p>Responsável: {assignees.find((entry) => entry.id === item.assignedUserId)?.displayName ?? (item.assignedUserId ? "Profissional atribuído" : "Sem responsável")}</p>
    <p>Início planejado: {formatHospitalDateTime(item.plannedStartsAt)} · fim: {formatHospitalDateTime(item.plannedEndsAt)}</p>
    <p className="field-hint">Planejamento não reserva recursos. O prazo clínico é {formatHospitalDateTime(item.dueAt)}.</p>
    {canAssign && user && directoryLoaded && assignees.some((entry) => entry.id === user.id) && !item.assignedUserId && <ActionButton tone="ghost" state={command.busy ? "pending" : "idle"} onClick={() => void save("assignment", { userId: user.id })}>Assumir exame</ActionButton>}
    {canAssign && manager && <form aria-label="Atribuir exame" onSubmit={(event) => { event.preventDefault(); void save("assignment", { userId: responsible || null }); }}><label>Profissional responsável<select value={responsible} disabled={!directoryLoaded || command.busy} onChange={(event) => setResponsible(event.target.value)}><option value="">Sem responsável</option>{assignees.map((entry) => <option key={entry.id} value={entry.id}>{entry.displayName}</option>)}{responsible && !assignees.some((entry) => entry.id === responsible) && <option value={responsible} disabled>Atribuição existente indisponível</option>}</select></label><ActionButton type="submit" tone="ghost" disabled={!directoryLoaded} state={command.busy ? "pending" : "idle"}>Salvar atribuição</ActionButton></form>}
    {directoryError && <p role="alert">{directoryError}</p>}
    {canPlan && <form aria-label="Planejar exame" onSubmit={(event) => { event.preventDefault(); void saveDates(); }}><label>Início planejado<input type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} /></label><label>Fim planejado<input type="datetime-local" value={endsAt} onChange={(event) => setEndsAt(event.target.value)} /></label><p className="field-hint">Datas no horário do hospital. Deixe ambos vazios para remover o planejamento.</p><ActionButton type="submit" tone="ghost" state={command.busy ? "pending" : "idle"}>Salvar planejamento</ActionButton></form>}
    {canPrioritize && <form aria-label="Reclassificar prioridade do exame" onSubmit={(event) => { event.preventDefault(); if (reason.trim()) void save("priority", { priority, reason: reason.trim() }); }}><label>Prioridade do exame<select value={priority} onChange={(event) => setPriority(event.target.value as Priority)}><option value="ROUTINE">Rotina</option><option value="URGENT">Urgente</option><option value="EMERGENCY">Emergência</option></select></label><label>Motivo da reclassificação<textarea value={reason} onChange={(event) => setReason(event.target.value)} required maxLength={500} /></label><p className="field-hint">O prazo usa o início e a política originais do exame; a criticidade do laudo permanece independente.</p><ActionButton type="submit" tone="ghost" state={command.busy ? "pending" : "idle"}>Reclassificar exame</ActionButton></form>}
    {(inputError || command.error) && <p role="alert" className="form-alert">{inputError || command.error}</p>}
  </section>;
}
