"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ActionButton } from "@cvg/ui";
import { ApiClientError, apiFetch, getSafeErrorMessage } from "./api-client";
import { Icon } from "./ui-icons";

/** PROD-202: completes an administrator-issued, single-use reset link. No session is created; the person logs in afterwards. */
export function PasswordResetForm() {
  const searchParams = useSearchParams();
  // The token is read once and removed from the address bar so it does not linger in history or screenshots.
  const [token] = useState(() => searchParams.get("token") ?? "");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [linkInvalid, setLinkInvalid] = useState(token === "");

  useEffect(() => {
    if (token) window.history.replaceState(window.history.state, "", window.location.pathname);
  }, [token]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password !== confirmation) { setError("As senhas precisam ser iguais."); return; }
    setSubmitting(true); setError("");
    try {
      await apiFetch<{ email: string }>("/session/password/reset", { method: "POST", body: JSON.stringify({ token, password }) });
      setPassword(""); setConfirmation(""); setDone(true);
    } catch (cause) {
      if (cause instanceof ApiClientError && cause.code === "PASSWORD_RESET_INVALID") setLinkInvalid(true);
      else setError(getSafeErrorMessage(cause, "Não foi possível redefinir a senha. Tente novamente."));
    } finally { setSubmitting(false); }
  }

  return (
    <main className="login-screen">
      <section className="login-panel">
        <div className="login-brand"><span className="brand-mark">CVG</span><span><strong>Diagnostics</strong><small>HUB OPERACIONAL</small></span></div>
        <div className="login-heading"><p className="eyebrow">Redefinição de senha</p><h1>Defina uma<br /><em>nova senha.</em></h1></div>
        {done ? (
          <div className="login-form">
            <p role="status" className="form-success">Senha redefinida. Entre com a nova senha.</p>
            <Link className="button button-primary button-wide" href="/login">Ir para o login</Link>
          </div>
        ) : linkInvalid ? (
          <div className="login-form">
            <p role="alert" className="form-alert">Link de redefinição inválido ou expirado.</p>
            <p className="field-hint">Peça um novo link à administração do Hub. Cada link vale uma única vez.</p>
            <Link className="button button-ghost button-wide" href="/login">Voltar ao login</Link>
          </div>
        ) : (
          <form onSubmit={(event) => void submit(event)} className="login-form">
            <p className="field-hint">Use de 12 a 200 caracteres, com letras e números. Evite sequências, repetições, seu nome ou e-mail e senhas comuns.</p>
            <label>Nova senha<input type="password" autoComplete="new-password" minLength={12} maxLength={200} required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
            <label>Confirmar nova senha<input type="password" autoComplete="new-password" minLength={12} maxLength={200} required value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
            {error && <div className="form-alert" role="alert">{error}</div>}
            <ActionButton className="button-wide" type="submit" state={submitting ? "pending" : "idle"} icon={<Icon name="arrow-right" size={15} />}>{submitting ? "Salvando…" : "Redefinir senha"}</ActionButton>
          </form>
        )}
        <p className="login-footnote">Link de uso único · atividade auditada · dados protegidos</p>
      </section>
      <aside className="login-aside"><div className="aside-grid" /><div className="aside-orbit orbit-one" /><div className="aside-orbit orbit-two" /></aside>
    </main>
  );
}
