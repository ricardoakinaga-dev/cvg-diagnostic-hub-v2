import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:https";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHmac } from "node:crypto";
import { hisV4Config, hisV4Catalog } from "../../test/hospital-his-v4-fixtures";
import { EXTERNAL_SECRET } from "../../test/hospital-external-fixtures";
import { discoverHospitalHisV4Http, verifyHospitalHisV4Signature } from "./hospital-his-v4-http";
import { hospitalHisV4ConfigFromEnv, validateHospitalHisV4Config } from "./hospital-his-v4-config";

let directory: string; let server: Server; let endpoint: string; let ca: string; let reply: "CATALOG" | "REDIRECT" | "OVERSIZED" | "INVALID" = "CATALOG";
const requests: Array<{ method?: string; path?: string; apiKey?: string; authorization?: string; cookie?: string }> = [];
const resolve = async () => [{ address: "127.0.0.1", family: 4 }];
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "cvg-his-v4-tls-")); const cert = join(directory, "certificate.pem"); const key = join(directory, "key.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", key, "-out", cert], { stdio: "ignore", timeout: 10_000 }); ca = readFileSync(cert, "utf8");
  server = createServer({ key: readFileSync(key), cert: ca }, (request, response) => {
    requests.push({ method: request.method, path: request.url, apiKey: request.headers["x-api-key"] as string, authorization: request.headers.authorization, cookie: request.headers.cookie });
    if (reply === "REDIRECT") response.writeHead(302, { location: "https://not-approved.example.invalid/integrations/catalog" }).end();
    else response.writeHead(200, { "content-type": "application/json" }).end(reply === "OVERSIZED" ? "x".repeat(100_001) : reply === "INVALID" ? "not-json" : JSON.stringify(hisV4Catalog()));
  }); server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); if (!address || typeof address === "string") throw new Error("TEST_BIND_FAILED"); endpoint = `https://localhost:${address.port}/integrations/catalog`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); });
const config = () => ({ ...hisV4Config(), endpoint, allowedHosts: ["localhost"], ca });
describe.sequential("actual HIS v4 HTTPS and signature contracts", () => {
  it("requests the exact catalog path over verified TLS with X-API-Key and no browser or bearer credentials", async () => {
    reply = "CATALOG"; expect(await discoverHospitalHisV4Http(config(), { resolve })).toMatchObject({ accountId: "his_synthetic_account", permissions: ["integrations.read"] }); expect(requests.at(-1)).toEqual({ method: "GET", path: "/integrations/catalog", apiKey: EXTERNAL_SECRET, authorization: undefined, cookie: undefined });
    await discoverHospitalHisV4Http({ ...config(), endpoint: endpoint.replace("/integrations/catalog", "/api/integrations/catalog") }, { resolve }); expect(requests.at(-1)?.path).toBe("/api/integrations/catalog");
  });
  it("pins every resolved address and refuses HTTP, credential URLs, path substitution or unknown CA", async () => {
    const before = requests.length; await expect(discoverHospitalHisV4Http(config(), { resolve: async () => [{ address: "127.0.0.1", family: 4 }, { address: "192.0.2.1", family: 4 }] })).rejects.toMatchObject({ code: "HIS_V4_DNS_NOT_APPROVED" }); expect(requests).toHaveLength(before);
    for (const unsafe of ["http://localhost/integrations/catalog", "https://user:password@localhost/integrations/catalog", "https://localhost/patients", "https://localhost/integrations/catalog?credential=secret"]) expect(() => validateHospitalHisV4Config({ ...config(), endpoint: unsafe })).toThrow();
    await expect(discoverHospitalHisV4Http({ ...config(), ca: undefined }, { resolve })).rejects.toMatchObject({ code: "HIS_V4_NETWORK_UNAVAILABLE" }); expect(requests).toHaveLength(before);
  });
  it("never follows redirects or treats malformed and oversized catalogs as success", async () => {
    reply = "REDIRECT"; await expect(discoverHospitalHisV4Http(config(), { resolve })).rejects.toMatchObject({ code: "HIS_V4_HTTP_302" }); reply = "OVERSIZED"; await expect(discoverHospitalHisV4Http(config(), { resolve })).rejects.toMatchObject({ code: "HIS_V4_CATALOG_TOO_LARGE" }); reply = "INVALID"; await expect(discoverHospitalHisV4Http(config(), { resolve })).rejects.toMatchObject({ code: "HIS_V4_CATALOG_INVALID" });
  });
  it("matches HIS signature v2 timestamp.body and the exact 300-second freshness boundary", () => {
    const timestamp = "1791741600"; const body = '{"synthetic":"ação"}'; const signature = `sha256=${createHmac("sha256", EXTERNAL_SECRET).update(`${timestamp}.${body}`).digest("hex")}`; const now = Number(timestamp) * 1000;
    expect(verifyHospitalHisV4Signature(body, signature, timestamp, "v2", EXTERNAL_SECRET, now)).toBe(true); expect(verifyHospitalHisV4Signature(body, signature, timestamp, "v2", EXTERNAL_SECRET, now + 300_000)).toBe(true); expect(verifyHospitalHisV4Signature(body, signature, timestamp, "v2", EXTERNAL_SECRET, now - 300_000)).toBe(true);
    for (const offset of [301_000, -301_000]) expect(verifyHospitalHisV4Signature(body, signature, timestamp, "v2", EXTERNAL_SECRET, now + offset)).toBe(false); expect(verifyHospitalHisV4Signature(body + " ", signature, timestamp, "v2", EXTERNAL_SECRET, now)).toBe(false); expect(verifyHospitalHisV4Signature(body, signature, timestamp, "v1", EXTERNAL_SECRET, now)).toBe(false);
    const legacy = `sha256=${createHmac("sha256", EXTERNAL_SECRET).update(body).digest("hex")}`; expect(verifyHospitalHisV4Signature(body, legacy, timestamp, "v2", EXTERNAL_SECRET, now)).toBe(false);
  });
  it("loads only explicit private files and keeps discovery and webhook defaults off", () => {
    expect(hospitalHisV4ConfigFromEnv({})).toBeUndefined(); const key = join(directory, "api-key"); writeFileSync(key, EXTERNAL_SECRET, { mode: 0o600 }); const env = { HOSPITAL_HIS_V4_ENABLED: "true", HOSPITAL_HIS_V4_CATALOG_ENDPOINT: endpoint, HOSPITAL_HIS_V4_ALLOWED_HOSTS: "localhost", HOSPITAL_HIS_V4_ALLOWED_IPS: "127.0.0.1", HOSPITAL_HIS_V4_API_KEY_FILE: key, HOSPITAL_HIS_V4_ACCOUNT_ID: "his_synthetic_account", HOSPITAL_HIS_V4_CONTRACT_REFERENCE: "synthetic-only-contract" }; expect(hospitalHisV4ConfigFromEnv(env)?.webhook).toBeUndefined();
    const publicKey = join(directory, "public-key"); writeFileSync(publicKey, EXTERNAL_SECRET, { mode: 0o644 }); expect(() => hospitalHisV4ConfigFromEnv({ ...env, HOSPITAL_HIS_V4_API_KEY_FILE: publicKey })).toThrow(); expect(() => hospitalHisV4ConfigFromEnv({ ...env, HOSPITAL_HIS_V4_WEBHOOK_ENABLED: "true" })).toThrow();
  });
});
