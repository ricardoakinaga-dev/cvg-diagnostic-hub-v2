import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { isIP } from "node:net";
import { request } from "node:https";
import { createHmac, timingSafeEqual } from "node:crypto";
import { HospitalIntegrationHttpError } from "./hospital-integration-http";
import { validateHospitalHisV4Config, type HospitalHisV4Config } from "./hospital-his-v4-config";

/** Actual HIS signature v2 covers `${unixSeconds}.${rawBody}`, with a 300-second window. */
export function verifyHospitalHisV4Signature(rawBody: string, signature: string, timestamp: string, version: string, secret: string, nowMs = Date.now()): boolean {
  if (version !== "v2" || !/^sha256=[a-f0-9]{64}$/.test(signature) || !/^\d{1,12}$/.test(timestamp)) return false;
  const seconds = Number(timestamp); if (!Number.isSafeInteger(seconds) || Math.abs(Math.floor(nowMs / 1000) - seconds) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest(); const actual = Buffer.from(signature.slice(7), "hex"); return expected.length === actual.length && timingSafeEqual(expected, actual);
}
/** X-API-Key is dedicated to the real HIS read-only catalog; no cookies, redirects or bearer. */
export async function discoverHospitalHisV4Http(config: HospitalHisV4Config, dependencies: { resolve?: (hostname: string, options: { all: true; verbatim: true }) => Promise<LookupAddress[]> } = {}): Promise<unknown> {
  const url = validateHospitalHisV4Config(config); const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  let addresses: LookupAddress[]; try { addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : dependencies.resolve ? await dependencies.resolve(host, { all: true, verbatim: true }) : await lookup(host, { all: true, verbatim: true }); } catch { throw new HospitalIntegrationHttpError("HIS_V4_DNS_UNAVAILABLE", true); }
  if (!addresses.length || addresses.some(entry => !config.allowedIps.includes(entry.address))) throw new HospitalIntegrationHttpError("HIS_V4_DNS_NOT_APPROVED", false);
  const selected = addresses[0];
  const data = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const outgoing = request(url, { method: "GET", minVersion: "TLSv1.2", rejectUnauthorized: true, ...(config.ca ? { ca: config.ca } : {}), lookup: (_hostname, options, callback) => options.all ? callback(null, [selected]) : callback(null, selected.address, selected.family), headers: { accept: "application/json", "x-api-key": config.apiKey }, signal: AbortSignal.timeout(config.timeoutMs) }, response => {
      const chunks: Buffer[] = []; let bytes = 0;
      response.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 100_000) response.destroy(new HospitalIntegrationHttpError("HIS_V4_CATALOG_TOO_LARGE", false)); else chunks.push(chunk); });
      response.on("error", error => reject(error instanceof HospitalIntegrationHttpError ? error : new HospitalIntegrationHttpError("HIS_V4_RESPONSE_INCOMPLETE", true)));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    }); outgoing.on("error", error => reject(error instanceof HospitalIntegrationHttpError ? error : new HospitalIntegrationHttpError("HIS_V4_NETWORK_UNAVAILABLE", true))); outgoing.end();
  });
  if (data.status !== 200) throw new HospitalIntegrationHttpError(`HIS_V4_HTTP_${data.status}`, data.status === 408 || data.status === 429 || data.status >= 500);
  try { return JSON.parse(data.body); } catch { throw new HospitalIntegrationHttpError("HIS_V4_CATALOG_INVALID", false); }
}
