"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import type { SessionResponse } from "@cvg/contracts";
import { apiFetch } from "./api-client";
import { LoadingState } from "./feedback-states";
import { Icon, type IconName } from "./ui-icons";
import { CommandPalette } from "./command-palette";
import { PatientDialog } from "./patient-dialog";
import styles from "./app-shell.module.css";

type LiveStatus = "connecting" | "connected" | "degraded";
const REALTIME_FALLBACK_INTERVAL_MS = 30_000;
const roleLabels: Record<string, string> = {
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

function ShellLoadingState() {
  return <LoadingState className="screen-center" label="Carregando o espaço operacional." />;
}

export function AppShell({ children }: Readonly<{ children: React.ReactNode }>) {
  return <Suspense fallback={<ShellLoadingState />}><AppShellContent>{children}</AppShellContent></Suspense>;
}

function AppShellContent({ children }: Readonly<{ children: React.ReactNode }>) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [user, setUser] = useState<SessionResponse["user"] | null>(null);
  const [sessionPath, setSessionPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [live, setLive] = useState<LiveStatus>("connecting");
  const [reconnectToken, setReconnectToken] = useState(0);
  const [hash, setHash] = useState("");
  const [showPalette, setShowPalette] = useState(false);
  const [showPatient, setShowPatient] = useState(false);
  const requiresPasswordChange = user?.mustChangePassword === true;
  const sessionLoading = loading || sessionPath !== pathname;
  const canUsePalette = Boolean(user && user.role !== "ADMIN" && !requiresPasswordChange && !sessionLoading);
  const canCreatePatient = user?.role === "VETERINARIAN" || user?.role === "INPATIENT_TEAM";
  const canCreateRequest = canCreatePatient || user?.role === "MANAGER";
  const modalOpen = canUsePalette && (showPalette || showPatient);

  useEffect(() => {
    const syncHash = () => setHash(window.location.hash);
    syncHash();
    window.addEventListener("hashchange", syncHash);
    return () => window.removeEventListener("hashchange", syncHash);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    apiFetch<SessionResponse>("/session/me", { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) { setUser(result.user); setSessionPath(pathname); setShowPalette(false); setShowPatient(false); } })
      .catch(() => { if (!controller.signal.aborted) { setUser(null); setSessionPath(pathname); router.replace("/login"); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [pathname, router]);

  useEffect(() => {
    if (!loading && sessionPath === pathname && requiresPasswordChange && pathname !== "/account" && pathname !== "/login") router.replace("/account?password=required");
  }, [loading, pathname, requiresPasswordChange, router, sessionPath]);

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
    if (!user || requiresPasswordChange) return;
    let source: EventSource | undefined;
    let fallbackTimer: ReturnType<typeof setInterval> | undefined;
    let stopped = false;
    const stopFallback = () => {
      if (fallbackTimer === undefined) return;
      clearInterval(fallbackTimer);
      fallbackTimer = undefined;
    };
    const startFallback = () => {
      if (fallbackTimer !== undefined) return;
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
      const dispatchUpdate = () => window.dispatchEvent(new Event("cvg:realtime-updated"));
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
    return () => { stopped = true; source?.close(); stopFallback(); };
  }, [reconnectToken, requiresPasswordChange, user]);

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

  if (sessionLoading) return <ShellLoadingState />;
  if (!user) return null;
  const canAccessManagement = user.role === "ADMIN" || user.role === "MANAGER";
  const isTechnicalAdmin = user.role === "ADMIN";
  const isManager = user.role === "MANAGER";
  const canAccessClinicalOperations = !isTechnicalAdmin;
  const canAccessIndicators = user.role === "MANAGER";
  const managementView = searchParams.get("view");
  const isManagementRoute = pathname === "/management" || pathname === "/";
  const isOverview = isManager && isManagementRoute && !managementView;
  const isRequests = isManager && isManagementRoute && managementView === "requests";
  const isPending = isManager && isManagementRoute && managementView === "pending";
  const isStats = isManager && isManagementRoute && managementView === "stats";

  return (
    <div className="app-frame">
      <aside className="sidebar" inert={modalOpen}>
        <Link href={requiresPasswordChange ? "/account?password=required" : "/"} className="brand" aria-label="CVG Diagnostics Hub, início">
          <span className="brand-mark">CVG</span>
          <span><strong>Diagnostics</strong><small>HUB OPERACIONAL</small></span>
        </Link>
        <nav aria-label="Navegação principal" className="main-nav">
          {!requiresPasswordChange && <>
          <NavLink href={isManager ? "/management" : "/"} active={isManager ? isOverview : pathname === "/"} icon="overview">Visão geral</NavLink>
          {isManager ? <>
            <NavLink href="/queues" active={pathname.startsWith("/queues")} icon="queue">Central de exames</NavLink>
            <NavLink href="/management?view=requests" active={isRequests} icon="requests">Solicitações</NavLink>
            <NavLink href="/management?view=pending" active={isPending} icon="attention">Pendências</NavLink>
            <NavLink href="/management?view=stats" active={isStats} icon="analytics">Estatísticas</NavLink>
            <NavLink href="/admin#users" active={pathname.startsWith("/admin") && hash === "#users"} icon="users">Acessos</NavLink>
            <NavLink href="/admin#catalog" active={pathname.startsWith("/admin") && hash === "#catalog"} icon="catalog">Catálogos</NavLink>
          </> : <>
            {canAccessClinicalOperations && <NavLink href="/queues" active={pathname.startsWith("/queues")} icon="queue">Central de exames</NavLink>}
            {canAccessClinicalOperations && <NavLink href="/patients" active={pathname.startsWith("/patients")} icon="patients">Meus pacientes</NavLink>}
            {canAccessIndicators && <NavLink href="/indicators" active={pathname.startsWith("/indicators")} icon="analytics">Indicadores</NavLink>}
            {canAccessManagement && <NavLink href="/admin" active={pathname.startsWith("/admin")} icon="settings">Administração</NavLink>}
          </>}
          {canAccessClinicalOperations && <NavLink href="/notifications" active={pathname.startsWith("/notifications")} icon="notifications">Notificações</NavLink>}
          {isTechnicalAdmin && <NavLink href="/system" active={pathname.startsWith("/system")} icon="settings">Sistema</NavLink>}
          </>}
          <NavLink href="/account" active={pathname.startsWith("/account")} icon="account">Minha conta</NavLink>
        </nav>
        <div className="sidebar-footer">
          <div className={`live-indicator live-${live}`}><span />{live === "connected" ? "Conexão em tempo real" : live === "degraded" ? "Conexão interrompida" : "Conectando"}</div>
          <div className="user-card"><Link href="/account" className="user-profile-link" aria-label={`Abrir conta de ${user.displayName}`}><span className="avatar">{user.displayName.slice(0, 1)}</span><span className="user-copy"><strong>{user.displayName}</strong><small>{roleLabel(user.role)}</small></span></Link></div>
        </div>
      </aside>
      <main className="main-content" inert={modalOpen}>
        <header className="topbar"><div className="breadcrumb"><span className="breadcrumb-product">CVG</span><span>/</span> Operação</div><div className="topbar-actions">{canUsePalette && <button type="button" className="icon-button" onClick={() => setShowPalette(true)} aria-label="Buscar paciente ou exame (Ctrl+K ou ⌘K)" aria-keyshortcuts="Control+k Meta+k"><Icon name="search" size={19} /></button>}{canAccessClinicalOperations && !requiresPasswordChange && <Link href="/notifications" className="notification-trigger" aria-label="Abrir notificações"><Icon name="notifications" size={19} /></Link>}<button type="button" onClick={() => void logout()} className="icon-button session-logout" aria-label="Sair"><Icon name="logout" size={18} /></button><span className="topbar-date">{new Intl.DateTimeFormat("pt-BR", { weekday: "short", day: "2-digit", month: "short" }).format(new Date())}</span></div></header>
        {!requiresPasswordChange && live !== "connected" && <RealtimeStatusBanner status={live} onReconcile={reconcile} />}
        <div className="content-wrap">{requiresPasswordChange && pathname !== "/account" && pathname !== "/login" ? <ShellLoadingState /> : children}</div>
      </main>
      {requiresPasswordChange ? <nav className={`mobile-nav ${styles.accountNav}`} aria-label="Navegação rápida"><MobileNavLink href="/account?password=required" active={pathname === "/account"} icon="account" label="Conta" /></nav> : <MobileNav inert={modalOpen} isManager={isManager} isTechnicalAdmin={isTechnicalAdmin} canAccessClinicalOperations={canAccessClinicalOperations} pathname={pathname} managementView={managementView} hash={hash} />}
      {canUsePalette && showPalette && <div inert={showPatient} aria-hidden={showPatient || undefined}><CommandPalette canCreatePatient={canCreatePatient} canCreateRequest={canCreateRequest} onClose={() => setShowPalette(false)} onNewPatient={() => setShowPatient(true)} onNewRequest={newRequest} onNavigate={(href) => { setShowPalette(false); router.push(href); }} /></div>}
      {canUsePalette && showPatient && canCreatePatient && <PatientDialog nested onClose={() => setShowPatient(false)} onCreated={() => { setShowPatient(false); setShowPalette(false); window.dispatchEvent(new Event("cvg:realtime-updated")); router.refresh(); }} />}
    </div>
  );
}

function NavLink({ href, active, icon, children }: { href: string; active: boolean; icon: IconName; children: React.ReactNode }) {
  const label = typeof children === "string" ? children : undefined;
  return <Link href={href} className={`nav-link ${active ? "active" : ""}`} aria-label={label} title={label} aria-current={active ? "page" : undefined}><span className="nav-icon" aria-hidden="true"><Icon name={icon} size={19} /></span><span className="nav-label">{children}</span></Link>;
}

function MobileNav({ inert, isManager, isTechnicalAdmin, canAccessClinicalOperations, pathname, managementView, hash }: { inert: boolean; isManager: boolean; isTechnicalAdmin: boolean; canAccessClinicalOperations: boolean; pathname: string; managementView: string | null; hash: string }) {
  if (isTechnicalAdmin) {
    return <nav className={`mobile-nav ${styles.adminNav}`} aria-label="Navegação rápida" inert={inert}>
      <MobileNavLink href="/" active={pathname === "/"} icon="overview" label="Início" />
      <MobileNavLink href="/admin" active={pathname === "/admin" && !hash} icon="settings" label="Admin" />
      <MobileNavLink href="/admin#users" active={pathname === "/admin" && hash === "#users"} icon="users" label="Acessos" />
      <MobileNavLink href="/admin#catalog" active={pathname === "/admin" && hash === "#catalog"} icon="catalog" label="Catálogo" />
      <MobileNavLink href="/system" active={pathname.startsWith("/system")} icon="settings" label="Sistema" />
      <MobileNavLink href="/account" active={pathname.startsWith("/account")} icon="account" label="Conta" />
    </nav>;
  }
  const managerFocus = managementView === "requests"
    ? { href: "/management?view=requests", icon: "requests" as const, label: "Solicitações" }
    : managementView === "stats"
      ? { href: "/management?view=stats", icon: "analytics" as const, label: "Estatísticas" }
      : { href: "/management?view=pending", icon: "attention" as const, label: "Atenção" };
  const isManagerRoute = isManager && (pathname === "/" || pathname === "/management");
  const isManagerOverview = isManagerRoute && !managementView;
  const isManagerFocus = isManagerRoute && Boolean(managementView);
  return <nav className="mobile-nav" aria-label="Navegação rápida" inert={inert}>
    <MobileNavLink href={isManager ? "/management" : "/"} active={isManager ? isManagerOverview : pathname === "/"} icon="overview" label="Início" />
    {!isTechnicalAdmin && <MobileNavLink href={isManager ? "/queues" : "/queues"} active={pathname.startsWith("/queues")} icon="queue" label="Fila" />}
    {isManager ? <MobileNavLink href={managerFocus.href} active={isManagerFocus} icon={managerFocus.icon} label={managerFocus.label} /> : canAccessClinicalOperations ? <MobileNavLink href="/patients" active={pathname.startsWith("/patients")} icon="patients" label="Pacientes" /> : <MobileNavLink href="/admin" active={pathname.startsWith("/admin")} icon="settings" label="Admin" />}
    {canAccessClinicalOperations && <MobileNavLink href="/notifications" active={pathname.startsWith("/notifications")} icon="notifications" label="Alertas" />}
    <MobileNavLink href="/account" active={pathname.startsWith("/account")} icon="account" label="Conta" />
  </nav>;
}

function MobileNavLink({ href, active, icon, label }: { href: string; active: boolean; icon: IconName; label: string }) {
  return <Link href={href} className={`mobile-nav-link ${active ? "active" : ""}`} aria-label={`Acesso rápido: ${label}`} aria-current={active ? "page" : undefined}><Icon name={icon} size={19} /><span>{label}</span></Link>;
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
