import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { producePinnedHisV4Webhook } from "../../test/his-v4-pinned-producer";
import { hospitalHisV4Fixture, hisV4Event, hisV4Signed } from "../../test/hospital-his-v4-fixtures";
import { EXTERNAL_NOW } from "../../test/hospital-external-fixtures";
import { systemGroupId } from "../security/access-group-policy";
import { verifyHospitalHisV4Signature } from "./hospital-his-v4-http";

describe("HIS v4 actual pinned producer metadata compatibility", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(EXTERNAL_NOW); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("accepts the signed raw body emitted by real runtime/publish/consumer/enqueue/delivery bodies without exposing or copying metadata", async () => {
    const producer = await producePinnedHisV4Webhook();
    expect(producer.event.data._meta).toMatchObject({ eventId: expect.any(String), eventType: "encounter.created", schemaVersion: 1, accountId: producer.event.accountId, sourceModule: "encounters", actor: { type: "system", id: "event-bus" }, causationId: null, sourceService: "cvg-his-v2-api", tenantId: "his_meta_tenant_synthetic", traceparent: "00-" + "1".repeat(32) + "-" + "2".repeat(16) + "-01" });
    expect(producer.event.data._meta.eventId).not.toBe(producer.event.id);
    expect(producer.event.id).toMatch(/^whpay_/); expect(producer.headers.deliveryId).toMatch(/^whdel_/);
    expect(producer.headers.idempotencyKey).toBe(producer.headers.deliveryId);
    expect(producer.provenance.fragments.every(fragment => fragment.sameFragmentAcrossPinnedCommits)).toBe(true);
    const c = await hospitalHisV4Fixture();
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "info"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    const receipt = await c.hisV4.receiveHospitalHisV4Webhook(c.issued.credential.id, producer.headers, producer.rawBody);
    expect(receipt).toMatchObject({ profile: "HIS_V4_WEBHOOK_V2", status: "RECEIVED_FOR_TRIAGE", providerPayloadId: producer.event.id });
    const state = c.store.getState();
    expect(state.hospitalIntakes).toHaveLength(1);
    expect(state.hospitalIntakes[0]).toMatchObject({ patientId: "patient-thor", encounterId: "encounter-thor", departmentCode: "INPATIENT", submittedBy: "user-vet" });
    expect(state.hospitalHisV4Deliveries).toHaveLength(1);
    const serialized = JSON.stringify({ receipt, intakes: state.hospitalIntakes, deliveries: state.hospitalHisV4Deliveries, audit: state.auditEvents, outbox: state.outbox, logs: logs.map(log => log.mock.calls) });
    expect(serialized).not.toMatch(/"_meta"|"sourceService"|"sourceModule"|"traceparent"|"tenantId"|his_meta_correlation_synthetic|his_meta_tenant_synthetic/);
  });

  it("accepts omitted optional tracing/tenant fields and the provider's 255 Unicode-codepoint correlation identifier", async () => {
    const producer = await producePinnedHisV4Webhook({ trace: false, tenant: false, correlationId: "𝄞".repeat(255) });
    expect(producer.event.data._meta).not.toHaveProperty("traceparent"); expect(producer.event.data._meta).not.toHaveProperty("tenantId");
    const c = await hospitalHisV4Fixture();
    expect(await c.hisV4.receiveHospitalHisV4Webhook(c.issued.credential.id, producer.headers, producer.rawBody)).toMatchObject({ status: "RECEIVED_FOR_TRIAGE" });
    expect(JSON.stringify(c.store.getState())).not.toContain("𝄞");
  });

  it("retains legacy no-metadata compatibility, redelivery identity and content collision protection", async () => {
    const legacy = await hospitalHisV4Fixture(); expect(await legacy.receive()).toMatchObject({ status: "RECEIVED_FOR_TRIAGE" });
    const producer = await producePinnedHisV4Webhook(); const c = await hospitalHisV4Fixture();
    const first = await c.hisV4.receiveHospitalHisV4Webhook(c.issued.credential.id, producer.headers, producer.rawBody);
    expect(await c.hisV4.receiveHospitalHisV4Webhook(c.issued.credential.id, hisV4Signed(producer.rawBody, "redelivery_metadata"), producer.rawBody)).toEqual(first);
    const changed = JSON.stringify({ ...producer.event, data: { ...producer.event.data, _meta: { ...producer.event.data._meta, tenantId: "changed_synthetic_tenant" } } });
    await expect(c.hisV4.receiveHospitalHisV4Webhook(c.issued.credential.id, hisV4Signed(changed, "collision_metadata"), changed)).rejects.toMatchObject({ status: 409, code: "INTEGRATION_MESSAGE_CONFLICT" });
    expect(c.store.getState().hospitalIntakes).toHaveLength(1); expect(c.store.getState().hospitalHisV4Deliveries).toHaveLength(1);
  });

  it("keeps raw HMAC authentication and current native actor authority independent from _meta actor claims", async () => {
    const producer = await producePinnedHisV4Webhook(); const c = await hospitalHisV4Fixture();
    const changed = JSON.stringify({ ...producer.event, data: { ...producer.event.data, _meta: { ...producer.event.data._meta, actor: { type: "user", id: "user-superadmin" } } } });
    await expect(c.hisV4.receiveHospitalHisV4Webhook(c.issued.credential.id, producer.headers, changed)).rejects.toMatchObject({ status: 401, code: "INTEGRATION_SIGNATURE_INVALID" });
    await c.store.transaction(state => ({ state: { ...state, accessGroups: state.accessGroups.map(group => group.id === systemGroupId("VETERINARIAN") ? { ...group, permissions: group.permissions.filter(permission => permission !== "hospital_intake.create") } : group) }, result: undefined }));
    await expect(c.hisV4.receiveHospitalHisV4Webhook(c.issued.credential.id, hisV4Signed(changed), changed)).rejects.toMatchObject({ status: 404, code: "SCOPE_DENIED" });
    expect(c.store.getState().hospitalIntakes).toHaveLength(0); expect(c.store.getState().hospitalHisV4Deliveries).toHaveLength(0);
  });

  it.each([
    ["null metadata", () => null],
    ["array metadata", () => []],
    ["missing canonical actor", (meta: Record<string, unknown>) => { const result = { ...meta }; delete result.actor; return result; }],
    ["unknown metadata key", (meta: Record<string, unknown>) => ({ ...meta, undeclaredPayload: "unadopted" })],
    ["unknown actor key", (meta: Record<string, unknown>) => ({ ...meta, actor: { type: "system", id: "event-bus", permissions: ["hospital_intake.create"] } })],
    ["unsupported version", (meta: Record<string, unknown>) => ({ ...meta, schemaVersion: 2 })],
    ["wrong metadata account", (meta: Record<string, unknown>) => ({ ...meta, accountId: "other_account" })],
    ["wrong metadata event", (meta: Record<string, unknown>) => ({ ...meta, eventType: "patient.created" })],
    ["wrong source module", (meta: Record<string, unknown>) => ({ ...meta, sourceModule: "patients" })],
    ["wrong source service", (meta: Record<string, unknown>) => ({ ...meta, sourceService: "unadopted-api" })],
    ["oversized identifier", (meta: Record<string, unknown>) => ({ ...meta, correlationId: "𝄞".repeat(256) })],
    ["blank actor identifier", (meta: Record<string, unknown>) => ({ ...meta, actor: { type: "system", id: "  " } })],
    ["malformed timestamp", (meta: Record<string, unknown>) => ({ ...meta, occurredAt: "yesterday" })],
    ["oversized timestamp", (meta: Record<string, unknown>) => ({ ...meta, publishedAt: "2026-10-11T18:00:00." + "0".repeat(100) + "Z" })],
    ["malformed traceparent", (meta: Record<string, unknown>) => ({ ...meta, traceparent: "00-invalid" })]
  ] as const)("rejects signed %s without native mutation", async (_name, mutate) => {
    const producer = await producePinnedHisV4Webhook(); const c = await hospitalHisV4Fixture(); const before = structuredClone(c.store.getState());
    const raw = JSON.stringify({ ...producer.event, data: { ...producer.event.data, _meta: mutate(producer.event.data._meta) } });
    await expect(c.hisV4.receiveHospitalHisV4Webhook(c.issued.credential.id, hisV4Signed(raw), raw)).rejects.toMatchObject({ status: 400, code: "HIS_V4_EVENT_NOT_ADOPTED" });
    expect(c.store.getState()).toEqual(before);
  });

  it("still rejects an extra business field and an oversized raw body even with the emitted metadata", async () => {
    const producer = await producePinnedHisV4Webhook(); const c = await hospitalHisV4Fixture(); const before = structuredClone(c.store.getState());
    const raw = JSON.stringify({ ...producer.event, data: { ...producer.event.data, departmentCode: "RADIOLOGY" } });
    await expect(c.hisV4.receiveHospitalHisV4Webhook(c.issued.credential.id, hisV4Signed(raw), raw)).rejects.toMatchObject({ status: 400, code: "HIS_V4_EVENT_NOT_ADOPTED" });
    const oversized = JSON.stringify({ ...producer.event, data: { ...producer.event.data, _meta: { ...producer.event.data._meta, correlationId: "x".repeat(100_001) } } });
    await expect(c.hisV4.receiveHospitalHisV4Webhook(c.issued.credential.id, hisV4Signed(oversized), oversized)).rejects.toMatchObject({ status: 413, code: "PAYLOAD_TOO_LARGE" });
    expect(c.store.getState()).toEqual(before);
    expect(hisV4Event().data).not.toHaveProperty("_meta");
    expect(verifyHospitalHisV4Signature(producer.rawBody, producer.headers.signature, producer.headers.timestamp, producer.headers.signatureVersion, c.config.webhook!.secret)).toBe(true);
  });
});
