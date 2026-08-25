"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Priority } from "@cvg/contracts";
import { ApiClientError, apiFetch, createClientUniqueId, formatRelativeTime, getSafeErrorMessage } from "./api-client";
import { PriorityBadge, StatusBadge } from "./status-badge";
import { ManagementDashboard } from "./management-dashboard";
import { PatientDialog, type CreatedPatientPayload } from "./patient-dialog";

interface Item { id: string; status: Parameters<typeof StatusBadge>[0]["status"]; priority: Priority; dueAt: string; service: { name: string; code: string }; note?: string }
interface Request { id: string; requestCode: string; patient: { displayName: string; species: string; sex: string; externalId: string }; priority: Priority; aggregateStatus: string; createdAt: string; items: Item[] }
interface Service { id: string; name: string; code: string; workflowType: string; category: string; requiresSample: boolean; requiresSchedule: boolean }
interface Encounter { id: string; patientId: string; externalId: string; type: "INPATIENT" | "EMERGENCY" | "OUTPATIENT"; status: "OPEN" | "CLOSED"; openedAt: string; closedAt?: string }
interface Stats { overdue: number; recollections: number; newResults: number; critical: number; totalActive: number; updatedAt: string }
interface Notification { id: string; category: string; priority: string; title: string; body: string; createdAt: string; state: string; deepLink: string }
interface SessionUser { displayName: string; role?: string }

const encounterTypeLabels: Record<Encounter["type"], string> = { INPATIENT: "Internação", EMERGENCY: "Emergência", OUTPATIENT: "Atendimento externo" };
const encounterStatusLabels: Record<Encounter["status"], string> = { OPEN: "Em aberto", CLOSED: "Encerrado" };

function encounterLabel(encounter: Encounter): string {
  return `${encounter.externalId} · ${encounterTypeLabels[encounter.type]} · ${encounterStatusLabels[encounter.status]}`;
}

function dashboardDateLabel(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "numeric", month: "long", timeZone: "America/Sao_Paulo" }).formatToParts(date);
  const weekday = parts.find((part) => part.type === "weekday")?.value ?? "";
  const day = parts.find((part) => part.type === "day")?.value ?? "";
  const month = parts.find((part) => part.type === "month")?.value ?? "";
  return `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)} · ${day} de ${month}`;
}

type ResourceStatus = "loading" | "ready" | "error";

interface ResourceState<T> {
  data: T | null;
  status: ResourceStatus;
  error: string | null;
  updatedAt: string | null;
}

function receivedAt(): string {
  return new Date().toISOString();
}

function useDashboardResource<T>(fetcher: () => Promise<T>, fallbackError: string, getUpdatedAt: (data: T) => string = receivedAt) {
  const [state, setState] = useState<ResourceState<T>>({ data: null, status: "loading", error: null, updatedAt: null });
  const requestVersion = useRef(0);

  const load = useCallback(async () => {
    const version = requestVersion.current + 1;
    requestVersion.current = version;
    setState((current) => ({ ...current, status: "loading", error: null }));

    try {
      const data = await fetcher();
      if (requestVersion.current !== version) return;
      setState({ data, status: "ready", error: null, updatedAt: getUpdatedAt(data) });
    } catch (cause) {
      if (requestVersion.current !== version) return;
      setState((current) => ({ ...current, status: "error", error: getSafeErrorMessage(cause, fallbackError) }));
    }
  }, [fallbackError, fetcher, getUpdatedAt]);

  useEffect(() => {
    void load();
  }, [load]);

  return { ...state, load };
}

export function Dashboard() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void apiFetch<{ user: SessionUser }>("/session/me")
      .then((result) => { if (active) setUser(result.user); })
      .catch((cause) => { if (active) setError(getSafeErrorMessage(cause, "Não foi possível atualizar a identificação da equipe.")); });
    return () => { active = false; };
  }, []);

  if (!user && !error) return <DashboardSkeleton />;
  if (error) return <div className="error-state" role="alert"><strong>{error}</strong></div>;
  if (user?.role === "ADMIN") return <TechnicalAdminDashboard displayName={user.displayName} />;
  if (user?.role === "MANAGER") return <ManagementDashboard />;
  return <ClinicalDashboard displayName={user?.displayName ?? "Equipe"} role={user?.role} />;
}

function TechnicalAdminDashboard({ displayName }: { displayName: string }) {
  const firstName = displayName.split(" ")[0] ?? displayName;
  return (
    <div className="dashboard-page admin-landing">
      <div className="page-heading">
        <div><p className="eyebrow">Acesso autorizado</p><h1>Administração <em>técnica.</em></h1><p className="page-lede">Olá, {firstName}. Este é o espaço para manter a configuração e os acessos do Hub.</p></div>
      </div>
      <div className="admin-policy-banner" role="status"><strong>Perfil técnico</strong><p>Dados clínicos, pacientes e solicitações operacionais permanecem protegidos e disponíveis somente nos perfis assistenciais autorizados.</p></div>
      <div className="admin-landing-grid">
        <Link href="/admin" className="panel admin-landing-card">
          <span className="strip-icon" aria-hidden="true">⚙</span>
          <span><strong>Configuração e acesso</strong><small>Catálogo de serviços, políticas e usuários do Hub.</small></span>
          <span className="text-link">Abrir administração <span>→</span></span>
        </Link>
        <section className="panel admin-landing-card" aria-label="Escopo protegido">
          <span className="strip-icon" aria-hidden="true">✦</span>
          <span><strong>Escopo protegido</strong><small>A separação entre operação clínica e administração técnica está ativa.</small></span>
          <span className="admin-landing-status">Protegido</span>
        </section>
      </div>
    </div>
  );
}

function ClinicalDashboard({ displayName, role }: { displayName: string; role?: string }) {
  const [showRequest, setShowRequest] = useState(false);
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<Array<{ id: string; label: string; patient: string; deepLink: string; status: string }>>([]);

  const fetchRequests = useCallback(() => apiFetch<Request[]>("/diagnostic-requests?limit=20"), []);
  const fetchStats = useCallback(() => apiFetch<Stats>("/dashboard"), []);
  const fetchNotifications = useCallback(() => apiFetch<Notification[]>("/notifications?filter=UNREAD"), []);
  const fetchServices = useCallback(() => apiFetch<Service[]>("/diagnostic-services"), []);
  const statsTimestamp = useCallback((data: Stats) => typeof data.updatedAt === "string" ? data.updatedAt : receivedAt(), []);

  const requestsResource = useDashboardResource(fetchRequests, "Não foi possível atualizar as solicitações.");
  const statsResource = useDashboardResource(fetchStats, "Não foi possível atualizar os indicadores.", statsTimestamp);
  const notificationsResource = useDashboardResource(fetchNotifications, "Não foi possível atualizar as notificações.");
  const servicesResource = useDashboardResource(fetchServices, "Não foi possível atualizar os serviços.");
  const { load: loadRequests } = requestsResource;
  const { load: loadStats } = statsResource;
  const { load: loadNotifications } = notificationsResource;
  const { load: loadServices } = servicesResource;

  const reloadAll = useCallback(() => {
    void loadRequests();
    void loadStats();
    void loadNotifications();
    void loadServices();
  }, [loadNotifications, loadRequests, loadServices, loadStats]);

  useEffect(() => {
    const refresh = () => reloadAll();
    const resync = () => reloadAll();
    window.addEventListener("cvg:realtime-updated", refresh);
    window.addEventListener("cvg:realtime-resync", resync);
    return () => { window.removeEventListener("cvg:realtime-updated", refresh); window.removeEventListener("cvg:realtime-resync", resync); };
  }, [reloadAll]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (search.trim().length < 2) { setSearchResults([]); return; }
      void apiFetch<typeof searchResults>(`/search?q=${encodeURIComponent(search)}`).then(setSearchResults).catch(() => setSearchResults([]));
    }, 280);
    return () => window.clearTimeout(timer);
  }, [search]);

  const notifications = notificationsResource.data ?? [];
  const stats = statsResource.data;
  const services = servicesResource.data ?? [];
  const canCreateClinicalRequest = role === undefined || role === "VETERINARIAN" || role === "INPATIENT_TEAM";
  const userName = displayName.split(" ")[1] ?? displayName;
  const activeRequests = useMemo(() => (requestsResource.data ?? []).filter((request) => !["COMPLETED", "CANCELLED"].includes(request.aggregateStatus)), [requestsResource.data]);
  const initialLoading = [requestsResource, statsResource, notificationsResource, servicesResource].every((resource) => resource.status === "loading" && resource.data === null);

  if (initialLoading) return <DashboardSkeleton />;

  return (
    <div className="dashboard-page">
      <div className="page-heading"><div><p className="eyebrow">{dashboardDateLabel()}</p><h1>Bom dia, <em>{userName}.</em></h1><p className="page-lede">Aqui está o que merece sua atenção agora.</p></div>{canCreateClinicalRequest && <button type="button" className="button button-primary" onClick={() => setShowRequest(true)}><span>＋</span> Nova solicitação</button>}</div>
      <div className="search-bar"><span aria-hidden="true">⌕</span><input aria-label="Buscar no Hub" placeholder="Buscar protocolo, paciente, serviço ou accession…" value={search} onChange={(event) => setSearch(event.target.value)} /><kbd>⌘ K</kbd>{searchResults.length > 0 && <div className="search-popover">{searchResults.map((result) => <Link key={result.id} href={result.deepLink} onClick={() => setSearch("")}><span className="search-icon">↗</span><span><strong>{result.label}</strong><small>{result.patient} · {result.status}</small></span></Link>)}</div>}</div>
      <section className="metric-grid" aria-label="Indicadores de atenção" aria-busy={statsResource.status === "loading"}>
        {!stats && <ResourceFeedback resource={statsResource} label="indicadores" onRetry={loadStats} />}
        {stats && <>
          {statsResource.error && <ResourceFeedback resource={statsResource} label="indicadores" onRetry={loadStats} />}
          <MetricCard label="Atrasados" value={stats.overdue} tone="danger" caption="exigem intervenção" icon="◷" />
          <MetricCard label="Recoletas" value={stats.recollections} tone="warning" caption="aguardando nova amostra" icon="⌁" />
          <MetricCard label="Resultados novos" value={stats.newResults} tone="success" caption="aguardando revisão" icon="↗" />
          <MetricCard label="Críticos" value={stats.critical} tone="critical" caption="confirmação necessária" icon="!" />
        </>}
      </section>
      <div className="dashboard-columns">
        <section className="panel attention-panel" aria-busy={requestsResource.status === "loading"}>
          <div className="panel-heading"><div><p className="eyebrow">Acompanhe de perto</p><h2>Solicitações em andamento</h2></div><Link href="/queues" className="text-link">Ver central <span>→</span></Link></div>
          {requestsResource.error && requestsResource.data && <ResourceFeedback resource={requestsResource} label="solicitações" onRetry={loadRequests} />}
          {!requestsResource.data ? <ResourceFeedback resource={requestsResource} label="solicitações" onRetry={loadRequests} /> : activeRequests.length === 0 ? <EmptyState title="Nenhuma solicitação pendente" description="Quando um exame precisar de ação, ele aparecerá aqui." /> : <div className="request-list">{activeRequests.slice(0, 6).map((request) => <RequestRow key={request.id} request={request} />)}</div>}
        </section>
        <section className="panel notification-panel" aria-busy={notificationsResource.status === "loading"}>
          <div className="panel-heading"><div><p className="eyebrow">Ação necessária</p><h2>Últimas notificações</h2></div><Link href="/notifications" className="text-link">Ver todas <span>→</span></Link></div>
          {notificationsResource.error && notificationsResource.data && <ResourceFeedback resource={notificationsResource} label="notificações" onRetry={loadNotifications} />}
          {!notificationsResource.data ? <ResourceFeedback resource={notificationsResource} label="notificações" onRetry={loadNotifications} /> : notifications.length === 0 ? <EmptyState title="Tudo em dia" description="Nenhuma nova ação no seu escopo." compact /> : <div className="notification-list">{notifications.slice(0, 4).map((notification) => <NotificationRow key={notification.id} notification={notification} />)}</div>}
        </section>
      </div>
      <section className="bottom-strip"><div><span className="strip-icon">✦</span><div><strong>Visibilidade ponta a ponta</strong><p>Os estados são confirmados pelo servidor e auditados em uma única timeline.</p></div></div><span className="strip-status">Atualizado {stats ? formatRelativeTime(stats.updatedAt) : "indisponível"}</span></section>
      {showRequest && <RequestDialog canCreatePatient={canCreateClinicalRequest} services={services} servicesError={servicesResource.error} onRetryServices={loadServices} onClose={() => setShowRequest(false)} onCreated={() => { setShowRequest(false); reloadAll(); }} />}
    </div>
  );
}

function ResourceFeedback<T>({ resource, label, onRetry }: { resource: ResourceState<T> & { load: () => Promise<void> }; label: string; onRetry: () => Promise<void> }) {
  if (resource.status === "loading" && resource.data === null) return <div className="resource-loading" role="status">Carregando {label}…</div>;
  if (resource.status !== "error" || !resource.error) return null;
  return (
    <div className="resource-feedback" role="alert">
      <div><strong>{resource.error}</strong>{resource.updatedAt && <><span>Dados possivelmente desatualizados</span><small>Atualizado {formatRelativeTime(resource.updatedAt)}</small></>}</div>
      <button type="button" className="button button-ghost" onClick={() => void onRetry()} aria-label={`Tentar novamente: ${label}`}>Tentar novamente</button>
    </div>
  );
}

function MetricCard({ label, value, tone, caption, icon }: { label: string; value: number; tone: string; caption: string; icon: string }) {
  return <article className={`metric-card metric-${tone}`}><div className="metric-top"><span>{label}</span><b aria-hidden="true">{icon}</b></div><strong>{value}</strong><small>{caption}</small></article>;
}

function RequestRow({ request }: { request: Request }) {
  const primary = request.items[0];
  return <Link href={`/requests/${request.id}`} className="request-row"><div className="patient-chip"><span className="patient-avatar">{request.patient.displayName.slice(0, 1)}</span><span><strong>{request.patient.displayName}</strong><small>{request.patient.species} · {request.patient.sex} · {request.patient.externalId}</small></span></div><div className="request-service"><strong>{request.items.length > 1 ? `${primary.service.name} + ${request.items.length - 1}` : primary.service.name}</strong><small>{request.requestCode} · {formatRelativeTime(request.createdAt)}</small></div><div className="request-state"><PriorityBadge priority={request.priority} /><StatusBadge status={primary.status} /></div><span className="row-arrow" aria-hidden="true">→</span></Link>;
}

function NotificationRow({ notification }: { notification: Notification }) {
  return <Link href={notification.deepLink} className="notification-row"><span className={`notification-dot notification-${notification.category.toLowerCase()}`} /><span className="notification-copy"><strong>{notification.title}</strong><small>{notification.body}</small><time>{formatRelativeTime(notification.createdAt)}</time></span><span aria-hidden="true" className="row-arrow">→</span></Link>;
}

function EmptyState({ title, description, compact = false }: { title: string; description: string; compact?: boolean }) { return <div className={`empty-state ${compact ? "empty-compact" : ""}`}><span aria-hidden="true">✓</span><strong>{title}</strong><p>{description}</p></div>; }

function DashboardSkeleton() { return <div className="dashboard-page"><div className="skeleton-heading skeleton-block" /><div className="skeleton-search skeleton-block" /><div className="metric-grid">{[1, 2, 3, 4].map((item) => <div key={item} className="metric-card skeleton-card" />)}</div><div className="dashboard-columns"><div className="panel skeleton-panel" /><div className="panel skeleton-panel" /></div></div>; }

function RequestDialog({ canCreatePatient, services, servicesError, onRetryServices, onClose, onCreated }: { canCreatePatient: boolean; services: Service[]; servicesError: string | null; onRetryServices: () => Promise<void>; onClose: () => void; onCreated: () => void }) {
  const [patients, setPatients] = useState<Array<{ id: string; displayName: string; species: string; externalId: string }>>([]);
  const [patientId, setPatientIdState] = useState("");
  const [encounters, setEncounters] = useState<Encounter[]>([]);
  const [encounterId, setEncounterId] = useState("");
  const patientIdRef = useRef("");
  const encounterIdRef = useRef("");
  const [encountersLoading, setEncountersLoading] = useState(false);
  const [encountersError, setEncountersError] = useState("");
  const encounterLoadVersion = useRef(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [priority, setPriority] = useState<Priority>("ROUTINE");
  const [error, setError] = useState("");
  const [duplicateWarning, setDuplicateWarning] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  const [showPatientCreate, setShowPatientCreate] = useState(false);
  const [patientNotice, setPatientNotice] = useState("");
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => { void apiFetch<typeof patients>("/patients").then(setPatients).catch(() => setError("Não foi possível carregar os pacientes.")); }, []);
  const loadEncounters = useCallback(async (nextPatientId: string) => {
    const version = encounterLoadVersion.current + 1;
    encounterLoadVersion.current = version;
    setEncountersLoading(true);
    setEncountersError("");
    try {
      const nextEncounters = await apiFetch<Encounter[]>(`/patients/${encodeURIComponent(nextPatientId)}/encounters`);
      if (encounterLoadVersion.current !== version) return;
      setEncounters(nextEncounters);
    } catch (cause) {
      if (encounterLoadVersion.current !== version) return;
      setEncounters([]);
      setEncountersError(getSafeErrorMessage(cause, "Não foi possível carregar os atendimentos."));
    } finally {
      if (encounterLoadVersion.current === version) setEncountersLoading(false);
    }
  }, []);
  function setPatientId(nextPatientId: string) {
    encounterLoadVersion.current += 1;
    patientIdRef.current = nextPatientId;
    encounterIdRef.current = "";
    setPatientIdState(nextPatientId);
    setEncounters([]);
    setEncounterId("");
    setEncountersError("");
    setPatientNotice("");
    setEncountersLoading(Boolean(nextPatientId));
    if (nextPatientId) void loadEncounters(nextPatientId);
  }
  function onPatientCreated(result: CreatedPatientPayload) {
    encounterLoadVersion.current += 1;
    patientIdRef.current = result.patient.id;
    encounterIdRef.current = result.encounter.id;
    setPatients((current) => [...current.filter((patient) => patient.id !== result.patient.id), result.patient]);
    setPatientIdState(result.patient.id);
    setEncounters([result.encounter]);
    setEncounterId(result.encounter.id);
    setEncountersError("");
    setEncountersLoading(false);
    setPatientNotice(`${result.patient.displayName} foi cadastrado e já está com atendimento aberto.`);
    setShowPatientCreate(false);
  }
  function setEncounter(nextEncounterId: string) {
    encounterIdRef.current = nextEncounterId;
    setEncounterId(nextEncounterId);
  }
  useEffect(() => () => { encounterLoadVersion.current += 1; }, []);
  async function submit() {
    const currentPatientId = patientIdRef.current;
    const currentEncounterId = encounterIdRef.current;
    setSubmitting(true);
    setError("");
    if (!currentPatientId || !currentEncounterId || selected.length === 0) {
      setError(!currentPatientId ? "Escolha um paciente." : !currentEncounterId ? "Escolha um atendimento." : "Escolha pelo menos um serviço.");
      setSubmitting(false);
      return;
    }
    if (duplicateWarning && !overrideReason.trim()) {
      setError("Explique por que o exame duplicado deve prosseguir.");
      setSubmitting(false);
      return;
    }
    try {
      await apiFetch("/diagnostic-requests", {
        method: "POST",
        headers: {
          "x-correlation-id": `ui-${createClientUniqueId()}`,
          ...(duplicateWarning ? { "x-duplicate-override": "true" } : {})
        },
        body: JSON.stringify({
          patientId: currentPatientId,
          encounterId: currentEncounterId,
          priority,
          items: selected.map((serviceId) => ({ serviceId })),
          ...(duplicateWarning ? { overrideReason: overrideReason.trim() } : {})
        })
      });
      onCreated();
    } catch (cause) {
      if (cause instanceof ApiClientError && cause.code === "DUPLICATE_WARNING") {
        setDuplicateWarning(true);
        setError("Já existe um exame ativo compatível. Revise o contexto e informe o motivo para prosseguir.");
      } else {
        setError(getSafeErrorMessage(cause, "Não foi possível criar a solicitação."));
      }
    } finally {
      setSubmitting(false);
    }
  }
  return <>
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}><section className="dialog" role="dialog" aria-modal="true" aria-labelledby="request-dialog-title"><div className="dialog-heading"><div><p className="eyebrow">Novo fluxo</p><h2 id="request-dialog-title">Solicitar exames</h2><p>O atendimento e o setor serão confirmados pelo servidor.</p></div><button type="button" className="icon-button" onClick={onClose} aria-label="Fechar">×</button></div><div className="dialog-field-heading"><label htmlFor="request-patient">Paciente</label>{canCreatePatient && <button type="button" className="text-button" onClick={() => setShowPatientCreate(true)}>＋ Cadastrar paciente</button>}</div><select id="request-patient" value={patientId} onChange={(event) => setPatientId(event.target.value)}><option value="">Selecione um paciente…</option>{patients.map((patient) => <option key={patient.id} value={patient.id}>{patient.displayName} · {patient.species} · {patient.externalId}</option>)}</select>{patientNotice && <div className="form-success" role="status">{patientNotice}</div>}<label>Atendimento<select aria-label="Atendimento" aria-describedby="request-encounter-help" value={encounterId} onChange={(event) => setEncounter(event.target.value)} disabled={!patientId || encountersLoading || encounters.length === 0} aria-busy={encountersLoading}><option value="">Selecione um atendimento…</option>{encounters.map((encounter) => <option key={encounter.id} value={encounter.id}>{encounterLabel(encounter)}</option>)}</select><small id="request-encounter-help" className="field-hint">Para um paciente novo, o tipo é definido em “Cadastrar paciente”; na internação, você informa ala e leito.</small>{encountersLoading && <small role="status">Carregando atendimentos…</small>}</label>{encountersError && <div className="form-alert" role="alert"><span>{encountersError}</span><button type="button" className="button button-ghost" onClick={() => void loadEncounters(patientId)} disabled={encountersLoading}>Tentar carregar atendimentos</button></div>}<fieldset><legend>Serviços</legend>{servicesError && <div className="form-alert" role="alert">{servicesError}<button type="button" className="button button-ghost" onClick={() => void onRetryServices()}>Tentar carregar serviços</button></div>}<div className="service-options">{services.map((service) => <label key={service.id} className={`service-option ${selected.includes(service.id) ? "selected" : ""}`}><input type="checkbox" checked={selected.includes(service.id)} onChange={() => setSelected((current) => current.includes(service.id) ? current.filter((id) => id !== service.id) : [...current, service.id])} /><span><strong>{service.name}</strong><small>{service.workflowType === "LABORATORY" ? "Laboratório" : service.workflowType === "ULTRASOUND" ? "Ultrassom" : "Radiologia"}</small></span><b aria-hidden="true">✓</b></label>)}</div></fieldset>{duplicateWarning && <label>Motivo para prosseguir com a duplicidade<textarea aria-label="Motivo para prosseguir com a duplicidade" value={overrideReason} onChange={(event) => setOverrideReason(event.target.value)} rows={2} maxLength={500} placeholder="Explique a necessidade clínica ou operacional." /></label>}<div className="priority-picker"><span>Prioridade</span>{(["ROUTINE", "URGENT", "EMERGENCY"] as Priority[]).map((value) => <button key={value} type="button" className={priority === value ? "selected" : ""} onClick={() => setPriority(value)}>{value === "ROUTINE" ? "Rotina" : value === "URGENT" ? "Urgente" : "Emergência"}</button>)}</div>{error && <div className="form-alert" role="alert">{error}</div>}<div className="dialog-actions"><button type="button" className="button button-ghost" onClick={onClose}>Cancelar</button><button type="button" className="button button-primary" onClick={() => void submit()} disabled={submitting}>{submitting ? "Confirmando…" : duplicateWarning ? "Confirmar duplicidade" : "Confirmar solicitação"}<span>→</span></button></div></section></div>
    {showPatientCreate && <PatientDialog nested onClose={() => setShowPatientCreate(false)} onCreated={onPatientCreated} />}
  </>;
}
