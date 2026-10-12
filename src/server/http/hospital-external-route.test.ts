import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GET, POST } from "../../app/api/v1/[...path]/route";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { loginUser } from "../security/session";
import { resetRateLimits } from "../security/rate-limit";
import { systemGroupId } from "../security/access-group-policy";
import { EXTERNAL_NOW, EXTERNAL_SECRET, rich } from "../../test/hospital-external-fixtures";
import * as transport from "../application/hospital-integration-http";
import * as aiTransport from "../application/hospital-ai-http";
const password = "hospital-external-http-test-only";
let directory: string;
async function setup() {
  const store = new MemoryStore(createDemoState(password)); globalThis.__cvgDiagnosticsStore = store; globalThis.__cvgDiagnosticsStorePromise = undefined; const sessions = new Map<string, Record<string, string>>(); let sequence = 0;
  const send = async (actorId: string | undefined, method: "GET" | "POST", path: string, body?: unknown, headers: Record<string, string> = {}, raw?: string) => {
    let session: Record<string, string> = {}; if (actorId) { if (!sessions.has(actorId)) { const login = await loginUser(store, store.getState().users.find(user => user.id === actorId)!.email, password); sessions.set(actorId, { cookie: `cvg_session=${login.sessionToken}; cvg_csrf=${login.csrfToken}`, origin: "http://localhost", "x-csrf-token": login.csrfToken }); } session = sessions.get(actorId)!; }
    const request = new Request(`http://localhost/api/v1/${path}`, { method, headers: { "content-type": "application/json", "idempotency-key": `external-http-${++sequence}`, ...session, ...headers }, ...(raw !== undefined ? { body: raw } : body === undefined ? {} : { body: JSON.stringify(body) }) }); const response = await ({ GET, POST })[method](request, { params: Promise.resolve({ path: path.split("?")[0].split("/") }) }); return { status: response.status, envelope: await response.json() };
  };
  const issue = () => send("user-admin", "POST", "hospital-integration-credentials", { system: "HIS", purpose: "HIS_INTAKE", actorUserId: "user-vet", name: "Synthetic HTTP credential", scope: { departmentCodes: ["INPATIENT"] }, ttlSeconds: 300 });
  const incoming = { contract: "CVG_OPERATIONAL_V1", messageId: "http-message", externalEntityId: "http-entity", sequence: 1, occurredAt: EXTERNAL_NOW, purpose: "HIS_INTAKE", payload: { title: "Demanda sintética HTTP", departmentCode: "INPATIENT", priority: "ROUTINE" } };
  const receive = (token: string, body = incoming) => { const raw = JSON.stringify(body); return send(undefined, "POST", "hospital-integrations/HIS/ingress", undefined, { authorization: `Bearer ${token}`, "x-hub-signature-256": `sha256=${createHmac("sha256", EXTERNAL_SECRET).update(raw).digest("hex")}` }, raw); };
  return { store, send, issue, receive, incoming };
}
describe.sequential("dedicated integration and optional assistance HTTP contract", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(EXTERNAL_NOW); resetRateLimits(); vi.stubEnv("APP_DATA_MODE", "memory"); vi.stubEnv("OUTBOX_INLINE_LOCAL", "false"); vi.stubEnv("HOSPITAL_AI_ENABLED", "false"); directory = mkdtempSync(join(tmpdir(), "cvg-external-http-")); const token = join(directory, "token"); const secret = join(directory, "secret"); writeFileSync(token, EXTERNAL_SECRET, { mode: 0o600 }); writeFileSync(secret, EXTERNAL_SECRET, { mode: 0o600 });
    for (const system of ["HIS", "LIS", "PACS"]) { const values = { ENABLED: "true", ENDPOINT: "https://vendor.example.test/contract", ALLOWED_HOSTS: "vendor.example.test", ALLOWED_IPS: "127.0.0.1", TOKEN_FILE: token, HMAC_SECRET_FILE: secret, CONTRACT_REFERENCE: "synthetic-http-contract", TIMEOUT_MS: "1000", CA_FILE: "" }; for (const [key, value] of Object.entries(values)) vi.stubEnv(`HOSPITAL_INTEGRATION_${system}_${key}`, value); }
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs(); delete globalThis.__cvgDiagnosticsStore; delete globalThis.__cvgDiagnosticsStorePromise; delete globalThis.__cvgDiagnosticsFileStore; resetRateLimits(); rmSync(directory, { recursive: true, force: true }); });
  it("issues a token once and accepts signed native intake without a browser session or CSRF", async () => {
    const c = await setup(); const options = await c.send("user-admin", "GET", "hospital-integrations/HIS/options"); expect(options.status).toBe(200); expect(options.envelope.data.actors.some((actor: {id:string}) => actor.id === "user-vet")).toBe(true); expect(JSON.stringify(options.envelope)).not.toMatch(/passwordHash|tokenHash/);
    const issued = await c.issue(); expect(issued.status, JSON.stringify(issued.envelope.error)).toBe(201); const token = issued.envelope.data.token; const receipt = await c.receive(token); expect(receipt.status, JSON.stringify(receipt.envelope.error)).toBe(200); expect(receipt.envelope.data).toMatchObject({ status: "SUCCEEDED", targetType: "HOSPITAL_INTAKE" }); expect((await c.receive(token)).envelope.data).toEqual(receipt.envelope.data); expect(c.store.getState().hospitalIntakes).toHaveLength(1); expect(JSON.stringify(receipt.envelope)).not.toMatch(/tokenHash|payloadHash|Demanda sintética/); expect(JSON.stringify(c.store.getState())).not.toContain(token);
    expect((await c.receive(token, { ...c.incoming, payload: { ...c.incoming.payload, title: "Other content" } })).status).toBe(409); const generic = await c.send(undefined, "GET", "patients", undefined, { authorization: `Bearer ${token}` }); expect(generic.status).toBe(401);
  });
  it("enforces header-only credential concurrency and rejects the old or revoked token", async () => {
    const c = await setup(); const issued = await c.issue(); const credentialId = issued.envelope.data.credential.id; const rotated = await c.send("user-admin", "POST", `hospital-integration-credentials/${credentialId}/rotate`, { ttlSeconds: 300 }, { "if-match": '"1"' }); expect(rotated.status, JSON.stringify(rotated.envelope.error)).toBe(200); expect((await c.receive(issued.envelope.data.token)).status).toBe(401); expect((await c.receive(rotated.envelope.data.token)).status).toBe(200);
    expect((await c.send("user-admin", "POST", `hospital-integration-credentials/${credentialId}/revoke`, { reason: "Synthetic" }, { "if-match": '"1"' })).status).toBe(409); expect((await c.send("user-admin", "POST", `hospital-integration-credentials/${credentialId}/revoke`, { reason: "Synthetic" }, { "if-match": '"2"' })).status).toBe(200); expect((await c.receive(rotated.envelope.data.token)).status).toBe(401);
  });
  it("checks signature, current grants, dedicated size limit and disabled configuration", async () => {
    const c = await setup(); const issued = await c.issue(); const token = issued.envelope.data.token; expect((await c.send(undefined, "POST", "hospital-integrations/HIS/ingress", c.incoming, { authorization: `Bearer ${token}`, "x-hub-signature-256": "sha256=" + "0".repeat(64) })).status).toBe(401); expect((await c.send(undefined, "POST", "hospital-integrations/HIS/ingress", undefined, { authorization: `Bearer ${token}`, "x-hub-signature-256": "sha256=" + "0".repeat(64) }, "x".repeat(2_000_001))).status).toBe(413);
    await c.receive(token); await c.store.transaction(state => ({ state: { ...state, accessGroups: state.accessGroups.map(group => group.id === systemGroupId("VETERINARIAN") ? { ...group, permissions: group.permissions.filter(permission => permission !== "integration.exchange") } : group) }, result: undefined })); expect((await c.receive(token)).status).toBe(404); vi.stubEnv("HOSPITAL_INTEGRATION_HIS_ENABLED", "false"); expect((await c.receive(token)).status).toBe(503);
  });
  it("rejects a non-JSON transport, malformed UTF-8 and interrupted input before claiming a provider message", async () => {
    const c = await setup(); const issued = await c.issue(); const token = issued.envelope.data.token;
    const path = ["hospital-integrations", "HIS", "ingress"];
    const headers = { authorization: `Bearer ${token}`, "x-hub-signature-256": `sha256=${"0".repeat(64)}`, "idempotency-key": "invalid-transport", "content-type": "application/json" };
    expect((await c.send(undefined, "POST", "hospital-integrations/UNKNOWN/ingress", c.incoming, headers)).status).toBe(400);
    expect((await c.send(undefined, "POST", path.join("/"), c.incoming, { "x-hub-signature-256": headers["x-hub-signature-256"] })).status).toBe(401);
    expect((await c.send(undefined, "POST", path.join("/"), c.incoming, { authorization: headers.authorization })).status).toBe(401);
    expect((await c.send(undefined, "POST", path.join("/"), c.incoming, { ...headers, "content-type": "text/plain" })).status).toBe(415);
    const malformed = new Request(`http://localhost/api/v1/${path.join("/")}`, { method: "POST", headers, body: new Uint8Array([0xc3, 0x28]) });
    expect((await POST(malformed, { params: Promise.resolve({ path }) })).status).toBe(400);
    const interrupted = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("SYNTHETIC_BODY_INTERRUPTED")); } });
    const broken = new Request(`http://localhost/api/v1/${path.join("/")}`, { method: "POST", headers, body: interrupted, duplex: "half" } as RequestInit & { duplex: "half" });
    const failed = await POST(broken, { params: Promise.resolve({ path }) }); expect(failed.status).toBe(500); expect(JSON.stringify(await failed.json())).not.toContain("SYNTHETIC_BODY_INTERRUPTED");
    expect(c.store.getState().hospitalIntegrationMessages).toEqual([]); expect(c.store.getState().hospitalIntakes).toEqual([]);
  });
  it("keeps optional assistance off and refuses a suggestion rather than reporting a fabricated provider delivery", async () => {
    const c = await setup(); const capability = await c.send("user-admin", "GET", "hospital-assistance/capability"); expect(capability.status).toBe(200); expect(capability.envelope.data).toMatchObject({ configured: false, deploymentVerified: false, requiresHumanReview: true }); const doc = await c.send("user-admin", "POST", "hospital-documents", { code: "AI_HTTP", title: "Synthetic", departmentCode: "INPATIENT", responsibleUserId: "user-vet", content: rich("Original") }); expect(doc.status).toBe(201); const request = await c.send("user-admin", "POST", `hospital-documents/${doc.envelope.data.document.id}/assistance`, { confirmTransmission: true, instruction: "Synthetic text", expectedDraftVersion: 1 }, { "if-match": '"1"' }); expect(request.status, JSON.stringify(request.envelope.error)).toBe(503); expect(c.store.getState().hospitalAiSuggestions).toHaveLength(0); expect(c.store.getState().hospitalDocuments[0].revisions[0].content).toEqual(rich("Original"));
  });
  it("lists capability and real receipts, retries an outbound failure with the same remote identity and hides another actor's receipts", async () => {
    const send = vi.spyOn(transport, "sendHospitalIntegrationHttp").mockRejectedValueOnce(new transport.HospitalIntegrationHttpError("INTEGRATION_NETWORK_UNAVAILABLE", true)).mockImplementation(async (_config, envelope) => ({ contract: "CVG_OPERATIONAL_V1", messageId: envelope.messageId, receiptId: "disposable-http-retry-receipt", status: "ACCEPTED" }));
    const c = await setup(); const capability = await c.send("user-admin", "GET", "hospital-integrations/capabilities"); expect(capability.status).toBe(200); expect(capability.envelope.data.every((entry: { deploymentVerified: boolean }) => entry.deploymentVerified === false)).toBe(true);
    const issued = await c.issue(); expect((await c.send("user-admin", "GET", "hospital-integration-credentials")).envelope.data).toHaveLength(1);
    const inbound = await c.receive(issued.envelope.data.token);
    const failed = await c.send("user-vet", "POST", "hospital-integrations/exchange", { system: "HIS", targetType: "HOSPITAL_INTAKE", targetId: inbound.envelope.data.targetId, messageId: "http-outbound", externalEntityId: "http-outbound-entity", sequence: 1 }, { "if-match": '"1"' });
    expect(failed.status).toBe(200); expect(failed.envelope.data).toMatchObject({ status: "FAILED", retryable: true });
    const page = await c.send("user-vet", "GET", "hospital-integrations/messages?system=HIS&direction=OUTBOUND&status=FAILED&limit=1"); expect(page.status).toBe(200); expect(page.envelope.data.items.map((entry: { id: string }) => entry.id)).toEqual([failed.envelope.data.id]);
    expect((await c.send("user-lab", "GET", "hospital-integrations/messages")).envelope.data.items).toEqual([]);
    vi.setSystemTime(Date.parse(EXTERNAL_NOW) + 30_000);
    const retried = await c.send("user-vet", "POST", `hospital-integrations/messages/${failed.envelope.data.id}/retry`, {}, { "if-match": `"${failed.envelope.data.version}"` }); expect(retried.status).toBe(200); expect(retried.envelope.data).toMatchObject({ status: "SUCCEEDED", attempts: 2, remoteReceiptId: "disposable-http-retry-receipt" });
    expect(send).toHaveBeenCalledTimes(2); expect(send.mock.calls[0][1]).toEqual(send.mock.calls[1][1]); expect(c.store.getState().hospitalTasks).toEqual([]);
  });
  it("receives a reviewable assistance suggestion and applies it only to the current unpublished draft", async () => {
    const send = vi.spyOn(aiTransport, "sendHospitalAiHttp").mockImplementation(async (_config, envelope) => ({ contract: "CVG_DOCUMENT_ASSISTANCE_V1", messageId: envelope.messageId, receiptId: "disposable-ai-http-receipt", model: "synthetic-model", content: rich("Texto proposto sintético") }));
    vi.spyOn(aiTransport, "hospitalAiHttpConfigFromEnv").mockReturnValue({ transport: { system: "HIS", endpoint: "https://vendor.example.test/contract", allowedHosts: ["vendor.example.test"], allowedIps: ["127.0.0.1"], bearerToken: EXTERNAL_SECRET, hmacSecret: EXTERNAL_SECRET, contractReference: "synthetic-http-contract", timeoutMs: 1000 }, provider: "synthetic-provider", model: "synthetic-model", decisionReference: "SYNTHETIC_TEST_ONLY" });
    const c = await setup(); const created = await c.send("user-admin", "POST", "hospital-documents", { code: "HTTP_AI_REVIEW", title: "Texto sintético", departmentCode: "INPATIENT", responsibleUserId: "user-vet", content: rich("Original") }); const documentId = created.envelope.data.document.id;
    const suggestion = await c.send("user-admin", "POST", `hospital-documents/${documentId}/assistance`, { confirmTransmission: true, instruction: "Melhorar texto operacional sintético", expectedDraftVersion: 1 }, { "if-match": '"1"' }); expect(suggestion.status).toBe(200); expect(suggestion.envelope.data.status).toBe("PENDING_REVIEW");
    expect(c.store.getState().hospitalDocuments[0].revisions[0].content).toEqual(rich("Original"));
    expect((await c.send("user-admin", "GET", `hospital-documents/${documentId}/assistance`)).envelope.data.map((row: { id: string }) => row.id)).toEqual([suggestion.envelope.data.id]);
    const reviewed = await c.send("user-admin", "POST", `hospital-assistance/${suggestion.envelope.data.id}/review`, { decision: "APPLY", confirm: true, reason: "Revisão humana exclusivamente sintética", expectedDocumentVersion: 1, expectedDraftVersion: 1 }, { "if-match": '"1"' }); expect(reviewed.status).toBe(200); expect(reviewed.envelope.data.status).toBe("APPLIED");
    expect(c.store.getState().hospitalDocuments[0].version).toBe(2); expect(c.store.getState().hospitalDocuments[0].currentPublishedRevisionId).toBeUndefined(); expect(c.store.getState().hospitalDocuments[0].revisions[0]).toMatchObject({ status: "DRAFT", content: rich("Texto proposto sintético") }); expect(send).toHaveBeenCalledTimes(1);
  });
});
