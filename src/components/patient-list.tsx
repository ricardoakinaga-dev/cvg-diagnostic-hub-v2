"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Patient, SessionResponse } from "@cvg/contracts";
import { apiFetch, getSafeErrorMessage } from "./api-client";
import { EmptyState, ErrorState, LoadingState } from "./feedback-states";
import { PatientDialog } from "./patient-dialog";
import { Icon } from "./ui-icons";
import { PageHeader } from "./page-header";
import { Avatar } from "./work-items/icons";

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
    <PageHeader crumbs={[{ label: "Pacientes", icon: "paw" }]} count={loading ? undefined : patients.length}>
      <div className="header-search"><Icon name="search" size={13} /><input aria-label="Buscar pacientes" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Nome, identificador ou tutor" /></div>
      {canCreate && <button type="button" className="button-primary-sm" onClick={() => setShowCreate(true)}><Icon name="add" size={14} />Novo paciente</button>}
    </PageHeader>
    <div className="patient-page">
      {error && <div className="page-body-tight"><ErrorState title="Não foi possível carregar os pacientes" message={error} onRetry={load} retrying={loading} /></div>}
      {loading ? <LoadingState className="resource-loading" label="Carregando pacientes" /> : patients.length === 0 ? <EmptyState title="Nenhum paciente atribuído" message="Refine a busca ou confirme o escopo de atendimento." /> : <section className="patient-rows" aria-label="Pacientes autorizados">
        <div className="patient-rows-head" aria-hidden="true"><span>Paciente</span><span>Espécie e raça</span><span>Identificador</span><span>Tutor</span></div>
        {patients.map((patient) => <Link href={`/patients/${patient.id}/diagnostics`} className="patient-row" key={patient.id}>
          <span className="patient-row-name"><Avatar name={patient.displayName} size="sm" /><strong>{patient.displayName}</strong><small>{patient.sex}</small></span>
          <span className="patient-row-cell"><Icon name="paw" size={13} />{patient.species} · {patient.breed}</span>
          <span className="patient-row-cell mono">{patient.externalId}</span>
          <span className="patient-row-cell">{patient.ownerLabel}</span>
          <Icon name="chevron-right" size={15} className="patient-row-arrow" />
        </Link>)}
      </section>}
    </div>
    {showCreate && <PatientDialog onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); void load(); }} />}
  </>;
}
