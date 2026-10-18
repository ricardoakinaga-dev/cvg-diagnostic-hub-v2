import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GET, POST } from "../../app/api/v1/[...path]/route";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { loginUser } from "../security/session";
import { resetRateLimits } from "../security/rate-limit";
import { systemGroupId } from "../security/access-group-policy";
import { EXTERNAL_NOW, EXTERNAL_SECRET } from "../../test/hospital-external-fixtures";
import { hisV4Catalog, hisV4Config, hisV4Event, hisV4Signed } from "../../test/hospital-his-v4-fixtures";
import * as http from "../application/hospital-his-v4-http";
import { producePinnedHisV4Webhook } from "../../test/his-v4-pinned-producer";

let directory: string; const password = "synthetic-his-v4-route-test";
async function setup() {
  const store = new MemoryStore(createDemoState(password)); globalThis.__cvgDiagnosticsStore = store; globalThis.__cvgDiagnosticsStorePromise = undefined;
  const sessions = new Map<string, Record<string, string>>(); let key = 0;
  const send = async (actorId: string | undefined, method: "GET" | "POST", path: string, body?: unknown, headers: Record<string, string> = {}, raw?: string) => {
    let session: Record<string, string> = {}; if (actorId) { if (!sessions.has(actorId)) { const result = await loginUser(store, store.getState().users.find(user => user.id === actorId)!.email, password); sessions.set(actorId, { cookie: `cvg_session=${result.sessionToken}; cvg_csrf=${result.csrfToken}`, origin: "http://localhost", "x-csrf-token": result.csrfToken }); } session = sessions.get(actorId)!; }
    const request = new Request(`http://localhost/api/v1/${path}`, { method, headers: { "content-type": "application/json", "idempotency-key": `his-v4-http-${++key}`, ...session, ...headers }, ...(raw === undefined ? body === undefined ? {} : { body: JSON.stringify(body) } : { body: raw }) }); const response = await ({ GET, POST })[method](request, { params: Promise.resolve({ path: path.split("/") }) }); return { status: response.status, envelope: await response.json() };
  };
  const issue = async () => { const result = await send("user-admin", "POST", "hospital-integration-credentials", { profile: "HIS_V4", system: "HIS", purpose: "HIS_INTAKE", actorUserId: "user-vet", name: "Synthetic HIS v4", scope: { departmentCodes: ["INPATIENT"], patientIds: ["patient-thor"] }, ttlSeconds: 300 }); if (result.status !== 201) throw new Error(`CREDENTIAL_ISSUANCE_FAILED:${result.envelope.error?.code}`); vi.stubEnv("HOSPITAL_HIS_V4_WEBHOOK_ENABLED", "true"); vi.stubEnv("HOSPITAL_HIS_V4_CREDENTIAL_ID", result.envelope.data.credential.id); return result.envelope.data; };
  const receive = (credentialId: string, event = hisV4Event(), override: Record<string, string> = {}, rawOverride?: string) => { const raw = rawOverride ?? JSON.stringify(event); const signed = hisV4Signed(raw); return send(undefined, "POST", `hospital-integrations/his-v4/webhooks/${credentialId}`, undefined, { "x-webhook-id": signed.webhookId, "x-webhook-event": signed.event, "x-webhook-delivery-id": signed.deliveryId, "x-webhook-signature": signed.signature, "x-webhook-timestamp": signed.timestamp, "x-webhook-signature-version": signed.signatureVersion, "idempotency-key": signed.idempotencyKey, ...override }, raw); };
  return { store, send, issue, receive };
}
describe.sequential("HIS v4 HTTP authentication and native command contract", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(EXTERNAL_NOW); vi.stubEnv("APP_DATA_MODE", "memory"); vi.stubEnv("OUTBOX_INLINE_LOCAL", "false"); vi.stubEnv("HOSPITAL_INTEGRATION_HIS_ENABLED", "false"); resetRateLimits(); directory = mkdtempSync(join(tmpdir(), "cvg-his-v4-http-"));
    const key = join(directory, "key"); const secret = join(directory, "secret"); const mappings = join(directory, "mappings.json"); writeFileSync(key, EXTERNAL_SECRET, { mode: 0o600 }); writeFileSync(secret, EXTERNAL_SECRET, { mode: 0o600 }); writeFileSync(mappings, JSON.stringify(hisV4Config().webhook!.mappings), { mode: 0o600 });
    const environment = { ENABLED: "true", CATALOG_ENDPOINT: "https://his.example.test/integrations/catalog", ALLOWED_HOSTS: "his.example.test", ALLOWED_IPS: "127.0.0.1", API_KEY_FILE: key, WEBHOOK_SECRET_FILE: secret, MAPPINGS_FILE: mappings, ACCOUNT_ID: "his_synthetic_account", WEBHOOK_ID: "wh_synthetic", CREDENTIAL_VERSION: "1", CONTRACT_REFERENCE: "source-0ebfc5b-synthetic-http", WEBHOOK_ENABLED: "false", CA_FILE: "" }; for (const [name, value] of Object.entries(environment)) vi.stubEnv(`HOSPITAL_HIS_V4_${name}`, value);
    vi.spyOn(http, "discoverHospitalHisV4Http").mockResolvedValue(hisV4Catalog());
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); delete globalThis.__cvgDiagnosticsStore; delete globalThis.__cvgDiagnosticsStorePromise; delete globalThis.__cvgDiagnosticsFileStore; resetRateLimits(); rmSync(directory, { recursive: true, force: true }); });
  it("discovers the actual advertised catalog only through authorized internal session and no provider secret in response", async () => {
    const c = await setup(); expect((await c.send(undefined, "GET", "hospital-integrations/his-v4/catalog")).status).toBe(401); expect((await c.send("user-lab", "GET", "hospital-integrations/his-v4/catalog")).status).toBe(404); const result = await c.send("user-admin", "GET", "hospital-integrations/his-v4/catalog"); expect(result.status).toBe(200); expect(result.envelope.data).toMatchObject({ profile: "HIS_V4", deploymentVerified: false }); expect(JSON.stringify(result.envelope)).not.toMatch(/apiKeyId|RESEND_API_KEY|tokenHash/); expect(JSON.stringify(result.envelope)).not.toContain(EXTERNAL_SECRET);
    vi.stubEnv("HOSPITAL_HIS_V4_ENABLED", "false"); expect((await c.send("user-admin", "GET", "hospital-integrations/his-v4/catalog")).status).toBe(503);
  });
  it("issues the explicit v4 profile without generic CVG config and receives signed v2 webhook with no session, bearer or CSRF", async () => {
    const c = await setup(); const issued = await c.issue(); expect(issued.credential.profile).toBe("HIS_V4"); const received = await c.receive(issued.credential.id); expect(received.status, JSON.stringify(received.envelope.error)).toBe(200); expect(received.envelope.data).toMatchObject({ profile: "HIS_V4_WEBHOOK_V2", status: "RECEIVED_FOR_TRIAGE" }); expect((await c.receive(issued.credential.id, hisV4Event(), { "x-webhook-delivery-id": "http-redelivery", "idempotency-key": "http-redelivery" })).envelope.data).toEqual(received.envelope.data); expect(c.store.getState().hospitalIntakes).toHaveLength(1); expect(c.store.getState().hospitalHisV4Deliveries).toHaveLength(1);
    expect(JSON.stringify(received.envelope)).not.toMatch(/patient-thor|encounter-thor|Demanda|sequence|payloadHash/); expect((await c.send(undefined, "GET", "patients", undefined, { authorization: `Bearer ${issued.token}` })).status).toBe(401);
  });
  it("receives all seven actual producer headers and the unchanged signed body with metadata for native mapped triage only", async () => {
    const c = await setup(); const issued = await c.issue(); const producer = await producePinnedHisV4Webhook();
    const nativeHeaders = Object.fromEntries(Object.entries(producer.nativeHeaders).map(([key, value]) => [key.toLowerCase(), value]));
    const received = await c.receive(issued.credential.id, producer.event, nativeHeaders, producer.rawBody);
    expect(received.status, JSON.stringify(received.envelope.error)).toBe(200);
    expect(received.envelope.data).toMatchObject({ profile: "HIS_V4_WEBHOOK_V2", status: "RECEIVED_FOR_TRIAGE", providerPayloadId: producer.event.id });
    expect(c.store.getState().hospitalIntakes).toHaveLength(1); expect(c.store.getState().hospitalHisV4Deliveries).toHaveLength(1);
    expect(JSON.stringify(received.envelope)).not.toMatch(/_meta|traceparent|tenantId|his_meta_|patient-thor|encounter-thor/);
    const malformed = { ...producer.event, data: { ...producer.event.data, _meta: { ...producer.event.data._meta, additional: "rejected" } } };
    const failure = await c.receive(issued.credential.id, malformed);
    expect(failure.status).toBe(400); expect(failure.envelope.error.code).toBe("HIS_V4_EVENT_NOT_ADOPTED");
    expect(JSON.stringify(failure.envelope)).not.toMatch(/additional|his_meta_|traceparent|tenantId/);
    expect(c.store.getState().hospitalIntakes).toHaveLength(1);
  });
  it("rejects bad HMAC, timestamp/version/binding, missing headers, nonadopted events and bounded body without native mutation", async () => {
    const c = await setup(); const issued = await c.issue(); expect((await c.receive(issued.credential.id, hisV4Event(), { "x-webhook-signature": "sha256=" + "0".repeat(64) })).status).toBe(401); expect((await c.receive(issued.credential.id, hisV4Event(), { "x-webhook-signature-version": "v1" })).status).toBe(400); expect((await c.receive(issued.credential.id, hisV4Event(), { "idempotency-key": "different-delivery" })).status).toBe(400);
    expect((await c.send(undefined, "POST", `hospital-integrations/his-v4/webhooks/${issued.credential.id}`, hisV4Event())).status).toBe(401); const other = JSON.stringify({ ...hisV4Event(), event: "patient.created" }); expect((await c.receive(issued.credential.id, hisV4Event(), { "x-webhook-event": "patient.created" }, other)).status).toBe(400); expect((await c.receive(issued.credential.id, hisV4Event(), {}, "x".repeat(100_001))).status).toBe(413); expect(c.store.getState().hospitalIntakes).toHaveLength(0);
  });
  it("rejects invalid media, undecodable UTF-8 and interrupted webhook delivery before native mutation", async () => {
    const c = await setup(); const issued = await c.issue(); const raw = JSON.stringify(hisV4Event()); const signed = hisV4Signed(raw);
    const path = ["hospital-integrations", "his-v4", "webhooks", issued.credential.id];
    const headers = { "content-type": "application/json", "idempotency-key": signed.idempotencyKey, "x-webhook-id": signed.webhookId, "x-webhook-event": signed.event, "x-webhook-delivery-id": signed.deliveryId, "x-webhook-signature": signed.signature, "x-webhook-timestamp": signed.timestamp, "x-webhook-signature-version": signed.signatureVersion };
    expect((await c.receive(issued.credential.id, hisV4Event(), { "content-type": "text/plain" })).status).toBe(415);
    const malformed = new Request(`http://localhost/api/v1/${path.join("/")}`, { method: "POST", headers, body: new Uint8Array([0xc3, 0x28]) });
    expect((await POST(malformed, { params: Promise.resolve({ path }) })).status).toBe(400);
    const interrupted = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("SYNTHETIC_WEBHOOK_INTERRUPTED")); } });
    const broken = new Request(`http://localhost/api/v1/${path.join("/")}`, { method: "POST", headers, body: interrupted, duplex: "half" } as RequestInit & { duplex: "half" });
    const failed = await POST(broken, { params: Promise.resolve({ path }) }); expect(failed.status).toBe(500); expect(JSON.stringify(await failed.json())).not.toContain("SYNTHETIC_WEBHOOK_INTERRUPTED");
    expect(c.store.getState().hospitalHisV4Deliveries).toEqual([]); expect(c.store.getState().hospitalIntakes).toEqual([]);
  });
  it("revalidates grants before replay and invalidates the webhook binding after credential rotation", async () => {
    const c = await setup(); const issued = await c.issue(); await c.receive(issued.credential.id); await c.store.transaction(state => ({ state: { ...state, accessGroups: state.accessGroups.map(group => group.id === systemGroupId("VETERINARIAN") ? { ...group, permissions: group.permissions.filter(permission => permission !== "hospital_intake.create") } : group) }, result: undefined })); expect((await c.receive(issued.credential.id)).status).toBe(404);
    const d = await setup(); const next = await d.issue(); const rotated = await d.send("user-admin", "POST", `hospital-integration-credentials/${next.credential.id}/rotate`, { ttlSeconds: 300 }, { "if-match": '"1"' }); expect(rotated.status).toBe(200); expect((await d.receive(next.credential.id)).status).toBe(401); expect(d.store.getState().hospitalIntakes).toHaveLength(0);
  });
});
