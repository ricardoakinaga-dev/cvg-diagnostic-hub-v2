import { afterEach, describe, expect, it, vi } from "vitest";
import { CRITICAL_ALERT_WHATSAPP_EVENT } from "../domain/models";
import { InProcessEventBus, isWhatsAppRoute, processOutboxBatch, type OutboxSink } from "../operations/outbox";
import type { WhatsAppCloudConfig } from "../operations/whatsapp-cloud-api";
import { createWhatsAppAlertResolver, createWhatsAppOutboxSink } from "../operations/whatsapp-outbox-sink";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { updateOwnAlertContact } from "./alert-contact";
import { createApplicationService } from "./service";
import { recordWhatsAppStatuses } from "./whatsapp-delivery-status";

const phone = ["+55", "11", "9", "8765", "4321"].join("");
const config: WhatsAppCloudConfig = { apiBase: "https://graph.facebook.com", apiVersion: "v26.0", phoneNumberId: "123456789", accessToken: "test-token", templateName: "critical_result_alert", templateLanguage: "pt_BR", timeoutMs: 10_000 };

function approvePolicy(whatsapp: boolean) {
  vi.stubEnv("CRITICAL_POLICY_ENABLED", "true");
  vi.stubEnv("CRITICAL_POLICY_VERSION", "policy-v1");
  vi.stubEnv("CRITICAL_POLICY_APPROVAL_REF", "approval-test-1");
  vi.stubEnv("CRITICAL_POLICY_APPROVED_AT", "2026-08-20T10:00:00.000Z");
  vi.stubEnv("WHATSAPP_ENABLED", whatsapp ? "true" : "false");
}

async function releaseCritical(registerNumber: boolean) {
  const store = new MemoryStore(createDemoState());
  const service = createApplicationService(store);
  const vet = store.getState().users.find((user) => user.email === "vet@cvg.local")!;
  const lab = store.getState().users.find((user) => user.email === "lab@cvg.local")!;
  if (registerNumber) await updateOwnAlertContact(store, vet, { whatsappPhone: phone, consent: true }, "corr-contact");
  const request = await service.createRequest(vet, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-crp" }] }, { idempotencyKey: "wa-request" });
  const received = await service.receiveSample(lab, [request.items[0].id], { accessionCode: "ACC-WA-1", sampleType: "EDTA", expectedVersion: request.items[0].version, idempotencyKey: "wa-receive" });
  const started = await service.startProcessing(lab, request.items[0].id, { expectedVersion: received.items[0].version, idempotencyKey: "wa-start" });
  const draft = await service.createResultDraft(lab, request.items[0].id, { narrative: "Resultado sensível.", content: {}, conclusion: "Avaliar", expectedVersion: started.item.version, idempotencyKey: "wa-draft" });
  const released = await service.releaseResult(lab, draft.result.id, { critical: true, expectedVersion: draft.result.version, idempotencyKey: "wa-release" });
  const notification = store.getState().notifications.find((entry) => entry.category === "CRITICAL" && entry.entityId === released.version.id)!;
  return { store, service, vet, request, released, notification };
}

describe("critical result over WhatsApp (PROD-402)", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("queues the alert at release, sends it with protocol and link only, and follows Meta's reports", async () => {
    approvePolicy(true);
    const { store, service, vet, request, released, notification } = await releaseCritical(true);
    expect(notification.whatsapp).toMatchObject({ status: "QUEUED" });
    const queued = store.getState().outbox.find((message) => message.eventType === CRITICAL_ALERT_WHATSAPP_EVENT)!;
    expect(queued).toMatchObject({ routingKey: "notification.whatsapp", payload: { notificationId: notification.id, recipientUserId: vet.id, requestCode: request.requestCode, linkPath: `results/${released.result.id}` } });
    expect(JSON.stringify(queued)).not.toContain(phone);

    const send = vi.fn(async () => ({ messageId: "wamid.flow" }));
    const whatsapp = createWhatsAppOutboxSink(config, createWhatsAppAlertResolver(store), send);
    const bus = new InProcessEventBus();
    const sink: OutboxSink = { publish: (message) => isWhatsAppRoute(message) ? whatsapp.publish(message) : bus.publish(message) };
    await processOutboxBatch(store, sink, { now: () => new Date(Date.now() + 1_000), batchSize: 50, allowSyntheticDelivery: true });
    expect(send).toHaveBeenCalledWith(config, { to: phone, requestCode: request.requestCode, linkPath: `results/${released.result.id}` });

    const delivered = store.getState().notifications.find((entry) => entry.id === notification.id)!;
    expect(delivered).toMatchObject({ state: "DELIVERED", whatsapp: { status: "SENT", messageId: "wamid.flow" } });
    const reports = [{ messageId: "wamid.flow", status: "delivered" as const, occurredAt: "2026-10-08T12:00:01.000Z" }, { messageId: "wamid.flow", status: "read" as const, occurredAt: "2026-10-08T12:00:05.000Z" }];
    expect(await recordWhatsAppStatuses(store, reports, "corr-webhook")).toBe(2);
    expect(store.getState().notifications.find((entry) => entry.id === notification.id)).toMatchObject({ version: delivered.version, whatsapp: { status: "READ" } });

    // The redundant channel never bumps the version the recipient acknowledges against.
    await expect(service.acknowledgeNotification(vet, notification.id, { expectedVersion: delivered.version, reason: "Recebi o crítico.", confirm: true, idempotencyKey: "wa-ack" })).resolves.toMatchObject({ state: "ACKNOWLEDGED" });
  });

  it("does not send to a recipient who withdrew consent or acknowledged before the worker ran", async () => {
    approvePolicy(true);
    const { store, vet } = await releaseCritical(true);
    await updateOwnAlertContact(store, vet, { whatsappPhone: null }, "corr-withdraw");
    const send = vi.fn(async () => ({ messageId: "never" }));
    const whatsapp = createWhatsAppOutboxSink(config, createWhatsAppAlertResolver(store), send);
    const bus = new InProcessEventBus();
    await processOutboxBatch(store, { publish: (message) => isWhatsAppRoute(message) ? whatsapp.publish(message) : bus.publish(message) }, { now: () => new Date(Date.now() + 1_000), batchSize: 50, allowSyntheticDelivery: true });
    expect(send).not.toHaveBeenCalled();
    expect(store.getState().notifications.find((entry) => entry.category === "CRITICAL")).toMatchObject({ whatsapp: { status: "SKIPPED", errorCode: "NO_CONTACT" } });
  });

  it("records that the alert had no WhatsApp backup when the recipient has no number, and stays silent when the channel is off", async () => {
    approvePolicy(true);
    const withoutNumber = await releaseCritical(false);
    expect(withoutNumber.notification.whatsapp).toMatchObject({ status: "SKIPPED", errorCode: "NO_CONTACT" });
    expect(withoutNumber.store.getState().outbox.some((message) => message.eventType === CRITICAL_ALERT_WHATSAPP_EVENT)).toBe(false);

    approvePolicy(false);
    const disabled = await releaseCritical(true);
    expect(disabled.notification).not.toHaveProperty("whatsapp");
    expect(disabled.store.getState().outbox.some((message) => message.eventType === CRITICAL_ALERT_WHATSAPP_EVENT)).toBe(false);
  });
});
