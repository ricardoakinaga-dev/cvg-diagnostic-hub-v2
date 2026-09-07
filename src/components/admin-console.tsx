"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ROLES, type RoleCode } from "@cvg/contracts";
import { ActionButton } from "@cvg/ui";
import { ApiClientError, apiFetch, createClientUniqueId, getSafeErrorMessage } from "./api-client";
import { Icon } from "./ui-icons";

type ServiceCategory = "LABORATORY" | "IMAGING";
type WorkflowType = "LABORATORY" | "RADIOLOGY" | "ULTRASOUND";
type ResultSchema = "NUMERIC_PANEL" | "NARRATIVE";

interface CatalogService {
  id: string;
  code: string;
  name: string;
  category: ServiceCategory;
  departmentCode: string;
  workflowType: WorkflowType;
  requiresSample: boolean;
  requiresSchedule: boolean;
  allowsAttachment: boolean;
  resultSchema: ResultSchema;
  active: boolean;
  version: number;
  slaHours: { ROUTINE: number; URGENT: number; EMERGENCY: number };
}

interface ReasonCode {
  id: string;
  type: "RECOLLECTION" | "CANCEL" | "REJECT" | "AMEND";
  code: string;
  label: string;
  active: boolean;
  version: number;
}

interface ManagedUser {
  id: string;
  email: string;
  displayName: string;
  role: RoleCode;
  departmentCode: string;
  managedDepartmentCodes?: string[];
  active: boolean;
  timezone: string;
  createdAt: string;
  version: number;
}

interface AuditEvent {
  id: string;
  eventType: string;
  actorId?: string;
  entityType: string;
  entityId: string;
  previousState?: string;
  newState?: string;
  occurredAt: string;
  metadata: Record<string, string | number | boolean | null>;
}

interface ServiceDraft {
  code: string;
  name: string;
  category: ServiceCategory;
  departmentCode: string;
  workflowType: WorkflowType;
  requiresSample: boolean;
  requiresSchedule: boolean;
  allowsAttachment: boolean;
  resultSchema: ResultSchema;
  slaHours: { ROUTINE: number; URGENT: number; EMERGENCY: number };
}

const defaultServiceDraft: ServiceDraft = {
  code: "",
  name: "",
  category: "LABORATORY",
  departmentCode: "LABORATORY",
  workflowType: "LABORATORY",
  requiresSample: true,
  requiresSchedule: false,
  allowsAttachment: false,
  resultSchema: "NARRATIVE",
  slaHours: { ROUTINE: 8, URGENT: 4, EMERGENCY: 2 }
};

const roleLabels: Record<RoleCode, string> = {
  ADMIN: "Administração técnica",
  MANAGER: "Gestão operacional",
  VETERINARIAN: "Veterinária",
  INPATIENT_TEAM: "Equipe de internação",
  LAB_TECH: "Técnica de laboratório",
  RADIOLOGY_TEAM: "Equipe de radiologia",
  ULTRASOUND_TEAM: "Equipe de ultrassom",
  VIEWER: "Visualização operacional"
};
const departmentLabels: Record<string, string> = { INPATIENT: "Internação", LABORATORY: "Laboratório", RADIOLOGY: "Radiologia", ULTRASOUND: "Ultrassom", OPERATIONS: "Operações", IT: "Tecnologia" };
const workflowLabels: Record<WorkflowType, string> = { LABORATORY: "Laboratório", RADIOLOGY: "Radiologia", ULTRASOUND: "Ultrassom" };
const reasonTypeLabels: Record<ReasonCode["type"], string> = { RECOLLECTION: "Recoleta", CANCEL: "Cancelamento", REJECT: "Rejeição", AMEND: "Emenda" };

function departmentLabel(code: string): string {
  return departmentLabels[code] ?? code.replaceAll("_", " ").toLowerCase().replace(/^./, (letter) => letter.toUpperCase());
}

function parseManagedDepartments(value: string): string[] | undefined {
  const codes = Array.from(new Set(value.split(",").map((code) => code.trim().toUpperCase()).filter(Boolean)));
  return codes.length > 0 ? codes : undefined;
}

export function AdminConsole() {
  const [services, setServices] = useState<CatalogService[]>([]);
  const [reasons, setReasons] = useState<ReasonCode[]>([]);
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [currentRole, setCurrentRole] = useState<RoleCode | null>(null);
  const [error, setError] = useState("");
  const [accessDenied, setAccessDenied] = useState(false);
  const [loading, setLoading] = useState(true);
  const loadVersion = useRef(0);

  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    setLoading(true);
    setError("");
    setAccessDenied(false);
    const [serviceResult, reasonResult, userResult, auditResult, identityResult] = await Promise.allSettled([
      apiFetch<CatalogService[]>("/diagnostic-services?includeInactive=true"),
      apiFetch<ReasonCode[]>("/reason-codes"),
      apiFetch<ManagedUser[]>("/users"),
      apiFetch<AuditEvent[]>("/audit-events?limit=20"),
      apiFetch<{ user: { role: RoleCode } }>("/session/me")
    ]);
    if (loadVersion.current !== version) return;
    if (serviceResult.status === "fulfilled") setServices(serviceResult.value);
    if (reasonResult.status === "fulfilled") setReasons(reasonResult.value);
    if (userResult.status === "fulfilled") setUsers(userResult.value);
    if (auditResult.status === "fulfilled") setAuditEvents(auditResult.value);
    if (identityResult.status === "fulfilled") setCurrentRole(identityResult.value.user.role);
    const results = [serviceResult, reasonResult, userResult, auditResult];
    const failures = results.filter((result) => result.status === "rejected");
    const denied = failures.length === results.length && failures.every((result) => result.status === "rejected" && result.reason instanceof ApiClientError && result.reason.code === "SCOPE_DENIED");
    setAccessDenied(denied);
    if (failures.length > 0 && !denied) setError("Parte da configuração está indisponível; alterações não confirmadas permanecem sem efeito.");
    if (loadVersion.current === version) setLoading(false);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => { window.clearTimeout(timer); loadVersion.current += 1; };
  }, [load]);

  if (loading && services.length === 0 && reasons.length === 0 && users.length === 0 && auditEvents.length === 0) return <div className="loading-state" role="status">Carregando administração…</div>;

  return (
    <div className="admin-page">
      <div className="page-heading"><div><p className="eyebrow">Configuração controlada</p><h1>Administração <em>sem atalhos.</em></h1><p className="page-lede">Catálogos, acessos e motivos são versionados, desativados e auditados; nada referenciado é apagado.</p></div><ActionButton tone="ghost" state={loading ? "pending" : "idle"} onClick={() => void load()}><Icon name="refresh" size={15} /> {loading ? "Atualizando…" : "Atualizar"}</ActionButton></div>
      {accessDenied ? <div className="error-state" role="alert"><strong>Administração fora do seu escopo</strong><span>Seu perfil não pode consultar nem alterar o catálogo institucional.</span><Link className="button button-ghost" href="/">Voltar à visão geral</Link></div> : error && <div className="error-state" role="status"><span>{error}</span><ActionButton tone="ghost" state={loading ? "pending" : "idle"} onClick={() => void load()}>{loading ? "Reconciliando…" : "Reconciliar"}</ActionButton></div>}
      <section className="admin-policy-banner" role="note"><strong>Gate externo mantido visível</strong><p>A política de resultado crítico, identidade institucional, transferência/alta, retenção e RPO/RTO não é inventada pelo ambiente local. A configuração permanece bloqueada até aprovação e owner do hospital.</p></section>
      <div className="admin-columns">
        <section className="panel" id="catalog"><div className="panel-heading"><div><p className="eyebrow">Catálogo customizável</p><h2>Serviços diagnósticos</h2></div><span className="timeline-count">{services.length}</span></div><ServiceCreateForm onSaved={() => void load()} />{services.length === 0 ? <div className="empty-state"><span aria-hidden="true"><Icon name="check" size={16} /></span><strong>Nenhum serviço no escopo de gestão</strong><p>Adicione o primeiro serviço ou revise o escopo delegado.</p></div> : <div className="admin-list">{services.map((service) => <ServiceRow key={service.id} service={service} onSaved={() => void load()} />)}</div>}</section>
        <section className="panel" id="reasons"><div className="panel-heading"><div><p className="eyebrow">Motivos auditáveis</p><h2>Códigos de motivo</h2></div><span className="timeline-count">{reasons.length}</span></div><ReasonCreateForm onSaved={() => void load()} />{reasons.length === 0 ? <div className="empty-state"><span aria-hidden="true"><Icon name="check" size={16} /></span><strong>Nenhum motivo configurado</strong><p>Novos códigos devem ser aprovados antes de serem usados em comandos.</p></div> : <div className="admin-list">{reasons.map((reason) => <ReasonRow key={reason.id} reason={reason} onSaved={() => void load()} />)}</div>}</section>
        <section className="panel" id="users"><div className="panel-heading"><div><p className="eyebrow">Acesso institucional</p><h2>Colaboradores e roles</h2></div><span className="timeline-count">{users.length}</span></div><UserCreateForm canCreateTechnicalRoles={currentRole === "ADMIN"} onSaved={() => void load()} />{users.length === 0 ? <div className="empty-state"><span aria-hidden="true"><Icon name="check" size={16} /></span><strong>Nenhum colaborador administrável</strong><p>O gestor só visualiza identidades dentro do escopo delegado; nenhuma credencial é exibida.</p></div> : <div className="admin-list">{users.map((user) => <UserRow key={`${user.id}:${user.version}:${user.active}`} user={user} canEditTechnicalScope={currentRole === "ADMIN"} onSaved={() => void load()} />)}</div>}</section>
      </div>
      <section className="panel admin-audit-panel" id="audit"><div className="panel-heading"><div><p className="eyebrow">Fonte de verdade</p><h2>Auditoria recente</h2></div><span className="timeline-count">{auditEvents.length}</span></div>{auditEvents.length === 0 ? <div className="empty-state"><span aria-hidden="true"><Icon name="check" size={16} /></span><strong>Nenhum evento de configuração no escopo</strong><p>As alterações aparecerão aqui quando houver atividade auditável.</p></div> : <ul className="admin-audit-list">{auditEvents.map((event) => <li key={event.id}><span className="audit-dot" aria-hidden="true" /><span><strong>{event.eventType.replace(/([a-z])([A-Z])/g, "$1 $2")}</strong><small>{event.entityType.replaceAll("_", " ").toLowerCase()} · {event.entityId} · {new Date(event.occurredAt).toLocaleString("pt-BR")}</small></span><span className="text-success">{event.newState?.replaceAll("_", " ").toLowerCase() ?? "registrado"}</span></li>)}</ul>}</section>
    </div>
  );
}

function ServiceCreateForm({ onSaved }: { onSaved: () => void }) {
  const [draft, setDraft] = useState<ServiceDraft>(defaultServiceDraft);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await apiFetch("/diagnostic-services", { method: "POST", body: JSON.stringify(draft) });
      setDraft(defaultServiceDraft);
      setOpen(false);
      onSaved();
    } catch (cause) {
      setError(getSafeErrorMessage(cause, "Não foi possível criar o serviço."));
    } finally { setBusy(false); }
  }

  return <details className="admin-create" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}><summary><Icon name="add" size={14} /> Adicionar serviço</summary><form className="admin-create-form" onSubmit={(event) => void save(event)}><ServiceFields draft={draft} onChange={setDraft} includeCode />{error && <p className="form-alert" role="alert">{error}</p>}<ActionButton type="submit" state={busy ? "pending" : "idle"} disabled={!draft.code.trim() || !draft.name.trim()}>{busy ? "Criando…" : "Criar serviço"}</ActionButton></form></details>;
}

function ServiceRow({ service, onSaved }: { service: CatalogService; onSaved: () => void }) {
  const [draft, setDraft] = useState<ServiceDraft>(() => ({ code: service.code, name: service.name, category: service.category ?? "LABORATORY", departmentCode: service.departmentCode, workflowType: service.workflowType ?? "LABORATORY", requiresSample: service.requiresSample ?? false, requiresSchedule: service.requiresSchedule ?? false, allowsAttachment: service.allowsAttachment ?? false, resultSchema: service.resultSchema ?? "NARRATIVE", slaHours: { ...service.slaHours } }));
  const [active, setActive] = useState(service.active);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { code: _code, ...editableDraft } = draft;
      await apiFetch(`/diagnostic-services/${service.id}`, { method: "PATCH", body: JSON.stringify({ ...editableDraft, active, expectedVersion: service.version }) });
      onSaved();
    } catch (cause) {
      setError(getSafeErrorMessage(cause, "Não foi possível salvar o serviço."));
    } finally { setBusy(false); }
  }

  return <form className="admin-row" onSubmit={(event) => void save(event)}><div className="admin-row-heading"><strong>{service.code}</strong><span className={active ? "text-success" : "text-danger"}>{active ? "Ativo" : "Desativado"}</span></div><small>{departmentLabel(draft.departmentCode)} · {workflowLabels[draft.workflowType]} · versão {service.version} · identificador protegido</small><ServiceFields draft={draft} onChange={setDraft} /><label className="admin-check"><input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} /> Disponível no catálogo</label>{error && <p className="form-alert" role="alert">{error}</p>}<ActionButton tone="ghost" type="submit" state={busy ? "pending" : "idle"}>{busy ? "Salvando…" : `Salvar ${service.name}`}</ActionButton></form>;
}

function ServiceFields({ draft, onChange, includeCode = false }: { draft: ServiceDraft; onChange: (next: ServiceDraft) => void; includeCode?: boolean }) {
  const set = <K extends keyof ServiceDraft>(key: K, value: ServiceDraft[K]) => onChange({ ...draft, [key]: value });
  const setSla = (key: keyof ServiceDraft["slaHours"], value: number) => onChange({ ...draft, slaHours: { ...draft.slaHours, [key]: value } });
  return <div className="admin-service-fields">
    {includeCode && <label>Código<input value={draft.code} onChange={(event) => set("code", event.target.value.toUpperCase())} pattern="[A-Z][A-Z0-9_]{1,59}" title="Use uma letra inicial e apenas letras, números ou sublinhado." maxLength={60} required /><small className="field-hint">Identificador estável: letra inicial, letras, números ou sublinhado.</small></label>}
    <label>Nome<input value={draft.name} onChange={(event) => set("name", event.target.value)} maxLength={120} required /></label>
    <div className="admin-role-grid"><label>Categoria<select value={draft.category} onChange={(event) => set("category", event.target.value as ServiceCategory)}><option value="LABORATORY">Laboratório</option><option value="IMAGING">Imagem</option></select></label><label>Workflow<select value={draft.workflowType} onChange={(event) => set("workflowType", event.target.value as WorkflowType)}><option value="LABORATORY">Laboratório</option><option value="RADIOLOGY">Radiologia</option><option value="ULTRASOUND">Ultrassom</option></select></label></div>
    <label>Setor<input value={draft.departmentCode} onChange={(event) => set("departmentCode", event.target.value.toUpperCase())} maxLength={60} required /></label>
    <div className="admin-check-grid"><label className="admin-check"><input type="checkbox" checked={draft.requiresSample} onChange={(event) => set("requiresSample", event.target.checked)} /> Exige amostra</label><label className="admin-check"><input type="checkbox" checked={draft.requiresSchedule} onChange={(event) => set("requiresSchedule", event.target.checked)} /> Exige agenda</label><label className="admin-check"><input type="checkbox" checked={draft.allowsAttachment} onChange={(event) => set("allowsAttachment", event.target.checked)} /> Aceita anexo</label></div>
    <label>Modelo de resultado<select value={draft.resultSchema} onChange={(event) => set("resultSchema", event.target.value as ResultSchema)}><option value="NUMERIC_PANEL">Painel numérico</option><option value="NARRATIVE">Narrativo</option></select></label>
    <div className="admin-sla-grid"><label>SLA rotina (h)<input type="number" min="1" max="720" value={draft.slaHours.ROUTINE} onChange={(event) => setSla("ROUTINE", Number(event.target.value))} /></label><label>SLA urgente (h)<input type="number" min="1" max="720" value={draft.slaHours.URGENT} onChange={(event) => setSla("URGENT", Number(event.target.value))} /></label><label>SLA emergência (h)<input type="number" min="1" max="720" value={draft.slaHours.EMERGENCY} onChange={(event) => setSla("EMERGENCY", Number(event.target.value))} /></label></div>
  </div>;
}

function ReasonCreateForm({ onSaved }: { onSaved: () => void }) {
  const [type, setType] = useState<ReasonCode["type"]>("RECOLLECTION");
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    try { await apiFetch("/reason-codes", { method: "POST", body: JSON.stringify({ type, code: code.trim().toUpperCase(), label: label.trim() }) }); setCode(""); setLabel(""); onSaved(); }
    catch (cause) { setError(getSafeErrorMessage(cause, "Não foi possível criar o motivo.")); }
    finally { setBusy(false); }
  }
  return <details className="admin-create"><summary><Icon name="add" size={14} /> Adicionar motivo</summary><form className="admin-create-form" onSubmit={(event) => void save(event)}><label>Tipo<select value={type} onChange={(event) => setType(event.target.value as ReasonCode["type"])}><option value="RECOLLECTION">Recoleta</option><option value="CANCEL">Cancelamento</option><option value="REJECT">Rejeição</option><option value="AMEND">Emenda</option></select></label><label>Código<input value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} maxLength={60} required /></label><label>Descrição<input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={160} required /></label>{error && <p className="form-alert" role="alert">{error}</p>}<ActionButton type="submit" state={busy ? "pending" : "idle"}>{busy ? "Criando…" : "Criar motivo"}</ActionButton></form></details>;
}

function ReasonRow({ reason, onSaved }: { reason: ReasonCode; onSaved: () => void }) {
  const [label, setLabel] = useState(reason.label);
  const [active, setActive] = useState(reason.active);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    try { await apiFetch(`/reason-codes/${reason.id}`, { method: "PATCH", body: JSON.stringify({ label: label.trim(), active, expectedVersion: reason.version }) }); onSaved(); }
    catch (cause) { setError(getSafeErrorMessage(cause, "Não foi possível salvar o motivo.")); }
    finally { setBusy(false); }
  }
  return <form className="admin-row" onSubmit={(event) => void save(event)}><div className="admin-row-heading"><strong>{reason.code}</strong><span className={active ? "text-success" : "text-danger"}>{active ? "Ativo" : "Desativado"}</span></div><small>{reasonTypeLabels[reason.type]} · versão {reason.version} · código protegido</small><label>Descrição<input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={160} /></label><label className="admin-check"><input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} /> Disponível para seleção</label>{error && <p className="form-alert" role="alert">{error}</p>}<ActionButton tone="ghost" type="submit" state={busy ? "pending" : "idle"}>{busy ? "Salvando…" : `Salvar ${reason.code}`}</ActionButton></form>;
}

function UserCreateForm({ canCreateTechnicalRoles, onSaved }: { canCreateTechnicalRoles: boolean; onSaved: () => void }) {
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<RoleCode>("LAB_TECH");
  const [departmentCode, setDepartmentCode] = useState("LABORATORY");
  const [managedDepartments, setManagedDepartments] = useState("");
  const [timezone, setTimezone] = useState("America/Sao_Paulo");
  const [reason, setReason] = useState("");
  const [reauthPassword, setReauthPassword] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      await apiFetch("/session/reauth", { method: "POST", body: JSON.stringify({ password: reauthPassword }) });
      await apiFetch("/users", { method: "POST", body: JSON.stringify({ displayName: displayName.trim(), email: email.trim(), password, role, departmentCode: departmentCode.trim(), managedDepartmentCodes: role === "MANAGER" ? parseManagedDepartments(managedDepartments) : undefined, timezone, reason: reason.trim(), confirm: true }) });
      setDisplayName(""); setEmail(""); setPassword(""); setManagedDepartments(""); setReason(""); setReauthPassword(""); setConfirmed(false); onSaved();
    } catch (cause) { setError(getSafeErrorMessage(cause, "Não foi possível adicionar o colaborador.")); }
    finally { setBusy(false); }
  }
  const creatableRoles = canCreateTechnicalRoles ? ROLES : ROLES.filter((option) => option !== "ADMIN" && option !== "MANAGER");
  return <details className="admin-create"><summary><Icon name="add" size={14} /> Adicionar colaborador</summary><form className="admin-create-form" onSubmit={(event) => void save(event)}><label>Nome completo<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={160} required /></label><label>E-mail institucional<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} maxLength={320} required /></label><div className="admin-role-grid"><label>Role<select value={role} onChange={(event) => setRole(event.target.value as RoleCode)}>{creatableRoles.map((option) => <option key={option} value={option}>{roleLabels[option]}</option>)}</select></label><label>Setor<input value={departmentCode} onChange={(event) => setDepartmentCode(event.target.value.toUpperCase())} maxLength={60} required /></label></div>{canCreateTechnicalRoles && role === "MANAGER" && <label>Setores gerenciados<input value={managedDepartments} onChange={(event) => setManagedDepartments(event.target.value)} maxLength={1200} placeholder="LABORATORY, RADIOLOGY, ULTRASOUND" /><small className="field-hint">Códigos separados por vírgula. O gestor poderá controlar solicitações e equipes apenas nesses setores.</small></label>}<label>Senha inicial<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={12} maxLength={200} autoComplete="new-password" required /><small className="field-hint">Mínimo de 12 caracteres com letras e números. Nunca é exibida novamente.</small></label><label>Fuso horário<input value={timezone} onChange={(event) => setTimezone(event.target.value)} maxLength={80} required /></label><label>Motivo da criação<input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} required /></label><label>Senha do gestor para confirmar<input type="password" value={reauthPassword} onChange={(event) => setReauthPassword(event.target.value)} autoComplete="current-password" required /></label><label className="admin-check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> Confirmo a criação deste acesso</label>{error && <p className="form-alert" role="alert">{error}</p>}<ActionButton type="submit" state={busy ? "pending" : "idle"} disabled={!confirmed}>{busy ? "Provisionando…" : "Criar acesso"}</ActionButton></form></details>;
}

function UserRow({ user, canEditTechnicalScope, onSaved }: { user: ManagedUser; canEditTechnicalScope: boolean; onSaved: () => void }) {
  const [role, setRole] = useState<RoleCode>(user.role);
  const [departmentCode, setDepartmentCode] = useState(user.departmentCode);
  const [managedDepartments, setManagedDepartments] = useState(user.managedDepartmentCodes?.join(", ") ?? "");
  const [active, setActive] = useState(user.active);
  const [reason, setReason] = useState("");
  const [password, setPassword] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function reauth() { await apiFetch("/session/reauth", { method: "POST", body: JSON.stringify({ password }) }); }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    try { await reauth(); await apiFetch(`/users/${user.id}/roles`, { method: "POST", body: JSON.stringify({ role, departmentCode: departmentCode.trim(), managedDepartmentCodes: canEditTechnicalScope && role === "MANAGER" ? (parseManagedDepartments(managedDepartments) ?? []) : undefined, active, expectedVersion: user.version, reason: reason.trim(), confirm: true }) }); onSaved(); }
    catch (cause) { setError(getSafeErrorMessage(cause, "Não foi possível salvar a role.")); }
    finally { setBusy(false); }
  }
  async function deactivate() {
    setBusy(true); setError("");
    try { await reauth(); await apiFetch(`/users/${user.id}`, { method: "DELETE", body: JSON.stringify({ expectedVersion: user.version, reason: reason.trim(), confirm: true }) }); onSaved(); }
    catch (cause) { setError(getSafeErrorMessage(cause, "Não foi possível desativar o acesso.")); }
    finally { setBusy(false); }
  }

  const editableRoles = canEditTechnicalScope ? ROLES : ROLES.filter((option) => option !== "ADMIN" && option !== "MANAGER");
  return <form className="admin-row" onSubmit={(event) => void save(event)}><div className="admin-row-heading"><strong>{user.displayName}</strong><span className={active ? "text-success" : "text-danger"}>{active ? "Ativo" : "Desativado"}</span></div><small>{user.email} · versão {user.version} · {user.timezone}</small><div className="admin-role-grid"><label>Role<select value={role} onChange={(event) => setRole(event.target.value as RoleCode)}>{editableRoles.map((option) => <option key={option} value={option}>{roleLabels[option]}</option>)}</select></label><label>Setor<input value={departmentCode} onChange={(event) => setDepartmentCode(event.target.value)} maxLength={60} /></label></div>{canEditTechnicalScope && role === "MANAGER" && <label>Setores gerenciados<input value={managedDepartments} onChange={(event) => setManagedDepartments(event.target.value)} maxLength={1200} placeholder="LABORATORY, RADIOLOGY, ULTRASOUND" /><small className="field-hint">Códigos separados por vírgula; essa é a fronteira operacional do gestor.</small></label>}<label className="admin-check"><input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} /> Acesso operacional ativo</label><label>Motivo da alteração<input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} required /></label><label>Senha para reautenticar<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" maxLength={200} required /></label><label className="admin-check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> Confirmo esta alteração de acesso</label>{error && <p className="form-alert" role="alert">{error}</p>}<div className="admin-action-row"><ActionButton tone="ghost" type="submit" state={busy ? "pending" : "idle"} disabled={!reason.trim() || !password || !confirmed}>{busy ? "Salvando…" : `Salvar ${user.email}`}</ActionButton><ActionButton tone="ghost" className="button-danger-ghost" type="button" state={busy ? "pending" : "idle"} onClick={() => void deactivate()} disabled={!user.active || !reason.trim() || !password || !confirmed}>Desativar acesso</ActionButton></div></form>;
}
