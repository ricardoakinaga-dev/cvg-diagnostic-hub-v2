"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import type { DiagnosticService, Encounter, Patient } from "@cvg/contracts";
import { ActionButton } from "@cvg/ui";
import { apiFetch, getSafeErrorMessage } from "./api-client";

export function QueueBoardQuickAdd({ departments, onCreated, disabled, refreshing = false }: { departments: string[]; onCreated: () => void; disabled: boolean; refreshing?: boolean }) {
  const id = useId();
  const [patients, setPatients] = useState<Patient[]>([]);
  const [services, setServices] = useState<DiagnosticService[]>([]);
  const [selectedPatient, setSelectedPatient] = useState<Patient>();
  const patientId = selectedPatient?.id ?? "";
  const [query, setQuery] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [encounters, setEncounters] = useState<Encounter[]>([]);
  const [encounterId, setEncounterId] = useState("");
  const [loadedPatientKey, setLoadedPatientKey] = useState("");
  const [loadedServiceKey, setLoadedServiceKey] = useState("");
  const [loadingEncounter, setLoadingEncounter] = useState(false);
  const [pending, setPending] = useState(false);
  const [patientError, setPatientError] = useState("");
  const [serviceError, setServiceError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const [patientRetry, setPatientRetry] = useState(0);
  const [serviceRetry, setServiceRetry] = useState(0);
  const patientKey = JSON.stringify([query, revision, patientRetry]);
  const serviceKey = JSON.stringify([revision, serviceRetry]);
  const loadingPatients = loadedPatientKey !== patientKey;
  const loadingServices = loadedServiceKey !== serviceKey;
  const encounterRequest = useRef(0);
  const submitting = useRef(false);
  const mounted = useRef(false);
  const previousRefreshing = useRef(refreshing);

  useEffect(() => {
    mounted.current = true;
    const refresh = () => setRevision((value) => value + 1);
    window.addEventListener("cvg:realtime-updated", refresh);
    window.addEventListener("cvg:realtime-resync", refresh);
    return () => {
      mounted.current = false;
      encounterRequest.current += 1;
      window.removeEventListener("cvg:realtime-updated", refresh);
      window.removeEventListener("cvg:realtime-resync", refresh);
    };
  }, []);

  useEffect(() => {
    if (previousRefreshing.current && !refreshing) setRevision((value) => value + 1);
    previousRefreshing.current = refreshing;
  }, [refreshing]);

  useEffect(() => {
    let active = true;
    const search = query.trim();
    void apiFetch<Patient[]>(search ? `/patients?q=${encodeURIComponent(search)}` : "/patients").then((nextPatients) => {
      if (!active) return;
      setPatientError("");
      setPatients(nextPatients.filter((patient) => patient.active));
      // Search pages are partial. Keep the choice even when it is outside this page.
      setSelectedPatient((selected) => selected && (nextPatients.find((patient) => patient.id === selected.id) ?? selected));
    }).catch((cause: unknown) => {
      if (active) setPatientError(getSafeErrorMessage(cause, "Não foi possível carregar pacientes."));
    }).finally(() => { if (active) setLoadedPatientKey(patientKey); });
    return () => { active = false; };
  }, [query, patientKey]);

  useEffect(() => {
    let active = true;
    void apiFetch<DiagnosticService[]>("/diagnostic-services").then((nextServices) => {
      if (active) {
        setServiceError("");
        setServices(nextServices.filter((service) => service.active));
      }
    }).catch((cause: unknown) => {
      if (active) setServiceError(getSafeErrorMessage(cause, "Não foi possível carregar exames."));
    }).finally(() => { if (active) setLoadedServiceKey(serviceKey); });
    return () => { active = false; };
  }, [serviceKey]);

  async function selectPatient(nextId: string) {
    const request = ++encounterRequest.current;
    setSelectedPatient(patientOptions.find((patient) => patient.id === nextId));
    setEncounterId("");
    setEncounters([]);
    setError("");
    setNotice("");
    setLoadingEncounter(Boolean(nextId));
    if (!nextId) return;
    try {
      const nextEncounters = await apiFetch<Encounter[]>(`/patients/${encodeURIComponent(nextId)}/encounters`);
      if (request !== encounterRequest.current) return;
      const open = nextEncounters.filter((encounter) => encounter.patientId === nextId && encounter.status === "OPEN");
      setEncounters(open);
      if (open.length === 1) setEncounterId(open[0].id);
    } catch (cause) {
      if (request === encounterRequest.current) setError(getSafeErrorMessage(cause, "Não foi possível carregar o atendimento do paciente."));
    } finally {
      if (request === encounterRequest.current) setLoadingEncounter(false);
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || refreshing || loadingServices || serviceError || loadingEncounter || submitting.current) return;
    setError("");
    setNotice("");
    if (!patientId || !serviceId || !encounterId) { setError("Escolha paciente, exame e um atendimento aberto válido."); return; }
    if (!selectedPatient?.active) { setError("Este paciente está inativo. Escolha outro paciente."); return; }
    if (!scopedServices.some((service) => service.id === serviceId)) { setError("Este exame não está disponível no setor. Escolha outro exame."); return; }
    if (!encounters.some((encounter) => encounter.id === encounterId && encounter.patientId === patientId && encounter.status === "OPEN")) { setError("O atendimento precisa pertencer ao paciente selecionado e estar aberto."); return; }
    submitting.current = true;
    setPending(true);
    try {
      await apiFetch("/diagnostic-requests", { method: "POST", body: JSON.stringify({ patientId, encounterId, priority: "ROUTINE", items: [{ serviceId }] }) });
      if (!mounted.current) return;
      setServiceId("");
      setNotice("Exame solicitado.");
      onCreated();
    } catch (cause) {
      if (mounted.current) setError(getSafeErrorMessage(cause, "Não foi possível solicitar o exame. Confira o atendimento e possíveis exames duplicados."));
    } finally {
      submitting.current = false;
      if (mounted.current) setPending(false);
    }
  }

  const scopedServices = services.filter((service) => departments.length === 0 || departments.includes(service.departmentCode));
  const patientOptions = selectedPatient && !patients.some((patient) => patient.id === patientId) ? [selectedPatient, ...patients] : patients;
  const unavailableService = serviceId && !scopedServices.some((service) => service.id === serviceId);
  return <form className="queue-board-quick-add" aria-label="Adicionar exame à fila" onSubmit={(event) => void submit(event)} onKeyDown={(event) => {
    if (event.key === "Enter" && event.target instanceof HTMLSelectElement) { event.preventDefault(); event.currentTarget.requestSubmit(); }
    if (event.key === "Enter" && event.target instanceof HTMLInputElement) event.preventDefault();
  }}>
    <h3>Novo exame</h3>
    <label htmlFor={`${id}-search`}>Buscar paciente</label><input id={`${id}-search`} type="search" value={query} maxLength={200} placeholder="Nome, tutor ou identificação" disabled={disabled || refreshing || pending} onChange={(event) => setQuery(event.target.value)} />
    <label htmlFor={`${id}-patient`}>Paciente</label><select id={`${id}-patient`} value={patientId} disabled={disabled || refreshing || pending || (loadingPatients && !patientOptions.length)} onChange={(event) => void selectPatient(event.target.value)}><option value="">Selecione o paciente…</option>{patientOptions.map((patient) => <option key={patient.id} value={patient.id} disabled={!patient.active}>{patient.displayName} · {patient.species} · {patient.externalId}</option>)}</select>
    <label htmlFor={`${id}-exam`}>Exame</label><select id={`${id}-exam`} value={serviceId} disabled={disabled || refreshing || loadingServices || pending} onChange={(event) => setServiceId(event.target.value)}><option value="">Selecione o exame…</option>{unavailableService && <option value={serviceId} disabled>Exame indisponível — escolha outro</option>}{scopedServices.map((service) => <option key={service.id} value={service.id}>{service.name}</option>)}</select>
    {encounters.length > 1 && <label>Atendimento<select value={encounterId} disabled={pending || disabled || refreshing} onChange={(event) => setEncounterId(event.target.value)}><option value="">Escolha o atendimento…</option>{encounters.map((encounter) => <option key={encounter.id} value={encounter.id}>{encounter.externalId} · {encounter.type}</option>)}</select></label>}
    {loadingPatients && <p role="status">Buscando pacientes…</p>}
    {loadingServices && <p role="status">Carregando exames…</p>}
    {loadingEncounter && <p role="status">Carregando atendimento…</p>}
    {patientId && !loadingEncounter && !error && encounters.length === 0 && <p role="status">Este paciente não tem atendimento aberto. <Link href={`/patients/${encodeURIComponent(patientId)}/diagnostics`}>Abra um novo atendimento na página do paciente.</Link></p>}
    {!loadingPatients && !patientError && patients.length === 0 && <p role="status">Nenhum paciente encontrado. Tente outro nome ou identificação.</p>}
    {!loadingPatients && patientError && <p role="alert">{patientError}<button type="button" disabled={pending || disabled || refreshing} onClick={() => setPatientRetry((value) => value + 1)}>Tentar novamente</button></p>}
    {!loadingServices && serviceError && <p role="alert">{serviceError}<button type="button" disabled={pending || disabled || refreshing} onClick={() => setServiceRetry((value) => value + 1)}>Tentar novamente</button></p>}
    {error && <p role="alert">{error}<button type="button" disabled={pending || disabled || refreshing} onClick={() => { if (encounterId) setError(""); else void selectPatient(patientId); }}>Tentar novamente</button></p>}
    {notice && <p role="status">{notice}</p>}
    <ActionButton type="submit" state={pending ? "pending" : "idle"} disabled={disabled || refreshing || loadingServices || Boolean(serviceError) || loadingEncounter || pending}>Adicionar exame</ActionButton>
    <small>Enter para adicionar em Solicitado. Prioridade padrão: rotina.</small>
  </form>;
}
