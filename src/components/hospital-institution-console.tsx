"use client";

import { useState } from "react";
import { HOSPITAL_CAPABILITIES, type HospitalInstitutionSettings, type HospitalInstitutionView, type SessionUser } from "@cvg/contracts";
import { ActionButton } from "@cvg/ui";
import { hospitalTimezone } from "@/lib/hospital-time";
import { usePlannerIdentity } from "./use-planner";
import { usePlannerResource } from "./use-planner-resource";
import { usePlannerCommand } from "./planner-command";
import { useDepartments } from "./use-departments";
import { ErrorState, LoadingState, PartialNotice } from "./feedback-states";

const capabilityLabels = { TASKS: "Atividades", PLANS: "Planos", SHIFTS: "Plantões", RECURRENCES: "Recorrências", CARE: "Cuidado", DOCUMENTS: "Documentos", CALENDAR: "Calendário" };
export function HospitalInstitutionConsole() {
  const { user, error } = usePlannerIdentity(); const resource = usePlannerResource<HospitalInstitutionView>(user?.id, "/hospital-institution"); const directory = useDepartments(user?.id);
  if (error || resource.error && !resource.data) return <ErrorState page title="Instituição indisponível" message={error || resource.error} onRetry={resource.reload} />;
  if (!user || !resource.data) return <LoadingState label="Carregando instituição" />;
  const may = (permission: "institution.manage" | "department.capabilities.manage") => user.permissions?.includes(permission) === true && resource.data?.permissions.includes(permission) === true;
  const settings = resource.data.settings;
  return <div className="detail-page"><h1>Instituição e capacidades</h1><p>Uma instalação representa uma instituição. Desabilitar novas atividades de um setor preserva obrigações, históricos e permissões existentes.</p>{resource.error && <PartialNotice message={resource.error} onRetry={resource.reload} />}<p>{settings?.name ?? "Instituição ainda não configurada"} · fuso {settings?.timezone ?? hospitalTimezone()}</p>{may("institution.manage") && <InstitutionForm key={`${user.id}:${settings?.version ?? 0}`} settings={settings} disabled={Boolean(resource.error)} onSaved={(value) => resource.saved({ ...resource.data!, settings: value })} />}{settings && <section className="panel"><h2>Espaços dos setores</h2>{directory.error && <PartialNotice message={directory.error} onRetry={directory.reload} />}{directory.departments.map((department) => <CapabilityForm key={`${user.id}:${department.code}:${settings.version}`} user={user} settings={settings} code={department.code} name={department.name} disabled={Boolean(resource.error) || !may("department.capabilities.manage")} onSaved={(value) => resource.saved({ ...resource.data!, settings: value })} />)}</section>}</div>;
}
function InstitutionForm({ settings, disabled, onSaved }: { settings: HospitalInstitutionSettings | null; disabled: boolean; onSaved: (value: HospitalInstitutionSettings) => void }) {
  const command = usePlannerCommand(); const [name, setName] = useState(settings?.name ?? ""); const [timezone, setTimezone] = useState(settings?.timezone ?? hospitalTimezone());
  return <form aria-label="Configurar instituição" onSubmit={(event) => { event.preventDefault(); if (disabled) return; void command.execute<HospitalInstitutionSettings>("/hospital-institution", "PUT", { name: name.trim(), timezone, expectedVersion: settings?.version ?? 0 }).then((result) => { if (result) onSaved(result); }); }}><fieldset disabled={disabled || command.busy}><legend>Identidade institucional</legend><label>Nome da instituição<input required maxLength={200} value={name} onChange={(event) => setName(event.target.value)} /></label><label>Fuso institucional IANA<input required maxLength={80} value={timezone} onChange={(event) => setTimezone(event.target.value)} /></label><p>A configuração deve corresponder ao fuso homologado da instalação; a API valida essa correspondência.</p><ActionButton type="submit" state={command.busy ? "pending" : "idle"}>Salvar instituição</ActionButton></fieldset>{command.error && <p role="alert">{command.error}</p>}</form>;
}
function CapabilityForm({ settings, code, name, disabled, onSaved }: { user: SessionUser; settings: HospitalInstitutionSettings; code: string; name: string; disabled: boolean; onSaved: (value: HospitalInstitutionSettings) => void }) {
  const current = settings.departmentCapabilities.find((entry) => entry.departmentCode === code); const [disabledNewWork, setDisabled] = useState(current?.disabledNewWork ?? []); const [archived, setArchived] = useState(current?.archived ?? false); const command = usePlannerCommand();
  return <form aria-label={`Capacidades de ${name}`} onSubmit={(event) => { event.preventDefault(); if (disabled) return; void command.execute<HospitalInstitutionSettings>(`/hospital-departments/${encodeURIComponent(code)}/capabilities`, "PUT", { disabledNewWork, archived, expectedVersion: settings.version }).then((result) => { if (result) onSaved(result); }); }}><fieldset disabled={disabled || command.busy}><legend>{name} · {code}</legend><label><input type="checkbox" checked={archived} onChange={(event) => setArchived(event.target.checked)} />Arquivar espaço para novas atividades</label><p>Desabilitar novas atividades por capacidade:</p>{HOSPITAL_CAPABILITIES.map((capability) => <label key={capability}><input type="checkbox" checked={disabledNewWork.includes(capability)} onChange={(event) => setDisabled(event.target.checked ? [...disabledNewWork, capability] : disabledNewWork.filter((entry) => entry !== capability))} />{capabilityLabels[capability]}</label>)}<ActionButton type="submit" state={command.busy ? "pending" : "idle"}>Salvar capacidades de {name}</ActionButton></fieldset>{command.error && <p role="alert">{command.error}</p>}</form>;
}
