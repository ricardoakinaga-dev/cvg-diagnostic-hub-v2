import type { AuditEvent, NotificationChannelDelivery, StateStore } from "../domain/models";
import { createAudit } from "./service-common";

/** A delivery report as parsed from Meta's webhook by the operations layer. */
export interface WhatsAppDeliveryReport {
  messageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  occurredAt: string;
  errorCode?: number;
}

const PROGRESS: Record<NotificationChannelDelivery["status"], number> = { SKIPPED: -1, QUEUED: 0, SENT: 1, FAILED: 1, DELIVERED: 2, READ: 3 };
const STATUS: Record<WhatsAppDeliveryReport["status"], NotificationChannelDelivery["status"]> = { sent: "SENT", delivered: "DELIVERED", read: "READ", failed: "FAILED" };
const EVENT: Partial<Record<NotificationChannelDelivery["status"], string>> = { DELIVERED: "CriticalAlertWhatsAppDelivered", READ: "CriticalAlertWhatsAppRead", FAILED: "CriticalAlertWhatsAppFailed" };

/**
 * PROD-402: Meta reports each message as sent, delivered, read or failed, in any order and possibly more
 * than once. A report only moves the alert forward; a failure is final and is ignored after delivery. Unknown message
 * ids (a report that arrives before the worker recorded the send, or from another sender) are dropped.
 * Like the send itself, the report annotates the notification without bumping its version.
 */
export async function recordWhatsAppStatuses(store: StateStore, updates: readonly WhatsAppDeliveryReport[], correlationId: string): Promise<number> {
  if (updates.length === 0) return 0;
  const reported = new Set(updates.map((update) => update.messageId));
  return store.transaction((state) => {
    const audits: AuditEvent[] = [];
    let applied = 0;
    const notifications = state.notifications.map((notification) => {
      const messageId = notification.whatsapp?.messageId;
      if (!messageId || !reported.has(messageId)) return notification;
      let whatsapp = notification.whatsapp!;
      for (const update of updates) {
        if (update.messageId !== messageId) continue;
        const status = STATUS[update.status];
        const regresses = whatsapp.status === "FAILED" || (status === "FAILED" ? PROGRESS[whatsapp.status] >= PROGRESS.DELIVERED : PROGRESS[status] <= PROGRESS[whatsapp.status]);
        if (regresses) continue;
        const previous = whatsapp.status;
        whatsapp = { status, updatedAt: update.occurredAt, messageId, ...(status === "FAILED" && update.errorCode !== undefined ? { errorCode: `WHATSAPP_API_${update.errorCode}` } : {}) };
        applied += 1;
        const eventType = EVENT[status];
        if (eventType) audits.push(createAudit(eventType, undefined, "Notification", notification.id, correlationId, previous, status, { channel: "WHATSAPP", ...(whatsapp.errorCode ? { errorCode: whatsapp.errorCode } : {}) }));
      }
      return whatsapp === notification.whatsapp ? notification : { ...notification, whatsapp };
    });
    if (applied === 0) return { state, result: 0 };
    return { state: { ...state, notifications, auditEvents: [...state.auditEvents, ...audits] }, result: applied };
  });
}
