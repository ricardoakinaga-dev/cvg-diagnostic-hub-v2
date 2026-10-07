"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AuditEvent, DeadLetterMessage, ManagedSession, SessionResponse } from "@cvg/contracts";
import { ActionButton } from "@cvg/ui";
import { ApiClientError, apiFetch, getSafeErrorMessage } from "./api-client";
import { useConfirm } from "./confirm-dialog";
import { EmptyState, ErrorState, LoadingState } from "./feedback-states";

export function SystemConsole() {
  const [sessions, setSessions] = useState<ManagedSession[]>([]);
  const [deadLetters, setDeadLetters] = useState<DeadLetterMessage[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [allowed, setAllowed] = useState(false);
  const [denied, setDenied] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const load = useCallback(async () => {
    const version = ++generation.current;
    setLoading(true); setError(""); setDenied(false); setAllowed(false);
    setSessions([]); setDeadLetters([]); setAuditEvents([]);
    try {
      const identity = await apiFetch<SessionResponse>("/session/me");
      if (version !== generation.current) return;
      if (identity.user.role !== "ADMIN") { setDenied(true); return; }
      const results = await Promise.allSettled([
        apiFetch<ManagedSession[]>("/sessions"), apiFetch<DeadLetterMessage[]>("/outbox/dead-letters"), apiFetch<AuditEvent[]>("/audit-events?limit=20")
      ]);
      if (version !== generation.current) return;
      const [sessionResult, messageResult, auditResult] = results;
      if (results.some((result) => result.status === "rejected" && result.reason instanceof ApiClientError && result.reason.code === "SCOPE_DENIED")) { setDenied(true); return; }
      setAllowed(true);
      if (sessionResult.status === "fulfilled") setSessions(sessionResult.value);
      if (messageResult.status === "fulfilled") setDeadLetters(messageResult.value);
      if (auditResult.status === "fulfilled") setAuditEvents(auditResult.value);
      if (results.some((result) => result.status === "rejected")) setError("Parte dos dados do sistema está indisponível. Tente atualizar.");
    } catch (cause) {
      if (version !== generation.current) return;
      if (cause instanceof ApiClientError && cause.code === "SCOPE_DENIED") setDenied(true);
      else setError(getSafeErrorMessage(cause, "Não foi possível carregar o sistema."));
    } finally { if (version === generation.current) setLoading(false); }
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => { window.clearTimeout(timer); generation.current += 1; };
  }, [load]);
  if (loading) return <LoadingState label="Carregando sistema" />;
  return <div className="admin-page"><div className="page-heading"><div><h1>Sistema</h1><p className="page-lede">Sessões, mensagens retidas e auditoria.</p></div><ActionButton tone="ghost" onClick={() => void load()}>Atualizar</ActionButton></div>
    {denied ? <ErrorState title="Sistema restrito à administração técnica" message="Somente o perfil ADMIN pode acessar esta área." onRetry={load} action={<Link className="button button-ghost" href="/">Voltar à visão geral</Link>} /> : <>
      {error && <ErrorState title="Sistema indisponível" message={error} onRetry={load} />}
      {allowed && <>
        <section className="panel admin-audit-panel" id="sessions"><div className="panel-heading"><h2>Dispositivos e acessos ativos</h2><span>{sessions.length}</span></div>{sessions.length === 0 ? <EmptyState title="Nenhuma sessão no escopo" message="As sessões aparecerão aqui." /> : <div className="admin-list">{sessions.map((session) => <ManagedSessionRow key={session.id} session={session} onSaved={load} />)}</div>}</section>
        <section className="panel admin-audit-panel" id="dead-letters"><div className="panel-heading"><h2>Dead-letter do outbox</h2><span>{deadLetters.length}</span></div>{deadLetters.length === 0 ? <EmptyState title="Nenhuma mensagem retida" message="Mensagens com falha de entrega aparecerão aqui." /> : <div className="admin-list">{deadLetters.map((message) => <DeadLetterRow key={message.id} message={message} onSaved={load} />)}</div>}</section>
        <section className="panel admin-audit-panel" id="audit"><div className="panel-heading"><h2>Auditoria recente</h2><span>{auditEvents.length}</span></div>{auditEvents.length === 0 ? <EmptyState title="Nenhum evento recente" message="As alterações aparecerão aqui." /> : <ul className="admin-audit-list">{auditEvents.map((event) => <li key={event.id}><span className="audit-dot" aria-hidden="true" /><span><strong>{event.eventType.replace(/([a-z])([A-Z])/g, "$1 $2")}</strong><small>{event.entityType} · {event.entityId} · {new Date(event.occurredAt).toLocaleString("pt-BR")}</small></span><span className="admin-audit-state">{event.newState ?? "registrado"}</span></li>)}</ul>}</section>
      </>}
    </>}
  </div>;
}

function ManagedSessionRow({ session, onSaved }: { session: ManagedSession; onSaved: () => Promise<void> }) {
  const { confirm, dialog } = useConfirm();
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState("");
  async function revoke() {
    if (submitting.current || session.current || session.status !== "ACTIVE") return;
    submitting.current = true;
    const confirmed = await confirm({ title: "Revogar sessão", message: `Revogar a sessão de ${session.userEmail}?`, confirmLabel: "Revogar", tone: "danger" });
    if (!confirmed) { submitting.current = false; return; }
    setBusy(true); setError("");
    try { await apiFetch(`/sessions/${session.id}/revoke`, { method: "POST", body: JSON.stringify({}) }); await onSaved(); }
    catch (cause) { setError(getSafeErrorMessage(cause, "Não foi possível revogar a sessão.")); }
    finally { submitting.current = false; setBusy(false); }
  }
  return <><div className="admin-row"><div className="admin-row-heading"><strong>{session.userDisplayName}</strong><span>{session.status === "ACTIVE" ? "Ativa" : session.status === "REVOKED" ? "Revogada" : "Expirada"}</span></div><small>{session.userEmail} · {session.departmentCode} · {new Date(session.createdAt).toLocaleString("pt-BR")}</small>{session.current ? <small>Sessão atual: use sair para encerrá-la.</small> : session.status === "ACTIVE" && <ActionButton tone="ghost" type="button" state={busy ? "pending" : "idle"} onClick={() => void revoke()}>Revogar sessão</ActionButton>}{error && <p className="form-alert" role="alert">{error}</p>}</div>{dialog}</>;
}

function DeadLetterRow({ message, onSaved }: { message: DeadLetterMessage; onSaved: () => Promise<void> }) {
  const { confirm, dialog } = useConfirm();
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState("");
  async function act(action: "reprocess" | "discard") {
    if (submitting.current) return; // the actions are only rendered for FAILED messages
    const label = action === "discard" ? "Descartar" : "Reprocessar";
    submitting.current = true;
    const confirmed = await confirm({ title: `${label} mensagem`, message: `${label} a mensagem ${message.id}?`, confirmLabel: label, tone: action === "discard" ? "danger" : "default" });
    if (!confirmed) { submitting.current = false; return; }
    setBusy(true); setError("");
    try { await apiFetch(`/outbox/dead-letters/${message.id}/${action}`, { method: "POST", body: JSON.stringify({}) }); await onSaved(); }
    catch (cause) { setError(getSafeErrorMessage(cause, "Não foi possível operar a dead-letter.")); }
    finally { submitting.current = false; setBusy(false); }
  }
  return <><div className="admin-row"><div className="admin-row-heading"><strong>{message.eventType}</strong><span>{message.status === "FAILED" ? "Retida" : message.status === "PENDING" ? "Em processamento" : "Descartada"}</span></div><small>{message.id} · {message.aggregateType}/{message.aggregateId} · tentativas {message.attempts}</small>{message.lastError && <small>Falha: {message.lastError}</small>}{message.status === "FAILED" && <div className="admin-action-row"><ActionButton tone="ghost" type="button" state={busy ? "pending" : "idle"} onClick={() => void act("reprocess")}>Reprocessar</ActionButton><ActionButton tone="ghost" type="button" state={busy ? "pending" : "idle"} onClick={() => void act("discard")}>Descartar</ActionButton></div>}{error && <p className="form-alert" role="alert">{error}</p>}</div>{dialog}</>;
}
