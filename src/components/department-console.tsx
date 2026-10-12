"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Department, DepartmentType, ManagedUser, Permission, SessionResponse, SessionUser } from "@cvg/contracts";
import { DEPARTMENT_TYPES } from "@cvg/contracts";
import { ActionButton } from "@cvg/ui";
import { apiFetch, createClientUniqueId, getSafeErrorMessage } from "./api-client";
import { EmptyState, ErrorState, LoadingState } from "./feedback-states";
import { useDepartments } from "./use-departments";
import { WorkActivityDisclosure } from "./work-activity-controls";
import { PlannerTargetReference } from "./planner-target-reference";
import { useConfirm } from "./confirm-dialog";

const typeLabels: Record<DepartmentType, string> = { CLINICAL: "Clínico", DIAGNOSTIC: "Diagnóstico", ADMINISTRATIVE: "Administrativo", SUPPORT: "Apoio" };

function useDepartmentCommand(onSaved: (department: Department) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const intent = useRef<{ payload: string; key: string } | undefined>(undefined);
  async function execute(path: string, method: string, body: Record<string, unknown>) {
    if (pending.current) return false;
    pending.current = true; setBusy(true); setError("");
    const serialized = JSON.stringify(body);
    const payload = `${method}:${path}:${serialized}`;
    if (intent.current?.payload !== payload) intent.current = { payload, key: createClientUniqueId() };
    try {
      const department = await apiFetch<Department>(path, { method, headers: { "idempotency-key": intent.current.key }, body: serialized });
      intent.current = undefined; onSaved(department); return true;
    } catch (cause) { setError(getSafeErrorMessage(cause, "Não foi possível salvar o setor.")); return false; }
    finally { pending.current = false; setBusy(false); }
  }
  return { busy, error, execute };
}

export function DepartmentConsole() {
  const [identity, setIdentity] = useState<SessionUser>();
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [sessionError, setSessionError] = useState("");
  const [usersError, setUsersError] = useState("");
  const [notice, setNotice] = useState("");
  const directory = useDepartments(identity?.id, { includeInactive: true });
  const permissions = identity?.permissions ?? [];
  const mayRead = permissions.includes("department.view");
  const mayManageMembers = permissions.includes("department.members.manage");
  useEffect(() => {
    const controller = new AbortController();
    void apiFetch<SessionResponse>("/session/me", { signal: controller.signal }).then(({ user }) => { if (!controller.signal.aborted) setIdentity(user); }).catch((cause: unknown) => { if (!controller.signal.aborted) setSessionError(getSafeErrorMessage(cause, "Não foi possível consultar seu acesso.")); });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!identity || !mayManageMembers) return;
    const controller = new AbortController();
    const load = () => { void apiFetch<ManagedUser[]>("/users", { signal: controller.signal }).then((result) => { if (!controller.signal.aborted) { setUsers(result); setUsersError(""); } }).catch((cause: unknown) => { if (!controller.signal.aborted) { setUsers([]); setUsersError(getSafeErrorMessage(cause, "Colaboradores indisponíveis. Atualize antes de alterar a equipe.")); } }); };
    load(); window.addEventListener("cvg:realtime-updated", load);
    return () => { controller.abort(); window.removeEventListener("cvg:realtime-updated", load); };
  }, [identity, mayManageMembers]);
  function saved(department: Department) {
    setNotice(`Setor ${department.name} salvo.`);
    window.dispatchEvent(new Event("cvg:departments-updated"));
  }
  if (sessionError) return <ErrorState title="Setores indisponíveis" message={sessionError} onRetry={() => window.location.reload()} />;
  if (!identity) return <LoadingState label="Carregando setores" />;
  if (!mayRead) return <ErrorState title="Setores fora do seu escopo" message="Você não tem acesso a este recurso." onRetry={() => window.location.reload()} />;
  return <div className="admin-page">
    <div className="page-heading"><div><h1>Setores</h1><p className="page-lede">Cadastro institucional, equipes e responsáveis.</p></div><ActionButton tone="ghost" state={directory.loading ? "pending" : "idle"} onClick={() => void directory.reload()}>Atualizar setores</ActionButton></div>
    {notice && <p className="form-notice" role="status">{notice}</p>}
    <PlannerTargetReference userId={identity.id} parameter="departmentId" prefix="department-" ids={directory.departments.map((department) => department.id)} loading={directory.loading} error={directory.error} />
    {directory.error && <ErrorState title="Cadastro indisponível" message={directory.error} onRetry={directory.reload} />}
    {usersError && <p className="form-alert" role="alert">{usersError}</p>}
    {permissions.includes("department.create") && <section className="panel"><h2>Novo setor</h2><DepartmentCreateForm onSaved={saved} /></section>}
    <section className="panel"><div className="panel-heading"><h2>Setores autorizados</h2><span className="timeline-count">{directory.departments.length}</span></div>
      {directory.loading && !directory.departments.length ? <LoadingState label="Carregando cadastro" /> : !directory.departments.length && !directory.error ? <EmptyState title="Nenhum setor autorizado" message="Novos setores ficam disponíveis conforme seu escopo." /> : <div className="admin-list">{directory.departments.map((department) => <DepartmentRow key={`${identity.id}:${department.id}:${department.version}`} user={identity} department={department} users={users} permissions={permissions} usersUnavailable={Boolean(usersError)} onSaved={saved} />)}</div>}
    </section>
  </div>;
}

function DepartmentCreateForm({ onSaved }: { onSaved: (department: Department) => void }) {
  const [code, setCode] = useState(""); const [name, setName] = useState(""); const [type, setType] = useState<DepartmentType>("CLINICAL");
  const command = useDepartmentCommand(onSaved);
  async function save(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (await command.execute("/departments", "POST", { code: code.trim().toUpperCase(), name: name.trim(), type })) { setCode(""); setName(""); } }
  return <form className="admin-create-form" aria-label="Criar setor" onSubmit={(event) => void save(event)}>
    <label>Código do setor<input value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} pattern="[A-Z0-9_-]+" minLength={1} maxLength={60} required /></label><small className="field-hint">Identificador permanente. O código não pode ser alterado após a criação.</small>
    <label>Nome do setor<input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required /></label><DepartmentTypeField value={type} onChange={setType} />
    {command.error && <p role="alert" className="form-alert">{command.error}</p>}<ActionButton type="submit" state={command.busy ? "pending" : "idle"}>Criar setor</ActionButton>
  </form>;
}

function DepartmentTypeField({ value, onChange, disabled }: { value: DepartmentType; onChange: (type: DepartmentType) => void; disabled?: boolean }) {
  return <label>Tipo de setor<select value={value} onChange={(event) => onChange(event.target.value as DepartmentType)} disabled={disabled}>{DEPARTMENT_TYPES.map((type) => <option key={type} value={type}>{typeLabels[type]}</option>)}</select></label>;
}

function DepartmentRow({ user, department, users, permissions, usersUnavailable, onSaved }: { user: SessionUser; department: Department; users: ManagedUser[]; permissions: Permission[]; usersUnavailable: boolean; onSaved: (department: Department) => void }) {
  const [name, setName] = useState(department.name); const [type, setType] = useState(department.type);
  const [members, setMembers] = useState(department.memberUserIds); const [responsible, setResponsible] = useState(department.responsibleUserId ?? "");
  const command = useDepartmentCommand(onSaved); const confirmation = useConfirm();
  const update = permissions.includes("department.update"); const manageMembers = department.active && permissions.includes("department.members.manage");
  const eligible = users.filter((user) => user.active && user.departmentCode === department.code);
  const unavailable = members.filter((id) => !eligible.some((user) => user.id === id));
  async function deactivate() { if (command.busy) return; if (await confirmation.confirm({ title: `Desativar ${department.name}?`, message: "Novos vínculos serão bloqueados. O histórico e os vínculos existentes serão preservados.", confirmLabel: "Desativar setor", tone: "danger" })) await command.execute(`/departments/${department.id}/deactivate`, "POST", { expectedVersion: department.version }); }
  function toggleMember(id: string, checked: boolean) { setMembers((current) => checked ? [...current, id] : current.filter((member) => member !== id)); if (!checked && responsible === id) setResponsible(""); }
  return <article id={`department-${department.id}`} tabIndex={-1} className="admin-row" aria-label={`Setor ${department.name}`}>
    <div className="admin-row-heading"><strong>{department.name}</strong><span className={department.active ? "text-success" : "text-danger"}>{department.active ? "Ativo" : "Desativado"}</span></div><p><span className="mono">{department.code}</span> · {typeLabels[department.type]} · versão {department.version}</p>
    <form aria-label={`Editar setor ${department.code}`} onSubmit={(event) => { event.preventDefault(); void command.execute(`/departments/${department.id}`, "PATCH", { name: name.trim(), type, expectedVersion: department.version }); }}>
      <label>Nome do setor<input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required disabled={!update || command.busy} /></label><DepartmentTypeField value={type} onChange={setType} disabled={!update || command.busy} />
      {update && <ActionButton type="submit" tone="ghost" state={command.busy ? "pending" : "idle"}>Salvar setor</ActionButton>}
    </form>
    <section aria-label={`Equipe ${department.code}`}><h3>Equipe e responsável</h3><p className="field-hint">Participação e responsabilidade não concedem acesso a pacientes.</p>
      {manageMembers ? <form aria-label={`Equipe do setor ${department.code}`} onSubmit={(event) => { event.preventDefault(); void command.execute(`/departments/${department.id}/members`, "PUT", { memberUserIds: members, responsibleUserId: responsible || null, expectedVersion: department.version }); }}>
        <fieldset disabled={command.busy || usersUnavailable}><legend>Membros ativos vinculados ao setor</legend>{eligible.map((user) => <label className="admin-check" key={user.id}><input type="checkbox" checked={members.includes(user.id)} onChange={(event) => toggleMember(user.id, event.target.checked)} />{user.displayName}</label>)}{unavailable.map((id) => <label className="admin-check" key={id}><input type="checkbox" checked onChange={(event) => toggleMember(id, event.target.checked)} />Membro indisponível ({id})</label>)}{!eligible.length && !unavailable.length && <p>Nenhum colaborador ativo vinculado a este setor.</p>}
          <label>Responsável<select value={responsible} onChange={(event) => setResponsible(event.target.value)}><option value="">Sem responsável</option>{eligible.filter((user) => members.includes(user.id)).map((user) => <option key={user.id} value={user.id}>{user.displayName}</option>)}{responsible && !eligible.some((user) => user.id === responsible) && <option value={responsible} disabled>Responsável indisponível</option>}</select></label>
          <ActionButton type="submit" tone="ghost" state={command.busy ? "pending" : "idle"}>Salvar equipe</ActionButton>
        </fieldset>
      </form> : <p>{members.length} membro(s) · {users.find((user) => user.id === responsible)?.displayName ?? (responsible ? "Responsável definido" : "Sem responsável")}</p>}
    </section>
    {command.error && <p className="form-alert" role="alert">{command.error}</p>}
    {department.active && permissions.includes("department.deactivate") && <ActionButton type="button" tone="ghost" state={command.busy ? "pending" : "idle"} onClick={() => void deactivate()}>Desativar setor</ActionButton>}
    {!department.active && update && <ActionButton type="button" tone="ghost" state={command.busy ? "pending" : "idle"} onClick={() => void command.execute(`/departments/${department.id}`, "PATCH", { active: true, expectedVersion: department.version })}>Reativar setor</ActionButton>}
    {confirmation.dialog}
  <WorkActivityDisclosure user={user} targetType="DEPARTMENT" targetId={department.id} readOnly={command.busy} /></article>;
}
