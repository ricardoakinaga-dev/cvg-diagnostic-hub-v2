import { createHash } from "node:crypto";
import { ApiError } from "../http/envelope";
import { createStructuredLogger } from "../observability/structured-logger";
import { COMMON_PASSWORDS } from "./common-passwords";

export interface PasswordPolicyContext {
  readonly email?: string;
  readonly displayName?: string;
}

const MIN_LENGTH = 12;
const MAX_LENGTH = 200;
const REPEATED_CHARACTER_RUN = 6;
const SEQUENCE_RUN = 6;
const IDENTITY_WORD_MIN_LENGTH = 4;
const COMMON_BASE_MIN_LENGTH = 4;
const KEYBOARD_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm", "1234567890", "abcdefghijklmnopqrstuvwxyz"];

const reject = (message: string, code = "VALIDATION_ERROR"): never => { throw new ApiError(code, message, 400); };
/** Weak-password rules beyond length and character classes; the UI maps this code to one safe message. */
const weak = (message: string): never => reject(message, "PASSWORD_POLICY");

function hasRepeatedRun(value: string): boolean {
  const characters = Array.from(value);
  let run = 1;
  for (let index = 1; index < characters.length; index += 1) {
    run = characters[index] === characters[index - 1] ? run + 1 : 1;
    if (run >= REPEATED_CHARACTER_RUN) return true;
  }
  return false;
}

/** Ascending or descending run of SEQUENCE_RUN characters on a keyboard row or the alphabet/digits. */
function hasSequentialRun(value: string): boolean {
  const lower = value.toLowerCase();
  for (const row of KEYBOARD_ROWS) {
    const reversed = Array.from(row).reverse().join("");
    for (const source of [row, reversed]) {
      for (let start = 0; start + SEQUENCE_RUN <= source.length; start += 1) {
        if (lower.includes(source.slice(start, start + SEQUENCE_RUN))) return true;
      }
    }
  }
  return false;
}

function identityWords(context: PasswordPolicyContext): string[] {
  const localPart = context.email?.split("@")[0]?.toLowerCase() ?? "";
  const words = [localPart, ...(context.displayName?.toLowerCase().split(/[^\p{L}\p{N}]+/u) ?? [])];
  return [...new Set(words.filter((word) => Array.from(word).length >= IDENTITY_WORD_MIN_LENGTH))];
}

function isCommonPassword(password: string): boolean {
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) return true;
  // "password" + trailing digits/symbols is the same weakness as "password".
  const base = lower.replace(/[^\p{L}]+$/u, "");
  return Array.from(base).length >= COMMON_BASE_MIN_LENGTH && COMMON_PASSWORDS.has(base);
}

/** Pure policy checks; throws ApiError(VALIDATION_ERROR) with an actionable Portuguese message. */
export function assertPasswordPolicy(password: string, context: PasswordPolicyContext = {}): void {
  const length = typeof password === "string" ? Array.from(password).length : 0;
  if (length < MIN_LENGTH || length > MAX_LENGTH || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    reject("Use de 12 a 200 caracteres, com letras e números.");
  }
  if (hasRepeatedRun(password)) weak("Evite repetir o mesmo caractere seis vezes ou mais seguidas.");
  if (hasSequentialRun(password)) weak("Evite sequências óbvias como 123456, abcdef ou qwerty.");
  const lower = password.toLowerCase();
  if (identityWords(context).some((word) => lower.includes(word))) weak("A senha não pode conter o seu nome ou o início do seu e-mail.");
  if (isCommonPassword(password)) weak("Esta senha é muito comum; escolha outra.");
}

export type BreachCheckEnvironment = Readonly<Record<string, string | undefined>>;

export type BreachCheckFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; text(): Promise<string> }>;

const HIBP_RANGE_URL = "https://api.pwnedpasswords.com/range/";
const DEFAULT_TIMEOUT_MS = 3000;

function breachTimeoutMs(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 100 && parsed <= 30_000 ? parsed : DEFAULT_TIMEOUT_MS;
}

/**
 * Optional Have I Been Pwned range check (k-anonymity: only the first five
 * hex characters of the SHA-1 leave the server). Off by default because the
 * hospital server may have restricted egress; when the service is unreachable
 * the outcome follows PASSWORD_BREACH_CHECK_FAIL (open by default).
 */
export async function checkBreachedPassword(
  password: string,
  environment: BreachCheckEnvironment = process.env,
  fetchImpl: BreachCheckFetch = fetch as unknown as BreachCheckFetch
): Promise<void> {
  if (environment.PASSWORD_BREACH_CHECK?.trim().toLowerCase() !== "hibp") return;
  const digest = createHash("sha1").update(password).digest("hex").toUpperCase();
  const prefix = digest.slice(0, 5);
  const suffix = digest.slice(5);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), breachTimeoutMs(environment.PASSWORD_BREACH_CHECK_TIMEOUT_MS));
  let body: string;
  try {
    const response = await fetchImpl(`${HIBP_RANGE_URL}${prefix}`, { headers: { "Add-Padding": "true" }, signal: controller.signal });
    if (!response.ok) throw new Error("BREACH_CHECK_HTTP_ERROR");
    body = await response.text();
  } catch (error) {
    if (environment.PASSWORD_BREACH_CHECK_FAIL?.trim().toLowerCase() === "closed") {
      throw new ApiError("DEPENDENCY_UNAVAILABLE", "Não foi possível verificar a senha agora; tente novamente em instantes.", 503, { retryable: true });
    }
    createStructuredLogger().warn("security.password_breach_check_unavailable", {
      component: "security",
      reason: error instanceof Error && error.name === "AbortError" ? "timeout" : "unreachable"
    });
    return;
  } finally {
    clearTimeout(timer);
  }
  for (const line of body.split(/\r?\n/)) {
    const [candidate, count] = line.trim().split(":");
    // Padding entries carry a zero count and must not be treated as hits.
    if (candidate?.toUpperCase() === suffix && Number(count) > 0) {
      throw new ApiError("PASSWORD_BREACHED", "Esta senha apareceu em vazamentos conhecidos; escolha outra.", 400);
    }
  }
}

/** Full policy: pure rules first (cheap), then the optional breached-password lookup. */
export async function assertAcceptablePassword(password: string, context: PasswordPolicyContext = {}, environment: BreachCheckEnvironment = process.env): Promise<void> {
  assertPasswordPolicy(password, context);
  await checkBreachedPassword(password, environment);
}
