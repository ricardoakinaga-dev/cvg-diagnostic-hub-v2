import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:https";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { externalConfig, EXTERNAL_SECRET, rich } from "../../test/hospital-external-fixtures";
import { hospitalIntegrationHttpConfigFromEnv, sendHospitalIntegrationHttp, validateHospitalIntegrationHttpConfig, verifyHospitalIntegrationSignature } from "./hospital-integration-http";
import { hospitalAiHttpConfigFromEnv, sendHospitalAiHttp } from "./hospital-ai-http";
let directory: string; let server: Server; let endpoint: string; let ca: string; let reply: "ACCEPT" | "WRONG_ID" | "REDIRECT" | "OVERSIZED" | "AI" | "AI_WRONG_ID" = "ACCEPT";
const received: Array<{ body: string; authorization?: string; signature?: string; idempotencyKey?: string }> = [];
const resolve = (async () => [{ address: "127.0.0.1", family: 4 }]);
const envelope = { contract: "CVG_OPERATIONAL_V1" as const, messageId: "isolated-tls-message", purpose: "HIS_INTAKE", payload: { synthetic: true } };
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "cvg-external-tls-test-")); const cert = join(directory, "certificate.pem"); const key = join(directory, "key.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", key, "-out", cert], { stdio: "ignore", timeout: 10_000 }); ca = readFileSync(cert, "utf8");
  server = createServer({ key: readFileSync(key), cert: ca }, (request, response) => { const chunks: Buffer[] = []; request.on("data", chunk => chunks.push(chunk)); request.on("end", () => { const body = Buffer.concat(chunks).toString("utf8"); received.push({ body, authorization: request.headers.authorization, signature: request.headers["x-cvg-signature"] as string, idempotencyKey: request.headers["idempotency-key"] as string }); const message = JSON.parse(body);
    if (reply === "REDIRECT") { response.writeHead(302, { location: "https://unapproved.example.invalid" }).end(); return; } if (reply === "OVERSIZED") { response.writeHead(200).end("x".repeat(100_000)); return; }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply === "AI" || reply === "AI_WRONG_ID" ? { contract: "CVG_DOCUMENT_ASSISTANCE_V1", messageId: reply === "AI_WRONG_ID" ? "wrong-ai-id" : message.messageId, receiptId: "disposable-ai-receipt", model: "synthetic-model", content: rich("Texto de ensaio TLS") } : { contract: "CVG_OPERATIONAL_V1", messageId: reply === "WRONG_ID" ? "wrong" : message.messageId, receiptId: "disposable-real-http-receipt", status: "ACCEPTED" })); }); }); server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); if (!address || typeof address === "string") throw new Error("TEST_BIND_FAILED"); endpoint = `https://localhost:${address.port}/contract`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); });
const config = () => ({ ...externalConfig("HIS"), endpoint, allowedHosts: ["localhost"], ca });
describe.sequential("concrete pinned HTTPS integration adapters", () => {
  it("sends signed HTTPS to the approved IP and accepts only the receiver's matching receipt", async () => {
    reply = "ACCEPT"; const receipt = await sendHospitalIntegrationHttp(config(), envelope, { resolve }); expect(receipt).toMatchObject({ receiptId: "disposable-real-http-receipt", status: "ACCEPTED" }); const last = received.at(-1)!; expect(last.authorization).toBe(`Bearer ${EXTERNAL_SECRET}`); expect(last.idempotencyKey).toBe(envelope.messageId); expect(last.signature).toBe(`sha256=${createHmac("sha256", EXTERNAL_SECRET).update(last.body).digest("hex")}`); expect(verifyHospitalIntegrationSignature(last.body, last.signature!, EXTERNAL_SECRET)).toBe(true);
  });
  it("blocks DNS rebinding, unsafe configuration and unknown CA before treating delivery as successful", async () => {
    const before = received.length; await expect(sendHospitalIntegrationHttp(config(), envelope, { resolve: (async () => [{ address: "127.0.0.1", family: 4 }, { address: "192.0.2.1", family: 4 }]) })).rejects.toMatchObject({ code: "INTEGRATION_DNS_NOT_APPROVED", retryable: false }); expect(received).toHaveLength(before);
    expect(() => validateHospitalIntegrationHttpConfig({ ...config(), endpoint: "http://localhost/contract" })).toThrow(); expect(() => validateHospitalIntegrationHttpConfig({ ...config(), endpoint: "https://user:password@localhost/contract" })).toThrow(); await expect(sendHospitalIntegrationHttp({ ...config(), ca: undefined }, envelope, { resolve })).rejects.toMatchObject({ code: "INTEGRATION_NETWORK_UNAVAILABLE" }); expect(received).toHaveLength(before);
  });
  it("does not follow redirects or accept mismatched or oversized receipts", async () => {
    reply = "REDIRECT"; await expect(sendHospitalIntegrationHttp(config(), envelope, { resolve })).rejects.toMatchObject({ code: "INTEGRATION_HTTP_302", retryable: false }); reply = "WRONG_ID"; await expect(sendHospitalIntegrationHttp(config(), envelope, { resolve })).rejects.toMatchObject({ code: "INTEGRATION_RECEIPT_INVALID" }); reply = "OVERSIZED"; await expect(sendHospitalIntegrationHttp(config(), envelope, { resolve })).rejects.toMatchObject({ code: "INTEGRATION_RESPONSE_TOO_LARGE" });
  });
  it("uses the same verified HTTPS transport for a reviewable AI response", async () => {
    reply = "AI"; const response = await sendHospitalAiHttp({ transport: { ...config(), endpoint: endpoint.replace("localhost", "127.0.0.1"), allowedHosts: ["127.0.0.1"] }, provider: "synthetic-provider", model: "synthetic-model", decisionReference: "test-only-decision" }, { contract: "CVG_DOCUMENT_ASSISTANCE_V1", messageId: "ai-disposable", content: rich("Input") }); expect(response).toMatchObject({ receiptId: "disposable-ai-receipt", model: "synthetic-model", content: rich("Texto de ensaio TLS") });
  });
  it("refuses unrelated AI receipts or models over real disposable TLS instead of accepting text as a provider result", async () => {
    const aiConfig = { transport: { ...config(), endpoint: endpoint.replace("localhost", "127.0.0.1"), allowedHosts: ["127.0.0.1"] }, provider: "synthetic-provider", model: "synthetic-model", decisionReference: "test-only-decision" };
    const input = { contract: "CVG_DOCUMENT_ASSISTANCE_V1" as const, messageId: "ai-bound-identity", content: rich("Input") };
    reply = "AI_WRONG_ID"; await expect(sendHospitalAiHttp(aiConfig, input)).rejects.toMatchObject({ code: "AI_RESPONSE_INVALID", status: 502 });
    reply = "AI"; await expect(sendHospitalAiHttp({ ...aiConfig, model: "another-configured-model" }, input)).rejects.toMatchObject({ code: "AI_RESPONSE_INVALID", status: 502 });
    reply = "ACCEPT"; await expect(sendHospitalAiHttp(aiConfig, input)).rejects.toMatchObject({ code: "AI_RESPONSE_INVALID", status: 502 });
  });
  it("loads optional assistance only from private transport files and an explicit institutional purpose", () => {
    expect(hospitalAiHttpConfigFromEnv({})).toBeUndefined();
    const token = join(directory, "ai-token.txt"); const secret = join(directory, "ai-hmac.txt"); writeFileSync(token, EXTERNAL_SECRET, { mode: 0o600 }); writeFileSync(secret, EXTERNAL_SECRET, { mode: 0o600 });
    const environment = { HOSPITAL_AI_ENABLED: "true", HOSPITAL_AI_PROVIDER: "synthetic-provider", HOSPITAL_AI_MODEL: "synthetic-model", HOSPITAL_AI_DECISION_REFERENCE: "SYNTHETIC_TEST_ONLY", HOSPITAL_AI_PURPOSE: "OPERATIONAL_DOCUMENT_TEXT", HOSPITAL_AI_ENDPOINT: endpoint, HOSPITAL_AI_ALLOWED_HOSTS: "localhost", HOSPITAL_AI_ALLOWED_IPS: "127.0.0.1", HOSPITAL_AI_TOKEN_FILE: token, HOSPITAL_AI_HMAC_SECRET_FILE: secret };
    expect(hospitalAiHttpConfigFromEnv(environment)).toMatchObject({ provider: "synthetic-provider", model: "synthetic-model", decisionReference: "SYNTHETIC_TEST_ONLY", transport: { endpoint } });
    for (const invalid of [{ HOSPITAL_AI_PROVIDER: "" }, { HOSPITAL_AI_PROVIDER: "x".repeat(101) }, { HOSPITAL_AI_MODEL: "" }, { HOSPITAL_AI_MODEL: "x".repeat(101) }, { HOSPITAL_AI_DECISION_REFERENCE: "" }, { HOSPITAL_AI_DECISION_REFERENCE: "x".repeat(501) }, { HOSPITAL_AI_PURPOSE: "CLINICAL_EXECUTION" }, { HOSPITAL_AI_ENDPOINT: "http://localhost/contract" }]) expect(() => hospitalAiHttpConfigFromEnv({ ...environment, ...invalid })).toThrow(expect.objectContaining({ code: "AI_CONFIGURATION_INVALID", status: 503 }));
  });
  it("requires private secret files and defaults capabilities off", () => {
    expect(hospitalIntegrationHttpConfigFromEnv("HIS", {})).toBeUndefined(); const token = join(directory, "token.txt"); const secret = join(directory, "hmac.txt"); writeFileSync(token, EXTERNAL_SECRET, { mode: 0o600 }); writeFileSync(secret, EXTERNAL_SECRET, { mode: 0o600 }); const environment = { HOSPITAL_INTEGRATION_HIS_ENABLED: "true", HOSPITAL_INTEGRATION_HIS_ENDPOINT: endpoint, HOSPITAL_INTEGRATION_HIS_ALLOWED_HOSTS: "localhost", HOSPITAL_INTEGRATION_HIS_ALLOWED_IPS: "127.0.0.1", HOSPITAL_INTEGRATION_HIS_TOKEN_FILE: token, HOSPITAL_INTEGRATION_HIS_HMAC_SECRET_FILE: secret, HOSPITAL_INTEGRATION_HIS_CONTRACT_REFERENCE: "test-only-contract" }; expect(hospitalIntegrationHttpConfigFromEnv("HIS", environment)?.endpoint).toBe(endpoint); writeFileSync(join(directory, "public-token.txt"), EXTERNAL_SECRET, { mode: 0o644 }); expect(() => hospitalIntegrationHttpConfigFromEnv("HIS", { ...environment, HOSPITAL_INTEGRATION_HIS_TOKEN_FILE: join(directory, "public-token.txt") })).toThrow();
  });
});
