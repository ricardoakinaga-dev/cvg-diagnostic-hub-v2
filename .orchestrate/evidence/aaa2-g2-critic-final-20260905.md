# AAA-2 G2 final critic — 2026-09-05

## Audit scope and decision

This is a fresh-context, read-only final critic of the current AAA-2 working tree at `HEAD 01bb1804682b4bb503e00e41c1361dc704d2294d`. The frozen acceptance source is [`docs/build/AAA_2_QUALITY_BAR.md`](../../docs/build/AAA_2_QUALITY_BAR.md), AAA-2 dated 2026-09-05. The bar requires `AAA-01` through `AAA-22` to be `PASS`, coverage of at least 90% statements/lines/functions and 85% branches at G4, current evidence for the exact artifact, and the named E2/E3/E4 external gates.

**Final verdict: REJECT.** The current wave has a strong local synthetic slice, but required gates remain failed, blocked, or missing. This packet does not claim PostgreSQL, hospital, representative-load, restore, remote-CI, human, or pilot evidence.

No product source, migration, test, configuration, or documentation file was edited by this critic. The only requested durable write is this evidence packet.

## Verification performed

Checks were run in isolated temporary project copies where practical. The host is Node `v24.20.0` / npm `11.19.0`; the repository and CI target Node 22 (`.nvmrc`, `.github/workflows/ci.yml`).

| Check | Result | Boundary and limitation |
| --- | --- | --- |
| `npm test` | **PASS** — 56 files, 461 tests | Local Vitest; no live database or second process |
| `npm run test:coverage` | **PASS** — 92.35% statements/lines, 84.86% branches, 94.88% functions | Branch coverage is 0.14 percentage points below the frozen 85% G4 target; this is not a G4 pass |
| `npm run typecheck` | **PASS** | Host Node 24, not the Node 22 CI runtime |
| `npm run lint` | **PASS** | Local ESLint |
| `npm run build` | **PASS** | Production build completed in a copy with a local hard-linked dependency tree; no remote CI or deployment proof |
| `npm run validate:docs` | **PASS** — 56 required files | Structural/document link gate only |
| `npm run validate:openapi` | **PASS** — 64 operations across 59 paths | Drift and schema lint; not a complete semantic review |
| `npm run validate:migrations` | **PASS** — ordered 001–008 manifest and checksums | Static manifest/checksum validation; no SQL executed against PostgreSQL |
| `npm run security:scan` | **PASS** | Local secret-pattern scan |
| `npm audit --audit-level=high --json` | **PASS** — zero vulnerabilities reported | Local dependency audit; remote CI was not observed |
| `npm run validate:traceability` | **REJECT** — 20 issues | Five matrix rows retain missing `code`, `test`, `command`, and `evidence` links |
| `node --test scripts/validate-traceability.test.mjs` | **PASS** — 4 tests | Validates that the harness fails known-bad planning-only rows; it does not make the current matrix complete |
| `npx tsx --test scripts/perf-report.test.ts` | **PASS** — 2 tests | Percentile/report formatter only; no workload, PostgreSQL, `EXPLAIN`, soak, or approved SLO |
| `node --test scripts/backup-restore.test.mjs` | **PASS** — 3 tests | Source guard contracts only; no backup, restore, attachment, key, RPO, or RTO result |
| Focused realtime/visibility/session tests | **PASS** — 19 tests | In-memory/local stream and authorization boundaries |
| Focused migration/relational adapter/PostgresStore tests | **PASS** — 61 tests | Static/mocked and snapshot-store contracts; no live relational execution |
| `npm run test:postgres` | **REJECT/BLOCKED** — 10 integration tests fail at the explicit guard; 6 harness tests pass | No `ALLOW_POSTGRES_INTEGRATION_TESTS=true`, `POSTGRES_TEST_ADMIN_URL`, Docker, or authorized disposable PostgreSQL target; no claim is made about SQL constraints, locks, rollback, cutover, or multi-instance behavior |
| `CI=1 npm run test:e2e -- --fail-on-flaky-tests --retries=0` | **REJECT** — 44 passed, 1 failed | Fresh full run failed the tablet critical-acknowledgement path waiting for `Draft atualizado.`; the browser uses isolated in-memory servers |
| Tablet critical-acknowledgement test with `--repeat-each=3` | **CONDITIONAL** — 3 passed | This bounded rerun does not erase the failed first full pass or explain the flake |

The full browser run included the six accessibility scenarios and those scenarios passed in the observed run. No manual reader, touch, zoom, contrast, reduced-motion, clinical, or hospital acceptance was performed. The prior synthetic `perf:smoke` record is not a current representative-load result; `npm run perf:smoke` was not run in this final review.

## Source-of-truth inspection

1. **Relational persistence is still transitional.** [`db/migrations/007_relational_clinical_core.sql`](../../db/migrations/007_relational_clinical_core.sql#L1) says the migration is additive, creates empty structures, and does not copy or rewrite `cvg_runtime_state`; its comments at lines 861–864 keep the snapshot as runtime authority. [`src/server/store/postgres-store.ts`](../../src/server/store/postgres-store.ts#L12) reads `cvg_runtime_state`, [`readState`](../../src/server/store/postgres-store.ts#L354) rereads it, the transaction uses `FOR UPDATE` at line 417, and line 432 updates the complete JSONB snapshot. The relational adapter opened by `createWithRelationalClinicalCore` is explicitly an opt-in shadow seam (`lines 286–303`) and projects a delta inside the same transaction; it does not provide relational read authority or a proven cutover. This rejects `AAA-08` and `AAA-09` at the final bar.

2. **The live PostgreSQL boundary was not exercised.** The harness intentionally requires an explicit loopback admin URL and opt-in (`tests/support/postgres-test-harness.ts:32–57`). The current run therefore exercised only the guard. There is no evidence for migration constraints/indexes, concurrent transactions, two stores, reload after restart, rollback/roll-forward, `EXPLAIN`, or browser served against PostgreSQL. This rejects `AAA-10` and leaves the persistence and migration claims at E0/E1.

3. **Realtime is process-local.** [`src/server/observability/realtime.ts`](../../src/server/observability/realtime.ts#L1) exposes `process-local` and `multi-instance` as types, but the only implementation is `ProcessLocalRealtimeNotificationAdapter` (`lines 17–43`); any configured value other than `process-local` returns no adapter (`lines 45–52`). [`realtime-stream.ts`](../../src/server/observability/realtime-stream.ts#L18) adds useful local controls: replay/`Last-Event-ID`, authorization rechecks, poll timeout, payload and connection limits, backpressure, cleanup, and maximum stream lifetime. Those controls do not create durable fanout or prove two users/instances, reconnect behavior, or cross-instance scope revocation. `AAA-12` remains `REJECT` and `AAA-10` remains unproven.

4. **Traceability correctly fails closed.** [`docs/TRACEABILITY_MATRIX.md`](../../docs/TRACEABILITY_MATRIX.md#L9) explicitly preserves `—` for transfer/alta, SLA policy, representative performance, and restore. Rows for `FR-CORE-005`, `FR-OPS-002`, `NFR-PERF-001`, `NFR-PERF-002`, and `NFR-OPS-001` at lines 52, 67, 83, 84, and 88 have no executable links. The validator reports the expected 20 missing references. The four validator self-tests are useful harness evidence, but `AAA-20` is `REJECT` until every required MUST/AC has a current code/test/command/evidence link.

5. **SLA evidence is a bounded local addition, not the acceptance policy.** [`calculateDueAt`](../../src/server/application/service-common.ts#L786) adds fixed service priority hours to the start timestamp. The new service test verifies a stamped start, due time, and policy version, but there is no calendar/timezone/holiday handling, event-dependent start policy, pause/resume, policy history across changes, or overdue job. Decision D-04 remains `OPEN` in [`AAA_2_DECISION_REGISTER.md`](../../docs/build/AAA_2_DECISION_REGISTER.md#L12), so `FR-OPS-002` remains conditional and the traceability row remains intentionally incomplete.

6. **Performance and recovery additions are guardrails only.** [`scripts/perf-report.ts`](../../scripts/perf-report.ts#L17) summarizes supplied samples; its two tests do not generate an approved workload or contact PostgreSQL. [`scripts/backup-restore.test.mjs`](../../scripts/backup-restore.test.mjs#L9) checks shell-script safety patterns. The backup runbook explicitly records that no drill was demonstrated and that object storage, key metadata, RPO/RTO and application verification are absent. `AAA-15` and `AAA-19` are therefore `REJECT`; `NFR-PERF-001/002` and `NFR-OPS-001` remain blocked/conditional local slices.

7. **Human decisions remain open.** D-01 through D-06 are all `OPEN` in [`AAA_2_DECISION_REGISTER.md`](../../docs/build/AAA_2_DECISION_REGISTER.md#L9), and its approval rule requires a named person, role, date, policy version, rejected alternative, accepted impact, and sanitized attachment (`lines 18–20`). No clinical identity/ownership, lifecycle, critical-result, SLA, retention/RPO/RTO, pilot, or release approval was inferred. This rejects `AAA-06`, `AAA-21`, and `AAA-22` at the final bar.

## Frozen criterion judgment

`PASS` here would mean the minimum proof in the AAA-2 bar is current for this artifact. Local code and synthetic tests are recorded as useful partial evidence but are not promoted to final PASS.

| Criterion | Judgment | Reason at the final boundary |
| --- | --- | --- |
| AAA-01 — journeys | **CONDITIONAL** | Broad synthetic journeys exist, but the fresh full browser run is 44/45 and transfer/alta plus E2/E3 evidence are absent |
| AAA-02 — HTTP | **CONDITIONAL** | OpenAPI/runtime drift and route tests pass locally; full semantic contract review and durable candidate evidence are absent |
| AAA-03 — inputs | **CONDITIONAL** | Limits, schemas, safe errors, and rate-limit tests pass locally; no E2 abuse/resource-pressure run |
| AAA-04 — authorization | **CONDITIONAL** | Scoped reads, cancellation, versioning, and granular scope tests pass locally; no two-instance revocation or institutional IdP |
| AAA-05 — confidentiality | **CONDITIONAL** | Local negative filtering and metadata tests pass; durable SSE/draft/version/attachment isolation is unproven |
| AAA-06 — clinical identity | **REJECT** | D-01 is `OPEN`; homonym, ownership, transfer, and discharge proof are absent |
| AAA-07 — lifecycle | **CONDITIONAL** | Local transition/cancellation coverage is strong; durable concurrency/replay and D-02 approval are absent |
| AAA-08 — persistence | **REJECT** | PostgresStore still reads/locks/writes the authoritative JSONB snapshot; migration 007 is additive/shadow |
| AAA-09 — migration | **REJECT** | No live PostgreSQL bootstrap/upgrade, institutional backfill, reconciliation, cutover, or recovery evidence |
| AAA-10 — multi-instance | **REJECT** | The required two-instance database run is blocked and realtime/limits are not proven shared across processes |
| AAA-11 — delivery | **CONDITIONAL** | Envelope/routing/lease/retry/dedupe contracts pass locally; no live FK/transaction/crash-after-send worker proof |
| AAA-12 — realtime | **REJECT** | Only process-local adapter is implemented; no broker/fanout or served two-instance stream evidence |
| AAA-13 — files | **CONDITIONAL** | Local MIME/checksum/quarantine/storage tests and synthetic browser flow pass; homologation scanner/storage and restore are absent |
| AAA-14 — observability | **CONDITIONAL** | Readiness, correlation, and bounded metrics pass locally; no injected failure, delivered alert, or runbook exercise |
| AAA-15 — performance | **REJECT** | No approved representative workload, PostgreSQL/two-instance measurement, soak, throughput, or `EXPLAIN`; only report harness/synthetic history |
| AAA-16 — UX | **CONDITIONAL** | Browser/axe automation is useful, but the fresh browser pass is not clean and manual/user review is absent |
| AAA-17 — architecture | **CONDITIONAL** | Fitness graph and adapter seam tests pass; integrated E2 persistence/realtime review is still missing |
| AAA-18 — chain/build | **CONDITIONAL** | Local lockfile/build/lint/type/audit/scan pass; host is Node 24 versus target Node 22 and remote CI/clean candidate provenance are unobserved |
| AAA-19 — recovery | **REJECT** | No isolated database + attachment + configuration/key restore, checksum/application verification, or measured RPO/RTO |
| AAA-20 — traceability | **REJECT** | Current validator fails closed with 20 missing executable references |
| AAA-21 — governance | **REJECT** | D-01–D-05 remain `OPEN`; no signed owner, policy version, or approval evidence |
| AAA-22 — release | **REJECT** | D-06 remains `OPEN`; no remote CI observation, manual acceptance, training, pilot, rollback authority, or formal release decision |

## Independence and mutation sentinel

Critic identity: fresh child-agent context, same model family, no inherited builder rationale; independence level `I1`. The pre-review repository+state fingerprint was `ca3119a14d7b0c9b00ad9254f440988eaccabe1ee47b347c825fa74e34d42204`.

The required post-read-only sentinel did **not** match. The only detected difference was the ignored generated file `node_modules/.vite/vitest/da39a3ee5e6b4b0d3255bfef95601890afd80709/results.json`, changing from SHA-256 `1351cc11f36045159d843d74862eec6f384272b9887c72d9e9211038df8c01dd` (5,330 bytes) to `3d1e105742d44b28cd6a7e1f782972bb8941d4281b061b58cea226639d0f1508` (5,319 bytes). The change was caused by the isolated test copy using a symlink to the shared dependency directory; tracked/index/worktree source fingerprints and `HEAD` were unchanged. Under the audit protocol, this makes the mutation sentinel **INVALID** for an unqualified critic approval. The cache change is preserved and called out; it was not deleted or hidden.

## Stop decision and next evidence

The stop reason is an evidenced final-bar failure, not resource exhaustion. The highest-value next evidence is an authorized disposable PostgreSQL run with migration/constraint/concurrency/reload/rollback and `EXPLAIN` checks, followed by a relational read/write authority and cutover proof. The program then needs broker-backed multi-instance realtime evidence, a deterministic clean first-pass browser run, complete traceability links, isolated database/object-storage/configuration restore with measured RPO/RTO, and signed D-01–D-06 decisions before any AAA-READY or hospital-release statement.

