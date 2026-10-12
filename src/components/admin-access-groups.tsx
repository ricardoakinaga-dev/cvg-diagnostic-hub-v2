"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { LEGACY_PERMISSION_ACTIONS, type EffectiveAccessPreview, type AccessGroupImpactPreview, type AccessGroup, type ManagedUser, type PatientGrant, type Permission, type SessionResponse } from "@cvg/contracts";
import { ActionButton } from "@cvg/ui";
import { ApiClientError, apiFetch, getSafeErrorMessage } from "./api-client";
import { EmptyState, ErrorState, LoadingState } from "./feedback-states";
import { ReauthDialog, roleLabels } from "./admin-users";
import { describePermissions, permissionLabels } from "./admin-permission-labels";

const independentPermissions = (permissions: readonly Permission[]) => [...new Set(permissions.flatMap((permission) => [permission, ...(LEGACY_PERMISSION_ACTIONS[permission] ?? [])]))].filter((permission) => !LEGACY_PERMISSION_ACTIONS[permission]);
const privilege = (user: ManagedUser) => user.role === "ADMIN" || user.role === "SUPERADMIN";
const allowed = (session: SessionResponse, permission: Permission) => Boolean(session.user.permissions?.includes(permission) || session.user.permissions?.includes("user_role.manage"));
class DiscardedAccessResponse extends Error {}

function PermissionEditor({ selected, options, onChange, disabled }: { selected: Permission[]; options: Permission[]; onChange: (permissions: Permission[]) => void; disabled?: boolean }) {
  return <fieldset className="admin-create-form" disabled={disabled}><legend>Ações independentes</legend><p>Visualizar, criar, alterar e desativar são concessões separadas. O perfil clínico e os escopos continuam limitando cada ação.</p>{options.map((permission) => <label className="admin-check" key={permission}><input type="checkbox" checked={selected.includes(permission)} onChange={(event) => onChange(event.target.checked ? [...selected, permission] : selected.filter((value) => value !== permission))} />{permissionLabels[permission]}</label>)}</fieldset>;
}

function EffectivePreview({ value }: { value: EffectiveAccessPreview }) {
  return <section className="panel" aria-label="Prévia do acesso efetivo"><h3>Prévia de {roleLabels[value.role]}</h3><p>Origem: {value.origin === "GROUP" ? `grupo ${value.accessGroupId}, ${value.groupActive ? "ativo" : "inativo"}` : "perfil legado"}. Setor {value.scopes.departmentCode}; {value.scopes.patientCount} pacientes concedidos; {value.scopes.serviceCodes.length} exames selecionados.</p><p>Concessões: {describePermissions(value.permissions)}.</p><p>Adicionadas: {describePermissions(value.addedPermissions)}. Retiradas: {describePermissions(value.removedPermissions)}.</p>{value.deniedByProfile.length > 0 && <p>Negadas pelo perfil: {describePermissions(value.deniedByProfile)}.</p>}<ul>{value.restrictions.map((restriction) => <li key={restriction}>{restriction}</li>)}</ul></section>;
}

function GroupImpact({ value }: { value: AccessGroupImpactPreview }) {
  return <section className="panel" aria-label="Impacto previsto do grupo"><h3>Antes de salvar</h3><p>{value.boundUserCount} colaborador(es) vinculado(s); {value.affectedUserCount} com mudança de permissões, sendo {value.activeAffectedUserCount} ativo(s).</p><p>O grupo ficará {value.proposedActive ? "ativo" : "inativo"}. Perfis e escopos continuam limitando o acesso; inativar o grupo não inativa as contas.</p>{value.requiresReauthentication && <p>Esta alteração afeta acesso administrativo e exige confirmação de identidade antes de salvar.</p>}<ul>{value.users.map((user) => <li key={user.userId}><strong>{user.displayName}</strong> · {roleLabels[user.role]} · {user.active ? "conta ativa" : "conta inativa, acesso continua bloqueado"}<p>Setor {user.departmentCode}; setores delegados: {user.managedDepartmentCodes.join(", ") || "nenhum"}; exames selecionados: {user.serviceCodes.join(", ") || "nenhum"}; {user.patientCount} paciente(s) concedido(s).</p><p>Adicionadas: {describePermissions(user.addedPermissions)}. Retiradas: {describePermissions(user.removedPermissions)}. Concessões restantes: {describePermissions(user.permissions)}.</p>{!user.effectiveAccessChanges && <p>Sem mudança de acesso efetivo.</p>}</li>)}</ul></section>;
}

export function AdminAccessGroups() {
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [groups, setGroups] = useState<AccessGroup[]>([]);
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [options, setOptions] = useState<Permission[]>([]);
  const [loading, setLoading] = useState(true);
  const [readReady, setReadReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [toggleOnly, setToggleOnly] = useState(false);
  const [groupActive, setGroupActive] = useState(true);
  const [groupImpact, setGroupImpact] = useState<{ candidateKey: string; value: AccessGroupImpactPreview } | null>(null);
  const [editing, setEditing] = useState<AccessGroup | null>(null);
  const [code, setCode] = useState("");
  const [description, setDescription] = useState("");
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [userId, setUserId] = useState("");
  const [groupId, setGroupId] = useState("");
  const [preview, setPreview] = useState<EffectiveAccessPreview | null>(null);
  const [grants, setGrants] = useState<PatientGrant[]>([]);
  const [patientId, setPatientId] = useState("");
  const [reason, setReason] = useState("");
  const [authorize, setAuthorize] = useState<(() => Promise<void>) | null>(null);
  const submitting = useRef(false);
  const loadVersion = useRef(0);
  const authority = useRef({ epoch: 0, identity: "", ready: false });
  const clearSnapshot = useCallback((identity = "") => {
    authority.current = { epoch: authority.current.epoch + 1, identity, ready: false };
    setReadReady(false);
    submitting.current = false; setBusy(false); setSession(null); setGroups([]); setUsers([]); setOptions([]);
    setEditing(null); setToggleOnly(false); setGroupActive(true); setCode(""); setDescription(""); setPermissions([]);
    setUserId(""); setGroupId(""); setPreview(null); setGroupImpact(null); setGrants([]); setPatientId(""); setReason(""); setAuthorize(null); setNotice("");
  }, []);
  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    authority.current.ready = false; setReadReady(false); setLoading(true);
    try {
      const identity = await apiFetch<SessionResponse>("/session/me");
      if (loadVersion.current !== version) return;
      const key = JSON.stringify([identity.user.id, identity.user.role, identity.user.permissions]);
      if (authority.current.identity && authority.current.identity !== key) clearSnapshot(key);
      authority.current.identity = key;
      setSession(identity);
      if (!allowed(identity, "access_group.view")) { clearSnapshot(key); setError("Você não tem permissão para visualizar grupos de acesso."); return; }
      const [groupList, permissionList, userList] = await Promise.all([apiFetch<AccessGroup[]>("/access-groups"), apiFetch<Permission[]>("/access-groups/permissions"), allowed(identity, "user.view") ? apiFetch<ManagedUser[]>("/users") : Promise.resolve([])]);
      if (loadVersion.current !== version) return;
      authority.current.ready = true;
      setReadReady(true);
      setGroups(groupList); setOptions(permissionList); setUsers(userList); setError("");
    } catch (cause) { if (loadVersion.current === version) { if (cause instanceof ApiClientError && [401, 403, 404].includes(cause.status)) clearSnapshot(); setError(getSafeErrorMessage(cause, "Não foi possível carregar os grupos.")); } }
    finally { if (loadVersion.current === version) setLoading(false); }
  }, [clearSnapshot]);
  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    const refresh = () => { setGroupImpact(null); setPreview(null); void load(); };
    window.addEventListener("cvg:realtime-updated", refresh); window.addEventListener("cvg:realtime-resync", refresh);
    return () => { window.clearTimeout(timer); loadVersion.current += 1; authority.current.epoch++; authority.current.ready = false; window.removeEventListener("cvg:realtime-updated", refresh); window.removeEventListener("cvg:realtime-resync", refresh); };
  }, [load]);
  const selectedUser = users.find((user) => user.id === userId);
  async function fetchCurrent<T>(path: string, init?: RequestInit): Promise<T> {
    const epoch = authority.current.epoch;
    if (!authority.current.ready) throw new DiscardedAccessResponse();
    try { const result = await apiFetch<T>(path, init); if (epoch !== authority.current.epoch || !authority.current.ready) throw new DiscardedAccessResponse(); return result; }
    catch (cause) { if (epoch !== authority.current.epoch) throw new DiscardedAccessResponse(); throw cause; }
  }
  const execute = async (action: () => Promise<void>, propagate = false) => {
    if (submitting.current || !authority.current.ready) return;
    const epoch = authority.current.epoch;
    submitting.current = true; setBusy(true); setError(""); setNotice("");
    try { await action(); if (epoch === authority.current.epoch) await load(); }
    catch (cause) { if (cause instanceof DiscardedAccessResponse || epoch !== authority.current.epoch) return; setGroupImpact(null); if (cause instanceof ApiClientError && [401, 403, 404].includes(cause.status)) { loadVersion.current++; clearSnapshot(); } setError(getSafeErrorMessage(cause, "Não foi possível salvar a alteração.")); if (propagate) throw cause; }
    finally { if (epoch === authority.current.epoch) { submitting.current = false; setBusy(false); } }
  };
  const confirmAction = (action: () => Promise<void>) => {
    const epoch = authority.current.epoch;
    setAuthorize(() => async () => { if (epoch === authority.current.epoch) await execute(action, true); });
  };
  const edit = (group: AccessGroup | null, toggle = false) => { setEditing(group); setToggleOnly(toggle); setGroupActive(toggle ? !group!.active : group?.active ?? true); setCode(group?.code ?? ""); setDescription(group?.description ?? ""); setPermissions(independentPermissions(group?.permissions ?? [])); setPreview(null); setGroupImpact(null); };
  const candidate = editing ? toggleOnly ? { active: groupActive, expectedVersion: editing.version } : { description, permissions, expectedVersion: editing.version } : null;
  const candidateKey = JSON.stringify({ groupId: editing?.id, candidate });
  const validImpact = groupImpact?.candidateKey === candidateKey && groupImpact.value.groupVersion === editing?.version ? groupImpact.value : null;
  const previewImpact = () => {
    if (!editing || !candidate) return;
    void execute(async () => { const value = await fetchCurrent<AccessGroupImpactPreview>(`/access-groups/${editing.id}/preview`, { method: "POST", body: JSON.stringify(candidate) }); setGroupImpact({ candidateKey, value }); });
  };
  const reloadGroupRevision = () => {
    if (!editing) return;
    void execute(async () => {
      const latest = (await fetchCurrent<AccessGroup[]>("/access-groups")).find((group) => group.id === editing.id);
      if (!latest) throw new Error("Grupo indisponível.");
      setEditing(latest); setGroupImpact(null); setNotice("Revisão atualizada. Sua proposta foi mantida; confira novamente o impacto antes de salvar.");
    });
  };
  const saveGroup = (event: FormEvent) => {
    event.preventDefault();
    if (!authority.current.ready) return;
    if (editing && !validImpact) { setError("Confira o impacto atual do grupo antes de salvar."); return; }
    const action = async () => {
      await fetchCurrent<AccessGroup>(editing ? `/access-groups/${editing.id}` : "/access-groups", { method: editing ? "PATCH" : "POST", body: JSON.stringify(editing ? { ...candidate, expectedImpactToken: validImpact!.impactToken } : { code, description, permissions }) });
      const notice = toggleOnly ? groupActive ? "Grupo reativado. Os vínculos recuperaram somente as permissões compatíveis com seus perfis." : "Grupo inativado. As contas permanecem cadastradas e as permissões do grupo foram retiradas." : "Grupo salvo. Os vínculos afetados foram reavaliados.";
      edit(null); setNotice(notice);
    };
    if (validImpact?.requiresReauthentication) confirmAction(action); else void execute(action);
  };
  const toggleGroup = (group: AccessGroup) => edit(group, true);
  const showPreview = () => void execute(async () => { const response = await fetchCurrent<EffectiveAccessPreview>(`/users/${userId}/access-preview`, { method: "POST", body: JSON.stringify({ ...(groupId ? { accessGroupId: groupId } : {}), ...(editing?.id === groupId ? { permissions } : {}) }) }); setPreview(response); });
  const assign = () => {
    if (!selectedUser) return;
    const action = async () => { await fetchCurrent(`/users/${userId}/access-group`, { method: "PUT", body: JSON.stringify({ accessGroupId: groupId, expectedVersion: preview?.userVersion ?? selectedUser.version, expectedGroupVersion: preview?.groupVersion }) }); setPreview(null); setNotice("Vínculo salvo e sessões anteriores revogadas."); };
    if (privilege(selectedUser)) confirmAction(action); else void execute(action);
  };
  const changeScope = (active: boolean, identifier = patientId) => {
    if (!selectedUser) return;
    void execute(async () => { await fetchCurrent(`/users/${userId}/patient-grants`, { method: "PUT", body: JSON.stringify({ patientId: identifier, active, reason, expectedVersion: selectedUser.version }) }); setGrants(await fetchCurrent<PatientGrant[]>(`/users/${userId}/patient-grants`)); setPatientId(""); setReason(""); setNotice(active ? "Escopo concedido. A próxima sessão poderá acessar este paciente." : "Escopo retirado e sessões anteriores revogadas."); });
  };
  if (loading && !session) return <LoadingState label="Carregando grupos de acesso" />;
  if (!session || !allowed(session, "access_group.view")) return <ErrorState title="Acesso indisponível" message={error} onRetry={() => void load()} />;
  return <div className="page-content"><header className="page-heading"><h1>Grupos e permissões</h1><p>Um grupo base por colaborador, limitado pelo perfil e pelos escopos assistenciais.</p><Link href="/admin/users">Voltar aos colaboradores</Link></header>{error && <p className="form-alert" role="alert">{error} <button type="button" onClick={() => void load()}>Recarregar grupos de acesso</button></p>}{notice && <p role="status">{notice}</p>}<fieldset disabled={!readReady} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
    <section className="panel"><h2>Grupos cadastrados</h2>{groups.length === 0 ? <EmptyState title="Nenhum grupo" message="Cadastre um grupo com as ações necessárias." /> : <div className="admin-list">{groups.map((group) => <div key={group.id} className="admin-row"><strong>{group.code}</strong><p>{group.description} · revisão {group.version} · {group.active ? "ativo" : "inativo"}</p>{allowed(session, "access_group.update") && <button className="button button-ghost" disabled={busy || !!authorize} onClick={() => edit(group)}>Editar {group.code}</button>}{allowed(session, group.active ? "access_group.deactivate" : "access_group.update") && <button className="button button-ghost" disabled={busy || !!authorize} onClick={() => toggleGroup(group)}>{group.active ? "Inativar" : "Reativar"} {group.code}</button>}</div>)}</div>}</section>
    {allowed(session, editing ? toggleOnly && !groupActive ? "access_group.deactivate" : "access_group.update" : "access_group.create") && <section className="panel"><h2>{editing ? `Editar ${editing.code}` : "Criar grupo"}</h2><form onSubmit={saveGroup} aria-label="Matriz do grupo"><label>Código<input value={code} onChange={(event) => setCode(event.target.value)} disabled={!!editing} maxLength={60} required /></label><label>Descrição<input value={description} onChange={(event) => { setDescription(event.target.value); setGroupImpact(null); }} disabled={toggleOnly || busy || !!authorize} maxLength={160} required /></label><PermissionEditor selected={permissions} options={options} onChange={(values) => { setPermissions(values); setGroupImpact(null); }} disabled={toggleOnly || busy || !!authorize} />{editing && <><button type="button" disabled={busy || !!authorize} onClick={previewImpact}>Ver impacto do grupo</button><button type="button" disabled={busy || !!authorize} onClick={reloadGroupRevision}>Atualizar revisão para comparar</button>{validImpact && <GroupImpact value={validImpact} />}</>}<ActionButton type="submit" state={busy ? "pending" : "idle"} disabled={!!authorize || !!editing && !validImpact}>{editing ? toggleOnly ? groupActive ? "Confirmar reativação do grupo" : "Confirmar inativação do grupo" : "Salvar grupo" : "Criar grupo"}</ActionButton>{editing && <button className="button button-ghost" type="button" disabled={busy} onClick={() => edit(null)}>Cancelar edição</button>}</form></section>}
    <section className="panel"><h2>Vínculo e prévia</h2><label>Colaborador<select value={userId} disabled={busy || !!authorize} onChange={(event) => { if (submitting.current || authorize || !authority.current.ready) return; setUserId(event.target.value); setGroupId(users.find((user) => user.id === event.target.value)?.accessGroupId ?? ""); setPreview(null); setGrants([]); }}><option value="">Selecione</option>{users.map((user) => <option key={user.id} value={user.id}>{user.displayName} · {roleLabels[user.role]}</option>)}</select></label><label>Grupo base<select value={groupId} disabled={busy || !!authorize} onChange={(event) => { if (submitting.current || authorize || !authority.current.ready) return; setGroupId(event.target.value); setPreview(null); }}><option value="">Perfil legado</option>{groups.map((group) => <option value={group.id} key={group.id} disabled={!group.active}>{group.code}{!group.active && " (inativo)"}</option>)}</select></label><button className="button button-ghost" disabled={!selectedUser || busy} onClick={showPreview}>Ver prévia do acesso</button>{allowed(session, "access_group.assign") && <button className="button button-primary" disabled={!selectedUser || !groupId || busy || !!authorize || selectedUser.id === session.user.id} onClick={assign}>Salvar vínculo</button>}{preview && <EffectivePreview value={preview} />}</section>
    {selectedUser && allowed(session, "patient_scope.manage") && ["VETERINARIAN", "INPATIENT_TEAM", "VIEWER"].includes(selectedUser.role) && <section className="panel"><h2>Escopo assistencial</h2><p>Atribuir uma tarefa ou responsável não concede o paciente. Use o identificador confirmado pelo hospital; esta tela não mostra dados clínicos.</p><button className="button button-ghost" disabled={busy} onClick={() => void execute(async () => setGrants(await fetchCurrent<PatientGrant[]>(`/users/${userId}/patient-grants`)))}>Carregar concessões</button><label>Identificador do paciente<input value={patientId} onChange={(event) => setPatientId(event.target.value)} maxLength={100} /></label><label>Motivo contextual<input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} /></label><button className="button button-primary" disabled={!patientId.trim() || !reason.trim() || busy} onClick={() => changeScope(true)}>Conceder paciente</button>{grants.map((grant) => <div key={grant.id}><code>{grant.patientId}</code> · {grant.active ? "concedido" : "retirado"} · {grant.source}{grant.active && <button className="button button-ghost" disabled={!reason.trim() || busy} onClick={() => changeScope(false, grant.patientId)}>Retirar {grant.patientId}</button>}</div>)}</section>}
    {authorize && <ReauthDialog onClose={() => setAuthorize((current) => current === authorize ? null : current)} onConfirmed={authorize} privilegedRole={selectedUser?.role === "SUPERADMIN" ? "SUPERADMIN" : "ADMIN"} />}
  </fieldset></div>;
}
