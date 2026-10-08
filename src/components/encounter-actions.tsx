"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import type { Encounter, EncounterCloseResult, EncounterOpenResult } from "@cvg/contracts";
import { ActionButton } from "@cvg/ui";
import { apiFetch, getSafeErrorMessage } from "./api-client";
import { useDialogFocus } from "./use-dialog-focus";
import { Icon } from "./ui-icons";

export const encounterTypeLabels: Record<Encounter["type"], string> = {
  OUTPATIENT: "Atendimento externo",
  EMERGENCY: "Emergência",
  INPATIENT: "Internação"
};

export function EncounterOpenDialog({ patientId, onClose, onOpened }: { patientId: string; onClose: () => void; onOpened: (result: EncounterOpenResult) => void }) {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const typeRef = useRef<HTMLSelectElement>(null);
  const [encounterType, setEncounterType] = useState<Encounter["type"]>("OUTPATIENT");
  const [ward, setWard] = useState("");
  const [bed, setBed] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useDialogFocus(dialogRef, onClose, typeRef);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await apiFetch<EncounterOpenResult>(`/patients/${encodeURIComponent(patientId)}/encounters`, {
        method: "POST",
        body: JSON.stringify({
          encounterType,
          ...(encounterType === "INPATIENT" ? { ward: ward.trim(), bed: bed.trim() } : {})
        })
      });
      onOpened(result);
    } catch (cause) {
      setError(getSafeErrorMessage(cause, "Não foi possível abrir o atendimento."));
    } finally {
      setBusy(false);
    }
  }

  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
    <section ref={dialogRef} className="dialog" data-dialog-layer="true" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="dialog-heading">
        <div><p className="eyebrow">Atendimento</p><h2 id={titleId}>Novo atendimento</h2><p>O paciente poderá receber novas solicitações de exame neste atendimento.</p></div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Fechar novo atendimento"><Icon name="close" size={18} /></button>
      </div>
      <form onSubmit={(event) => void submit(event)}>
        <label>Tipo de atendimento<select ref={typeRef} value={encounterType} onChange={(event) => setEncounterType(event.target.value as Encounter["type"])}>{(Object.keys(encounterTypeLabels) as Encounter["type"][]).map((type) => <option key={type} value={type}>{encounterTypeLabels[type]}</option>)}</select></label>
        {encounterType === "INPATIENT" && <div className="patient-form-grid patient-admission-fields"><label>Ala ou unidade<input value={ward} onChange={(event) => setWard(event.target.value)} maxLength={100} required placeholder="Ex.: UTI 1" /></label><label>Leito<input value={bed} onChange={(event) => setBed(event.target.value)} maxLength={100} required placeholder="Ex.: Box 03" /></label></div>}
        {error && <div className="form-alert" role="alert">{error}</div>}
        <div className="dialog-actions"><button type="button" className="button button-ghost" onClick={onClose}>Cancelar</button><ActionButton type="submit" state={busy ? "pending" : "idle"} icon={<Icon name="arrow-right" size={15} />}>{busy ? "Abrindo…" : "Abrir atendimento"}</ActionButton></div>
      </form>
    </section>
  </div>;
}

export function EncounterCloseDialog({ encounter, onClose, onClosed }: { encounter: Encounter; onClose: () => void; onClosed: (result: EncounterCloseResult) => void }) {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useDialogFocus(dialogRef, onClose, cancelRef);

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await apiFetch<EncounterCloseResult>(`/encounters/${encodeURIComponent(encounter.id)}/close`, {
        method: "POST",
        body: JSON.stringify(reason.trim() ? { reason: reason.trim() } : {})
      });
      onClosed(result);
    } catch (cause) {
      setError(getSafeErrorMessage(cause, "Não foi possível encerrar o atendimento."));
    } finally {
      setBusy(false);
    }
  }

  return <div className="dialog-backdrop" role="presentation">
    <section ref={dialogRef} className="dialog" data-dialog-layer="true" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <h2 id={titleId}>Encerrar atendimento</h2>
      <p>O atendimento {encounter.externalId} será encerrado{encounter.type === "INPATIENT" ? " e a internação receberá alta" : ""}. Os exames pendentes continuam com quem solicitou.</p>
      <label>Motivo <span className="field-optional">opcional</span><textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} maxLength={500} placeholder="Ex.: alta clínica, tutor retirou o paciente." /></label>
      {error && <div className="form-alert" role="alert">{error}</div>}
      <div className="dialog-actions">
        <button ref={cancelRef} type="button" className="button button-ghost" onClick={onClose}>Cancelar</button>
        <ActionButton state={busy ? "pending" : "idle"} onClick={() => void confirm()}>{busy ? "Encerrando…" : "Encerrar atendimento"}</ActionButton>
      </div>
    </section>
  </div>;
}
