import { CRITICAL_ALERT_WHATSAPP_EVENT, type DiagnosticRequest, type StoreState } from "../domain/models";
import { findById } from "../domain/state-index";
import { createOutbox, now } from "./service-common";

export function whatsAppAlertsEnabled(environment: Partial<NodeJS.ProcessEnv> = process.env): boolean {
  return environment.WHATSAPP_ENABLED === "true";
}

/**
 * PROD-402 (D3): a critical notification is also sent over WhatsApp when the recipient registered a
 * number with consent. The message carries the request protocol and the Hub link, never clinical data;
 * the number is resolved again when the worker sends it.
 */
export function withCriticalWhatsAppAlert(state: StoreState, notificationId: string | undefined, request: Pick<DiagnosticRequest, "requestCode">, correlationId: string, environment: Partial<NodeJS.ProcessEnv> = process.env): StoreState {
  if (!notificationId || !whatsAppAlertsEnabled(environment)) return state;
  const notification = findById(state.notifications, notificationId);
  if (!notification || notification.category !== "CRITICAL" || notification.whatsapp) return state;
  const recipient = findById(state.users, notification.recipientUserId);
  const reachable = Boolean(recipient?.active && recipient.whatsappPhone && recipient.whatsappConsentAt);
  const updatedAt = now();
  const whatsapp = reachable ? { status: "QUEUED" as const, updatedAt } : { status: "SKIPPED" as const, updatedAt, errorCode: "NO_CONTACT" };
  return {
    ...state,
    notifications: state.notifications.map((entry) => entry.id === notification.id ? { ...entry, whatsapp } : entry),
    outbox: reachable
      ? [...state.outbox, createOutbox(CRITICAL_ALERT_WHATSAPP_EVENT, "Notification", notification.id, correlationId, { notificationId: notification.id, recipientUserId: notification.recipientUserId, requestCode: request.requestCode, linkPath: notification.deepLink.replace(/^\/+/, "") })]
      : state.outbox
  };
}
