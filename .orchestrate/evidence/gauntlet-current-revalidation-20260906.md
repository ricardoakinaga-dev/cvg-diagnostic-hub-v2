# Current consolidated revalidation — 2026-09-06

## Status

`PASS_WITH_CONDITIONS` for the current local synthetic candidate. This packet
is the current traceability anchor; historical packets remain immutable and
are not relabeled as current. It is not AAA-READY, production approval,
clinical acceptance or relational cutover authority.

## Current final revalidation — 2026-09-06T21:14:42Z

- `npm run validate` passed **614/614** tests in 75 files, with 92.01%
  statements/lines, 85.00% branches and 94.36% functions; docs 73/73,
  OpenAPI 65 operations/60 paths, traceability 43/43 and migrations 001–010
  with checksums.
- The full browser regression passed **51/51 in 3.9 minutes** with no retries;
  accessibility passed 6/6. The focused responsive scenario passed 3/3.
- The current Patient Workspace packet is v6 with **20 PNG artifacts** covering
  ready, loading, error/denied, empty, partial and stale at 1440, 834 and 375
  CSS pixels, plus dense mobile collapsed/expanded evidence. Fresh-context
  critic Bernoulli returned **APPROVED_LOCAL** for the exact packet.
- Current packet: [`visual-patient-workspace-20260906-v6/manifest.json`](visual-patient-workspace-20260906-v6/manifest.json),
  SHA-256 `77fcf00479c41aeac40e3dc5a470c94048a99a285f042b02abbee49c2f6263a5`;
  critic report: [`visual-patient-workspace-20260906-v6/critic-report.md`](visual-patient-workspace-20260906-v6/critic-report.md).
- The new `relational-sample-lineage.integration.test.ts` is present but was
  not executed because no disposable PostgreSQL runtime was available. The
  historical PostgreSQL result remains 30/30, and persistent `127.0.0.1:5432`
  was not touched.
- Current code/evidence hashes are recorded in the v6 manifest; the coverage
  summary digest is `82feefaeb7d0e933b2787b697d8080d1a1d0f877f721f189f6037c20e2fb06b6`.

## Historical responsive-polish checkpoint — 2026-09-06T19:42:36Z

- Final focused Patient Workspace state capture passed 3/3 responsive projects
  with no retries and synchronized 18 PNGs covering ready, loading,
  error/denied, empty, partial and stale at 1440, 834 and 375 CSS pixels.
- Final full browser regression passed **51/51 in 4.6 minutes**, with no
  retries; the responsive scenario passed 3/3 and the accessibility scenarios
  remained green.
- `npm run validate` passed serially: 612/612 tests in 75 files, 92.01%
  statements/lines, 85.02% branches and 94.43% functions; docs 73/73,
  OpenAPI 65 operations/60 paths, traceability 43/43 and migrations 001–010
  with checksums.
- Fresh-context critic Epicurus inspected the exact 18 final PNGs and returned
  **APPROVE**. No material local visual defect, clipping, problematic
  truncation, alert obstruction or development overlay remained.
- Current fingerprints: `globals.css`
  `584ac679e78680e0482d2e7361522f49428e221f213d6e4a362d1e605dbba21c`,
  `next.config.mjs`
  `75b2a83344fb7ce4d425f8cb6fab116231ff17bd2dc09a605b05c66ba03eb63d`,
  `core-flows.spec.ts`
  `2f9f4796b2c67112df7d175b27d7893c8afe9e7705f85408742084baf1046f91`, and
  state manifest `6e772715d157ef38e51bd46f929a8d7a280514a043eeb338b77097a303025eb9`.
- This is still `PASS_WITH_CONDITIONS`: manual screen-reader/touch review,
  product golden, target Web Vitals, remote CI, target operations, relational
  authority, clinical and human release gates remain open.

## Candidate and environment

- Repository `HEAD`: `01bb1804682b4bb503e00e41c1361dc704d2294d` at the start of this revalidation;
  working-tree changes are intentionally in scope and are described by the
  current source manifest below.
- Runtime: Next.js 16.3.0, synthetic fixtures, system Chrome/Playwright,
  current working tree; repository pin is Node 22, while this local shell used
  Node 24.20.0 because Node 22 is not installed here.
- Source-manifest digest: `51cfe078586b7a6e10cf3321319a8247cec396fc61c5f42999ebee2c26dde922`.
- Existing PostgreSQL at `127.0.0.1:5432` was not touched by this packet.

## Historical executed result summary — checkpoint 2026-09-06T19:42:36Z

- `npm run test:coverage`: 612/612 tests in 75 files; 92.01% statements/lines,
  85.02% conservative branches and 94.43% functions.
- `npm run typecheck`, `npm run lint`, production build, docs/OpenAPI/
  traceability/migration validation and `git diff --check`: PASS.
- OpenAPI: 65 operations / 60 paths. Structural traceability: 43/43.
- Disposable PostgreSQL evidence already retained: 9/9 focused relational
  tests and 30/30 complete PostgreSQL suite; JSONB remains runtime authority.
- Browser: no-retry synthetic Chromium/tablet/mobile 51/51 in the final run;
  accessibility 6/6.
  The local durable PostgreSQL production-like packet records 51/51 across
  Chromium/tablet/mobile; CI execution and target-environment acceptance remain
  separate gates.
- Security scan, high-severity audit, performance 7/7, recovery 5/5 and the
  current contrast/reflow/copy evidence passed within their declared bounds.

## Traceability command inventory

The full current suite executed the referenced test files. The following
focused commands are the reproducible command inventory bound to the matrix;
they are not represented as separate executions when only the full suite was
run in this pass.

```text
npx vitest run src/app/api/v1/[...path]/route.test.ts
npx vitest run src/server/application/service.test.ts
npx vitest run src/server/application/error-branches.test.ts
npx vitest run src/server/application/admission-context-service.test.ts src/server/http/admission-context-route.test.ts
npx vitest run src/server/http/cancellation-policy.test.ts
npx vitest run src/server/application/workflow-commands.test.ts
npx vitest run src/server/application/catalog.test.ts
npx vitest run src/components/result-view.test.tsx
npx vitest run src/server/application/result-access-security.test.ts
npx vitest run src/server/application/error-branches.test.ts src/server/application/critical-result-policy.test.ts
npx vitest run src/server/operations/outbox.test.ts
npx vitest run src/components/app-shell.test.tsx src/components/result-view.test.tsx
npx vitest run src/server/application/read-models.test.ts src/app/api/v1/[...path]/route.test.ts
npx vitest run src/server/application/sla-policy.test.ts src/server/application/service.test.ts
npx vitest run src/server/http/scoped-reads-route.test.ts
npx vitest run src/server/application/registry-service.test.ts
npx vitest run src/server/storage/file-store.test.ts
npx vitest run src/server/application/management.test.ts src/server/application/critical-result-policy.test.ts
npx vitest run src/server/security/session.test.ts
npx vitest run src/server/storage/malware-scanner.test.ts
npx vitest run src/server/observability/metrics.test.ts
npx vitest run src/server/architecture-fitness.test.ts
npm run perf:synthetic
CI=1 npm run test:e2e -- --fail-on-flaky-tests --retries=0
npm run test:accessibility
npm run test:recovery
```

## Open conditions

The snapshot/relational cutover, full lossless mapping, representative
workload, restart/failover/restore, object storage and malware scanner,
production secrets/TLS/ingress, CI execution, manual screen-reader/touch and
clinical/hospital acceptance remain open. The earlier independent visual review
by Huygens is retained as historical CONDITIONAL evidence, the Hooke review is
historical approval, and fresh Bernoulli review approved the synchronized final
20-artifact local state/viewport matrix; the dense mobile timeline gap was closed by deterministic
collapsed/expanded assertions and production-like PNG evidence. The design
packet deliberately keeps typography conditional where approved-font parity
and formal line-box measurements are unavailable.
