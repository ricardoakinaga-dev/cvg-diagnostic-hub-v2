# Evidence packet — HTTP multi-instance PostgreSQL realtime

**Run date:** 2026-09-06  
**Scope:** local disposable PostgreSQL 16.15, two independent Next.js HTTP
processes, synthetic users/data only  
**Verdict:** `CONDITIONAL` — executable local evidence, not production or
hospital acceptance

## Exact execution

The run used fresh loopback-only PostgreSQL clusters on ports `55466` and
`55467`, initialized with trust-only synthetic roles and stopped by the test
wrapper. The `55466` run focused on the HTTP file; the `55467` run exercised
the complete PostgreSQL integration configuration.
The pre-existing PostgreSQL listener on `127.0.0.1:5432` was not used or
modified.

```sh
ALLOW_POSTGRES_INTEGRATION_TESTS=true \
POSTGRES_TEST_ADMIN_URL=postgresql://postgres@127.0.0.1:55467/postgres \
npm run test:postgres -- --run --reporter=dot
```

Result: **5 test files, 24/24 tests, 35.62 s**. The dedicated HTTP file also
ran alone with the verbose reporter on port `55466`: **2/2, 26.68 s**.

## What is proven

`tests/postgres/http-multi-instance.integration.test.ts` starts two separate
Next processes with distinct ports, isolated `NEXT_DIST_DIR` values and
PostgreSQL `application_name` values. The first scenario uses `next dev`; the
second builds and starts two independent `next start` processes. Both modes
point to the same disposable database and use
`REALTIME_NOTIFICATION_ADAPTER=postgres-listen`.

The scenario verifies, in order:

1. `readyz` is healthy on both processes with `dataMode=postgres`.
2. Login on instance A sets the session/CSRF cookies and `/session/me` on B
   authenticates the same user.
3. B opens the authorized SSE stream; the harness observes B's `LISTEN`
   session through `pg_stat_activity`.
4. A separate publisher sends a notification with the payload `probe`; B
   emits a heartbeat without receiving clinical data.
5. A creates a diagnostic request with CSRF and idempotency headers. The
   committed outbox event is published by A and received by B's SSE stream
   within the test's five-second wake-up bound while the polling interval is
   set to 60 seconds.
6. The event contains only bounded aggregate metadata, not `patient-thor` or
   `Hemograma`, and B then reads the created request through its own HTTP
   process.

The production-start scenario additionally proves:

1. Each process boots from its own production build while `readyz` validates
   PostgreSQL, a local S3-compatible health endpoint and an external-scanner
   configuration shape. The S3 endpoint is a test HTTP responder; no object is
   persisted and no scanner request is made.
2. B receives the first committed event, the client disconnects, A creates a
   second request through the explicit duplicate-warning override policy, and
   B reconnects with `Last-Event-ID`.
3. The reconnect replay contains the second durable event, excludes the first
   event, and B reads the second request through its own `next start` process.
4. A third B stream closes promptly after A logs out and revokes the shared
   session, exercising cross-process authorization re-evaluation rather than
   waiting for the 60-second durable polling interval.

The reusable process harness is
`tests/support/next-http-test-server.ts`. It terminates the exact child
process group and removes only its generated Next/storage directories after
the test. The final socket check showed only `127.0.0.1:5432` listening.

## Limits and next gate

This closes the local process-level HTTP/session/fanout and local `next start`
reconnect/replay gaps for this synthetic slice, but it does not prove target
TLS/proxy or IdP integration, representative load/p95, restart/failover,
outbox delivery to a real sink, real object storage/AV, RPO/RTO, clinical
policies, manual acceptance or pilot readiness. It must not be used to mark
AAA-04/AAA-05/AAA-08/AAA-09/AAA-10/AAA-11/AAA-12 or the release checklist
complete.

## Reproduction files

- `tests/postgres/http-multi-instance.integration.test.ts`
- `tests/support/next-http-test-server.ts`
- `tests/support/postgres-test-harness.ts`
- `src/server/observability/realtime.ts`
- `src/server/observability/realtime-stream.ts`
- `src/app/api/v1/[...path]/route.ts`
