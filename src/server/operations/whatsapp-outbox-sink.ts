import type { OutboxMessage, StateStore } from "../domain/models";
import { findById } from "../domain/state-index";
import type { OutboxDeliveryConfirmation, OutboxSink } from "./outbox";
import { isWhatsAppRoute } from "./outbox";
import { sendCriticalAlertTemplate, WhatsAppSendError, type CriticalAlertTemplateInput, type WhatsAppCloudConfig, type WhatsAppSendResult } from "./whatsapp-cloud-api";

/** Decided when the message is sent, not when it was queued: consent can be withdrawn and the alert acknowledged meanwhile. */
export type WhatsAppAlertTarget = { phone: string } | { skip: "NO_CONTACT" | "SETTLED" };
export type WhatsAppAlertResolver = (notificationId: string, recipientUserId: string) => Promise<WhatsAppAlertTarget>;
type Send = (config: WhatsAppCloudConfig, input: CriticalAlertTemplateInput) => Promise<WhatsAppSendResult>;

/** Refusals about this recipient's number settle the message: retrying or reprocessing cannot fix them. */
const RECIPIENT_REFUSALS = new Set(["WHATSAPP_API_131026", "WHATSAPP_RECIPIENT_INVALID"]);

export function createWhatsAppAlertResolver(store: StateStore): WhatsAppAlertResolver {
  return async (notificationId, recipientUserId) => {
    const state = await store.readState();
    const notification = findById(state.notifications, notificationId);
    if (!notification || notification.recipientUserId !== recipientUserId || ["ACKNOWLEDGED", "SUPERSEDED"].includes(notification.state)) return { skip: "SETTLED" };
    const recipient = findById(state.users, recipientUserId);
    if (!recipient?.active || !recipient.whatsappPhone || !recipient.whatsappConsentAt) return { skip: "NO_CONTACT" };
    return { phone: recipient.whatsappPhone };
  };
}

function text(payload: OutboxMessage["payload"], key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || !value.trim()) throw new Error("WHATSAPP_PAYLOAD_INVALID");
  return value;
}

function confirmation(deliveryId: string, channel: NonNullable<OutboxDeliveryConfirmation["channel"]>): OutboxDeliveryConfirmation {
  return { confirmed: true, durability: "DURABLE", sink: "whatsapp", deliveryId, channel };
}

/**
 * PROD-402: sends the approved critical-alert template. Without configuration (WHATSAPP_ENABLED is not
 * "true") queued alerts are settled as skipped instead of piling up behind a disabled channel.
 */
export function createWhatsAppOutboxSink(config: WhatsAppCloudConfig | undefined, resolve: WhatsAppAlertResolver, send: Send = sendCriticalAlertTemplate): OutboxSink {
  return {
    supportsRoute: isWhatsAppRoute,
    async publish(message): Promise<OutboxDeliveryConfirmation> {
      const notificationId = text(message.payload, "notificationId");
      const recipientUserId = text(message.payload, "recipientUserId");
      const requestCode = text(message.payload, "requestCode");
      const linkPath = text(message.payload, "linkPath");
      if (!config) return confirmation(`whatsapp-skipped:${message.id}`, { status: "SKIPPED", errorCode: "CHANNEL_DISABLED" });
      const target = await resolve(notificationId, recipientUserId);
      if ("skip" in target) return confirmation(`whatsapp-skipped:${message.id}`, { status: "SKIPPED", errorCode: target.skip });
      try {
        const { messageId } = await send(config, { to: target.phone, requestCode, linkPath });
        return confirmation(messageId, { status: "SENT", messageId });
      } catch (error) {
        if (error instanceof WhatsAppSendError && RECIPIENT_REFUSALS.has(error.code)) {
          return confirmation(`whatsapp-refused:${message.id}`, { status: "FAILED", errorCode: error.code });
        }
        throw error;
      }
    }
  };
}
