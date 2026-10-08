import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createSuccessResponse, toApiErrorResponse } from "../../../../server/http/envelope";
import { getRuntimeStoreAsync } from "../../../../server/store/runtime";
import type { CommandMeta, SearchResultType, createApplicationService } from "../../../../server/application/service";
import type { ApiHandlerEntry } from "../../../../server/http/api-handler-registry";
import type { authenticateRequest } from "../../../../server/security/session";
import { ApiError } from "../../../../server/http/envelope";
import { assertRateLimit } from "../../../../server/security/rate-limit";
import { createSafeConsoleSink, processOutboxBatch } from "../../../../server/operations/outbox";
import { createStructuredLogger } from "../../../../server/observability/structured-logger";
import { RealtimeUnavailableError } from "../../../../server/observability/realtime-stream";
import { ITEM_STATES, PRIORITIES } from "@cvg/contracts";
import { readJsonWithLimit } from "../../../../server/http/request-body";
import { maskAlertPhone } from "../../../../server/application/alert-contact";
import { type ApiOperation } from "../../../../server/http/api-operation-manifest";
export interface PublicHandlerContext {
  request: Request;
  path: string[];
  operation: ApiOperation;
  correlationId: string;
  id: string;
  clientIdentity: ClientRateLimitIdentity;
  rateLimitClientKey: string;
}

export interface SessionHandlerContext extends PublicHandlerContext {
  store: Awaited<ReturnType<typeof getRuntimeStoreAsync>>;
  actor: Awaited<ReturnType<typeof authenticateRequest>>;
  service: ReturnType<typeof createApplicationService>;
}

export type ApiHandlerGroup = Readonly<Record<string, ApiHandlerEntry<PublicHandlerContext, SessionHandlerContext>>>;

export type RouteContext = {
  params: Promise<{
    path: string[];
  }>;
};
export const codePointLength = (value: string) => Array.from(value).length;
export const boundedString = (minimum: number, maximum: number) => z.string().refine((value) => codePointLength(value) >= minimum && codePointLength(value) <= maximum, `text must contain between ${minimum} and ${maximum} Unicode characters`);
export const expectedVersionSchema = z.number().int().positive().max(999999999999999);
export const queryDateTimeSchema = z.string().max(100).datetime({ offset: true }).refine((value) => Number.isFinite(Date.parse(value)));
export const serviceIdentifierSchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);
export const normalizedText = (minimum: number, maximum: number) => z.string().transform((value) => value.trim()).refine((value) => codePointLength(value) >= minimum && codePointLength(value) <= maximum, `text must contain between ${minimum} and ${maximum} Unicode characters after trimming`);
export const departmentCodeSchema = z.string().trim().regex(/^[A-Za-z0-9_-]{1,60}$/);
export const catalogCodeSchema = z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_]{1,59}$/);
export const createRequestSchema = z.object({
  patientId: boundedString(1, 100),
  encounterId: boundedString(1, 100),
  admissionId: boundedString(1, 100).optional(),
  priority: z.enum(["ROUTINE", "URGENT", "EMERGENCY"]),
  items: z.array(z.object({ serviceId: boundedString(1, 100), note: normalizedText(1, 2000).optional() }).strict()).min(1).max(20),
  overrideReason: normalizedText(1, 500).optional()
}).strict();
export const createPatientSchema = z.object({
  displayName: normalizedText(2, 120),
  species: normalizedText(2, 60),
  breed: normalizedText(2, 120),
  sex: normalizedText(1, 40),
  birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  ownerLabel: normalizedText(2, 160),
  externalId: normalizedText(1, 100).optional(),
  encounterType: z.enum(["INPATIENT", "EMERGENCY", "OUTPATIENT"]),
  ward: normalizedText(1, 100).optional(),
  bed: normalizedText(1, 100).optional()
}).strict();
export const loginSchema = z.object({ email: z.string().email().refine((value) => codePointLength(value) <= 320), password: boundedString(1, 200) }).strict();
export const reasonCreateSchema = z.object({ type: z.enum(["RECOLLECTION", "CANCEL", "REJECT", "AMEND"]), code: catalogCodeSchema, label: normalizedText(1, 160) }).strict();
export const reasonPatchSchema = z.object({ label: normalizedText(1, 160).optional(), active: z.boolean().optional(), expectedVersion: expectedVersionSchema.optional() }).strict();
export function correlationFrom(request: Request): string {
  const supplied = request.headers.get("x-correlation-id")?.trim();
  return supplied && /^[A-Za-z0-9._:-]{1,100}$/.test(supplied) ? supplied : `corr_${randomUUID()}`;
}
export function requestId(): string {
  return `req_${randomUUID()}`;
}
export type ClientIdentitySignal = "proxy_not_configured" | "proxy_invalid" | "proxy_untrusted" | "client_address_missing";
export type ClientRateLimitIdentity = {
  key?: string;
  signal?: ClientIdentitySignal;
};
export function clientIdentityFor(request: Request): ClientRateLimitIdentity {
  const trustProxy = process.env.TRUST_PROXY?.trim();
  if (trustProxy === undefined)
    return { signal: "proxy_not_configured" };
  if (trustProxy !== "true")
    return { signal: "proxy_invalid" };
  const configuredSecret = process.env.TRUST_PROXY_SHARED_SECRET?.trim();
  const presentedSecret = request.headers.get("x-cvg-proxy-secret")?.trim();
  if (!configuredSecret || !presentedSecret || !sameSecret(presentedSecret, configuredSecret))
    return { signal: "proxy_untrusted" };
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const realIp = request.headers.get("x-real-ip")?.trim();
  const address = forwarded || realIp;
  if (!address || address.length > 200 || /[\r\n]/.test(address))
    return { signal: "client_address_missing" };
  return { key: createHash("sha256").update(address).digest("hex").slice(0, 32) };
}
/** Constant-time comparison; digests equalize lengths so the length does not leak either. */
function sameSecret(presented: string, configured: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(presented), digest(configured));
}
export function signalUnidentifiedClient(identity: ClientRateLimitIdentity): void {
  if (!identity.signal)
    return;
  createStructuredLogger().warn(`rate_limit.${identity.signal}`, { component: "security" });
}
export function assertProductionClientIdentity(identity: ClientRateLimitIdentity): void {
  if (identity.key || process.env.NODE_ENV !== "production")
    return;
  throw new ApiError("RATE_LIMIT_UNAVAILABLE", "O controle de abuso não está configurado para esta borda.", 503, { retryable: true });
}
export function clientRateLimitKey(identity: ClientRateLimitIdentity): string {
  return identity.key ?? "local";
}
export function responseFor<T>(data: T, correlationId: string, id: string, status = 200, extraMeta?: Record<string, unknown>): NextResponse {
  const response = createSuccessResponse(data, correlationId, id, status, extraMeta);
  const nextResponse = NextResponse.json(response.body, { status: response.status });
  nextResponse.headers.set("x-correlation-id", correlationId);
  nextResponse.headers.set("cache-control", "no-store");
  return nextResponse;
}
export function errorFor(error: unknown, correlationId: string, id: string): NextResponse {
  const normalizedError = normalizeRouteError(error);
  const response = toApiErrorResponse(normalizedError, correlationId, id);
  const nextResponse = NextResponse.json(response.body, { status: response.status });
  nextResponse.headers.set("x-correlation-id", correlationId);
  nextResponse.headers.set("cache-control", "no-store");
  return nextResponse;
}
// Network failures and PostgreSQL connection/shutdown/timeout SQLSTATEs (classes 08, 53300, 57P0x, 57014).
const DEPENDENCY_ERROR_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "EHOSTUNREACH", "ENOTFOUND", "EAI_AGAIN", "53300", "57P01", "57P02", "57P03", "57014"]);
const DEPENDENCY_ERROR_MESSAGE = /connection terminated|timeout exceeded when trying to connect|query read timeout|ECONNREFUSED|ECONNRESET|ETIMEDOUT/i;

/** A database outage is a retryable 503, not an unexpected 500. */
export function isDependencyUnavailable(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > 5) return false;
  const candidate = error as { code?: unknown; message?: unknown; cause?: unknown };
  const code = typeof candidate.code === "string" ? candidate.code : "";
  if (DEPENDENCY_ERROR_CODES.has(code) || /^08[0-9A-Z]{3}$/.test(code)) return true;
  if (typeof candidate.message === "string" && DEPENDENCY_ERROR_MESSAGE.test(candidate.message)) return true;
  return isDependencyUnavailable(candidate.cause, depth + 1);
}

export function normalizeRouteError(error: unknown): unknown {
  if (!(error instanceof ApiError) && isDependencyUnavailable(error)) {
    return new ApiError("DEPENDENCY_UNAVAILABLE", "Uma dependência do serviço está indisponível. Tente novamente em instantes.", 503, { retryable: true });
  }
  if (error instanceof RealtimeUnavailableError) {
    return error.reason === "capacity"
      ? new ApiError("REALTIME_CAPACITY", "O canal em tempo real atingiu sua capacidade operacional. Tente novamente.", 429, { retryable: true })
      : new ApiError("REALTIME_ADAPTER_UNAVAILABLE", "O canal em tempo real não está disponível nesta instância.", 500, { retryable: true });
  }
  return error;
}
export async function jsonBody(request: Request): Promise<unknown> {
  return readJsonWithLimit(request, {
    maxBytes: positiveInteger(process.env.JSON_BODY_MAX_BYTES, 1024 * 1024),
    maxDepth: positiveInteger(process.env.JSON_BODY_MAX_DEPTH, 32)
  });
}
export async function objectBody(request: Request): Promise<Record<string, unknown>> {
  const body = await jsonBody(request);
  if (!isRecord(body))
    throw new ApiError("VALIDATION_ERROR", "O corpo JSON deve ser um objeto.", 400);
  return body;
}
export function parseCommandBody<T>(body: Record<string, unknown>, schema: z.ZodType<T>, message: string): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    throw new ApiError("VALIDATION_ERROR", message, 400);
  return parsed.data;
}
export function commandMeta(request: Request, body: Record<string, unknown>, operation: ApiOperation): CommandMeta {
  const bodyVersion = typeof body.expectedVersion === "number" ? body.expectedVersion : undefined;
  const rawIfMatch = request.headers.get("if-match");
  let headerVersion: number | undefined;
  if (rawIfMatch !== null) {
    const match = /^(?:([1-9][0-9]{0,14})|"([1-9][0-9]{0,14})"|W\/"([1-9][0-9]{0,14})")$/.exec(rawIfMatch);
    if (!match)
      throw new ApiError("VALIDATION_ERROR", "O cabeçalho If-Match é inválido.", 400);
    headerVersion = Number(match[1] ?? match[2] ?? match[3]);
  }
  if (bodyVersion !== undefined && headerVersion !== undefined && bodyVersion !== headerVersion) {
    throw new ApiError("VALIDATION_ERROR", "If-Match e expectedVersion devem informar a mesma versão.", 400);
  }
  if (operation.concurrencyGuard && bodyVersion === undefined && headerVersion === undefined) {
    throw new ApiError("VALIDATION_ERROR", "expectedVersion ou If-Match é obrigatório para esta operação.", 400);
  }
  return {
    idempotencyKey: request.headers.get("idempotency-key") ?? undefined,
    expectedVersion: bodyVersion ?? headerVersion,
    correlationId: request.headers.get("x-correlation-id") ?? undefined
  };
}
export const REQUEST_HEADER_VALIDATORS = Object.freeze({
  "x-correlation-id": (value: string) => /^[A-Za-z0-9._:-]{1,100}$/.test(value),
  "x-csrf-token": (value: string) => codePointLength(value) >= 1 && codePointLength(value) <= 500,
  "idempotency-key": (value: string) => codePointLength(value) >= 1 && codePointLength(value) <= 200 && /\S/.test(value),
  "if-match": (value: string) => /^(?:[1-9][0-9]{0,14}|"[1-9][0-9]{0,14}"|W\/"[1-9][0-9]{0,14}")$/.test(value),
  "last-event-id": (value: string) => codePointLength(value) >= 1 && codePointLength(value) <= 200,
  "x-duplicate-override": (value: string) => value === "true"
} satisfies Record<ApiOperation["requestHeaders"][number]["name"], (value: string) => boolean>);
export function validateRequestHeaders(request: Request, operation: ApiOperation): void {
  for (const header of operation.requestHeaders) {
    const value = request.headers.get(header.name);
    if (value === null) {
      if (header.name === "idempotency-key" && header.required) {
        throw new ApiError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key é obrigatório para esta operação.", 400);
      }
      continue;
    }
    const validator = REQUEST_HEADER_VALIDATORS[header.name];
    if (!validator(value)) {
      const code = header.name === "idempotency-key" && header.required ? "IDEMPOTENCY_KEY_REQUIRED" : "VALIDATION_ERROR";
      throw new ApiError(code, `O cabeçalho ${header.name} é inválido.`, 400);
    }
  }
}
export async function pathFor(context: RouteContext): Promise<string[]> {
  const params = await context.params;
  return [...params.path];
}
export async function flushConfiguredLocalOutbox(store: Awaited<ReturnType<typeof getRuntimeStoreAsync>>): Promise<void> {
  if (process.env.OUTBOX_INLINE_LOCAL !== "true" || process.env.NODE_ENV === "production")
    return;
  await processOutboxBatch(store, createSafeConsoleSink(() => undefined), { workerId: `inline_${process.pid}`, batchSize: 100, allowSyntheticDelivery: true });
}
export function publicUser(user: {
  id: string;
  email: string;
  displayName: string;
  role: string;
  departmentCode: string;
  timezone: string;
  managedDepartmentCodes?: ReadonlyArray<string>;
  mustChangePassword?: boolean;
  whatsappPhone?: string;
  whatsappConsentAt?: string;
  onCall?: boolean;
}) {
  const alertContact = user.whatsappPhone && user.whatsappConsentAt ? { maskedPhone: maskAlertPhone(user.whatsappPhone), consentAt: user.whatsappConsentAt } : undefined;
  return { id: user.id, email: user.email, displayName: user.displayName, role: user.role, departmentCode: user.departmentCode, managedDepartmentCodes: user.managedDepartmentCodes ? [...user.managedDepartmentCodes] : undefined, timezone: user.timezone, mustChangePassword: user.mustChangePassword, alertContact, onCall: user.onCall === true ? true : undefined };
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
export function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
export async function assertHealthRateLimit(key: string, limit: number): Promise<void> {
  try {
    await assertRateLimit(key, limit, 60000);
  }
  catch (error) {
    if (error instanceof ApiError)
      throw error;
    throw new ApiError("NOT_READY", "O controle de abuso ainda não está configurado.", 503, { retryable: true });
  }
}
export function parseLimit(value: string | null, fallback = 25): number {
  const parsed = z.coerce.number().int().min(1).max(100).safeParse(value === null ? fallback : value);
  if (!parsed.success)
    throw new ApiError("VALIDATION_ERROR", "O limite deve ser um inteiro entre 1 e 100.", 400);
  return parsed.data;
}
export function parseItemState(value: string | null) {
  if (value === null)
    return undefined;
  const parsed = z.enum(ITEM_STATES).safeParse(value);
  if (!parsed.success)
    throw new ApiError("VALIDATION_ERROR", "O status informado é inválido.", 400);
  return parsed.data;
}
export function parsePriority(value: string | null) {
  if (value === null)
    return undefined;
  const parsed = z.enum(PRIORITIES).safeParse(value);
  if (!parsed.success)
    throw new ApiError("VALIDATION_ERROR", "A prioridade informada é inválida.", 400);
  return parsed.data;
}
export function parseBooleanFilter(value: string | null, field: string): boolean | undefined {
  if (value === null)
    return undefined;
  if (value === "true")
    return true;
  if (value === "false")
    return false;
  throw new ApiError("VALIDATION_ERROR", `O filtro ${field} é inválido.`, 400);
}
export function parseServiceIdentifier(value: string | null): string | undefined {
  if (value === null)
    return undefined;
  const parsed = serviceIdentifierSchema.safeParse(value);
  if (!parsed.success)
    throw new ApiError("VALIDATION_ERROR", "O serviço informado é inválido.", 400);
  return parsed.data;
}
export function parseDateTimeFilter(value: string | null, field: string): string | undefined {
  if (value === null)
    return undefined;
  const parsed = queryDateTimeSchema.safeParse(value);
  if (!parsed.success)
    throw new ApiError("VALIDATION_ERROR", `O filtro ${field} é inválido.`, 400);
  return parsed.data;
}
export function parseSearchTypes(value: string | null): SearchResultType[] | undefined {
  if (value === null)
    return undefined;
  if (!/^(REQUEST|ITEM)(\s*,\s*(REQUEST|ITEM))*$/.test(value)) {
    throw new ApiError("VALIDATION_ERROR", "O tipo de busca é inválido.", 400);
  }
  const types = value.split(",").map((entry) => entry.trim());
  return [...new Set(types)] as SearchResultType[];
}
export function parseCursor(value: string | null): string | undefined {
  if (value === null)
    return undefined;
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 200)
    throw new ApiError("VALIDATION_ERROR", "O cursor informado é inválido.", 400);
  return value;
}
