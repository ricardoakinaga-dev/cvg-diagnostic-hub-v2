# Gauntlet State

## Goal

Produzir, em um repositório inicialmente vazio, a documentação completa e coerente do CVG Diagnostics Hub seguindo `DISCOVERY → PRD → SPEC → BUILD PLAN`, incluindo discovery operacional, Event Storming, PRD/MVP, especificação de domínio/estados/dados/permissões/API/realtime, arquitetura, UX, segurança, testes, operações, ADRs, backlog e matriz de rastreabilidade. Não implementar a aplicação antes de a documentação estar revisada e coerente.

Restrições: não inventar fatos operacionais; classificar informação como `FACT`, `ASSUMPTION`, `DECISION` ou `OPEN QUESTION`; manter o produto focado no fluxo diagnóstico; priorizar segurança clínica, simplicidade operacional e rastreabilidade; não adicionar microserviços ou tecnologias sem necessidade demonstrada.

## Quality Bar Control

- Current version: v1
- Frozen before implementation: yes — documentation-only scope; baseline captured before edits.
- Revision log: v1 completed after Round 03 final review.

## Quality Bar

| ID | Dimension | Criterion | Target | Evidence method | Required | Priority | Baseline | Validity notes | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| DOC-1 | Reconnaissance | O estado inicial do repositório e seus limites devem estar registrados | Fact explícito de repositório vazio, sem arquitetura existente | `git status`, `ls -la`, `docs/discovery/DISCOVERY.md` | yes | critical | Diretório vazio; sem `.git` | Evidência local; sem histórico para inspecionar | PASS |
| DOC-2 | Discovery | Problema, stakeholders, personas, jobs, jornadas, blueprint e Event Storming devem estar documentados | Todos os artefatos Discovery obrigatórios presentes e cross-referenciados | `bash scripts/validate-docs.sh` + inspeção dos arquivos | yes | critical | Nenhum documento | Testa presença e âncoras, não substitui julgamento operacional | PASS |
| DOC-3 | Epistemologia | Fatos, hipóteses, decisões e perguntas abertas não podem ser misturados | Cada registro relevante classificado; perguntas clínicas/operacionais não resolvidas permanecem visíveis | Inspeção dos registros e banners de status downstream | yes | high | Ausente | Não prova validade das premissas no hospital | PASS |
| DOC-4 | PRD/MVP | O PRD deve definir outcome, non-goals, MoSCoW, requisitos versionados, histórias e acceptance criteria | Todo requisito MVP possui ID, prioridade e critério Given/When/Then; MVP executável em vertical slices | `rg` por IDs e leitura do PRD/traceability | yes | critical | Nenhum PRD | Critérios são proposta para validação humana | PASS |
| DOC-5 | Domain correctness | Domínio, invariantes e estados devem explicar os fluxos Lab/RX/US, recoleta, cancelamento, crítico e correção | Transições válidas, atores, precondições, efeitos e terminais documentados sem estado impossível conhecido | Inspeção de `DOMAIN_MODEL.md` e `STATE_MACHINES.md` + Critic | yes | critical | Ausente | Segurança clínica ainda depende de validação do responsável | PASS |
| DOC-6 | Data/API integrity | Persistência e API devem manter auditoria, versionamento de resultado, idempotência, concorrência e erros | Modelo com constraints/timestamps/indexes e endpoints de comando alinhados ao domínio | Inspeção de `DATA_MODEL.md`, `API_SPEC.md`, `ERROR_MODEL.md` | yes | critical | Ausente | Não é contrato OpenAPI executável ainda | PASS |
| DOC-7 | Access/security | A autorização deve ser por ator, ação e escopo; ameaças, uploads e LGPD devem estar tratados | Matriz de permissões e threat model cobrem todos os comandos clínicos e recursos sensíveis | Inspeção de `PERMISSIONS.md`, `SECURITY.md`, `THREAT_MODEL.md` + Critic | yes | critical | Ausente | Sem implementação não há teste de exploração real | PASS documental |
| DOC-8 | Architecture/UX | Arquitetura simples e extensível e UX operacional devem estar especificadas | Modular monolith, contratos de módulo, fluxos, telas e estados assíncronos são explícitos | Inspeção dos docs de arquitetura/UX e ADRs | yes | high | Ausente | Qualidade visual só será verificável após BUILD | PASS |
| DOC-9 | Operations/testing | Plano de testes, backup/restore, observabilidade, readiness e release checklist devem ser acionáveis | Cada requisito crítico mapeia para validação; RPO/RTO propostos e restore testável; gates de release definidos | Inspeção de docs + validador | yes | high | Ausente | Alvos operacionais são propostas, marcadas para validação | PASS documental |
| DOC-10 | Traceability | Problem → requirement → acceptance → spec → build task → test deve ser navegável | Toda FR/NFR/AC crítica tem linha de rastreabilidade e nenhuma referência órfã conhecida | `bash scripts/validate-docs.sh` + cobertura por IDs | yes | critical | Ausente | A matriz não prova implementação; prova preparação para BUILD | PASS |
| DOC-11 | Consistency | Termos, enums, endpoints, eventos e decisões devem permanecer consistentes entre documentos | Validador sem falhas e revisão cruzada sem divergência material aberta | `bash scripts/validate-docs.sh` + revisão independente | yes | critical | Ausente | Revisão final independente aprovou após o mapeamento endpoint–permissão | PASS |
| DOC-12 | Scope discipline | A entrega não deve conter código de produto nem complexidade ornamental | Nenhuma implementação de aplicação; Build Plan é o próximo passo documentado | `rg --files`, inspeção de árvore e `DISCOVERY.md` | yes | high | Repositório vazio | Scripts de validação não são produto | PASS |

## Gauntlet Score

| Dimension | Status | Actual evidence | Target | Confidence | Trend |
| --- | --- | --- | --- | --- | --- |
| Repository reconnaissance | PASS | `ls -la` mostrou apenas `.` e `..`; não há `.git` nem arquivos de produto | DOC-1 | high | baseline |
| Documentation completeness | PASS | 56 arquivos obrigatórios; PRD com 42 requisitos e 42 AC; validador verde | DOC-2, DOC-4, DOC-8, DOC-9 | high | better |
| Domain correctness | PASS documental | `RESULTS_AVAILABLE`, completion policy/API, cancelamento faseado, void/reopen/replacement e coerência Lab/RX/US revisados; Critic final aprovou | DOC-5, DOC-6 | high | better |
| Security and operations | PASS documental | matriz granular, threat model e alert/runbook ownership; sem runtime evidence por escopo | DOC-7, DOC-9 | medium | better |
| Traceability and consistency | PASS | 42/42 requisitos, 42/42 ACs, 28/28 tarefas e 17 operações API cobertos; permissões canônicas conferidas; Critic final aprovou | DOC-10, DOC-11 | high | better |

## Workstreams

| Workstream | Bar IDs | Owner/boundary | Order | Status |
| --- | --- | --- | --- | --- |
| Reconnaissance and quality bar | DOC-1, DOC-12 | Lead; `.gauntlet/`, initial report | completed | completed |
| Discovery and Event Storming | DOC-2, DOC-3 | Lead; `docs/discovery/**` | sequential first | completed |
| PRD and MVP | DOC-4 | Lead; `docs/prd/**` | after Discovery | completed |
| Technical specification | DOC-5, DOC-6, DOC-7 | Lead; `docs/spec/**`, `docs/api/**`, `docs/security/**` | after PRD | completed; retested |
| Architecture and UX | DOC-8 | Lead; `docs/architecture/**`, `docs/ux/**`, `docs/adr/**` | after core SPEC | completed |
| Testing and operations | DOC-9 | Lead; `docs/testing/**`, `docs/operations/**` | after SPEC | completed |
| Build plan and traceability | DOC-10 | Lead; `docs/build/**`, `docs/TRACEABILITY_MATRIX.md` | final planning phase | completed; retested |
| Integration review | DOC-11 | Fresh reviewer / Lead integration | after all docs | completed |

## Rounds

### Round 00 — Reconnaissance

Gap:
The repository is empty and has no application architecture, package manager, tests, CI, Docker, migration history, or existing documentation.

Evidence:
`pwd` → an empty temporary workspace; `ls -la` → only `.` and `..`; `git status` and `git log` → not a Git repository; `rg --files` for manifests/docs → no matches.

Root cause:
FACT: this is a new documentation-first project, not an existing codebase to extend.

Change:
Freeze a documentation-only quality bar and record the absence of architecture as a fact. Do not install dependencies or create product code.

Retest:
Pending creation of the documentation tree and validator.

Critic:
Not yet commissioned; reconnaissance is direct evidence from the filesystem.

Next largest gap:
Create Discovery and Event Storming while keeping supplied operational descriptions separate from validated facts.

### Round 01 — Documentation wave and first independent critique

Gap:
The first complete document wave had an incomplete aggregate-state contract: requests with all results released/reviewed had no explicit aggregate outcome; completion had no explicit API/policy; phase-specific cancellation was incomplete. The critic also found coarse permissions, non-canonical backlog dependencies, test/backlog mismatch and stale status/classification markers.

Evidence:
`bash scripts/validate-docs.sh` passed with 55 required files, but independent Critic decision was `REJECT` with high-confidence critical findings in `SYSTEM_SPEC.md`, `STATE_MACHINES.md`, `API_SPEC.md`, `PERMISSIONS.md` and `BACKLOG.md`.

Root cause:
The documentation wave was assembled around the happy path before independently checking every aggregate outcome and command against the API/action matrix.

Change:
Add aggregate `RESULTS_AVAILABLE`, explicit completion policy plus `/diagnostic-items/{id}/complete`, phase-safe cancel/void rules, granular draft/void/upload/download permissions, canonical `BLD-*` dependencies/tests, alert ownership/runbook mapping, downstream knowledge-status banners and explicit final Discovery review.

Retest:
`bash scripts/validate-docs.sh` → PASS; PRD requirement/AC coverage → 42/42; local-link check → PASS; negative harness test removing `docs/prd/PRD.md` → correctly rejected.

Critic:
Fresh Critic round commissioned after the fix; result pending.

Next largest gap:
Obtain final independent decision and ensure no material state/API/traceability gap remains.

### Round 02 — State and integration repair

Gap:
Close the Round 01 critical state/API and consistency findings.

Evidence:
`SYSTEM_SPEC.md` now defines `RESULTS_AVAILABLE` and all request aggregate cases; `STATE_MACHINES.md` covers scheduled/recollection/failed/awaiting-report cancellation and automatic/manual completion; `API_SPEC.md` exposes item cancel/complete; `PERMISSIONS.md` covers draft/void/upload/finalize/download; backlog dependencies use `BLD-*` IDs.

Root cause:
Missing cross-document contract, not an application runtime defect.

Change:
Applied the coherent documentation repair and added a final reviewer request.

Retest:
`bash scripts/validate-docs.sh` → PASS (56 files); no orphan requirements or AC; no forbidden placeholders; link resolver PASS; 42 PRD requirements and 42 ACs are represented.

Critic:
Pending final independent Critic.

Next largest gap:
Final critique and completion audit.

### Round 03 — Final authorization and consistency gate

Gap:
The first final critique found that API resources had permissions in aggregate but individual endpoint actions did not have an explicit permission mapping.

Evidence:
The critique was `REJECT` with high confidence. Local audit also showed the need for a canonical permission catalog rather than relying only on action labels.

Root cause:
The API contract and the RBAC action matrix used different levels of granularity.

Change:
Added 46 canonical permission identifiers to `docs/spec/PERMISSIONS.md`, an exhaustive 54-row endpoint authorization contract to `docs/api/API_SPEC.md`, and a `Permission(s)` column to all 17 API operation traceability rows. The map covers query, command, attachment, notification, configuration, health and realtime routes.

Retest:
`bash scripts/validate-docs.sh` → PASS; local permission audit → 54 endpoint rows, 48 referenced permission IDs, 0 undefined IDs, 17/17 API trace rows with permissions; 42/42 requirements, 42/42 ACs and 28/28 backlog tasks remain covered; negative validator harness still rejects a required-file removal.

Critic:
Fresh independent final reviewer using a compatible model returned `APPROVE` and found no remaining gaps.

Next largest gap:
Human validation of hospital policy and implementation evidence, which is outside this documentation-only goal and explicitly tracked as an input to BUILD.

## Open Gaps

- Operational workflows, role boundaries, SLA clocks, critical-value policy and retention rules still require validation with the hospital stakeholders; they are explicitly tracked in `docs/discovery/OPEN_QUESTIONS.md`.
- There is no executable application, so runtime/API/security/performance evidence cannot yet be claimed. The current goal is documentation readiness, not production readiness.
- Independent reviews rejected concrete gaps in earlier rounds; all findings were fixed and the final independent review approved the current documentation set.

## Stop Decision

- State: STOP
- Reason: All required documentation quality-bar criteria pass, the final independent reviewer approved the repaired contract, and no required work remains within the documentation-only goal.
- Last integrated verification: `bash scripts/validate-docs.sh`; canonical permission/endpoint audit; 42/42 requirement and AC coverage; 28/28 backlog coverage; local-link and negative-harness checks; final independent `APPROVE`.
- Next largest gap: Resolve the human validation questions in `docs/discovery/OPEN_QUESTIONS.md` before BUILD and obtain runtime evidence; these are explicit next-phase gates, not unfinished documentation work.

## Build Extension — 2026-08-19

### Goal

Implement the documented CVG Diagnostics Hub as a runnable, testable modular monolith, covering the planned M0–M8 slices and preserving the documented safety boundary: synthetic/local data only, configurable clinical policies, no invented critical-result thresholds, no production deployment, and no claim of hospital approval.

### Quality Bar v2 — frozen before implementation

| ID | Dimension | Criterion | Target | Evidence method | Required | Priority | Baseline |
| --- | --- | --- | --- | --- | --- | --- | --- |
| BUILD-1 | Runtime | The real artifact starts from a clean checkout with documented configuration | `npm ci` + `npm run build` + `npm run start` serve the web/API | yes | critical | no application |
| BUILD-2 | Foundation/API | Versioned API, safe envelope/errors, correlation and health are executable | `/api/v1/livez`, `/api/v1/readyz`, validation, `X-Correlation-Id`, stable error envelope pass contract tests | yes | critical | no endpoints |
| BUILD-3 | Data integrity | PostgreSQL schema/migrations encode core relationships, audit, idempotency and outbox | disposable PostgreSQL migration/seed/rollback smoke passes; no in-memory-only clinical path | yes | critical | no DB |
| BUILD-4 | Domain | Request/item state machines, aggregate status, samples, imaging and result version rules are enforced | unit + API integration tests cover valid/invalid/terminal/concurrent transitions | yes | critical | no domain |
| BUILD-5 | Access | Session, CSRF, RBAC and resource/department scope are server-side and deny by default | auth/security tests cover expiry/revocation, wrong role/scope, guessed IDs and safe errors | yes | critical | no auth |
| BUILD-6 | Core journeys | Lab normal/recollection, RX, US schedule, request/cancel and result release/view/review/amend/void work end-to-end | API + browser E2E with synthetic fixtures; reload preserves truth | yes | critical | no journeys |
| BUILD-7 | Communication/realtime | Durable notifications, critical acknowledgement gate, SSE invalidation/reconnect and fallback are real | integration/network tests prove no false clinical success, dedupe and resync behavior | yes | high | no notification |
| BUILD-8 | Operations | scoped search, queues/SLA, event-derived timeline, dashboard, observability and safe attachment flow work | API/integration/UI checks, parameterized queries, quarantine/private download and metrics/correlation evidence | yes | high | no operations |
| BUILD-9 | UX/accessibility | Operational screens expose next action and loading/empty/error/partial/offline/permission states | Playwright at desktop/tablet/mobile plus keyboard/axe/manual inspection; no color-only status | yes | high | no UI |
| BUILD-10 | Quality/security | Tests are first-class and business-code coverage is at least 80% | unit/integration/API/E2E/security suites pass; `npm run test:coverage` meets threshold; audit/secret scans clean | yes | critical | no tests |
| BUILD-11 | Ops/recovery | Dev/test environment, synthetic seed, backup/restore and release/runbook evidence are executable or clearly gated | compose/migration/backup/restore smoke scripts and readiness docs; OQ gates remain explicit | yes | high | no ops |
| BUILD-12 | Traceability | Implemented slices map back to requirements/tasks and docs state the actual build status | traceability/backlog/status updates and final requirement audit | yes | high | all tasks planned |

### Build workstreams and ownership

- Foundation/contracts: root config, `apps/web`, `apps/api`/API routes, `packages/contracts`, `packages/config`, migrations and scripts.
- Domain/application: `src/server` modules for identity, registry, catalog, diagnostics, lab, imaging, results, notifications, audit and operations.
- Web/UX: `src/app`, `src/components`, `src/styles`, Playwright flows.
- Verification/operations: tests, fixtures, compose, backup/restore and security checks.

Shared contracts are integrated by the Lead sequentially. No implementation claim is accepted from a Builder without raw test/runtime evidence; independent review is required before the final verdict.

### Baseline

- `bash scripts/validate-docs.sh` → PASS (56 documentation files).
- `node v22.22.2`, `npm 10.9.7`, `pnpm 10.33.0`, `bun 1.3.14`, Docker 29.7.2 available.
- No `package.json`, source, migration, test, CI or running artifact exists.
- No `.git` metadata exists; pre-existing documentation and `.gauntlet` history are preserved.

### Round 00B — Build baseline and frozen bar

Gap:
The prior documentation goal is complete, but every implementation task and all runtime evidence are absent.

Evidence:
`rg --files -g '!docs/**'` shows only `README.md`, `QUESTIONS.md` and `scripts/validate-docs.sh`; `README.md` and `DISCOVERY.md` explicitly say phase documental/no application.

Root cause:
The repository was intentionally stopped after documentation readiness.

Change:
Start the authorized BUILD extension with Quality Bar v2 above; keep clinical/identity/retention gates configurable and visible.

Retest:
Pending first failing tests and runtime bootstrap.

Critic:
Independent planning review commissioned; implementation critic required after first artifact wave.

Next largest gap:
Create the first failing tests and foundation workspace without hiding domain requirements behind a fake demo.

### Round 01 — Foundation and first runnable vertical slices — 2026-08-19

Gap:
The frozen documentation bar had no executable artifact, persistence boundary, API or user-facing workflow.

Evidence:
The repository now contains a Next.js 16/React/TypeScript modular monolith, shared contracts, versioned API envelope, opaque sessions, CSRF, RBAC/scope, synthetic fixtures, PostgreSQL migration/seed/smoke scripts and responsive operational screens. Typecheck, lint and production build passed.

Root cause:
The missing implementation was expected after the documentation-only phase; no prior runtime contract could be reused.

Change:
Built the foundation through vertical slices: request context and multi-item request, Lab sample/recollection, RX/US procedures, versioned results, local attachment lifecycle, notifications, queues/search/timeline/dashboard and browser shell.

Retest:
Unit/API and integration tests passed; PostgreSQL migration, synthetic seed and persistence smoke passed. The local runtime is explicitly synthetic and not hospital-approved.

Critic:
Initial read-only evidence review completed. A compatible independent reviewer was commissioned for the final implementation audit; one reviewer profile was unavailable in the harness.

Next largest gap:
Security-scope proof, operational hardening and cross-viewport browser verification.

### Round 02 — Integrity, files, persistence and catalog hardening — 2026-08-19

Gap:
The first artifact wave needed stronger upload integrity, durable database evidence, versioned catalog mutations and a complete command idempotency boundary.

Evidence:
Checksum and byte-size verification now happen before storage; MIME signature and quarantine rules are enforced; private responses redact `storageKey`; Postgres transactions project audit/outbox records; service/reason-code administration is permissioned, versioned and audited; mandatory idempotency keys are enforced for release/amend/void/recollection/cancel/review/complete/finalize.

Change:
Added optimistic-version checks, draft editing, catalog create/update commands, catalog API schemas, attachment expiry/checksum tests and PostgreSQL smoke coverage. The runtime refuses critical-result activation while the clinical policy flag is disabled.

Retest:
`npm test -- --run` → 46 tests passed; `npm run test:coverage` → 95.49% lines/statements, 93.98% functions, 80.18% branches; `npm audit --audit-level=high` → 0 vulnerabilities; PostgreSQL migration/seed/smoke → PASS.

Critic:
Local security review identified service-to-service request item overexposure in public command/read responses; it was fixed in the next round with a regression test.

Next largest gap:
Cross-department response filtering and end-to-end evidence across the three viewport projects.

### Round 03 — Scope isolation and browser verification — 2026-08-19

Gap:
Executor reads and command responses could expose unrelated department item IDs; the first Playwright matrix also exposed a host-browser tablet launch issue, duplicate fixture collisions and a hidden mobile protocol.

Change:
Added department-aware patient/request/item/result views, filtered command responses, service-scoped search/timeline/dashboard visibility, and a regression proving Lab cannot receive Radiology item IDs. Playwright tablet uses a stable emulated viewport with the host Chrome; each project uses an isolated request scenario; mobile keeps the protocol visible.

Retest:
Playwright desktop/tablet/mobile → 9/9 passed. API replay tests cover bounded SSE `Last-Event-ID`, `retry: 5000` and `resync_required`. `/readyz` now verifies the configured runtime store instead of returning readiness unconditionally.

Critic:
The available reviewer profile that required `gpt-5.3-codex` was rejected by the account harness; a compatible default reviewer remained pending at the time of this state write.

Next largest gap:
Final independent review and documentation/status synchronization.

### Round 04 — Final verification and bounded stop — 2026-08-20

Gap:
Implementation evidence and the normative documentation still diverged on what was local, partial, gated or pending; the gauntlet progress file also described the pre-build repository.

Change:
Synchronized README, Build Plan, backlog, traceability, API/System/Test/Operations status and this state file. The status is conservative: local workflows are complete within the synthetic MVP boundary; production object storage/AV, durable notification worker/escalation, transfer/alta policy, critical-result policy, performance, accessibility, restore drill, CI and pilot approval remain explicit gates.

Retest:
Current evidence is tracked in the final handoff: 47 Vitest tests, coverage above the 80% threshold, typecheck/lint/build, compiled `next start` plus `/livez` smoke, PostgreSQL migration/seed/smoke, 9/9 Playwright flows, docs validator and high-severity npm audit. No Git history exists in this workspace, so no commit/PR evidence can be claimed.

Critic:
The final implementation audit was attempted with the available compatible default reviewer; the unsupported reviewer profile is recorded above. Remaining gaps are policy/operations or deliberately bounded production integrations, not hidden clinical assumptions.

Stop decision:
Complete the local implementation goal at the documented safety boundary. Do not call the artifact production-ready; the remaining gates require hospital/TI decisions or external infrastructure and cannot be safely invented in code.

## Build Extension v3 — 2026-08-20 — 95/100 hardening

### Goal

Elevar cada dimensão do build local para uma barra alvo de 95/100, criar roadmap/backlog executáveis, implementar as melhorias técnicas seguras e deixar explícitos os gates que dependem de decisão clínica, TI ou aceite hospitalar.

### Frozen bar

The canonical scorecard is [`docs/build/QUALITY_SCORECARD_95.md`](../docs/build/QUALITY_SCORECARD_95.md). The 12 dimensions remain BUILD-1 through BUILD-12. Baseline scores are evidence-backed local estimates; target is >=95 for every dimension. `BLOCKED EXTERNAL` is not silently converted into a code pass.

### Round 05 — Plan and baseline

Gap:
The previous local MVP had explicit production gaps but no execution contract aimed at 95/100, no incremental backlog for those gaps and no separated roadmap for technical versus external gates.

Change:
Added the 95/100 scorecard, roadmap and executable backlog; linked them from the documentation map and Build Plan; started a new gauntlet round without deleting the previous implementation history.

Retest:
`bash scripts/validate-docs.sh` → PASS; baseline `npm test -- --run` → 47 tests passed; previous coverage/typecheck/lint/build/Postgres/E2E/audit evidence remains valid as the starting point.

Next largest gap:
Implement W1 foundation changes first, then close durable event, observability/storage/recovery, performance and accessibility evidence in the order defined by `docs/build/ROADMAP_95.md`.

### Round 06 — Independent critique closure and final retest — 2026-08-20

Independent critique:
The read-only explorer found no critical vulnerability or false production-ready claim. It identified four high-priority technical gaps: active SSE connections were not reflected in metrics, outbox oldest-age/readiness-failure gauges were not refreshed, readiness checked only basic connectivity, and failure/degradation coverage was thin. It also reaffirmed that accessibility, proxy trust, hospital identity, critical-result policy, AV/object storage, RPO/RTO and pilot evidence remain conditional or external.

Changes:
- `src/server/observability/metrics.ts` now refreshes bounded outbox depth/age, tracks readiness failures and active SSE connections without event identifiers.
- `src/app/api/v1/[...path]/route.ts` keeps SSE open by default with heartbeat, counts connections cleanup-safely, supports an optional `REALTIME_STREAM_MAX_MS` cap, and reports readiness failures.
- `MemoryStore`, `PostgresStore` and `LocalFileStore` readiness checks now validate state shape, applied runtime schema and local writability; PostgreSQL `/readyz` was exercised against the live disposable development database.
- Added regression tests for readiness failure, active SSE disconnect cleanup, metric refresh/privacy and operational gauge behavior; updated realtime/observability contracts and `.env.example`.

Final retest:
`npm run validate` → 62 tests, 95.71% lines, 81.12% branches; `npm test -- --run` → 62/62; `npm run build` → PASS; Playwright desktop/tablet/mobile → 15/15 with selected axe rules; memory and PostgreSQL `/readyz` → 200; perf smoke → 100/100 successful reads, p95 54.7 ms; PostgreSQL migration/smoke → PASS; disposable backup/restore → PASS (`1|12|6`); OpenAPI (40 paths), documentation validator (56 files), secret scan and `npm audit --audit-level=high` → PASS.

Decision:
Local technical gates are complete at the synthetic-MVP boundary and score >=95 in all 12 dimensions. Release remains `NOT READY` for hospital use until external evidence closes the conditional/blocked rows; no clinical threshold, SLA, fallback, ownership or retention policy was invented.

### Round 07 — Workflow closure and artifact verification — 2026-08-20

Gap:
The previous hardening round had green infrastructure evidence but the normative UX still lacked explicit patient/encounter context, server-confirmed workflow actions, result/patient/indicator/admin surfaces and resilient partial-resource handling. Status documents also retained older test/path/performance counts.

Change:
Implemented scoped patient diagnostics and encounter reads; replaced the request-dialog patient/encounter shortcut with server-loaded context; added workflow actions to queue/request detail; added result review/view/report attachment context; added patient, indicator and administration surfaces with versioned catalog/reason editing and explicit external-policy banner; added safe permission-denied UI; hardened browser error rendering; added bounded strict command schemas and streamed request-body limits; added OpenAPI/API/docs/CI coverage and fresh E2E/accessibility cases.

Retest:
`npm run validate` → PASS (93 tests; 94.39% statements; 80.3% branches); `npm run build` → PASS; production `next start` → ready on `localhost:3000`; `npm run test:e2e` → 21/21 across desktop/tablet/mobile; `npm run test:accessibility` → 6/6; PostgreSQL persistence/audit/outbox smoke → PASS; disposable restore → PASS (`1|18|9`); perf smoke → 100/100, 0 errors, p95 134.54 ms against 500 ms; outbox one-shot → PASS; OpenAPI → 44 paths; docs → 56 files; secret scan, high-severity npm audit and diff check → PASS.

Critic:
A fresh compatible default read-only reviewer was commissioned after the specialized reviewer profile was unavailable in this harness, but it did not return within the finalization window and was shut down. A fresh local read-only audit covered the changed API/UI/security paths; no external clinical policy or production approval is inferred from local evidence.

Decision:
The local technical bar is complete at the synthetic/local boundary. The release remains `NOT READY` for hospital use until identity/ownership, transfer/alta, critical-result policy/fallback, production AV/object storage/credentials, retention/RPO/RTO, representative workload, manual clinical/accessibility acceptance, remote CI and pilot sign-off are evidenced by the responsible external owners.

### Round 08 — Contract slices and representative local workload — 2026-08-20

Gap:
The Round 07 implementation still needed explicit operational indicator definitions, validated filters and cursors across query surfaces, a local user/role administration boundary, and performance evidence beyond the catalog endpoint.

Change:
Implemented the dashboard indicator contract with one `asOf` snapshot and explicit denominators/definitions/actions; corrected the new-result state to `RESULT_AVAILABLE` only; added request filters, typed scoped search, search/timeline/request pagination metadata; added ADMIN-only versioned/audited user-role listing and updates with no credential material in responses; updated the Admin UI, OpenAPI, API specification, traceability and readiness evidence; expanded performance smoke to four read workloads.

Retest:
102 Vitest tests passed; coverage is 94.69% statements and 80.23% branches; typecheck, lint, build, docs/OpenAPI validation, secret scan and high-severity audit passed; PostgreSQL smoke and disposable restore passed (`1|20|10`); perf smoke passed with 400 requests, 0 errors and maximum route p95 346.03 ms against 500 ms; clean Playwright-managed E2E passed 21/21 and accessibility 6/6.

Critic:
The specialized reviewer profile was rejected by the harness because its fixed model is unsupported. A compatible default read-only reviewer was commissioned for a final independent audit; no final commit decision is recorded until that result is integrated.

Decision:
Local evidence is green at the synthetic boundary. External gates remain explicit: hospital identity/ownership and delegated-manager scope, transfer/alta, critical-result thresholds/fallback, production AV/object storage/credentials, approved retention/RPO/RTO, representative hospital workload, manual accessibility/clinical acceptance, remote CI and pilot sign-off.

### Round 10 — LAN development access hardening and final retest — 2026-08-20

Gap:
The local app rendered on `localhost`, but opening it through the machine's LAN address stayed on the loading screen. Next 16 rejected development assets from the LAN origin, and plain HTTP on the LAN did not expose `crypto.randomUUID`, which prevented login/request client actions before the API call.

Change:
Allowlisted only the current local demo host in `allowedDevOrigins`; added a `crypto.getRandomValues`/time fallback for client-generated idempotency and correlation IDs; and added regression tests covering LAN-compatible login/request submission.

Retest:
`npm run test:coverage` → 109/109, 95.35% statements and 81.05% branches; typecheck/lint/build → PASS; isolated LAN Playwright E2E → 24/24, including accessibility 6/6 and the request-detail layout regression; OpenAPI → 47 paths; docs → 56 files; secret scan, high-severity audit and diff check → PASS.

Decision:
The local LAN demo is usable at the current host address. Keep synthetic data and `NOT READY` for hospital use.

### Round 09 — Authorization hardening, stable pagination and final retest — 2026-08-20

Gap:
The Round 08 audit identified server-side authorization gaps for sample receipt, manager scoping, ADMIN clinical bypasses, mixed timeline contexts, notification acknowledgement, SSE revocation and sensitive role changes. It also identified offset cursors and incomplete query/OpenAPI descriptions.

Change:
Closed those local gaps with server-side department/resource checks, technical-only ADMIN permissions, manager-scoped patient/request/item/search/queue/dashboard/audit reads, matching timeline contexts, permissioned notification acknowledgement, keyset cursors, SSE authorization snapshots, password re-authentication plus expected-version/reason/confirmation controls for role changes, and aligned route schemas/OpenAPI/docs. Added a positive approved-policy test so the critical-policy guard remains executable without inventing clinical thresholds.

Retest:
`npm run test:coverage` → 107/107, 95.4% statements and 81.01% branches; typecheck/lint/build → PASS; OpenAPI → 47 paths; docs → 56 files; PostgreSQL smoke → PASS; restore smoke → PASS (`1|26|13`); production `next start` perf smoke → 400 requests, 0 errors, max p95 434.69 ms against 500 ms; Playwright E2E → 21/21; accessibility → 6/6; secret scan, high-severity audit and diff check → PASS.

Critic:
The compatible read-only audit returned `REJECT` with five concrete local findings: session-revoked SSE streams stayed open; a manager could complete an item outside the manager's department; notification acknowledgement lacked idempotency/version/reason/confirmation controls; timeline omitted derived Sample/ResultVersion/Procedure/Attachment events; and the OpenAPI envelope/header contract diverged from runtime. Each finding was fixed and locked by targeted regression tests and fresh gates. The specialized reviewer profile and a second post-fix explorer were unavailable in this account, so no unsupported independent approval is claimed. External gates remain blocked/conditional and are not represented as local implementation failures.

Decision:
Local technical gates are green at the synthetic/local boundary. The release remains `NOT READY` for hospital use until identity/ownership, delegated-manager policy, transfer/alta, approved critical-result fallback, production AV/object storage/credentials, retention/RPO/RTO, representative workload, manual acceptance, remote CI and pilot sign-off are evidenced by responsible owners.

## Round 11 — Management control center and delegated access — 2026-08-20

### Goal

Implement the management experience requested by the hospital operations user: delegated collaborator access administration, fully editable diagnostic catalog and auditable reason codes, and an operational control center with requests, pending work, SLA/priority/department indicators and audit visibility. Preserve the synthetic/local boundary and never hard-delete clinical or audit references.

### Quality Bar v3 — frozen before implementation

| ID | Dimension | Criterion | Target | Evidence method | Required | Priority | Baseline | Validity notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| MGMT-1 | Collaborator access | Authorized managers/admins can create, edit, deactivate and inspect collaborators without credential leakage | Create, role/department update, soft deactivation, session revocation, optimistic version and audit all work | Service/API tests + browser flow + reload | yes | critical | Manager sees 0 users; no create/deactivate path | Hospital identity provisioning remains an external gate |
| MGMT-2 | Authorization scope | Delegated management is scoped by role and permitted departments | Manager can manage operational collaborators only inside declared departments; cannot self-edit or elevate to technical/admin roles; technical admin remains non-clinical | Negative/positive authorization tests + route tests | yes | critical | Manager role administration absent | Fixture scope is a local demonstration of delegated policy |
| MGMT-3 | Catalog customization | Service catalog supports safe create and structural/versioned edit | Code remains stable as an identifier; editable name, department, workflow, requirements, result schema, attachment and SLA; in-use structural changes are rejected; deactivate is retained | Application/API tests + UI form + reload | yes | critical | Only name/active/attachment/SLA editable | Clinical policy approval is not invented |
| MGMT-4 | Auditable reasons | Reason codes support create, label edit and safe deactivation | Type/code remain stable after creation; label/active are versioned and audited | Application/API tests + UI form | yes | high | Only existing reason rows editable | Hard delete is intentionally excluded |
| MGMT-5 | Operational control | Management home exposes actionable operational truth | Single management snapshot includes active, overdue, critical, recollection, review, department and pending request views with links to next action | API contract tests + browser screenshot/interaction | yes | critical | Manager dashboard showed clinical scope empty | Counts are synthetic and not hospital KPI approval |
| MGMT-6 | Navigation/UX | Manager navbar matches operational responsibilities | Controle, solicitações, pendências, estatísticas, acessos, catálogos and auditoria are discoverable; loading/empty/error/partial states and keyboard semantics work | Component tests + Playwright at 3 viewports + axe | yes | high | Manager had only generic clinical/admin links | Visual review is local; manual acceptance remains required |
| MGMT-7 | Security/data integrity | Mutations remain protected and auditable | CSRF, authentication, input schema validation, reauth for access changes, idempotency, version guards, no plaintext password/hash response, append-only audit | Security/API tests + secret scan + diff audit | yes | critical | Existing controls for previous admin role update | FHIR AuditEvent guidance informs append-only audit design |
| MGMT-8 | Regression quality | Existing clinical flows remain green | Unit/API coverage >=80% and all prior E2E/accessibility/build/lint/type/docs gates remain green | Full verification suite and fresh artifact inspection | yes | critical | 109 unit tests, 24 E2E, 6 accessibility | No threshold lowering |

### Frozen decisions

- The fixture manager receives `managedDepartmentCodes` for `LABORATORY`, `RADIOLOGY` and `ULTRASOUND`; managers without that explicit list remain restricted to their own department.
- “Excluir usuário” means soft deactivation, revocation of every active session and an append-only audit record. Historical references are retained.
- Manager-created collaborators may use operational roles only; `ADMIN` and `MANAGER` elevation remains technical/owner-controlled.
- The control center is an operational projection over the existing diagnostic state, not a replacement for hospital identity, transfer/alta, critical-result or retention policy.

### Research basis

The design uses official FHIR AuditEvent guidance for security/configuration audit records and preservation of audit integrity, and operational EHR patterns for role-based audit trails, customizable worklists and real-time actionable dashboards. Sources: https://hl7.org/fhir/R4/auditevent.html, https://blog.meditech.com/how-meditechs-approach-to-cybersecurity-ensures-safety-for-patients-providers-and-organizations, https://ehr.meditech.com/ehr-solutions/expanse-pathology.

### Baseline before Round 11

`git status --short --branch` was clean on `main` tracking `origin/main`; last commit was `13016ec`. Existing local evidence was 109 unit tests, 95.35% statements, 81.05% branches, 24 E2E flows, 6 accessibility flows, typecheck/lint/build/docs/OpenAPI/security/audit green. Current management defect is visible in the supplied screenshot: manager catalog/users panels are empty or partially unavailable and the navigation has no management control center.

### Round 11 closure / fresh evidence — 2026-08-20

Implementation:
The management slice is complete at the synthetic/local boundary. Managers now receive explicit diagnostic department scope; the control center exposes a single server snapshot for control, requests, pending work and statistics; the manager navbar links to queues, requests, pending items, statistics, access, catalog and audit; and the administration console supports safe service/reason customization plus collaborator provisioning, versioned role changes and soft deactivation with active-session revocation. Technical roles remain unavailable to delegated managers, credentials never leave the server, and stable service/reason identifiers are protected.

Fresh retest:
`npm run test:coverage` → PASS, 119/119 tests, 94.97% statements and 80.74% branches; `npm run typecheck`, `npm run lint` and `npm run build` → PASS; full Playwright → 33/33 across Chromium/tablet/mobile, including the manager workflow and delegated manager scope configuration; accessibility → 6/6 axe/keyboard checks; `npm run validate:docs` → PASS, 56 files; `npm run validate:openapi` → PASS, 49 paths; `npm run security:scan` → PASS; `npm audit --audit-level=high --omit=dev` → 0 vulnerabilities; `git diff --check` → PASS. A fresh browser inspection found no page errors or non-SSE failed requests: the manager control center rendered the four-sector scope and the admin console rendered 4 managed collaborators, 4 services and 5 reason codes.

Critic:
Final Critic is a fresh local read-only audit of the changed management API, authorization, forms, navigation, docs and verification artifacts. It is explicitly non-independent because no callable independent reviewer/subagent was available in this harness; no external clinical or hospital approval is inferred.

Decision:
The local technical bar is complete for the requested management outcome. The release remains `NOT READY` for hospital use until external identity/ownership, delegated-manager policy approval, transfer/alta, critical-result thresholds/fallback, production AV/object storage/credentials, retention/RPO/RTO, representative workload, manual clinical/accessibility acceptance, remote CI and pilot sign-off are evidenced by responsible owners.

## Round 12 — Quality Bar v4 recovery and critical-gap closure — 2026-08-22

### Reopened premise

The prior local-complete verdict is superseded. Fresh standards validation found 51
OpenAPI errors, automated tests were confirmed to run without PostgreSQL, critical
browser mutations are substantially mocked, and an independent security audit
reproduced four HIGH local confidentiality/integrity defects.

### Frozen bar and control plane

Quality Bar v4 is frozen in `docs/build/PREMIUM_MVP_V4.md`. Its criteria are binary,
required and evidence-bound; no aggregate score can compensate for a failure. The
living ExecPlan, dependency graph and typed evidence are under `.agent/`.

### Current decision

Verdict is `REJECT` for the historical local-complete claim and `NOT READY` for release.
The next build slice is the RED-first closure of draft confidentiality, exact
author/service authorization, fail-closed bootstrap and canonical result lineage.
External hospital and production gates remain blocked and no policy value is invented.

## Round 13 — PostgreSQL-backed MVP closure and evidence reconciliation — 2026-08-23

### Goal and bar

Continue the Quality Bar v4 recovery through the locally authorized implementation
boundary, execute the real artifact with PostgreSQL, reconcile documentation and
leave a precise release decision. The bar remains binary for local evidence and
does not permit synthetic fixtures to close hospital or production gates.

### Implemented slice

- Added durable outbox claim ownership with token/lease verification so stale workers
  cannot complete or retry a message after another worker takes the lease.
- Added fail-closed production malware-scanner and distributed PostgreSQL rate-limit
  adapters, plus migrations for claim ownership, buckets and the explicit transitional
  snapshot boundary.
- Split the application service into cohesive request, workflow, result, attachment,
  management and read modules; no production source file exceeds the 800-line bar.
- Completed UI actions for recollection/reschedule and result draft/release/amend/void,
  audit/review and attachment upload with checksum/MIME/scan/finalization controls.
- Reconciled architecture, UX, data, realtime, traceability, readiness and discovery
  documents with the actual Next.js/PostgreSQL implementation.

### Fresh evidence

`npm run test:coverage` passed 254/254 tests across 40 files with 96.36% statements/
lines, 83.00% branches and 97.38% functions. Typecheck, lint, Next production build,
OpenAPI (62 operations/58 paths), docs (56 files), secret scan, high-severity audit and
`git diff --check` passed. The disposable PostgreSQL suite passed 16/16 tests in two
files. Full Playwright passed 33/33 across Chromium/tablet/mobile, including six
accessibility checks. A clean PostgreSQL-backed browser run passed 11/11 Chromium
scenarios in 59.9s, including the accessibility flow, manager workflows, contextual
request creation, patient context, responsive navigation and degraded-resource handling.

### Critique and limitations

The separated critics and targeted adversarial tests drove the security, contract,
outbox, storage and architecture fixes recorded above. This checkpoint does not claim
a fresh independent final approval for the entire changed tree. The browser set still
needs full real-backend result/attachment/critical-notification journeys; the clinical
JSONB snapshot is explicitly transitional and lacks relational migration/EXPLAIN proof.

### Decision

`CONDITIONAL PASS` for the locally verifiable synthetic MVP boundary. `NOT READY` for
hospital or production use. Open gates are hospital identity/ownership and transfer or
discharge policy, delegated-manager authority, critical-result fallback/escalation,
production object storage/AV/secrets, retention/residency/RPO/RTO, representative load,
manual clinical/accessibility acceptance, remote CI, pilot sign-off and independent
production configuration review.

## Round 14 — Final Quality Bar v4 verification and conditional gate — 2026-08-23

### Final local evidence

The source-generated contract was corrected to include the runtime notification states
`FAILED` and `SUPERSEDED`; the notification documentation and traceability counts were
then reconciled. The final deterministic control-plane checker passed all 11 checks with
zero failures, including state, backlog, execution log, verification ledger, authority,
gate history and lifecycle reconciliation.

Fresh artifact evidence is green: `npm run test:coverage` passed 265/265 tests across 41
files with 96.28% statements/lines, 83.63% branches and 97.04% functions; typecheck,
lint and Next production build passed; OpenAPI passed at 62 operations/58 paths; docs
validation passed 56 required files; secret scan, high-severity dependency audit and
`git diff --check` passed. The disposable PostgreSQL suite passed 16/16 tests, the full
synthetic browser matrix passed 39/39, and the final PostgreSQL-backed clinical smoke
passed 2/2 after the source correction. The final independent read-only critic found no
unresolved local HIGH finding; its MEDIUM enum/evidence-reconciliation findings were
closed and retested.

The historical Round 13 counts remain unchanged as historical evidence. Round 14 is the
current evidence boundary and supersedes those counts for the final decision.

### Decision

The persisted gate `.agent/gates/verified-v4-final.json` is
`PASS_WITH_CONDITIONS` for `Local synthetic MVP verification only`, with authority
explicitly confirmed for that scope and explicitly withheld for hospital and production
release. The local artifact is verified conditionally; `RELEASE_READY` remains blocked.

The remaining blockers are external and non-inferable: hospital identity, ownership,
transfer/alta and delegated-manager policy; critical-result recipients, thresholds,
fallback and escalation approval; production storage, malware scanning, secrets, TLS and
ingress; retention/residency, backup/restore, RPO/RTO and incident ownership; relational
clinical migration and representative EXPLAIN evidence; representative load, remote CI,
manual clinical/accessibility acceptance, pilot sign-off and production configuration
review. No real clinical data or deployment authority is implied by this gate.

## Round 15 — V2 official-repository recovery and first-wave bar — 2026-08-25

### Recovered premise

The official V2 URL is now configured as the local `origin` and the V1 repository is
preserved as `v1`. The official V2 remote was empty during discovery, while the local
checkout is a functional V1-derived Next.js application with historical V4 evidence.
V4 records remain historical; they do not prove the V2 master prompt is complete.

### Fresh critique

An independent read-only critic rejected the current artifact against the master V2
prompt. The major gaps are the absent connected Command Center/Patient Workspace/
modality workspaces, unstructured laboratory results and missing critical-result
fallback journey, contextual drawer, and physical `apps/web`/`apps/api` migration.
The critic also confirmed that Node 18 blocks the ordinary Vitest/build commands;
Node 22 is available for compatible local verification.

### Frozen V2 bar and plan

The first-wave binary bar is `docs/v2/QUALITY_BAR.md`, the migration DAG is in
`.agent/plans/cvg-diagnostic-hub-v2.md`, and the current/target map is in
`docs/v2/MIGRATION_MAP.md`. The first slice is operational context → server read
model/API → attention-first Command Center → Central de Exames drawer → tests.

### Decision

`BUILDING` toward a V2 conditional local checkpoint. No release, push, hospital use,
clinical policy approval or completion of the global V2 program is claimed.

## Round 16 — V2 first-wave implementation, independent critique and fixes — 2026-08-25

### Implementation

The first vertical slice was built across the real runtime: `packages/domain` derives
the operational context; contracts and OpenAPI expose owner/action/blocker/waiting/
expected-by/escalation; the server read model produces attention and sector
projections with existing RBAC; the feature-oriented Command Center and Central de
Exames consume those projections; and `packages/ui`, `packages/services` and
`packages/shared-state` are runtime-consumed boundaries. The queue drawer preserves
the queue, provides a deep link, keeps commands server-authorized and exposes
accessible context.

### Independent critique and remediation

The first fresh read-only critic found four local gaps: active `NONE` items were
mislabelled as attention; stale dashboard snapshots stayed visually fresh; the
drawer lacked focus trapping/restoration; and new scope/contract regressions were
under-specified. The coordinator fixed all four by filtering the server projection,
marking retained dashboard data `DEGRADED`, adding focus cycle/restoration, and adding
ordering, cross-department and AJV runtime tests. The critic also confirmed the
global gaps remain explicit rather than simulated: physical `apps/web`/`apps/api`,
structured Laboratory, full workspaces, critical fallback and production gates.

### Decision

`FIXED_AND_RETEST_REQUIRED`. The wave was not closed on the critic's first report;
the full retest and a second independent critique were required.

## Round 17 — V2 first-wave conditional checkpoint — 2026-08-25

### Fresh verification

- Full Vitest coverage: 283 tests across 48 files passed; 89.17% statements,
  83.93% branches and 96.4% functions.
- TypeScript, ESLint, Next production build, Redocly/OpenAPI drift (63 operations/
  58 paths), documentation validation, secret scan and `git diff --check` passed.
- Served Chromium artifact: 12/12 core-flow and accessibility tests passed,
  including the attention-first Command Center, real queue drawer, 390px viewport,
  focus cycle, Escape and focus restoration.
- Scope/contract evidence includes application and HTTP denial tests for foreign
  department queues and AJV validation of real dashboard and queue envelopes.

### Final independent critic

A fresh read-only critic reviewed the corrected tree and found no unresolved local
CRITICAL/HIGH issue. It confirmed the four earlier local findings were corrected and
classified the wave `PASS_WITH_CONDITIONS`; the critic itself did not run browser or
long regression commands, so those were run separately by the coordinator and are
recorded above.

### Remaining limitations

This checkpoint covers only the first operational wave. The repository is still a
root-hosted V1-derived Next application rather than the target physical monorepo.
Structured Laboratory panels/analytes/reference ranges/flags, dedicated Radiology
and Ultrasound workspaces, Patient Workspace, saved views/board/calendar, critical
result fallback policy, relational clinical migration, representative load, remote
CI, manual clinical acceptance, production configuration and pilot approval remain
open. Node 18 is below the documented baseline; verification used the available
Node 22 runner. No push was made to the official remote.

### Decision

`PASS_WITH_CONDITIONS` for V2 wave 1 local evidence only. `NOT_READY` for the global
V2 program, hospital use and production release.

## Round 18 — V2 structured Laboratory remediation and retest — 2026-08-25

### Critique and material finding

The independent read-only Laboratory audit initially returned `FAIL_TO_CLOSE`:
an active Hemogram could reach `RELEASED` with legacy `{}` content because draft
normalization was conditional on the discriminator and release did not revalidate.
The same audit identified that numeric services could be created without a panel
template and that the UI presented a legacy draft as an empty panel.

### Remediation

The release command now requires an active template-backed structured payload and
normalizes it again immediately before mutation. Legacy content remains available
only as a migration draft and is visibly marked incomplete; the queue removes its
immediate Laboratory release action. Catalog creation/update rejects numeric
services without an active versioned template, the CRP synthetic fixture is
narrative until its own panel exists, and the new catalog form defaults safely to
`NARRATIVE`. OpenAPI component references were wired so Redocly has no unused
Laboratory warnings.

### Fresh verification

- Full Vitest coverage: 292 tests across 49 files; 89.25% statements, 83.94%
  branches and 96.51% functions.
- TypeScript, whole-tree ESLint, Next 16 production build, source-generated
  OpenAPI and Redocly passed; current contract is 64 operations/59 paths.
- Documentation validator (56 files), secret scan and `git diff --check` passed.
- Clean Chromium: clinical lifecycle 3/3; core flows plus accessibility 12/12.
- The pre-remediation critic finding is recorded in the verification ledger;
  a fresh post-remediation critic is the remaining local audit input.

### Remaining limitations

Sample/accession linkage is not yet persisted on `ResultVersion`; clinical
thresholds, critical recipients/fallback/escalation, species/population policy,
relational migration, Patient Workspace, remote CI, representative load and
manual clinical acceptance remain open. These are not simulated as complete.

### Decision

`FIXED_AND_RETEST_REQUIRED` until the post-remediation read-only critic returns.
The V2 global program remains `NOT_READY`; no push or hospital/production release
authority is implied.

## Round 19 — V2 Laboratory conditional closure and Patient Workspace handoff — 2026-08-25

### Final audit integration

The final read-only critic confirmed that the P0 release bypass, the numeric
catalog guard and the legacy Laboratory UI release action were corrected. Its
additional claim that OpenAPI required `critical` was checked against the
generated `ReleaseResultCommand`: the schema has no `required` list, matching
the optional Zod field. A focused 11-test parity regression now protects that
contract boundary. The absence of template authoring remains a real next-wave
limitation and is documented as a fail-closed catalog boundary.

### Final evidence

- Node 22 Vitest: 293 tests across 49 files; 89.25% statements, 83.94% branches
  and 96.51% functions.
- TypeScript, whole-tree ESLint, Next 16 production build, OpenAPI generation
  and drift, Redocly, docs (56 files), secret scan, JSON/JSONL parsing and
  `git diff --check` passed; OpenAPI is 64 operations/59 paths.
- Fresh clean Chromium evidence remains 3/3 for the clinical lifecycle and
  12/12 for core flows plus accessibility.

### Decision

`.agent/gates/v2-laboratory-conditional.json` is
`PASS_WITH_CONDITIONS` for the synthetic local Hemogram slice only. The gate
withholds hospital, production and clinical-policy authority. The next planned
task is `TASK-V2-PATIENT-WORKSPACE-001`; global V2 remains `NOT_READY`.
