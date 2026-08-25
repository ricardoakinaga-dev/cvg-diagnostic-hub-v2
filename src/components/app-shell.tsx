"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { apiFetch } from "./api-client";

interface SessionUser { id: string; email: string; displayName: string; role: string; departmentCode: string; timezone: string }
type LiveStatus = "connecting" | "connected" | "degraded";

export function AppShell({ children }: Readonly<{ children: React.ReactNode }>) {
  return <Suspense fallback={<div className="screen-center"><div className="loading-mark" aria-label="Carregando" /></div>}><AppShellContent>{children}</AppShellContent></Suspense>;
}

function AppShellContent({ children }: Readonly<{ children: React.ReactNode }>) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [live, setLive] = useState<LiveStatus>("connecting");
  const [reconnectToken, setReconnectToken] = useState(0);
  const [hash, setHash] = useState("");

  useEffect(() => {
    const syncHash = () => setHash(window.location.hash);
    syncHash();
    window.addEventListener("hashchange", syncHash);
    return () => window.removeEventListener("hashchange", syncHash);
  }, []);

  useEffect(() => {
    apiFetch<{ user: SessionUser }>("/session/me")
      .then((result) => setUser(result.user))
      .catch(() => router.replace("/login"))
      .finally(() => setLoading(false));
  }, [router]);

  useEffect(() => {
    if (!user) return;
    let source: EventSource | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let retryCount = 0;
    const connect = () => {
      if (stopped) return;
      const nextSource = new EventSource("/api/v1/realtime/events");
      source = nextSource;
      nextSource.onopen = () => { retryCount = 0; setLive("connected"); };
      nextSource.onmessage = () => window.dispatchEvent(new Event("cvg:realtime-updated"));
      nextSource.addEventListener("resync_required", () => window.dispatchEvent(new Event("cvg:realtime-resync")));
      nextSource.onerror = () => {
        if (stopped || source !== nextSource) return;
        setLive("degraded");
        nextSource.close();
        retryCount += 1;
        retryTimer = setTimeout(connect, Math.min(30_000, 1_000 * 2 ** Math.min(retryCount, 5)));
      };
    };
    connect();
    return () => { stopped = true; source?.close(); if (retryTimer) clearTimeout(retryTimer); };
  }, [reconnectToken, user]);

  function reconcile() {
    setLive("connecting");
    window.dispatchEvent(new Event("cvg:realtime-resync"));
    setReconnectToken((current) => current + 1);
  }

  async function logout() {
    try { await apiFetch("/session/logout", { method: "POST", body: "{}" }); } finally { router.replace("/login"); }
  }

  if (loading) return <div className="screen-center"><div className="loading-mark" aria-label="Carregando" /></div>;
  if (!user) return null;
  const canAccessManagement = user.role === "ADMIN" || user.role === "MANAGER";
  const isTechnicalAdmin = user.role === "ADMIN";
  const isManager = user.role === "MANAGER";
  const canAccessClinicalOperations = !isTechnicalAdmin;
  const canAccessIndicators = user.role === "MANAGER";
  const managementView = searchParams.get("view");
  const isManagementRoute = pathname === "/management" || pathname === "/";
  const isOverview = isManager && ((pathname === "/management" && !managementView) || pathname === "/");
  const isRequests = isManager && isManagementRoute && managementView === "requests";
  const isPending = isManager && isManagementRoute && managementView === "pending";
  const isStats = isManager && isManagementRoute && managementView === "stats";

  return (
    <div className="app-frame">
      <aside className="sidebar">
        <Link href="/" className="brand" aria-label="CVG Diagnostics Hub, início">
          <span className="brand-mark">CVG</span>
          <span><strong>Diagnostics</strong><small>HUB OPERACIONAL</small></span>
        </Link>
        <nav aria-label="Navegação principal" className="main-nav">
          <NavLink href={isManager ? "/management" : "/"} active={isManager ? isOverview : pathname === "/"} icon="⌂">Visão geral</NavLink>
          {isManager ? <>
            <NavLink href="/queues" active={pathname.startsWith("/queues")} icon="▤">Central de exames</NavLink>
            <NavLink href="/management?view=requests" active={isRequests} icon="⌁">Solicitações</NavLink>
            <NavLink href="/management?view=pending" active={isPending} icon="!">Pendências</NavLink>
            <NavLink href="/management?view=stats" active={isStats} icon="◒">Estatísticas</NavLink>
            <NavLink href="/admin#users" active={pathname.startsWith("/admin") && hash === "#users"} icon="♙">Acessos</NavLink>
            <NavLink href="/admin#catalog" active={pathname.startsWith("/admin") && hash === "#catalog"} icon="⚙">Catálogos</NavLink>
            <NavLink href="/admin#audit" active={pathname.startsWith("/admin") && hash === "#audit"} icon="◌">Auditoria</NavLink>
          </> : <>
            {canAccessClinicalOperations && <NavLink href="/queues" active={pathname.startsWith("/queues")} icon="▤">Central de exames</NavLink>}
            {canAccessClinicalOperations && <NavLink href="/patients" active={pathname.startsWith("/patients")} icon="♧">Meus pacientes</NavLink>}
            {canAccessIndicators && <NavLink href="/indicators" active={pathname.startsWith("/indicators")} icon="◒">Indicadores</NavLink>}
            {canAccessManagement && <NavLink href="/admin" active={pathname.startsWith("/admin")} icon="⚙">Administração</NavLink>}
          </>}
          {canAccessClinicalOperations && <NavLink href="/notifications" active={pathname.startsWith("/notifications")} icon="◌">Notificações</NavLink>}
          <NavLink href="/account" active={pathname.startsWith("/account")} icon="◉">Minha conta</NavLink>
        </nav>
        <div className="sidebar-footer">
          <div className={`live-indicator live-${live}`}><span />{live === "connected" ? "Atualização ao vivo" : live === "degraded" ? "Atualização interrompida" : "Conectando"}</div>
          <div className="user-card"><Link href="/account" className="user-profile-link" aria-label={`Abrir conta de ${user.displayName}`}><span className="avatar">{user.displayName.slice(0, 1)}</span><span className="user-copy"><strong>{user.displayName}</strong><small>{user.role.replaceAll("_", " ")}</small></span></Link><button onClick={() => void logout()} className="icon-button" aria-label="Sair">↪</button></div>
        </div>
      </aside>
      <main className="main-content">
        <header className="topbar"><div className="breadcrumb">CVG <span>/</span> Operação</div><div className="topbar-actions">{canAccessClinicalOperations && <Link href="/notifications" className="notification-trigger" aria-label="Abrir notificações">◌</Link>}<span className="topbar-date">{new Intl.DateTimeFormat("pt-BR", { weekday: "short", day: "2-digit", month: "short" }).format(new Date())}</span></div></header>
        {live !== "connected" && <RealtimeStatusBanner status={live} onReconcile={reconcile} />}
        <div className="content-wrap">{children}</div>
      </main>
    </div>
  );
}

function NavLink({ href, active, icon, children }: { href: string; active: boolean; icon: string; children: React.ReactNode }) {
  return <Link href={href} className={`nav-link ${active ? "active" : ""}`} aria-current={active ? "page" : undefined}><span aria-hidden="true">{icon}</span>{children}</Link>;
}

function RealtimeStatusBanner({ status, onReconcile }: { status: Exclude<LiveStatus, "connected">; onReconcile: () => void }) {
  const degraded = status === "degraded";
  return (
    <div className={`realtime-banner realtime-${status}`} role="status" aria-live="polite" aria-atomic="true">
      <div className="realtime-banner-copy">
        <strong>{degraded ? "Atualizações ao vivo indisponíveis" : "Conectando às atualizações ao vivo"}</strong>
        <span>{degraded ? "As informações podem estar desatualizadas até a reconciliação com o servidor." : "As informações podem estar desatualizadas enquanto a conexão é estabelecida."}</span>
      </div>
      <button type="button" className="button button-ghost" onClick={onReconcile}>Atualizar agora</button>
    </div>
  );
}
