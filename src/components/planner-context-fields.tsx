"use client";

import { useEffect, useState } from "react";
import type { Encounter, Patient } from "@cvg/contracts";
import { apiFetch, getSafeErrorMessage } from "./api-client";

export interface PlannerCareContext { patientId?: string; encounterId?: string }
export function PlannerContextFields({ value, onChange, required = false, allowed = false, currentPatient }: { value: PlannerCareContext; onChange: (context: PlannerCareContext) => void; required?: boolean; allowed?: boolean; currentPatient?: Pick<Patient, "id" | "displayName" | "externalId" | "ownerLabel"> }) {
  const [query, setQuery] = useState("");
  const [patients, setPatients] = useState<Patient[]>([]);
  const [encounters, setEncounters] = useState<{ patientId: string; items: Encounter[] }>({ patientId: "", items: [] });
  const [selectedPatient, setSelectedPatient] = useState<Pick<Patient, "id" | "displayName" | "externalId" | "ownerLabel">>();
  const [patientError, setPatientError] = useState("");
  const [encounterError, setEncounterError] = useState("");
  const [patientsLoading, setPatientsLoading] = useState(false);
  const [encountersLoading, setEncountersLoading] = useState(false);
  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setPatientsLoading(true);
      void apiFetch<Patient[]>(`/patients${query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ""}`, { signal: controller.signal }).then((result) => { if (!controller.signal.aborted) { setPatients(result); setPatientError(""); } }).catch((cause: unknown) => { if (!controller.signal.aborted) { setPatients([]); setPatientError(getSafeErrorMessage(cause, "Não foi possível consultar os pacientes.")); } }).finally(() => { if (!controller.signal.aborted) setPatientsLoading(false); });
    }, 200);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query, allowed]);
  useEffect(() => {
    if (!allowed || !value.patientId) return;
    const patientId = value.patientId;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setEncountersLoading(true);
      void apiFetch<Encounter[]>(`/patients/${encodeURIComponent(patientId)}/encounters`, { signal: controller.signal }).then((result) => { if (!controller.signal.aborted) { setEncounters({ patientId, items: result.filter((entry) => entry.status === "OPEN") }); setEncounterError(""); } }).catch((cause: unknown) => { if (!controller.signal.aborted) { setEncounters({ patientId, items: [] }); setEncounterError(getSafeErrorMessage(cause, "Não foi possível consultar os atendimentos.")); } }).finally(() => { if (!controller.signal.aborted) setEncountersLoading(false); });
    }, 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [value.patientId, allowed]);
  const retained = selectedPatient?.id === value.patientId ? selectedPatient : currentPatient?.id === value.patientId ? currentPatient : undefined;
  const options = retained && !patients.some((patient) => patient.id === retained.id) ? [retained, ...patients] : patients;
  const currentEncounters = encounters.patientId === value.patientId ? encounters.items : [];
  if (!allowed) return <p className="field-hint">Seu acesso não permite vincular pacientes nesta operação.</p>;
  return <fieldset><legend>Contexto assistencial {required ? "obrigatório" : "opcional"}</legend>
    <label>Buscar paciente ou prontuário<input value={query} onChange={(event) => setQuery(event.target.value)} maxLength={200} placeholder="Nome ou identificação do prontuário" /></label>
    <label>Paciente<select value={value.patientId ?? ""} disabled={patientsLoading || Boolean(patientError)} required={required} onChange={(event) => { setSelectedPatient(options.find((entry) => entry.id === event.target.value)); onChange(event.target.value ? { patientId: event.target.value } : {}); }}><option value="">Sem vínculo com paciente</option>{options.map((patient) => <option key={patient.id} value={patient.id}>{patient.displayName} · {patient.externalId} · tutor {patient.ownerLabel}</option>)}</select></label>
    {patientsLoading && <p role="status">Buscando pacientes autorizados…</p>}{patientError && <p role="alert">{patientError}</p>}
    {value.patientId && <label>Atendimento<select value={value.encounterId ?? ""} required={required} disabled={encountersLoading || currentEncounters.length === 0} onChange={(event) => onChange({ patientId: value.patientId, ...(event.target.value ? { encounterId: event.target.value } : {}) })}><option value="">Selecione o atendimento…</option>{currentEncounters.map((encounter) => <option key={encounter.id} value={encounter.id}>{encounter.externalId} · {encounter.type === "INPATIENT" ? "Internação" : encounter.type === "EMERGENCY" ? "Emergência" : "Atendimento externo"}</option>)}</select></label>}
    {encountersLoading && <p role="status">Carregando atendimentos…</p>}{encounterError && <p role="alert">{encounterError}</p>}
    {value.patientId && !encountersLoading && !currentEncounters.length && !encounterError && <p role="status">Nenhum atendimento aberto disponível. Abra o contexto na página do paciente.</p>}
    {!required && <p className="field-hint">Uma rotina operacional pode existir sem paciente. Use somente identificação operacional em tarefas sem vínculo assistencial.</p>}
  </fieldset>;
}
