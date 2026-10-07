"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Notification } from "@cvg/contracts";
import { ActionButton } from "@cvg/ui";
import { apiFetch, formatRelativeTime, getSafeErrorMessage } from "./api-client";
import { EmptyState, ErrorState, LoadingState, StaleNotice } from "./feedback-states";
import { Icon } from "./ui-icons";
import { PageHeader } from "./page-header";

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
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
      window.dispatchEvent(new Event("cvg:notifications-changed"));
    } catch (cause) {
      setError(getSafeErrorMessage(cause, "Não foi possível confirmar a notificação."));
    } finally {
      setAcknowledgingId(null);
    }
  }

  const selected = items.find((item) => item.id === selectedId) ?? null;
  // Like Plane's inbox, the first item opens by default on wide screens.
  useEffect(() => {
    if (selected || items.length === 0 || (typeof window.matchMedia === "function" && window.matchMedia("(max-width: 960px)").matches)) return;
    const timer = window.setTimeout(() => setSelectedId(items[0].id), 0);
    return () => window.clearTimeout(timer);
  }, [items, selected]);
  const categoryLabel = (item: Notification) => item.category === "CRITICAL" ? "Crítica" : item.category === "ACTIONABLE" ? "Ação necessária" : item.category === "ADMINISTRATIVE" ? "Administrativa" : "Informativa";
  const categoryTone = (item: Notification) => item.category === "CRITICAL" ? "critical" : item.category === "ACTIONABLE" ? "actionable" : "info";
  const isUnread = (item: Notification) => item.state !== "ACKNOWLEDGED" && item.state !== "SUPERSEDED";

  return <>
    <PageHeader crumbs={[{ label: "Caixa de entrada", icon: "inbox" }]} count={loading && items.length === 0 ? undefined : items.length}>
      <button type="button" className="icon-button header-refresh" onClick={() => void load()} aria-label="Atualizar notificações" title="Atualizar"><Icon name="refresh" size={14} className={loading ? "spin" : undefined} /></button>
    </PageHeader>
    {error && items.length > 0 && <div className="page-body page-body-tight"><StaleNotice title="Notificações confirmadas; atualização falhou" message={error} lastConfirmedAt={lastConfirmedAt ? formatRelativeTime(lastConfirmedAt) : undefined} onRetry={load} retrying={loading} /></div>}
    <div className={`inbox${selected ? " has-selection" : ""}`}>
      <div className="inbox-list">
        <div className="inbox-tabs" role="tablist" aria-label="Filtro de notificações">{notificationTabs.map(([value, label], index) => <button key={value} id={`notifications-tab-${value}`} data-notification-tab-index={index} role="tab" type="button" aria-controls="notifications-panel" aria-selected={filter === value} tabIndex={filter === value ? 0 : -1} className={filter === value ? "active" : ""} onClick={() => setFilter(value)} onKeyDown={(event) => handleTabKeyDown(event, index)}>{label}</button>)}</div>
        <section id="notifications-panel" role="tabpanel" aria-labelledby={`notifications-tab-${filter}`} tabIndex={-1}>
          {error && items.length === 0 && <div className="page-body-tight"><ErrorState title="Não foi possível carregar as notificações" message={error} onRetry={load} retrying={loading} /></div>}
          {loading && items.length === 0 ? <LoadingState className="queue-loading" label="Carregando notificações" /> : items.length === 0 && !error ? <EmptyState title="Nenhuma notificação nesta visão" message="Você está em dia no seu escopo." /> : items.map((item) => <button key={item.id} type="button" className={`inbox-item${selectedId === item.id ? " is-active" : ""}${isUnread(item) ? " is-unread" : ""}`} aria-current={selectedId === item.id ? "true" : undefined} onClick={() => setSelectedId(item.id)}>
            <span className="inbox-unread-dot" aria-hidden="true" />
            <span className={`inbox-icon tone-${categoryTone(item)}`} aria-hidden="true"><Icon name={item.category === "CRITICAL" ? "attention" : item.category === "ACTIONABLE" ? "arrow-right" : "notifications"} size={14} /></span>
            <span className="inbox-item-copy"><strong>{item.title}</strong><span>{item.body}</span><time dateTime={item.createdAt}>{categoryLabel(item)} · {formatRelativeTime(item.createdAt)}</time></span>
          </button>)}
        </section>
      </div>
      <section className="inbox-detail" aria-label="Notificação selecionada">
        {selected ? <article>
          <button type="button" className="header-button mobile-only-inline" onClick={() => setSelectedId(null)}><Icon name="arrow-left" size={13} />Voltar</button>
          <div className="inbox-detail-meta"><span className={`inbox-icon tone-${categoryTone(selected)}`} aria-hidden="true"><Icon name={selected.category === "CRITICAL" ? "attention" : "notifications"} size={14} /></span><span>{categoryLabel(selected)}</span><span>·</span><time dateTime={selected.createdAt}>{formatRelativeTime(selected.createdAt)}</time>{selected.priority !== "NORMAL" && <span className="pill pill-danger"><span>{selected.priority === "URGENT" ? "Urgente" : "Alta"}</span></span>}</div>
          <h2>{selected.title}</h2>
          <p>{selected.body}</p>
          <div className="inbox-detail-actions"><Link href={selected.deepLink} className="button button-primary">Abrir contexto <Icon name="arrow-right" size={15} /></Link></div>
          <div className="inbox-ack">
            <NotificationActions item={selected} reason={reasons[selected.id] ?? ""} confirmed={confirmations[selected.id] === true} pending={acknowledgingId === selected.id} blocked={acknowledgingId !== null && acknowledgingId !== selected.id} onReasonChange={(value) => setReasons((current) => ({ ...current, [selected.id]: value }))} onConfirmationChange={(value) => setConfirmations((current) => ({ ...current, [selected.id]: value }))} onAcknowledge={() => void acknowledge(selected)} />
          </div>
        </article> : <div className="empty-panel"><span className="empty-panel-icon" aria-hidden="true"><Icon name="inbox" size={26} /></span><h2>Selecione uma notificação</h2><p>Os detalhes e a confirmação aparecem aqui.</p></div>}
      </section>
    </div>
  </>;
}
