# V2 relational sample-lineage backfill — local disposable evidence

Status: `PASS_WITH_CONDITIONS` for the bounded local shadow slice; not a
production, clinical or relational-authority approval.

Observed: 2026-09-06, Node 22, Next.js 16.3.0, PostgreSQL 16.15, disposable
loopback cluster on `127.0.0.1:55468` as the dedicated local role `ricardo`.
The pre-existing PostgreSQL process on `127.0.0.1:5432` was not touched.

## Scope

This packet covers migration `010_relational_backfill_control`, the durable
`relational_backfill_runs` ledger and the request-scoped
`CLINICAL_CORE_REQUESTS` backfill to `RELATIONAL_SHADOW`. It projects only the
ten losslessly mappable clinical-core tables, keeps `cvg_runtime_state`/JSONB
authoritative and performs per-request relational read/reconciliation in the
same disposable database. It is not the complete 007–010 migration and does
not enable dual-write cutover.

## Executed PostgreSQL evidence

Focused command:

```text
ALLOW_POSTGRES_INTEGRATION_TESTS=true
POSTGRES_TEST_ADMIN_URL=postgresql://ricardo@127.0.0.1:55468/postgres
LD_LIBRARY_PATH=<disposable-postgresql-libraries>
npm run test:postgres -- --run tests/postgres/relational-sample-lineage.integration.test.ts --reporter=verbose
```

Result: 1 file, **9/9 tests**, 6.39s. The cases cover live 009 readiness and
constraints, projection/read/reconciliation, populated backfill with a durable
checkpoint and idempotent replay, failed-run cursor resume, source locking
through checkpoint, same-run serialization across independent pools, exact
target-key completeness, indexed access-path inspection and
invalid-link/accession rejection.

Full disposable PostgreSQL command:

```text
ALLOW_POSTGRES_INTEGRATION_TESTS=true
POSTGRES_TEST_ADMIN_URL=postgresql://ricardo@127.0.0.1:55468/postgres
LD_LIBRARY_PATH=<disposable-postgresql-libraries>
npm run test:postgres -- --reporter=verbose
```

Result: **5 files, 29/29 tests**, 38.07s. The suite includes the two-process
HTTP/realtime checks, PostgresStore multi-instance transactions, all six
relational sample-lineage/backfill cases, two-pool LISTEN/NOTIFY and harness
guardrails.

## Consolidated local revalidation

- `npm run validate`: **564/564 tests in 67 files**; 93.06% statements/lines,
  85.14% branches and 95.51% functions; typecheck, lint, docs 56/56, OpenAPI
  65 operations across 60 paths, traceability 43/43 and migrations 001–010
  with exact checksums passed.
- `npm run build`: production build passed and generated 12 static pages.
- `CI=1 npm run test:e2e -- --retries=0 --fail-on-flaky-tests`: **51/51**
  (3.2m).
- `npm run test:accessibility -- --retries=0 --fail-on-flaky-tests`: **6/6**
  (21.0s).
- Secret scan passed; `npm audit --audit-level=high` reported 0
  vulnerabilities; performance passed **7/7** and recovery passed **5/5**.
- The canonical engineering-framework checker passed **11/11** checks and
  `git diff --check` passed.

## Backfill assertions

- A populated two-request snapshot is projected by complete request aggregate;
  the first populated run reports one request and four rows for the one-request
  fixture (`diagnostic_requests`, item, sample and link), with one successful
  reconciliation.
- Reusing the same completed `runId` is idempotent and returns the durable
  completed cursor without duplicating rows, after exact-key and aggregate
  revalidation in a repeatable-read transaction.
- Corrupting a projected request after completion makes the same `runId` fail
  closed with `POSTGRES_RELATIONAL_RECONCILIATION_DIVERGED`; the completed
  ledger row remains completed and the JSONB source is unchanged.
- Mutating the JSONB snapshot/version out of band makes the same run fail
  closed with `POSTGRES_RELATIONAL_BACKFILL_SOURCE_CHANGED`; the completed
  ledger row remains completed and relational authority is not promoted.
- A manually failed run with a committed first-request cursor resumes from
  that cursor, projects the remaining request and ends with two requests,
  eight projected rows and two reconciliations in the synthetic fixture.
- Every batch holds the source request row lock through relational rows,
  absolute counters and checkpoint commit. The run-level advisory lock
  serializes reuse of one `runId` across independent pools.
- Completeness checks compare exact expected and actual keys, and reject
  shortfall, extra rows and orphaned foreign-key references across the fixed
  ten-table scope.

## Independent criticism

The fresh read-only critic initially reported one HIGH race and MEDIUM/LOW
findings around source locking, exact key completeness, sanitized CLI errors,
transform provenance, duplicate-run wording and advisory-lock coverage. All
local findings were fixed and retested; the disposition is recorded in
[`v2-relational-sample-lineage-backfill-critic-20260906.md`](v2-relational-sample-lineage-backfill-critic-20260906.md).
The critic did not approve production, clinical or authority cutover.

## Limits

The result is local synthetic/disposable evidence. Catalog and identity
prerequisites are explicit inputs; no parent, owner, role, policy,
`result_components`, delivery, acknowledgement or idempotency rows are
fabricated. The JSONB snapshot remains runtime authority. Full relational
mapping, continuous target-environment dual-read, approved representative
`EXPLAIN`/load, browser persistence through the relational seam, cutover and
rollback, production storage/AV/secrets, restart/failover, remote CI, signed
clinical policies, manual acceptance and hospital release authority remain
open.

Raw command notes are preserved in
[`v2-relational-sample-lineage-backfill-run-20260906.txt`](v2-relational-sample-lineage-backfill-run-20260906.txt).
