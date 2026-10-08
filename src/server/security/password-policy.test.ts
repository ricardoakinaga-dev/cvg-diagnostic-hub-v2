import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMMON_PASSWORDS } from "./common-passwords";
import { assertAcceptablePassword, assertPasswordPolicy, checkBreachedPassword, type BreachCheckFetch } from "./password-policy";
import * as structuredLogger from "../observability/structured-logger";

const GOOD = "Cavalo-azul-Lua-48-xk";

describe("assertPasswordPolicy", () => {
  it("accepts a long passphrase with letters and digits", () => {
    expect(() => assertPasswordPolicy(GOOD, { email: "ana@hospital.example", displayName: "Ana Souza" })).not.toThrow();
    expect(() => assertPasswordPolicy(GOOD)).not.toThrow();
  });

  it.each([
    ["too short", "Ab1-short", "VALIDATION_ERROR"],
    ["too long", `a1${"x-".repeat(100)}`, "VALIDATION_ERROR"],
    ["no digit", "sem-digitos-aqui-no-texto", "VALIDATION_ERROR"],
    ["no letter", "9182736450192837", "VALIDATION_ERROR"],
    ["not a string", undefined as unknown as string, "VALIDATION_ERROR"],
    ["same character six times", "Boa-senha-zzzzzz-91", "PASSWORD_POLICY"],
    ["ascending digits", "Linda-flor-345678-ok", "PASSWORD_POLICY"],
    ["descending digits", "Linda-flor-987654-ok", "PASSWORD_POLICY"],
    ["alphabet run", "Linda-ABCDEF-flor-7", "PASSWORD_POLICY"],
    ["keyboard run", "Linda-QWERTY-flor-7", "PASSWORD_POLICY"],
    ["a common password", "Password123456", "PASSWORD_POLICY"]
  ])("rejects %s", (_label, password, code) => {
    expect(() => assertPasswordPolicy(password)).toThrowError(expect.objectContaining({ code, status: 400 }));
  });

  it("rejects common bases followed only by digits or symbols, case-insensitively", () => {
    expect(() => assertPasswordPolicy("SENHAsenha1!!!")).toThrowError(expect.objectContaining({ code: "PASSWORD_POLICY" }));
    expect(() => assertPasswordPolicy("Welcome2026-x-9")).not.toThrow();
    expect(() => assertPasswordPolicy("Qwertyuiop-9-9")).toThrowError(expect.objectContaining({ code: "PASSWORD_POLICY" }));
    expect(() => assertPasswordPolicy("Dragon8dragon")).not.toThrow();
    expect(() => assertPasswordPolicy("admin-2468-xx")).not.toThrow();
    expect(() => assertPasswordPolicy("Administrator1-")).toThrowError(expect.objectContaining({ code: "PASSWORD_POLICY" }));
  });

  it("rejects the e-mail local part and display-name words of four or more characters", () => {
    const context = { email: "Maria.Silva@hospital.example", displayName: "Maria da Silva Neto" };
    expect(() => assertPasswordPolicy("x-MARIA.silva-47-Zq", context)).toThrowError(expect.objectContaining({ code: "PASSWORD_POLICY" }));
    expect(() => assertPasswordPolicy("Casa-do-NETO-61-ab", context)).toThrowError(expect.objectContaining({ code: "PASSWORD_POLICY" }));
    // Words shorter than four characters ("da") are not identity markers.
    expect(() => assertPasswordPolicy("Casa-da-lua-61-abc", context)).not.toThrow();
    expect(() => assertPasswordPolicy(GOOD, { email: "sem-arroba", displayName: "" })).not.toThrow();
  });

  it("ships a lower-cased denylist", () => {
    expect(COMMON_PASSWORDS.size).toBeGreaterThan(300);
    expect([...COMMON_PASSWORDS].every((entry) => entry === entry.toLowerCase())).toBe(true);
  });
});

function pwnedFetch(password: string, count: number): BreachCheckFetch {
  const digest = createHash("sha1").update(password).digest("hex").toUpperCase();
  return vi.fn(async (url: string) => {
    expect(url).toBe(`https://api.pwnedpasswords.com/range/${digest.slice(0, 5)}`);
    return { ok: true, text: async () => `0018A45C4D1DEF81644B54AB7F969B88D65:3\r\n${digest.slice(5)}:${count}\r\n011053FD0102E94D6AE2F8B83D76FAF94F6:0` };
  });
}

describe("checkBreachedPassword", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is off by default and never calls the network", async () => {
    const fetchImpl = vi.fn();
    await checkBreachedPassword(GOOD, {}, fetchImpl as unknown as BreachCheckFetch);
    await checkBreachedPassword(GOOD, { PASSWORD_BREACH_CHECK: "off" }, fetchImpl as unknown as BreachCheckFetch);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a password whose SHA-1 suffix is listed and sends padding plus only the 5-character prefix", async () => {
    const fetchImpl = pwnedFetch(GOOD, 42);
    await expect(checkBreachedPassword(GOOD, { PASSWORD_BREACH_CHECK: "hibp" }, fetchImpl)).rejects.toMatchObject({ code: "PASSWORD_BREACHED", status: 400, message: "Esta senha apareceu em vazamentos conhecidos; escolha outra." });
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0];
    expect(url).not.toContain(createHash("sha1").update(GOOD).digest("hex").toUpperCase().slice(5));
    expect(init.headers).toEqual({ "Add-Padding": "true" });
  });

  it("accepts a password that is absent or only present as a zero-count padding entry", async () => {
    await expect(checkBreachedPassword(GOOD, { PASSWORD_BREACH_CHECK: "hibp" }, pwnedFetch(GOOD, 0))).resolves.toBeUndefined();
    const miss: BreachCheckFetch = async () => ({ ok: true, text: async () => "0018A45C4D1DEF81644B54AB7F969B88D65:3\n\n" });
    await expect(checkBreachedPassword(GOOD, { PASSWORD_BREACH_CHECK: "HIBP" }, miss)).resolves.toBeUndefined();
  });

  it("fails open by default and logs a structured warning without the password or its hash", async () => {
    const warn = vi.fn();
    vi.spyOn(structuredLogger, "createStructuredLogger").mockReturnValue({ warn } as unknown as ReturnType<typeof structuredLogger.createStructuredLogger>);
    const down: BreachCheckFetch = async () => { throw new Error("getaddrinfo ENOTFOUND"); };
    await expect(checkBreachedPassword(GOOD, { PASSWORD_BREACH_CHECK: "hibp" }, down)).resolves.toBeUndefined();
    const notOk: BreachCheckFetch = async () => ({ ok: false, text: async () => "" });
    await expect(checkBreachedPassword(GOOD, { PASSWORD_BREACH_CHECK: "hibp", PASSWORD_BREACH_CHECK_FAIL: "open" }, notOk)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(GOOD);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/[0-9A-F]{40}/i);
  });

  it("times out an unresponsive service (abort) and honours open and closed", async () => {
    const hang: BreachCheckFetch = (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
    const warn = vi.fn();
    vi.spyOn(structuredLogger, "createStructuredLogger").mockReturnValue({ warn } as unknown as ReturnType<typeof structuredLogger.createStructuredLogger>);
    const env = { PASSWORD_BREACH_CHECK: "hibp", PASSWORD_BREACH_CHECK_TIMEOUT_MS: "100" };
    await expect(checkBreachedPassword(GOOD, env, hang)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("security.password_breach_check_unavailable", expect.objectContaining({ reason: "timeout" }));
    await expect(checkBreachedPassword(GOOD, { ...env, PASSWORD_BREACH_CHECK_FAIL: "closed" }, hang)).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE", status: 503 });
  });

  it("falls back to the default timeout for an invalid configuration value", async () => {
    const fetchImpl = pwnedFetch(GOOD, 0);
    await expect(checkBreachedPassword(GOOD, { PASSWORD_BREACH_CHECK: "hibp", PASSWORD_BREACH_CHECK_TIMEOUT_MS: "abc" }, fetchImpl)).resolves.toBeUndefined();
  });

  it("assertAcceptablePassword runs the pure rules before any network call", async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    await expect(assertAcceptablePassword("Password123456", {}, { PASSWORD_BREACH_CHECK: "hibp" })).rejects.toMatchObject({ code: "PASSWORD_POLICY" });
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(assertAcceptablePassword(GOOD, {}, {})).resolves.toBeUndefined();
    vi.unstubAllGlobals();
  });
});
