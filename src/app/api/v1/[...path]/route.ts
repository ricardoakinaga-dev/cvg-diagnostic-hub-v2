import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createApplicationService } from "../../../../server/application/service";
import { createSuccessResponse, toApiErrorResponse } from "../../../../server/http/envelope";
import { getRuntimeFileStore, getRuntimeReadiness, getRuntimeStoreAsync } from "../../../../server/store/runtime";
import { authenticateRequest, authorizationSnapshotIsCurrent, clearSessionCookies, getCookieValue, loginUser, reauthenticateUser, revokeSession, sessionCookies } from "../../../../server/security/session";
import type { CommandMeta, SearchResultType } from "../../../../server/application/service";
import { ApiError } from "../../../../server/http/envelope";
import { canAccessResource } from "../../../../server/security/authorization";
import { eventVisible } from "../../../../server/application/realtime-visibility";
import { assertRateLimit } from "../../../../server/security/rate-limit";
import { createSafeConsoleSink, processOutboxBatch } from "../../../../server/operations/outbox";
import { recordHttpRequest, recordReadinessFailure, refreshOperationalMetrics, renderPrometheus, routeMetricLabel } from "../../../../server/observability/metrics";
import { logHttpRequest } from "../../../../server/observability/structured-logger";
import { notifyRealtimeMutation } from "../../../../server/observability/realtime";
import { createRealtimeResponse, RealtimeUnavailableError } from "../../../../server/observability/realtime-stream";
import { ITEM_STATES, PRIORITIES, ROLES } from "@cvg/contracts";
import {
  acknowledgeNotificationSchema,
  admissionContextSchema,
  amendResultSchema,
  attachmentFinalizeSchema,
  attachmentUploadSchema,
  cancelSchema,
  emptyCommandSchema,
  recollectionSchema,
  rejectSchema,
  releaseResultSchema,
  resultDraftSchema,
  reviewResultSchema,
  sampleSchema,
  scheduleSchema,
  voidResultSchema
} from "../../../../server/http/command-schemas";
import { readBytesWithLimit, readJsonWithLimit } from "../../../../server/http/request-body";
import { matchApiOperation, type ApiOperation } from "../../../../server/http/api-operation-manifest";

type RouteContext = { params: Promise<{ path: string[] }> };

const codePointLength = (value: string) => Array.from(value).length;
const boundedString = (minimum: number, maximum: number) => z.string().refine(
  (value) => codePointLength(value) >= minimum && codePointLength(value) <= maximum,
  `text must contain between ${minimum} and ${maximum} Unicode characters`
);
const expectedVersionSchema = z.number().int().positive().max(999_999_999_999_999);
const queryDateTimeSchema = z.string().max(100).datetime({ offset: true }).refine((value) => Number.isFinite(Date.parse(value)));
const serviceIdentifierSchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);
const normalizedText = (minimum: number, maximum: number) => z.string().transform((value) => value.trim()).refine(
  (value) => codePointLength(value) >= minimum && codePointLength(value) <= maximum,
  `text must contain between ${minimum} and ${maximum} Unicode characters after trimming`
);
const departmentCodeSchema = z.string().trim().regex(/^[A-Za-z0-9_-]{1,60}$/);
const catalogCodeSchema = z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_]{1,59}$/);

const createRequestSchema = z.object({
  patientId: boundedString(1, 100),
  encounterId: boundedString(1, 100),
  admissionId: boundedString(1, 100).optional(),
  priority: z.enum(["ROUTINE", "URGENT", "EMERGENCY"]),
  items: z.array(z.object({ serviceId: boundedString(1, 100), note: normalizedText(1, 2000).optional() }).strict()).min(1).max(20),
  overrideReason: normalizedText(1, 500).optional()
}).strict();
const createPatientSchema = z.object({
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

const loginSchema = z.object({ email: z.string().email().refine((value) => codePointLength(value) <= 320), password: boundedString(1, 200) }).strict();
const serviceCreateSchema = z.object({
  code: catalogCodeSchema,
  name: normalizedText(1, 120),
  category: z.enum(["LABORATORY", "IMAGING"]),
  departmentCode: departmentCodeSchema,
  workflowType: z.enum(["LABORATORY", "RADIOLOGY", "ULTRASOUND"]),
  requiresSample: z.boolean(),
  requiresSchedule: z.boolean(),
  allowsAttachment: z.boolean(),
  resultSchema: z.enum(["NUMERIC_PANEL", "NARRATIVE"]),
  slaHours: z.object({ ROUTINE: z.number().positive().max(720), URGENT: z.number().positive().max(720), EMERGENCY: z.number().positive().max(720) }).strict()
}).strict();
const servicePatchSchema = z.object({ name: normalizedText(1, 120).optional(), category: z.enum(["LABORATORY", "IMAGING"]).optional(), departmentCode: departmentCodeSchema.optional(), workflowType: z.enum(["LABORATORY", "RADIOLOGY", "ULTRASOUND"]).optional(), requiresSample: z.boolean().optional(), requiresSchedule: z.boolean().optional(), active: z.boolean().optional(), allowsAttachment: z.boolean().optional(), resultSchema: z.enum(["NUMERIC_PANEL", "NARRATIVE"]).optional(), slaHours: z.object({ ROUTINE: z.number().positive().max(720), URGENT: z.number().positive().max(720), EMERGENCY: z.number().positive().max(720) }).strict().optional(), expectedVersion: expectedVersionSchema.optional() }).strict();
const reasonCreateSchema = z.object({ type: z.enum(["RECOLLECTION", "CANCEL", "REJECT", "AMEND"]), code: catalogCodeSchema, label: normalizedText(1, 160) }).strict();
const reasonPatchSchema = z.object({ label: normalizedText(1, 160).optional(), active: z.boolean().optional(), expectedVersion: expectedVersionSchema.optional() }).strict();
const reauthenticationSchema = z.object({ password: boundedString(1, 200) }).strict();
const managedDepartmentCodesSchema = z.array(departmentCodeSchema).max(20).optional();
const userRoleSchema = z.object({ role: z.enum(ROLES), departmentCode: departmentCodeSchema, managedDepartmentCodes: managedDepartmentCodesSchema, active: z.boolean().optional(), expectedVersion: expectedVersionSchema.optional(), reason: normalizedText(1, 500), confirm: z.literal(true) }).strict();
const userCreateSchema = z.object({ email: z.string().email().refine((value) => codePointLength(value) <= 320), displayName: normalizedText(2, 160), password: boundedString(12, 200), role: z.enum(ROLES), departmentCode: departmentCodeSchema, managedDepartmentCodes: managedDepartmentCodesSchema, timezone: normalizedText(1, 80), reason: normalizedText(1, 500), confirm: z.literal(true) }).strict();
const userDeactivateSchema = z.object({ expectedVersion: expectedVersionSchema.optional(), reason: normalizedText(1, 500), confirm: z.literal(true) }).strict();

function correlationFrom(request: Request): string {
  const supplied = request.headers.get("x-correlation-id")?.trim();
  return supplied && /^[A-Za-z0-9._:-]{1,100}$/.test(supplied) ? supplied : `corr_${randomUUID()}`;
}

function requestId(): string {
  return `req_${randomUUID()}`;
}

function clientAddressFor(request: Request): string {
  if (process.env.TRUST_PROXY !== "true") return "local-client";
  const configuredSecret = process.env.TRUST_PROXY_SHARED_SECRET?.trim();
  const presentedSecret = request.headers.get("x-cvg-proxy-secret")?.trim();
  if (!configuredSecret || !presentedSecret || presentedSecret !== configuredSecret) return "untrusted-proxy";
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const realIp = request.headers.get("x-real-ip")?.trim();
  const address = forwarded || realIp;
  return address && address.length <= 200 ? address : "trusted-proxy";
}

function responseFor<T>(data: T, correlationId: string, id: string, status = 200, extraMeta?: Record<string, unknown>): NextResponse {
  const response = createSuccessResponse(data, correlationId, id, status, extraMeta);
  const nextResponse = NextResponse.json(response.body, { status: response.status });
  nextResponse.headers.set("x-correlation-id", correlationId);
  nextResponse.headers.set("cache-control", "no-store");
  return nextResponse;
}

function errorFor(error: unknown, correlationId: string, id: string): NextResponse {
  if (error instanceof RealtimeUnavailableError) {
    error = error.reason === "capacity"
      ? new ApiError("REALTIME_CAPACITY", "O canal em tempo real atingiu sua capacidade operacional. Tente novamente.", 429, { retryable: true })
      : new ApiError("REALTIME_ADAPTER_UNAVAILABLE", "O canal em tempo real não está disponível nesta instância.", 500, { retryable: true });
  }
  const response = toApiErrorResponse(error, correlationId, id);
  const nextResponse = NextResponse.json(response.body, { status: response.status });
  nextResponse.headers.set("x-correlation-id", correlationId);
  nextResponse.headers.set("cache-control", "no-store");
  return nextResponse;
}

async function jsonBody(request: Request): Promise<unknown> {
  return readJsonWithLimit(request, {
    maxBytes: positiveInteger(process.env.JSON_BODY_MAX_BYTES, 1024 * 1024),
    maxDepth: positiveInteger(process.env.JSON_BODY_MAX_DEPTH, 32)
  });
}

async function objectBody(request: Request): Promise<Record<string, unknown>> {
  const body = await jsonBody(request);
  if (!isRecord(body)) throw new ApiError("VALIDATION_ERROR", "O corpo JSON deve ser um objeto.", 400);
  return body;
}

function parseCommandBody<T>(body: Record<string, unknown>, schema: z.ZodType<T>, message: string): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ApiError("VALIDATION_ERROR", message, 400);
  return parsed.data;
}

function commandMeta(request: Request, body: Record<string, unknown>, operation: ApiOperation): CommandMeta {
  const bodyVersion = typeof body.expectedVersion === "number" ? body.expectedVersion : undefined;
  const rawIfMatch = request.headers.get("if-match");
  let headerVersion: number | undefined;
  if (rawIfMatch !== null) {
    const match = /^(?:([1-9][0-9]{0,14})|"([1-9][0-9]{0,14})"|W\/"([1-9][0-9]{0,14})")$/.exec(rawIfMatch);
    if (!match) throw new ApiError("VALIDATION_ERROR", "O cabeçalho If-Match é inválido.", 400);
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

const REQUEST_HEADER_VALIDATORS = Object.freeze({
  "x-correlation-id": (value: string) => /^[A-Za-z0-9._:-]{1,100}$/.test(value),
  "x-csrf-token": (value: string) => codePointLength(value) >= 1 && codePointLength(value) <= 500,
  "idempotency-key": (value: string) => codePointLength(value) >= 1 && codePointLength(value) <= 200 && /\S/.test(value),
  "if-match": (value: string) => /^(?:[1-9][0-9]{0,14}|"[1-9][0-9]{0,14}"|W\/"[1-9][0-9]{0,14}")$/.test(value),
  "last-event-id": (value: string) => codePointLength(value) >= 1 && codePointLength(value) <= 200,
  "x-duplicate-override": (value: string) => value === "true"
} satisfies Record<ApiOperation["requestHeaders"][number]["name"], (value: string) => boolean>);

function validateRequestHeaders(request: Request, operation: ApiOperation): void {
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

async function pathFor(context: RouteContext): Promise<string[]> {
  const params = await context.params;
  return [...params.path];
}

async function dispatch(method: string, request: Request, context: RouteContext): Promise<Response> {
  const startedAt = performance.now();
  let metricPath: string[] = [];
  try {
    metricPath = await pathFor(context);
  } catch {
    metricPath = ["invalid"];
  }
  const response = await dispatchInner(method, request, context);
  if (method !== "GET" && response.status >= 200 && response.status < 300) notifyRealtimeMutation();
  const route = routeMetricLabel(metricPath);
  const durationMs = performance.now() - startedAt;
  recordHttpRequest(method, route, response.status, durationMs);
  logHttpRequest({
    method,
    route,
    status: response.status,
    durationMs,
    correlationId: response.headers.get("x-correlation-id") ?? undefined
  });
  return response;
}

async function dispatchInner(method: string, request: Request, context: RouteContext): Promise<Response> {
  const correlationId = correlationFrom(request);
  const id = requestId();
  try {
    const path = await pathFor(context);
    const operation = matchApiOperation(method, path);
    if (!operation) throw new ApiError("NOT_FOUND", "Rota não encontrada.", 404);
    validateRequestHeaders(request, operation);
    const isLogin = operation.operationId === "login";
    const isPublic = operation.authentication === "public";
    if (path[0] === "livez" && method === "GET") return responseFor({ status: "ok", service: "cvg-diagnostics-hub" }, correlationId, id);
    if (path[0] === "readyz" && method === "GET") {
      try {
        return responseFor({ status: "ready", ...(await getRuntimeReadiness()) }, correlationId, id);
      } catch {
        recordReadinessFailure();
        throw new ApiError("NOT_READY", "A dependência de persistência ainda não está disponível.", 503, { retryable: true });
      }
    }
    const clientAddress = clientAddressFor(request);
    const loginRateLimit = positiveInteger(process.env.LOGIN_RATE_LIMIT, 10);
    await assertRateLimit(`${clientAddress}:${operation.operationId}`, operation.operationId === "login" ? loginRateLimit : 240, 60_000);
    const store = await getRuntimeStoreAsync();
    await flushConfiguredLocalOutbox(store);
    const service = createApplicationService(store, { storage: getRuntimeFileStore() });
    if (isPublic && isLogin && method === "POST") {
      const parsed = loginSchema.safeParse(await jsonBody(request));
      if (!parsed.success) throw new ApiError("VALIDATION_ERROR", "Informe e-mail e senha válidos.", 400);
      await assertRateLimit(`login-email:${parsed.data.email.trim().toLowerCase()}`, loginRateLimit, 60_000);
      const login = await loginUser(store, parsed.data.email, parsed.data.password);
      const response = responseFor({ user: publicUser(login.user), expiresAt: login.expiresAt }, correlationId, id);
      for (const cookie of sessionCookies(login)) response.headers.append("set-cookie", cookie);
      return response;
    }

    const actor = await authenticateRequest(store, request, { requireCsrf: operation.csrf });
    if (operation.operationId === "uploadAttachmentContent") {
      await assertRateLimit(`${clientAddress}:${actor.id}:attachment-content`, positiveInteger(process.env.ATTACHMENT_UPLOAD_RATE_LIMIT, 30), 60_000);
    }
    if (path[0] === "metrics" && method === "GET") {
      if (!canAccessResource(actor, "health.readiness", {})) throw new ApiError("NOT_FOUND", "Rota não encontrada.", 404);
      const state = await store.readState();
      refreshOperationalMetrics(state);
      const body = renderPrometheus();
      return new Response(body, { status: 200, headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store", "x-correlation-id": correlationId } });
    }
    if (path[0] === "session" && path[1] === "me" && method === "GET") return responseFor({ user: publicUser(actor) }, correlationId, id);
    if (path[0] === "session" && path[1] === "logout" && method === "POST") {
      const sessionToken = getCookieValue(request, "cvg_session");
      if (sessionToken) await revokeSession(store, sessionToken);
      const response = responseFor({ loggedOut: true }, correlationId, id);
      for (const cookie of clearSessionCookies()) response.headers.append("set-cookie", cookie);
      return response;
    }
    if (path[0] === "session" && path[1] === "reauth" && method === "POST") {
      const parsed = reauthenticationSchema.safeParse(await jsonBody(request));
      if (!parsed.success) throw new ApiError("VALIDATION_ERROR", "Informe sua senha para confirmar a identidade.", 400);
      const reauthenticated = await reauthenticateUser(store, request, parsed.data.password);
      return responseFor({ user: publicUser(reauthenticated), reauthenticatedAt: reauthenticated.reauthenticatedAt }, correlationId, id);
    }

    if (path[0] === "users" && path.length === 1 && method === "GET") return responseFor(await service.listManagedUsers(actor), correlationId, id);
    if (path[0] === "users" && path.length === 1 && method === "POST") {
      const body = await objectBody(request);
      const parsed = userCreateSchema.safeParse(body);
      if (!parsed.success) throw new ApiError("VALIDATION_ERROR", "Os dados do colaborador são inválidos.", 400);
      return responseFor(await service.createManagedUser(actor, { ...parsed.data, ...commandMeta(request, body, operation) }), correlationId, id, 201);
    }
    if (path[0] === "users" && path.length === 2 && method === "DELETE") {
      const body = await objectBody(request);
      const parsed = userDeactivateSchema.safeParse(body);
      if (!parsed.success) throw new ApiError("VALIDATION_ERROR", "Os dados de desativação são inválidos.", 400);
      return responseFor(await service.deactivateManagedUser(actor, path[1], { ...parsed.data, ...commandMeta(request, body, operation) }), correlationId, id);
    }
    if (path[0] === "users" && path.length === 3 && path[2] === "roles" && method === "POST") {
      const body = await objectBody(request);
      const parsed = userRoleSchema.safeParse(body);
      if (!parsed.success) throw new ApiError("VALIDATION_ERROR", "Os dados de role são inválidos.", 400);
      return responseFor(await service.updateUserRole(actor, path[1], { ...parsed.data, ...commandMeta(request, body, operation) }), correlationId, id);
    }

    if (path[0] === "diagnostic-services" && method === "GET" && path.length === 1) {
      const includeInactive = parseBooleanFilter(new URL(request.url).searchParams.get("includeInactive"), "includeInactive") ?? false;
      return responseFor(await service.listServices(actor, { includeInactive }), correlationId, id);
    }
    if (path[0] === "diagnostic-services" && path.length === 3 && path[2] === "result-template" && method === "GET") {
      return responseFor(await service.getResultTemplate(actor, path[1]), correlationId, id);
    }
    if (path[0] === "diagnostic-services" && path.length === 1 && method === "POST") {
      const body = await objectBody(request);
      const parsed = serviceCreateSchema.safeParse(body);
      if (!parsed.success) throw new ApiError("VALIDATION_ERROR", "Os dados do serviço são inválidos.", 400);
      return responseFor(await service.createDiagnosticService(actor, { ...parsed.data, ...commandMeta(request, body, operation) }), correlationId, id, 201);
    }
    if (path[0] === "diagnostic-services" && path.length === 2 && method === "PATCH") {
      const body = await objectBody(request);
      const parsed = servicePatchSchema.safeParse(body);
      if (!parsed.success) throw new ApiError("VALIDATION_ERROR", "Os dados do serviço são inválidos.", 400);
      return responseFor(await service.updateDiagnosticService(actor, path[1], { ...parsed.data, ...commandMeta(request, body, operation) }), correlationId, id);
    }
    if (path[0] === "reason-codes" && path.length === 1 && method === "POST") {
      const body = await objectBody(request);
      const parsed = reasonCreateSchema.safeParse(body);
      if (!parsed.success) throw new ApiError("VALIDATION_ERROR", "Os dados do motivo são inválidos.", 400);
      return responseFor(await service.createReasonCode(actor, { ...parsed.data, ...commandMeta(request, body, operation) }), correlationId, id, 201);
    }
    if (path[0] === "reason-codes" && path.length === 2 && method === "PATCH") {
      const body = await objectBody(request);
      const parsed = reasonPatchSchema.safeParse(body);
      if (!parsed.success) throw new ApiError("VALIDATION_ERROR", "Os dados do motivo são inválidos.", 400);
      return responseFor(await service.updateReasonCode(actor, path[1], { ...parsed.data, ...commandMeta(request, body, operation) }), correlationId, id);
    }
    if (path[0] === "reason-codes" && path.length === 1 && method === "GET") return responseFor(await service.listReasonCodes(actor), correlationId, id);
    if (path[0] === "patients" && method === "GET" && path.length === 1) {
      const query = new URL(request.url).searchParams.get("q") ?? "";
      if (codePointLength(query) > 200) throw new ApiError("VALIDATION_ERROR", "A busca de pacientes é muito longa.", 400);
      return responseFor(await service.listPatients(actor, query), correlationId, id);
    }
    if (path[0] === "patients" && method === "POST" && path.length === 1) {
      const body = await objectBody(request);
      const parsed = createPatientSchema.safeParse(body);
      if (!parsed.success) throw new ApiError("VALIDATION_ERROR", "Os dados do paciente são inválidos.", 400);
      return responseFor(await service.createPatient(actor, parsed.data, commandMeta(request, body, operation)), correlationId, id, 201);
    }
    if (path[0] === "patients" && path.length === 3 && path[2] === "diagnostics" && method === "GET") {
      const search = new URL(request.url).searchParams;
      return responseFor(await service.getPatientDiagnostics(actor, path[1], { limit: parseLimit(search.get("limit")), cursor: parseCursor(search.get("cursor")) }), correlationId, id);
    }
    if (path[0] === "patients" && path.length === 3 && path[2] === "encounters" && method === "GET") return responseFor(await service.listEncounters(actor, path[1]), correlationId, id);
    if (path[0] === "patients" && method === "GET" && path.length === 2) return responseFor(await service.getPatient(actor, path[1]), correlationId, id);
    if (path[0] === "encounters" && method === "GET" && path.length === 2) return responseFor(await service.getEncounter(actor, path[1]), correlationId, id);
    if (path[0] === "admissions" && method === "GET" && path.length === 2) return responseFor(await service.getAdmission(actor, path[1]), correlationId, id);
    if (path[0] === "admissions" && path.length === 3 && path[2] === "context" && method === "POST") {
      const body = await objectBody(request);
      const input = parseCommandBody(body, admissionContextSchema, "Os dados da atualização de contexto são inválidos.");
      return responseFor(await service.updateAdmissionContext(actor, path[1], { ...input, ...commandMeta(request, body, operation) }), correlationId, id);
    }

    if (path[0] === "diagnostic-requests" && path.length === 1 && method === "GET") {
      const search = new URL(request.url).searchParams;
      const data = await service.listRequests(actor, {
        status: parseItemState(search.get("status")),
        departmentCode: search.get("departmentCode") ?? search.get("departmentId") ?? undefined,
        priority: parsePriority(search.get("priority")),
        serviceId: parseServiceIdentifier(search.get("serviceId")),
        overdue: parseBooleanFilter(search.get("overdue"), "overdue"),
        from: parseDateTimeFilter(search.get("from"), "from"),
        to: parseDateTimeFilter(search.get("to"), "to"),
        cursor: parseCursor(search.get("cursor")),
        limit: parseLimit(search.get("limit"))
      });
      return responseFor(data.items, correlationId, id, 200, { nextCursor: data.nextCursor, limit: data.limit, total: data.total });
    }
    if (path[0] === "diagnostic-requests" && path.length === 1 && method === "POST") {
      const parsed = createRequestSchema.safeParse(await jsonBody(request));
      if (!parsed.success) throw new ApiError("VALIDATION_ERROR", "Os dados da solicitação são inválidos.", 400);
      const body = parsed.data;
      const result = await service.createRequest(actor, body, { ...commandMeta(request, body, operation), allowDuplicateOverride: request.headers.get("x-duplicate-override") === "true" });
      return responseFor(result, correlationId, id, 201);
    }
    if (path[0] === "diagnostic-requests" && path.length === 2 && method === "GET") return responseFor(await service.getRequest(actor, path[1]), correlationId, id);
    if (path[0] === "diagnostic-requests" && path.length === 3 && path[2] === "cancel" && method === "POST") {
      const body = await objectBody(request);
      const input = parseCommandBody(body, cancelSchema, "Os dados de cancelamento são inválidos.");
      return responseFor(await service.cancelRequest(actor, path[1], { ...input, ...commandMeta(request, body, operation) }), correlationId, id);
    }

    if (path[0] === "diagnostic-items" && path.length === 2 && method === "GET") return responseFor(await service.getItem(actor, path[1]), correlationId, id);
    if (path[0] === "diagnostic-items" && path.length >= 3) {
      const itemId = path[1];
      const action = path[2];
      if (method !== "POST") throw new ApiError("NOT_FOUND", "Rota não encontrada.", 404);
      const body = await objectBody(request);
      const meta = commandMeta(request, body, operation);
      if (action === "receive-sample") {
        const input = parseCommandBody(body, sampleSchema, "Os dados da amostra são inválidos.");
        return responseFor(await service.receiveSample(actor, [itemId], { ...input, ...meta }), correlationId, id);
      }
      if (action === "start-processing") {
        parseCommandBody(body, emptyCommandSchema, "Os dados de processamento são inválidos.");
        return responseFor(await service.startProcessing(actor, itemId, meta), correlationId, id);
      }
      if (action === "cancel") {
        const input = parseCommandBody(body, cancelSchema, "Os dados de cancelamento são inválidos.");
        return responseFor(await service.cancelItem(actor, itemId, { ...input, ...meta }), correlationId, id);
      }
      if (action === "reject") {
        const input = parseCommandBody(body, rejectSchema, "Os dados de rejeição são inválidos.");
        return responseFor(await service.rejectItem(actor, itemId, { ...input, ...meta }), correlationId, id);
      }
      if (action === "complete") {
        parseCommandBody(body, emptyCommandSchema, "Os dados de conclusão são inválidos.");
        return responseFor(await service.completeItem(actor, itemId, meta), correlationId, id);
      }
      if (action === "schedule") {
        const input = parseCommandBody(body, scheduleSchema, "Os dados de agenda são inválidos.");
        return responseFor(await service.scheduleProcedure(actor, itemId, { ...input, ...meta }), correlationId, id);
      }
      if (action === "start-procedure") {
        parseCommandBody(body, emptyCommandSchema, "Os dados de procedimento são inválidos.");
        return responseFor(await service.startProcedure(actor, itemId, meta), correlationId, id);
      }
      if (action === "mark-performed") {
        parseCommandBody(body, emptyCommandSchema, "Os dados do procedimento são inválidos.");
        return responseFor(await service.markProcedurePerformed(actor, itemId, meta), correlationId, id);
      }
      if (action === "request-recollection") {
        const input = parseCommandBody(body, recollectionSchema, "Os dados de recoleta são inválidos.");
        return responseFor(await service.requestRecollectionForItem(actor, itemId, { ...input, ...meta }), correlationId, id);
      }
      if (action === "results" && method === "POST") {
        const input = parseCommandBody(body, resultDraftSchema, "Os dados do resultado são inválidos.");
        return responseFor(await service.createResultDraft(actor, itemId, { ...input, ...meta }), correlationId, id, 201);
      }
    }

    if (path[0] === "samples" && path.length === 3 && path[2] === "receive-replacement" && method === "POST") {
      const body = await objectBody(request);
      const input = parseCommandBody(body, sampleSchema, "Os dados da amostra substituta são inválidos.");
      return responseFor(await service.receiveReplacement(actor, path[1], { ...input, ...commandMeta(request, body, operation) }), correlationId, id);
    }
    if (path[0] === "procedures" && path.length === 3 && path[2] === "reschedule" && method === "POST") {
      const body = await objectBody(request);
      const input = parseCommandBody(body, scheduleSchema, "Os dados de remarcação são inválidos.");
      return responseFor(await service.rescheduleProcedure(actor, path[1], { ...input, ...commandMeta(request, body, operation) }), correlationId, id);
    }
    if (path[0] === "result-versions" && path.length === 4 && path[2] === "attachments" && path[3] === "upload-session" && method === "POST") {
      const body = await objectBody(request);
      const input = parseCommandBody(body, attachmentUploadSchema, "Os dados do anexo são inválidos.");
      return responseFor(await service.createAttachmentUploadSession(actor, path[1], { ...input, ...commandMeta(request, body, operation) }), correlationId, id, 201);
    }
    if (path[0] === "attachments" && path.length === 3 && path[2] === "content" && method === "PUT") {
      const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (mediaType !== "application/octet-stream") throw new ApiError("UNSUPPORTED_MEDIA_TYPE", "O tipo de conteúdo não é suportado.", 415);
      const maxAttachmentBytes = positiveInteger(process.env.ATTACHMENT_MAX_BYTES, 25 * 1024 * 1024);
      const authorized = await service.authorizeAttachmentUpload(actor, path[1]);
      const bytes = await readBytesWithLimit(request, Math.min(maxAttachmentBytes, authorized.sizeBytes));
      return responseFor(await service.uploadAttachment(actor, path[1], bytes), correlationId, id);
    }
    if (path[0] === "attachments" && path.length === 3 && path[2] === "finalize" && method === "POST") {
      const body = await objectBody(request);
      parseCommandBody(body, attachmentFinalizeSchema, "Os dados de finalização são inválidos.");
      return responseFor(await service.finalizeAttachment(actor, path[1], commandMeta(request, body, operation)), correlationId, id);
    }
    if (path[0] === "attachments" && path.length === 3 && path[2] === "download" && method === "GET") {
      const downloaded = await service.downloadAttachment(actor, path[1]);
      return new Response(downloaded.content as unknown as BodyInit, { status: 200, headers: { "content-type": downloaded.attachment.detectedMime, "content-length": String(downloaded.content.byteLength), "content-disposition": `attachment; filename="${downloaded.attachment.safeName}"`, "cache-control": "private, no-store", "x-correlation-id": correlationId } });
    }

    if (path[0] === "results" && path.length >= 2) {
      const resultId = path[1];
      if (path.length === 2 && method === "GET") return responseFor(await service.getResult(actor, resultId), correlationId, id);
      if (path[2] === "versions" && method === "GET") return responseFor(await service.listResultVersions(actor, resultId), correlationId, id);
      if (path[2] === "draft" && method === "PATCH") {
        const body = await objectBody(request);
        const input = parseCommandBody(body, resultDraftSchema, "Os dados do draft são inválidos.");
        return responseFor(await service.updateResultDraft(actor, resultId, { ...input, ...commandMeta(request, body, operation) }), correlationId, id);
      }
      if (path[2] === "release" && method === "POST") {
        const body = await objectBody(request);
        const input = parseCommandBody(body, releaseResultSchema, "Os dados de liberação são inválidos.");
        return responseFor(await service.releaseResult(actor, resultId, { ...input, ...commandMeta(request, body, operation) }), correlationId, id);
      }
      if (path[2] === "amend" && method === "POST") {
        const body = await objectBody(request);
        const input = parseCommandBody(body, amendResultSchema, "Os dados da emenda são inválidos.");
        return responseFor(await service.amendResult(actor, resultId, { ...input, ...commandMeta(request, body, operation) }), correlationId, id);
      }
      if (path[2] === "void" && method === "POST") {
        const body = await objectBody(request);
        const input = parseCommandBody(body, voidResultSchema, "Os dados de invalidação são inválidos.");
        return responseFor(await service.voidResult(actor, resultId, { ...input, ...commandMeta(request, body, operation) }), correlationId, id);
      }
      if (path[2] === "view" && method === "POST") {
        const body = await objectBody(request);
        const input = parseCommandBody(body, reviewResultSchema, "Os dados de visualização são inválidos.");
        const current = await service.getResult(actor, resultId);
        const versionId = input.versionId;
        if (current.version.id !== versionId) throw new ApiError("REVIEW_STALE", "A versão do resultado mudou. Atualize o contexto.", 409);
        return responseFor(await service.viewResult(actor, versionId, commandMeta(request, body, operation)), correlationId, id);
      }
      if (path[2] === "review" && method === "POST") {
        const body = await objectBody(request);
        const input = parseCommandBody(body, reviewResultSchema, "Os dados de revisão são inválidos.");
        return responseFor(await service.reviewResult(actor, resultId, { ...input, ...commandMeta(request, body, operation) }), correlationId, id);
      }
    }

    if (path[0] === "reports" && path.length === 2 && method === "GET") return responseFor(await service.getReport(actor, path[1]), correlationId, id);

    if (path[0] === "audit-events" && path.length === 1 && method === "GET") {
      const search = new URL(request.url).searchParams;
      const data = await service.listAuditEvents(actor, { limit: parseLimit(search.get("limit")), cursor: parseCursor(search.get("cursor")) });
      return responseFor(data.items, correlationId, id, 200, { nextCursor: data.nextCursor, limit: data.limit, total: data.total });
    }

    if (path[0] === "notifications" && method === "GET") {
      const search = new URL(request.url).searchParams;
      const data = await service.listNotifications(actor, (search.get("filter") as "ALL" | "UNREAD" | "ACTIONABLE" | "CRITICAL") ?? "ALL", {
        cursor: parseCursor(search.get("cursor")),
        limit: parseLimit(search.get("limit"))
      });
      return responseFor(data.items, correlationId, id, 200, { nextCursor: data.nextCursor, limit: data.limit, total: data.total });
    }
    if (path[0] === "notifications" && path[2] === "acknowledge" && method === "POST") {
      const body = await objectBody(request);
      const parsed = parseCommandBody(body, acknowledgeNotificationSchema, "Os dados de confirmação são inválidos.");
      return responseFor(await service.acknowledgeNotification(actor, path[1], { ...parsed, ...commandMeta(request, body, operation) }), correlationId, id);
    }
    if (path[0] === "queues" && path[2] === "items" && method === "GET") {
      const search = new URL(request.url).searchParams;
      const overdue = search.get("overdue");
      if (overdue !== null && overdue !== "true" && overdue !== "false") throw new ApiError("VALIDATION_ERROR", "O filtro de atraso é inválido.", 400);
      const data = await service.listQueuePage(actor, path[1], {
        status: parseItemState(search.get("status")),
        overdue: overdue === null ? undefined : overdue === "true",
        cursor: parseCursor(search.get("cursor")),
        limit: parseLimit(search.get("limit"))
      });
      return responseFor(data.items, correlationId, id, 200, { nextCursor: data.nextCursor, limit: data.limit, total: data.total });
    }
    if (path[0] === "search" && method === "GET") {
      const search = new URL(request.url).searchParams;
      const query = search.get("q") ?? "";
      if (codePointLength(query) > 200) throw new ApiError("VALIDATION_ERROR", "O termo de busca é muito longo.", 400);
      const data = await service.search(actor, query, {
        types: parseSearchTypes(search.get("types")),
        status: parseItemState(search.get("status")),
        departmentCode: search.get("department") ?? search.get("departmentCode") ?? undefined,
        from: parseDateTimeFilter(search.get("from"), "from"),
        to: parseDateTimeFilter(search.get("to"), "to"),
        cursor: parseCursor(search.get("cursor")),
        limit: parseLimit(search.get("limit"))
      });
      return responseFor(data.items, correlationId, id, 200, { nextCursor: data.nextCursor, limit: data.limit, total: data.total });
    }
    if (path[0] === "timeline" && method === "GET") {
      const search = new URL(request.url).searchParams;
      const data = await service.timeline(actor, search.get("requestId") ?? undefined, search.get("itemId") ?? undefined, { cursor: parseCursor(search.get("cursor")), limit: parseLimit(search.get("limit")) });
      return responseFor(data.items, correlationId, id, 200, { nextCursor: data.nextCursor, limit: data.limit, total: data.total });
    }
    if (path[0] === "dashboard" && method === "GET") return responseFor(await service.dashboard(actor), correlationId, id);
    if (path[0] === "management" && path[1] === "overview" && method === "GET") return responseFor(await service.managementOverview(actor), correlationId, id);
    if (path[0] === "realtime" && path[1] === "events" && method === "GET") {
      if (!canAccessResource(actor, "realtime.connect", {})) throw new ApiError("SCOPE_DENIED", "Você não tem acesso ao canal em tempo real.", 404);
      const snapshot = parseBooleanFilter(new URL(request.url).searchParams.get("snapshot"), "snapshot") ?? false;
      return await createRealtimeResponse(store, actor, correlationId, request.headers.get("last-event-id") ?? undefined, snapshot, request, {
        isAuthorized: authorizationSnapshotIsCurrent,
        eventVisible,
        authorizationError: () => new ApiError("SESSION_EXPIRED", "Sessão expirada. Entre novamente.", 401)
      });
    }

    throw new ApiError("NOT_FOUND", "Rota não encontrada.", 404);
  } catch (error) {
    return errorFor(error, correlationId, id);
  }
}

async function flushConfiguredLocalOutbox(store: Awaited<ReturnType<typeof getRuntimeStoreAsync>>): Promise<void> {
  if (process.env.OUTBOX_INLINE_LOCAL !== "true" || process.env.NODE_ENV === "production") return;
  await processOutboxBatch(store, createSafeConsoleSink(() => undefined), { workerId: `inline_${process.pid}`, batchSize: 100, allowSyntheticDelivery: true });
}

function publicUser(user: { id: string; email: string; displayName: string; role: string; departmentCode: string; timezone: string; managedDepartmentCodes?: ReadonlyArray<string> }) {
  return { id: user.id, email: user.email, displayName: user.displayName, role: user.role, departmentCode: user.departmentCode, managedDepartmentCodes: user.managedDepartmentCodes ? [...user.managedDepartmentCodes] : undefined, timezone: user.timezone };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseLimit(value: string | null, fallback = 25): number {
  const parsed = z.coerce.number().int().min(1).max(100).safeParse(value === null ? fallback : value);
  if (!parsed.success) throw new ApiError("VALIDATION_ERROR", "O limite deve ser um inteiro entre 1 e 100.", 400);
  return parsed.data;
}

function parseItemState(value: string | null) {
  if (value === null) return undefined;
  const parsed = z.enum(ITEM_STATES).safeParse(value);
  if (!parsed.success) throw new ApiError("VALIDATION_ERROR", "O status informado é inválido.", 400);
  return parsed.data;
}

function parsePriority(value: string | null) {
  if (value === null) return undefined;
  const parsed = z.enum(PRIORITIES).safeParse(value);
  if (!parsed.success) throw new ApiError("VALIDATION_ERROR", "A prioridade informada é inválida.", 400);
  return parsed.data;
}

function parseBooleanFilter(value: string | null, field: string): boolean | undefined {
  if (value === null) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ApiError("VALIDATION_ERROR", `O filtro ${field} é inválido.`, 400);
}

function parseServiceIdentifier(value: string | null): string | undefined {
  if (value === null) return undefined;
  const parsed = serviceIdentifierSchema.safeParse(value);
  if (!parsed.success) throw new ApiError("VALIDATION_ERROR", "O serviço informado é inválido.", 400);
  return parsed.data;
}

function parseDateTimeFilter(value: string | null, field: string): string | undefined {
  if (value === null) return undefined;
  const parsed = queryDateTimeSchema.safeParse(value);
  if (!parsed.success) throw new ApiError("VALIDATION_ERROR", `O filtro ${field} é inválido.`, 400);
  return parsed.data;
}

function parseSearchTypes(value: string | null): SearchResultType[] | undefined {
  if (value === null) return undefined;
  if (!/^(REQUEST|ITEM)(\s*,\s*(REQUEST|ITEM))*$/.test(value)) {
    throw new ApiError("VALIDATION_ERROR", "O tipo de busca é inválido.", 400);
  }
  const types = value.split(",").map((entry) => entry.trim());
  return [...new Set(types)] as SearchResultType[];
}

function parseCursor(value: string | null): string | undefined {
  if (value === null) return undefined;
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 200) throw new ApiError("VALIDATION_ERROR", "O cursor informado é inválido.", 400);
  return value;
}


export async function GET(request: Request, context: RouteContext): Promise<Response> {
  return dispatch("GET", request, context);
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  return dispatch("POST", request, context);
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  return dispatch("PATCH", request, context);
}

export async function PUT(request: Request, context: RouteContext): Promise<Response> {
  return dispatch("PUT", request, context);
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  return dispatch("DELETE", request, context);
}
