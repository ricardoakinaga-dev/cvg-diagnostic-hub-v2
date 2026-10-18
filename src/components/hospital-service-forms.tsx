"use client";
import { useRef, useState } from "react";
import { HOSPITAL_SERVICE_KINDS, type Department, type HospitalService, type HospitalServiceKind, type ManagedUser, type Permission } from "@cvg/contracts";
import { apiFetch, createClientUniqueId, getSafeErrorMessage } from "./api-client";

export const hospitalServiceKindLabels: Record<HospitalServiceKind | "DIAGNOSTIC", string> = { CARE: "Cuidado", PROCEDURE: "Procedimento", OPERATIONAL: "Operacional", DIAGNOSTIC: "Diagnóstico" };
const allowed = (permissions: readonly Permission[], action: Permission) => permissions.includes("service.catalog.manage") || permissions.includes(action);

function useCommand(onSaved: () => void) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const pending = useRef(false);
  const intent = useRef<{ payload: string; key: string } | undefined>(undefined);
  async function execute(path: string, method: string, body: Record<string, unknown>) {
    if (pending.current) return false;
    pending.current = true; setBusy(true); setError("");
    const serialized = JSON.stringify(body); const payload = `${method}:${path}:${serialized}`;
    if (intent.current?.payload !== payload) intent.current = { payload, key: createClientUniqueId() };
    try { await apiFetch(path, { method, headers: { "idempotency-key": intent.current.key }, body: serialized }); intent.current = undefined; onSaved(); return true; }
    catch (cause) { setError(getSafeErrorMessage(cause, "Não foi possível salvar o serviço hospitalar.")); return false; }
    finally { pending.current = false; setBusy(false); }
  }
  return { busy, error, execute };
}

export function HospitalServiceForm({ service, departments, users, permissions, refreshing, onSaved }: { service?: HospitalService; departments: Department[]; users: ManagedUser[]; permissions: readonly Permission[]; refreshing: boolean; onSaved: () => void }) {
  const command = useCommand(onSaved);
  const [code, setCode] = useState(service?.code ?? ""); const [name, setName] = useState(service?.name ?? ""); const [description, setDescription] = useState(service?.description ?? "");
  const [kind, setKind] = useState<HospitalServiceKind>(service?.kind ?? "CARE"); const [departmentCode, setDepartmentCode] = useState(service?.departmentCode ?? departments.find((department) => department.active)?.code ?? "");
  const [team, setTeam] = useState<string[]>(service?.teamUserIds ?? []);
  const sector = departments.find((department) => department.code === departmentCode);
  const members = users.filter((user) => user.active && user.departmentCode === departmentCode && sector?.memberUserIds.includes(user.id));
  const canEdit = allowed(permissions, service ? "service.catalog.update" : "service.catalog.create");
  const canDeactivate = allowed(permissions, "service.catalog.deactivate");
  const blocked = refreshing || command.busy;
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (blocked || !canEdit) return;
    const common = { name: name.trim(), description: description.trim() || (service ? null : undefined), kind, departmentCode, teamUserIds: team, resourceIds: service?.resourceIds ?? [] };
    const changed = await command.execute(service ? `/hospital-services/${service.id}` : "/hospital-services", service ? "PATCH" : "POST", { ...common, ...(service ? { expectedVersion: service.version } : { code: code.trim().toUpperCase() }) });
    if (changed && !service) { setCode(""); setName(""); setDescription(""); setTeam([]); }
  }
  return <section className="panel" aria-label={service ? `Serviço hospitalar ${service.name}` : "Cadastrar serviço hospitalar"}>
    {service ? <h3>{service.name} · {service.active ? "Ativo" : "Inativo"}</h3> : <h2>Cadastrar serviço hospitalar</h2>}
    {command.error && <p role="alert">{command.error}</p>}
    {canEdit && <form aria-label={service ? `Editar ${service.name}` : "Novo serviço hospitalar"} onSubmit={(event) => void save(event)}>
      {!service && <label>Código do serviço<input value={code} maxLength={60} required onChange={(event) => setCode(event.target.value)} /></label>}
      <label>Nome do serviço<input value={name} maxLength={160} required onChange={(event) => setName(event.target.value)} /></label>
      <label>Descrição<textarea value={description} maxLength={1000} onChange={(event) => setDescription(event.target.value)} /></label>
      <label>Tipo de capacidade<select value={kind} onChange={(event) => setKind(event.target.value as HospitalServiceKind)}>{HOSPITAL_SERVICE_KINDS.map((entry) => <option key={entry} value={entry}>{hospitalServiceKindLabels[entry]}</option>)}</select></label>
      <label>Setor do serviço<select value={departmentCode} required onChange={(event) => { setDepartmentCode(event.target.value); setTeam([]); }}><option value="">Selecione um setor ativo</option>{departments.filter((department) => department.active || department.code === service?.departmentCode).map((department) => <option key={department.id} value={department.code} disabled={!department.active && department.code !== service?.departmentCode}>{department.name}{department.active ? "" : " (inativo)"}</option>)}{service && !departments.some((department) => department.code === service.departmentCode) && <option value={service.departmentCode}>{service.departmentCode}</option>}</select></label>
      <fieldset><legend>Equipe do serviço</legend><p>A equipe descreve a capacidade e mantém os acessos clínicos atuais.</p>{members.map((user) => <label key={user.id}><input type="checkbox" checked={team.includes(user.id)} onChange={(event) => setTeam((current) => event.target.checked ? [...current, user.id] : current.filter((id) => id !== user.id))} />{user.displayName}</label>)}{members.length === 0 && <p>Nenhum colaborador ativo disponível neste setor.</p>}{team.filter((id) => !members.some((user) => user.id === id)).map((id) => <p key={id}>Colaborador vinculado indisponível nesta consulta. <button type="button" disabled={blocked} onClick={() => setTeam((current) => current.filter((entry) => entry !== id))}>Retirar vínculo indisponível</button></p>)}</fieldset>
      <p>Recursos: {service?.resourceIds.length ? `${service.resourceIds.length} vinculados` : "nenhum recurso cadastrado disponível"}.</p>
      <button type="submit" disabled={blocked || !departmentCode}>{service ? "Salvar serviço" : "Cadastrar serviço"}</button>
    </form>}
    {service && (service.active ? canDeactivate : canEdit) && <button type="button" disabled={blocked || !service.active && !sector?.active} onClick={() => { if (!blocked) void command.execute(`/hospital-services/${service.id}`, "PATCH", { active: !service.active, expectedVersion: service.version }); }}>{service.active ? "Desativar serviço" : "Reativar serviço"}</button>}
  </section>;
}
