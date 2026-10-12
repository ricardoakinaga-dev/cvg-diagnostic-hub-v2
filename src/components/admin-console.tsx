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
const catalogActions = ["service.catalog.create", "service.catalog.update", "service.catalog.deactivate"] as const;
function mayChangeCatalog(permissions: readonly Permission[] | undefined, action: typeof catalogActions[number]): boolean {
  return Boolean(permissions?.includes(action) || permissions?.includes("service.catalog.manage"));
}

export function AdminConsole({ section = "all" }: { section?: "all" | "users" | "catalog" } = {}) {
  const [services, setServices] = useState<CatalogService[]>([]);
  const [reasons, setReasons] = useState<ReasonCode[]>([]);
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [identity, setIdentity] = useState<SessionUser | null>(null);
  const directoryScope = identity?.permissions?.includes("department.view") ? JSON.stringify([identity.id, identity.role, identity.departmentCode, [...(identity.managedDepartmentCodes ?? [])].sort()]) : undefined;
  const directory = useDepartments(directoryScope, { includeInactive: true });
  const [error, setError] = useState("");
  const [accessDenied, setAccessDenied] = useState(false);
  const [loading, setLoading] = useState(true);
  const loadVersion = useRef(0);
  const snapshotAuthority = useRef<string | null>(null);

  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    setLoading(true); setError(""); setAccessDenied(false);
    const evict = () => { snapshotAuthority.current = null; setIdentity(null); setServices([]); setReasons([]); setUsers([]); };
    try {
      const session = await apiFetch<SessionResponse>("/session/me");
      if (loadVersion.current !== version) return;
      const current = { ...session.user, permissions: session.user.permissions ?? [] };
      const catalogMutation = catalogActions.some((action) => mayChangeCatalog(current.permissions, action));
      const mayOpen = section === "catalog" ? current.permissions.includes("service.catalog.view") || catalogMutation : ["SUPERADMIN", "ADMIN", "MANAGER"].includes(current.role);
      if (!mayOpen) {
        evict(); setAccessDenied(true);
        return;
      }
      const authority = JSON.stringify([current.id, current.role, current.departmentCode, [...(current.managedDepartmentCodes ?? [])].sort(), [...current.permissions].sort()]);
      if (snapshotAuthority.current !== authority) { setServices([]); setReasons([]); setUsers([]); }
      snapshotAuthority.current = authority;
      setIdentity(current);
      const [serviceResult, reasonResult, userResult] = await Promise.allSettled([
        catalogMutation ? apiFetch<CatalogService[]>("/diagnostic-services?includeInactive=true") : current.permissions.includes("service.catalog.view") ? apiFetch<CatalogService[]>("/diagnostic-services") : Promise.resolve([]),
        current.permissions.includes("reason_code.manage") ? apiFetch<ReasonCode[]>("/reason-codes") : Promise.resolve([]), canAdminister(current, "user.view", "user_role.manage") ? apiFetch<ManagedUser[]>("/users") : Promise.resolve([])
      ]);
      if (loadVersion.current !== version) return;
      const failures = [serviceResult, reasonResult, userResult].filter((result) => result.status === "rejected");
      if (failures.some((result) => result.reason instanceof ApiClientError && [401, 403, 404].includes(result.reason.status))) { evict(); setAccessDenied(true); return; }
      setServices(serviceResult.status === "fulfilled" ? serviceResult.value : []);
      setReasons(reasonResult.status === "fulfilled" ? reasonResult.value : []);
      setUsers(userResult.status === "fulfilled" ? userResult.value : []);
      if (failures.length) setError("Parte da configuração está indisponível. Tente atualizar.");
    } catch (cause) {
      if (loadVersion.current !== version) return;
      evict();
      if (cause instanceof ApiClientError && [401, 403, 404].includes(cause.status)) setAccessDenied(true);
      else setError(getSafeErrorMessage(cause, "Não foi possível carregar a administração."));
    } finally { if (loadVersion.current === version) setLoading(false); }
  }, [section]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    const refresh = () => { void load(); };
    window.addEventListener("cvg:realtime-resync", refresh);
    return () => { window.clearTimeout(timer); loadVersion.current += 1; window.removeEventListener("cvg:realtime-resync", refresh); };
  }, [load]);

  const permissions = identity?.permissions ?? [];
  const canCreateService = mayChangeCatalog(permissions, "service.catalog.create");
  const canImport = catalogActions.some((action) => mayChangeCatalog(permissions, action));
  const canManageReasons = permissions.includes("reason_code.manage");

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
        {section !== "catalog" && <section className="panel" id="users"><div className="panel-heading"><h2>Colaboradores</h2><span className="timeline-count">{users.length}</span></div><UserCreateForm departments={directory.departments} creator={loading ? { ...identity, permissions: [] } : identity} services={services} onCreated={(user) => setUsers((current) => [...current.filter((entry) => entry.id !== user.id), user])} />{users.length === 0 ? <EmptyState title="Nenhum colaborador administrável" message="Adicione um colaborador ao seu setor." /> : <div className="admin-list">{users.map((user) => <UserRow permissions={loading ? [] : permissions} departments={directory.departments} key={`${identity.id}:${user.id}`} user={user} viewerId={identity.id} services={services} departmentCodes={departmentCodes} technical={["ADMIN", "SUPERADMIN"].includes(identity.role)} superadmin={identity.role === "SUPERADMIN"} onChanged={(updated) => setUsers((current) => current.map((entry) => entry.id === updated.id ? updated : entry))} />)}</div>}</section>}
        {section !== "users" && <section className="panel" id="catalog"><div className="panel-heading"><h2>Serviços diagnósticos</h2><span className="timeline-count">{services.length}</span></div>{canImport && !loading && <CatalogImportPanel onApplied={() => void load()} />}{canCreateService && (directory.departments.some((department) => department.active) ? <ServiceCreateForm readOnly={loading} creator={identity} departments={directory.departments} existingCodes={services.map((service) => service.code)} onSaved={() => void load()} /> : <p className="field-hint">{directory.loading ? "Carregando setores para novos serviços…" : "Nenhum setor ativo autorizado para criar serviços."}</p>)}{services.length === 0 ? <EmptyState title="Nenhum serviço no escopo de gestão" message="Adicione o primeiro serviço." /> : <div className="admin-list">{services.map((service) => <ServiceRow key={`${identity.id}:${service.id}:${service.version}`} readOnly={loading} service={service} departments={directory.departments} permissions={permissions} existingCodes={services.map((entry) => entry.code)} onSaved={() => void load()} />)}</div>}</section>}
        {section !== "users" && <section className="panel" id="reasons"><div className="panel-heading"><h2>Motivos</h2><span className="timeline-count">{reasons.length}</span></div>{canManageReasons && <ReasonCreateForm readOnly={loading} permissions={permissions} existingCodes={reasons.map((reason) => reason.code)} onSaved={() => void load()} />}{reasons.length === 0 ? <EmptyState title="Nenhum motivo configurado" message="Adicione um motivo para seleção nos fluxos clínicos." /> : <div className="admin-list">{reasons.map((reason) => <ReasonRow key={`${identity.id}:${reason.id}:${reason.version}`} readOnly={loading} permissions={permissions} reason={reason} existingCodes={reasons.map((entry) => entry.code)} onSaved={() => void load()} />)}</div>}</section>}
        {section === "all" && !loading && permissions.includes("patient.data_export") && ["ADMIN", "SUPERADMIN"].includes(identity.role) && <section className="panel" id="privacy"><div className="panel-heading"><h2>Privacidade (LGPD)</h2></div><DataSubjectExportPanel /></section>}
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

function ServiceCreateForm({ creator, departments, existingCodes, onSaved, readOnly }: { creator: SessionUser; departments: Department[]; existingCodes: string[]; onSaved: () => void; readOnly: boolean }) {
  const [draft, setDraft] = useState<ServiceDraft>(() => createServiceDraft(creator, departments));
  const effectiveDraft = draft.departmentCode ? draft : { ...draft, departmentCode: createServiceDraft(creator, departments).departmentCode };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (readOnly || busy || !mayChangeCatalog(creator.permissions, "service.catalog.create")) return;
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

  return <form className="admin-create-form" aria-label="Adicionar serviço" onSubmit={(event) => void save(event)}><ServiceFields disabled={readOnly || busy} draft={effectiveDraft} departments={departments} onChange={setDraft} />{error && <p className="form-alert" role="alert">{error}</p>}<ActionButton type="submit" state={busy ? "pending" : "idle"} disabled={readOnly || !draft.name.trim() || !departments.some((department) => department.active && department.code === effectiveDraft.departmentCode)}>{busy ? "Criando…" : "Criar serviço"}</ActionButton></form>;
}

function ServiceRow({ service, departments, permissions = [], existingCodes, onSaved, readOnly }: { service: CatalogService; departments: Department[]; permissions?: readonly Permission[]; existingCodes: string[]; onSaved: () => void; readOnly: boolean }) {
  const [draft, setDraft] = useState<ServiceDraft>(() => ({ code: service.code, name: service.name, category: service.category ?? "LABORATORY", departmentCode: service.departmentCode, workflowType: service.workflowType ?? "LABORATORY", requiresSample: service.requiresSample ?? false, sampleType: service.sampleType ?? "", requiresSchedule: service.requiresSchedule ?? false, allowsAttachment: service.allowsAttachment ?? false, resultSchema: service.resultSchema ?? "NARRATIVE", slaHours: { ...service.slaHours } }));
  const [active, setActive] = useState(service.active);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const canUpdate = mayChangeCatalog(permissions, "service.catalog.update");
  const canDeactivate = mayChangeCatalog(permissions, "service.catalog.deactivate");
  const canCreate = mayChangeCatalog(permissions, "service.catalog.create");
  const canChangeAvailability = service.active ? canDeactivate : canUpdate;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const availabilityChanged = active !== service.active;
    if (readOnly || busy || (!canUpdate && !(canDeactivate && service.active && !active)) || (availabilityChanged && !(active ? canUpdate : canDeactivate))) return;
    setBusy(true);
    setError("");
    try {
      const { code: _code, ...editableDraft } = servicePayload(draft);
      await apiFetch(`/diagnostic-services/${service.id}`, { method: "PATCH", body: JSON.stringify({ ...(canUpdate ? { ...editableDraft, sampleType: editableDraft.sampleType ?? null } : {}), ...(availabilityChanged ? { active } : {}), expectedVersion: service.version }) });
      onSaved();
    } catch (cause) {
      setError(getSafeErrorMessage(cause, "Não foi possível salvar o serviço."));
    } finally { setBusy(false); }
  }

  async function duplicate() {
    if (readOnly || busy || !canCreate || !departments.some((department) => department.code === draft.departmentCode && department.active)) return;
    setBusy(true); setError("");
    const name = `${draft.name.slice(0, 112)} (cópia)`;
    try {
      await apiFetch("/diagnostic-services", { method: "POST", body: JSON.stringify({ ...servicePayload(draft), name, code: codeFromName(name, existingCodes), duplicateOfServiceId: service.id }) });
      onSaved();
    } catch (cause) { setError(getSafeErrorMessage(cause, "Não foi possível duplicar o serviço.")); }
    finally { setBusy(false); }
  }

  return <><form className="admin-row" aria-label={`Serviço ${service.name}`} onSubmit={(event) => void save(event)}><div className="admin-row-heading"><strong>{service.name}</strong><span className={active ? "text-success" : "text-danger"}>{active ? "Ativo" : "Desativado"}</span></div><small>{departments.find((department) => department.code === draft.departmentCode)?.name ?? draft.departmentCode} · {workflowLabels[draft.workflowType]}</small><ServiceFields disabled={!canUpdate || readOnly || busy} draft={draft} departments={departments} onChange={setDraft} /><label className="admin-check"><input type="checkbox" disabled={readOnly || busy || !canChangeAvailability} checked={active} onChange={(event) => { if (!readOnly && !busy && canChangeAvailability) setActive(event.target.checked); }} /> Disponível no catálogo</label>{error && <p className="form-alert" role="alert">{error}</p>}<div className="admin-action-row">{(canUpdate || (canDeactivate && service.active)) && <ActionButton tone="ghost" type="submit" state={busy ? "pending" : "idle"} disabled={readOnly || (!canUpdate && active === service.active)} aria-label={`Salvar ${service.name}`}>{busy ? "Salvando…" : "Salvar"}</ActionButton>}{canCreate && <ActionButton tone="ghost" type="button" state={busy ? "pending" : "idle"} disabled={readOnly || !departments.some((department) => department.code === draft.departmentCode && department.active)} onClick={() => void duplicate()} aria-label={`Duplicar ${service.name}`}>Duplicar</ActionButton>}</div></form><ExamDefinitionEditor service={service} permissions={readOnly ? [] : permissions} onSaved={onSaved} /></>;
}

function ServiceFields({ draft, departments, onChange, disabled }: { draft: ServiceDraft; departments: Department[]; onChange: (next: ServiceDraft) => void; disabled: boolean }) {
  const set = <K extends keyof ServiceDraft>(key: K, value: ServiceDraft[K]) => onChange({ ...draft, [key]: value });
  const setSla = (key: keyof ServiceDraft["slaHours"], value: number) => onChange({ ...draft, slaHours: { ...draft.slaHours, [key]: value } });
  return <div className="admin-service-fields">

    <label>Nome<input disabled={disabled} value={draft.name} onChange={(event) => set("name", event.target.value)} maxLength={120} required /></label>
    <details className="admin-create"><summary>Opções avançadas do exame</summary>
    <div className="admin-role-grid"><label>Categoria<select disabled={disabled} value={draft.category} onChange={(event) => set("category", event.target.value as ServiceCategory)}><option value="LABORATORY">Laboratório</option><option value="IMAGING">Imagem</option></select></label><label>Workflow<select disabled={disabled} value={draft.workflowType} onChange={(event) => set("workflowType", event.target.value as WorkflowType)}><option value="LABORATORY">Laboratório</option><option value="RADIOLOGY">Radiologia</option><option value="ULTRASOUND">Ultrassom</option></select></label></div>
    <label>Setor<select disabled={disabled} value={draft.departmentCode} onChange={(event) => set("departmentCode", event.target.value)} required><option value="">Selecione um setor ativo</option>{departmentOptions(departments, [draft.departmentCode]).map((department) => <option key={department.code} value={department.code} disabled={!department.active}>{department.name}{!department.active ? " (vínculo existente)" : ""}</option>)}</select></label><small className="field-hint">Novos serviços usam setores ativos do cadastro institucional.</small>
    <div className="admin-check-grid"><label className="admin-check"><input disabled={disabled} type="checkbox" checked={draft.requiresSample} onChange={(event) => set("requiresSample", event.target.checked)} /> Exige amostra</label><label className="admin-check"><input disabled={disabled} type="checkbox" checked={draft.requiresSchedule} onChange={(event) => set("requiresSchedule", event.target.checked)} /> Exige agenda</label><label className="admin-check"><input disabled={disabled} type="checkbox" checked={draft.allowsAttachment} onChange={(event) => set("allowsAttachment", event.target.checked)} /> Aceita anexo</label></div>
    {draft.requiresSample && <label>Tipo de amostra<input disabled={disabled} value={draft.sampleType} onChange={(event) => set("sampleType", event.target.value)} maxLength={60} placeholder="EDTA, soro, urina…" /></label>}
    <label>Modelo de resultado<select disabled={disabled} value={draft.resultSchema} onChange={(event) => set("resultSchema", event.target.value as ResultSchema)}><option value="NUMERIC_PANEL">Painel numérico</option><option value="NARRATIVE">Narrativo</option></select></label>
    <div className="admin-sla-grid"><label>SLA rotina (h)<input disabled={disabled} type="number" min="1" max="720" value={draft.slaHours.ROUTINE} onChange={(event) => setSla("ROUTINE", Number(event.target.value))} /></label><label>SLA urgente (h)<input disabled={disabled} type="number" min="1" max="720" value={draft.slaHours.URGENT} onChange={(event) => setSla("URGENT", Number(event.target.value))} /></label><label>SLA emergência (h)<input disabled={disabled} type="number" min="1" max="720" value={draft.slaHours.EMERGENCY} onChange={(event) => setSla("EMERGENCY", Number(event.target.value))} /></label></div>
    </details>
  </div>;
}

function ReasonCreateForm({ existingCodes, onSaved, permissions, readOnly }: { existingCodes: string[]; onSaved: () => void; permissions: readonly Permission[]; readOnly: boolean }) {
  const [type, setType] = useState<ReasonCode["type"]>("RECOLLECTION");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (readOnly || busy || !permissions.includes("reason_code.manage")) return; setBusy(true); setError("");
    try { await apiFetch("/reason-codes", { method: "POST", body: JSON.stringify({ type, code: codeFromName(label, existingCodes), label: label.trim() }) }); setLabel(""); onSaved(); }
    catch (cause) { setError(getSafeErrorMessage(cause, "Não foi possível criar o motivo.")); }
    finally { setBusy(false); }
  }
  return <details className="admin-create"><summary><Icon name="add" size={14} /> Adicionar motivo</summary><form className="admin-create-form" onSubmit={(event) => void save(event)}><label>Tipo<select disabled={readOnly || busy} value={type} onChange={(event) => setType(event.target.value as ReasonCode["type"])}><option value="RECOLLECTION">Recoleta</option><option value="CANCEL">Cancelamento</option><option value="REJECT">Rejeição</option><option value="AMEND">Emenda</option></select></label><label>Descrição<input disabled={readOnly || busy} value={label} onChange={(event) => setLabel(event.target.value)} maxLength={160} required /></label>{error && <p className="form-alert" role="alert">{error}</p>}<ActionButton disabled={readOnly} type="submit" state={busy ? "pending" : "idle"}>{busy ? "Criando…" : "Criar motivo"}</ActionButton></form></details>;
}

function ReasonRow({ reason, existingCodes, onSaved, permissions, readOnly }: { reason: ReasonCode; existingCodes: string[]; onSaved: () => void; permissions: readonly Permission[]; readOnly: boolean }) {
  const [label, setLabel] = useState(reason.label);
  const [active, setActive] = useState(reason.active);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const canManage = permissions.includes("reason_code.manage");
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (readOnly || busy || !canManage) return; setBusy(true); setError("");
    try { await apiFetch(`/reason-codes/${reason.id}`, { method: "PATCH", body: JSON.stringify({ label: label.trim(), active, expectedVersion: reason.version }) }); onSaved(); }
    catch (cause) { setError(getSafeErrorMessage(cause, "Não foi possível salvar o motivo.")); }
    finally { setBusy(false); }
  }
  async function duplicate() {
    if (readOnly || busy || !canManage) return;
    setBusy(true); setError("");
    const copyLabel = `${label.slice(0, 152)} (cópia)`;
    try { await apiFetch("/reason-codes", { method: "POST", body: JSON.stringify({ type: reason.type, label: copyLabel, code: codeFromName(copyLabel, existingCodes) }) }); onSaved(); }
    catch (cause) { setError(getSafeErrorMessage(cause, "Não foi possível duplicar o motivo.")); }
    finally { setBusy(false); }
  }
  return <form className="admin-row" aria-label={`Motivo ${reason.label}`} onSubmit={(event) => void save(event)}><div className="admin-row-heading"><strong>{reason.label}</strong><span className={active ? "text-success" : "text-danger"}>{active ? "Ativo" : "Desativado"}</span></div><small>{reasonTypeLabels[reason.type]}</small><label>Descrição<input disabled={readOnly || busy || !canManage} value={label} onChange={(event) => setLabel(event.target.value)} maxLength={160} required /></label><label className="admin-check"><input disabled={readOnly || busy || !canManage} type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} /> Disponível para seleção</label>{error && <p className="form-alert" role="alert">{error}</p>}{canManage && <ActionButton disabled={readOnly} tone="ghost" type="submit" state={busy ? "pending" : "idle"} aria-label={`Salvar ${reason.code}`}>{busy ? "Salvando…" : "Salvar"}</ActionButton>}{canManage && <ActionButton disabled={readOnly} tone="ghost" type="button" state={busy ? "pending" : "idle"} onClick={() => void duplicate()} aria-label={`Duplicar ${reason.label}`}>Duplicar</ActionButton>}</form>;
}
