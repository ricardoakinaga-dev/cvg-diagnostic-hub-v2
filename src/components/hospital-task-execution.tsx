"use client";

import { useState } from "react";
import type { HospitalChecklistStep, HospitalTaskView, SessionUser } from "@cvg/contracts";
import { ActionButton } from "@cvg/ui";
import { formatHospitalDateTime } from "@/lib/hospital-time";
import { usePlannerCommand } from "./planner-command";

export function HospitalTaskExecution({ user, view, readOnly = false, onSaved }: { user: SessionUser; view: HospitalTaskView; readOnly?: boolean; onSaved: (view: HospitalTaskView) => void }) {
  const snapshot = view.task.checklistSnapshot;
  if (!snapshot) return null;
  const mayExecute = !readOnly && user.permissions?.includes("checklist.execute") === true && view.permissions.includes("checklist.execute") && !["COMPLETED", "CANCELLED"].includes(view.task.phase);
  return <><section className="panel" aria-label="Checklist da atividade"><h2>{snapshot.name}</h2><p>Versão aprovada {snapshot.templateVersion} · aprovação em {formatHospitalDateTime(snapshot.approvedAt)}. Alterações no modelo não reescrevem esta execução.</p><p className="field-hint">Registrar etapas não libera laudo, confirma crítico ou comprova administração medicamentosa.</p>
    {snapshot.steps.map((step) => <ChecklistStep key={`${view.task.id}:${view.task.version}:${step.code}`} user={user} view={view} step={step} mayExecute={mayExecute} onSaved={onSaved} />)}
  </section>{snapshot.clinicalProcess && <CareExecution user={user} view={view} readOnly={readOnly} onSaved={onSaved} />}</>;
}

function ChecklistStep({ user, view, step, mayExecute, onSaved }: { user: SessionUser; view: HospitalTaskView; step: HospitalChecklistStep; mayExecute: boolean; onSaved: (view: HospitalTaskView) => void }) {
  const [open, setOpen] = useState(false); const [evidence, setEvidence] = useState(""); const [reason, setReason] = useState(""); const command = usePlannerCommand();
  const current = view.task.checklistExecutions?.find((entry) => entry.stepCode === step.code && entry.status === "DONE"); const history = view.task.checklistExecutions?.filter((entry) => entry.stepCode === step.code && entry.status === "VOIDED") ?? [];
  const mayVoid = mayExecute && current && (current.actorId === user.id || ["MANAGER", "SUPERADMIN"].includes(user.role));
  async function save() {
    if (!mayExecute || current && (!mayVoid || !reason.trim()) || !current && step.evidenceRequired && !evidence.trim()) return;
    const result = await command.execute<HospitalTaskView>(`/hospital-tasks/${encodeURIComponent(view.task.id)}/checklist-steps`, "POST", { stepCode: step.code, command: current ? "VOID" : "DONE", ...(current ? { reason: reason.trim() } : evidence.trim() ? { evidenceText: evidence.trim() } : {}), expectedVersion: view.task.version }); if (result) onSaved(result);
  }
  return <div className="checklist-step"><h3>{step.label}{step.required ? " · obrigatória" : " · opcional"}</h3>{current ? <p>Registrada em {formatHospitalDateTime(current.executedAt)}{current.evidenceText && <> · {current.evidenceText}</>}</p> : <p>Etapa pendente.</p>}
    {mayExecute && (!current || mayVoid) && <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{current ? "Invalidar evidência" : "Registrar etapa"} {step.label}</button>}
    {open && mayExecute && (!current || mayVoid) && <form aria-label={`${current ? "Invalidar" : "Registrar"} etapa ${step.label}`} onSubmit={(event) => { event.preventDefault(); void save(); }}>{current ? <label>Motivo da invalidação<textarea required maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} /></label> : <label>Evidência da etapa{!step.evidenceRequired && " (opcional)"}<textarea required={step.evidenceRequired} maxLength={2000} value={evidence} onChange={(event) => setEvidence(event.target.value)} /></label>}{command.error && <p role="alert">{command.error}</p>}<ActionButton type="submit" state={command.busy ? "pending" : "idle"}>{current ? "Confirmar invalidação" : "Confirmar registro da etapa"}</ActionButton></form>}
    {history.length > 0 && <details><summary>Evidências invalidadas desta etapa</summary>{history.map((entry) => <p key={entry.id}>{formatHospitalDateTime(entry.executedAt)} · {entry.evidenceText ?? "Sem texto adicional"} · invalidada em {formatHospitalDateTime(entry.voidedAt)} · motivo: {entry.voidReason}</p>)}</details>}
  </div>;
}

function CareExecution({ user, view, readOnly, onSaved }: { user: SessionUser; view: HospitalTaskView; readOnly: boolean; onSaved: (view: HospitalTaskView) => void }) {
  const process = view.task.checklistSnapshot!.clinicalProcess!; const execution = view.task.careExecution; const [reference, setReference] = useState(""); const [note, setNote] = useState(""); const [confirmed, setConfirmed] = useState(false); const command = usePlannerCommand();
  const mayExecute = !readOnly && !execution && view.task.phase === "IN_PROGRESS" && user.permissions?.includes("care.execute") === true && view.permissions.includes("care.execute");
  async function save() {
    if (!mayExecute || !confirmed || !reference.trim()) return;
    const result = await command.execute<HospitalTaskView>(`/hospital-tasks/${encodeURIComponent(view.task.id)}/care-execution`, "POST", { expectedVersion: view.task.version, confirm: true, clinicalRecordReference: reference.trim(), ...(note.trim() ? { note: note.trim() } : {}) }); if (result) onSaved(result);
  }
  return <section className="panel" aria-label="Confirmação de cuidado"><h2>{process.modality === "CARE" ? "Confirmação do cuidado" : "Confirmação do procedimento"}</h2><p>Sistema clínico adotado: {process.clinicalSystemReference}</p><p>Política de confirmação: {process.confirmationPolicyReference}</p><p className="field-hint">A referência é declarada pelo executor. Este registro não comprova recebimento em um sistema externo nem representa prescrição ou administração de medicamento.</p>
    {execution ? <><p>Confirmado em {formatHospitalDateTime(execution.performedAt)} · registro clínico: {execution.clinicalRecordReference}</p>{execution.note && <p>{execution.note}</p>}<p>Recursos usados: {execution.resourceSnapshots.map((resource) => resource.name).join(" / ") || "Sem recursos adicionais registrados"}</p></> : mayExecute ? <form aria-label="Confirmar execução assistencial" onSubmit={(event) => { event.preventDefault(); void save(); }}><label>Referência no prontuário ou sistema clínico<input required maxLength={500} value={reference} onChange={(event) => setReference(event.target.value)} /></label><label>Nota da execução assistencial (opcional)<textarea maxLength={2000} value={note} onChange={(event) => setNote(event.target.value)} /></label><label><input type="checkbox" required checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />Confirmo que executei este processo e registrei a referência conforme a política aprovada.</label>{command.error && <p role="alert">{command.error}</p>}<ActionButton type="submit" state={command.busy ? "pending" : "idle"}>Confirmar execução assistencial</ActionButton></form> : <p>A confirmação usa uma ação assistencial própria, disponível ao executor elegível na fase de execução.</p>}
  </section>;
}
