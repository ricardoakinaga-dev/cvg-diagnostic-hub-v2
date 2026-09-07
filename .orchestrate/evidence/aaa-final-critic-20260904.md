# Final Critic — AAA-1

- Decision: `REJECT`
- Critic ID: `CVG-AAA1-FINAL-CRITIC-I1-20260904-01`
- Independence: `I1`; context fork: none; packet sealed: true
- Mutation sentinel: `UNCHANGED`; independent post-fingerprint verification: `match: true`

## Current criterion verdicts

| Criterion | Verdict | Evidence boundary |
| --- | --- | --- |
| AAA-01 | PASS | 45/45 E2E without retry; synthetic memory only |
| AAA-02 | PASS | OpenAPI 64 operations/59 paths; no remote CI |
| AAA-03 | PASS | input-limit/schema/safe-error tests; no production proxy/load proof |
| AAA-04 | PASS | server authorization tests; no institutional IdP |
| AAA-05 | PASS | confidentiality/negative tests; storage remains synthetic |
| AAA-06 | BLOCKED | hospital identity, homonym, transfer and discharge policy unsigned |
| AAA-07 | BLOCKED | 10 PostgreSQL integration tests stop at the explicit opt-in guard |
| AAA-08 | FAIL | runtime still writes authoritative full JSONB snapshot; migration 007 is additive only |
| AAA-09 | FAIL | no executed backfill, dual-read, cutover, rollback/roll-forward or restore drill |
| AAA-10 | BLOCKED | cross-instance PostgreSQL tests were not run against a database |
| AAA-11 | FAIL | production outbox worker still uses a console sink; durable sink proof absent |
| AAA-12 | FAIL | realtime remains process-local polling; no multi-instance fanout |
| AAA-13 | BLOCKED | external AV, production object storage and restore absent |
| AAA-14 | FAIL | metrics are process-local; failure injection, tracing, alert routing and runbooks unverified |
| AAA-15 | FAIL | 400-request smoke is synthetic; no representative workload or PostgreSQL EXPLAIN |
| AAA-16 | NOT VERIFIED | automated 6/6 passes; manual reader/touch/contrast/reduced-motion/clinical acceptance absent |
| AAA-17 | NOT VERIFIED | no complete architecture acyclicity or migration-regression proof |
| AAA-18 | PASS | audit 0 vulnerabilities; fast-uri 3.1.7 |
| AAA-19 | BLOCKED | no isolated restore drill or approved RPO/RTO |
| AAA-20 | NOT VERIFIED | docs pass, but every MUST/AC is not yet linked to current code/test/command/digest |
| AAA-21 | BLOCKED | no signed clinical governance policy |
| AAA-22 | BLOCKED | no remote CI, representative load, manual acceptance, rollback authority, pilot or release sign-off |

## Required rework

1. Complete relational runtime cutover and live migration/backfill/concurrency/EXPLAIN evidence (`AAA-W1-003`, `AAA-W1-004`, `AAA-W1-005`, `AAA-W1-007`).
2. Execute the PostgreSQL suite on a disposable database (`AAA-W0-002`).
3. Replace console delivery with durable sink confirmation and implement multi-instance realtime/telemetry/benchmark evidence (`AAA-W4-006`, `AAA-W5-001`, `AAA-W5-002`, `AAA-W5-003`).
4. Complete approved AV/object storage and isolated restore (`AAA-W2-003`, `AAA-W1-006`).
5. Obtain institutional and clinical decisions (`AAA-W2-001`, `AAA-W2-002`, `AAA-W3-002`, `AAA-W4-005`, `AAA-W8-001`, `AAA-W8-002`).
6. Complete manual UX, remote CI, full traceability and release packet (`AAA-W6-001`, `AAA-W7-001`, `AAA-W7-002`, `AAA-W7-003`), then rerun the final critic.

Largest remaining gap: the runtime remains a transitional JSONB snapshot instead of proven relational clinical persistence.
