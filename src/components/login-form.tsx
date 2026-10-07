"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { ActionButton } from "@cvg/ui";
import { apiFetch, getSafeErrorMessage } from "./api-client";
import { Icon } from "./ui-icons";
import type { SessionResponse } from "@cvg/contracts";

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true); setError("");
    try {
      const session = await apiFetch<SessionResponse>("/session/login", { method: "POST", body: JSON.stringify({ email, password }) });
      router.replace(session.user.mustChangePassword ? "/account?password=required" : "/");
    } catch (cause) { setError(getSafeErrorMessage(cause, "Não foi possível entrar. Verifique os dados e tente novamente.")); }
    finally { setSubmitting(false); }
  }

  return (
    <main className="login-screen">
      <section className="login-panel">
        <div className="login-brand"><span className="brand-mark">CVG</span><span><strong>Diagnostics</strong><small>HUB OPERACIONAL</small></span></div>
        <div className="login-heading"><p className="eyebrow">Acesso seguro</p><h1>Bom trabalho começa<br /><em>com contexto.</em></h1><p>Entre para acompanhar exames, pendências e resultados no escopo do seu setor.</p></div>
        <form onSubmit={submit} className="login-form">
          <label>E-mail profissional<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="nome@hospital.com" autoComplete="username" required /></label>
          <label>Senha<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Sua senha" autoComplete="current-password" required /></label>
          {error && <div className="form-alert" role="alert">{error}</div>}
          <ActionButton className="button-wide" type="submit" state={submitting ? "pending" : "idle"} icon={<Icon name="arrow-right" size={15} />}>{submitting ? "Entrando…" : "Entrar no Hub"}</ActionButton>
        </form>
        <p className="login-footnote">Acesso individual · atividade auditada · dados protegidos</p>
      </section>
      <aside className="login-aside"><div className="aside-grid" /><div className="aside-quote"><span className="quote-mark">“</span><p>Nenhuma solicitação importante deve se perder entre quem solicita, quem executa e quem precisa agir.</p><small>PRINCÍPIO DO HUB</small></div><div className="aside-orbit orbit-one" /><div className="aside-orbit orbit-two" /></aside>
    </main>
  );
}
