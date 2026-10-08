import { describe, expect, it } from "vitest";
import type { Notification, NotificationChannelDelivery } from "../domain/models";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { recordWhatsAppStatuses, type WhatsAppDeliveryReport } from "./whatsapp-delivery-status";

const MID = "wamid.TARGET";

function notification(id: string, whatsapp?: NotificationChannelDelivery): Notification {
  return { id, category: "CRITICAL", priority: "URGENT", recipientUserId: "user-vet", entityType: "REQUEST", entityId: "req-1", deepLink: "/requests/req-1", title: "Critical", body: "Body", dedupeKey: `dedupe-${id}`, state: "DELIVERED", createdAt: "2026-10-08T10:00:00.000Z", attempts: 0, version: 4, ...(whatsapp ? { whatsapp } : {}) };
}

async function setup(initial: NotificationChannelDelivery["status"] = "SENT", messageId = MID) {
  const store = new MemoryStore(createDemoState("test-password-2026"));
  await store.transaction((state) => ({
    state: {
      ...state,
      notifications: [
        ...state.notifications,
        notification("n-target", { status: initial, updatedAt: "2026-10-08T10:00:00.000Z", ...(messageId ? { messageId } : {}) }),
        notification("n-other", { status: "SENT", updatedAt: "2026-10-08T10:00:00.000Z", messageId: "wamid.OTHER" }),
        notification("n-none")
      ]
    },
    result: undefined
  }));
  const target = () => store.getState().notifications.find((entry) => entry.id === "n-target")!;
  const other = () => store.getState().notifications.find((entry) => entry.id === "n-other")!;
  return { store, target, other };
}

const report = (status: WhatsAppDeliveryReport["status"], occurredAt = "2026-10-08T11:00:00.000Z", extra: Partial<WhatsAppDeliveryReport> = {}): WhatsAppDeliveryReport => ({ messageId: MID, status, occurredAt, ...extra });

describe("recordWhatsAppStatuses", () => {
  it("returns 0 and does not write for no reports", async () => {
    const { store } = await setup();
    const before = store.getState();
    expect(await recordWhatsAppStatuses(store, [], "corr")).toBe(0);
    expect(store.getState()).toStrictEqual(before);
  });

  it("returns 0 and does not write for unknown message ids", async () => {
    const { store } = await setup();
    const before = store.getState();
    expect(await recordWhatsAppStatuses(store, [{ ...report("delivered"), messageId: "wamid.UNKNOWN" }], "corr")).toBe(0);
    expect(store.getState()).toStrictEqual(before);
  });

  it("moves forward from SENT to DELIVERED to READ, auditing each step", async () => {
    const { store, target } = await setup();
    expect(await recordWhatsAppStatuses(store, [report("delivered", "2026-10-08T11:00:00.000Z")], "corr-d")).toBe(1);
    expect(target().whatsapp).toEqual({ status: "DELIVERED", updatedAt: "2026-10-08T11:00:00.000Z", messageId: MID });
    expect(await recordWhatsAppStatuses(store, [report("read", "2026-10-08T12:00:00.000Z")], "corr-r")).toBe(1);
    expect(target().whatsapp).toEqual({ status: "READ", updatedAt: "2026-10-08T12:00:00.000Z", messageId: MID });
    const audits = store.getState().auditEvents.filter((event) => event.entityId === "n-target");
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({ eventType: "CriticalAlertWhatsAppDelivered", entityType: "Notification", previousState: "SENT", newState: "DELIVERED", correlationId: "corr-d", metadata: { channel: "WHATSAPP" } });
    expect(audits[1]).toMatchObject({ eventType: "CriticalAlertWhatsAppRead", entityType: "Notification", previousState: "DELIVERED", newState: "READ", correlationId: "corr-r", metadata: { channel: "WHATSAPP" } });
  });

  it("advances QUEUED to SENT without writing an audit event", async () => {
    const { store, target } = await setup("QUEUED");
    const auditsBefore = store.getState().auditEvents.length;
    expect(await recordWhatsAppStatuses(store, [report("sent")], "corr")).toBe(1);
    expect(target().whatsapp?.status).toBe("SENT");
    expect(store.getState().auditEvents).toHaveLength(auditsBefore);
  });

  it("ignores regressions and duplicates", async () => {
    const { store, target } = await setup();
    await recordWhatsAppStatuses(store, [report("read")], "corr");
    const afterRead = store.getState();
    expect(await recordWhatsAppStatuses(store, [report("delivered"), report("sent"), report("read")], "corr")).toBe(0);
    expect(store.getState()).toStrictEqual(afterRead);
    expect(target().whatsapp?.status).toBe("READ");
  });

  it("applies failed from QUEUED and SENT with a prefixed error code", async () => {
    for (const initial of ["QUEUED", "SENT"] as const) {
      const { store, target } = await setup(initial);
      expect(await recordWhatsAppStatuses(store, [report("failed", "2026-10-08T11:00:00.000Z", { errorCode: 131047 })], "corr-f")).toBe(1);
      expect(target().whatsapp).toEqual({ status: "FAILED", updatedAt: "2026-10-08T11:00:00.000Z", messageId: MID, errorCode: "WHATSAPP_API_131047" });
      expect(store.getState().auditEvents.at(-1)).toMatchObject({ eventType: "CriticalAlertWhatsAppFailed", entityType: "Notification", entityId: "n-target", previousState: initial, newState: "FAILED", correlationId: "corr-f", metadata: { channel: "WHATSAPP", errorCode: "WHATSAPP_API_131047" } });
    }
  });

  it("stores no error code when the failure report has none", async () => {
    const { store, target } = await setup();
    await recordWhatsAppStatuses(store, [report("failed")], "corr");
    expect(target().whatsapp).toEqual({ status: "FAILED", updatedAt: "2026-10-08T11:00:00.000Z", messageId: MID });
    expect(store.getState().auditEvents.at(-1)!.metadata).toEqual({ channel: "WHATSAPP" });
  });

  it("keeps an error code of zero", async () => {
    const { store, target } = await setup();
    await recordWhatsAppStatuses(store, [report("failed", undefined, { errorCode: 0 })], "corr");
    expect(target().whatsapp?.errorCode).toBe("WHATSAPP_API_0");
  });

  it("ignores failed after DELIVERED or READ", async () => {
    for (const status of ["DELIVERED", "READ"] as const) {
      const { store, target } = await setup(status);
      const before = store.getState();
      expect(await recordWhatsAppStatuses(store, [report("failed", undefined, { errorCode: 1 })], "corr")).toBe(0);
      expect(store.getState()).toStrictEqual(before);
      expect(target().whatsapp?.status).toBe(status);
    }
  });

  it("treats FAILED as final", async () => {
    const { store, target } = await setup("FAILED");
    for (const status of ["sent", "delivered", "read", "failed"] as const) {
      expect(await recordWhatsAppStatuses(store, [report(status)], "corr")).toBe(0);
    }
    expect(target().whatsapp?.status).toBe("FAILED");
  });

  it("does not touch a SKIPPED or message-less delivery", async () => {
    const { store, target } = await setup("SKIPPED", "");
    expect(await recordWhatsAppStatuses(store, [report("delivered")], "corr")).toBe(0);
    expect(target().whatsapp?.status).toBe("SKIPPED");
  });

  it("applies several reports for the same message in order and counts each change", async () => {
    const { store, target } = await setup("QUEUED");
    const applied = await recordWhatsAppStatuses(store, [report("sent", "2026-10-08T11:00:00.000Z"), report("read", "2026-10-08T11:02:00.000Z"), report("delivered", "2026-10-08T11:01:00.000Z"), report("failed")], "corr");
    expect(applied).toBe(2);
    expect(target().whatsapp).toEqual({ status: "READ", updatedAt: "2026-10-08T11:02:00.000Z", messageId: MID });
    expect(store.getState().auditEvents.filter((event) => event.entityId === "n-target").map((event) => event.eventType)).toEqual(["CriticalAlertWhatsAppRead"]);
  });

  it("changes only the matching notification and never bumps versions", async () => {
    const { store, target, other } = await setup();
    const otherBefore = other();
    const none = store.getState().notifications.find((entry) => entry.id === "n-none")!;
    await recordWhatsAppStatuses(store, [report("delivered")], "corr");
    expect(target().version).toBe(4);
    expect(other()).toEqual(otherBefore);
    expect(store.getState().notifications.find((entry) => entry.id === "n-none")).toEqual(none);
  });

  it("updates two notifications from one batch of reports", async () => {
    const { store, target, other } = await setup();
    const applied = await recordWhatsAppStatuses(store, [report("delivered"), { messageId: "wamid.OTHER", status: "read", occurredAt: "2026-10-08T11:30:00.000Z" }], "corr");
    expect(applied).toBe(2);
    expect(target().whatsapp?.status).toBe("DELIVERED");
    expect(other().whatsapp).toMatchObject({ status: "READ", messageId: "wamid.OTHER" });
  });
});
