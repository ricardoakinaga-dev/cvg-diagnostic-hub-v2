"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Notification } from "@cvg/contracts";
import { ActionButton } from "@cvg/ui";
import { apiFetch, formatRelativeTime, getSafeErrorMessage } from "./api-client";
import { EmptyState, ErrorState, LoadingState, StaleNotice } from "./feedback-states";
import { Icon } from "./ui-icons";

interface NotificationActionsProps {
  item: Notification;
  reason: string;
  confirmed: boolean;
  onReasonChange: (value: string) => void;
  onConfirmationChange: (value: boolean) => void;
  onAcknowledge: () => void;
  pending: boolean;
  blocked: boolean;
}

const notificationTabs = [
  ["ALL", "Todas"],
  ["UNREAD", "Não lidas"],
  ["ACTIONABLE", "Ação necessária"],
  ["CRITICAL", "Críticas"]
] as const;

function NotificationActions({ item, reason, confirmed, onReasonChange, onConfirmationChange, onAcknowledge, pending, blocked }: NotificationActionsProps) {
  if (item.state === "ACKNOWLEDGED") return <span className="notification-delivery-state">Confirmada</span>;
  if (item.state === "PENDING") return <span className="notification-delivery-state" role="status">Entrega pendente; a confirmação ficará disponível após o canal confirmar.</span>;
  if (item.state === "FAILED") return <span className="notification-delivery-state" role="alert">Entrega não confirmada; acione o suporte operacional.</span>;
  if (item.state === "SUPERSEDED") return <span className="notification-delivery-state">Resultado substituído; abra o contexto atual.</span>;
  return <div className="notification-confirmation">
    <label htmlFor={`reason-${item.id}`}>Motivo da confirmação</label>
    <input id={`reason-${item.id}`} value={reason} onChange={(event) => onReasonChange(event.target.value)} maxLength={500} />
    <label><input type="checkbox" checked={confirmed} onChange={(event) => onConfirmationChange(event.target.checked)} /> Confirmo a ação</label>
    <ActionButton type="button" state={pending ? "pending" : "idle"} disabled={blocked || !reason.trim() || !confirmed} onClick={onAcknowledge}>{pending ? "Confirmando…" : "Confirmar"}</ActionButton>
  </div>;
}

export function NotificationsView() {
  const [items, setItems] = useState<Notification[]>([]);
  const [filter, setFilter] = useState("ALL");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [lastConfirmedAt, setLastConfirmedAt] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [confirmations, setConfirmations] = useState<Record<string, boolean>>({});
  const [acknowledgingId, setAcknowledgingId] = useState<string | null>(null);
  const loadVersion = useRef(0);

  function focusTab(index: number) {
    const tab = document.querySelector<HTMLButtonElement>(`[data-notification-tab-index="${index}"]`);
    tab?.focus();
  }

  function handleTabKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    const key = event.key;
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(key)) return;
    event.preventDefault();
    const nextIndex = key === "Home" ? 0 : key === "End" ? notificationTabs.length - 1 : (index + (key === "ArrowRight" ? 1 : -1) + notificationTabs.length) % notificationTabs.length;
    const [nextFilter] = notificationTabs[nextIndex];
    setFilter(nextFilter);
    window.setTimeout(() => focusTab(nextIndex), 0);
  }

  const load = useCallback(async () => {
    const version = loadVersion.current + 1;
    loadVersion.current = version;
    setLoading(true);
    try {
      setError("");
      const nextItems = await apiFetch<Notification[]>(`/notifications?filter=${filter}`);
      if (loadVersion.current !== version) return;
      setItems(nextItems);
      setLastConfirmedAt(new Date().toISOString());
    } catch (cause) {
      if (loadVersion.current !== version) return;
      setError(getSafeErrorMessage(cause, "Não foi possível carregar as notificações."));
    } finally {
      if (loadVersion.current === version) setLoading(false);
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
    setAcknowledgingId(notification.id);
    try {
      await apiFetch(`/notifications/${notification.id}/acknowledge`, { method: "POST", body: JSON.stringify({ expectedVersion: notification.version, reason, confirm: true }) });
      await load();
    } catch (cause) {
      setError(getSafeErrorMessage(cause, "Não foi possível confirmar a notificação."));
    } finally {
      setAcknowledgingId(null);
    }
  }

  return <div className="notifications-page">
    <div className="page-heading"><div><p className="eyebrow">Comunicação interna</p><h1>Notificações <em>que encontram você.</em></h1><p className="page-lede">Cada item leva ao contexto autorizado e permanece na auditoria.</p></div></div>
    <div className="tabs" role="tablist" aria-label="Filtro de notificações">{notificationTabs.map(([value, label], index) => <button key={value} id={`notifications-tab-${value}`} data-notification-tab-index={index} role="tab" type="button" aria-controls="notifications-panel" aria-selected={filter === value} tabIndex={filter === value ? 0 : -1} className={filter === value ? "active" : ""} onClick={() => setFilter(value)} onKeyDown={(event) => handleTabKeyDown(event, index)}>{label}</button>)}</div>
    {error && items.length > 0 && <StaleNotice title="Notificações confirmadas; atualização falhou" message={error} lastConfirmedAt={lastConfirmedAt ? formatRelativeTime(lastConfirmedAt) : undefined} onRetry={load} retrying={loading} />}
    {error && items.length === 0 && <ErrorState title="Não foi possível carregar as notificações" message={error} onRetry={load} retrying={loading} />}
    <section className="panel inbox-panel" id="notifications-panel" role="tabpanel" aria-labelledby={`notifications-tab-${filter}`} tabIndex={-1}>
      {loading && items.length === 0 ? <LoadingState className="queue-loading" label="Carregando notificações" /> : items.length === 0 ? <EmptyState title="Nenhuma notificação nesta visão" message="Você está em dia no seu escopo." /> : items.map((item) => <article key={item.id} className={`inbox-row inbox-${item.category.toLowerCase()} ${item.state === "ACKNOWLEDGED" ? "is-acknowledged" : ""}`}>
        <span className={`notification-dot notification-${item.category.toLowerCase()}`} />
        <div><p className="inbox-meta">{item.category === "CRITICAL" ? "CRÍTICA" : item.category === "ACTIONABLE" ? "AÇÃO NECESSÁRIA" : "INFORMATIVA"} · {formatRelativeTime(item.createdAt)}</p><h2>{item.title}</h2><p>{item.body}</p></div>
        <div className="inbox-actions">
          <Link href={item.deepLink} className="button button-ghost">Abrir contexto <Icon name="arrow-right" size={15} /></Link>
          <NotificationActions item={item} reason={reasons[item.id] ?? ""} confirmed={confirmations[item.id] === true} pending={acknowledgingId === item.id} blocked={acknowledgingId !== null && acknowledgingId !== item.id} onReasonChange={(value) => setReasons((current) => ({ ...current, [item.id]: value }))} onConfirmationChange={(value) => setConfirmations((current) => ({ ...current, [item.id]: value }))} onAcknowledge={() => void acknowledge(item)} />
        </div>
      </article>)}
    </section>
  </div>;
}
