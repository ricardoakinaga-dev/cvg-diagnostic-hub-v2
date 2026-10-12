import type { HospitalIntegrationSystem } from "@cvg/contracts";
import { createHmac, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { isIP } from "node:net";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { request } from "node:https";

export interface HospitalIntegrationHttpConfig {
  system: HospitalIntegrationSystem;
  endpoint: string;
  allowedHosts: string[];
  allowedIps: string[];
  bearerToken: string;
  hmacSecret: string;
  contractReference: string;
  timeoutMs: number;
  ca?: string;
}
export class HospitalIntegrationHttpError extends Error {
  constructor(readonly code: string, readonly retryable: boolean) { super(code); this.name = "HospitalIntegrationHttpError"; }
}
function configError(): never { throw new HospitalIntegrationHttpError("INTEGRATION_CONFIGURATION_INVALID", false); }
function secretFile(path: string): string {
  if (!isAbsolute(path)) return configError();
  try { const stat = statSync(path); if (!stat.isFile() || stat.size > 4096 || stat.mode & 0o077) return configError(); const value = readFileSync(path, "utf8").trim(); return value.length >= 32 && value.length <= 4096 && !/\s/.test(value) ? value : configError(); } catch { return configError(); }
}
export function validateHospitalIntegrationHttpConfig(config: HospitalIntegrationHttpConfig): URL {
  let url: URL; try { url = new URL(config.endpoint); } catch { return configError(); }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !config.allowedHosts.includes(host) || !config.allowedIps.length || config.allowedIps.some((ip) => !isIP(ip)) || config.bearerToken.length < 32 || config.hmacSecret.length < 32 || /\s/.test(config.bearerToken) || /\s/.test(config.hmacSecret) || !config.contractReference.trim() || config.contractReference.length > 500 || !Number.isInteger(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 60_000) return configError();
  if (isIP(host) && !config.allowedIps.includes(host)) return configError();
  return url;
}
export function hospitalIntegrationHttpConfigFromEnv(system: HospitalIntegrationSystem, environment: Partial<NodeJS.ProcessEnv> = process.env): HospitalIntegrationHttpConfig | undefined {
  const prefix = `HOSPITAL_INTEGRATION_${system}_`; if (environment[`${prefix}ENABLED`] !== "true") return undefined;
  const value = (name: string) => (environment[`${prefix}${name}`] ?? "").trim();
  const caPath = value("CA_FILE"); let ca: string | undefined;
  if (caPath) { try { if (!isAbsolute(caPath) || !statSync(caPath).isFile() || statSync(caPath).size > 100_000) return configError(); ca = readFileSync(caPath, "utf8"); } catch { return configError(); } }
  const config: HospitalIntegrationHttpConfig = { system, endpoint: value("ENDPOINT"), allowedHosts: value("ALLOWED_HOSTS").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean), allowedIps: value("ALLOWED_IPS").split(",").map((ip) => ip.trim()).filter(Boolean), bearerToken: secretFile(value("TOKEN_FILE")), hmacSecret: secretFile(value("HMAC_SECRET_FILE")), contractReference: value("CONTRACT_REFERENCE"), timeoutMs: value("TIMEOUT_MS") ? Number(value("TIMEOUT_MS")) : 10_000, ...(ca ? { ca } : {}) };
  validateHospitalIntegrationHttpConfig(config); return config;
}
export function verifyHospitalIntegrationSignature(rawBody: string, signature: string, secret: string): boolean {
  if (!/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest(); const received = Buffer.from(signature.slice(7), "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}
/** Resolve once per send and pin the HTTPS connection to an explicitly approved IP. */
export async function postHospitalHttpsJson(config: HospitalIntegrationHttpConfig, envelope: { contract: string; messageId: string; [key: string]: unknown }, dependencies: { resolve?: (hostname: string, options: { all: true; verbatim: true }) => Promise<LookupAddress[]>; maxResponseBytes?: number } = {}) {
  const url = validateHospitalIntegrationHttpConfig(config); const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  let addresses: Array<{ address: string; family: number }>;
  try { addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : dependencies.resolve ? await dependencies.resolve(host, { all: true, verbatim: true }) : await lookup(host, { all: true, verbatim: true }); } catch { throw new HospitalIntegrationHttpError("INTEGRATION_DNS_UNAVAILABLE", true); }
  if (!addresses.length || addresses.some((entry) => !config.allowedIps.includes(entry.address))) throw new HospitalIntegrationHttpError("INTEGRATION_DNS_NOT_APPROVED", false);
  const selected = addresses[0]; const body = JSON.stringify(envelope);
  if (Buffer.byteLength(body) > 500_000) throw new HospitalIntegrationHttpError("INTEGRATION_PAYLOAD_TOO_LARGE", false);
  const data = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const outgoing = request(url, { method: "POST", minVersion: "TLSv1.2", rejectUnauthorized: true, ...(config.ca ? { ca: config.ca } : {}), lookup: (_hostname, options, callback) => options.all ? callback(null, [selected]) : callback(null, selected.address, selected.family), headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), authorization: `Bearer ${config.bearerToken}`, "x-cvg-contract": envelope.contract, "x-cvg-signature": `sha256=${createHmac("sha256", config.hmacSecret).update(body).digest("hex")}`, "idempotency-key": envelope.messageId }, signal: AbortSignal.timeout(config.timeoutMs) }, (response) => {
      const chunks: Buffer[] = []; let size = 0;
      response.on("data", (chunk: Buffer) => { size += chunk.length; if (size > (dependencies.maxResponseBytes ?? 64_000)) response.destroy(new HospitalIntegrationHttpError("INTEGRATION_RESPONSE_TOO_LARGE", false)); else chunks.push(chunk); });
      response.on("error", (error) => reject(error instanceof HospitalIntegrationHttpError ? error : new HospitalIntegrationHttpError("INTEGRATION_RESPONSE_INCOMPLETE", true)));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    outgoing.on("error", (error) => reject(error instanceof HospitalIntegrationHttpError ? error : new HospitalIntegrationHttpError("INTEGRATION_NETWORK_UNAVAILABLE", true))); outgoing.end(body);
  });
  if (data.status < 200 || data.status >= 300) throw new HospitalIntegrationHttpError(`INTEGRATION_HTTP_${data.status}`, data.status === 408 || data.status === 429 || data.status >= 500);
  let value: unknown; try { value = JSON.parse(data.body); } catch { throw new HospitalIntegrationHttpError("INTEGRATION_RECEIPT_INVALID", false); }
  return value;
}
export async function sendHospitalIntegrationHttp(config: HospitalIntegrationHttpConfig, envelope: { contract: "CVG_OPERATIONAL_V1"; messageId: string; [key: string]: unknown }, dependencies: { resolve?: (hostname: string, options: { all: true; verbatim: true }) => Promise<LookupAddress[]> } = {}) {
  const value = await postHospitalHttpsJson(config, envelope, dependencies);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HospitalIntegrationHttpError("INTEGRATION_RECEIPT_INVALID", false);
  const receipt = value as Record<string, unknown>;
  if (Object.keys(receipt).sort().join(",") !== "contract,messageId,receiptId,status" || receipt.contract !== "CVG_OPERATIONAL_V1" || receipt.messageId !== envelope.messageId || receipt.status !== "ACCEPTED" || typeof receipt.receiptId !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/.test(receipt.receiptId)) throw new HospitalIntegrationHttpError("INTEGRATION_RECEIPT_INVALID", false);
  return { contract: "CVG_OPERATIONAL_V1" as const, messageId: envelope.messageId, receiptId: receipt.receiptId, status: "ACCEPTED" as const };
}
