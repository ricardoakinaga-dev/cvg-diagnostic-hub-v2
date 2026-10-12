import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { isIP } from "node:net";
import { HospitalIntegrationHttpError } from "./hospital-integration-http";
import { hospitalHisV4MappingsSchema, type HospitalHisV4Mappings } from "../http/hospital-his-v4-schemas";

export interface HospitalHisV4Config {
  endpoint: string; allowedHosts: string[]; allowedIps: string[]; apiKey: string; accountId: string; contractReference: string; timeoutMs: number; ca?: string;
  webhook?: { secret: string; webhookId: string; credentialId: string; credentialVersion: number; mappings: HospitalHisV4Mappings };
}
const invalid = (): never => { throw new HospitalIntegrationHttpError("HIS_V4_CONFIGURATION_INVALID", false); };
function privateFile(path: string, maxBytes: number): string {
  try { const stat = statSync(path); if (!isAbsolute(path) || !stat.isFile() || stat.mode & 0o077 || stat.size > maxBytes) return invalid(); return readFileSync(path, "utf8"); } catch { return invalid(); }
}
export function validateHospitalHisV4Config(config: HospitalHisV4Config): URL {
  let url: URL; try { url = new URL(config.endpoint); } catch { return invalid(); }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !["/integrations/catalog", "/api/integrations/catalog"].includes(url.pathname) || !config.allowedHosts.includes(host) || !config.allowedIps.length || config.allowedIps.some(ip => !isIP(ip)) || isIP(host) && !config.allowedIps.includes(host) || !/^[^\s]{32,4096}$/.test(config.apiKey) || !/^[A-Za-z0-9_.:-]{1,160}$/.test(config.accountId) || !config.contractReference.trim() || config.contractReference.length > 500 || !Number.isInteger(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 60_000) return invalid();
  if (config.webhook && (!/^[^\s]{32,4096}$/.test(config.webhook.secret) || !/^[A-Za-z0-9_.:-]{1,160}$/.test(config.webhook.webhookId) || !/^[A-Za-z0-9_.:-]{1,100}$/.test(config.webhook.credentialId) || !Number.isInteger(config.webhook.credentialVersion) || config.webhook.credentialVersion < 1 || !hospitalHisV4MappingsSchema.safeParse(config.webhook.mappings).success)) return invalid();
  return url;
}
export function hospitalHisV4ConfigFromEnv(environment: Partial<NodeJS.ProcessEnv> = process.env): HospitalHisV4Config | undefined {
  if (environment.HOSPITAL_HIS_V4_ENABLED !== "true") return undefined;
  const value = (key: string) => (environment[`HOSPITAL_HIS_V4_${key}`] ?? "").trim();
  let ca: string | undefined;
  if (value("CA_FILE")) { try { const path = value("CA_FILE"); const stat = statSync(path); if (!isAbsolute(path) || !stat.isFile() || stat.size > 100_000) return invalid(); ca = readFileSync(path, "utf8"); } catch { return invalid(); } }
  const config: HospitalHisV4Config = { endpoint: value("CATALOG_ENDPOINT"), allowedHosts: value("ALLOWED_HOSTS").split(",").map(host => host.trim().toLowerCase()).filter(Boolean), allowedIps: value("ALLOWED_IPS").split(",").map(ip => ip.trim()).filter(Boolean), apiKey: privateFile(value("API_KEY_FILE"), 4096).trim(), accountId: value("ACCOUNT_ID"), contractReference: value("CONTRACT_REFERENCE"), timeoutMs: value("TIMEOUT_MS") ? Number(value("TIMEOUT_MS")) : 10_000, ...(ca ? { ca } : {}) };
  if (value("WEBHOOK_ENABLED") === "true") {
    let mappings: HospitalHisV4Mappings; try { mappings = hospitalHisV4MappingsSchema.parse(JSON.parse(privateFile(value("MAPPINGS_FILE"), 2_000_000))); } catch { return invalid(); }
    config.webhook = { secret: privateFile(value("WEBHOOK_SECRET_FILE"), 4096).trim(), webhookId: value("WEBHOOK_ID"), credentialId: value("CREDENTIAL_ID"), credentialVersion: Number(value("CREDENTIAL_VERSION")), mappings };
  }
  validateHospitalHisV4Config(config); return config;
}
