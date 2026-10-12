import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { EXTERNAL_NOW } from "../../test/hospital-external-fixtures";
import { hospitalHisV4Fixture, hisV4Event, hisV4Signed, hisV4Catalog } from "../../test/hospital-his-v4-fixtures";
import { createHospitalHisV4Service } from "./hospital-his-v4-service";
import { systemGroupId } from "../security/access-group-policy";

describe("HIS v4 real-contract adapter", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(EXTERNAL_NOW); });
  afterEach(() => vi.useRealTimers());
  it("reads the actual advertised catalog and strips key IDs, operator endpoints and secret configuration", async () => {
    const c = await hospitalHisV4Fixture(); const catalog = await c.hisV4.getHospitalHisV4Catalog(c.user("user-admin")); expect(catalog).toMatchObject({ profile: "HIS_V4", accountId: "his_synthetic_account", deploymentVerified: false }); expect(catalog.advertised.map(entry => entry.family)).toEqual(["eventBus", "webhooks", "payments", "email", "sms", "googleCalendar", "laboratoryEquipmentBridge"]);
    expect(JSON.stringify(catalog)).not.toMatch(/apiKeyId|RESEND_API_KEY|internal\/events|Sintético/);
    const wrong = createHospitalHisV4Service(c.context, { config: () => c.config, discover: async () => ({ ...hisV4Catalog(), accountId: "other_account" }) }); await expect(wrong.getHospitalHisV4Catalog(c.user("user-admin"))).rejects.toMatchObject({ code: "HIS_V4_CATALOG_INVALID" });
  });
  it("fails closed for missing profile configuration, missing mappings and nonadopted events", async () => {
    const c = await hospitalHisV4Fixture(); const disabled = createHospitalHisV4Service(c.context, { config: () => undefined }); const raw = JSON.stringify(hisV4Event()); await expect(disabled.receiveHospitalHisV4Webhook(c.issued.credential.id, hisV4Signed(raw), raw)).rejects.toMatchObject({ status: 503 });
    c.config.webhook!.mappings.patients = [{ hisId: "another_patient", hubId: "patient-thor" }]; await expect(c.receive()).rejects.toMatchObject({ code: "HIS_V4_MAPPING_REQUIRED", status: 422 });
    const other = JSON.stringify({ ...hisV4Event(), event: "patient.created" }); await expect(c.hisV4.receiveHospitalHisV4Webhook(c.issued.credential.id, { ...hisV4Signed(other), event: "patient.created" }, other)).rejects.toMatchObject({ code: "HIS_V4_EVENT_NOT_ADOPTED" }); expect(c.store.getState().hospitalIntakes).toHaveLength(0);
    const wrongStatus = JSON.stringify({ ...hisV4Event(), data: { ...hisV4Event().data, status: "open" } }); await expect(c.hisV4.receiveHospitalHisV4Webhook(c.issued.credential.id, hisV4Signed(wrongStatus), wrongStatus)).rejects.toMatchObject({ code: "HIS_V4_EVENT_NOT_ADOPTED" });
  });
  it("creates only a native RECEIVED intake and deduplicates identical event across delivery IDs and webhook recreation", async () => {
    const c = await hospitalHisV4Fixture(); const raw = JSON.stringify(hisV4Event()); const received = await Promise.all([c.hisV4.receiveHospitalHisV4Webhook(c.issued.credential.id, hisV4Signed(raw, "delivery_a"), raw), c.hisV4.receiveHospitalHisV4Webhook(c.issued.credential.id, hisV4Signed(raw, "delivery_b"), raw)]); expect(received[0]).toEqual(received[1]);
    expect(c.store.getState().hospitalIntakes).toHaveLength(1); expect(c.store.getState().hospitalIntakes[0]).toMatchObject({ state: "RECEIVED", patientId: "patient-thor", encounterId: "encounter-thor", sourceLabel: "HIS_V4:encounter.created" }); expect(c.store.getState().hospitalTasks).toHaveLength(0); expect(c.store.getState().hospitalIntegrationMessages).toHaveLength(0);
    c.config.webhook!.webhookId = "recreated_webhook"; expect(await c.hisV4.receiveHospitalHisV4Webhook(c.issued.credential.id, { ...hisV4Signed(raw, "delivery_c"), webhookId: "recreated_webhook" }, raw)).toEqual(received[0]); expect(c.store.getState().hospitalHisV4Deliveries).toHaveLength(1);
    expect(JSON.stringify(received)).not.toMatch(/patient-thor|Demanda|payloadHash|mappingHash|sequence/); expect(JSON.stringify(c.store.getState().auditEvents.filter(entry => entry.entityType === "HospitalHisV4Delivery"))).not.toMatch(/Sintético|his_synthetic_owner/);
  });
  it("rejects collisions, changed mappings and repeated encounter creation under a different provider payload ID", async () => {
    const c = await hospitalHisV4Fixture(); await c.receive(); await expect(c.receive({ ...hisV4Event(), data: { ...hisV4Event().data, reason: "Changed" } })).rejects.toMatchObject({ status: 409 });
    c.config.webhook!.mappings.actions[0].title = "Other action title"; await expect(c.receive()).rejects.toMatchObject({ status: 409 }); c.config.webhook!.mappings.actions[0].title = "Demanda sintética HIS para triagem";
    const event = { ...hisV4Event(), id: "new_payload_identity" }; const raw = JSON.stringify(event); await expect(c.hisV4.receiveHospitalHisV4Webhook(c.issued.credential.id, hisV4Signed(raw, "new_delivery"), raw)).rejects.toMatchObject({ code: "HIS_V4_EVENT_CONFLICT" }); expect(c.store.getState().hospitalIntakes).toHaveLength(1);
  });
  it("validates timestamp v2, account and every delivery binding before any native mutation", async () => {
    const c = await hospitalHisV4Fixture(); const raw = JSON.stringify(hisV4Event()); const headers = hisV4Signed(raw);
    for (const invalid of [{ ...headers, signatureVersion: "v1" }, { ...headers, signature: "sha256=" + "0".repeat(64) }, hisV4Signed(raw, "stale", String(Math.floor(Date.now() / 1000) - 301)), hisV4Signed(raw, "future", String(Math.floor(Date.now() / 1000) + 301))]) await expect(c.hisV4.receiveHospitalHisV4Webhook(c.issued.credential.id, invalid, raw)).rejects.toMatchObject({ status: 401 });
    for (const invalid of [{ ...headers, webhookId: "wrong_webhook" }, { ...headers, idempotencyKey: "wrong_identity" }, { ...headers, event: "patient.created" }]) await expect(c.hisV4.receiveHospitalHisV4Webhook(c.issued.credential.id, invalid, raw)).rejects.toBeDefined();
    const otherAccount = JSON.stringify({ ...hisV4Event(), accountId: "other_account", data: { ...hisV4Event().data, accountId: "other_account" } }); await expect(c.hisV4.receiveHospitalHisV4Webhook(c.issued.credential.id, hisV4Signed(otherAccount), otherAccount)).rejects.toMatchObject({ status: 403 }); expect(c.store.getState().hospitalIntakes).toHaveLength(0);
  });
  it("revalidates credential expiry, rotation, revocation and current native actor grants before replay", async () => {
    const c = await hospitalHisV4Fixture(); await c.receive();
    await c.store.transaction(state => ({ state: { ...state, accessGroups: state.accessGroups.map(group => group.id === systemGroupId("VETERINARIAN") ? { ...group, permissions: group.permissions.filter(permission => permission !== "integration.exchange") } : group) }, result: undefined })); await expect(c.receive()).rejects.toMatchObject({ status: 404 });
    const d = await hospitalHisV4Fixture(); await d.receive(); await d.credentialService.rotateHospitalIntegrationCredential(d.user("user-admin"), d.issued.credential.id, { ttlSeconds: 300, expectedVersion: 1, idempotencyKey: "rotate-v4" }); await expect(d.receive()).rejects.toMatchObject({ status: 401 }); d.config.webhook!.credentialVersion = 2; expect(await d.receive()).toMatchObject({ status: "RECEIVED_FOR_TRIAGE" });
    await d.credentialService.revokeHospitalIntegrationCredential(d.user("user-admin"), d.issued.credential.id, { expectedVersion: 2, reason: "Synthetic revoke", idempotencyKey: "revoke-v4" }); await expect(d.receive()).rejects.toMatchObject({ status: 401 });
    const e = await hospitalHisV4Fixture(); vi.setSystemTime(new Date(Date.parse(EXTERNAL_NOW) + 300_000)); await expect(e.receive()).rejects.toMatchObject({ status: 401 });
  });
  it("retains native patient/encounter and credential scope checks and cannot use the v4 credential as generic CVG bearer", async () => {
    const c = await hospitalHisV4Fixture(); c.config.webhook!.mappings.encounters[0].hubId = "encounter-mel"; await expect(c.receive()).rejects.toMatchObject({ status: 404 }); expect(c.store.getState().hospitalIntakes).toHaveLength(0);
    const { currentIntegrationCredential } = await import("./hospital-integration-policy"); expect(() => currentIntegrationCredential(c.store.getState(), "HIS", c.issued.token!)).toThrow();
    c.config.webhook!.mappings.encounters[0].hubId = "encounter-thor"; c.config.webhook!.mappings.patients[0].hubId = "patient-mel"; await expect(c.receive()).rejects.toMatchObject({ status: 404 });
  });
  it("rolls back native intake, receipt and idempotency together on a crash and permits one later retry", async () => {
    const c = await hospitalHisV4Fixture(); const raw = JSON.stringify(hisV4Event()); const before = structuredClone(c.store.getState()); const faulty = createHospitalHisV4Service(c.context, { config: () => c.config, afterCommand: async () => { throw new Error("Synthetic atomic failure"); } });
    await expect(faulty.receiveHospitalHisV4Webhook(c.issued.credential.id, hisV4Signed(raw), raw)).rejects.toThrow("Synthetic atomic failure"); expect(c.store.getState()).toEqual(before); await c.receive(); await c.receive(); expect(c.store.getState().hospitalIntakes).toHaveLength(1); expect(c.store.getState().hospitalHisV4Deliveries).toHaveLength(1);
  });
  it("revalidates discovery access after the remote read completes", async () => {
    const c = await hospitalHisV4Fixture(); const slow = createHospitalHisV4Service(c.context, { config: () => c.config, discover: async () => { await c.store.transaction(state => ({ state: { ...state, users: state.users.map(user => user.id === "user-admin" ? { ...user, active: false } : user) }, result: undefined })); return hisV4Catalog(); } }); await expect(slow.getHospitalHisV4Catalog(c.user("user-admin"))).rejects.toMatchObject({ status: 401 });
  });
});
