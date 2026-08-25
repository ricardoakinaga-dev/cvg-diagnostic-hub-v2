# Gauntlet Progress

## Current V2 checkpoint — 2026-08-25

- Goal: build the first executable V2 vertical slice while preserving V1 and
  establishing a real migration boundary.
- Phase: DISCOVER → DEFINE_BAR → BUILD → RUN → INSPECT → CRITIQUE → FIX → RETEST
- Current round: 17 (wave 1 fixes, independent criticism and full retest)
- Frozen bar: [`docs/v2/QUALITY_BAR.md`](../docs/v2/QUALITY_BAR.md)
- ExecPlan: [`.agent/plans/cvg-diagnostic-hub-v2.md`](../.agent/plans/cvg-diagnostic-hub-v2.md)
- Migration map: [`docs/v2/MIGRATION_MAP.md`](../docs/v2/MIGRATION_MAP.md)
- Implemented: structured server-derived operational context; attention-filtered
  Command Center; scoped sector projection; dense queue filters; accessible
  contextual drawer; real `domain`, `ui`, `services` and `shared-state` package
  boundaries; stale/degraded dashboard labeling.
- Fresh evidence: 283 tests across 48 files; 89.17% statements, 83.93% branches
  and 96.4% functions; typecheck/lint/build/OpenAPI/docs/secret scan/diff pass;
  Chromium core plus accessibility 12/12, including the 390px drawer focus
  journey.
- Independent critic: no unresolved local CRITICAL/HIGH finding after fixes;
  the coordinator retested the browser after the critic's read-only pass.
- Decision: `PASS_WITH_CONDITIONS` for V2 wave 1 only. The global V2 program,
  hospital use and production release remain `NOT READY`.

## Round 15 — V2 official-repository recovery and first-wave bar — 2026-08-25

- The official V2 origin and preserved V1 remote were established; the V2 remote
  was empty during discovery, so the checkout remains a transition base.
- The migration map, first-wave quality bar and executable plan were frozen before
  implementation. The initial independent critique rejected the global V2 scope,
  which became the explicit backlog and limitation boundary for this wave.

- Goal: Elevar o CVG Diagnostics Hub do estado local atual para uma entrega local/produtiva com scorecard alvo de 95/100 por dimensão; criar plano, roadmap e backlog; implementar melhorias seguras; validar o artefato real; manter gates clínicos/operacionais explícitos.
- Phase: DISCOVER → DEFINE_BAR → BUILD → RUN → INSPECT → CRITIQUE → FIX → RETEST
- Current round: 12 (Quality Bar v4 recovery and critical-gap closure)
- Active workstreams: Foundation/contracts, durable events, observability/storage/recovery, web/UX, verification/operations.
- Frozen bar: [`docs/build/PREMIUM_MVP_V4.md`](../docs/build/PREMIUM_MVP_V4.md)
- Roadmap/backlog: [`.agent/plans/premium-enterprise-mvp-v4.md`](../.agent/plans/premium-enterprise-mvp-v4.md) and [`.agent/backlog.json`](../.agent/backlog.json)
- Final local verification: `npm run test:coverage` PASS (109 testes; 95.35% statements, 81.05% branches); typecheck/lint/build PASS; PostgreSQL persistence/audit/outbox smoke PASS; disposable restore PASS (`1|26|13`); Playwright 24/24 across desktop/tablet/mobile, including the LAN URL and request-detail layout; explicit accessibility suite 6/6; four-route production perf smoke 400 requests/0 errors/max p95 434.69 ms against 500 ms; OpenAPI 47 paths/docs 56 files/secret scan/audit PASS; `git diff --check` PASS.
- Current gap: the former local-complete claim was rejected. Four HIGH clinical/security defects were reproduced; OpenAPI has 51 semantic errors; Postgres and complete clinical browser journeys lack automated proof.
- Stop rule: no score is raised without fresh evidence, and no external clinical policy is invented in code or documentation.

Next largest gap:
Close draft confidentiality, exact author/service authorization, fail-closed bootstrap and duplicate-result lineage with RED-first tests.

## Round 12 — Quality Bar v4 recovery — 2026-08-22

- Complete docs/code/test audits reject the historical 95/96 local closure.
- `npm run validate` remains a useful baseline (119 tests and global coverage pass),
  but it does not exercise PostgreSQL and cannot establish the required journeys.
- Standards OpenAPI lint exits 1 with 51 errors and 47 warnings.
- Independent security verdict is `REJECT`, with draft disclosure, cross-author/service
  draft edits, known default ADMIN credentials and duplicate result drafts reproduced.
- The active bar, plan, dependency graph and typed evidence now live in
  `docs/build/PREMIUM_MVP_V4.md` and `.agent/`.
- Release remains `NOT READY`; external gates are unchanged and are not simulated.

## Round 10 — LAN development access hardening and final retest — 2026-08-20

Gap:
The local app rendered on `localhost`, but opening it through the machine's LAN address stayed on the loading screen. Next 16 rejected development assets from the LAN origin, and plain HTTP on the LAN did not expose `crypto.randomUUID`, which prevented login/request client actions before the API call.

Change:
Allowlisted only the current local demo host in `allowedDevOrigins`; added a `crypto.getRandomValues`/time fallback for client-generated idempotency and correlation IDs; and added regression tests covering LAN-compatible login/request submission.

Retest:
`npm run test:coverage` → 109/109, 95.35% statements and 81.05% branches; typecheck/lint/build → PASS; isolated LAN Playwright E2E → 24/24, including accessibility 6/6 and the request-detail layout regression; OpenAPI → 47 paths; docs → 56 files; secret scan, high-severity audit and diff check → PASS.

Decision:
The local LAN demo is usable at the current host address. Keep synthetic data and `NOT READY` for hospital use.

## Round 09 — Authorization hardening, stable pagination and final retest — 2026-08-20

Gap:
The previous independent audit found server-side authorization gaps for sample receipt, manager scoping, ADMIN clinical bypasses, mixed timeline contexts, notification acknowledgement, SSE revocation and sensitive role changes. It also identified offset cursors and incomplete query/OpenAPI descriptions.

Change:
Closed those local gaps with server-side department/resource checks, technical-only ADMIN permissions, manager-scoped patient/request/item/search/queue/dashboard/audit reads, matching timeline contexts, permissioned notification acknowledgement, keyset cursors, SSE authorization snapshots, password re-authentication plus expected-version/reason/confirmation controls for role changes, and aligned route schemas/OpenAPI/docs. Added a positive approved-policy test so the critical-policy guard remains executable without inventing clinical thresholds.

Retest:
`npm run test:coverage` → 107/107, 95.4% statements and 81.01% branches; typecheck/lint/build → PASS; OpenAPI → 47 paths; docs → 56 files; PostgreSQL smoke → PASS; restore smoke → PASS (`1|26|13`); production `next start` perf smoke → 400 requests, 0 errors, max p95 434.69 ms against 500 ms; Playwright E2E → 21/21; accessibility → 6/6; secret scan, high-severity audit and diff check → PASS.

Independent critique:
The compatible read-only audit returned `REJECT` with five concrete local findings: session-revoked SSE streams stayed open; a manager could complete an item outside the manager's department; notification acknowledgement lacked idempotency/version/reason/confirmation controls; timeline omitted derived Sample/ResultVersion/Procedure/Attachment events; and the OpenAPI envelope/header contract diverged from runtime. Each finding was fixed and locked by targeted regression tests and fresh gates. The specialized reviewer profile and a second post-fix explorer were unavailable in this account, so no unsupported independent approval is claimed. External gates remain blocked/conditional and are not represented as local implementation failures.

Decision:
Local technical gates are green at the synthetic/local boundary. The release remains `NOT READY` for hospital use until identity/ownership, delegated-manager policy, transfer/alta, approved critical-result fallback, production AV/object storage/credentials, retention/RPO/RTO, representative workload, manual acceptance, remote CI and pilot sign-off are evidenced by responsible owners.

## Round 07 — Workflow closure, artifact verification and final retest — 2026-08-20

Implementation closure:
The documented priority gaps are implemented locally: patient/encounter context replaces hardcoded request context; queue, request detail and result detail expose server-confirmed next actions; dashboard and indicators retain partial data and surface retry/degraded states; patient, indicators and administration surfaces are available with explicit permission denial; catalog/reason reads and scoped diagnostics/audit/report reads are versioned API paths; command bodies and streamed attachment bodies are bounded and validated; client errors are safe by code rather than raw server message.

Independent evidence:
The compatible default reviewer was commissioned for a fresh read-only audit after the unavailable specialized reviewer profile, but the harness did not return a result within the finalization window and the agent was shut down. A fresh local read-only audit was completed instead; no reviewer result is converted into an approval without concrete evidence.

Fresh retest:
`npm run validate` → PASS, 93 tests, 94.39% statements, 80.3% branches; `npm run build` → PASS; production `next start` → ready on port 3000; `npm run test:e2e` → 21/21 across chromium, tablet and mobile; `npm run test:accessibility` → 6/6; `DATABASE_URL=... npm run db:smoke` → PASS; `ALLOW_DB_RESTORE_SMOKE=true npm run db:restore:smoke` → PASS (`1|18|9`); `BASE_URL=http://localhost:3000 PERF_REQUESTS=100 PERF_CONCURRENCY=10 PERF_WARMUP=10 npm run perf:smoke` → 0 errors, p95 134.54 ms; outbox one-shot → PASS; `npm run validate:openapi` → 44 paths; `npm run validate:docs` → 56 files; `npm run security:scan` and `npm audit --audit-level=high` → PASS; `git diff --check` → PASS.

Decision:
All local technical gates are green at the synthetic/local boundary. The release remains `NOT READY` for hospital use because identity/ownership, transfer/alta, critical-result thresholds/fallback, production AV/object storage/credentials, retention/RPO/RTO, representative hospital workload, manual clinical/accessibility acceptance, remote CI and pilot sign-off remain external gates.

## Round 08 — Contract slices, representative local workload and retest — 2026-08-20

Gap:
The Round 07 audit identified local contract gaps in indicator definitions, request/search/timeline query semantics, user/role administration and performance evidence limited to one catalog endpoint. The independent audit also found that critical-result fallback, transfer/alta and production object-storage recovery must remain external gates.

Change:
Added a single-snapshot dashboard indicator contract with explicit numerator/denominator/definition/next-action fields; corrected `newResults` to count only released results awaiting review; added validated request filters, typed scoped search results and stable cursor metadata for search/timeline; added ADMIN-only versioned/audited user-role administration with safe user fields and controlled UI; aligned API/OpenAPI/docs contracts; expanded perf smoke to diagnostic services, requests, search and dashboard.

Retest:
`npm test -- --run` → 102/102; `npm run test:coverage` → 94.69% statements and 80.23% branches; `npm run typecheck`/`npm run lint`/`npm run build` → PASS; `npm run validate:docs` → 56 files; `npm run validate:openapi` → 46 paths; PostgreSQL smoke → PASS; restore smoke → PASS (`1|20|10`); perf smoke → 400 requests, 0 errors, max p95 346.03 ms against 500 ms; `npm run security:scan` and `npm audit --audit-level=high` → PASS; clean Playwright-managed dev run → E2E 21/21 and accessibility 6/6. A stale reused production server initially caused a transient E2E rate-limit failure after the benchmark; it was resolved by rerunning with the configured isolated test server and is not counted as artifact evidence.

Independent critique:
A specialized reviewer profile was rejected by the account harness because its fixed model is unsupported. A compatible default read-only reviewer was commissioned for the final diff; its result is pending and must be integrated before the final commit decision.

Decision:
Local implementation evidence is green at the synthetic boundary, but the release remains `NOT READY` for hospital use. Critical-result fallback/escalation, transfer/alta/ownership, production AV/object storage/credentials, approved retention/RPO/RTO, representative hospital load, manual accessibility/clinical acceptance, remote CI and pilot sign-off remain conditional or blocked external gates.

## Round 11 — Management control center and delegated access — 2026-08-20

- Goal: deliver scoped collaborator administration, full safe catalog/reason customization, and an operational management control center without weakening the existing clinical/security boundary.
- Phase: DEFINE_BAR → TEST_FIRST → BUILD → RUN → INSPECT → CRITIQUE → FIX → RETEST
- Frozen bar: `MGMT-1` through `MGMT-8` in `.gauntlet/state.md`.
- Baseline: clean `main` at `13016ec`; manager currently has no user-management permission, sees no diagnostic catalog because its department is `INPATIENT`, and has no management-specific navbar/control center.
- Safety decisions: manager scope is explicit through `managedDepartmentCodes`; user removal is soft deactivation plus session revocation and audit; catalog identifiers and reason codes remain stable after creation.
- Evidence pending: red tests, implementation, full unit/coverage/typecheck/lint/build/docs/OpenAPI/security gates, three-viewport Playwright and accessibility, real-browser network/console inspection, fresh read-only critique, commit and push.

### Round 11 closure — 2026-08-20

- Implemented scoped manager control center, operational navbar, delegated collaborator create/update/soft-deactivate, service catalog customization, auditable reason customization, session revocation, and append-only audit visibility.
- Verification: 119 unit/integration tests; 94.97% statements; 80.74% branches; typecheck/lint/build PASS; 33/33 Playwright across desktop/tablet/mobile; accessibility 6/6; docs 56 files; OpenAPI 49 paths; secret scan PASS; production dependency audit 0 vulnerabilities; diff check PASS.
- Browser evidence: manager scope rendered `INPATIENT · LABORATORY · RADIOLOGY · ULTRASOUND`; admin console rendered 4 scoped collaborators, 4 services and 5 reason codes; no page errors or non-SSE failed requests were observed.
- Fixes during critique: scoped manager fixtures, UI role filtering, catalog-code client validation, and version-keyed collaborator rows so server-side deactivation immediately renders `Desativado` after reload.
- Critic status: fresh local read-only audit completed; non-independent because no callable independent reviewer/subagent was available in this harness. Final verdict is `CONDITIONAL PASS` for local synthetic scope only.
- Remaining external gates: hospital IdP/ownership and delegated-manager approval, transfer/alta, critical-result policy/fallback, production AV/object storage/credentials, retention/RPO/RTO, representative workload, manual clinical/accessibility acceptance, remote CI and pilot sign-off.

## Round 18 — V2 structured Laboratory remediation and retest — 2026-08-25

- Independent pre-remediation criticism found a P0: an active Hemogram could be
  released with legacy `{}` content through the queue/lifecycle path.
- Remediation closed the local bypass: release revalidates structured content,
  legacy drafts are migration-only and visibly incomplete, the Laboratory queue
  no longer offers immediate release, and new numeric catalog services require an
  active versioned panel template. The CRP fixture is narrative until its own
  approved panel exists.
- Fresh local evidence: 292 tests in 49 files passed with 89.25% statements,
  83.94% branches and 96.51% functions; typecheck, ESLint, Next build, OpenAPI
  64/59, Redocly, docs, secret scan and diff check passed; clinical Chromium
  3/3 and core/accessibility Chromium 12/12 passed on clean servers.
- The final read-only critic is being run against the remediated tree. The slice
  remains conditional and the global V2 remains `NOT_READY`; no push was made.

## Round 19 — V2 Laboratory conditional closure and Patient Workspace handoff — 2026-08-25

- Final read-only criticism confirmed the release/catalog/UI remediations. The
  alleged OpenAPI `critical` mismatch was false: generated OpenAPI and Zod both
  keep the field optional, and 11 focused parity tests now lock the behavior.
- Final local evidence: 293 tests/49 files; 89.25% statements, 83.94% branches,
  96.51% functions; typecheck/lint/build/OpenAPI 64/59/Redocly/docs 56/secret
  scan/JSON parse/diff checks green; browser evidence 3/3 and 12/12.
- Decision: `PASS_WITH_CONDITIONS` for the synthetic Laboratory slice only;
  template authoring, clinical policy, sample/accession lineage, relational
  persistence, Patient Workspace, CI/load/manual acceptance and production
  controls remain open. No push was made.
