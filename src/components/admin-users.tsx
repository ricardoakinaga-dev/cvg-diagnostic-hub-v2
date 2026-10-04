"use client";

import { useId, useRef, useState, type FormEvent, type MouseEvent, type RefObject } from "react";
import { ROLES, type DiagnosticService, type ManagedUser, type RoleCode, type SessionUser } from "@cvg/contracts";
import { ActionButton } from "@cvg/ui";
import { apiFetch, getSafeErrorMessage } from "./api-client";
import { useDialogFocus } from "./use-dialog-focus";

export const roleLabels: Record<RoleCode, string> = {
  ADMIN: "Administração técnica", MANAGER: "Gestão operacional", VETERINARIAN: "Veterinária",
  INPATIENT_TEAM: "Equipe de internação", LAB_TECH: "Técnica de laboratório",
  RADIOLOGY_TEAM: "Equipe de radiologia", ULTRASOUND_TEAM: "Equipe de ultrassom", VIEWER: "Visualização operacional"
};

const departmentLabels: Record<string, string> = {
  LABORATORY: "Laboratório", INPATIENT: "Internação", RADIOLOGY: "Radiologia", ULTRASOUND: "Ultrassom", IT: "TI"
};

function managedCodes(value: string): string[] {
  return [...new Set(value.split(",").map((code) => code.trim().toUpperCase()).filter(Boolean))];
}

function ProfileField({ value, technical, onChange }: { value: RoleCode; technical: boolean; onChange: (role: RoleCode) => void }) {
  const options = technical ? ROLES : ROLES.filter((role) => role !== "ADMIN" && role !== "MANAGER");
  return <label>Perfil<select value={value} onChange={(event) => onChange(event.target.value as RoleCode)}>{options.map((role) => <option key={role} value={role}>{roleLabels[role]}</option>)}</select></label>;
}

function ManagedDepartments({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <details className="admin-create"><summary>Opções avançadas</summary><label>Setores gerenciados<input value={value} onChange={(event) => onChange(event.target.value)} maxLength={1200} placeholder="LABORATORY, RADIOLOGY, ULTRASOUND" /></label></details>;
}

const executor = (role: RoleCode) => ["LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM"].includes(role);

function ServiceAssignments({ services, departmentCode, selected, onChange }: { services: DiagnosticService[]; departmentCode: string; selected: string[]; onChange: (codes: string[]) => void }) {
  const available = services.filter((service) => service.departmentCode === departmentCode);
  return <details className="admin-create"><summary>Exames autorizados</summary><fieldset className="admin-create-form"><legend>Exames que o colaborador pode executar</legend>{available.map((service) => <label className="admin-check" key={service.id}><input type="checkbox" checked={selected.includes(service.code)} onChange={(event) => onChange(event.target.checked ? [...new Set([...selected, service.code])] : selected.filter((code) => code !== service.code))} />{service.name}</label>)}{available.length === 0 && <p>Nenhum exame configurado neste setor. Defina o setor na linha do colaborador para atribuir os exames.</p>}</fieldset></details>;
}

function ReauthDialog({ onClose, onConfirmed, recovering = false }: { onClose: () => void; onConfirmed: () => Promise<void>; recovering?: boolean }) {
  const id = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState("");
  const close = () => { if (!submitting.current) onClose(); };
  useDialogFocus(dialogRef, close, passwordRef);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setError("");
    let authenticated = false;
    try {
      await apiFetch("/session/reauth", { method: "POST", body: JSON.stringify({ password }) });
      authenticated = true; setPassword("");
      await onConfirmed();
      onClose();
    } catch (cause) { setError(getSafeErrorMessage(cause, authenticated ? "Não foi possível salvar a alteração." : "Não foi possível confirmar sua senha.")); }
    finally { submitting.current = false; setBusy(false); }
  }
  return <div className="dialog-backdrop"><section ref={dialogRef} className="dialog" role="dialog" aria-modal="true" aria-labelledby={id}><h2 id={id}>{recovering ? "Confirmar recuperação de ADMIN" : "Confirmar alteração de ADMIN"}</h2><p>{recovering ? "Confirme sua senha para recuperar o acesso desta conta de administração técnica." : "Confirme sua senha para conceder ou remover acesso de administração técnica."}</p><form onSubmit={(event) => void submit(event)}><label>Senha para reautenticar<input ref={passwordRef} type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" maxLength={200} required /></label>{error && <p className="form-alert" role="alert">{error}</p>}<div className="dialog-actions"><button type="button" className="button button-ghost" disabled={busy} onClick={close}>Cancelar</button><ActionButton type="submit" state={busy ? "pending" : "idle"} disabled={!password}>Confirmar</ActionButton></div></form></section></div>;
}

function InitialPasswordDialog({ password, onClose, regenerated = false, returnFocusRef }: { password: string; onClose: () => void; regenerated?: boolean; returnFocusRef?: RefObject<HTMLElement | null> }) {
  const id = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  useDialogFocus(dialogRef, onClose, closeRef, returnFocusRef);
  async function copy() {
    try { await navigator.clipboard.writeText(password); setNotice("Senha copiada."); setError(""); }
    catch { setError("Não foi possível copiar. Selecione e copie a senha exibida."); }
  }
  return <div className="dialog-backdrop"><section ref={dialogRef} className="dialog" role="dialog" aria-modal="true" aria-labelledby={id}><h2 id={id}>{regenerated ? "Nova senha temporária" : "Senha inicial"}</h2><p>Copie e entregue ao colaborador. Esta senha será exibida uma vez; a troca é obrigatória no primeiro login.</p><output className="admin-initial-password" aria-label="Senha inicial gerada">{password}</output>{notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}<div className="dialog-actions"><button type="button" className="button button-primary" onClick={() => void copy()}>Copiar senha</button><button ref={closeRef} type="button" className="button button-ghost" onClick={onClose}>Fechar</button></div></section></div>;
}

export function UserCreateForm({ creator, onCreated, services = [] }: { creator: SessionUser; onCreated: (user: ManagedUser) => void; services?: DiagnosticService[] }) {
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<RoleCode>("LAB_TECH");
  const [managed, setManaged] = useState("");
  const [serviceCodes, setServiceCodes] = useState<string[]>([]);
  const [initialPassword, setInitialPassword] = useState<string | null>(null);
  const [authorize, setAuthorize] = useState<(() => Promise<void>) | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState("");
  const technical = creator.role === "ADMIN";
  async function create(payload: object, propagateFailure = false) {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setError("");
    try {
      const response = await apiFetch<ManagedUser & { initialPassword?: string }>("/users", { method: "POST", body: JSON.stringify(payload) });
      const { initialPassword: generatedPassword, ...user } = response;
      setInitialPassword(generatedPassword ?? null);
      onCreated(user);
      setDisplayName(""); setEmail(""); setManaged(""); setServiceCodes([]);
    } catch (cause) { setError(getSafeErrorMessage(cause, "Não foi possível adicionar o colaborador.")); if (propagateFailure) throw cause; }
    finally { submitting.current = false; setBusy(false); }
  }
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || authorize || initialPassword) return;
    const payload = { serviceCodes: executor(role) && serviceCodes.length ? serviceCodes : undefined, displayName: displayName.trim(), email: email.trim(), role, departmentCode: creator.departmentCode, managedDepartmentCodes: technical && role === "MANAGER" ? managedCodes(managed) : undefined };
    if (role === "ADMIN") setAuthorize(() => () => create(payload, true));
    else void create(payload);
  }
  return <><form className="admin-create-form" aria-label="Adicionar colaborador" onSubmit={save}><label>Nome completo<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} minLength={2} maxLength={160} required /></label><label>E-mail institucional<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} maxLength={320} required /></label><ProfileField value={role} technical={technical} onChange={setRole} />{technical && role === "MANAGER" && <ManagedDepartments value={managed} onChange={setManaged} />}{executor(role) && <ServiceAssignments services={services} departmentCode={creator.departmentCode} selected={serviceCodes} onChange={setServiceCodes} />}{error && <p className="form-alert" role="alert">{error}</p>}<ActionButton type="submit" state={busy ? "pending" : "idle"} disabled={!!initialPassword || !!authorize}>Criar acesso</ActionButton></form>{authorize && <ReauthDialog onClose={() => setAuthorize(null)} onConfirmed={authorize} />}{initialPassword && <InitialPasswordDialog password={initialPassword} onClose={() => setInitialPassword(null)} />}</>;
}

interface AccessDraft { role: RoleCode; departmentCode: string; active: boolean; managed: string; serviceCodes: string[] }

export function UserRow({ user, technical, viewerId, onChanged, services = [], departmentCodes = [] }: { user: ManagedUser; technical: boolean; viewerId: string; onChanged: (user: ManagedUser) => void; services?: DiagnosticService[]; departmentCodes?: string[] }) {
  const [draft, setDraft] = useState<AccessDraft | null>(null);
  const fields = draft ?? { role: user.role, departmentCode: user.departmentCode, active: user.active, managed: user.managedDepartmentCodes?.join(", ") ?? "", serviceCodes: user.serviceCodes ?? [] };
  const departments = [...new Set([...Object.keys(departmentLabels), ...departmentCodes, ...services.map((service) => service.departmentCode), ...(user.managedDepartmentCodes ?? []), user.departmentCode, fields.departmentCode].filter(Boolean))];
  const [undo, setUndo] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const passwordOpenerRef = useRef<HTMLButtonElement>(null);
  const [initialPassword, setInitialPassword] = useState<string | null>(null);
  const [authorize, setAuthorize] = useState<(() => Promise<void>) | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState("");
  const set = <K extends keyof AccessDraft>(key: K, value: AccessDraft[K]) => setDraft({ ...fields, [key]: value });
  async function mutate(deactivate: boolean, values: AccessDraft, propagateFailure = false) {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setError("");
    try {
      const response = await apiFetch<ManagedUser>(deactivate ? `/users/${user.id}` : `/users/${user.id}/roles`, {
        method: deactivate ? "DELETE" : "POST",
        body: JSON.stringify(deactivate ? { expectedVersion: user.version } : { serviceCodes: executor(values.role) ? values.departmentCode === user.departmentCode ? values.serviceCodes : values.serviceCodes.filter((code) => services.some((service) => service.code === code && service.departmentCode === values.departmentCode)) : undefined, role: values.role, departmentCode: values.departmentCode, active: values.active, managedDepartmentCodes: technical && values.role === "MANAGER" ? managedCodes(values.managed) : undefined, expectedVersion: user.version })
      });
      onChanged(response); setDraft(null); setUndo(deactivate || (user.active && !response.active));
    } catch (cause) { setError(getSafeErrorMessage(cause, "Não foi possível salvar o acesso.")); if (propagateFailure) throw cause; }
    finally { submitting.current = false; setBusy(false); }
  }
  async function regenerate(propagateFailure = false) {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setError("");
    try {
      const response = await apiFetch<ManagedUser & { initialPassword?: string }>(`/users/${user.id}/password`, {
        method: "POST", body: JSON.stringify({ expectedVersion: user.version })
      });
      const { initialPassword: generatedPassword, ...updated } = response;
      onChanged(updated);
      if (generatedPassword) setInitialPassword(generatedPassword);
      else setError("A senha já foi gerada e não pode ser exibida novamente. Gere outra senha para recuperar o acesso.");
    } catch (cause) { setError(getSafeErrorMessage(cause, "Não foi possível gerar uma nova senha.")); if (propagateFailure) throw cause; }
    finally { submitting.current = false; setBusy(false); }
  }
  function requestPassword(event: MouseEvent<HTMLButtonElement>) {
    if (busy || authorize || initialPassword) return;
    passwordOpenerRef.current = event.currentTarget;
    if (!window.confirm(`Gerar nova senha para ${user.displayName}? A senha anterior deixará de funcionar e as sessões serão encerradas.`)) return;
    setRecovering(true);
    if (user.role === "ADMIN") setAuthorize(() => () => regenerate(true));
    else void regenerate();
  }
  function request(deactivate: boolean, values: AccessDraft) {
    if (busy || authorize || initialPassword) return;
    setRecovering(false);
    const adminChange = deactivate ? user.active && user.role === "ADMIN" : (user.role === "ADMIN") !== (values.role === "ADMIN") || (user.role === "ADMIN" && user.active !== values.active);
    if (adminChange) setAuthorize(() => () => mutate(deactivate, values, true));
    else void mutate(deactivate, values);
  }
  return <><form className="admin-row" aria-label={`Acesso de ${user.email}`} onSubmit={(event) => { event.preventDefault(); request(false, fields); }}><div className="admin-row-heading"><strong>{user.displayName}</strong><span className={user.active ? "text-success" : "text-danger"}>{user.active ? "Ativo" : "Desativado"}</span></div><small>{user.email}</small><div className="admin-role-grid"><ProfileField value={fields.role} technical={technical} onChange={(value) => set("role", value)} /><label>Setor<select value={fields.departmentCode} onChange={(event) => set("departmentCode", event.target.value)} required>{departments.map((code) => <option key={code} value={code}>{departmentLabels[code] ?? code}</option>)}</select></label></div>{technical && fields.role === "MANAGER" && <ManagedDepartments value={fields.managed} onChange={(value) => set("managed", value)} />}{executor(fields.role) && <ServiceAssignments services={services} departmentCode={fields.departmentCode} selected={fields.serviceCodes} onChange={(value) => set("serviceCodes", value)} />}<label className="admin-check"><input type="checkbox" checked={fields.active} onChange={(event) => set("active", event.target.checked)} /> Acesso operacional ativo</label>{error && <p className="form-alert" role="alert">{error}</p>}<div className="admin-action-row"><ActionButton tone="ghost" type="submit" state={busy ? "pending" : "idle"} disabled={!!authorize || !!initialPassword} aria-label={`Salvar ${user.email}`}>Salvar</ActionButton>{user.active && <ActionButton tone="ghost" type="button" state={busy ? "pending" : "idle"} disabled={!!authorize || !!initialPassword} onClick={() => request(true, fields)} aria-label="Desativar acesso">Desativar</ActionButton>}{user.active && user.id !== viewerId && <ActionButton tone="ghost" type="button" state={busy ? "pending" : "idle"} disabled={!!authorize || !!initialPassword} onClick={requestPassword}>Gerar nova senha</ActionButton>}</div>{undo && !user.active && <p role="status">Acesso desativado. <button type="button" className="button button-ghost" disabled={busy || !!authorize} onClick={() => request(false, { role: user.role, departmentCode: user.departmentCode, managed: user.managedDepartmentCodes?.join(", ") ?? "", serviceCodes: user.serviceCodes ?? [], active: true })}>Desfazer</button></p>}</form>{authorize && <ReauthDialog recovering={recovering} onClose={() => setAuthorize(null)} onConfirmed={authorize} />}{initialPassword && <InitialPasswordDialog password={initialPassword} regenerated returnFocusRef={passwordOpenerRef} onClose={() => setInitialPassword(null)} />}</>;
}
