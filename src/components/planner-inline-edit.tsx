"use client";

import { useState } from "react";
import type { HospitalTaskView, SessionUser } from "@cvg/contracts";
import { ActionButton } from "@cvg/ui";
import { hospitalDateTimeInput, hospitalDateTimeInputToIso } from "@/lib/hospital-time";
import { usePlannerCommand } from "./planner-command";

export function PlannerInlineEdit({ user, view, disabled = false, onChanged }: { user: SessionUser; view: HospitalTaskView; disabled?: boolean; onChanged: () => void }) {
  const may = !disabled && !view.task.archivedAt && !view.task.isDraft && user.permissions?.includes("hospital_task.update") === true && view.permissions.includes("hospital_task.update");
  if (!may) return null;
  return <details><summary>Editar título e datas</summary><InlineEditForm key={`${user.id}:${view.task.id}`} view={view} disabled={disabled} onChanged={onChanged} /></details>;
}
function InlineEditForm({ view, disabled, onChanged }: { view: HospitalTaskView; disabled: boolean; onChanged: () => void }) {
  const [baseVersion, setBaseVersion] = useState(view.task.version); const conflict = view.task.version > baseVersion;
  const [title, setTitle] = useState(view.task.title); const [start, setStart] = useState(view.task.plannedStartAt ? hospitalDateTimeInput(view.task.plannedStartAt) : ""); const [end, setEnd] = useState(view.task.plannedEndAt ? hospitalDateTimeInput(view.task.plannedEndAt) : ""); const [error, setError] = useState(""); const command = usePlannerCommand();
  return <form aria-label={`Editar planejamento de ${view.task.taskCode}`} onSubmit={(event) => { event.preventDefault(); if (disabled || conflict) return; try { const plannedStartAt = start ? hospitalDateTimeInputToIso(start) : null; const plannedEndAt = end ? hospitalDateTimeInputToIso(end) : null; if (plannedStartAt && plannedEndAt && Date.parse(plannedStartAt) > Date.parse(plannedEndAt)) throw new Error("O fim não pode anteceder o início."); setError(""); void command.execute<HospitalTaskView>(`/hospital-tasks/${view.task.id}`, "PATCH", { title: title.trim(), plannedStartAt, plannedEndAt, expectedVersion: baseVersion }).then((result) => { if (result) { setBaseVersion(result.task.version); onChanged(); } }); } catch (cause) { setError(cause instanceof Error ? cause.message : "Datas inválidas."); } }}><>{conflict && <p role="alert">Outra alteração mudou a versão. Seu texto permanece; <button type="button" onClick={() => { setTitle(view.task.title); setStart(view.task.plannedStartAt ? hospitalDateTimeInput(view.task.plannedStartAt) : ""); setEnd(view.task.plannedEndAt ? hospitalDateTimeInput(view.task.plannedEndAt) : ""); setBaseVersion(view.task.version); }}>Recarregar células e descartar meu texto</button></p>}<fieldset disabled={disabled || conflict || command.busy}><legend>Alterações no horário do hospital · versão {view.task.version}</legend><label>Título editável<input required maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} /></label><label>Início editável<input type="datetime-local" value={start} onChange={(event) => setStart(event.target.value)} /></label><label>Fim editável<input type="datetime-local" value={end} onChange={(event) => setEnd(event.target.value)} /></label><p>Não modifica estado, prazo diagnóstico ou reserva de recurso.</p><ActionButton type="submit" state={command.busy ? "pending" : "idle"}>Salvar células alteradas</ActionButton></fieldset>{(error || command.error) && <p role="alert">{error || command.error} Suas alterações permanecem até você reconciliar a versão na visão.</p>}</></form>;
}
