# Realtime specification

**Knowledge status:** `IMPLEMENTED LOCALLY / CONDITIONAL` — SSE autorizado, heartbeat, replay limitado, `Last-Event-ID`, `resync_required`, expiração/revogação, polling de fallback e o adapter PostgreSQL `LISTEN/NOTIFY` existem; o packet HTTP local agora cobre duas instâncias, fanout, replay e revogação cross-process, enquanto carga, produção e meta de propagação ainda são `OPEN QUESTION`.

## 1. Choice

`DECISION`: use Server-Sent Events (SSE) for server-to-client updates. The product primarily broadcasts committed changes; clients do not need bidirectional socket messaging for MVP. WebSocket is deferred until a measured requirement proves SSE insufficient.

## 2. Endpoint and events

`GET /api/v1/realtime/events` with authenticated session and optional scoped filters.

Event types:

- The current wire event name is `diagnostic.updated`; the domain event
  discriminator remains in the `data.type` field. Consumers must subscribe to
  the wire name and refetch the authorized resource rather than treating the
  event as clinical content.

Payload contains `eventId`, `type`, `occurredAt`, `entityType`, opaque `entityId` and correlation ID. It deliberately does not carry a resource version or scope hint: the client refetches the authorized resource and compares the returned entity/version under the normal authorization boundary. It does not contain full result content or attachment URLs.

## 3. Delivery semantics

- best effort for UI freshness; durable truth is PostgreSQL + notification/outbox;
- every event has a unique durable `eventId` and an outbox order suitable for
  `Last-Event-ID`; the identifier itself is opaque and is not interpreted as a
  numeric sequence;
- reconnect sends `Last-Event-ID`; server replays a bounded event window or emits `resync_required`;
- duplicate events are harmless because UI compares entity/version and refetches;
- release/review commands never depend on receiving SSE.

## 4. Current and multi-instance path

O endpoint lê uma janela limitada do outbox por polling e refaz a checagem de autorização antes de cada envio. O default sintético é `process-local`; em ambiente PostgreSQL, `REALTIME_NOTIFICATION_ADAPTER=postgres-listen` usa um cliente dedicado para `LISTEN` e publica apenas um wake-up sem payload clínico via `pg_notify`. Em produção, a configuração ausente assume `postgres-listen` e a prontidão rejeita `process-local`, URL inválida ou canal inválido; isso evita anunciar fan-out entre instâncias com um adapter somente local. A borda HTTP publica o wake-up após uma mutação 2xx; escritas externas ao dispatcher continuam cobertas pelo polling durável. Falha de conexão ou publicação não invalida a transação: o polling durável continua sendo a fonte de verdade e o adapter tenta reconectar com atraso limitado. Um `snapshot=true` não depende do adapter, para que a reconciliação durável continue disponível quando o wake-up estiver degradado. O packet local [`aaa3-http-multi-instance-20260906.md`](../../.orchestrate/evidence/aaa3-http-multi-instance-20260906.md) prova duas instâncias HTTP em `next dev` e `next start`, sessão cross-process, entrega autorizada do evento via SSE, replay após `Last-Event-ID` e encerramento da stream após revogação de sessão em cluster descartável; a auditoria específica SAA-015 está em [`saa-015-realtime-20260907.md`](../../.orchestrate/evidence/saa-015-realtime-20260907.md). Isso não é homologação de produção nem meta p95. Redis não é default.

## 5. Degraded behavior

If SSE disconnects:

1. UI displays `Atualização ao vivo interrompida` and last refresh time.
2. The browser keeps the same `EventSource` reconnect algorithm active; the
   server-provided bounded `retry` preserves the browser's `Last-Event-ID`.
   Manual reconciliation may replace the source only after dispatching a
   durable resync.
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
