import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { createHospitalIntegrationService } from "./hospital-integration-service";
import { hospitalExternalFixture, externalConfig, EXTERNAL_NOW, EXTERNAL_SECRET } from "../../test/hospital-external-fixtures";
import { systemGroupId } from "../security/access-group-policy";
import type { HospitalIntegrationSystem } from "@cvg/contracts";

function setup() {
  const c = hospitalExternalFixture(); const integration = createHospitalIntegrationService(c.context, { config: externalConfig });
  const input = { system: "HIS" as const, purpose: "HIS_INTAKE" as const, actorUserId: "user-vet", name: "Credencial sintética", scope: { departmentCodes: ["INPATIENT"], patientIds: ["patient-thor"] }, ttlSeconds: 300, idempotencyKey: "issue" };
  const issue = () => integration.createHospitalIntegrationCredential(c.user("user-admin"), input);
  const receive = (token: string, patientId = "patient-thor", encounterId = "encounter-thor") => {
    const raw = JSON.stringify({ contract: "CVG_OPERATIONAL_V1", messageId: "credential-message", externalEntityId: "synthetic-entity", sequence: 1, occurredAt: EXTERNAL_NOW, purpose: "HIS_INTAKE", payload: { title: "Demanda sintética", departmentCode: "INPATIENT", patientId, encounterId, priority: "ROUTINE" } });
    return integration.receiveHospitalIntegrationMessage("HIS", token, `sha256=${createHmac("sha256", EXTERNAL_SECRET).update(raw).digest("hex")}`, raw);
  };
  return { ...c, integration, input, issue, receive };
}
describe("credential lifecycle and current scoped authority", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(EXTERNAL_NOW); });
  afterEach(() => vi.useRealTimers());
  it("makes rotate and revoke replay return metadata without a second plaintext token or audit mutation", async () => {
    const c = setup(); const issued = await c.issue(); const rotate = { expectedVersion: 1, ttlSeconds: 300, correlationId: "synthetic-rotate-correlation", idempotencyKey: "rotate" };
    const rotated = await c.integration.rotateHospitalIntegrationCredential(c.user("user-admin"), issued.credential.id, rotate); const afterRotate = c.store.getState();
    const replay = await c.integration.rotateHospitalIntegrationCredential(c.user("user-admin"), issued.credential.id, rotate); expect(replay).toMatchObject({ tokenReturnedOnce: false, credential: { version: 2 } }); expect(replay.token).toBeUndefined(); expect(c.store.getState()).toEqual(afterRotate);
    const revoke = { expectedVersion: 2, reason: "Revogação sintética explícita", correlationId: "synthetic-revoke-correlation", idempotencyKey: "revoke" };
    const revoked = await c.integration.revokeHospitalIntegrationCredential(c.user("user-admin"), issued.credential.id, revoke); const afterRevoke = c.store.getState();
    expect(await c.integration.revokeHospitalIntegrationCredential(c.user("user-admin"), issued.credential.id, revoke)).toEqual(revoked); expect(c.store.getState()).toEqual(afterRevoke);
    await expect(c.integration.rotateHospitalIntegrationCredential(c.user("user-admin"), issued.credential.id, { ...rotate, expectedVersion: 3, idempotencyKey: "cannot-reactivate" })).rejects.toMatchObject({ code: "INTEGRATION_CREDENTIAL_REVOKED", status: 409 });
    await expect(c.receive(rotated.token!)).rejects.toMatchObject({ status: 401 }); expect(c.store.getState().hospitalIntakes).toHaveLength(0);
  });
  it("requires an enabled native actor at issuance and rotation, with opaque errors for absent credentials", async () => {
    const c = setup(); await c.store.transaction(state => ({ state: { ...state, users: state.users.map(user => user.id === "user-vet" ? { ...user, mustChangePassword: true } : user) }, result: undefined }));
    await expect(c.issue()).rejects.toMatchObject({ code: "PASSWORD_CHANGE_REQUIRED", status: 403 });
    await expect(c.integration.createHospitalIntegrationCredential(c.user("user-admin"), { ...c.input, actorUserId: "missing-actor", idempotencyKey: "missing-actor" })).rejects.toMatchObject({ status: 401 });
    await c.store.transaction(state => ({ state: { ...state, users: state.users.map(user => user.id === "user-vet" ? { ...user, mustChangePassword: false } : user) }, result: undefined })); const issued = await c.issue();
    await c.store.transaction(state => ({ state: { ...state, users: state.users.map(user => user.id === "user-vet" ? { ...user, mustChangePassword: true } : user) }, result: undefined })); const before = c.store.getState();
    await expect(c.integration.rotateHospitalIntegrationCredential(c.user("user-admin"), issued.credential.id, { expectedVersion: 1, ttlSeconds: 300, idempotencyKey: "disabled-rotate" })).rejects.toMatchObject({ code: "PASSWORD_CHANGE_REQUIRED", status: 403 });
    await expect(c.receive(issued.token!)).rejects.toMatchObject({ code: "PASSWORD_CHANGE_REQUIRED", status: 403 }); expect(c.store.getState()).toEqual(before);
    await expect(c.integration.rotateHospitalIntegrationCredential(c.user("user-admin"), "missing", { expectedVersion: 1, ttlSeconds: 300, idempotencyKey: "missing-rotate" })).rejects.toMatchObject({ status: 404 });
    await expect(c.integration.revokeHospitalIntegrationCredential(c.user("user-admin"), "missing", { expectedVersion: 1, reason: "Sem alvo", idempotencyKey: "missing-revoke" })).rejects.toMatchObject({ status: 404 });
  });
  it("filters manager metadata by delegation and excludes unready actors without granting directory access", async () => {
    const c = setup(); await c.issue();
    await c.store.transaction(state => ({ state: { ...state, users: state.users.map(user => user.id === "user-manager" ? { ...user, departmentCode: "LABORATORY", managedDepartmentCodes: ["LABORATORY"] } : user.id === "user-us" ? { ...user, active: false } : user.id === "user-rx" ? { ...user, mustChangePassword: true } : user) }, result: undefined }));
    const options = await c.integration.getHospitalIntegrationOptions(c.user("user-manager"), "LIS"); expect(options.departments.map(department => department.code)).toEqual(["LABORATORY"]); expect(options.actors).toContainEqual(expect.objectContaining({ id: "user-lab" })); expect(options.actors.map(actor => actor.id)).not.toContain("user-vet");
    expect(await c.integration.listHospitalIntegrationCredentials(c.user("user-manager"))).toEqual([]); expect(JSON.stringify(options)).not.toMatch(/passwordHash|patientIds|whatsapp/);
    await expect(c.integration.getHospitalIntegrationOptions(c.user("user-admin"), "UNKNOWN" as HospitalIntegrationSystem)).rejects.toMatchObject({ status: 400 });
  });
  it("does not claim capabilities when current grants or configured transport are invalid", async () => {
    const c = setup(); const invalid = createHospitalIntegrationService(c.context, { config: system => ({ ...externalConfig(system), endpoint: "http://unsafe.example.invalid" }) });
    expect(await invalid.getHospitalIntegrationCapabilities(c.user("user-admin"))).toEqual(["HIS", "LIS", "PACS"].map(system => ({ system, contract: "CVG_OPERATIONAL_V1", configured: false, deploymentVerified: false, reason: "CONFIGURATION_INVALID" })));
    await expect(invalid.createHospitalIntegrationCredential(c.user("user-admin"), c.input)).rejects.toMatchObject({ code: "INTEGRATION_CONFIGURATION_INVALID", status: 503 });
    await c.store.transaction(state => ({ state: { ...state, accessGroups: state.accessGroups.map(group => group.id === systemGroupId("ADMIN") ? { ...group, permissions: group.permissions.filter(permission => permission !== "integration.manage") } : group) }, result: undefined }));
    await expect(c.integration.getHospitalIntegrationCapabilities(c.user("user-admin"))).rejects.toMatchObject({ status: 404 });
  });
  it("enforces credential patient bounds and the actor's current grants before native intake or cached replay", async () => {
    const c = setup(); const issued = await c.issue();
    await expect(c.receive("malformed-token")).rejects.toMatchObject({ status: 401 });
    await expect(c.receive(issued.token!, "patient-mel", "encounter-mel")).rejects.toMatchObject({ status: 404 }); expect(c.store.getState().hospitalIntakes).toHaveLength(0);
    await c.receive(issued.token!); await c.store.transaction(state => ({ state: { ...state, users: state.users.map(user => user.id === "user-vet" ? { ...user, patientIds: ["patient-mel"] } : user) }, result: undefined }));
    await expect(c.receive(issued.token!)).rejects.toMatchObject({ status: 404 }); expect(c.store.getState().hospitalIntakes).toHaveLength(1);
  });
  it("does not issue a HIS v4 credential before its discovery configuration exists", async () => {
    const c = setup(); const disabled = createHospitalIntegrationService(c.context, { config: externalConfig, hisV4Config: () => undefined });
    await expect(disabled.createHospitalIntegrationCredential(c.user("user-admin"), { ...c.input, profile: "HIS_V4", idempotencyKey: "missing-v4" })).rejects.toMatchObject({ code: "HIS_V4_NOT_CONFIGURED", status: 503 }); expect(c.store.getState().hospitalIntegrationCredentials).toHaveLength(0);
  });
});
