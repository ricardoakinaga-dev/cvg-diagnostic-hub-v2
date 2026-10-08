import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  criticalAlertMessageBody,
  parseWhatsAppStatusUpdates,
  sendCriticalAlertTemplate,
  verifyWhatsAppSignature,
  verifyWhatsAppSubscription,
  whatsAppCloudConfigFromEnv,
  WhatsAppSendError,
  type CriticalAlertTemplateInput,
  type WhatsAppCloudConfig
} from "./whatsapp-cloud-api";

const PHONE = ["+55", "11", "9", "8765", "4321"].join("");
const TOKEN = "t".repeat(8) + "-test";
const CODE = "REQ-2026.0042";

const config: WhatsAppCloudConfig = {
  apiBase: "https://graph.example.test",
  apiVersion: "v26.0",
  phoneNumberId: "123456789",
  accessToken: TOKEN,
  templateName: "critical_result",
  templateLanguage: "pt_BR",
  timeoutMs: 5000
};
const input: CriticalAlertTemplateInput = { to: PHONE, requestCode: CODE, linkPath: "results/result-123" };

const baseEnv = {
  WHATSAPP_ENABLED: "true",
  WHATSAPP_PHONE_NUMBER_ID: "123456789",
  WHATSAPP_ACCESS_TOKEN: TOKEN,
  WHATSAPP_TEMPLATE_NAME: "critical_result"
};

function reply(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

async function sendError(fetchImpl: typeof fetch, cfg = config, inp = input): Promise<WhatsAppSendError> {
  try {
    await sendCriticalAlertTemplate(cfg, inp, fetchImpl);
  } catch (error) {
    expect(error).toBeInstanceOf(WhatsAppSendError);
    return error as WhatsAppSendError;
  }
  throw new Error("expected failure");
}

describe("whatsAppCloudConfigFromEnv", () => {
  it("is disabled unless WHATSAPP_ENABLED is exactly true", () => {
    expect(whatsAppCloudConfigFromEnv({})).toBeUndefined();
    expect(whatsAppCloudConfigFromEnv({ ...baseEnv, WHATSAPP_ENABLED: "TRUE" })).toBeUndefined();
  });

  it("reads process.env by default", () => {
    expect(whatsAppCloudConfigFromEnv()).toBeUndefined();
  });

  it("applies defaults and trims values", () => {
    expect(whatsAppCloudConfigFromEnv({ ...baseEnv, WHATSAPP_ACCESS_TOKEN: `  ${TOKEN} ` })).toEqual({
      apiBase: "https://graph.facebook.com",
      apiVersion: "v26.0",
      phoneNumberId: "123456789",
      accessToken: TOKEN,
      templateName: "critical_result",
      templateLanguage: "pt_BR",
      timeoutMs: 10000
    });
  });

  it("accepts explicit overrides and trims trailing slashes", () => {
    const result = whatsAppCloudConfigFromEnv({
      ...baseEnv,
      WHATSAPP_API_BASE: "https://proxy.example.test/graph//",
      WHATSAPP_API_VERSION: "v30.1",
      WHATSAPP_TEMPLATE_LANGUAGE: "en",
      WHATSAPP_TIMEOUT_MS: "2500"
    });
    expect(result).toMatchObject({ apiBase: "https://proxy.example.test/graph", apiVersion: "v30.1", templateLanguage: "en", timeoutMs: 2500 });
  });

  it.each([
    ["WHATSAPP_API_BASE", "http://graph.example.test"],
    ["WHATSAPP_API_BASE", "not a url"],
    ["WHATSAPP_API_BASE", "https://user:pw@graph.example.test"],
    ["WHATSAPP_API_VERSION", "26.0"],
    ["WHATSAPP_PHONE_NUMBER_ID", ""],
    ["WHATSAPP_PHONE_NUMBER_ID", "12ab"],
    ["WHATSAPP_ACCESS_TOKEN", ""],
    ["WHATSAPP_ACCESS_TOKEN", "has space"],
    ["WHATSAPP_ACCESS_TOKEN", "x".repeat(4097)],
    ["WHATSAPP_TEMPLATE_NAME", ""],
    ["WHATSAPP_TEMPLATE_NAME", "Bad-Name"],
    ["WHATSAPP_TEMPLATE_LANGUAGE", "pt-BR"],
    ["WHATSAPP_TIMEOUT_MS", "999"],
    ["WHATSAPP_TIMEOUT_MS", "60001"],
    ["WHATSAPP_TIMEOUT_MS", "abc"],
    ["WHATSAPP_TIMEOUT_MS", "1500.5"]
  ])("rejects invalid %s=%j", (name, value) => {
    expect(() => whatsAppCloudConfigFromEnv({ ...baseEnv, [name]: value })).toThrow(`WHATSAPP_CONFIG_INVALID:${name}`);
  });

  it.each(["WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_ACCESS_TOKEN", "WHATSAPP_TEMPLATE_NAME"])("requires %s", (name) => {
    const env: Record<string, string> = { ...baseEnv };
    delete env[name];
    expect(() => whatsAppCloudConfigFromEnv(env)).toThrow(`WHATSAPP_CONFIG_INVALID:${name}`);
  });
});

describe("criticalAlertMessageBody", () => {
  it("builds the exact template payload", () => {
    expect(criticalAlertMessageBody(config, input)).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: PHONE,
      type: "template",
      template: {
        name: "critical_result",
        language: { code: "pt_BR" },
        components: [
          { type: "body", parameters: [{ type: "text", text: CODE }] },
          { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "results/result-123" }] }
        ]
      }
    });
  });

  it.each(["11987654321", "+0123456789", "+55 11", "+1234567", `${PHONE}9999999`])("rejects recipient %j", (to) => {
    expect(() => criticalAlertMessageBody(config, { ...input, to })).toThrowError(expect.objectContaining({ code: "WHATSAPP_RECIPIENT_INVALID", retryable: false }));
  });

  it.each([
    [{ requestCode: "" }],
    [{ requestCode: "a b" }],
    [{ requestCode: "a".repeat(61) }],
    [{ linkPath: "" }],
    [{ linkPath: "/results/1" }],
    [{ linkPath: "results/a b" }],
    [{ linkPath: "a".repeat(501) }],
    [{ linkPath: "results?x=1" }]
  ])("rejects parameters %j", (override) => {
    expect(() => criticalAlertMessageBody(config, { ...input, ...override })).toThrowError(expect.objectContaining({ code: "WHATSAPP_PARAMETER_INVALID", retryable: false }));
  });

  it("rejects non-string inputs", () => {
    const bad = (override: object) => ({ ...input, ...override }) as unknown as CriticalAlertTemplateInput;
    expect(() => criticalAlertMessageBody(config, bad({ to: 5 }))).toThrow("WHATSAPP_RECIPIENT_INVALID");
    expect(() => criticalAlertMessageBody(config, bad({ requestCode: 5 }))).toThrow("WHATSAPP_PARAMETER_INVALID");
    expect(() => criticalAlertMessageBody(config, bad({ linkPath: 5 }))).toThrow("WHATSAPP_PARAMETER_INVALID");
  });
});

describe("sendCriticalAlertTemplate", () => {
  it("posts the template and returns the message id", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(reply({ messages: [{ id: "wamid.ABC" }] }));
    await expect(sendCriticalAlertTemplate(config, input, fetchImpl)).resolves.toEqual({ messageId: "wamid.ABC" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://graph.example.test/v26.0/123456789/messages");
    expect(init?.method).toBe("POST");
    const authorization = `Bearer ${TOKEN}`;
    expect(init?.headers).toEqual({ Authorization: authorization, "Content-Type": "application/json" });
    expect(JSON.parse(init?.body as string)).toEqual(criticalAlertMessageBody(config, input));
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("uses the global fetch by default", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(reply({ messages: [{ id: "wamid.G" }] }));
    try {
      await expect(sendCriticalAlertTemplate(config, input)).resolves.toEqual({ messageId: "wamid.G" });
    } finally {
      spy.mockRestore();
    }
  });

  it("does not call the network for invalid input", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(sendCriticalAlertTemplate(config, { ...input, to: "x" }, fetchImpl)).rejects.toThrow("WHATSAPP_RECIPIENT_INVALID");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["no messages", {}],
    ["not an object", "[]"],
    ["non-json", "<html>"],
    ["empty messages", { messages: [] }],
    ["non-object entry", { messages: ["x"] }],
    ["empty id", { messages: [{ id: "" }] }],
    ["numeric id", { messages: [{ id: 5 }] }],
    ["oversized id", { messages: [{ id: "x".repeat(201) }] }]
  ])("treats a 2xx with %s as a retryable invalid response", async (_label, body) => {
    const error = await sendError(vi.fn<typeof fetch>().mockResolvedValue(reply(body)));
    expect(error).toMatchObject({ code: "WHATSAPP_RESPONSE_INVALID", retryable: true });
  });

  it.each([
    [80007, 400, true],
    [130429, 400, true],
    [131056, 400, true],
    [131000, 400, true],
    [131016, 400, true],
    [131026, 400, false],
    [132000, 400, false],
    [132001, 404, false],
    [132015, 400, false],
    [190, 401, false],
    [131026, 503, true],
    [190, 429, true]
  ])("maps API code %i (HTTP %i) retryable=%s", async (code, status, retryable) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(reply({ error: { code, message: `leak ${PHONE} ${TOKEN} ${CODE}` } }, status));
    const error = await sendError(fetchImpl);
    expect(error).toMatchObject({ code: `WHATSAPP_API_${code}`, retryable, message: `WHATSAPP_API_${code}` });
  });

  it.each([
    [429, true],
    [500, true],
    [503, true],
    [400, false],
    [401, false],
    [404, false]
  ])("maps HTTP %i without a parseable code retryable=%s", async (status, retryable) => {
    for (const body of ["plain text", { error: {} }, { error: { code: "131026" } }, { error: { code: 1.5 } }, { error: "x" }, "null"]) {
      const error = await sendError(vi.fn<typeof fetch>().mockImplementation(async () => reply(body, status)));
      expect(error).toMatchObject({ code: `WHATSAPP_HTTP_${status}`, retryable });
    }
  });

  it.each(["TimeoutError", "AbortError"])("maps %s to a retryable timeout", async (name) => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new DOMException(`${PHONE} ${TOKEN}`, name));
    const error = await sendError(fetchImpl);
    expect(error).toMatchObject({ code: "WHATSAPP_TIMEOUT", retryable: true, message: "WHATSAPP_TIMEOUT" });
  });

  it("maps any other rejection to a retryable network error", async () => {
    for (const reason of [new TypeError(`fetch failed ${PHONE} ${TOKEN} ${CODE}`), "boom"]) {
      const error = await sendError(vi.fn<typeof fetch>().mockRejectedValue(reason));
      expect(error).toMatchObject({ code: "WHATSAPP_NETWORK", retryable: true, message: "WHATSAPP_NETWORK" });
    }
  });

  it("never leaks the phone, token or request code in any error", async () => {
    const outcomes: Array<() => Promise<Response>> = [
      async () => reply({ error: { code: 131026, message: `${PHONE} ${TOKEN} ${CODE}`, error_data: { details: PHONE } } }, 400),
      async () => reply(`${PHONE} ${TOKEN} ${CODE}`, 502),
      async () => {
        throw new Error(`${PHONE} ${TOKEN} ${CODE}`);
      }
    ];
    for (const outcome of outcomes) {
      const error = await sendError(vi.fn<typeof fetch>().mockImplementation(outcome));
      const text = `${error.message} ${error.code} ${error.stack?.split("\n")[0]}`;
      for (const secret of [PHONE, TOKEN, CODE]) expect(text).not.toContain(secret);
    }
  });
});

describe("verifyWhatsAppSubscription", () => {
  const params = (entries: Record<string, string>) => new URLSearchParams(entries);

  it("returns the challenge for a valid request", () => {
    expect(verifyWhatsAppSubscription(params({ "hub.mode": "subscribe", "hub.verify_token": "secret-1", "hub.challenge": "abc_123-X" }), "secret-1")).toBe("abc_123-X");
  });

  it("rejects wrong token, different length, wrong mode, empty configured token", () => {
    const base = { "hub.mode": "subscribe", "hub.verify_token": "secret-1", "hub.challenge": "12345" };
    expect(verifyWhatsAppSubscription(params(base), "secret-2")).toBeUndefined();
    expect(verifyWhatsAppSubscription(params(base), "secret-12")).toBeUndefined();
    expect(verifyWhatsAppSubscription(params({ ...base, "hub.mode": "unsubscribe" }), "secret-1")).toBeUndefined();
    expect(verifyWhatsAppSubscription(params({ "hub.mode": "subscribe", "hub.challenge": "12345" }), "secret-1")).toBeUndefined();
    expect(verifyWhatsAppSubscription(params({ ...base, "hub.verify_token": "" }), "")).toBeUndefined();
  });

  it("rejects missing or invalid challenges", () => {
    const base = { "hub.mode": "subscribe", "hub.verify_token": "s" };
    expect(verifyWhatsAppSubscription(params(base), "s")).toBeUndefined();
    expect(verifyWhatsAppSubscription(params({ ...base, "hub.challenge": "" }), "s")).toBeUndefined();
    expect(verifyWhatsAppSubscription(params({ ...base, "hub.challenge": "<script>" }), "s")).toBeUndefined();
    expect(verifyWhatsAppSubscription(params({ ...base, "hub.challenge": "a".repeat(201) }), "s")).toBeUndefined();
  });
});

describe("verifyWhatsAppSignature", () => {
  const secret = "app-secret";
  const body = '{"object":"whatsapp_business_account","x":"ã"}';
  const sign = (data: string | Uint8Array, key = secret) => `sha256=${createHmac("sha256", key).update(data).digest("hex")}`;

  it("accepts a valid signature for string and byte bodies", () => {
    expect(verifyWhatsAppSignature(body, sign(body), secret)).toBe(true);
    expect(verifyWhatsAppSignature(new TextEncoder().encode(body), sign(body), secret)).toBe(true);
    expect(verifyWhatsAppSignature(body, sign(body).toUpperCase().replace("SHA256=", "sha256="), secret)).toBe(true);
  });

  it("rejects wrong secret, tampered body, malformed and missing headers, empty secret", () => {
    expect(verifyWhatsAppSignature(body, sign(body, "other"), secret)).toBe(false);
    expect(verifyWhatsAppSignature(`${body} `, sign(body), secret)).toBe(false);
    expect(verifyWhatsAppSignature(body, "sha256=abc", secret)).toBe(false);
    expect(verifyWhatsAppSignature(body, sign(body).replace("sha256=", "sha1="), secret)).toBe(false);
    expect(verifyWhatsAppSignature(body, null, secret)).toBe(false);
    expect(verifyWhatsAppSignature(body, sign(body, ""), "")).toBe(false);
  });
});

describe("parseWhatsAppStatusUpdates", () => {
  const wrap = (statuses: unknown[], extra: Record<string, unknown> = {}) => ({
    object: "whatsapp_business_account",
    entry: [{ id: "1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", statuses, ...extra } }] }]
  });

  it("parses sent, delivered, read and failed statuses", () => {
    const result = parseWhatsAppStatusUpdates(
      wrap([
        { id: "w1", status: "sent", timestamp: "1700000000", recipient_id: "5511999990000" },
        { id: "w2", status: "delivered", timestamp: 1700000001 },
        { id: "w3", status: "read", timestamp: "1700000002" },
        { id: "w4", status: "failed", timestamp: "1700000003", errors: [{ code: 131026, title: "free text" }] }
      ])
    );
    expect(result).toEqual([
      { messageId: "w1", status: "sent", occurredAt: "2023-11-14T22:13:20.000Z" },
      { messageId: "w2", status: "delivered", occurredAt: "2023-11-14T22:13:21.000Z" },
      { messageId: "w3", status: "read", occurredAt: "2023-11-14T22:13:22.000Z" },
      { messageId: "w4", status: "failed", occurredAt: "2023-11-14T22:13:23.000Z", errorCode: 131026 }
    ]);
  });

  it("omits errorCode when absent or non-numeric and ignores errors on non-failed statuses", () => {
    const result = parseWhatsAppStatusUpdates(
      wrap([
        { id: "a", status: "failed", timestamp: "1" },
        { id: "b", status: "failed", timestamp: "1", errors: [{ code: "x" }] },
        { id: "c", status: "failed", timestamp: "1", errors: ["x"] },
        { id: "d", status: "sent", timestamp: "1", errors: [{ code: 5 }] }
      ])
    );
    expect(result).toHaveLength(4);
    for (const update of result) expect(update).not.toHaveProperty("errorCode");
  });

  it("never exposes recipient, conversation or pricing data", () => {
    const result = parseWhatsAppStatusUpdates(
      wrap([{ id: "w1", status: "sent", timestamp: "1", recipient_id: "5511999990000", conversation: { id: "c" }, pricing: { billable: true } }])
    );
    const text = JSON.stringify(result);
    expect(text).not.toContain("5511999990000");
    expect(text).not.toContain("conversation");
    expect(text).not.toContain("pricing");
  });

  it("ignores unknown statuses, inbound messages and malformed entries without throwing", () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        null,
        "x",
        { changes: "x" },
        { changes: [null, { field: "other", value: { statuses: [{ id: "x", status: "sent", timestamp: "1" }] } }] },
        { changes: [{ field: "messages", value: null }] },
        { changes: [{ field: "messages", value: { messages: [{ id: "m", from: "1", type: "text" }] } }] },
        {
          changes: [
            {
              field: "messages",
              value: {
                statuses: [
                  null,
                  { id: "p", status: "played", timestamp: "1" },
                  { id: 5, status: "sent", timestamp: "1" },
                  { id: "", status: "sent", timestamp: "1" },
                  { id: "q", status: 7, timestamp: "1" },
                  { id: "r", status: "sent", timestamp: "nope" },
                  { id: "s", status: "sent" },
                  { id: "t", status: "sent", timestamp: "99999999999999999" },
                  { id: "ok", status: "read", timestamp: "5" }
                ]
              }
            }
          ]
        }
      ]
    };
    expect(parseWhatsAppStatusUpdates(payload)).toEqual([{ messageId: "ok", status: "read", occurredAt: "1970-01-01T00:00:05.000Z" }]);
  });

  it("returns [] for non-objects, other objects and missing entry", () => {
    for (const payload of [null, undefined, "x", 5, [], { object: "page", entry: [] }, { object: "whatsapp_business_account" }]) {
      expect(parseWhatsAppStatusUpdates(payload)).toEqual([]);
    }
  });

  it("caps the output at 1000 updates", () => {
    const statuses = Array.from({ length: 1500 }, (_, index) => ({ id: `w${index}`, status: "sent", timestamp: "1" }));
    const result = parseWhatsAppStatusUpdates(wrap(statuses));
    expect(result).toHaveLength(1000);
    expect(result[999].messageId).toBe("w999");
  });
});
