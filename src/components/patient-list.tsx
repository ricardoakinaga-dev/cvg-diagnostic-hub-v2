"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Patient, SessionResponse } from "@cvg/contracts";
import { apiFetch, getSafeErrorMessage } from "./api-client";
import { EmptyState, ErrorState, LoadingState } from "./feedback-states";
import { PatientDialog } from "./patient-dialog";
import { Icon } from "./ui-icons";

export function PatientList() {
  const [query, setQuery] = useState("");
  const [patients, setPatients] = useState<Patient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [canCreate, setCanCreate] = useState(false);
  const loadVersion = useRef(0);
  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    setLoading(true);
    setError("");
    try {
      const nextPatients = await apiFetch<Patient[]>(`/patients?q=${encodeURIComponent(query)}`);
      if (loadVersion.current !== version) return;
      setPatients(nextPatients);
    }
    catch (cause) {
      if (loadVersion.current === version) setError(getSafeErrorMessage(cause, "Não foi possível carregar os pacientes."));
    }
    finally {
      if (loadVersion.current === version) setLoading(false);
    }
  }, [query]);
  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 180);
    return () => { window.clearTimeout(timer); loadVersion.current += 1; };
  }, [load]);
  useEffect(() => {
    void apiFetch<SessionResponse>("/session/me")
      .then(({ user }) => setCanCreate(user.role === "VETERINARIAN" || user.role === "INPATIENT_TEAM"))
      .catch(() => setCanCreate(false));
  }, []);

  return <>
     <div className="patient-page"><div className="page-heading"><div><p className="eyebrow">Contexto de cuidado</p><h1>Meus <em>pacientes.</em></h1><p className="page-lede">Identidade mínima, atendimento e próximos passos dentro do seu escopo.</p></div>{canCreate && <button type="button" className="button button-primary" onClick={() => setShowCreate(true)}><Icon name="add" size={16} /> Novo paciente</button>}</div><div className="search-bar"><span aria-hidden="true"><Icon name="search" size={19} /></span><input aria-label="Buscar pacientes" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar nome, identificador ou tutor…" /></div>{error && <ErrorState title="Não foi possível carregar os pacientes" message={error} onRetry={load} retrying={loading} />}{loading ? <LoadingState className="panel resource-loading" label="Carregando pacientes" /> : patients.length === 0 ? <EmptyState className="panel" title="Nenhum paciente atribuído" message="Refine a busca ou confirme o escopo de atendimento." /> : <section className="patient-grid" aria-label="Pacientes autorizados">{patients.map((patient) => <Link href={`/patients/${patient.id}/diagnostics`} className="panel patient-card" key={patient.id}><span className="patient-avatar">{patient.displayName.slice(0, 1)}</span><span className="patient-card-copy"><strong>{patient.displayName}</strong><small>{patient.species} · {patient.sex} · {patient.breed}</small><small>{patient.externalId} · tutor {patient.ownerLabel}</small></span><span className="row-arrow" aria-hidden="true"><Icon name="arrow-right" size={16} /></span></Link>)}</section>}
    </div>
    {showCreate && <PatientDialog onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); void load(); }} />}
  </>;
}
