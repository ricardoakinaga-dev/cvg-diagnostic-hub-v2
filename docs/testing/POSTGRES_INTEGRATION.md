# PostgreSQL integration loop

This loop is disposable and synthetic. It never accepts a production URL and never resets a non-loopback target. The harness requires an explicit opt-in so a normal local test cannot mutate a developer or hospital database.

## Local Docker loop

From the repository root:

```sh
docker compose up -d postgres minio
ALLOW_POSTGRES_INTEGRATION_TESTS=true \
POSTGRES_TEST_ADMIN_URL=postgresql://cvg:cvg_dev@127.0.0.1:54329/postgres \
npm run test:postgres
docker compose down
```

The compose file fixes PostgreSQL 16 and exposes it only on the loopback development port `54329`; MinIO is the local object-storage companion. The command must be run only against the disposable services. A missing Docker daemon or database is `BLOCKED`, never a passing integration result.

## Local portable loop without Docker

For a host without Docker, a user-owned PostgreSQL 16 cluster can be initialized on a loopback port and passed to the same harness:

```sh
ALLOW_POSTGRES_INTEGRATION_TESTS=true \
POSTGRES_TEST_ADMIN_URL=postgresql://<local-user>@127.0.0.1:<port>/postgres \
npm run test:postgres
```

The cluster must be disposable, loopback-only and removed after the run. The [current AAA-3 revalidation packet](../../.orchestrate/aaa3-execution-20260907/node22-current-revalidation-20260907.md) records PostgreSQL 16 on a fresh disposable cluster and **39/39 passing tests in 6 files**, including the populated `001→010` SAA-022 upgrade proof, the resumed `009 already committed` repair case, migration-009 constraints and BACKFILL-only legacy repair, relational projection/read/reconciliation, populated migration-010 backfill, durable checkpoint/reconciliation, completed-run revalidation, source locking, two-pool serialization, exact-key divergence rejection, indexed `EXPLAIN`, HTTP multi-instance session/fanout/replay, and real LISTEN/NOTIFY wake-up. The [upgrade packet](../../.orchestrate/aaa3-execution-20260907/migration-upgrade-node22-local-20260907.md) records its five dedicated scenarios. The earlier V2 packets remain historical evidence for their own counts (22/22, 30/30, 29/29). This path does not provide MinIO, approved production sizing, representative approved workload or a release decision.

## Populated relational backfill

After applying migrations through `010_relational_backfill_control`, a
synthetic database with a populated `cvg_runtime_state` can run the bounded
shadow backfill:

```sh
ALLOW_RELATIONAL_BACKFILL=true \
RELATIONAL_BACKFILL_TARGET=RELATIONAL_SHADOW \
DATABASE_URL=postgresql://<local-user>@127.0.0.1:<port>/<cvg_test_database> \
npm run db:relational-backfill
```

The command is prohibited with `NODE_ENV=production`. It requires catalog and
identity prerequisites to have been created separately, processes the ten
losslessly mappable clinical-core tables by complete request aggregate, and
prints only counts and the opaque run identifier. Reusing
`RELATIONAL_BACKFILL_RUN_ID` resumes a failed run from its committed cursor;
replaying a completed run revalidates the exact target key-set and every
request aggregate in a repeatable-read transaction before returning the same
idempotent report. Source-version/hash drift, target key-set divergence,
post-completion target corruption, incomplete totals and duplicate execution
attempts against incompatible state fail closed. This command is not a full
007–010 migration, does not
write the JSONB snapshot and does not authorize relational cutover.

## Two independent HTTP instances

The opt-in PostgreSQL suite includes process-level scenarios that start two
isolated Next servers and point both at the same disposable database. The
development-mode scenario proves login on A → `/session/me` on B, an
authorized SSE stream on B with a real PostgreSQL `LISTEN`, a no-clinical-
payload wake-up probe and a diagnostic-request mutation on A delivered as a
durable outbox event to B. The production-start scenario builds and starts two
independent `next start` processes, receives the first event, disconnects,
creates a second request with explicit duplicate override, and reconnects with
`Last-Event-ID`, proving that only the subsequent durable event is replayed;
the same stream closes promptly when A revokes the shared session.
Run the full suite with the command above; to focus on these scenarios:

```sh
ALLOW_POSTGRES_INTEGRATION_TESTS=true \
POSTGRES_TEST_ADMIN_URL=postgresql://<local-user>@127.0.0.1:<port>/postgres \
npm run test:postgres -- --run tests/postgres/http-multi-instance.integration.test.ts --reporter=verbose
```

This is local `CONDITIONAL` evidence. The fixture and PostgreSQL cluster are
synthetic; the `next start` scenario uses a local HTTP responder only for the
S3-compatible health check and does not persist objects or call a scanner.
Target proxy/TLS, IdP, restart/failover, representative load, real storage/AV,
delivery sink and human/clinical gates remain separate acceptance work.

## Browser against a durable disposable database

The Playwright harness supports an explicit external-runtime mode. Start the
Next server against the migrated and synthetically seeded disposable database,
then run the browser suite from a second terminal:

```sh
# terminal 1 — the runtime must already be ready and must use a disposable URL
PORT=3110 \
APP_DATA_MODE=postgres \
DATABASE_URL=postgresql://<local-user>@127.0.0.1:<port>/<cvg_test_database> \
RATE_LIMIT_MODE=memory \
TRUST_PROXY=true \
TRUST_PROXY_SHARED_SECRET=<synthetic-test-secret> \
OUTBOX_INLINE_LOCAL=true \
STORAGE_SCAN_MODE=local \
npm run dev

# terminal 2 — do not let Playwright replace the target runtime
E2E_REUSE_EXISTING_SERVER=true \
BASE_URL=http://127.0.0.1:3110 \
CI=1 npm run test:e2e -- --retries=0 --fail-on-flaky-tests
```

`E2E_REUSE_EXISTING_SERVER=true` is deliberately opt-in; the default still
starts isolated in-memory servers per project. The Next.js development
allowlist includes only the documented local loopback hosts and the existing
LAN demonstration host, so the runtime can hydrate when `BASE_URL` uses
`127.0.0.1`. The earlier snapshot packet ([`aaa3-postgres-browser-20260906.md`](../../.orchestrate/evidence/aaa3-postgres-browser-20260906.md)) records 17/17 Chromium scenarios with local storage. The superseding production-like local packet ([`aaa3-browser-postgres-production-s3-20260906.md`](../../.orchestrate/evidence/aaa3-browser-postgres-production-s3-20260906.md)) records 51/51 across Chromium, tablet and mobile with `next start`, S3-compatible upload/download, HTTPS scanner, PostgreSQL outbox worker and `readyz.dataMode=postgres`/`storageMode=s3`. The current Node 22 revalidation and production-like lane are recorded in [`postgres-node22-final-20260907.md`](../../.orchestrate/aaa3-execution-20260907/postgres-node22-final-20260907.md) and [`browser-postgres-synthetic-local-20260907.md`](../../.orchestrate/aaa3-execution-20260907/browser-postgres-synthetic-local-20260907.md); the current no-retry browser regression is in [`browser-e2e-node22-no-retry-20260907.md`](../../.orchestrate/aaa3-execution-20260907/browser-e2e-node22-no-retry-20260907.md); the PostgreSQL-only restore smoke is in [`postgres-restore-smoke-node22-local-20260907.md`](../../.orchestrate/aaa3-execution-20260907/postgres-restore-smoke-node22-local-20260907.md).

Both browser proofs remain local conditional evidence: services are synthetic,
the run is one instance, and neither packet proves production object storage,
representative load, restore/RPO/RTO, hospital policy or release acceptance.
The separate HTTP process packet covers two-instance session/fanout at the API
boundary, not browser deployment acceptance.

## Local migration manifest check

The migration runner has a database-free preflight for the production bundle:

```sh
npm run validate:migrations
```

It reads the current production set `001_initial` through `010_relational_backfill_control` (including the immutable AAA2-012 `001–008` baseline), verifies contiguous order and exact UTF-8 SHA-256 checksums, and prints the manifest. The migration unit tests also exercise empty-ledger bootstrap, populated `001–006 → 007`, `001–007 → 008`, and `001–009 → 010` upgrades, checksum drift, ledger gaps and unknown/future versions through a SQL test double. These checks do not execute PostgreSQL, validate live constraints/indexes, or replace the disposable integration loop below.

## CI loop

The CI `verify` job starts PostgreSQL 16 as a service, waits for its health check, and supplies:

```text
ALLOW_POSTGRES_INTEGRATION_TESTS=true
POSTGRES_TEST_ADMIN_URL=postgresql://cvg:cvg_ci@127.0.0.1:5432/postgres
```

The default CI `browser` job remains the memory-only journey. The separate
`browser-postgres` job depends on `verify`, runs Node 22 with its own disposable
`postgres:16-alpine` service, and uses only the database
`cvg_test_e2e_${{ github.run_id }}`. Its setup is:

1. create that database through the service admin database;
2. run `npm run db:migrate` and `npm run db:seed` with
   `NODE_ENV=development`, `ALLOW_SYNTHETIC_SEED=true` and the existing
   synthetic password `DEMO_PASSWORD=e2e-local-password-2026`;
3. generate a disposable scanner certificate and start
   `npm run ci:storage-services`, which provides an authenticated
   S3-compatible `HEAD`/`PUT`/`GET`/`DELETE` service and an authenticated HTTPS
   clean/quarantine scanner; publish their loopback ports through
   `$GITHUB_ENV`;
4. run `npm run build`, start `npm run start -- --hostname 127.0.0.1` with
   `NODE_ENV=production`, and start a separate `npm run outbox:worker` with
   `OUTBOX_SINK=postgres` and `OUTBOX_INLINE_LOCAL=false`;
5. poll `/api/v1/readyz` until it reports `ready`, `dataMode=postgres` and
   `storageMode=s3`;
6. run the external-server Playwright lane:

```sh
E2E_REUSE_EXISTING_SERVER=true \
BASE_URL=http://127.0.0.1:3110 \
CI=1 npm run test:e2e -- --retries=0 --fail-on-flaky-tests
```

The complete matrix contains 17 scenarios per project (12 core,
3 clinical-lifecycle and 2 accessibility), for 51 scenarios across Chromium,
tablet and mobile. The clinical flow exercises clean attachment
upload/download and critical-result acknowledgement through the durable
PostgreSQL outbox worker.
`TRUST_PROXY=true` and `TRUST_PROXY_SHARED_SECRET=e2e-proxy-secret-2026-0123456789abcdef` (production readiness requires 32+ characters)
match the `x-cvg-proxy-secret` and `x-forwarded-for` headers emitted by
`playwright.config.ts`. The service credentials, scanner key and certificate
are synthetic and loopback-only. This lane therefore proves the configured
storage/scan/outbox contracts in a disposable environment, not a real
object-storage provider, production AV service or target credentials.

The lane uploads `playwright-report/`, `test-results/` and `logs/` under a
run-specific artifact. An `if: always()` cleanup stops the production server
and probe, terminates sessions in the named database, and drops only
`cvg_test_e2e_${{ github.run_id }}`. No production URL or credential is used;
the CI PostgreSQL service is isolated from the persistent local database.

## Guardrails

- `validatePostgresIntegrationEnvironment` rejects missing opt-in, missing admin URL and non-loopback hosts.
- The admin URL is used only to create/reset a dedicated test database; credentials are synthetic and are not committed as production secrets.
- Migration and reset tests are isolated by database name and run serially.
- A successful harness test proves the guardrail, not that a live PostgreSQL integration ran; the output must identify the server and migration result.
