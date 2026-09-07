# V2 completed-run replay integrity — current local evidence

Status: `PASS_WITH_CONDITIONS` for the bounded local shadow slice. This packet
does not authorize clinical use, relational cutover, production deployment or
hospital release.

Observed: 2026-09-06. The current shell used Node 24.20.0 while the repository
pin is Node 22; the current checks passed, and the Node 22 evidence from the
preceding candidate remains separately recorded. Next.js is 16.3.0 and the
disposable PostgreSQL runtime is 16.15. The existing PostgreSQL process on
`127.0.0.1:5432` was not touched.

## Frozen objective

After a backfill run reaches `COMPLETED`, reusing the same `runId` must still
verify the relational shadow before reporting success. The verification now
checks the exact key set across the ten mapped tables and reconciles every
request aggregate against the authoritative JSONB snapshot in a
`REPEATABLE READ` transaction. Target corruption therefore fails closed,
leaves the completed ledger row completed, and never promotes relational
authority.

## RED then GREEN

The new regression was first run against a real disposable PostgreSQL cluster
before the implementation change: 8 tests passed and the test that corrupted a
completed target unexpectedly resolved. This was a genuine product failure,
not an unavailable-database result.

After the implementation change:

- Focused disposable PostgreSQL run on loopback port `55469`: **1 file,
  9/9 tests**, 6.47s.
- Full disposable PostgreSQL run on loopback port `55470`: **5 files,
  29/29 tests**, 40.94s.
- Focused TypeScript/store regression suite: **3 files, 25/25 tests**, 3.33s.
- `npm run typecheck`: PASS.

The focused integration case proves intact completed replay remains idempotent,
post-completion aggregate corruption fails with
`POSTGRES_RELATIONAL_RECONCILIATION_DIVERGED`, the completed ledger status is
preserved, and source JSONB remains unchanged. The same file also retains
source-drift, cursor-resume, source-lock, advisory-lock, exact-key and
constraint coverage.

## Broad revalidation

- `npm run validate`: **67 files, 564/564 tests**; 93.06% statements/lines,
  85.11% branches and 95.51% functions; typecheck, lint, docs 56/56, OpenAPI
  65 operations across 60 paths, traceability 43/43 and migrations 001–010
  with exact checksums passed.
- `npm run build`: PASS; 12 static pages generated.
- `CI=1 npm run test:e2e -- --retries=0 --fail-on-flaky-tests`: **51/51** in
  3.4 minutes.
- `npm run test:accessibility -- --retries=0 --fail-on-flaky-tests`: **6/6**
  in 22.3s.
- `npm run security:scan`: PASS; `npm audit --audit-level=high`: **0
  vulnerabilities**.
- `npm run test:perf`: **7/7**; `npm run test:recovery`: **5/5**.
- Canonical engineering-framework checker: **11/11**; JSON/JSONL parsing and
  active state/backlog/log/gate reconciliation passed.
- `git diff --check`: PASS.

## Independent review status

Two fresh sealed read-only critic attempts were commissioned after the RED/GREEN
change with `fork_context:false` and no access to `.agent` or `.gauntlet`
control-plane context. `Mill` and `Maxwell` both timed out without returning a
report and were closed after re-polling. They are recorded as `NOT_RUN`, not as
approval and not as evidence that the implementation is risk-free. The earlier
critic report belongs to the pre-replay-hardening slice and is not substituted
for a fresh independent approval.

## Explicit limits and next gate

This remains synthetic/disposable local evidence. The JSONB snapshot remains
runtime authority. Full 007–010 relational mapping, target-environment
projection and dual-read, approved representative EXPLAIN/load, recovery and
rollback in the target, production storage/AV/secrets/TLS, remote CI,
independent approval, signed clinical policy, manual acceptance and hospital
release authority remain open. The next action is target-environment and human
evidence; the product remains `VERIFY` / `PASS_WITH_CONDITIONS`, not
`RELEASE_READY` or `AAA-READY`.

Source and regression artifacts:

- `src/server/store/postgres-store.ts`
- `tests/postgres/relational-sample-lineage.integration.test.ts`
- `docs/v2/RELATIONAL_SAMPLE_LINEAGE.md`
- `docs/testing/POSTGRES_INTEGRATION.md`
- `.orchestrate/evidence/v2-relational-sample-lineage-replay-hardening-run-20260906.txt`
