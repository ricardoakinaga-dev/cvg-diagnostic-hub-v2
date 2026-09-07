"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ActionButton } from "@cvg/ui";
import { apiFetch, getSafeErrorMessage } from "./api-client";
import { Icon } from "./ui-icons";

interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  role: string;
  departmentCode: string;
  managedDepartmentCodes?: string[];
  timezone: string;
}

const roleLabels: Record<string, string> = {
  ADMIN: "Administração técnica",
  MANAGER: "Gestão operacional",
  VETERINARIAN: "Veterinária",
  INPATIENT_TEAM: "Equipe de internação",
  LAB_TECH: "Técnica de laboratório",
  RADIOLOGY_TEAM: "Equipe de radiologia",
  ULTRASOUND_TEAM: "Equipe de ultrassom",
  VIEWER: "Visualização operacional"
};

const departmentLabels: Record<string, string> = {
  INPATIENT: "Internação",
  LABORATORY: "Laboratório",
  RADIOLOGY: "Radiologia",
  ULTRASOUND: "Ultrassom",
  IT: "Tecnologia"
};

function labelFor(values: Record<string, string>, value: string): string {
  return values[value] ?? value.replaceAll("_", " ");
}

export function AccountView() {
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    void apiFetch<{ user: SessionUser }>("/session/me")
      .then(({ user: currentUser }) => setUser(currentUser))
      .catch((cause) => setError(getSafeErrorMessage(cause, "Não foi possível carregar sua conta.")))
      .finally(() => setLoading(false));
  }, []);

  async function logout() {
    setLoggingOut(true);
    try { await apiFetch("/session/logout", { method: "POST", body: "{}" }); }
    finally { router.replace("/login"); }
  }

  if (loading) return <div className="loading-state" role="status">Carregando sua conta…</div>;
  if (!user) return <div className="error-state" role="alert"><strong>Conta indisponível</strong><span>{error}</span><Link className="button button-ghost" href="/">Voltar ao início</Link></div>;

  const managedDepartments = user.managedDepartmentCodes?.map((code) => labelFor(departmentLabels, code)).join(" · ");
  const canAccessClinical = user.role !== "ADMIN";
  return <div className="account-page">
    <Link href="/" className="back-link"><Icon name="arrow-left" size={15} /> Visão geral</Link>
    <div className="page-heading account-heading"><div><p className="eyebrow">Acesso individual</p><h1>Minha <em>conta.</em></h1><p className="page-lede">Confira sua identidade, perfil operacional e proteção da sessão.</p></div><ActionButton tone="ghost" type="button" state={loggingOut ? "pending" : "idle"} onClick={() => void logout()}>{loggingOut ? "Saindo…" : "Encerrar sessão"}</ActionButton></div>
    <section className="panel account-identity"><span className="account-avatar">{user.displayName.slice(0, 1)}</span><div><p className="eyebrow">Sessão ativa</p><h2>{user.displayName}</h2><p>{user.email}</p></div><span className="account-status"><span />Acesso ativo</span></section>
    <div className="account-grid">
      <section className="panel account-panel"><div className="panel-heading"><div><p className="eyebrow">Perfil operacional</p><h2>Seu contexto</h2></div></div><dl className="account-details"><div><dt>Função</dt><dd>{labelFor(roleLabels, user.role)}</dd></div><div><dt>Setor principal</dt><dd>{labelFor(departmentLabels, user.departmentCode)}</dd></div><div><dt>Fuso horário</dt><dd>{user.timezone}</dd></div>{managedDepartments && <div><dt>Setores gerenciados</dt><dd>{managedDepartments}</dd></div>}</dl></section>
      <section className="panel account-panel"><div className="panel-heading"><div><p className="eyebrow">Proteção</p><h2>Segurança da sessão</h2></div></div><ul className="account-security-list"><li><span className="account-security-icon" aria-hidden="true"><Icon name="check" size={14} /></span><span><strong>Autenticação individual</strong><small>Acesso vinculado ao seu usuário e ao seu perfil atual.</small></span></li><li><span className="account-security-icon" aria-hidden="true"><Icon name="audit" size={14} /></span><span><strong>Atividade controlada</strong><small>As ações operacionais passam por autorização e registro.</small></span></li><li><span className="account-security-icon" aria-hidden="true"><Icon name="refresh" size={14} /></span><span><strong>Atualização ao vivo</strong><small>O Hub reconcilia mudanças enquanto você trabalha.</small></span></li></ul></section>
    </div>
    <section className="panel account-shortcuts"><div className="panel-heading"><div><p className="eyebrow">Acesso rápido</p><h2>Continuar no Hub</h2></div></div><div className="account-shortcut-grid">{canAccessClinical && <Link href="/patients"><strong>Meus pacientes</strong><small>Buscar pacientes e acompanhar exames.</small><Icon name="arrow-right" size={15} /></Link>}{canAccessClinical && <Link href="/queues"><strong>Central de exames</strong><small>Acompanhar filas e próximas ações.</small><Icon name="arrow-right" size={15} /></Link>}{canAccessClinical && <Link href="/notifications"><strong>Notificações</strong><small>Revisar ações pendentes no seu escopo.</small><Icon name="arrow-right" size={15} /></Link>}{user.role === "MANAGER" && <Link href="/management"><strong>Gestão operacional</strong><small>Consolidar filas, pendências e indicadores.</small><Icon name="arrow-right" size={15} /></Link>}{user.role === "ADMIN" && <Link href="/admin"><strong>Administração técnica</strong><small>Gerenciar acessos, catálogo e auditoria.</small><Icon name="arrow-right" size={15} /></Link>}</div></section>
  </div>;
}
