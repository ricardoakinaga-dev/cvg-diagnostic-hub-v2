import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HospitalIntegrationHttpConfig } from "./hospital-integration-http";
import type { HospitalIntegrationExchangeInput } from "../http/hospital-integration-schemas";
import { HospitalIntegrationHttpError } from "./hospital-integration-http";
import { createHospitalIntegrationService } from "./hospital-integration-service";
import type { HospitalIntegrationExchangeDependencies } from "./hospital-integration-exchange-service";
import { EXTERNAL_NOW, externalConfig, hospitalExternalFixture } from "@/test/hospital-external-fixtures";
import { systemGroupId } from "../security/access-group-policy";

function setup(dependencies: HospitalIntegrationExchangeDependencies = {}) {
  const fixture = hospitalExternalFixture();
  const send = vi.fn(async (_config: HospitalIntegrationHttpConfig, envelope: { messageId: string }) => ({ contract: "CVG_OPERATIONAL_V1" as const, messageId: envelope.messageId, receiptId: `receipt-${envelope.messageId}`, status: "ACCEPTED" as const }));
  const integration = createHospitalIntegrationService(fixture.context, { config: externalConfig, send, ...dependencies });
  const intake = () => fixture.service.createHospitalIntake(fixture.user("user-vet"), { title: "Reposição sintética", departmentCode: "INPATIENT", priority: "ROUTINE", source: "MANUAL", idempotencyKey: "intake" });
  const input = (targetId: string, messageId = "outbound-1"): HospitalIntegrationExchangeInput => ({ system: "HIS", targetType: "HOSPITAL_INTAKE", targetId, messageId, externalEntityId: "external-intake", sequence: 1, expectedVersion: 1, idempotencyKey: messageId });
  return { ...fixture, integration, send, intake, input };
}

describe("outbound integrations retain current source and remote receipt authority", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(EXTERNAL_NOW); });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it("paginates visible receipts, rejects inaccessible cursors and filters the actual outcome", async () => {
    const c = setup(); const intake = await c.intake();
    const first = await c.integration.exchangeHospitalIntegration(c.user("user-vet"), c.input(intake.id));
    vi.setSystemTime(Date.parse(EXTERNAL_NOW) + 1_000);
    const second = await c.integration.exchangeHospitalIntegration(c.user("user-vet"), { ...c.input(intake.id, "outbound-2"), sequence: 2 });
    const page = await c.integration.listHospitalIntegrationMessages(c.user("user-vet"), { system: "HIS", direction: "OUTBOUND", status: "SUCCEEDED", limit: 1 });
    expect(page).toMatchObject({ total: 2, nextCursor: second.id }); expect(page.items.map(row => row.id)).toEqual([second.id]);
    const continuation = await c.integration.listHospitalIntegrationMessages(c.user("user-vet"), { cursor: page.nextCursor, limit: 1 });
    expect(continuation).toMatchObject({ total: 2, items: [{ id: first.id }] }); expect(continuation.nextCursor).toBeUndefined();
    expect((await c.integration.listHospitalIntegrationMessages(c.user("user-vet"))).items).toHaveLength(2);
    expect((await c.integration.listHospitalIntegrationMessages(c.user("user-vet"), { system: "LIS" })).total).toBe(0);
    expect((await c.integration.listHospitalIntegrationMessages(c.user("user-vet"), { direction: "INBOUND" })).total).toBe(0);
    expect((await c.integration.listHospitalIntegrationMessages(c.user("user-vet"), { status: "FAILED" })).total).toBe(0);
    expect((await c.integration.listHospitalIntegrationMessages(c.user("user-lab"))).items).toEqual([]);
    await expect(c.integration.listHospitalIntegrationMessages(c.user("user-lab"), { cursor: second.id })).rejects.toMatchObject({ status: 400 });
    await expect(c.integration.listHospitalIntegrationMessages(c.user("user-vet"), { limit: 0 })).rejects.toMatchObject({ status: 400 });
    await c.store.transaction(state => ({ state: { ...state, users: [...state.users, { ...state.users.find(user => user.id === "user-vet")!, id: "super", role: "SUPERADMIN", accessGroupId: systemGroupId("SUPERADMIN") }] }, result: undefined }));
    expect((await c.integration.listHospitalIntegrationMessages(c.user("super"))).total).toBe(2);
    await c.store.transaction(state => ({ state: { ...state, accessGroups: state.accessGroups.map(group => group.id === systemGroupId("VETERINARIAN") ? { ...group, permissions: group.permissions.filter(permission => permission !== "integration.exchange") } : group) }, result: undefined }));
    await expect(c.integration.listHospitalIntegrationMessages(c.user("user-vet"))).rejects.toMatchObject({ status: 404 });
    expect(c.send).toHaveBeenCalledTimes(2);
  });

  it("sends LIS and PACS orders only from compatible currently authorized diagnostic items", async () => {
    const c = setup(); const request = await c.service.createRequest(c.user("user-vet"), { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-crp" }, { serviceId: "service-xray" }] }, { idempotencyKey: "diagnostic" });
    const [lab, xray] = request.items;
    const source = (system: "LIS" | "PACS", targetId: string): HospitalIntegrationExchangeInput => ({ system, targetType: "DIAGNOSTIC_ITEM", targetId, messageId: `order-${system}`, externalEntityId: `entity-${system}`, sequence: 1, expectedVersion: 1, idempotencyKey: `order-${system}` });
    expect(await c.integration.exchangeHospitalIntegration(c.user("user-lab"), source("LIS", lab.id))).toMatchObject({ status: "SUCCEEDED", targetId: lab.id });
    expect(await c.integration.exchangeHospitalIntegration(c.user("user-rx"), source("PACS", xray.id))).toMatchObject({ status: "SUCCEEDED", targetId: xray.id });
    await expect(c.integration.exchangeHospitalIntegration(c.user("user-lab"), { ...source("LIS", xray.id), idempotencyKey: "wrong-workflow" })).rejects.toMatchObject({ status: 404 });
    await expect(c.integration.exchangeHospitalIntegration(c.user("user-rx"), { ...source("PACS", lab.id), idempotencyKey: "wrong-pacs" })).rejects.toMatchObject({ status: 404 });
    await expect(c.integration.exchangeHospitalIntegration(c.user("user-lab"), { ...source("LIS", "missing"), idempotencyKey: "missing" })).rejects.toMatchObject({ status: 404 });
    await expect(c.integration.exchangeHospitalIntegration(c.user("user-vet"), { ...source("LIS", lab.id), idempotencyKey: "outside-exchange-department" })).rejects.toMatchObject({ status: 404 });
    expect(c.send).toHaveBeenCalledTimes(2); expect(c.store.getState().results).toEqual([]); expect(c.store.getState().items.map(item => item.status)).toEqual(["REQUESTED", "REQUESTED"]);
    expect(JSON.stringify(c.store.getState().hospitalIntegrationMessages)).not.toContain("examDefinitionSnapshot");
  });

  it("rejects stale sources, changed idempotency bodies and reused message identities without transmitting twice", async () => {
    const c = setup(); const intake = await c.intake(); const body = c.input(intake.id);
    await expect(c.integration.exchangeHospitalIntegration(c.user("user-vet"), { ...body, expectedVersion: 2 })).rejects.toMatchObject({ status: 409 });
    expect(c.store.getState().hospitalIntegrationMessages).toEqual([]);
    const receipt = await c.integration.exchangeHospitalIntegration(c.user("user-vet"), body);
    expect(await c.integration.exchangeHospitalIntegration(c.user("user-vet"), body)).toEqual(receipt);
    await expect(c.integration.exchangeHospitalIntegration(c.user("user-vet"), { ...body, externalEntityId: "changed" })).rejects.toMatchObject({ status: 409 });
    await expect(c.integration.exchangeHospitalIntegration(c.user("user-vet"), { ...body, idempotencyKey: "same-message-other-command" })).rejects.toMatchObject({ code: "INTEGRATION_MESSAGE_CONFLICT", status: 409 });
    await expect(c.integration.retryHospitalIntegrationMessage(c.user("user-vet"), receipt.id, { expectedVersion: receipt.version, idempotencyKey: "already-delivered" })).rejects.toMatchObject({ code: "INTEGRATION_RETRY_NOT_AVAILABLE" });
    await expect(c.integration.retryHospitalIntegrationMessage(c.user("user-vet"), "missing", { expectedVersion: 1, idempotencyKey: "missing-retry" })).rejects.toMatchObject({ status: 404 });
    expect(c.send).toHaveBeenCalledTimes(1);
  });

  it("distinguishes permanent rejection from a recoverable transport failure and replays a completed retry", async () => {
    const permanentSend = vi.fn().mockRejectedValue(new HospitalIntegrationHttpError("INTEGRATION_REMOTE_REJECTED", false));
    const permanent = setup({ send: permanentSend }); const first = await permanent.intake();
    const rejected = await permanent.integration.exchangeHospitalIntegration(permanent.user("user-vet"), permanent.input(first.id));
    expect(rejected).toMatchObject({ status: "FAILED", retryable: false, errorCode: "INTEGRATION_REMOTE_REJECTED" }); expect(rejected.nextAttemptAt).toBeUndefined();
    await expect(permanent.integration.retryHospitalIntegrationMessage(permanent.user("user-vet"), rejected.id, { expectedVersion: rejected.version, idempotencyKey: "permanent" })).rejects.toMatchObject({ code: "INTEGRATION_RETRY_NOT_AVAILABLE" });
    const recoveringSend = vi.fn().mockRejectedValueOnce(new Error("Synthetic transport exception")).mockImplementation(async (_config, envelope) => ({ contract: "CVG_OPERATIONAL_V1", messageId: envelope.messageId, receiptId: "real-test-retry-receipt", status: "ACCEPTED" }));
    const c = setup({ send: recoveringSend }); const intake = await c.intake();
    const failed = await c.integration.exchangeHospitalIntegration(c.user("user-vet"), c.input(intake.id));
    expect(failed).toMatchObject({ status: "FAILED", retryable: true, errorCode: "INTEGRATION_DELIVERY_UNAVAILABLE" });
    vi.setSystemTime(Date.parse(EXTERNAL_NOW) + 30_000);
    const retry = { expectedVersion: failed.version, idempotencyKey: "recover" };
    const completed = await c.integration.retryHospitalIntegrationMessage(c.user("user-vet"), failed.id, retry);
    expect(completed).toMatchObject({ status: "SUCCEEDED", remoteReceiptId: "real-test-retry-receipt", attempts: 2 });
    expect(await c.integration.retryHospitalIntegrationMessage(c.user("user-vet"), failed.id, retry)).toEqual(completed);
    expect(recoveringSend).toHaveBeenCalledTimes(2); expect(recoveringSend.mock.calls[0][1]).toEqual(recoveringSend.mock.calls[1][1]);
  });

  it("blocks a competing retry during the claim lease and preserves the real receipt", async () => {
    let notifyStarted!: () => void; const started = new Promise<void>(resolve => { notifyStarted = resolve; });
    let finish!: (value: { contract: "CVG_OPERATIONAL_V1"; messageId: string; receiptId: string; status: "ACCEPTED" }) => void;
    const pending = new Promise<{ contract: "CVG_OPERATIONAL_V1"; messageId: string; receiptId: string; status: "ACCEPTED" }>(resolve => { finish = resolve; });
    const send = vi.fn(async () => { notifyStarted(); return pending; });
    const c = setup({ send }); const intake = await c.intake(); const delivery = c.integration.exchangeHospitalIntegration(c.user("user-vet"), c.input(intake.id));
    await started; const claim = c.store.getState().hospitalIntegrationMessages[0]; expect(claim.status).toBe("CLAIMED");
    await expect(c.integration.retryHospitalIntegrationMessage(c.user("user-vet"), claim.id, { expectedVersion: 1, idempotencyKey: "competing" })).rejects.toMatchObject({ code: "INTEGRATION_RETRY_NOT_AVAILABLE" });
    finish({ contract: "CVG_OPERATIONAL_V1", messageId: claim.messageId, receiptId: "remote-once", status: "ACCEPTED" });
    expect(await delivery).toMatchObject({ status: "SUCCEEDED", remoteReceiptId: "remote-once", attempts: 1 }); expect(send).toHaveBeenCalledTimes(1);
  });

  it("prevents a late expired-lease delivery from overwriting the newer reconciliation", async () => {
    let notifyStarted!: () => void; const started = new Promise<void>(resolve => { notifyStarted = resolve; });
    let finish!: (value: { contract: "CVG_OPERATIONAL_V1"; messageId: string; receiptId: string; status: "ACCEPTED" }) => void;
    const pending = new Promise<{ contract: "CVG_OPERATIONAL_V1"; messageId: string; receiptId: string; status: "ACCEPTED" }>(resolve => { finish = resolve; });
    const send = vi.fn().mockImplementationOnce(async () => { notifyStarted(); return pending; }).mockImplementation(async (_config, envelope) => ({ contract: "CVG_OPERATIONAL_V1", messageId: envelope.messageId, receiptId: "remote-idempotent-receipt", status: "ACCEPTED" }));
    const c = setup({ send }); const intake = await c.intake(); const delivery = c.integration.exchangeHospitalIntegration(c.user("user-vet"), c.input(intake.id));
    const lateOutcome = expect(delivery).rejects.toMatchObject({ code: "INTEGRATION_CLAIM_CHANGED", status: 409 });
    await started; const claim = c.store.getState().hospitalIntegrationMessages[0]; vi.setSystemTime(Date.parse(EXTERNAL_NOW) + 120_000);
    const completed = await c.integration.retryHospitalIntegrationMessage(c.user("user-vet"), claim.id, { expectedVersion: 1, idempotencyKey: "expired-lease-retry" });
    finish({ contract: "CVG_OPERATIONAL_V1", messageId: claim.messageId, receiptId: "remote-idempotent-receipt", status: "ACCEPTED" }); await lateOutcome;
    expect(c.store.getState().hospitalIntegrationMessages[0]).toMatchObject({ id: completed.id, status: "SUCCEEDED", attempts: 2, version: completed.version, remoteReceiptId: "remote-idempotent-receipt" });
    expect(send.mock.calls[0][1]).toEqual(send.mock.calls[1][1]);
  });

  it("stops transmission when the source changes between claim and delivery", async () => {
    const c = setup(); const intake = await c.intake(); const read = c.store.readState.bind(c.store);
    vi.spyOn(c.store, "readState").mockImplementationOnce(async () => {
      await c.service.triageHospitalIntake(c.user("user-vet"), intake.id, { decision: "DEFER", reason: "Alteração sintética concorrente", expectedVersion: 1, idempotencyKey: "triage-during-claim" });
      return read();
    });
    const receipt = await c.integration.exchangeHospitalIntegration(c.user("user-vet"), c.input(intake.id));
    expect(receipt).toMatchObject({ status: "FAILED", retryable: false, errorCode: "INTEGRATION_SOURCE_CHANGED" });
    expect(c.send).not.toHaveBeenCalled(); expect(c.store.getState().hospitalIntakes[0]).toMatchObject({ state: "DEFERRED", version: 2 });
  });
});
