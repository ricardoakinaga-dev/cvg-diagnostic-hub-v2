# Independent critic — V2 relational sample-lineage backfill

Date: 2026-09-06  
Scope: read-only review of the bounded migration-010 request-scoped shadow
backfill, its ledger, tests, CLI guardrails and documentation.  
Reviewer: fresh independent critic in the orchestration run.  
Review mode: artifact inspection only; the critic did not intentionally edit
files or execute PostgreSQL tests.

## Verdict

`PASS_WITH_CONDITIONS` for the bounded local shadow slice after retest. No
production, clinical, hospital or relational-authority approval is implied.

The first review found no CRITICAL issue and surfaced one HIGH and several
MEDIUM/LOW findings. The implementation was corrected before this verdict was
recorded, and the corrected paths were exercised by the final focused and full
PostgreSQL runs.

## Findings and disposition

- HIGH — source stability could be lost between the last source read and the
  completion ledger commit. Fixed by holding the source request row lock from
  aggregate projection through relational writes, checkpoint and final
  completion; a concurrent-writer integration case now proves fail-closed
  serialization behavior.
- MEDIUM — completeness compared row counts and could accept compensating
  extra/missing keys. Fixed with exact expected-versus-actual primary-key sets
  across the ten-table scope, with deterministic sample-link keys and
  integration coverage for target key-set divergence.
- MEDIUM — the CLI could expose raw database errors. Fixed by mapping the
  SQLSTATE/source-change path and all other failures to a bounded sanitized
  backfill code before printing.
- MEDIUM — callers could provide an arbitrary transform provenance string.
  Fixed by accepting only the server-owned `clinical-core-request-v1`
  transform version.
- LOW — documentation wording could suggest every duplicate run fails closed,
  despite completed replay being intentionally idempotent. Fixed by documenting
  completed replay as a no-op and incompatible ledger state as fail-closed.
- LOW — same-run advisory-lock behavior lacked independent-pool coverage.
  Fixed with a two-store PostgreSQL integration case that proves serialization
  and absence of duplicate rows.

## Retest evidence

- Focused relational PostgreSQL file: 9/9 tests, 6.39s.
- Complete disposable PostgreSQL suite: 5 files, 29/29 tests, 38.07s.
- `npm run validate`: 564/564 tests in 67 files; 93.06% statements/lines,
  85.14% branches and 95.51% functions.
- Production build: passed; 12 static pages generated.
- No-retry browser matrix: 51/51; no-retry accessibility matrix: 6/6.
- Secret scan, high-severity dependency audit, performance 7/7 and recovery
  5/5 passed.

The review was read-only and did not modify the application or database. Its
integrity note distinguished unrelated external control-plane/evidence
activity from the critic, ignored a Vitest cache change, and found the final
artifact fingerprint consistent with the reviewed workspace.

## Conditions retained

The snapshot/JSONB store remains runtime authority. Full 007–010 mapping,
continuous target dual-read, authority cutover/rollback, target infrastructure,
representative load and EXPLAIN approval, restart/failover, production
storage/AV/secrets, remote CI, signed clinical policy, manual acceptance and
hospital release authority remain open.
