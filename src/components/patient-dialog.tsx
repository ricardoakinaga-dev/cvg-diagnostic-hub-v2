"use client";

import { useRef, useState, type FormEvent } from "react";
import type { PatientCreateResult } from "@cvg/contracts";
import { ActionButton } from "@cvg/ui";
import { apiFetch, getSafeErrorMessage } from "./api-client";
import { useDialogFocus } from "./use-dialog-focus";
import { Icon } from "./ui-icons";

export type CreatedPatientPayload = PatientCreateResult;

interface PatientDraft {
  displayName: string;
  species: string;
  breed: string;
  sex: string;
  birthDate: string;
  ownerLabel: string;
  externalId: string;
  encounterType: "INPATIENT" | "EMERGENCY" | "OUTPATIENT";
  ward: string;
  bed: string;
}

const initialDraft: PatientDraft = {
  displayName: "",
  species: "Canino",
  breed: "",
  sex: "Macho",
  birthDate: "",
  ownerLabel: "",
  externalId: "",
  encounterType: "OUTPATIENT",
  ward: "",
  bed: ""
};

const encounterLabels: Record<PatientDraft["encounterType"], string> = {
  OUTPATIENT: "Atendimento externo",
  EMERGENCY: "Emergência",
  INPATIENT: "Internação"
};

export function PatientDialog({ onClose, onCreated, nested = false }: { onClose: () => void; onCreated: (result: CreatedPatientPayload) => void; nested?: boolean }) {
  const dialogRef = useRef<HTMLElement>(null);
  const firstInputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<PatientDraft>(initialDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useDialogFocus(dialogRef, onClose, firstInputRef);

  function setField<K extends keyof PatientDraft>(field: K, value: PatientDraft[K]) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await apiFetch<CreatedPatientPayload>("/patients", {
        method: "POST",
        body: JSON.stringify({
          displayName: draft.displayName,
          species: draft.species,
          breed: draft.breed,
          sex: draft.sex,
          ...(draft.birthDate ? { birthDate: draft.birthDate } : {}),
          ownerLabel: draft.ownerLabel,
          ...(draft.externalId.trim() ? { externalId: draft.externalId } : {}),
          encounterType: draft.encounterType,
          ...(draft.encounterType === "INPATIENT" ? { ward: draft.ward, bed: draft.bed } : {})
        })
      });
      onCreated(result);
    } catch (cause) {
      setError(getSafeErrorMessage(cause, "Não foi possível cadastrar o paciente."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`dialog-backdrop ${nested ? "dialog-backdrop-nested" : ""}`} role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <section ref={dialogRef} className="dialog patient-dialog" data-dialog-layer="true" role="dialog" aria-modal="true" aria-labelledby="patient-dialog-title">
        <div className="dialog-heading">
          <div><p className="eyebrow">Novo contexto</p><h2 id="patient-dialog-title">Cadastrar paciente</h2><p>O atendimento inicial será aberto junto com o cadastro.</p></div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Fechar cadastro de paciente"><Icon name="close" size={18} /></button>
        </div>
        <form onSubmit={(event) => void submit(event)}>
          <div className="patient-form-grid">
            <label className="patient-form-wide">Nome do paciente<input ref={firstInputRef} value={draft.displayName} onChange={(event) => setField("displayName", event.target.value)} maxLength={120} autoFocus required placeholder="Ex.: Amora" /></label>
            <label>Espécie<input value={draft.species} onChange={(event) => setField("species", event.target.value)} maxLength={60} required placeholder="Ex.: Canino" /></label>
            <label>Raça ou tipo<input value={draft.breed} onChange={(event) => setField("breed", event.target.value)} maxLength={120} required placeholder="Ex.: Labrador" /></label>
            <label>Sexo<select value={draft.sex} onChange={(event) => setField("sex", event.target.value)}><option value="Macho">Macho</option><option value="Fêmea">Fêmea</option><option value="Não informado">Não informado</option></select></label>
            <label>Data de nascimento<input type="date" value={draft.birthDate} onChange={(event) => setField("birthDate", event.target.value)} max={new Date().toISOString().slice(0, 10)} /></label>
            <label className="patient-form-wide">Tutor ou responsável<input value={draft.ownerLabel} onChange={(event) => setField("ownerLabel", event.target.value)} maxLength={160} required placeholder="Nome para identificação no atendimento" /></label>
            <label className="patient-form-wide">Prontuário ou identificador externo <span className="field-optional">opcional</span><input value={draft.externalId} onChange={(event) => setField("externalId", event.target.value.toUpperCase())} maxLength={100} placeholder="Será gerado se não for informado" /><small className="field-hint">Use o identificador do hospital quando existir. No modo local, o Hub gera um código único.</small></label>
          </div>
          <fieldset className="patient-encounter-fieldset"><legend>Atendimento inicial</legend><p className="field-hint patient-encounter-hint">Escolha o contexto clínico que será aberto para este paciente e usado na solicitação.</p><div className="encounter-choice-list">{(Object.keys(encounterLabels) as PatientDraft["encounterType"][]).map((type) => <label key={type} className={`encounter-choice ${draft.encounterType === type ? "selected" : ""}`}><input type="radio" name="encounterType" value={type} checked={draft.encounterType === type} onChange={() => setField("encounterType", type)} /><span><strong>{encounterLabels[type]}</strong><small>{type === "INPATIENT" ? "Abre também ala e leito." : "Fica disponível para a solicitação de exames."}</small></span></label>)}</div></fieldset>
          {draft.encounterType === "INPATIENT" && <div className="patient-form-grid patient-admission-fields"><label>Ala ou unidade<input value={draft.ward} onChange={(event) => setField("ward", event.target.value)} maxLength={100} required placeholder="Ex.: UTI 1" /></label><label>Leito<input value={draft.bed} onChange={(event) => setField("bed", event.target.value)} maxLength={100} required placeholder="Ex.: Box 03" /></label></div>}
          {error && <div className="form-alert" role="alert">{error}</div>}
          <div className="dialog-actions"><button type="button" className="button button-ghost" onClick={onClose}>Cancelar</button><ActionButton type="submit" state={busy ? "pending" : "idle"} aria-label={busy ? "Cadastrando paciente" : "Confirmar cadastro de paciente"} icon={<Icon name="arrow-right" size={15} />}>{busy ? "Cadastrando…" : "Cadastrar paciente"}</ActionButton></div>
        </form>
      </section>
    </div>
  );
}
