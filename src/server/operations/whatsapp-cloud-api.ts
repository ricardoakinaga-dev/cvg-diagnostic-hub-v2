import { createHmac, timingSafeEqual } from "node:crypto";

export interface WhatsAppCloudConfig {
  apiBase: string;
  apiVersion: string;
  phoneNumberId: string;
  accessToken: string;
  templateName: string;
  templateLanguage: string;
  timeoutMs: number;
}

const DEFAULT_API_BASE = "https://graph.facebook.com";
const DEFAULT_API_VERSION = "v26.0";
const DEFAULT_LANGUAGE = "pt_BR";
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_STATUS_UPDATES = 1000;

function configError(variable: string): Error {
  return new Error(`WHATSAPP_CONFIG_INVALID:${variable}`);
}

function normalizeApiBase(raw: string): string | undefined {
  const trimmed = raw.replace(/\/+$/, "");
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return undefined;
  } catch {
    return undefined;
  }
  return trimmed;
}

/** undefined unless WHATSAPP_ENABLED is exactly "true"; then the first missing/invalid variable throws. */
export function whatsAppCloudConfigFromEnv(environment: Partial<NodeJS.ProcessEnv> = process.env): WhatsAppCloudConfig | undefined {
  if (environment.WHATSAPP_ENABLED !== "true") return undefined;
  const read = (name: string): string => (environment[name] ?? "").trim();

  const apiBase = normalizeApiBase(read("WHATSAPP_API_BASE") || DEFAULT_API_BASE);
  if (!apiBase) throw configError("WHATSAPP_API_BASE");

  const apiVersion = read("WHATSAPP_API_VERSION") || DEFAULT_API_VERSION;
  if (!/^v\d{1,3}\.\d{1,2}$/.test(apiVersion)) throw configError("WHATSAPP_API_VERSION");

  const phoneNumberId = read("WHATSAPP_PHONE_NUMBER_ID");
  if (!/^[0-9]{5,30}$/.test(phoneNumberId)) throw configError("WHATSAPP_PHONE_NUMBER_ID");

  const accessToken = read("WHATSAPP_ACCESS_TOKEN");
  if (!accessToken || accessToken.length > 4096 || /\s/.test(accessToken)) throw configError("WHATSAPP_ACCESS_TOKEN");

  const templateName = read("WHATSAPP_TEMPLATE_NAME");
  if (!/^[a-z0-9_]{1,512}$/.test(templateName)) throw configError("WHATSAPP_TEMPLATE_NAME");

  const templateLanguage = read("WHATSAPP_TEMPLATE_LANGUAGE") || DEFAULT_LANGUAGE;
  if (!/^[a-z]{2,3}(_[A-Z]{2})?$/.test(templateLanguage)) throw configError("WHATSAPP_TEMPLATE_LANGUAGE");

  const rawTimeout = read("WHATSAPP_TIMEOUT_MS");
  const timeoutMs = rawTimeout ? (/^\d{1,6}$/.test(rawTimeout) ? Number(rawTimeout) : NaN) : DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) throw configError("WHATSAPP_TIMEOUT_MS");

  return { apiBase, apiVersion, phoneNumberId, accessToken, templateName, templateLanguage, timeoutMs };
}

export interface CriticalAlertTemplateInput {
  to: string;
  requestCode: string;
  linkPath: string;
}

export class WhatsAppSendError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, retryable: boolean) {
    super(code);
    this.name = "WhatsAppSendError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface WhatsAppSendResult {
  messageId: string;
}

function validateInput(input: CriticalAlertTemplateInput): void {
  if (typeof input.to !== "string" || !/^\+[1-9][0-9]{7,14}$/.test(input.to)) {
    throw new WhatsAppSendError("WHATSAPP_RECIPIENT_INVALID", false);
  }
  if (typeof input.requestCode !== "string" || input.requestCode.length > 60 || !/^[A-Za-z0-9._-]+$/.test(input.requestCode)) {
    throw new WhatsAppSendError("WHATSAPP_PARAMETER_INVALID", false);
  }
  if (typeof input.linkPath !== "string" || input.linkPath.length > 500 || !/^[A-Za-z0-9._~/-]+$/.test(input.linkPath) || input.linkPath.startsWith("/")) {
    throw new WhatsAppSendError("WHATSAPP_PARAMETER_INVALID", false);
  }
}

/** Builds the exact JSON body for POST {apiBase}/{apiVersion}/{phoneNumberId}/messages. */
export function criticalAlertMessageBody(config: WhatsAppCloudConfig, input: CriticalAlertTemplateInput): Record<string, unknown> {
  validateInput(input);
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: input.to,
    type: "template",
    template: {
      name: config.templateName,
      language: { code: config.templateLanguage },
      components: [
        { type: "body", parameters: [{ type: "text", text: input.requestCode }] },
        { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: input.linkPath }] }
      ]
    }
  };
}

const RETRYABLE_API_CODES = new Set([80007, 130429, 131056, 131000, 131016]);

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorFromResponse(status: number, body: unknown): WhatsAppSendError {
  const code = isRecord(body) && isRecord(body.error) ? body.error.code : undefined;
  if (typeof code === "number" && Number.isInteger(code)) {
    return new WhatsAppSendError(`WHATSAPP_API_${code}`, RETRYABLE_API_CODES.has(code) || isRetryableStatus(status));
  }
  return new WhatsAppSendError(`WHATSAPP_HTTP_${status}`, isRetryableStatus(status));
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/** Sends the critical-alert template. Errors carry only a code, never recipient, token, request code or provider text. */
export async function sendCriticalAlertTemplate(
  config: WhatsAppCloudConfig,
  input: CriticalAlertTemplateInput,
  fetchImpl: typeof fetch = fetch
): Promise<WhatsAppSendResult> {
  const body = criticalAlertMessageBody(config, input);
  let response: Response;
  try {
    response = await fetchImpl(`${config.apiBase}/${config.apiVersion}/${config.phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs)
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : undefined;
    if (name === "TimeoutError" || name === "AbortError") throw new WhatsAppSendError("WHATSAPP_TIMEOUT", true);
    throw new WhatsAppSendError("WHATSAPP_NETWORK", true);
  }

  const payload = await readJson(response);
  if (!response.ok) throw errorFromResponse(response.status, payload);

  const messages = isRecord(payload) ? payload.messages : undefined;
  const first: unknown = Array.isArray(messages) ? messages[0] : undefined;
  const id = isRecord(first) ? first.id : undefined;
  if (typeof id !== "string" || id.length === 0 || id.length > 200) {
    throw new WhatsAppSendError("WHATSAPP_RESPONSE_INVALID", true);
  }
  return { messageId: id };
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Meta GET verification: returns hub.challenge only for a matching subscribe request. */
export function verifyWhatsAppSubscription(params: URLSearchParams, verifyToken: string): string | undefined {
  if (params.get("hub.mode") !== "subscribe") return undefined;
  const provided = params.get("hub.verify_token");
  if (provided === null || !verifyToken || !safeEqual(Buffer.from(provided), Buffer.from(verifyToken))) return undefined;
  const challenge = params.get("hub.challenge");
  if (challenge === null || challenge.length > 200 || !/^[A-Za-z0-9_-]+$/.test(challenge)) return undefined;
  return challenge;
}

/** Validates X-Hub-Signature-256 over the exact raw body bytes. */
export function verifyWhatsAppSignature(rawBody: string | Uint8Array, signatureHeader: string | null, appSecret: string): boolean {
  if (!appSecret || signatureHeader === null) return false;
  const match = /^sha256=([0-9a-fA-F]{64})$/.exec(signatureHeader);
  if (!match) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  return safeEqual(expected, Buffer.from(match[1], "hex"));
}

export interface WhatsAppStatusUpdate {
  messageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  occurredAt: string;
  errorCode?: number;
}

const STATUSES = new Set(["sent", "delivered", "read", "failed"]);

function parseStatus(raw: unknown): WhatsAppStatusUpdate | undefined {
  if (!isRecord(raw)) return undefined;
  const { id, status, timestamp, errors } = raw;
  if (typeof id !== "string" || id.length === 0 || id.length > 200) return undefined;
  if (typeof status !== "string" || !STATUSES.has(status)) return undefined;
  const seconds = typeof timestamp === "string" || typeof timestamp === "number" ? Number(timestamp) : NaN;
  const date = new Date(seconds * 1000);
  if (!Number.isFinite(seconds) || Number.isNaN(date.getTime())) return undefined;

  const update: WhatsAppStatusUpdate = {
    messageId: id,
    status: status as WhatsAppStatusUpdate["status"],
    occurredAt: date.toISOString()
  };
  if (status === "failed" && Array.isArray(errors) && isRecord(errors[0]) && typeof errors[0].code === "number") {
    update.errorCode = errors[0].code;
  }
  return update;
}

/** Extracts delivery status updates only; recipient, conversation and pricing data are deliberately dropped. */
export function parseWhatsAppStatusUpdates(payload: unknown): WhatsAppStatusUpdate[] {
  const updates: WhatsAppStatusUpdate[] = [];
  if (!isRecord(payload) || payload.object !== "whatsapp_business_account" || !Array.isArray(payload.entry)) return updates;
  for (const entry of payload.entry) {
    if (!isRecord(entry) || !Array.isArray(entry.changes)) continue;
    for (const change of entry.changes) {
      if (!isRecord(change) || change.field !== "messages" || !isRecord(change.value) || !Array.isArray(change.value.statuses)) continue;
      for (const raw of change.value.statuses) {
        const update = parseStatus(raw);
        if (!update) continue;
        updates.push(update);
        if (updates.length >= MAX_STATUS_UPDATES) return updates;
      }
    }
  }
  return updates;
}
