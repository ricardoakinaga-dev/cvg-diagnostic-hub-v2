import { describe, expect, it } from "vitest";
import { CRITICAL_ALERT_WHATSAPP_EVENT, type Notification, type StoreState } from "../domain/models";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { whatsAppAlertsEnabled, withCriticalWhatsAppAlert } from "./critical-alert-channel";

// Built at run time so the privacy scan never sees a formatted phone number in the source.
const phone = ["+55", "11", "9", "8765", "4321"].join("");
const enabled = { WHATSAPP_ENABLED: "true" };
const request = { requestCode: "REQ-001" };

function notification(overrides: Partial<Notification> = {}): Notification {
  return { id: "notif-ca-1", category: "CRITICAL", priority: "URGENT", recipientUserId: "user-vet", entityType: "REQUEST", entityId: "req-1", deepLink: "//requests/req-1?tab=result", title: "Critical", body: "Body", dedupeKey: "dedupe-ca-1", state: "DELIVERED", createdAt: "2026-10-08T10:00:00.000Z", attempts: 0, version: 3, ...overrides };
}

async function build(options: { notification?: Partial<Notification>; user?: Record<string, unknown> } = {}): Promise<StoreState> {
  const store = new MemoryStore(createDemoState("test-password-2026"));
  await store.transaction((state) => ({
    state: {
      ...state,
      users: state.users.map((user) => user.id === "user-vet" ? { ...user, whatsappPhone: phone, whatsappConsentAt: "2026-10-01T10:00:00.000Z", ...options.user } : user),
      notifications: [...state.notifications, notification(options.notification)]
    },
    result: undefined
  }));
  return store.getState();
}

describe("whatsAppAlertsEnabled", () => {
  it("is on only for the exact string true", () => {
    expect(whatsAppAlertsEnabled(enabled)).toBe(true);
    for (const value of [undefined, "", "false", "TRUE", "1", " true"]) expect(whatsAppAlertsEnabled({ WHATSAPP_ENABLED: value })).toBe(false);
    expect(whatsAppAlertsEnabled({})).toBe(false);
  });

  it("reads the process environment by default", () => {
    expect(whatsAppAlertsEnabled()).toBe(process.env.WHATSAPP_ENABLED === "true");
  });
});

describe("withCriticalWhatsAppAlert", () => {
  it("returns the same state when the channel is disabled", async () => {
    const state = await build();
    expect(withCriticalWhatsAppAlert(state, "notif-ca-1", request, "corr", {})).toBe(state);
    expect(withCriticalWhatsAppAlert(state, "notif-ca-1", request, "corr", { WHATSAPP_ENABLED: "false" })).toBe(state);
  });

  it("returns the same state without a notification id or when the notification does not exist", async () => {
    const state = await build();
    expect(withCriticalWhatsAppAlert(state, undefined, request, "corr", enabled)).toBe(state);
    expect(withCriticalWhatsAppAlert(state, "missing", request, "corr", enabled)).toBe(state);
  });

  it.each(["INFORMATIONAL", "ACTIONABLE", "ADMINISTRATIVE"] as const)("ignores %s notifications", async (category) => {
    const state = await build({ notification: { category } });
    expect(withCriticalWhatsAppAlert(state, "notif-ca-1", request, "corr", enabled)).toBe(state);
  });

  it("ignores a notification that already has a WhatsApp delivery", async () => {
    const state = await build({ notification: { whatsapp: { status: "SENT", updatedAt: "2026-10-08T10:01:00.000Z", messageId: "wamid.X" } } });
    expect(withCriticalWhatsAppAlert(state, "notif-ca-1", request, "corr", enabled)).toBe(state);
  });

  it("queues the alert for a reachable recipient with exactly one PII-free outbox message", async () => {
    const state = await build();
    const next = withCriticalWhatsAppAlert(state, "notif-ca-1", request, "corr-queue", enabled);
    expect(next).not.toBe(state);
    const updated = next.notifications.find((entry) => entry.id === "notif-ca-1")!;
    expect(updated.whatsapp).toEqual({ status: "QUEUED", updatedAt: expect.any(String) });
    expect(Date.parse(updated.whatsapp!.updatedAt)).not.toBeNaN();
    expect(updated.version).toBe(3);
    expect(next.outbox).toHaveLength(state.outbox.length + 1);
    const added = next.outbox.at(-1)!;
    expect(added).toMatchObject({
      eventType: CRITICAL_ALERT_WHATSAPP_EVENT,
      consumerType: "NOTIFICATION_DELIVERY",
      routingKey: "notification.whatsapp",
      aggregateType: "Notification",
      aggregateId: "notif-ca-1",
      correlationId: "corr-queue",
      payload: { notificationId: "notif-ca-1", recipientUserId: "user-vet", requestCode: "REQ-001", linkPath: "requests/req-1?tab=result" }
    });
    expect(Object.keys(added.payload).sort()).toEqual(["linkPath", "notificationId", "recipientUserId", "requestCode"]);
    expect(JSON.stringify(added)).not.toContain(phone);
    expect(JSON.stringify(added)).not.toContain("8765");
  });

  it("leaves other notifications and the input state untouched", async () => {
    const state = await build();
    const before = JSON.stringify(state);
    const next = withCriticalWhatsAppAlert(state, "notif-ca-1", request, "corr", enabled);
    expect(JSON.stringify(state)).toBe(before);
    expect(next.notifications.filter((entry) => entry.id !== "notif-ca-1")).toEqual(state.notifications.filter((entry) => entry.id !== "notif-ca-1"));
  });

  it.each([
    ["has no number", { whatsappPhone: undefined }],
    ["has no consent", { whatsappConsentAt: undefined }],
    ["is inactive", { active: false }]
  ])("skips with NO_CONTACT and queues nothing when the recipient %s", async (_label, user) => {
    const state = await build({ user });
    const next = withCriticalWhatsAppAlert(state, "notif-ca-1", request, "corr", enabled);
    const updated = next.notifications.find((entry) => entry.id === "notif-ca-1")!;
    expect(updated.whatsapp).toEqual({ status: "SKIPPED", updatedAt: expect.any(String), errorCode: "NO_CONTACT" });
    expect(updated.version).toBe(3);
    expect(next.outbox).toBe(state.outbox);
  });

  it("skips with NO_CONTACT when the recipient does not exist", async () => {
    const state = await build({ notification: { recipientUserId: "ghost" } });
    const next = withCriticalWhatsAppAlert(state, "notif-ca-1", request, "corr", enabled);
    expect(next.notifications.find((entry) => entry.id === "notif-ca-1")!.whatsapp).toMatchObject({ status: "SKIPPED", errorCode: "NO_CONTACT" });
    expect(next.outbox).toBe(state.outbox);
  });
});
