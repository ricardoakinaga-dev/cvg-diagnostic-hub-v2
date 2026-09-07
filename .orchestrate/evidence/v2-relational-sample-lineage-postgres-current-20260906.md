# Current disposable PostgreSQL verification — 2026-09-06

## Result

`ALLOW_POSTGRES_INTEGRATION_TESTS=true POSTGRES_TEST_ADMIN_URL=postgresql://postgres@127.0.0.1:55449/postgres npm run test:postgres` passed **33/33 tests in 5 files** on a fresh PostgreSQL 16 disposable cluster.

The run covered the HTTP multi-instance/session/fanout/replay slice (2),
relational sample/accession lineage and migration-009/backfill-010 behavior
(12), PostgreSQLStore multi-instance/atomicity/outbox/rate-limit behavior (12),
real LISTEN/NOTIFY wake-up (1), and harness guardrails (6).

The cluster was initialized with `initdb --auth=trust --no-locale
--encoding=UTF8` on loopback port `55449`, started only for this command, and
removed after completion. The persistent PostgreSQL instance on
`127.0.0.1:5432` was not used or modified; the post-run listener check showed
only that persistent port.

## Scope boundary

This is a local synthetic disposable proof. It closes the previous local
execution gap for the new receive/recollection/rollback and readiness-repair
integration, but it does not establish relational authority/cutover, target
environment behavior, production sizing/failover, real storage/AV, clinical
policy, or human release acceptance.
