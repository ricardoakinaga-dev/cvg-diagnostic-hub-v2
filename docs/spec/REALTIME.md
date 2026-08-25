# Realtime specification

**Knowledge status:** `IMPLEMENTED LOCALLY / CONDITIONAL` — SSE autorizado, heartbeat, replay limitado, `Last-Event-ID`, `resync_required`, expiração e polling de fallback existem; multi-instância, carga e meta de propagação ainda são `OPEN QUESTION`.

## 1. Choice

`DECISION`: use Server-Sent Events (SSE) for server-to-client updates. The product primarily broadcasts committed changes; clients do not need bidirectional socket messaging for MVP. WebSocket is deferred until a measured requirement proves SSE insufficient.

## 2. Endpoint and events

`GET /api/v1/realtime/events` with authenticated session and optional scoped filters.

Event types:

- `diagnostic.request.updated`
- `diagnostic.item.updated`
- `notification.created`
- `notification.updated`
- `critical-result.action-required`
- `queue.updated`
- `system.degraded`

Payload contains `eventId`, `type`, `occurredAt`, `entityType`, opaque `entityId`, `version`, scope hint and correlation ID. It does not contain full result content or attachment URLs. Client fetches the resource through normal authorization.

## 3. Delivery semantics

- best effort for UI freshness; durable truth is PostgreSQL + notification/outbox;
- every event has monotonic/unique `eventId` suitable for `Last-Event-ID`;
- reconnect sends `Last-Event-ID`; server replays a bounded event window or emits `resync_required`;
- duplicate events are harmless because UI compares entity/version and refetches;
- release/review commands never depend on receiving SSE.

## 4. Current and multi-instance path

O endpoint atual lê uma janela limitada do outbox por polling e refaz a checagem de autorização antes de cada envio. Isso é suficiente como sinal de invalidação em um processo e não expõe conteúdo clínico. Não há `LISTEN/NOTIFY` nem fanout multi-instância demonstrado. Antes de escalar horizontalmente, usar um poller/fanout durável baseado no outbox ou PostgreSQL `LISTEN/NOTIFY`, e testar entrega autorizada em todas as instâncias. Redis não é default.

## 5. Degraded behavior

If SSE disconnects:

1. UI displays `Atualização ao vivo interrompida` and last refresh time.
2. It reconnects with backoff/jitter.
3. It falls back to bounded polling for queues/inbox.
4. After action, it always refetches the command response.
5. It never shows a local optimistic clinical state as final.

## 6. Security and performance

- authenticate connection and enforce scope on subscription/filter;
- close connections on session expiry/role change;
- cap concurrent connections and heartbeat/timeout idle streams; the local stream remains open by default and supports an optional `REALTIME_STREAM_MAX_MS` operational cap;
- expose active connection count as a bounded operational metric without event payloads or clinical identifiers;
- rate-limit reconnect storms;
- measure propagation p50/p95 from commit to authorized UI event in a representative pilot; proposed initial p95 target ≤ 2 s, to validate before release;
- do not log result content in stream diagnostics.
