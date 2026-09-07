# AAA-2 G3 fresh critic — post-fix ResultView — 2026-09-05

## Decision

**Overall verdict: REJECT — NÃO PRONTO.**

The bounded `ResultView` post-save race fix is **PASS** for the evidence exercised in this review. The current artifact preserves `Draft atualizado.` after its own realtime delivery, does not raise the false `mudou em outra sessão` conflict observed by G2, and still rejects a genuinely newer remote version while the editor is open. This local pass does not satisfy the frozen AAA-2 release bar: live PostgreSQL and relational authority are unproven, realtime is process-local, branch coverage remains below 85%, traceability fails closed, recovery/performance evidence is incomplete, and D-01–D-06 have no signed human decisions.

## Scope, role and artifact identity

- Mode: read-only audit of the working tree after the latest change to `src/components/result-view.tsx`.
- Critic: separate child-agent review, same model family, no participation in the product edit. The task packet disclosed the historical failure and intended correction, so this is an **I1, non-blind** review rather than an independent causal discovery.
- Observed `HEAD`: `01bb1804682b4bb503e00e41c1361dc704d2294d` with a materially dirty working tree.
- Pre-review repository+state fingerprint: `f8d14c3d5f276ac4d642f94156c12a31edd2312fb9ad500dcc19436bcd400894`.
- Reviewed file SHA-256 in the isolated copy:
  - `src/components/result-view.tsx`: `b4087a7f0781b804b3dc04594b4e6222223ecc756a8e4f11fea67f7834c89bab`
  - `src/components/result-view.test.tsx`: `671a0fdb713a66656cd587e39588f866080b1540511e989af4398282ab11a910`
- Runtime: Node `v24.20.0`; repository/CI target is Node 22.

All executable checks ran in `/tmp/aaa2-g3-audit.dHGXbm`, copied from the working tree before testing. Its `node_modules` was physically copied/reflinked so Next/Turbopack and Vitest caches stayed outside the repository. The first E2E attempt used symlinked dependencies and was **INVALID** before test execution because Turbopack rejected `next/package.json` outside the temporary workspace root; it was stopped and repeated with the physical dependency copy. That harness failure is not counted as a product failure or a pass.

## Frozen post-fix criteria

| ID | Required target | Evidence | Judgment |
| --- | --- | --- | --- |
| PF-01 | The save's own realtime event must not create a remote-conflict alert | Unit regression during a pending mutation plus real browser lifecycle | **PASS** |
| PF-02 | Post-save realtime deliveries must not overwrite the mutation confirmation | Duplicate-event unit regression and browser lifecycle | **PASS** |
| PF-03 | A genuinely newer remote version must still block an editor save | Unit regression with version 1 → 2 while the editor remains open | **PASS** |
| PF-04 | The critical acknowledgement journey must be clean on tablet and mobile without retries | Six predeclared executions, three per project | **PASS** — 6/6 |
| PF-05 | The affected browser regression surface must remain clean on the integrated artifact | Complete Playwright suite, all projects, no retries or flaky-test tolerance | **PASS** — 45/45 |
| G4-COV | Frozen branch target is at least 85% | Fresh coverage run | **FAIL** — 84.83% |
| AAA-08/09/10/12/15/19/20/21/22 | Persistence, migration, multi-instance, realtime, performance, recovery, traceability, governance and release gates need current required evidence | Source inspection and executable guards below | **REJECT/BLOCKED** |

## Code inspection

The correction is coherent for the observed race:

1. `busyRef` is set synchronously before the editor mutation and the realtime listener returns while it is true (`src/components/result-view.tsx:83`, `:145-149`, `:194-197`). A delivery emitted during the request therefore cannot run conflict detection against a version created by that same request.
2. After a successful mutation, the component writes the specific confirmation, closes the editor state, enables one editing-session suppression, and explicitly reconciles with `load(false)` (`:229-237`). This covers the React state-transition window in which an older callback can still see the previous editor/base version.
3. `noticeRef` is updated together with React state (`:100-103`). Later duplicate realtime events only write the generic reconciliation notice when no specific notice exists (`:147`), preventing `Draft atualizado.` from being overwritten.
4. `beginEditor` resets suppression and snapshots the current result version (`:165-169`). A new remote version is therefore still detected, marks the editor conflicted, clears the notice, and blocks submission (`:113-125`, `:187-193`).

The focused tests directly cover realtime reconciliation, a true remote conflict, preservation of unsaved text, an event while save is pending, and duplicate events after save (`src/components/result-view.test.tsx:131-233`). The browser scenario performs a real draft edit, release, critical acknowledgement and review through the served UI (`tests/e2e/clinical-lifecycle.spec.ts:227`).

Residual frontend limitation: multiple realtime events outside a mutation can still start concurrent `load()` calls without a sequence token or cancellation. The server-side expected-version guard protects writes, and no stale overwrite appeared in this review, but out-of-order network responses were not injected. The 6-run repeat and full suite are finite synthetic evidence, not a proof under production latency or multi-instance fanout.

## Commands and observed results

| Command | Result | Notes |
| --- | --- | --- |
| `npx vitest run src/components/result-view.test.tsx` | **PASS** — 10/10 | Focused component behavior, 1.10 s |
| `CI=1 npx playwright test tests/e2e/clinical-lifecycle.spec.ts --project=tablet --project=mobile --grep "requires critical acknowledgement" --repeat-each=3 --fail-on-flaky-tests --retries=0` | **PASS** — 6/6 | Tablet 3/3 and mobile 3/3, 58.5 s; no retry |
| `CI=1 npm run test:e2e -- --fail-on-flaky-tests --retries=0` | **PASS** — 45/45 | Chromium, tablet and mobile, 2.9 min; the critical case passed in all three projects; six axe scenarios included |
| `npm run test:coverage` | **PASS suite / FAIL threshold** — 56 files, 461/461; 92.35% statements/lines, **84.83% branches**, 94.88% functions | Branch result is 0.17 point below the frozen 85% target |
| `npm run validate:traceability` | **FAIL CLOSED** — exit 1, 20 issues | Five rows each lack code, test, command and evidence links |
| `npm run test:postgres` | **BLOCKED/EXPECTED GUARD** — exit 1; 10 integration cases blocked, 6 harness tests passed | `ALLOW_POSTGRES_INTEGRATION_TESTS=true` and a disposable live target were unavailable |
| `git diff --check` | **PASS** | No whitespace errors in the working diff |

The earlier G2 final critic recorded 44/45 because tablet displayed the false conflict after the save. This G3 review is current for the file hashes above and independently obtained 6/6 targeted plus 45/45 full first-pass browser results. The G2 failure remains historical evidence; the later passes do not erase it, but the discriminating unit cases and clean served-browser executions support that its observed race is fixed in this artifact.

## Required limits that keep the artifact NÃO PRONTO

1. **Persistence and migration: REJECT.** `PostgresStore` still reads, locks and writes the authoritative `cvg_runtime_state` JSONB snapshot; migration 007 is additive and keeps the snapshot authoritative. No live bootstrap, constraints, concurrent stores, restart/reload, rollback/roll-forward, cutover, reconciliation or `EXPLAIN` execution was available.
2. **PostgreSQL/multi-instance: BLOCKED.** The integration guard fired before all 10 live cases. There is no current E2 proof for cross-instance session revocation, concurrency, relational constraints, distributed rate limiting or browser operation against PostgreSQL.
3. **Realtime: REJECT for production/multi-instance.** `src/server/observability/realtime.ts` implements only `ProcessLocalRealtimeNotificationAdapter`; a non-process-local setting returns no adapter. The browser suite uses isolated in-memory single-process servers and cannot prove broker-backed fanout, restart survival or two-instance scope revocation.
4. **Coverage: FAIL at G4.** This critic observed 84.83% branches, below 85%. The current root evidence records 84.82%; both measurements fail the same frozen gate.
5. **Traceability: FAIL CLOSED.** `FR-CORE-005`, `FR-OPS-002`, `NFR-PERF-001`, `NFR-PERF-002` and `NFR-OPS-001` each lack all four executable link types, totaling 20 issues.
6. **Performance/recovery: REJECT.** No approved representative workload, PostgreSQL/two-instance p50/p95/p99/throughput/soak/EXPLAIN evidence, or isolated database + attachments + configuration/key restore with measured RPO/RTO was performed.
7. **Human and release gates: REJECT.** D-01 through D-06 remain `OPEN`; there is no named clinical/operations approval, manual clinical/accessibility acceptance, remote CI observation, training, pilot, rollback authority or formal release decision.

## Mutation sentinel and stop reason

Immediately before the authorized packet write, `verify-fingerprint` returned `match: true`: expected and actual repository+state digests were both `f8d14c3d5f276ac4d642f94156c12a31edd2312fb9ad500dcc19436bcd400894`. Product, test and documentation files were not changed by this critic. This packet is the only intentional repository write by the review.

The stop reason is required-gate failure, not a lack of time. The `ResultView` correction can be accepted as a bounded rework, while the program and any hospital/production release claim remain **REJECT / NÃO PRONTO** until the external and architectural gates above have current passing evidence.
