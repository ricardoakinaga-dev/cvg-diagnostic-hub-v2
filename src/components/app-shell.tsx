"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import type { Notification, SessionResponse } from "@cvg/contracts";
import { apiFetch } from "./api-client";
import { LoadingState } from "./feedback-states";
import { Icon, type IconName } from "./ui-icons";
import { CommandPalette } from "./command-palette";
import { PatientDialog } from "./patient-dialog";
import { PageHeader, type Crumb } from "./page-header";
import { Avatar, DepartmentIcon } from "./work-items/icons";
import { CLINICAL_DEPARTMENTS, departmentLabel } from "./work-items/model";
import styles from "./app-shell.module.css";

type LiveStatus = "connecting" | "connected" | "degraded";
const REALTIME_FALLBACK_INTERVAL_MS = 30_000;
const SIDEBAR_STORAGE_KEY = "cvg.sidebar.collapsed";
const SECTORS_STORAGE_KEY = "cvg.sidebar.sectors";
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
function sidebarSectors(user: SessionResponse["user"]): string[] {
  if (user.role === "ADMIN") return [];
  if (user.role === "MANAGER") return CLINICAL_DEPARTMENTS.filter((code) => user.managedDepartmentCodes?.includes(code));
  if (CLINICAL_DEPARTMENTS.includes(user.departmentCode as typeof CLINICAL_DEPARTMENTS[number])) return [user.departmentCode];
  return [...CLINICAL_DEPARTMENTS];
}

/** Breadcrumbs for pages that do not draw their own Plane header. */
function legacyCrumbs(pathname: string, view: string | null, hash: string): Crumb[] {
  if (pathname.startsWith("/patients/")) return [{ label: "Pacientes", href: "/patients", icon: "paw" }, { label: "Diagnósticos do paciente" }];
  if (pathname.startsWith("/patients")) return [{ label: "Pacientes", icon: "paw" }];
  if (pathname.startsWith("/notifications")) return [{ label: "Caixa de entrada", icon: "inbox" }];
  if (pathname.startsWith("/account")) return [{ label: "Minha conta", icon: "account" }];
  if (pathname.startsWith("/admin")) return hash === "#users" ? [{ label: "Administração", href: "/admin", icon: "settings" }, { label: "Acessos" }] : hash === "#catalog" ? [{ label: "Administração", href: "/admin", icon: "settings" }, { label: "Catálogos" }] : [{ label: "Administração", icon: "settings" }];
  if (pathname.startsWith("/system")) return [{ label: "Sistema", icon: "settings" }];
  if (pathname.startsWith("/indicators")) return [{ label: "Indicadores", icon: "analytics" }];
  if (pathname.startsWith("/results/")) return [{ label: "Exames", href: "/queues", icon: "layers" }, { label: "Resultado" }];
  if (pathname.startsWith("/requests/")) return [{ label: "Exames", href: "/queues", icon: "layers" }, { label: "Solicitação" }];
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
  const sessionLoading = loading || sessionPath !== pathname;
  const canUsePalette = Boolean(user && user.role !== "ADMIN" && !requiresPasswordChange && !sessionLoading);
  const canCreatePatient = user?.role === "VETERINARIAN" || user?.role === "INPATIENT_TEAM";
  const canCreateRequest = canCreatePatient || user?.role === "MANAGER";
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
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setCollapsed(readStorage(SIDEBAR_STORAGE_KEY) === "1");
      try { const saved = JSON.parse(readStorage(SECTORS_STORAGE_KEY) ?? "null") as unknown; if (Array.isArray(saved)) setOpenSectors(saved.filter((value): value is string => typeof value === "string")); } catch { /* ignore */ }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    apiFetch<SessionResponse>("/session/me", { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) { setUser(result.user); setSessionPath(pathname); setShowPalette(false); setShowPatient(false); setShowUserMenu(false); setMobileOpen(false); } })
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

  function toggleCollapsed() {
    setCollapsed((current) => { writeStorage(SIDEBAR_STORAGE_KEY, current ? "0" : "1"); return !current; });
  }

  if (sessionLoading) return <ShellLoadingState />;
  if (!user) return null;
  const isTechnicalAdmin = user.role === "ADMIN";
  const isManager = user.role === "MANAGER";
  const canAccessClinicalOperations = !isTechnicalAdmin;
  const managementView = searchParams.get("view");
  const dept = searchParams.get("dept");
  const preset = searchParams.get("preset");
  const onQueues = pathname.startsWith("/queues");
  const sectors = sidebarSectors(user);
  const expandedSectors = openSectors ?? (dept ? [dept] : sectors.slice(0, 1));
  const toggleSector = (code: string) => {
    const next = expandedSectors.includes(code) ? expandedSectors.filter((value) => value !== code) : [...expandedSectors, code];
    setOpenSectors(next);
    writeStorage(SECTORS_STORAGE_KEY, JSON.stringify(next));
  };

  const content = requiresPasswordChange && pathname !== "/account" && pathname !== "/login" ? <ShellLoadingState /> : flush ? children : <>
    <PageHeader crumbs={legacyCrumbs(pathname, managementView, hash)} heading={false} />
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
          <span className="sidebar-title">{isTechnicalAdmin ? "Administração" : isManager ? "Operação" : "Diagnósticos"}</span>
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
              {isManager && <NavLink href="/indicators" active={pathname.startsWith("/indicators")} icon="analytics">Indicadores</NavLink>}
            </div>}
            {isManager && <div className="nav-group">
              <span className="nav-group-label">Gestão</span>
              <NavLink href="/management" active={pathname === "/management" && !managementView} icon="overview">Painel gerencial</NavLink>
              <NavLink href="/management?view=requests" active={pathname === "/management" && managementView === "requests"} icon="requests">Solicitações</NavLink>
              <NavLink href="/management?view=pending" active={pathname === "/management" && managementView === "pending"} icon="attention">Pendências</NavLink>
              <NavLink href="/management?view=stats" active={pathname === "/management" && managementView === "stats"} icon="analytics">Estatísticas</NavLink>
              <NavLink href="/admin#users" active={pathname.startsWith("/admin") && hash === "#users"} icon="users">Acessos</NavLink>
              <NavLink href="/admin#catalog" active={pathname.startsWith("/admin") && hash === "#catalog"} icon="catalog">Catálogos</NavLink>
            </div>}
            {isTechnicalAdmin && <div className="nav-group">
              <span className="nav-group-label">Workspace</span>
              <NavLink href="/admin" active={pathname.startsWith("/admin") && !hash} icon="settings">Administração</NavLink>
              <NavLink href="/admin#users" active={pathname.startsWith("/admin") && hash === "#users"} icon="users">Acessos</NavLink>
              <NavLink href="/admin#catalog" active={pathname.startsWith("/admin") && hash === "#catalog"} icon="catalog">Catálogos</NavLink>
              <NavLink href="/system" active={pathname.startsWith("/system")} icon="activity">Sistema</NavLink>
            </div>}
            {sectors.length > 0 && <div className="nav-group">
              <span className="nav-group-label">Setores</span>
              {sectors.map((code) => {
                const open = expandedSectors.includes(code);
                const base = `/queues?dept=${code}`;
                return <div key={code} className="nav-sector">
                  <button type="button" className={`nav-sector-toggle${onQueues && dept === code ? " active" : ""}`} aria-expanded={open} onClick={() => toggleSector(code)}>
                    <DepartmentIcon code={code} size={14} /><span className="nav-label">{departmentLabel(code)}</span><Icon name="chevron-down" size={13} className="nav-sector-chevron" />
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
          {content}
        </div>
      </main>
      {requiresPasswordChange ? <nav className={`mobile-nav ${styles.accountNav}`} aria-label="Navegação rápida"><MobileNavLink href="/account?password=required" active={pathname === "/account"} icon="account" label="Conta" /></nav> : <MobileNav inert={modalOpen || peekOpen} isTechnicalAdmin={isTechnicalAdmin} isManager={isManager} pathname={pathname} hash={hash} view={managementView} unread={unread} />}
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

function MobileNav({ inert, isTechnicalAdmin, isManager, pathname, hash, view, unread }: { inert: boolean; isTechnicalAdmin: boolean; isManager: boolean; pathname: string; hash: string; view: string | null; unread: number }) {
  if (isTechnicalAdmin) {
    return <nav className={`mobile-nav ${styles.adminNav}`} aria-label="Navegação rápida" inert={inert}>
      <MobileNavLink href="/" active={pathname === "/"} icon="home" label="Início" />
      <MobileNavLink href="/admin" active={pathname === "/admin" && !hash} icon="settings" label="Admin" />
      <MobileNavLink href="/admin#users" active={pathname === "/admin" && hash === "#users"} icon="users" label="Acessos" />
      <MobileNavLink href="/admin#catalog" active={pathname === "/admin" && hash === "#catalog"} icon="catalog" label="Catálogo" />
      <MobileNavLink href="/system" active={pathname.startsWith("/system")} icon="activity" label="Sistema" />
      <MobileNavLink href="/account" active={pathname.startsWith("/account")} icon="account" label="Conta" />
    </nav>;
  }
  if (isManager) {
    // Managers keep one management destination, the one they are on or "Atenção".
    const onManagement = pathname === "/management";
    const focus = view === "requests" ? { href: "/management?view=requests", icon: "requests" as const, label: "Solicitações" }
      : view === "stats" ? { href: "/management?view=stats", icon: "analytics" as const, label: "Estatísticas" }
        : { href: "/management?view=pending", icon: "attention" as const, label: "Atenção" };
    return <nav className="mobile-nav" aria-label="Navegação rápida" inert={inert}>
      <MobileNavLink href="/" active={pathname === "/"} icon="home" label="Início" />
      <MobileNavLink href="/queues" active={pathname.startsWith("/queues")} icon="layers" label="Exames" />
      <MobileNavLink href={focus.href} active={onManagement && Boolean(view)} icon={focus.icon} label={focus.label} />
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
