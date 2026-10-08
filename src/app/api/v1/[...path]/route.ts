import { createApplicationService } from "../../../../server/application/service";
import { ApiError } from "../../../../server/http/envelope";
import { matchApiOperation } from "../../../../server/http/api-operation-manifest";
import { recordHttpRequest, routeMetricLabel } from "../../../../server/observability/metrics";
import { notifyRealtimeMutation } from "../../../../server/observability/realtime";
import { createStructuredLogger, logHttpRequest } from "../../../../server/observability/structured-logger";
import { assertRateLimit } from "../../../../server/security/rate-limit";
import { authenticateRequest } from "../../../../server/security/session";
import { metricsScrapeAuthorized } from "../../../../server/security/metrics-token";
import { getRuntimeFileStore, getRuntimeStoreAsync } from "../../../../server/store/runtime";
import { API_HANDLER_REGISTRY } from "./operation-handlers";
import { metricsResponse } from "./operations-handlers";
import {
  assertProductionClientIdentity, clientIdentityFor, clientRateLimitKey, correlationFrom,
  errorFor, flushConfiguredLocalOutbox, normalizeRouteError, pathFor, positiveInteger,
  requestId, signalUnidentifiedClient, validateRequestHeaders, type RouteContext
} from "./route-support";

async function dispatch(method: string, request: Request, context: RouteContext): Promise<Response> {
  const startedAt = performance.now();
  let metricPath: string[];
  try { metricPath = await pathFor(context); }
  catch { metricPath = ["invalid"]; }
  const response = await dispatchInner(method, request, context);
  if (method !== "GET" && response.status >= 200 && response.status < 300) notifyRealtimeMutation();
  const route = routeMetricLabel(metricPath);
  const durationMs = performance.now() - startedAt;
  recordHttpRequest(method, route, response.status, durationMs);
  logHttpRequest({ method, route, status: response.status, durationMs, correlationId: response.headers.get("x-correlation-id") ?? undefined });
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
    const clientIdentity = clientIdentityFor(request);
    signalUnidentifiedClient(clientIdentity);
    assertProductionClientIdentity(clientIdentity);
    const rateLimitClientKey = clientRateLimitKey(clientIdentity);
    const handler = API_HANDLER_REGISTRY.resolve(operation.operationId);
    const handlerContext = { request, path, operation, correlationId, id, clientIdentity, rateLimitClientKey };
    if (handler.authentication === "public") return await handler.handle(handlerContext);

    const store = await getRuntimeStoreAsync();
    // The manifest declares which operation accepts the Prometheus token (GET /metrics only).
    // It reads aggregate counters; any other credential falls through to the session.
    if (operation.serviceTokenScheme === "metricsBearer" && metricsScrapeAuthorized(request)) {
      await assertRateLimit(`metrics-scrape:${rateLimitClientKey}`, positiveInteger(process.env.METRICS_SCRAPE_RATE_LIMIT, 60), 60_000);
      return await metricsResponse(store, correlationId);
    }
    let actor: Awaited<ReturnType<typeof authenticateRequest>>;
    try {
      actor = await authenticateRequest(store, request, {
        requireCsrf: operation.csrf,
        allowPasswordChange: ["getCurrentSession", "logout", "changeInitialPassword"].includes(operation.operationId)
      });
    } catch (error) {
      if (error instanceof ApiError && (error.code === "UNAUTHENTICATED" || error.code === "SESSION_EXPIRED")) {
        await assertRateLimit(`preauth:${rateLimitClientKey}`, positiveInteger(process.env.UNAUTHENTICATED_RATE_LIMIT, 120), 60_000);
      }
      throw error;
    }
    await flushConfiguredLocalOutbox(store);
    const service = createApplicationService(store, { storage: getRuntimeFileStore() });
    const actorRateLimitKey = actor.sessionId ?? actor.id;
    await assertRateLimit(`session:${actorRateLimitKey}:${operation.operationId}`, positiveInteger(process.env.AUTHENTICATED_RATE_LIMIT, 240), 60_000);
    return await handler.handle({ ...handlerContext, store, actor, service });
  } catch (error) {
    const normalizedError = normalizeRouteError(error);
    const response = errorFor(normalizedError, correlationId, id);
    if (response.status >= 500) {
      createStructuredLogger().error("http.failure", {
        component: "http", requestId: id, correlationId,
        errorCode: normalizedError instanceof ApiError ? normalizedError.code : "INTERNAL", status: response.status
      });
    }
    return response;
  }
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
