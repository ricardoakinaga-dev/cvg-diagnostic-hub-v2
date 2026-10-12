"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import type { Notification, SessionResponse } from "@cvg/contracts";
import { ApiClientError, apiFetch, getSafeErrorMessage } from "./api-client";
import { ErrorState, LoadingState } from "./feedback-states";
import { Icon, type IconName } from "./ui-icons";
import { CommandPalette } from "./command-palette";
import { PatientDialog } from "./patient-dialog";
import { PageHeader, type Crumb } from "./page-header";
import { Avatar, DepartmentIcon } from "./work-items/icons";
import { departmentOptions, useDepartments } from "./use-departments";
import { DepartmentLabelsProvider } from "./department-labels";
import { WorkflowPermissionsProvider } from "./workflow-permissions";
import type { Department, DiagnosticService } from "@cvg/contracts";
import styles from "./app-shell.module.css";

type LiveStatus = "connecting" | "connected" | "degraded";
const REALTIME_FALLBACK_INTERVAL_MS = 30_000;
// Every page mounts its own shell, so each navigation opens a new stream and
// receives the server replay window (REALTIME_REPLAY_WINDOW, 20 by default) in
// one burst. Listeners refetch their whole view per event. The first event
// refreshes at once, as before; later events inside the window collapse into
// one trailing refresh, so a burst costs two refreshes instead of up to 20.
// A trailing-only delay moved every refresh 150 ms later, onto the moment a
// user acts after their own command, when list actions are briefly disabled.
const REALTIME_COALESCE_MS = 150;
const SIDEBAR_STORAGE_KEY = "cvg.sidebar.collapsed";
const SECTORS_STORAGE_KEY = "cvg.sidebar.sectors";
const roleLabels: Record<string, string> = {
  SUPERADMIN: "Superadmin",
  ADMIN: "Administração técnica",
  MANAGER: "Gestão operacional",
  VETERINARIAN: "Veterinária",
  VET: "Veterinário",
  INPATIENT_TEAM: "Equipe de internação",
  LAB_TECH: "Técnica de laboratório",
  RADIOLOGY_TEAM: "Equipe de radiologia",
  ULTRASOUND_TEAM: "Equipe de ultrassom",
  VIEWER: "Visualização operacional"
};

function roleLabel(role: string): string {
  return roleLabels[role] ?? "Perfil operacional";
}

function readStorage(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}

function writeStorage(key: string, value: string): void {
  try { window.localStorage.setItem(key, value); } catch { /* per-viewer convenience only */ }
}

function ShellLoadingState() {
  return <LoadingState className="screen-center" label="Carregando o espaço operacional." />;
}

/** Sectors whose exams the user follows, in the order the sidebar lists them. */
function sidebarSectors(user: SessionResponse["user"], departments: Department[], services: DiagnosticService[]): string[] {
  if (user.role === "ADMIN") return [];
  return departmentOptions(departments.filter((department) => department.type === "DIAGNOSTIC"), services.map((service) => service.departmentCode)).map((department) => department.code);
}

/** Breadcrumbs for pages that do not draw their own Plane header. */
function legacyCrumbs(pathname: string, view: string | null, hash: string): Crumb[] {
  if (pathname.startsWith("/patients/")) return [{ label: "Pacientes", href: "/patients", icon: "paw" }, { label: "Diagnósticos do paciente" }];
  if (pathname.startsWith("/patients")) return [{ label: "Pacientes", icon: "paw" }];
  if (pathname.startsWith("/notifications")) return [{ label: "Caixa de entrada", icon: "inbox" }];
  if (pathname.startsWith("/account")) return [{ label: "Minha conta", icon: "account" }];
  if (pathname === "/admin/integrations") return [{ label: "Administração", href: "/admin", icon: "settings" }, { label: "Integrações" }];
  if (pathname === "/admin/institution") return [{ label: "Administração", href: "/admin", icon: "settings" }, { label: "Instituição" }];
  if (pathname === "/admin/invitations") return [{ label: "Administração", href: "/admin", icon: "settings" }, { label: "Convites" }];
  if (pathname === "/admin/departments") return [{ label: "Administração", href: "/admin", icon: "settings" }, { label: "Setores" }];
  if (pathname === "/admin/access-groups") return [{ label: "Administração", href: "/admin", icon: "settings" }, { label: "Grupos de acesso" }];
  if (pathname === "/admin/resources") return [{ label: "Administração", href: "/admin", icon: "settings" }, { label: "Recursos e leitos" }];
  if (pathname === "/admin/hospital-services") return [{ label: "Administração", href: "/admin", icon: "settings" }, { label: "Serviços hospitalares" }];
  if (pathname.startsWith("/admin")) return pathname === "/admin/users" || hash === "#users" ? [{ label: "Administração", href: "/admin", icon: "settings" }, { label: "Acessos" }] : pathname === "/admin/catalog" || hash === "#catalog" ? [{ label: "Administração", href: "/admin", icon: "settings" }, { label: "Catálogos" }] : [{ label: "Administração", icon: "settings" }];
  if (pathname.startsWith("/system")) return [{ label: "Sistema", icon: "settings" }];
  if (pathname.startsWith("/indicators")) return [{ label: "Indicadores", icon: "analytics" }];
  if (pathname.startsWith("/results/")) return [{ label: "Exames", href: "/queues", icon: "layers" }, { label: "Resultado" }];
  if (pathname.startsWith("/archive/")) return [{ label: "Pacientes", href: "/patients", icon: "paw" }, { label: "Arquivo clínico" }];
  if (pathname.startsWith("/requests/")) return [{ label: "Exames", href: "/queues", icon: "layers" }, { label: "Solicitação" }];
  if (pathname.startsWith("/planner")) return [{ label: "Planner hospitalar", href: "/planner", icon: "board" }, ...(pathname.startsWith("/planner/documents") ? [{ label: "Protocolos e documentos" }] : pathname === "/planner/inbox" ? [{ label: "Caixa de trabalho" }] : pathname === "/planner/following" ? [{ label: "Meu acompanhamento" }] : pathname === "/planner/metrics" ? [{ label: "Indicadores hospitalares" }] : pathname === "/planner/reports" ? [{ label: "Relatórios hospitalares" }] : pathname === "/planner/timeline" ? [{ label: "Cronograma hospitalar" }] : pathname.startsWith("/planner/tasks/") ? [{ label: "Atividade" }] : pathname === "/planner/intake" ? [{ label: "Triagem" }] : pathname === "/planner/search" ? [{ label: "Busca" }] : pathname === "/planner/types" ? [{ label: "Tipos de atividade" }] : pathname.startsWith("/planner/plans") ? [{ label: "Planos assistenciais" }] : pathname.startsWith("/planner/shifts") ? [{ label: "Plantões" }] : pathname === "/planner/handoffs" ? [{ label: "Passagem de plantão" }] : pathname === "/planner/agenda" ? [{ label: "Agenda de recursos" }] : pathname === "/planner/beds" ? [{ label: "Leitos e censo" }] : pathname === "/planner/checklists" ? [{ label: "Modelos de checklist" }] : pathname === "/planner/recurrences" ? [{ label: "Rotinas recorrentes" }] : pathname === "/planner/capacity" ? [{ label: "Capacidade" }] : [])];
  if (pathname.startsWith("/management") || pathname === "/") {
    const labels: Record<string, string> = { requests: "Solicitações", pending: "Pendências", stats: "Estatísticas" };
    return view && labels[view] ? [{ label: "Gestão", href: "/management", icon: "analytics" }, { label: labels[view] }] : [{ label: "Gestão", icon: "analytics" }];
  }
  return [{ label: "CVG", icon: "home" }];
}

export function AppShell({ children, flush = false }: Readonly<{ children: React.ReactNode; flush?: boolean }>) {
  return <Suspense fallback={<ShellLoadingState />}><AppShellContent flush={flush}>{children}</AppShellContent></Suspense>;
}

function AppShellContent({ children, flush }: Readonly<{ children: React.ReactNode; flush: boolean }>) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [user, setUser] = useState<SessionResponse["user"] | null>(null);
  const [sessionPath, setSessionPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionError, setSessionError] = useState("");
  const [live, setLive] = useState<LiveStatus>("connecting");
  const [reconnectToken, setReconnectToken] = useState(0);
  const [hash, setHash] = useState("");
  const [showPalette, setShowPalette] = useState(false);
  const [showPatient, setShowPatient] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [openSectors, setOpenSectors] = useState<string[] | null>(null);
  const [unread, setUnread] = useState(0);
  const [peekOpen, setPeekOpen] = useState(false);
  const requiresPasswordChange = user?.mustChangePassword === true;
  const departmentDirectory = useDepartments(requiresPasswordChange ? undefined : user?.id, { catalog: user?.role !== "ADMIN" });
  const sessionLoading = loading || sessionPath !== pathname;
  const canUsePalette = Boolean(user && user.role !== "ADMIN" && !requiresPasswordChange && !sessionLoading && !sessionError);
  const canCreatePatient = Boolean(user?.permissions?.includes("patient.create") && ["SUPERADMIN", "VETERINARIAN", "INPATIENT_TEAM"].includes(user.role));
  const canCreateRequest = Boolean(user?.permissions?.includes("request.create") && ["SUPERADMIN", "VETERINARIAN", "INPATIENT_TEAM", "MANAGER"].includes(user.role));
  const modalOpen = canUsePalette && (showPalette || showPatient);

  useEffect(() => {
    const onPeek = (event: Event) => setPeekOpen(Boolean((event as CustomEvent<boolean>).detail));
    window.addEventListener("cvg:peek", onPeek);
    return () => window.removeEventListener("cvg:peek", onPeek);
  }, []);

  useEffect(() => {
    const syncHash = () => setHash(window.location.hash);
    syncHash();
    window.addEventListener("hashchange", syncHash);
    return () => window.removeEventListener("hashchange", syncHash);
  }, [pathname]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setCollapsed(readStorage(SIDEBAR_STORAGE_KEY) === "1");
      try { const saved = JSON.parse(readStorage(SECTORS_STORAGE_KEY) ?? "null") as unknown; if (Array.isArray(saved)) setOpenSectors(saved.filter((value): value is string => typeof value === "string")); } catch { /* ignore */ }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    let controller: AbortController | undefined;
    let version = 0;
    const readIdentity = () => {
      const current = ++version;
      controller?.abort();
      const request = new AbortController();
      controller = request;
      void apiFetch<SessionResponse>("/session/me", { signal: request.signal })
        .then((result) => { if (!request.signal.aborted && current === version) { setUser(result.user); setSessionError(""); setSessionPath(pathname); setShowPalette(false); setShowPatient(false); setShowUserMenu(false); setMobileOpen(false); } })
        .catch((cause) => {
          if (request.signal.aborted || current !== version) return;
          setSessionPath(pathname);
          if (cause instanceof ApiClientError && [401, 403, 404].includes(cause.status)) { setUser(null); router.replace("/login"); }
          else setSessionError(getSafeErrorMessage(cause, "Não foi possível revalidar a identificação da equipe."));
        })
        .finally(() => { if (!request.signal.aborted && current === version) setLoading(false); });
    };
    const refresh = () => { setLoading(true); setSessionError(""); setShowPalette(false); setShowPatient(false); setShowUserMenu(false); setMobileOpen(false); readIdentity(); };
    readIdentity();
    window.addEventListener("cvg:realtime-resync", refresh);
    return () => { version += 1; controller?.abort(); window.removeEventListener("cvg:realtime-resync", refresh); };
  }, [pathname, router]);

  useEffect(() => {
    if (!loading && !sessionError && sessionPath === pathname && requiresPasswordChange && pathname !== "/account" && pathname !== "/login") router.replace("/account?password=required");
  }, [loading, pathname, requiresPasswordChange, router, sessionError, sessionPath]);

  useEffect(() => {
    if (!canUsePalette) return;
    const openPalette = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "k" || event.altKey || event.repeat || event.isComposing) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (document.querySelector("[data-dialog-layer='true']")) return;
      setShowPalette(true);
    };
    window.addEventListener("keydown", openPalette, true);
    return () => window.removeEventListener("keydown", openPalette, true);
  }, [canUsePalette]);

  useEffect(() => {
    if (!user || requiresPasswordChange || user.role === "ADMIN") return;
    let active = true;
    const refresh = () => {
      void apiFetch<Notification[]>("/notifications?filter=UNREAD").then((list) => { if (active) setUnread(Array.isArray(list) ? list.length : 0); }).catch(() => undefined);
    };
    refresh();
    window.addEventListener("cvg:realtime-updated", refresh);
    window.addEventListener("cvg:notifications-changed", refresh);
    return () => { active = false; window.removeEventListener("cvg:realtime-updated", refresh); window.removeEventListener("cvg:notifications-changed", refresh); };
  }, [requiresPasswordChange, user]);

  useEffect(() => {
    if (!user?.id || requiresPasswordChange) return;
    let source: EventSource | undefined;
    let fallbackTimer: ReturnType<typeof setInterval> | undefined;
    let updateTimer: ReturnType<typeof setTimeout> | undefined;
    let updatePending = false;
    let stopped = false;
    const closeUpdateWindow = () => {
      if (!updatePending) { updateTimer = undefined; return; }
      updatePending = false;
      window.dispatchEvent(new Event("cvg:realtime-updated"));
      updateTimer = setTimeout(closeUpdateWindow, REALTIME_COALESCE_MS);
    };
    const dispatchUpdate = () => {
      if (updateTimer !== undefined) { updatePending = true; return; }
      window.dispatchEvent(new Event("cvg:realtime-updated"));
      updateTimer = setTimeout(closeUpdateWindow, REALTIME_COALESCE_MS);
    };
    const stopFallback = () => {
      if (fallbackTimer === undefined) return;
      clearInterval(fallbackTimer);
      fallbackTimer = undefined;
    };
    const startFallback = () => {
      if (fallbackTimer !== undefined) return;
      window.dispatchEvent(new Event("cvg:realtime-resync"));
      window.dispatchEvent(new Event("cvg:realtime-updated"));
      fallbackTimer = setInterval(() => window.dispatchEvent(new Event("cvg:realtime-updated")), REALTIME_FALLBACK_INTERVAL_MS);
    };
    const connect = () => {
      if (stopped) return;
      const nextSource = new EventSource("/api/v1/realtime/events");
      source = nextSource;
      // Keep the same EventSource alive through transient failures. The native
      // EventSource reconnection algorithm then resends Last-Event-ID, avoiding
      // a cursor reset when the transport recovers. A manual reconciliation
      // still replaces the source deliberately and refetches durable state.
      nextSource.onopen = () => { stopFallback(); setLive("connected"); };
      nextSource.onmessage = dispatchUpdate;
      nextSource.addEventListener("diagnostic.updated", dispatchUpdate);
      nextSource.addEventListener("resync_required", () => window.dispatchEvent(new Event("cvg:realtime-resync")));
      nextSource.onerror = () => {
        if (stopped || source !== nextSource) return;
        setLive("degraded");
        // Do not call close here: closing aborts the browser's reconnect
        // algorithm and loses its automatic Last-Event-ID header.
        startFallback();
      };
    };
    connect();
    return () => { stopped = true; source?.close(); stopFallback(); clearTimeout(updateTimer); };
  }, [reconnectToken, requiresPasswordChange, user?.id]);

  function reconcile() {
    setLive("connecting");
    window.dispatchEvent(new Event("cvg:realtime-resync"));
    setReconnectToken((current) => current + 1);
  }

  async function logout() {
    try { await apiFetch("/session/logout", { method: "POST", body: "{}" }); } finally { router.replace("/login"); }
  }

  function newRequest() {
    setShowPalette(false);
    if (pathname.startsWith("/queues")) window.dispatchEvent(new CustomEvent("cvg:create-request"));
    else router.push("/queues?create=request");
  }

  function toggleCollapsed() {
    setCollapsed((current) => { writeStorage(SIDEBAR_STORAGE_KEY, current ? "0" : "1"); return !current; });
  }

  if (sessionLoading) return <ShellLoadingState />;
  if (sessionError) return <ErrorState page title="Identidade indisponível" message={sessionError} onRetry={() => { window.dispatchEvent(new Event("cvg:realtime-resync")); }} />;
  if (!user) return null;
  const isTechnicalAdmin = user.role === "ADMIN";
  const isSuperadmin = user.role === "SUPERADMIN";
  const isManager = user.role === "MANAGER";
  const canAccessManagement = isManager || isSuperadmin;
  const canAccessClinicalOperations = !isTechnicalAdmin;
  const canAccessUsers = user.permissions?.some((permission) => ["user_role.manage", "user.view", "user.create", "user.update", "user.deactivate"].includes(permission));
  const canAccessCatalog = user.permissions?.some((permission) => ["service.catalog.manage", "service.catalog.view", "service.catalog.create", "service.catalog.update", "service.catalog.deactivate"].includes(permission));
  const canAccessAudit = user.permissions?.includes("audit.view") ?? false;
  const canAccessAdmin = (isTechnicalAdmin || isSuperadmin || isManager) && Boolean(canAccessUsers || canAccessCatalog || user.permissions?.some((permission) => ["reason_code.manage", "patient.data_export"].includes(permission)));
  const canAccessSystem = canAccessAudit || ((isTechnicalAdmin || isSuperadmin) && Boolean(user.permissions?.some((permission) => ["user_role.manage", "user.view", "outbox.manage", "critical_result_policy.manage"].includes(permission))));
  const managementView = searchParams.get("view");
  const dept = searchParams.get("dept");
  const preset = searchParams.get("preset");
  const onQueues = pathname.startsWith("/queues");
  const sectors = sidebarSectors(user, departmentDirectory.departments, departmentDirectory.services);
  const sectorNames = new Map(departmentOptions(departmentDirectory.departments, sectors).map((department) => [department.code, department.name]));
  const expandedSectors = openSectors ?? (dept ? [dept] : sectors.slice(0, 1));
  const toggleSector = (code: string) => {
    const next = expandedSectors.includes(code) ? expandedSectors.filter((value) => value !== code) : [...expandedSectors, code];
    setOpenSectors(next);
    writeStorage(SECTORS_STORAGE_KEY, JSON.stringify(next));
  };

  const content = requiresPasswordChange && pathname !== "/account" && pathname !== "/login" ? <ShellLoadingState /> : flush ? children : <>
    <PageHeader crumbs={legacyCrumbs(pathname, managementView, hash).map((crumb) => crumb.href === "/admin" && !canAccessAdmin ? { ...crumb, href: undefined } : crumb)} heading={false} />
    <div className="page-body">{children}</div>
  </>;

  return (
    <div className={`app-frame${collapsed ? " sidebar-collapsed" : ""}${mobileOpen ? " sidebar-mobile-open" : ""}`}>
      <header className="app-topbar" inert={modalOpen}>
        <div className="topbar-left">
          <button type="button" className="icon-button mobile-only" onClick={() => setMobileOpen((open) => !open)} aria-label={mobileOpen ? "Fechar menu" : "Abrir menu"} aria-expanded={mobileOpen}><Icon name="sidebar" size={17} /></button>
          <Link href={requiresPasswordChange ? "/account?password=required" : "/"} className="workspace-switcher" aria-label="CVG Diagnósticos, início">
            <span className="workspace-logo" aria-hidden="true">C</span>
            <span className="workspace-name">CVG Diagnósticos</span>
          </Link>
        </div>
        {canUsePalette ? <button type="button" className="topbar-search" onClick={() => setShowPalette(true)} aria-label="Buscar paciente ou exame (Ctrl+K ou ⌘K)" aria-keyshortcuts="Control+k Meta+k">
          <Icon name="search" size={14} /><span>Buscar pacientes, exames ou comandos…</span><kbd>Ctrl K</kbd>
        </button> : <span />}
        <div className="topbar-right">
          <span className={`live-dot live-${live}`} title={live === "connected" ? "Conexão em tempo real" : live === "degraded" ? "Conexão interrompida" : "Conectando"} role="img" aria-label={live === "connected" ? "Conexão em tempo real ativa" : live === "degraded" ? "Conexão em tempo real interrompida" : "Conectando ao tempo real"} />
          {canAccessClinicalOperations && !requiresPasswordChange && <Link href="/notifications" className="icon-button topbar-inbox" aria-label="Abrir notificações"><Icon name="inbox" size={17} />{unread > 0 && <span className="topbar-badge" aria-hidden="true">{unread > 9 ? "9+" : unread}</span>}</Link>}
          <UserMenu open={showUserMenu} onToggle={() => setShowUserMenu((open) => !open)} onClose={() => setShowUserMenu(false)} displayName={user.displayName} email={user.email} role={roleLabel(user.role)} onLogout={() => void logout()} />
        </div>
      </header>
      <aside className="sidebar" inert={modalOpen} aria-label="Barra lateral">
        <div className="sidebar-head">
          <span className="sidebar-title">{isSuperadmin ? "Superadmin" : isTechnicalAdmin ? "Administração" : isManager ? "Operação" : "Diagnósticos"}</span>
          <button type="button" className="icon-button desktop-only" onClick={toggleCollapsed} aria-label={collapsed ? "Expandir barra lateral" : "Recolher barra lateral"} title={collapsed ? "Expandir barra lateral" : "Recolher barra lateral"}><Icon name="sidebar" size={16} /></button>
        </div>
        {canCreateRequest && !requiresPasswordChange && <button type="button" className="sidebar-new" onClick={newRequest}><Icon name="add" size={15} /><span>Nova solicitação</span></button>}
        <nav aria-label="Navegação principal" className="main-nav" onClick={(event) => { if (event.target instanceof Element && event.target.closest("a")) setMobileOpen(false); }}>
          {requiresPasswordChange && <div className="nav-group"><NavLink href="/account?password=required" active={pathname.startsWith("/account")} icon="account">Minha conta</NavLink></div>}
          {!requiresPasswordChange && <>
            <div className="nav-group">
              <NavLink href="/" active={pathname === "/"} icon="home">Início</NavLink>
              {canAccessClinicalOperations && <NavLink href="/queues?view=mine" active={onQueues && managementView === "mine"} icon="user-check">Meu trabalho</NavLink>}
              {canAccessClinicalOperations && <NavLink href="/notifications" active={pathname.startsWith("/notifications")} icon="inbox" badge={unread}>Caixa de entrada</NavLink>}
              {canAccessClinicalOperations && !isManager && <NavLink href="/patients" active={pathname.startsWith("/patients")} icon="paw">Pacientes</NavLink>}
            </div>
            {canAccessClinicalOperations && <div className="nav-group">
              <span className="nav-group-label">Workspace</span>
              <NavLink href="/queues" active={onQueues && !dept && !managementView} icon="layers">Todos os exames</NavLink>
              {user.permissions?.includes("hospital_task.view") && <NavLink href="/planner" active={pathname === "/planner" || pathname.startsWith("/planner/tasks/")} icon="board">Planner hospitalar</NavLink>}
              {!canAccessManagement && user.permissions?.includes("service.catalog.view") && <NavLink href="/admin/catalog" active={pathname === "/admin/catalog"} icon="catalog">Catálogo clínico</NavLink>}
              {canAccessManagement && <NavLink href="/indicators" active={pathname.startsWith("/indicators")} icon="analytics">Indicadores</NavLink>}
            </div>}
            {canAccessManagement && <div className="nav-group">
              <span className="nav-group-label">Gestão</span>
              <NavLink href="/management" active={pathname === "/management" && !managementView} icon="overview">Painel gerencial</NavLink>
              <NavLink href="/management?view=requests" active={pathname === "/management" && managementView === "requests"} icon="requests">Solicitações</NavLink>
              <NavLink href="/management?view=pending" active={pathname === "/management" && managementView === "pending"} icon="attention">Pendências</NavLink>
              <NavLink href="/management?view=stats" active={pathname === "/management" && managementView === "stats"} icon="analytics">Estatísticas</NavLink>
              {!isSuperadmin && canAccessUsers && <NavLink href="/admin/users" active={pathname === "/admin/users" || (pathname === "/admin" && hash === "#users")} icon="users">Acessos</NavLink>}
              {!isSuperadmin && canAccessCatalog && <NavLink href="/admin/catalog" active={pathname === "/admin/catalog" || (pathname === "/admin" && hash === "#catalog")} icon="catalog">Catálogos</NavLink>}
              {!isSuperadmin && user.permissions?.includes("service.catalog.view") && <NavLink href="/admin/hospital-services" active={pathname === "/admin/hospital-services"} icon="catalog">Serviços hospitalares</NavLink>}
              {!isSuperadmin && user.permissions?.includes("department.view") && <NavLink href="/admin/departments" active={pathname === "/admin/departments"} icon="building">Setores</NavLink>}
              {!isSuperadmin && user.permissions?.includes("access_group.view") && <NavLink href="/admin/access-groups" active={pathname === "/admin/access-groups"} icon="users">Grupos de acesso</NavLink>}
            </div>}
            {!isTechnicalAdmin && !isSuperadmin && canAccessAudit && <div className="nav-group"><NavLink href="/system#audit" active={pathname.startsWith("/system")} icon="activity">Auditoria</NavLink></div>}
            {(isTechnicalAdmin || isSuperadmin) && <div className="nav-group">
              <span className="nav-group-label">Workspace</span>
              {canAccessAdmin && <NavLink href="/admin" active={pathname === "/admin" && !hash} icon="settings">Administração</NavLink>}
              {canAccessUsers && <NavLink href="/admin/users" active={pathname === "/admin/users" || (pathname === "/admin" && hash === "#users")} icon="users">Acessos</NavLink>}
              {canAccessCatalog && <NavLink href="/admin/catalog" active={pathname === "/admin/catalog" || (pathname === "/admin" && hash === "#catalog")} icon="catalog">Catálogos</NavLink>}
              {user.permissions?.includes("service.catalog.view") && <NavLink href="/admin/hospital-services" active={pathname === "/admin/hospital-services"} icon="catalog">Serviços hospitalares</NavLink>}
              {user.permissions?.includes("department.view") && <NavLink href="/admin/departments" active={pathname === "/admin/departments"} icon="building">Setores</NavLink>}
              {user.permissions?.includes("access_group.view") && <NavLink href="/admin/access-groups" active={pathname === "/admin/access-groups"} icon="users">Grupos de acesso</NavLink>}
              {canAccessSystem && <NavLink href="/system" active={pathname.startsWith("/system")} icon="activity">Sistema</NavLink>}
            </div>}
            {user.permissions?.some((permission) => ["plan.view", "shift.view", "handoff.offer", "handoff.accept", "hospital_resource.view", "hospital_calendar.view", "hospital_capacity.view", "admission.view", "checklist_template.view", "recurrence.view", "hospital_document.view", "work_notification.view", "work_activity.preference.manage", "hospital_metric.view", "hospital_report.view", "institution.manage", "user_invite.manage", "hospital_task.view", "integration.manage", "integration.exchange"].includes(permission)) && <div className="nav-group">
              <span className="nav-group-label">Hospital</span>
              {user.permissions?.some((permission) => ["integration.manage", "integration.exchange"].includes(permission)) && <NavLink href="/admin/integrations" active={pathname === "/admin/integrations"} icon="settings">Integrações hospitalares</NavLink>}
              {user.permissions?.includes("work_notification.view") && <NavLink href="/planner/inbox" active={pathname === "/planner/inbox"} icon="inbox">Caixa de trabalho</NavLink>}
              {user.permissions?.includes("work_activity.preference.manage") && <NavLink href="/planner/following" active={pathname === "/planner/following"} icon="user-check">Meu acompanhamento</NavLink>}
              {user.permissions?.includes("hospital_document.view") && <NavLink href="/planner/documents" active={pathname.startsWith("/planner/documents")} icon="catalog">Protocolos e documentos</NavLink>}
              {user.permissions?.includes("hospital_task.view") && <NavLink href="/planner/timeline" active={pathname === "/planner/timeline"} icon="calendar">Cronograma hospitalar</NavLink>}
              {user.permissions?.includes("hospital_metric.view") && <NavLink href="/planner/metrics" active={pathname === "/planner/metrics"} icon="analytics">Indicadores hospitalares</NavLink>}
              {user.permissions?.includes("hospital_report.view") && <NavLink href="/planner/reports" active={pathname === "/planner/reports"} icon="analytics">Relatórios hospitalares</NavLink>}
              {user.permissions?.includes("institution.manage") && <NavLink href="/admin/institution" active={pathname === "/admin/institution"} icon="settings">Instituição</NavLink>}
              {user.permissions?.includes("user_invite.manage") && <NavLink href="/admin/invitations" active={pathname === "/admin/invitations"} icon="users">Convites operacionais</NavLink>}
              {user.permissions?.includes("plan.view") && <NavLink href="/planner/plans" active={pathname.startsWith("/planner/plans")} icon="layers">Planos assistenciais</NavLink>}
              {user.permissions?.includes("shift.view") && <NavLink href="/planner/shifts" active={pathname.startsWith("/planner/shifts")} icon="users">Plantões e cobertura</NavLink>}
              {user.permissions?.includes("shift.view") && <NavLink href="/planner/handoffs" active={pathname === "/planner/handoffs"} icon="user-check">Passagem de plantão</NavLink>}
              {user.permissions?.includes("hospital_calendar.view") && <NavLink href="/planner/agenda" active={pathname === "/planner/agenda"} icon="calendar">Agenda de recursos</NavLink>}
              {user.permissions?.includes("admission.view") && <NavLink href="/planner/beds" active={pathname === "/planner/beds"} icon="building">Leitos e censo</NavLink>}
              {user.permissions?.includes("hospital_capacity.view") && <NavLink href="/planner/capacity" active={pathname === "/planner/capacity"} icon="analytics">Capacidade</NavLink>}
              {user.permissions?.includes("hospital_resource.view") && <NavLink href="/admin/resources" active={pathname === "/admin/resources"} icon="settings">Recursos e leitos</NavLink>}
              {user.permissions?.includes("checklist_template.view") && <NavLink href="/planner/checklists" active={pathname === "/planner/checklists"} icon="requests">Modelos de checklist</NavLink>}
              {user.permissions?.includes("recurrence.view") && <NavLink href="/planner/recurrences" active={pathname === "/planner/recurrences"} icon="calendar">Rotinas recorrentes</NavLink>}
            </div>}
            {sectors.length > 0 && <div className="nav-group">
              <span className="nav-group-label">Setores</span>
              {sectors.map((code) => {
                const open = expandedSectors.includes(code);
                const base = `/queues?dept=${encodeURIComponent(code)}`;
                return <div key={code} className="nav-sector">
                  <button type="button" className={`nav-sector-toggle${onQueues && dept === code ? " active" : ""}`} aria-expanded={open} onClick={() => toggleSector(code)}>
                    <DepartmentIcon code={code} size={14} /><span className="nav-label">{sectorNames.get(code) ?? code}</span><Icon name="chevron-down" size={13} className="nav-sector-chevron" />
                  </button>
                  {open && <div className="nav-sector-items">
                    <NavLink href={base} active={onQueues && dept === code && !preset} icon="layers" nested>Exames</NavLink>
                    <NavLink href={`${base}&preset=overdue`} active={onQueues && dept === code && preset === "overdue"} icon="clock" nested>Em atraso</NavLink>
                    <NavLink href={`${base}&preset=results`} active={onQueues && dept === code && preset === "results"} icon="check" nested>Resultados</NavLink>
                    <NavLink href={`${base}&preset=done`} active={onQueues && dept === code && preset === "done"} icon="catalog" nested>Concluídos</NavLink>
                  </div>}
                </div>;
              })}
            </div>}
          </>}
        </nav>
        <div className="sidebar-footer">
          <Link href="/account" className={`sidebar-account${pathname.startsWith("/account") ? " active" : ""}`} aria-label="Minha conta" aria-current={pathname.startsWith("/account") ? "page" : undefined}>
            <Avatar name={user.displayName} size="sm" /><span className="user-copy"><strong>{user.displayName}</strong><small>{roleLabel(user.role)}</small></span>
          </Link>
        </div>
      </aside>
      {mobileOpen && <button type="button" className="sidebar-scrim" aria-label="Fechar menu" onClick={() => setMobileOpen(false)} />}
      <main className="main-content" inert={modalOpen}>
        <div className="main-panel">
          {!requiresPasswordChange && live === "degraded" && <RealtimeStatusBanner status={live} onReconcile={reconcile} />}
          <WorkflowPermissionsProvider permissions={user.permissions}><DepartmentLabelsProvider names={Object.fromEntries(sectorNames)}>{content}</DepartmentLabelsProvider></WorkflowPermissionsProvider>
        </div>
      </main>
      {requiresPasswordChange ? <nav className={`mobile-nav ${styles.accountNav}`} aria-label="Navegação rápida"><MobileNavLink href="/account?password=required" active={pathname === "/account"} icon="account" label="Conta" /></nav> : <MobileNav inert={modalOpen || peekOpen} isTechnicalAdmin={isTechnicalAdmin} isSuperadmin={isSuperadmin} isManager={isManager} canAccessAudit={canAccessAudit} canAccessAdmin={canAccessAdmin} canAccessUsers={Boolean(canAccessUsers)} canAccessCatalog={Boolean(canAccessCatalog)} canAccessSystem={canAccessSystem} pathname={pathname} hash={hash} view={managementView} unread={unread} />}
      {canUsePalette && showPalette && <div inert={showPatient} aria-hidden={showPatient || undefined}><CommandPalette canCreatePatient={canCreatePatient} canCreateRequest={canCreateRequest} onClose={() => setShowPalette(false)} onNewPatient={() => setShowPatient(true)} onNewRequest={newRequest} onNavigate={(href) => { setShowPalette(false); router.push(href); }} /></div>}
      {canUsePalette && showPatient && canCreatePatient && <PatientDialog nested onClose={() => setShowPatient(false)} onCreated={() => { setShowPatient(false); setShowPalette(false); window.dispatchEvent(new Event("cvg:realtime-updated")); router.refresh(); }} />}
    </div>
  );
}

function UserMenu({ open, onToggle, onClose, displayName, email, role, onLogout }: { open: boolean; onToggle: () => void; onClose: () => void; displayName: string; email: string; role: string; onLogout: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    if (!ref.current?.contains(document.activeElement) || document.activeElement === ref.current?.querySelector("button")) ref.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); ref.current?.querySelector<HTMLButtonElement>("button")?.focus(); }
      } else if (!ref.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", close); };
  }, [onClose, open]);
  return <div className="user-menu" ref={ref}>
    <button type="button" className="user-menu-trigger" onClick={onToggle} onKeyDown={(event) => { if (!open && ["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); onToggle(); } }} aria-expanded={open} aria-haspopup="menu" aria-label={`Menu de ${displayName}`}><Avatar name={displayName} size="sm" /></button>
    {open && <div className="dropdown user-menu-panel" role="menu" aria-label="Menu da conta" onKeyDown={(event) => {
      const entries = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[role=menuitem]"));
      if (event.key === "Tab") { onClose(); ref.current?.querySelector<HTMLButtonElement>("button")?.focus(); return; }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const index = entries.indexOf(document.activeElement as HTMLElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? entries.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + entries.length) % entries.length;
      entries[next]?.focus();
    }}>
      <div className="user-menu-identity"><Avatar name={displayName} size="md" /><span><strong>{displayName}</strong><small>{role}</small><small>{email}</small></span></div>
      <Link role="menuitem" href="/account" className="dropdown-item" onClick={onClose}><Icon name="account" size={15} />Minha conta</Link>
      <button role="menuitem" type="button" className="dropdown-item session-logout" onClick={onLogout} aria-label="Sair"><Icon name="logout" size={15} />Sair</button>
    </div>}
  </div>;
}

function NavLink({ href, active, icon, children, badge, nested = false }: { href: string; active: boolean; icon: IconName; children: React.ReactNode; badge?: number; nested?: boolean }) {
  const label = typeof children === "string" ? children : undefined;
  return <Link href={href} className={`nav-link${active ? " active" : ""}${nested ? " nav-link-nested" : ""}`} aria-label={label} title={label} aria-current={active ? "page" : undefined}><span className="nav-icon" aria-hidden="true"><Icon name={icon} size={nested ? 14 : 16} /></span><span className="nav-label">{children}</span>{badge ? <span className="nav-badge" aria-hidden="true">{badge > 99 ? "99+" : badge}</span> : null}</Link>;
}

function MobileNav({ inert, isTechnicalAdmin, isSuperadmin, isManager, canAccessAudit, canAccessAdmin, canAccessUsers, canAccessCatalog, canAccessSystem, pathname, hash, view, unread }: { inert: boolean; isTechnicalAdmin: boolean; isSuperadmin: boolean; isManager: boolean; canAccessAudit: boolean; canAccessAdmin: boolean; canAccessUsers: boolean; canAccessCatalog: boolean; canAccessSystem: boolean; pathname: string; hash: string; view: string | null; unread: number }) {
  if (isSuperadmin) {
    const destinations = [
      ...(canAccessSystem ? [{ href: "/system", icon: "activity" as const, label: "Sistema" }] : []),
      ...(canAccessUsers ? [{ href: "/admin/users", icon: "users" as const, label: "Acessos" }] : []),
      ...(canAccessCatalog ? [{ href: "/admin/catalog", icon: "catalog" as const, label: "Catálogo" }] : []),
      ...(canAccessAdmin ? [{ href: "/admin", icon: "settings" as const, label: "Admin" }] : [])
    ];
    const adminFocus = destinations.find((destination) => pathname === destination.href)
      ?? destinations.find((destination) => destination.href === "/admin") ?? destinations[0];
    return <nav className={`mobile-nav ${styles.adminNav}`} aria-label="Navegação rápida" inert={inert}>
      <MobileNavLink href="/" active={pathname === "/"} icon="home" label="Início" />
      <MobileNavLink href="/queues" active={pathname.startsWith("/queues")} icon="layers" label="Exames" />
      <MobileNavLink href="/patients" active={pathname.startsWith("/patients")} icon="paw" label="Pacientes" />
      <MobileNavLink href="/management" active={pathname === "/management" || pathname === "/indicators"} icon="analytics" label="Gestão" />
      {adminFocus && <MobileNavLink href={adminFocus.href} active={pathname === adminFocus.href} icon={adminFocus.icon} label={adminFocus.label} />}
      <MobileNavLink href="/account" active={pathname.startsWith("/account")} icon="account" label="Conta" />
    </nav>;
  }
  if (isTechnicalAdmin) {
    return <nav className={`mobile-nav ${styles.adminNav}`} aria-label="Navegação rápida" inert={inert}>
      <MobileNavLink href="/" active={pathname === "/"} icon="home" label="Início" />
      {canAccessAdmin && <MobileNavLink href="/admin" active={pathname === "/admin" && !hash} icon="settings" label="Admin" />}
      {canAccessUsers && <MobileNavLink href="/admin/users" active={pathname === "/admin/users" || (pathname === "/admin" && hash === "#users")} icon="users" label="Acessos" />}
      {canAccessCatalog && <MobileNavLink href="/admin/catalog" active={pathname === "/admin/catalog" || (pathname === "/admin" && hash === "#catalog")} icon="catalog" label="Catálogo" />}
      {canAccessSystem && <MobileNavLink href="/system" active={pathname.startsWith("/system")} icon="activity" label="Sistema" />}
      <MobileNavLink href="/account" active={pathname.startsWith("/account")} icon="account" label="Conta" />
    </nav>;
  }
  if (isManager) {
    // Managers keep one management destination, the one they are on or "Atenção".
    const onManagement = pathname === "/management";
    const focus = canAccessAudit && pathname.startsWith("/system") ? { href: "/system#audit", icon: "activity" as const, label: "Auditoria" } : view === "requests" ? { href: "/management?view=requests", icon: "requests" as const, label: "Solicitações" }
      : view === "stats" ? { href: "/management?view=stats", icon: "analytics" as const, label: "Estatísticas" }
        : { href: "/management?view=pending", icon: "attention" as const, label: "Atenção" };
    return <nav className="mobile-nav" aria-label="Navegação rápida" inert={inert}>
      <MobileNavLink href="/" active={pathname === "/"} icon="home" label="Início" />
      <MobileNavLink href="/queues" active={pathname.startsWith("/queues")} icon="layers" label="Exames" />
      <MobileNavLink href={focus.href} active={(onManagement && Boolean(view)) || (canAccessAudit && pathname.startsWith("/system"))} icon={focus.icon} label={focus.label} />
      <MobileNavLink href="/notifications" active={pathname.startsWith("/notifications")} icon="inbox" label="Entrada" badge={unread} />
      <MobileNavLink href="/account" active={pathname.startsWith("/account")} icon="account" label="Conta" />
    </nav>;
  }
  return <nav className="mobile-nav" aria-label="Navegação rápida" inert={inert}>
    <MobileNavLink href="/" active={pathname === "/"} icon="home" label="Início" />
    <MobileNavLink href="/queues" active={pathname.startsWith("/queues")} icon="layers" label="Exames" />
    <MobileNavLink href="/patients" active={pathname.startsWith("/patients")} icon="paw" label="Pacientes" />
    <MobileNavLink href="/notifications" active={pathname.startsWith("/notifications")} icon="inbox" label="Entrada" badge={unread} />
    <MobileNavLink href="/account" active={pathname.startsWith("/account")} icon="account" label="Conta" />
  </nav>;
}

function MobileNavLink({ href, active, icon, label, badge }: { href: string; active: boolean; icon: IconName; label: string; badge?: number }) {
  return <Link href={href} className={`mobile-nav-link ${active ? "active" : ""}`} aria-label={`Acesso rápido: ${label}`} aria-current={active ? "page" : undefined}><i className="mobile-nav-icon" aria-hidden="true"><Icon name={icon} size={19} />{badge ? <b className="topbar-badge">{badge > 9 ? "9+" : badge}</b> : null}</i><span>{label}</span></Link>;
}

function RealtimeStatusBanner({ status, onReconcile }: { status: Exclude<LiveStatus, "connected">; onReconcile: () => void }) {
  const degraded = status === "degraded";
  return (
    <div className={`realtime-banner realtime-${status}`} role="status" aria-live="polite" aria-atomic="true">
      <div className="realtime-banner-copy">
        <strong>{degraded ? "Conexão em tempo real indisponível" : "Conectando à conexão em tempo real"}</strong>
        <span>{degraded ? "Uma reconciliação limitada ocorre periodicamente; os dados podem permanecer desatualizados." : "As informações podem estar desatualizadas enquanto a conexão é estabelecida."}</span>
      </div>
      <button type="button" className="button button-ghost" onClick={onReconcile}>Atualizar agora</button>
    </div>
  );
}
