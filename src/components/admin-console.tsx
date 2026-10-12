"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { type Department, type DiagnosticService, type Permission, type ReasonCode, type ManagedUser, type SessionResponse, type SessionUser } from "@cvg/contracts";
import { ActionButton } from "@cvg/ui";
import { ApiClientError, apiFetch, getSafeErrorMessage } from "./api-client";
import { EmptyState, ErrorState, LoadingState } from "./feedback-states";
import { Icon } from "./ui-icons";
import { UserCreateForm, UserRow } from "./admin-users";
import { CatalogImportPanel } from "./admin-catalog-import";
import { DataSubjectExportPanel } from "./admin-data-subject-export";
import { departmentOptions, useDepartments } from "./use-departments";
import { ExamDefinitionEditor } from "./exam-definition-editor";
import { canAdminister } from "./admin-capabilities";

type CatalogService = DiagnosticService;
type ServiceCategory = DiagnosticService["category"];
type WorkflowType = DiagnosticService["workflowType"];
type ResultSchema = DiagnosticService["resultSchema"];

interface ServiceDraft {
  code: string;
  name: string;
  category: ServiceCategory;
  departmentCode: string;
  workflowType: WorkflowType;
  requiresSample: boolean;
  sampleType: string;
  requiresSchedule: boolean;
  allowsAttachment: boolean;
  resultSchema: ResultSchema;
  slaHours: { ROUTINE: number; URGENT: number; EMERGENCY: number };
}

function createServiceDraft(creator: SessionUser, departments: Department[]): ServiceDraft {
  const active = departments.filter((department) => department.active);
  const departmentCode = [creator.departmentCode, ...(creator.managedDepartmentCodes ?? [])].map((code) => active.find((department) => department.code === code && department.type === "DIAGNOSTIC")?.code).find(Boolean)
    ?? active.find((department) => department.type === "DIAGNOSTIC")?.code ?? active[0]?.code ?? "";
  const workflowType: WorkflowType = departmentCode === "RADIOLOGY" ? "RADIOLOGY" : departmentCode === "ULTRASOUND" ? "ULTRASOUND" : "LABORATORY";
  return {
    code: "",
    name: "",
    category: workflowType === "LABORATORY" ? "LABORATORY" : "IMAGING",
    departmentCode,
    workflowType,
    requiresSample: workflowType === "LABORATORY",
    sampleType: "",
    requiresSchedule: workflowType === "ULTRASOUND",
    allowsAttachment: workflowType !== "LABORATORY",
    resultSchema: "NARRATIVE",
    slaHours: workflowType === "RADIOLOGY" ? { ROUTINE: 24, URGENT: 8, EMERGENCY: 4 }
      : workflowType === "ULTRASOUND" ? { ROUTINE: 48, URGENT: 12, EMERGENCY: 6 }
        : { ROUTINE: 8, URGENT: 4, EMERGENCY: 2 }
  };
}

/** The API rejects an empty sampleType; the field is omitted when blank or when no sample is required. */
function servicePayload(draft: ServiceDraft): Omit<ServiceDraft, "sampleType"> & { sampleType?: string } {
  const { sampleType, ...rest } = draft;
  const trimmed = sampleType.trim();
  return draft.requiresSample && trimmed ? { ...rest, sampleType: trimmed } : rest;
}

const workflowLabels: Record<WorkflowType, string> = { LABORATORY: "Laboratório", RADIOLOGY: "Radiologia", ULTRASOUND: "Ultrassom" };
const reasonTypeLabels: Record<ReasonCode["type"], string> = { RECOLLECTION: "Recoleta", CANCEL: "Cancelamento", REJECT: "Rejeição", AMEND: "Emenda" };

export function AdminConsole({ section = "all" }: { section?: "all" | "users" | "catalog" } = {}) {
  const [services, setServices] = useState<CatalogService[]>([]);
  const [reasons, setReasons] = useState<ReasonCode[]>([]);
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [identity, setIdentity] = useState<SessionUser | null>(null);
  const directory = useDepartments(identity?.id, { includeInactive: true });
  const [error, setError] = useState("");
  const [accessDenied, setAccessDenied] = useState(false);
  const [loading, setLoading] = useState(true);
  const loadVersion = useRef(0);

  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    setLoading(true); setError(""); setAccessDenied(false);
    try {
      const session = await apiFetch<SessionResponse>("/session/me");
      if (loadVersion.current !== version) return;
      if (!["SUPERADMIN", "ADMIN", "MANAGER"].includes(session.user.role)) {
        setIdentity(null); setAccessDenied(true); setServices([]); setReasons([]); setUsers([]);
        return;
      }
      setIdentity(session.user);
      const [serviceResult, reasonResult, userResult] = await Promise.allSettled([
        apiFetch<CatalogService[]>("/diagnostic-services?includeInactive=true"),
        apiFetch<ReasonCode[]>("/reason-codes"), canAdminister(session.user, "user.view", "user_role.manage") ? apiFetch<ManagedUser[]>("/users") : Promise.resolve([])
      ]);
      if (loadVersion.current !== version) return;
      setServices(serviceResult.status === "fulfilled" ? serviceResult.value : []);
      setReasons(reasonResult.status === "fulfilled" ? reasonResult.value : []);
      setUsers(userResult.status === "fulfilled" ? userResult.value : []);
      const failures = [serviceResult, reasonResult, userResult].filter((result) => result.status === "rejected");
      const denied = failures.length === 3 && failures.every((result) => result.status === "rejected" && result.reason instanceof ApiClientError && result.reason.code === "SCOPE_DENIED");
      setAccessDenied(denied);
      if (failures.length && !denied) setError("Parte da configuração está indisponível. Tente atualizar.");
    } catch (cause) {
      if (loadVersion.current !== version) return;
      setIdentity(null); setServices([]); setReasons([]); setUsers([]);
      if (cause instanceof ApiClientError && cause.code === "SCOPE_DENIED") setAccessDenied(true);
      else setError(getSafeErrorMessage(cause, "Não foi possível carregar a administração."));
    } finally { if (loadVersion.current === version) setLoading(false); }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => { window.clearTimeout(timer); loadVersion.current += 1; };
  }, [load]);

  const departmentCodes = [...new Set([
    ...directory.departments.map((department) => department.code), ...users.flatMap((user) => [user.departmentCode, ...(user.managedDepartmentCodes ?? [])]),
    ...services.map((service) => service.departmentCode),
    ...(identity ? [identity.departmentCode, ...(identity.managedDepartmentCodes ?? [])] : [])
  ].filter(Boolean))];
  const heading = section === "users" ? "Acessos" : section === "catalog" ? "Catálogos" : "Administração";
  const description = section === "users" ? "Colaboradores e permissões." : section === "catalog" ? "Serviços diagnósticos e motivos." : "Colaboradores, exames e motivos.";

  if (loading && !identity) return <LoadingState label="Carregando administração" />;
  return <div className="admin-page">
    <div className="page-heading"><div><h1>{heading}</h1><p className="page-lede">{description}</p></div><ActionButton tone="ghost" state={loading ? "pending" : "idle"} onClick={() => void load()}><Icon name="refresh" size={15} /> Atualizar</ActionButton></div>
    {accessDenied ? <ErrorState title="Administração fora do seu escopo" message="Seu perfil não pode consultar nem alterar o catálogo institucional." onRetry={load} action={<Link className="button button-ghost" href="/">Voltar à visão geral</Link>} /> : <>
      {error && <ErrorState title="Configuração parcialmente indisponível" message={error} onRetry={load} retrying={loading} />}
      {identity && <div className={`admin-columns${section === "all" ? "" : " admin-columns-section"}`}>
        {section !== "catalog" && <section className="panel" id="users"><div className="panel-heading"><h2>Colaboradores</h2><span className="timeline-count">{users.length}</span></div><UserCreateForm departments={directory.departments} creator={identity} services={services} onCreated={(user) => setUsers((current) => [...current.filter((entry) => entry.id !== user.id), user])} />{users.length === 0 ? <EmptyState title="Nenhum colaborador administrável" message="Adicione um colaborador ao seu setor." /> : <div className="admin-list">{users.map((user) => <UserRow permissions={identity.permissions} departments={directory.departments} key={user.id} user={user} viewerId={identity.id} services={services} departmentCodes={departmentCodes} technical={["ADMIN", "SUPERADMIN"].includes(identity.role)} superadmin={identity.role === "SUPERADMIN"} onChanged={(updated) => setUsers((current) => current.map((entry) => entry.id === updated.id ? updated : entry))} />)}</div>}</section>}
        {section !== "users" && <section className="panel" id="catalog"><div className="panel-heading"><h2>Serviços diagnósticos</h2><span className="timeline-count">{services.length}</span></div><CatalogImportPanel onApplied={() => void load()} />{directory.departments.some((department) => department.active) ? <ServiceCreateForm creator={identity} departments={directory.departments} existingCodes={services.map((service) => service.code)} onSaved={() => void load()} /> : <p className="field-hint">{directory.loading ? "Carregando setores para novos serviços…" : "Nenhum setor ativo autorizado para criar serviços."}</p>}{services.length === 0 ? <EmptyState title="Nenhum serviço no escopo de gestão" message="Adicione o primeiro serviço." /> : <div className="admin-list">{services.map((service) => <ServiceRow key={`${service.id}:${service.version}`} service={service} departments={directory.departments} permissions={identity.permissions} existingCodes={services.map((entry) => entry.code)} onSaved={() => void load()} />)}</div>}</section>}
        {section !== "users" && <section className="panel" id="reasons"><div className="panel-heading"><h2>Motivos</h2><span className="timeline-count">{reasons.length}</span></div><ReasonCreateForm existingCodes={reasons.map((reason) => reason.code)} onSaved={() => void load()} />{reasons.length === 0 ? <EmptyState title="Nenhum motivo configurado" message="Adicione um motivo para seleção nos fluxos clínicos." /> : <div className="admin-list">{reasons.map((reason) => <ReasonRow key={`${reason.id}:${reason.version}`} reason={reason} existingCodes={reasons.map((entry) => entry.code)} onSaved={() => void load()} />)}</div>}</section>}
        {section === "all" && ["ADMIN", "SUPERADMIN"].includes(identity.role) && <section className="panel" id="privacy"><div className="panel-heading"><h2>Privacidade (LGPD)</h2></div><DataSubjectExportPanel /></section>}
      </div>}
    </>}
  </div>;
}

function codeFromName(name: string, existingCodes: string[]): string {
  const normalized = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const base = (normalized.match(/^[A-Z]/) ? normalized : `ITEM_${normalized}`).slice(0, 50).padEnd(2, "_");
  let code = base;
  for (let suffix = 2; existingCodes.includes(code); suffix += 1) code = `${base}_${suffix}`;
  return code;
}

function ServiceCreateForm({ creator, departments, existingCodes, onSaved }: { creator: SessionUser; departments: Department[]; existingCodes: string[]; onSaved: () => void }) {
  const [draft, setDraft] = useState<ServiceDraft>(() => createServiceDraft(creator, departments));
  const effectiveDraft = draft.departmentCode ? draft : { ...draft, departmentCode: createServiceDraft(creator, departments).departmentCode };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await apiFetch("/diagnostic-services", { method: "POST", body: JSON.stringify({ ...servicePayload(effectiveDraft), name: draft.name.trim(), code: codeFromName(draft.name, existingCodes) }) });
      setDraft(createServiceDraft(creator, departments));
      onSaved();
    } catch (cause) {
      setError(getSafeErrorMessage(cause, "Não foi possível criar o serviço."));
    } finally { setBusy(false); }
  }

  return <form className="admin-create-form" aria-label="Adicionar serviço" onSubmit={(event) => void save(event)}><ServiceFields draft={effectiveDraft} departments={departments} onChange={setDraft} />{error && <p className="form-alert" role="alert">{error}</p>}<ActionButton type="submit" state={busy ? "pending" : "idle"} disabled={!draft.name.trim() || !departments.some((department) => department.active && department.code === effectiveDraft.departmentCode)}>{busy ? "Criando…" : "Criar serviço"}</ActionButton></form>;
}

function ServiceRow({ service, departments, permissions = [], existingCodes, onSaved }: { service: CatalogService; departments: Department[]; permissions?: readonly Permission[]; existingCodes: string[]; onSaved: () => void }) {
  const [draft, setDraft] = useState<ServiceDraft>(() => ({ code: service.code, name: service.name, category: service.category ?? "LABORATORY", departmentCode: service.departmentCode, workflowType: service.workflowType ?? "LABORATORY", requiresSample: service.requiresSample ?? false, sampleType: service.sampleType ?? "", requiresSchedule: service.requiresSchedule ?? false, allowsAttachment: service.allowsAttachment ?? false, resultSchema: service.resultSchema ?? "NARRATIVE", slaHours: { ...service.slaHours } }));
  const [active, setActive] = useState(service.active);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { code: _code, ...editableDraft } = servicePayload(draft);
      await apiFetch(`/diagnostic-services/${service.id}`, { method: "PATCH", body: JSON.stringify({ ...editableDraft, sampleType: editableDraft.sampleType ?? null, active, expectedVersion: service.version }) });
      onSaved();
    } catch (cause) {
      setError(getSafeErrorMessage(cause, "Não foi possível salvar o serviço."));
    } finally { setBusy(false); }
  }

  async function duplicate() {
    if (busy) return;
    setBusy(true); setError("");
    const name = `${draft.name.slice(0, 112)} (cópia)`;
    try {
      await apiFetch("/diagnostic-services", { method: "POST", body: JSON.stringify({ ...servicePayload(draft), name, code: codeFromName(name, existingCodes), duplicateOfServiceId: service.id }) });
      onSaved();
    } catch (cause) { setError(getSafeErrorMessage(cause, "Não foi possível duplicar o serviço.")); }
    finally { setBusy(false); }
  }

  return <><form className="admin-row" aria-label={`Serviço ${service.name}`} onSubmit={(event) => void save(event)}><div className="admin-row-heading"><strong>{service.name}</strong><span className={active ? "text-success" : "text-danger"}>{active ? "Ativo" : "Desativado"}</span></div><small>{departments.find((department) => department.code === draft.departmentCode)?.name ?? draft.departmentCode} · {workflowLabels[draft.workflowType]}</small><ServiceFields draft={draft} departments={departments} onChange={setDraft} /><label className="admin-check"><input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} /> Disponível no catálogo</label>{error && <p className="form-alert" role="alert">{error}</p>}<div className="admin-action-row"><ActionButton tone="ghost" type="submit" state={busy ? "pending" : "idle"} aria-label={`Salvar ${service.name}`}>{busy ? "Salvando…" : "Salvar"}</ActionButton><ActionButton tone="ghost" type="button" state={busy ? "pending" : "idle"} disabled={!departments.some((department) => department.code === draft.departmentCode && department.active)} onClick={() => void duplicate()} aria-label={`Duplicar ${service.name}`}>Duplicar</ActionButton></div></form><ExamDefinitionEditor service={service} permissions={permissions} onSaved={onSaved} /></>;
}

function ServiceFields({ draft, departments, onChange }: { draft: ServiceDraft; departments: Department[]; onChange: (next: ServiceDraft) => void }) {
  const set = <K extends keyof ServiceDraft>(key: K, value: ServiceDraft[K]) => onChange({ ...draft, [key]: value });
  const setSla = (key: keyof ServiceDraft["slaHours"], value: number) => onChange({ ...draft, slaHours: { ...draft.slaHours, [key]: value } });
  return <div className="admin-service-fields">

    <label>Nome<input value={draft.name} onChange={(event) => set("name", event.target.value)} maxLength={120} required /></label>
    <details className="admin-create"><summary>Opções avançadas do exame</summary>
    <div className="admin-role-grid"><label>Categoria<select value={draft.category} onChange={(event) => set("category", event.target.value as ServiceCategory)}><option value="LABORATORY">Laboratório</option><option value="IMAGING">Imagem</option></select></label><label>Workflow<select value={draft.workflowType} onChange={(event) => set("workflowType", event.target.value as WorkflowType)}><option value="LABORATORY">Laboratório</option><option value="RADIOLOGY">Radiologia</option><option value="ULTRASOUND">Ultrassom</option></select></label></div>
    <label>Setor<select value={draft.departmentCode} onChange={(event) => set("departmentCode", event.target.value)} required><option value="">Selecione um setor ativo</option>{departmentOptions(departments, [draft.departmentCode]).map((department) => <option key={department.code} value={department.code} disabled={!department.active}>{department.name}{!department.active ? " (vínculo existente)" : ""}</option>)}</select></label><small className="field-hint">Novos serviços usam setores ativos do cadastro institucional.</small>
    <div className="admin-check-grid"><label className="admin-check"><input type="checkbox" checked={draft.requiresSample} onChange={(event) => set("requiresSample", event.target.checked)} /> Exige amostra</label><label className="admin-check"><input type="checkbox" checked={draft.requiresSchedule} onChange={(event) => set("requiresSchedule", event.target.checked)} /> Exige agenda</label><label className="admin-check"><input type="checkbox" checked={draft.allowsAttachment} onChange={(event) => set("allowsAttachment", event.target.checked)} /> Aceita anexo</label></div>
    {draft.requiresSample && <label>Tipo de amostra<input value={draft.sampleType} onChange={(event) => set("sampleType", event.target.value)} maxLength={60} placeholder="EDTA, soro, urina…" /></label>}
    <label>Modelo de resultado<select value={draft.resultSchema} onChange={(event) => set("resultSchema", event.target.value as ResultSchema)}><option value="NUMERIC_PANEL">Painel numérico</option><option value="NARRATIVE">Narrativo</option></select></label>
    <div className="admin-sla-grid"><label>SLA rotina (h)<input type="number" min="1" max="720" value={draft.slaHours.ROUTINE} onChange={(event) => setSla("ROUTINE", Number(event.target.value))} /></label><label>SLA urgente (h)<input type="number" min="1" max="720" value={draft.slaHours.URGENT} onChange={(event) => setSla("URGENT", Number(event.target.value))} /></label><label>SLA emergência (h)<input type="number" min="1" max="720" value={draft.slaHours.EMERGENCY} onChange={(event) => setSla("EMERGENCY", Number(event.target.value))} /></label></div>
    </details>
  </div>;
}

function ReasonCreateForm({ existingCodes, onSaved }: { existingCodes: string[]; onSaved: () => void }) {
  const [type, setType] = useState<ReasonCode["type"]>("RECOLLECTION");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    try { await apiFetch("/reason-codes", { method: "POST", body: JSON.stringify({ type, code: codeFromName(label, existingCodes), label: label.trim() }) }); setLabel(""); onSaved(); }
    catch (cause) { setError(getSafeErrorMessage(cause, "Não foi possível criar o motivo.")); }
    finally { setBusy(false); }
  }
  return <details className="admin-create"><summary><Icon name="add" size={14} /> Adicionar motivo</summary><form className="admin-create-form" onSubmit={(event) => void save(event)}><label>Tipo<select value={type} onChange={(event) => setType(event.target.value as ReasonCode["type"])}><option value="RECOLLECTION">Recoleta</option><option value="CANCEL">Cancelamento</option><option value="REJECT">Rejeição</option><option value="AMEND">Emenda</option></select></label><label>Descrição<input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={160} required /></label>{error && <p className="form-alert" role="alert">{error}</p>}<ActionButton type="submit" state={busy ? "pending" : "idle"}>{busy ? "Criando…" : "Criar motivo"}</ActionButton></form></details>;
}

function ReasonRow({ reason, existingCodes, onSaved }: { reason: ReasonCode; existingCodes: string[]; onSaved: () => void }) {
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
  async function duplicate() {
    if (busy) return;
    setBusy(true); setError("");
    const copyLabel = `${label.slice(0, 152)} (cópia)`;
    try { await apiFetch("/reason-codes", { method: "POST", body: JSON.stringify({ type: reason.type, label: copyLabel, code: codeFromName(copyLabel, existingCodes) }) }); onSaved(); }
    catch (cause) { setError(getSafeErrorMessage(cause, "Não foi possível duplicar o motivo.")); }
    finally { setBusy(false); }
  }
  return <form className="admin-row" aria-label={`Motivo ${reason.label}`} onSubmit={(event) => void save(event)}><div className="admin-row-heading"><strong>{reason.label}</strong><span className={active ? "text-success" : "text-danger"}>{active ? "Ativo" : "Desativado"}</span></div><small>{reasonTypeLabels[reason.type]}</small><label>Descrição<input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={160} required /></label><label className="admin-check"><input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} /> Disponível para seleção</label>{error && <p className="form-alert" role="alert">{error}</p>}<ActionButton tone="ghost" type="submit" state={busy ? "pending" : "idle"} aria-label={`Salvar ${reason.code}`}>{busy ? "Salvando…" : "Salvar"}</ActionButton><ActionButton tone="ghost" type="button" state={busy ? "pending" : "idle"} onClick={() => void duplicate()} aria-label={`Duplicar ${reason.label}`}>Duplicar</ActionButton></form>;
}
