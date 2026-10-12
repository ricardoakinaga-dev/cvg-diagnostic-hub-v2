import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { createHospitalIntegrationService } from "./hospital-integration-service";
import { HospitalIntegrationHttpError } from "./hospital-integration-http";
import { hospitalExternalFixture, externalConfig, EXTERNAL_NOW, EXTERNAL_SECRET } from "../../test/hospital-external-fixtures";
import { systemGroupId } from "../security/access-group-policy";
import type { HospitalIntegrationExchangeDependencies } from "./hospital-integration-exchange-service";
import type { HospitalIntegrationMessageInput } from "../http/hospital-integration-schemas";
const message = (id = "message-1", sequence = 1): Extract<HospitalIntegrationMessageInput, { purpose: "HIS_INTAKE" }> => ({ contract: "CVG_OPERATIONAL_V1", messageId: id, externalEntityId: "external-entity-1", sequence, occurredAt: EXTERNAL_NOW, purpose: "HIS_INTAKE", payload: { title: "Demanda sintética", departmentCode: "INPATIENT", priority: "ROUTINE" } });
const signature = (raw: string) => `sha256=${createHmac("sha256", EXTERNAL_SECRET).update(raw).digest("hex")}`;
function setup(dependencies: HospitalIntegrationExchangeDependencies = {}) { const c = hospitalExternalFixture(); const service = createHospitalIntegrationService(c.context, { config: externalConfig, ...dependencies }); const issue = () => service.createHospitalIntegrationCredential(c.user("user-admin"), { system: "HIS", purpose: "HIS_INTAKE", actorUserId: "user-vet", name: "Synthetic credential", scope: { departmentCodes: ["INPATIENT"] }, ttlSeconds: 300, idempotencyKey: "issue" }); const receive = (token: string, body = message()) => { const raw = JSON.stringify(body); return service.receiveHospitalIntegrationMessage("HIS", token, signature(raw), raw); }; return { ...c, integration: service, issue, receive }; }
describe("purpose-bound hospital integration commands", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(EXTERNAL_NOW); }); afterEach(() => vi.useRealTimers());
  it("fails closed without adopted configuration and never claims vendor validation", async () => {
    const c = setup({ config: () => undefined }); expect(await c.integration.getHospitalIntegrationCapabilities(c.user("user-admin"))).toEqual(["HIS", "LIS", "PACS"].map(system => ({ system, contract: "CVG_OPERATIONAL_V1", configured: false, deploymentVerified: false, reason: "CONFIGURATION_MISSING" })));
    await expect(c.issue()).rejects.toMatchObject({ code: "INTEGRATION_NOT_CONFIGURED", status: 503 }); expect(c.store.getState().hospitalIntegrationCredentials).toHaveLength(0);
  });
  it("returns the token once, rotates and revokes without retaining plaintext in state or audit", async () => {
    const c = setup(); const issued = await c.issue(); expect(issued.tokenReturnedOnce).toBe(true); expect((await c.issue()).token).toBeUndefined(); expect(JSON.stringify(c.store.getState())).not.toContain(issued.token!);
    const rotated = await c.integration.rotateHospitalIntegrationCredential(c.user("user-admin"), issued.credential.id, { ttlSeconds: 300, expectedVersion: 1, idempotencyKey: "rotate" }); await expect(c.receive(issued.token!)).rejects.toMatchObject({ status: 401 }); await c.receive(rotated.token!);
    await c.integration.revokeHospitalIntegrationCredential(c.user("user-admin"), issued.credential.id, { reason: "Synthetic revocation", expectedVersion: 2, idempotencyKey: "revoke" }); await expect(c.receive(rotated.token!)).rejects.toMatchObject({ status: 401 }); expect(JSON.stringify(c.store.getState().auditEvents)).not.toContain(rotated.token!);
  });
  it("atomically creates only an intake, handles simultaneous duplicates and rejects changed content or sequence", async () => {
    const c = setup(); const issued = await c.issue(); const receipts = await Promise.all([c.receive(issued.token!), c.receive(issued.token!)]); expect(receipts[0]).toEqual(receipts[1]); expect(c.store.getState().hospitalIntakes).toHaveLength(1); expect(c.store.getState().hospitalTasks).toHaveLength(0); expect(c.store.getState().hospitalIntegrationMessages).toHaveLength(1);
    await expect(c.receive(issued.token!, { ...message(), payload: { ...message().payload, title: "Different" } })).rejects.toMatchObject({ code: "INTEGRATION_MESSAGE_CONFLICT", status: 409 }); await expect(c.receive(issued.token!, message("message-gap", 3))).rejects.toMatchObject({ code: "INTEGRATION_SEQUENCE_CONFLICT" }); expect((await c.receive(issued.token!, message("message-2", 2))).status).toBe("SUCCEEDED");
  });
  it("rolls back a crash after the native command and safely repeats exactly once", async () => {
    let fail = true; const c = setup({ afterInboundCommand: async () => { if (fail) throw new Error("Synthetic crash"); } }); const issued = await c.issue(); const before = c.store.getState(); await expect(c.receive(issued.token!)).rejects.toThrow("Synthetic crash"); expect(c.store.getState()).toEqual(before); fail = false; await c.receive(issued.token!); await c.receive(issued.token!); expect(c.store.getState().hospitalIntakes).toHaveLength(1);
  });
  it("rejects signature, purpose, expiry and withdrawn grants before replay", async () => {
    const c = setup(); const issued = await c.issue(); const raw = JSON.stringify(message()); await expect(c.integration.receiveHospitalIntegrationMessage("HIS", issued.token!, "sha256=" + "0".repeat(64), raw)).rejects.toMatchObject({ status: 401 });
    const wrong = JSON.stringify({ ...message(), purpose: "PACS_RESULT_DRAFT", payload: { itemId: "none", draft: { narrative: "Synthetic", content: { kind: "NARRATIVE" }, expectedVersion: 1 } } }); await expect(c.integration.receiveHospitalIntegrationMessage("HIS", issued.token!, signature(wrong), wrong)).rejects.toMatchObject({ status: 403 });
    await c.receive(issued.token!); await c.store.transaction(state => ({ state: { ...state, accessGroups: state.accessGroups.map(group => group.id === systemGroupId("VETERINARIAN") ? { ...group, permissions: group.permissions.filter(permission => permission !== "integration.exchange") } : group) }, result: undefined })); await expect(c.receive(issued.token!)).rejects.toMatchObject({ status: 404 }); vi.setSystemTime(Date.parse(EXTERNAL_NOW) + 300_000); await expect(c.receive(issued.token!)).rejects.toMatchObject({ status: 401 });
  });
  it("keeps LIS output as the current executor's native draft and never releases it", async () => {
    const c = setup(); const request = await c.service.createRequest(c.user("user-vet"), { patientId: "patient-thor", encounterId: "encounter-thor", admissionId: "admission-thor", priority: "ROUTINE", items: [{ serviceId: "service-crp" }] }, { idempotencyKey: "request" }); const itemId = request.items[0].id; await c.service.assignDiagnosticItem(c.user("user-manager"), itemId, { userId: "user-lab", expectedVersion: 1, idempotencyKey: "assign" }); await c.service.receiveSample(c.user("user-lab"), [itemId], { expectedVersion: 2, sampleType: "sangue", idempotencyKey: "receive" }); await c.service.startProcessing(c.user("user-lab"), itemId, { expectedVersion: 3, idempotencyKey: "start" });
    const issued = await c.integration.createHospitalIntegrationCredential(c.user("user-admin"), { system: "LIS", purpose: "LIS_RESULT_DRAFT", actorUserId: "user-lab", name: "Synthetic LIS", scope: { departmentCodes: ["LABORATORY"], patientIds: ["patient-thor"] }, ttlSeconds: 300, idempotencyKey: "issue-lis" });
    const body = { ...message("lis-1"), purpose: "LIS_RESULT_DRAFT", payload: { itemId, draft: { narrative: "Rascunho externo sintético", content: { kind: "NARRATIVE" }, expectedVersion: 4 } } }; const raw = JSON.stringify(body); const receipt = await c.integration.receiveHospitalIntegrationMessage("LIS", issued.token!, signature(raw), raw); expect(receipt.status).toBe("SUCCEEDED"); expect(c.store.getState().resultVersions[0]).toMatchObject({ status: "DRAFT", authorId: "user-lab" }); expect(c.store.getState().results[0].lifecycleStatus).toBe("DRAFT"); expect(c.store.getState().items[0].status).toBe("IN_PROGRESS");
    const receipts = await c.integration.listHospitalIntegrationMessages(c.user("user-lab"), { system: "LIS", direction: "INBOUND", status: "SUCCEEDED" }); expect(receipts.total).toBe(1); expect(receipts.items[0]).toMatchObject({ id: receipt.id, targetType: "RESULT", status: "SUCCEEDED" }); expect(JSON.stringify(receipts)).not.toContain("Rascunho externo sintético");
    await c.store.transaction(state => ({ state: { ...state, items: state.items.map(item => item.id === itemId ? { ...item, assignedUserId: "another-executor" } : item) }, result: undefined })); await expect(c.integration.receiveHospitalIntegrationMessage("LIS", issued.token!, signature(raw), raw)).rejects.toMatchObject({ status: 404 });
    expect((await c.integration.listHospitalIntegrationMessages(c.user("user-lab"), { direction: "INBOUND" })).items).toEqual([]);
  });
  it("records actual outbound failure and retries unchanged content with the same remote idempotency identity", async () => {
    const send = vi.fn().mockRejectedValueOnce(new HospitalIntegrationHttpError("INTEGRATION_NETWORK_UNAVAILABLE", true)).mockImplementation(async (_config, envelope) => ({ contract: "CVG_OPERATIONAL_V1", messageId: envelope.messageId, receiptId: "actual-disposable-receipt", status: "ACCEPTED" })); const c = setup({ send }); const issued = await c.issue(); const inbound = await c.receive(issued.token!);
    const input = { system: "HIS" as const, targetType: "HOSPITAL_INTAKE" as const, targetId: inbound.targetId!, messageId: "outbound-1", externalEntityId: "outbound-entity", sequence: 1, expectedVersion: 1, idempotencyKey: "exchange" }; const failed = await c.integration.exchangeHospitalIntegration(c.user("user-vet"), input); expect(failed).toMatchObject({ status: "FAILED", retryable: true, remoteReceiptId: undefined }); expect((await c.integration.exchangeHospitalIntegration(c.user("user-vet"), input)).id).toBe(failed.id); expect(send).toHaveBeenCalledTimes(1);
    await expect(c.integration.retryHospitalIntegrationMessage(c.user("user-vet"), failed.id, { expectedVersion: failed.version, idempotencyKey: "too-soon" })).rejects.toMatchObject({ status: 409 }); vi.setSystemTime(Date.parse(EXTERNAL_NOW) + 30_000); const completed = await c.integration.retryHospitalIntegrationMessage(c.user("user-vet"), failed.id, { expectedVersion: failed.version, idempotencyKey: "retry" }); expect(completed).toMatchObject({ status: "SUCCEEDED", remoteReceiptId: "actual-disposable-receipt", attempts: 2 }); expect(send.mock.calls[0][1]).toEqual(send.mock.calls[1][1]); expect(JSON.stringify(c.store.getState().hospitalIntegrationMessages)).not.toContain("Demanda sintética");
  });
  it("prevents a different message from bypassing unresolved ordering and denies retry of changed sources", async () => {
    const send = vi.fn().mockRejectedValue(new HospitalIntegrationHttpError("INTEGRATION_NETWORK_UNAVAILABLE", true)); const c = setup({ send }); const issued = await c.issue(); const inbound = await c.receive(issued.token!); const input = { system: "HIS" as const, targetType: "HOSPITAL_INTAKE" as const, targetId: inbound.targetId!, messageId: "failed-outbound", externalEntityId: "entity", sequence: 1, expectedVersion: 1, idempotencyKey: "failed" }; const failed = await c.integration.exchangeHospitalIntegration(c.user("user-vet"), input);
    await expect(c.integration.exchangeHospitalIntegration(c.user("user-vet"), { ...input, messageId: "different", idempotencyKey: "different" })).rejects.toMatchObject({ status: 409 }); await c.store.transaction(state => ({ state: { ...state, hospitalIntakes: state.hospitalIntakes.map(entry => ({ ...entry, title: "Changed", version: 2 })) }, result: undefined })); vi.setSystemTime(Date.parse(EXTERNAL_NOW) + 30_000); await expect(c.integration.retryHospitalIntegrationMessage(c.user("user-vet"), failed.id, { expectedVersion: failed.version, idempotencyKey: "changed" })).rejects.toMatchObject({ code: "INTEGRATION_SOURCE_CHANGED" }); expect(send).toHaveBeenCalledTimes(1);
  });
  it("persists an actual remote receipt even if its actor is deactivated while delivery is in flight", async () => {
    const c = setup(); const issued = await c.issue(); const inbound = await c.receive(issued.token!);
    const integration = createHospitalIntegrationService(c.context, { config: externalConfig, send: async (_config, envelope) => {
      await c.store.transaction(state => ({ state: { ...state, users: state.users.map(user => user.id === "user-vet" ? { ...user, active: false } : user) }, result: undefined }));
      return { contract: "CVG_OPERATIONAL_V1", messageId: envelope.messageId, receiptId: "real-disposable-receipt-after-revocation", status: "ACCEPTED" };
    } });
    await expect(integration.exchangeHospitalIntegration(c.user("user-vet"), { system: "HIS", targetType: "HOSPITAL_INTAKE", targetId: inbound.targetId!, messageId: "revoked-in-flight", externalEntityId: "in-flight-entity", sequence: 1, expectedVersion: 1, idempotencyKey: "in-flight" })).rejects.toMatchObject({ status: 404 });
    expect(c.store.getState().hospitalIntegrationMessages.find(message => message.direction === "OUTBOUND")).toMatchObject({ status: "SUCCEEDED", remoteReceiptId: "real-disposable-receipt-after-revocation" });
  });

  it("records a native refusal without partial intake and preserves its identity on an exact failed retry", async () => {
    const c = setup(); const issued = await c.issue(); const body = { ...message("native-refused"), payload: { ...message().payload, typeId: "hospital-task-type-care" } };
    const before = c.store.getState(); await expect(c.receive(issued.token!, body)).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 });
    const failed = c.store.getState().hospitalIntegrationMessages[0]; expect(failed).toMatchObject({ status: "FAILED", retryable: false, attempts: 1, errorCode: "VALIDATION_ERROR" });
    expect(c.store.getState().hospitalIntakes).toEqual(before.hospitalIntakes); expect(c.store.getState().auditEvents).toEqual(before.auditEvents); expect(c.store.getState().idempotency).toEqual(before.idempotency);
    await expect(c.receive(issued.token!, body)).rejects.toMatchObject({ status: 400 }); expect(c.store.getState().hospitalIntegrationMessages).toHaveLength(1); expect(c.store.getState().hospitalIntegrationMessages[0]).toMatchObject({ id: failed.id, createdAt: failed.createdAt, attempts: 2, status: "FAILED" });
    const d = setup(); const other = await d.issue(); await d.store.transaction(state => ({ state: { ...state, encounters: state.encounters.map(encounter => encounter.id === "encounter-thor" ? { ...encounter, status: "CLOSED" } : encounter) }, result: undefined }));
    await expect(d.receive(other.token!, { ...message("closed-native-context"), payload: { ...message().payload, patientId: "patient-thor", encounterId: "encounter-thor" } })).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION", status: 409 });
    expect(d.store.getState().hospitalIntegrationMessages[0]).toMatchObject({ status: "FAILED", retryable: true, errorCode: "INVALID_STATE_TRANSITION" }); expect(d.store.getState().hospitalIntakes).toHaveLength(0);
  });

  it("parses literal braces and escaped quotes as string content while rejecting malformed or excessively nested JSON", async () => {
    const c = setup(); const issued = await c.issue(); const title = 'Conferência sintética "texto" \\ {literal}';
    await c.receive(issued.token!, { ...message(), payload: { ...message().payload, title } }); expect(c.store.getState().hospitalIntakes[0].title).toBe(title);
    for (const [raw, code] of [["{broken-json", "INVALID_JSON"], [JSON.stringify({ invalidContract: true }), "VALIDATION_ERROR"], ["[".repeat(33) + "0" + "]".repeat(33), "VALIDATION_ERROR"]]) {
      await expect(c.integration.receiveHospitalIntegrationMessage("HIS", issued.token!, signature(raw), raw)).rejects.toMatchObject({ code, status: 400 });
    }
    expect(c.store.getState().hospitalIntegrationMessages).toHaveLength(1); expect(c.store.getState().hospitalIntakes).toHaveLength(1);
  });

});
