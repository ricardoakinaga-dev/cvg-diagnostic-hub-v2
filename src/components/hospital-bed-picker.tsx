"use client";

import Link from "next/link";
import { useEffect } from "react";
import type { HospitalBedCensus, Patient } from "@cvg/contracts";
import { usePlannerIdentity } from "./use-planner";
import { usePlannerResource } from "./use-planner-resource";
import { PartialNotice } from "./feedback-states";

const fold = (value: string) => value.normalize("NFKC").trim().toLocaleLowerCase("pt-BR");
export function HospitalBedPicker({ census, value, onChange, species, departmentCode, allowReconciling = false }: { census: HospitalBedCensus; value: string; onChange: (id: string) => void; species?: string; departmentCode?: string; allowReconciling?: boolean }) {
  const rows = census.beds.filter((entry) => !departmentCode || entry.resource.departmentCode === departmentCode);
  const eligible = (row: HospitalBedCensus["beds"][number]) => (row.state === "AVAILABLE" || allowReconciling && row.state === "UNRECONCILED") && row.resource.active && row.resource.availability === "AVAILABLE" && (!species || row.resource.allowedSpecies?.map(fold).includes(fold(species)));
  useEffect(() => { if (value && !rows.some((row) => row.resource.id === value && eligible(row))) onChange(""); });
  return <><label>Leito cadastrado<select required value={value} onChange={(event) => onChange(event.target.value)}><option value="">Selecione um leito elegível…</option>{rows.map((row) => <option key={row.resource.id} value={row.resource.id} disabled={!eligible(row)}>{row.resource.name} · {row.resource.departmentCode} · ala {row.resource.ward} · {row.resource.bedLabel}{!eligible(row) ? " · indisponível ou incompatível" : ""}</option>)}</select></label><p className="field-hint">O leito é validado por ID, compatibilidade de espécie e ocupação na transação da internação.</p>{!rows.some(eligible) && <p role="status">Nenhum leito elegível nesta visão. Cadastre o inventário ou concilie as internações sem vínculo antes de admitir nova ocupação.</p>}</>;
}

export function HospitalNewAdmissionFields({ value, onChange, species, patientId }: { value: string; onChange: (id: string) => void; species?: string; patientId?: string }) {
  const { user, error } = usePlannerIdentity(); const mayRead = user?.permissions?.includes("admission.view") === true;
  const census = usePlannerResource<HospitalBedCensus>(user?.id, "/bed-census", mayRead);
  const patient = usePlannerResource<Patient>(user?.id, `/patients/${encodeURIComponent(patientId ?? "")}`, Boolean(patientId) && user?.permissions?.includes("patient.view") === true);
  useEffect(() => { if (value && (error || !mayRead || census.error || patientId && patient.error)) onChange(""); }, [value, error, mayRead, census.error, patientId, patient.error, onChange]);
  if (error) return <p role="alert">{error}</p>;
  if (!user || census.loading && !census.data) return <p role="status">Consultando leitos e ocupação…</p>;
  if (!mayRead) return <p role="alert">Seu acesso não permite consultar leitos para abrir uma internação.</p>;
  return <fieldset><legend>Acomodação da internação</legend>{census.error && <PartialNotice message={census.error} onRetry={census.reload} />}{patient.error && <PartialNotice message={patient.error} onRetry={patient.reload} />}{census.data && !census.error && (!patientId || patient.data && !patient.error) && <HospitalBedPicker census={census.data} value={value} onChange={onChange} species={species ?? patient.data?.species} />} {user.permissions?.includes("hospital_resource.create") && <Link href="/admin/resources">Cadastrar leitos e espécies compatíveis</Link>}</fieldset>;
}
