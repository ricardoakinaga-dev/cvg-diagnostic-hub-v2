"use client";

import Link from "next/link";
import { useState } from "react";
import type { HospitalSchedule, HospitalTaskView, SessionUser } from "@cvg/contracts";
import { ActionButton } from "@cvg/ui";
import { formatHospitalDateTime, hospitalDateTimeInput, hospitalDateTimeInputToIso } from "@/lib/hospital-time";
import { usePlannerCommand } from "./planner-command";
import { HospitalResourcePicker } from "./hospital-resource-picker";

export function HospitalReservationControls({ user, view, onChanged }: { user: SessionUser; view: HospitalTaskView; onChanged: () => void }) {
  const [creating, setCreating] = useState(false);
  const may = (permission: "hospital_calendar.reserve" | "hospital_calendar.reschedule" | "hospital_calendar.cancel") => user.permissions?.includes(permission) === true && view.permissions.includes(permission);
  const reservations = view.reservations ?? [];
  if (!user.permissions?.includes("hospital_calendar.view") || !view.permissions.includes("hospital_calendar.view")) return null;
  return <section className="panel" aria-label="Reservas da atividade"><h2>Reservas de recursos</h2><p className="field-hint">Planejamento, reserva e execução têm fontes distintas. Uma reserva não inicia a atividade e não muda seu prazo.</p>
    {reservations.length ? reservations.map((reservation) => <HospitalReservationEditor key={`${user.id}:${reservation.id}:${reservation.version}`} user={user} view={view} reservation={reservation} onChanged={onChanged} />) : <p>Sem reserva vigente registrada.</p>}
    {!reservations.length && view.task.phase === "PENDING" && may("hospital_calendar.reserve") && <button type="button" aria-expanded={creating} onClick={() => setCreating((value) => !value)}>Reservar recursos</button>}
    {creating && !reservations.length && view.task.phase === "PENDING" && may("hospital_calendar.reserve") && <HospitalReservationEditor user={user} view={view} onChanged={() => { setCreating(false); onChanged(); }} />}
    <Link href="/planner/agenda">Abrir agenda horária</Link>
  </section>;
}

export function HospitalReservationEditor({ user, view, reservation, onChanged }: { user: SessionUser; view: HospitalTaskView; reservation?: HospitalSchedule; onChanged: () => void }) {
  const [mode, setMode] = useState<"RESCHEDULE" | "CANCEL">(); const [start, setStart] = useState(reservation ? hospitalDateTimeInput(reservation.startsAt) : view.task.plannedStartAt ? hospitalDateTimeInput(view.task.plannedStartAt) : ""); const [end, setEnd] = useState(reservation ? hospitalDateTimeInput(reservation.endsAt) : view.task.plannedEndAt ? hospitalDateTimeInput(view.task.plannedEndAt) : ""); const [resources, setResources] = useState(reservation?.resourceIds ?? []); const [reason, setReason] = useState(""); const [inputError, setInputError] = useState(""); const command = usePlannerCommand();
  const permission = reservation ? mode === "CANCEL" ? "hospital_calendar.cancel" : "hospital_calendar.reschedule" : "hospital_calendar.reserve";
  const may = user.permissions?.includes(permission) === true && view.permissions.includes(permission) && !["COMPLETED", "CANCELLED"].includes(view.task.phase) && (mode === "CANCEL" || view.task.phase === "PENDING");
  async function save() {
    if (!may) return;
    try {
      setInputError(""); if (reservation && !reason.trim()) throw new Error("Informe o motivo da alteração da reserva.");
      const period = mode === "CANCEL" ? undefined : { startsAt: hospitalDateTimeInputToIso(start), endsAt: hospitalDateTimeInputToIso(end) };
      if (period && (period.endsAt <= period.startsAt || Date.parse(period.endsAt) - Date.parse(period.startsAt) > 86_400_000 || !resources.length)) throw new Error("Selecione recursos e um intervalo válido de até 24 horas.");
      const result = await command.execute<HospitalSchedule | { schedule: HospitalSchedule }>(reservation ? `/hospital-reservations/${encodeURIComponent(reservation.id)}/${mode === "CANCEL" ? "cancel" : "reschedule"}` : `/hospital-tasks/${encodeURIComponent(view.task.id)}/reservations`, "POST", { ...(period ? { ...period, resourceIds: resources } : {}), ...(reservation ? { reason: reason.trim() } : {}), expectedVersion: reservation?.version ?? view.task.version }); if (result) onChanged();
    } catch (cause) { setInputError(cause instanceof Error ? cause.message : "Revise o intervalo da reserva."); }
  }
  return <div>{reservation && <><p>Reserva vigente: {formatHospitalDateTime(reservation.startsAt)} até {formatHospitalDateTime(reservation.endsAt)}</p><p>Recursos: {reservation.resourceSnapshots?.map((snapshot) => snapshot.name).join(" / ") || reservation.resource}</p>{view.task.phase === "PENDING" && user.permissions?.includes("hospital_calendar.reschedule") && view.permissions.includes("hospital_calendar.reschedule") && <button type="button" onClick={() => setMode("RESCHEDULE")}>Remarcar reserva</button>}{!["COMPLETED", "CANCELLED"].includes(view.task.phase) && user.permissions?.includes("hospital_calendar.cancel") && view.permissions.includes("hospital_calendar.cancel") && <button type="button" onClick={() => setMode("CANCEL")}>Cancelar reserva</button>}</>}
    {(!reservation || mode) && may && <form aria-label={reservation ? mode === "CANCEL" ? "Cancelar reserva da atividade" : "Remarcar reserva da atividade" : "Reservar recursos da atividade"} onSubmit={(event) => { event.preventDefault(); void save(); }}>
      {mode !== "CANCEL" && <><label>Início da reserva<input type="datetime-local" required value={start} onChange={(event) => setStart(event.target.value)} /></label><label>Fim da reserva<input type="datetime-local" required value={end} onChange={(event) => setEnd(event.target.value)} /></label><HospitalResourcePicker userId={user.id} departmentCode={view.task.departmentCode} selectedIds={resources} onChange={setResources} snapshots={reservation?.resourceSnapshots} canConfigure={user.permissions?.includes("hospital_resource.create")} /></>}
      {reservation && <label>Motivo da reserva<textarea required maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} /></label>}{(inputError || command.error) && <p role="alert">{inputError || command.error}</p>}<ActionButton type="submit" state={command.busy ? "pending" : "idle"}>{reservation ? mode === "CANCEL" ? "Confirmar cancelamento da reserva" : "Confirmar remarcação" : "Confirmar reserva"}</ActionButton>{reservation && <button type="button" disabled={command.busy} onClick={() => setMode(undefined)}>Voltar sem alterar reserva</button>}
    </form>}
  </div>;
}
