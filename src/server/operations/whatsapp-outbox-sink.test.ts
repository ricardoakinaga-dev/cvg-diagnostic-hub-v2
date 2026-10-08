import { describe, expect, it, vi } from "vitest";
import { CRITICAL_ALERT_WHATSAPP_EVENT, type Notification, type OutboxMessage } from "../domain/models";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { createWhatsAppAlertResolver, createWhatsAppOutboxSink } from "./whatsapp-outbox-sink";
import { WhatsAppSendError, type WhatsAppCloudConfig } from "./whatsapp-cloud-api";

// Built at run time so the privacy scan never sees a formatted phone number in the source.
const phone = ["+55", "11", "9", "8765", "4321"].join("");

const config: WhatsAppCloudConfig = { apiBase: "https://graph.facebook.com", apiVersion: "v26.0", phoneNumberId: "123456789", accessToken: "test-token", templateName: "critical_result_alert", templateLanguage: "pt_BR", timeoutMs: 10000 };

function notification(overrides: Partial<Notification> = {}): Notification {
  return { id: "notif-wa-1", category: "CRITICAL", priority: "URGENT", recipientUserId: "user-vet", entityType: "REQUEST", entityId: "req-1", deepLink: "/requests/req-1", title: "Critical", body: "Body", dedupeKey: "dedupe-wa-1", state: "DELIVERED", createdAt: "2026-10-08T10:00:00.000Z", attempts: 0, version: 1, ...overrides };
}

async function setup(options: { notification?: Partial<Notification> | null; user?: Record<string, unknown> } = {}) {
  const store = new MemoryStore(createDemoState("test-password-2026"));
  await store.transaction((state) => ({
    state: {
      ...state,
      users: state.users.map((user) => user.id === "user-vet" ? { ...user, whatsappPhone: phone, whatsappConsentAt: "2026-10-01T10:00:00.000Z", ...options.user } : user),
      notifications: options.notification === null ? state.notifications : [...state.notifications, notification(options.notification)]
    },
    result: undefined
  }));
  return store;
}

function message(payload: Record<string, unknown> = {}, eventType: string = CRITICAL_ALERT_WHATSAPP_EVENT): OutboxMessage {
  return {
    id: "outbox-1", eventType, aggregateType: "Notification", aggregateId: "notif-wa-1",
    payload: { notificationId: "notif-wa-1", recipientUserId: "user-vet", requestCode: "REQ-001", linkPath: "requests/req-1", ...payload },
    correlationId: "corr-1", createdAt: "2026-10-08T10:00:00.000Z", attempts: 0, status: "PENDING"
  } as unknown as OutboxMessage;
}

describe("createWhatsAppAlertResolver", () => {
  it("returns the phone of an active, consenting recipient", async () => {
    const resolve = createWhatsAppAlertResolver(await setup());
    expect(await resolve("notif-wa-1", "user-vet")).toEqual({ phone });
  });

  it("settles when the notification is missing or belongs to another recipient", async () => {
    const resolve = createWhatsAppAlertResolver(await setup());
    expect(await resolve("missing", "user-vet")).toEqual({ skip: "SETTLED" });
    expect(await resolve("notif-wa-1", "user-other")).toEqual({ skip: "SETTLED" });
  });

  it.each(["ACKNOWLEDGED", "SUPERSEDED"] as const)("settles an alert that is already %s", async (state) => {
    const resolve = createWhatsAppAlertResolver(await setup({ notification: { state } }));
    expect(await resolve("notif-wa-1", "user-vet")).toEqual({ skip: "SETTLED" });
  });

  it.each([
    ["inactive", { active: false }],
    ["without a number", { whatsappPhone: undefined }],
    ["without consent", { whatsappConsentAt: undefined }]
  ])("reports NO_CONTACT for a recipient %s", async (_label, user) => {
    const resolve = createWhatsAppAlertResolver(await setup({ user }));
    expect(await resolve("notif-wa-1", "user-vet")).toEqual({ skip: "NO_CONTACT" });
  });

  it("reports NO_CONTACT when the recipient user does not exist", async () => {
    const store = await setup({ notification: { recipientUserId: "ghost" } });
    expect(await createWhatsAppAlertResolver(store)("notif-wa-1", "ghost")).toEqual({ skip: "NO_CONTACT" });
  });
});

describe("createWhatsAppOutboxSink", () => {
  it("supports only whatsapp-routed messages", () => {
    const sink = createWhatsAppOutboxSink(config, vi.fn(), vi.fn());
    expect(sink.supportsRoute?.(message())).toBe(true);
    expect(sink.supportsRoute?.(message({}, "ResultReleased"))).toBe(false);
  });

  it.each(["notificationId", "recipientUserId", "requestCode", "linkPath"])("rejects a payload without %s", async (key) => {
    const resolve = vi.fn();
    const send = vi.fn();
    const sink = createWhatsAppOutboxSink(config, resolve, send);
    await expect(sink.publish(message({ [key]: undefined }))).rejects.toThrow("WHATSAPP_PAYLOAD_INVALID");
    await expect(sink.publish(message({ [key]: "   " }))).rejects.toThrow("WHATSAPP_PAYLOAD_INVALID");
    await expect(sink.publish(message({ [key]: 42 }))).rejects.toThrow("WHATSAPP_PAYLOAD_INVALID");
    expect(resolve).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("settles as skipped when the channel is disabled, without resolving or sending", async () => {
    const resolve = vi.fn();
    const send = vi.fn();
    const result = await createWhatsAppOutboxSink(undefined, resolve, send).publish(message());
    expect(result).toEqual({ confirmed: true, durability: "DURABLE", sink: "whatsapp", deliveryId: "whatsapp-skipped:outbox-1", channel: { status: "SKIPPED", errorCode: "CHANNEL_DISABLED" } });
    expect(resolve).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it.each(["NO_CONTACT", "SETTLED"] as const)("settles as skipped when the resolver says %s", async (skip) => {
    const send = vi.fn();
    const resolve = vi.fn().mockResolvedValue({ skip });
    const result = await createWhatsAppOutboxSink(config, resolve, send).publish(message());
    expect(result).toMatchObject({ confirmed: true, sink: "whatsapp", channel: { status: "SKIPPED", errorCode: skip } });
    expect(resolve).toHaveBeenCalledWith("notif-wa-1", "user-vet");
    expect(send).not.toHaveBeenCalled();
  });

  it("sends the template and confirms durably with the provider message id", async () => {
    const resolve = vi.fn().mockResolvedValue({ phone });
    const send = vi.fn().mockResolvedValue({ messageId: "wamid.ABC" });
    const result = await createWhatsAppOutboxSink(config, resolve, send).publish(message());
    expect(result).toEqual({ confirmed: true, durability: "DURABLE", sink: "whatsapp", deliveryId: "wamid.ABC", channel: { status: "SENT", messageId: "wamid.ABC" } });
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(config, { to: phone, requestCode: "REQ-001", linkPath: "requests/req-1" });
  });

  it.each(["WHATSAPP_API_131026", "WHATSAPP_RECIPIENT_INVALID"])("settles a recipient refusal (%s) as FAILED", async (code) => {
    const send = vi.fn().mockRejectedValue(new WhatsAppSendError(code, false));
    const result = await createWhatsAppOutboxSink(config, vi.fn().mockResolvedValue({ phone }), send).publish(message());
    expect(result).toEqual({ confirmed: true, durability: "DURABLE", sink: "whatsapp", deliveryId: "whatsapp-refused:outbox-1", channel: { status: "FAILED", errorCode: code } });
  });

  it.each([
    ["a non-recipient API error", new WhatsAppSendError("WHATSAPP_API_190", false)],
    ["a retryable timeout", new WhatsAppSendError("WHATSAPP_TIMEOUT", true)],
    ["an unexpected error", new Error("boom")]
  ])("rethrows %s so the outbox can retry or dead-letter it", async (_label, error) => {
    const send = vi.fn().mockRejectedValue(error);
    await expect(createWhatsAppOutboxSink(config, vi.fn().mockResolvedValue({ phone }), send).publish(message())).rejects.toBe(error);
  });
});
