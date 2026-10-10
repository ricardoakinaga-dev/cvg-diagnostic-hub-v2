import { requireActiveUser, requirePermission } from "../../../../server/application/service-common";
import { deadLetterCommandSchema } from "../../../../server/http/admin-schemas";
import { authorizationSnapshotIsCurrent } from "../../../../server/security/session";
import { ApiError } from "../../../../server/http/envelope";
import { canAccessResource } from "../../../../server/security/authorization";
import { eventVisible } from "../../../../server/application/realtime-visibility";
import { discardDeadLetterMessage, listDeadLetterMessages, reprocessDeadLetterMessage } from "../../../../server/operations/outbox";
import { operationalAuditQuery, recordCriticalReadiness, refreshOperationalMetrics, renderPrometheus } from "../../../../server/observability/metrics";
import { criticalReadinessChecks, criticalResultReadiness } from "../../../../server/application/critical-readiness";
import { createRealtimeResponse } from "../../../../server/observability/realtime-stream";
import { acknowledgeNotificationSchema } from "../../../../server/http/command-schemas";
import { codePointLength, responseFor, objectBody, parseCommandBody, commandMeta, parseLimit, parseItemState, parseBooleanFilter, parseDateTimeFilter, parseSearchTypes, parseCursor } from "./route-support";
import type { ApiHandlerGroup } from "./route-support";
import type { StateStore } from "../../../../server/domain/models";
/** Shared by the ADMIN session and the Prometheus scrape token (route.ts). */
export async function metricsResponse(store: StateStore, correlationId: string): Promise<Response> {
  const state = await store.readState();
  const [history, outbox] = await Promise.all([
    store.readAuditMetrics(operationalAuditQuery(state)),
    store.readOutboxMetrics()
  ]);
  refreshOperationalMetrics(state, new Date(), history, outbox);
  recordCriticalReadiness(criticalReadinessChecks(criticalResultReadiness(state)));
  const body = renderPrometheus();
  return new Response(body, { status: 200, headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store", "x-correlation-id": correlationId } });
}

export const operationsHandlers = {
  getMetrics: { authentication: "session", handle: async ({ correlationId, store, actor }) => {
      if (!canAccessResource(actor, "health.readiness", {}))
        throw new ApiError("NOT_FOUND", "Rota não encontrada.", 404);
      return metricsResponse(store, correlationId);
    } },
  listAuditEvents: { authentication: "session", handle: async ({ request, correlationId, id, service, actor }) => {
      const search = new URL(request.url).searchParams;
      const data = await service.listAuditEvents(actor, { limit: parseLimit(search.get("limit")), cursor: parseCursor(search.get("cursor")) });
      return responseFor(data.items, correlationId, id, 200, { nextCursor: data.nextCursor, limit: data.limit, total: data.total });
    } },
  listNotifications: { authentication: "session", handle: async ({ request, correlationId, id, service, actor }) => {
      const search = new URL(request.url).searchParams;
      const data = await service.listNotifications(actor, (search.get("filter") as "ALL" | "UNREAD" | "ACTIONABLE" | "CRITICAL") ?? "ALL", {
        cursor: parseCursor(search.get("cursor")),
        limit: parseLimit(search.get("limit"))
      });
      return responseFor(data.items, correlationId, id, 200, { nextCursor: data.nextCursor, limit: data.limit, total: data.total });
    } },
  acknowledgeNotification: { authentication: "session", handle: async ({ request, path, operation, correlationId, id, service, actor }) => {
      const body = await objectBody(request);
      const parsed = parseCommandBody(body, acknowledgeNotificationSchema, "Os dados de confirmação são inválidos.");
      return responseFor(await service.acknowledgeNotification(actor, path[1], { ...parsed, ...commandMeta(request, body, operation) }), correlationId, id);
    } },
  listQueueItems: { authentication: "session", handle: async ({ request, path, correlationId, id, service, actor }) => {
      const search = new URL(request.url).searchParams;
      const overdue = search.get("overdue");
      if (overdue !== null && overdue !== "true" && overdue !== "false")
        throw new ApiError("VALIDATION_ERROR", "O filtro de atraso é inválido.", 400);
      const data = await service.listQueuePage(actor, path[1], {
        status: parseItemState(search.get("status")),
        overdue: overdue === null ? undefined : overdue === "true",
        cursor: parseCursor(search.get("cursor")),
        limit: parseLimit(search.get("limit"))
      });
      return responseFor(data.items, correlationId, id, 200, { nextCursor: data.nextCursor, limit: data.limit, total: data.total });
    } },
  searchDiagnostics: { authentication: "session", handle: async ({ request, correlationId, id, service, actor }) => {
      const search = new URL(request.url).searchParams;
      const query = search.get("q") ?? "";
      if (codePointLength(query) > 200)
        throw new ApiError("VALIDATION_ERROR", "O termo de busca é muito longo.", 400);
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
    } },
  getTimeline: { authentication: "session", handle: async ({ request, correlationId, id, service, actor }) => {
      const search = new URL(request.url).searchParams;
      const data = await service.timeline(actor, search.get("requestId") ?? undefined, search.get("itemId") ?? undefined, { cursor: parseCursor(search.get("cursor")), limit: parseLimit(search.get("limit")) });
      return responseFor(data.items, correlationId, id, 200, { nextCursor: data.nextCursor, limit: data.limit, total: data.total });
    } },
  getDashboard: { authentication: "session", handle: async ({ correlationId, id, service, actor }) => {
      return responseFor(await service.dashboard(actor), correlationId, id);
    } },
  getManagementOverview: { authentication: "session", handle: async ({ correlationId, id, service, actor }) => {
      return responseFor(await service.managementOverview(actor), correlationId, id);
    } },
  getCriticalReadiness: { authentication: "session", handle: async ({ correlationId, id, store, actor }) => {
      if (!canAccessResource(actor, "critical_result_policy.manage", {}))
        throw new ApiError("NOT_FOUND", "Rota não encontrada.", 404);
      return responseFor(criticalResultReadiness(await store.readState()), correlationId, id);
    } },
  listDeadLetters: { authentication: "session", handle: async ({ request, correlationId, id, store, actor }) => {
      if (!canAccessResource(actor, "outbox.manage", {}))
        throw new ApiError("NOT_FOUND", "Rota não encontrada.", 404);
      return responseFor(await listDeadLetterMessages(store, parseLimit(new URL(request.url).searchParams.get("limit"))), correlationId, id);
    } },
  streamRealtimeEvents: { authentication: "session", handle: async ({ request, correlationId, store, actor }) => {
      if (!canAccessResource(actor, "realtime.connect", {}))
        throw new ApiError("SCOPE_DENIED", "Você não tem acesso ao canal em tempo real.", 404);
      const snapshot = parseBooleanFilter(new URL(request.url).searchParams.get("snapshot"), "snapshot") ?? false;
      return await createRealtimeResponse(store, actor, correlationId, request.headers.get("last-event-id") ?? undefined, snapshot, request, {
        isAuthorized: authorizationSnapshotIsCurrent,
        eventVisible,
        authorizationError: () => new ApiError("SESSION_EXPIRED", "Sessão expirada. Entre novamente.", 401)
      });
    } },
  reprocessDeadLetter: { authentication: "session", handle: async ({ request, path, operation, correlationId, id, store, actor }) => {
      if (!canAccessResource(actor, "outbox.manage", {}))
        throw new ApiError("NOT_FOUND", "Rota não encontrada.", 404);
      const body = await objectBody(request);
      const parsed = parseCommandBody(body, deadLetterCommandSchema, "Os dados da dead-letter são inválidos.");
      const meta = commandMeta(request, body, operation);
      const command = { actorId: actor.id, correlationId, idempotencyKey: meta.idempotencyKey!, reason: parsed.reason ?? "Reprocessamento solicitado na aba Sistema", authorize: (state: Parameters<typeof requireActiveUser>[0]) => { const current = requireActiveUser(state, actor); requirePermission(current, "outbox.manage", {}); } };
      const result = await reprocessDeadLetterMessage(store, path[2], command);
      return responseFor(result, correlationId, id);
    } },
  discardDeadLetter: { authentication: "session", handle: async ({ request, path, operation, correlationId, id, store, actor }) => {
      if (!canAccessResource(actor, "outbox.manage", {}))
        throw new ApiError("NOT_FOUND", "Rota não encontrada.", 404);
      const body = await objectBody(request);
      const parsed = parseCommandBody(body, deadLetterCommandSchema, "Os dados da dead-letter são inválidos.");
      const meta = commandMeta(request, body, operation);
      const command = { actorId: actor.id, correlationId, idempotencyKey: meta.idempotencyKey!, reason: parsed.reason ?? "Descarte solicitado na aba Sistema", authorize: (state: Parameters<typeof requireActiveUser>[0]) => { const current = requireActiveUser(state, actor); requirePermission(current, "outbox.manage", {}); } };
      const result = await discardDeadLetterMessage(store, path[2], command);
      return responseFor(result, correlationId, id);
    } }
} satisfies ApiHandlerGroup;
