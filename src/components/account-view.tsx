"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import type { SessionResponse, SessionUser } from "@cvg/contracts";
import { ActionButton } from "@cvg/ui";
import { apiFetch, getSafeErrorMessage } from "./api-client";
import { ErrorState, LoadingState } from "./feedback-states";
import { Icon } from "./ui-icons";

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

/** PROD-201: confirms the current password; the server rotates this session and ends every other one. */
function PasswordChangePanel() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaved(false);
    if (newPassword !== confirmation) { setError("As senhas novas precisam ser iguais."); return; }
    setSaving(true); setError("");
    try {
      await apiFetch<SessionResponse>("/session/password/change", { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) });
      setCurrentPassword(""); setNewPassword(""); setConfirmation("");
      setSaved(true);
    } catch (cause) { setError(getSafeErrorMessage(cause, "Não foi possível alterar sua senha.")); }
    finally { setSaving(false); }
  }

  return <section className="panel account-panel account-password" aria-labelledby="account-password-title"><div className="panel-heading"><div><p className="eyebrow">Credencial</p><h2 id="account-password-title">Alterar senha</h2></div></div><p className="field-hint">Use de 12 a 200 caracteres, com letras e números. As outras sessões abertas com sua conta serão encerradas.</p><form className="admin-create-form" onSubmit={(event) => void changePassword(event)}><label>Senha atual<input type="password" autoComplete="current-password" maxLength={200} required value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label><label>Nova senha<input type="password" autoComplete="new-password" minLength={12} maxLength={200} required value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></label><label>Confirmar nova senha<input type="password" autoComplete="new-password" minLength={12} maxLength={200} required value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>{error && <p role="alert" className="form-alert">{error}</p>}{saved && <p role="status" className="form-success">Senha alterada. As outras sessões foram encerradas.</p>}<ActionButton type="submit" state={saving ? "pending" : "idle"}>Alterar senha</ActionButton></form></section>;
}

const consentDate = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short" });

/** PROD-402: the person's own WhatsApp number for critical-result alerts, registered with consent. */
function AlertContactPanel({ user, onChange }: { user: SessionUser; onChange: (user: SessionUser) => void }) {
  const [editing, setEditing] = useState(!user.alertContact);
  const [phone, setPhone] = useState("");
  const [consent, setConsent] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function save(whatsappPhone: string | null) {
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await apiFetch<SessionResponse>("/session/alert-contact", { method: "PUT", body: JSON.stringify(whatsappPhone === null ? { whatsappPhone } : { whatsappPhone, consent: true }) });
      onChange(response.user);
      setPhone(""); setConsent(false);
      setEditing(!response.user.alertContact);
      setNotice(whatsappPhone === null ? "Número removido. Os alertas continuam chegando no Hub." : "Número cadastrado para os alertas.");
    } catch (cause) { setError(getSafeErrorMessage(cause, "Não foi possível salvar o número.")); }
    finally { setSaving(false); }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void save(phone);
  }

  const contact = user.alertContact;
  return <section className="panel account-panel account-alerts" aria-labelledby="account-alerts-title"><div className="panel-heading"><div><p className="eyebrow">Alertas</p><h2 id="account-alerts-title">Resultado crítico no WhatsApp</h2></div></div>
    <p className="field-hint">Quando um resultado crítico precisa da sua confirmação, o Hub também avisa por WhatsApp. A mensagem não traz dados do paciente nem do exame: só o protocolo e o link. A confirmação continua sendo feita no Hub.</p>
    {user.onCall && <p role="note" className={contact ? "form-success" : "form-alert"}>{contact ? "Você está no plantão de alertas do seu setor." : "Você está no plantão de alertas, mas sem número cadastrado: os avisos só chegam pelo Hub."}</p>}
    {contact && <dl className="account-details"><div><dt>Número cadastrado</dt><dd>{contact.maskedPhone}</dd></div><div><dt>Autorizado em</dt><dd>{consentDate.format(new Date(contact.consentAt))}</dd></div></dl>}
    {notice && <p role="status" className="form-success">{notice}</p>}
    {contact && !editing && <>{error && <p role="alert" className="form-alert">{error}</p>}<div className="admin-action-row"><ActionButton tone="ghost" type="button" disabled={saving} onClick={() => { setEditing(true); setNotice(""); }}>Trocar número</ActionButton><ActionButton tone="ghost" type="button" state={saving ? "pending" : "idle"} onClick={() => void save(null)}>Remover número</ActionButton></div></>}
    {editing && <form className="admin-create-form" aria-label="Cadastrar número para alertas" onSubmit={submit}><label>Celular com DDD<input type="tel" inputMode="tel" autoComplete="tel" maxLength={40} required placeholder="+55 11 9…" value={phone} onChange={(event) => setPhone(event.target.value)} /></label><label className="admin-check"><input type="checkbox" required checked={consent} onChange={(event) => setConsent(event.target.checked)} /> Autorizo o Hub a enviar alertas de resultado crítico para este número pelo WhatsApp.</label>{error && <p role="alert" className="form-alert">{error}</p>}<div className="admin-action-row"><ActionButton type="submit" state={saving ? "pending" : "idle"} disabled={!consent}>Salvar número</ActionButton>{contact && <ActionButton tone="ghost" type="button" disabled={saving} onClick={() => { setEditing(false); setError(""); }}>Cancelar</ActionButton>}</div></form>}
  </section>;
}

export function AccountView() {
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [loggingOut, setLoggingOut] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);

  useEffect(() => {
    void apiFetch<SessionResponse>("/session/me")
      .then(({ user: currentUser }) => setUser(currentUser))
      .catch((cause) => setError(getSafeErrorMessage(cause, "Não foi possível carregar sua conta.")))
      .finally(() => setLoading(false));
  }, []);

  async function logout() {
    setLoggingOut(true);
    try { await apiFetch("/session/logout", { method: "POST", body: "{}" }); }
    finally { router.replace("/login"); }
  }

  async function replaceInitialPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password !== confirmation) { setError("As senhas precisam ser iguais."); return; }
    setSavingPassword(true); setError("");
    try {
      await apiFetch<SessionResponse>("/session/password", { method: "POST", body: JSON.stringify({ password }) });
      setPassword(""); setConfirmation("");
      router.replace("/");
      router.refresh();
    } catch (cause) { setError(getSafeErrorMessage(cause, "Não foi possível trocar sua senha.")); }
    finally { setSavingPassword(false); }
  }

  if (loading) return <LoadingState label="Carregando sua conta" />;
  if (!user) return <ErrorState page title="Conta indisponível" message={error} onRetry={() => window.location.reload()} action={<Link className="button button-ghost" href="/">Voltar ao início</Link>} />;
  if (user.mustChangePassword) return <div className="account-page"><div className="page-heading"><div><p className="eyebrow">Primeiro acesso</p><h1>Crie sua senha</h1><p className="page-lede">Substitua a senha inicial para acessar o Hub. Use pelo menos 12 caracteres, com letras e números.</p></div></div><section className="panel account-panel"><form className="admin-create-form" onSubmit={(event) => void replaceInitialPassword(event)}><label>Nova senha<input type="password" autoComplete="new-password" minLength={12} maxLength={200} required value={password} onChange={(event) => setPassword(event.target.value)} /></label><label>Confirmar nova senha<input type="password" autoComplete="new-password" minLength={12} maxLength={200} required value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>{error && <p role="alert" className="form-alert">{error}</p>}<ActionButton type="submit" state={savingPassword ? "pending" : "idle"}>Salvar nova senha</ActionButton><ActionButton type="button" tone="ghost" state={loggingOut ? "pending" : "idle"} onClick={() => void logout()}>Encerrar sessão</ActionButton></form></section></div>;

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
    <PasswordChangePanel />
    <AlertContactPanel user={user} onChange={setUser} />
    <section className="panel account-shortcuts"><div className="panel-heading"><div><p className="eyebrow">Acesso rápido</p><h2>Continuar no Hub</h2></div></div><div className="account-shortcut-grid">{canAccessClinical && <Link href="/patients"><strong>Meus pacientes</strong><small>Buscar pacientes e acompanhar exames.</small><Icon name="arrow-right" size={15} /></Link>}{canAccessClinical && <Link href="/queues"><strong>Central de exames</strong><small>Acompanhar filas e próximas ações.</small><Icon name="arrow-right" size={15} /></Link>}{canAccessClinical && <Link href="/notifications"><strong>Notificações</strong><small>Revisar ações pendentes no seu escopo.</small><Icon name="arrow-right" size={15} /></Link>}{user.role === "MANAGER" && <Link href="/management"><strong>Gestão operacional</strong><small>Consolidar filas, pendências e indicadores.</small><Icon name="arrow-right" size={15} /></Link>}{user.role === "ADMIN" && <Link href="/admin"><strong>Administração técnica</strong><small>Gerenciar acessos, catálogo e auditoria.</small><Icon name="arrow-right" size={15} /></Link>}</div></section>
  </div>;
}
