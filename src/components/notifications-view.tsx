"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { apiFetch, formatRelativeTime, getSafeErrorMessage } from "./api-client";

interface Notification {
  id: string;
  category: string;
  priority: string;
  title: string;
  body: string;
  createdAt: string;
  state: "PENDING" | "DELIVERED" | "SEEN" | "ACKNOWLEDGED" | "FAILED" | "SUPERSEDED" | "ESCALATED";
  deepLink: string;
  version: number;
}

interface NotificationActionsProps {
  item: Notification;
  reason: string;
  confirmed: boolean;
  onReasonChange: (value: string) => void;
  onConfirmationChange: (value: boolean) => void;
  onAcknowledge: () => void;
}

function NotificationActions({ item, reason, confirmed, onReasonChange, onConfirmationChange, onAcknowledge }: NotificationActionsProps) {
  if (item.state === "ACKNOWLEDGED") return <span className="notification-delivery-state">Confirmada</span>;
  if (item.state === "PENDING") return <span className="notification-delivery-state" role="status">Entrega pendente; a confirmação ficará disponível após o canal confirmar.</span>;
  if (item.state === "FAILED") return <span className="notification-delivery-state" role="alert">Entrega não confirmada; acione o suporte operacional.</span>;
  if (item.state === "SUPERSEDED") return <span className="notification-delivery-state">Resultado substituído; abra o contexto atual.</span>;
  return <div className="notification-confirmation">
    <label htmlFor={`reason-${item.id}`}>Motivo da confirmação</label>
    <input id={`reason-${item.id}`} value={reason} onChange={(event) => onReasonChange(event.target.value)} maxLength={500} />
    <label><input type="checkbox" checked={confirmed} onChange={(event) => onConfirmationChange(event.target.checked)} /> Confirmo a ação</label>
    <button className="button button-primary" disabled={!reason.trim() || !confirmed} onClick={onAcknowledge}>Confirmar</button>
  </div>;
}

export function NotificationsView() {
  const [items, setItems] = useState<Notification[]>([]);
  const [filter, setFilter] = useState("ALL");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [confirmations, setConfirmations] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setError("");
      setItems(await apiFetch<Notification[]>(`/notifications?filter=${filter}`));
    } catch (cause) {
      setError(getSafeErrorMessage(cause, "Não foi possível carregar as notificações."));
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    const refresh = () => { void load(); };
    window.addEventListener("cvg:realtime-updated", refresh);
    window.addEventListener("cvg:realtime-resync", refresh);
    return () => {
      window.removeEventListener("cvg:realtime-updated", refresh);
      window.removeEventListener("cvg:realtime-resync", refresh);
    };
  }, [load]);

  async function acknowledge(notification: Notification) {
    const reason = reasons[notification.id]?.trim();
    if (!reason || !confirmations[notification.id]) {
      setError("Informe o motivo e confirme a ação antes de continuar.");
      return;
    }
    try {
      await apiFetch(`/notifications/${notification.id}/acknowledge`, { method: "POST", body: JSON.stringify({ expectedVersion: notification.version, reason, confirm: true }) });
      void load();
    } catch (cause) {
      setError(getSafeErrorMessage(cause, "Não foi possível confirmar a notificação."));
    }
  }

  return <div className="notifications-page">
    <div className="page-heading"><div><p className="eyebrow">Comunicação interna</p><h1>Notificações <em>que encontram você.</em></h1><p className="page-lede">Cada item leva ao contexto autorizado e permanece na auditoria.</p></div></div>
    <div className="tabs" role="tablist">{[["ALL", "Todas"], ["UNREAD", "Não lidas"], ["ACTIONABLE", "Ação necessária"], ["CRITICAL", "Críticas"]].map(([value, label]) => <button key={value} role="tab" aria-selected={filter === value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{label}</button>)}</div>
    {error && <div className="error-state" role="alert">{error}<button className="button button-ghost" onClick={() => void load()}>Tentar novamente</button></div>}
    <section className="panel inbox-panel">
      {loading && items.length === 0 ? <div className="queue-loading" role="status" aria-live="polite">Carregando notificações…</div> : items.length === 0 ? <div className="empty-state"><span>✓</span><strong>Nenhuma notificação nesta visão</strong><p>Você está em dia no seu escopo.</p></div> : items.map((item) => <article key={item.id} className={`inbox-row inbox-${item.category.toLowerCase()} ${item.state === "ACKNOWLEDGED" ? "is-acknowledged" : ""}`}>
        <span className={`notification-dot notification-${item.category.toLowerCase()}`} />
        <div><p className="inbox-meta">{item.category === "CRITICAL" ? "CRÍTICA" : item.category === "ACTIONABLE" ? "AÇÃO NECESSÁRIA" : "INFORMATIVA"} · {formatRelativeTime(item.createdAt)}</p><h2>{item.title}</h2><p>{item.body}</p></div>
        <div className="inbox-actions">
          <Link href={item.deepLink} className="button button-ghost">Abrir contexto →</Link>
          <NotificationActions item={item} reason={reasons[item.id] ?? ""} confirmed={confirmations[item.id] === true} onReasonChange={(value) => setReasons((current) => ({ ...current, [item.id]: value }))} onConfirmationChange={(value) => setConfirmations((current) => ({ ...current, [item.id]: value }))} onAcknowledge={() => void acknowledge(item)} />
        </div>
      </article>)}
    </section>
  </div>;
}
