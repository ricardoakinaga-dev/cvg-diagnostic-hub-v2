# Test Plan

**Knowledge status (07/09/2026):** `DECISION` de estratégia de validação; a fonte corrente é o candidato AAA-3 e seu manifesto. O MVP local possui testes unitários, API/integrados, cobertura e Playwright. A matriz browser current-source passou 60/60 em Node 22 sem retry, incluindo 12/12 de acessibilidade; o packet PostgreSQL descartável anterior passou 39/39 em Node 22/PostgreSQL 16.15, mas a repetição atual aguarda host com `initdb`/`pg_ctl`/Docker e não tocou 5432. JSONB permanece autoridade clínica. Os cenários abaixo continuam sendo o plano completo para piloto/produção, e os cenários ainda ausentes estão marcados no [backlog AAA-3](../build/STATE_OF_ART_TRIPLE_AAA_BACKLOG.md).

**AAA-3:** [plano](../build/STATE_OF_ART_TRIPLE_AAA_EXECUTIVE_PLAN.md) · [roadmap](../build/STATE_OF_ART_TRIPLE_AAA_ROADMAP.md) · [backlog](../build/STATE_OF_ART_TRIPLE_AAA_BACKLOG.md) · [auditoria de 07/09/2026](../RELATORIO_AUDITORIA_2026-09-07.md) · [manifesto](../../.orchestrate/aaa3-execution-20260907/evidence-manifest.json)

### Current executable evidence — 07/09/2026

`npm run validate` passed **725/725 tests in 86 files**, with 92.72% statements/lines, 85.82% branches and 94.31% functions in the latest full run. Build, OpenAPI 65/60, traceability 43/43, migrations 001–010, security scan, production audit, SBOM CycloneDX with 560 components under Node 22, recovery 5/5 and deterministic performance 7/7 pass. The layer report uses global thresholds of 90/90/85 and retains 35 files below at least one per-file threshold. Browser evidence is **57/57** across core, clinical, accessibility and realtime in Chromium/tablet/mobile without retry; the current full rerun is recorded in [`browser-e2e-node22-race-20260907.md`](../../.orchestrate/aaa3-execution-20260907/browser-e2e-node22-race-20260907.md). The previous disposable PostgreSQL packet passes 39/39, including the resumed SAA-022 upgrade case; a current source rerun awaits a disposable cluster and did not touch 5432. A production-like local lane passes 51/51 against `next start`, PostgreSQL, synthetic S3/HTTPS scan services and a durable outbox worker; PostgreSQL-only restore smoke passes with checksum in an isolated restored database. Target load/failover, real storage/AV, full restore/RPO/RTO, remote CI and human/clinical acceptance remain open. The authoritative packet is [`evidence-manifest.json`](../../.orchestrate/aaa3-execution-20260907/evidence-manifest.json).

## 1. Objectives

Provar comportamento externo, integridade clínica, autorização, recuperação e usabilidade dos journeys críticos. A meta geral de implementação é cobertura ≥80% em código de negócio, mas cobertura não substitui integration/E2E/security.

### Historical executable evidence — 05/09/2026 baseline (superseded)

The superseding 06/09/2026 revalidation is recorded in the [broad G4 packet](../../.orchestrate/evidence/aaa3-g4-broad-coverage-20260906.md), the [current Patient Workspace packet](../../.orchestrate/evidence/v2-patient-workspace-current-20260906.md), the [visual v8 packet](../../.orchestrate/evidence/visual-patient-workspace-20260906-v8/manifest.json), the [current PostgreSQL packet](../../.orchestrate/evidence/v2-relational-sample-lineage-postgres-current-20260906.md), the [production-like browser packet](../../.orchestrate/evidence/aaa3-browser-postgres-production-s3-20260906.md) and the [final notification-projection packet](../../.orchestrate/evidence/aaa3-final-revalidation-20260906-post-notification-projection.md): `npm run test:coverage` passed **619/619 tests in 75 files** with 91.85% statements/lines, 85.09% branches and 94.28% functions across the G4 executable scope; the complete disposable PostgreSQL suite passed **33/33**; build, no-retry E2E 51/51 including 6/6 accessibility scenarios, security, audit, performance 7/7 and recovery 5/5 passed. The production-like browser lane passed 51/51 across Chromium, tablet and mobile with `next start`, PostgreSQL, synthetic S3/HTTPS scan services and a durable outbox worker. The v8 visual packet is historical; the current AAA-3 matrix is 60/60 with accessibility 12/12 in [`browser-e2e-node22-accessibility-20260907.md`](../../.orchestrate/aaa3-execution-20260907/browser-e2e-node22-accessibility-20260907.md). This remains local conditional evidence and does not authorize clinical or production release.

- Playwright: o crítico G2 final registrou 44/45 em sua fronteira; os retestes G3/G4 confirmaram a correção pós-save e 45/45 sem retry. A execução corrente do working tree passou 51/51 em Chromium, tablet e mobile, incluindo o Patient Workspace e a preservação de snapshot stale/degraded; `npm run test:accessibility` passou 6/6 e os testes locais cobrem o projection join, erro/retry, refresh stale/degraded com preservação do snapshot, filtro de contexto e o envelope OpenAPI. A corrida adicional AAA-3 passou 51/51 nos três projetos contra PostgreSQL durável local; o packet está em [`aaa3-browser-postgres-production-s3-20260906.md`](../../.orchestrate/evidence/aaa3-browser-postgres-production-s3-20260906.md). O packet HTTP cobre fanout API/SSE em duas instâncias, mas não aceite browser/produção; a crítica visual independente Bernoulli aprovou localmente o packet v6 e não fornece aprovação clínica, humana ou de produção.
- `npm run test:coverage`: PASS; **619 testes em 75 arquivos**; 91,85% statements/lines, 85,09% branches e 94,28% functions. O denominador G4 inclui `src` e `packages` executáveis, com exclusões técnicas explicitamente listadas no packet; a aprovação global não fecha as lacunas de autoridade relacional, operação ou aceite humano.
- `npm run test:postgres`: PASS em PostgreSQL 16 descartável, **33/33** na suíte completa; o packet browser production-like [`aaa3-browser-postgres-production-s3-20260906.md`](../../.orchestrate/evidence/aaa3-browser-postgres-production-s3-20260906.md) acrescenta 51/51 cenários nos projetos Chromium, tablet e mobile sem retry com `next start`, S3/scan sintéticos e worker outbox; o packet [`aaa3-http-multi-instance-20260906.md`](../../.orchestrate/evidence/aaa3-http-multi-instance-20260906.md) acrescenta 24/24 cenários HTTP em duas instâncias `next dev`/`next start`, replay `Last-Event-ID` e revogação cross-process. Os cenários process-level provam login em A, `/session/me` em B, `LISTEN` observado no banco, probe sem payload clínico, mutação em A, evento SSE autorizado em B, desconexão, replay somente do evento posterior e encerramento da stream após logout; CI/ambiente alvo, cutover e failover ainda precisam repetir o gate correspondente.
- Playwright: a execução corrente do working tree passou 51/51 em Chromium, tablet e mobile, incluindo o Patient Workspace, estados parciais e a preservação de snapshot stale durante refresh; `npm run test:accessibility` passou 6/6 e os testes locais cobrem o projection join, erro/retry, refresh stale/degraded com preservação do snapshot, filtro de contexto e o envelope OpenAPI. A corrida adicional AAA-3 passou 51/51 nos três projetos contra PostgreSQL durável local; o packet está em [`aaa3-browser-postgres-production-s3-20260906.md`](../../.orchestrate/evidence/aaa3-browser-postgres-production-s3-20260906.md). O packet HTTP cobre fanout API/SSE em duas instâncias, mas não aceite browser/produção; a crítica visual v8 permanece o gate independente corrente e não fornece aprovação clínica, humana ou de produção.
- Playwright: o crítico G2 final registrou 44/45 em sua fronteira; os retestes G3/G4 confirmaram a correção pós-save e 45/45 sem retry. A execução corrente do working tree passou 51/51 em Chromium, tablet e mobile, incluindo o Patient Workspace e a preservação de snapshot stale/degraded; `npm run test:accessibility` passou 6/6 e os testes locais cobrem o projection join, erro/retry, refresh stale/degraded com preservação do snapshot, filtro de contexto e o envelope OpenAPI. A corrida adicional AAA-3 passou 51/51 nos três projetos contra PostgreSQL durável local; o packet está em [`aaa3-browser-postgres-production-s3-20260906.md`](../../.orchestrate/evidence/aaa3-browser-postgres-production-s3-20260906.md). O packet HTTP cobre fanout API/SSE em duas instâncias, mas não aceite browser/produção; a crítica visual independente Bernoulli aprovou localmente o packet v6 e não fornece aprovação clínica, humana ou de produção.
- `npm run test:accessibility`: PASS; 9/9 em Chromium, tablet e mobile.
- `npm run perf:synthetic`: PASS determinístico; 372 requisições virtuais concorrentes, leitura p95 104 ms, busca exata p95 60 ms, textual p95 171 ms, p50/p95/p99 e 12 erros esperados/0 inesperados. `npm run perf:smoke` continua sendo o smoke HTTP separado; nenhum dos dois representa workload hospitalar aprovado.
- `npm ci`, typecheck, lint, production build, `npm run validate:openapi` (65 operações/60 paths), `npm run validate:docs`, `npm run security:scan`, `npm test`, `npm audit --audit-level=high`, `npm run validate:migrations`, `node --test scripts/validate-traceability.test.mjs` e `npm run validate:traceability` passaram; `fast-uri` está em 3.1.7 e audit reportou 0 vulnerabilidades. `npm run test:perf` (7/7), `npm run test:recovery` (5/5) e `npm run perf:synthetic` passaram. O packet V2 corrente registra a integração real 33/33 em cluster isolado, com migration 009/010, `EXPLAIN` estrutural local, backfill/replay e wake-up PostgreSQL entre duas conexões. NFR-PERF-001/002 e NFR-OPS-001 têm vínculos locais `CONDITIONAL`, sem aceite externo. Esta é evidência local; migração clínica autoritativa, `EXPLAIN` sob workload aprovado, infraestrutura externa, aceite manual e gates de política hospitalar permanecem abertos.

## 2. Test environments

- Unit: deterministic clock, isolated pure rules.
- Integration target: disposable PostgreSQL + object storage emulator/MinIO, migrations applied, no production credentials. O packet PostgreSQL 16 anterior passou 39/39, incluindo migration-009 readiness/repair, backfill/replay, upgrade SAA-022 retomável, duas instâncias HTTP em `next dev`/`next start`, sessão/fanout/replay e LISTEN/NOTIFY; a repetição current-source aguarda um cluster descartável e não tocou 5432. O browser production-like local passou 51/51 nos projetos Chromium, tablet e mobile com S3/scan sintéticos e worker outbox durável. Object storage real, produção, carga representativa, restart/failover e ambiente alvo continuam pendentes.
- Reproduction: the exact disposable loop and CI variables are documented in [`POSTGRES_INTEGRATION.md`](POSTGRES_INTEGRATION.md); Docker não é obrigatório para o smoke local porque `backup-restore-smoke.sh` aceita `POSTGRES_DIRECT_URL`, mas CI/ambiente alvo ainda devem repetir a execução isolada.
- API/contract: running API with auth middleware, schema and persistence.
- E2E: seeded synthetic patients/users, Playwright, fixed timezone/locale and named viewport.
- Security: isolated test tenant/site/data, no destructive production action.
- Restore: isolated database/bucket, never production.

## 3. Test pyramid and ownership

| Layer | Covers | Examples |
| --- | --- | --- |
| Unit | value objects, state machines, SLA, priority, permission policy, error mapping | transition matrix, duplicate warning, result version |
| Integration | repositories, transactions, outbox, storage, session, authorization | release atomicity, recollection chain, IDOR |
| API/contract | endpoints/envelopes/errors/OpenAPI | request/release/review/idempotency |
| E2E | critical user journeys across browser/API/db | Lab normal, recollection, result critical |
| Accessibility | semantic/focus/contrast/keyboard | queues/forms/result states |
| Security | abuse cases from threat model | upload, SQLi/XSS, privilege, session |
| Ops | backup/restore, health, failure/reconnect | restore drill, outbox retry, SSE degraded |
| Performance | representative read/command/search/realtime | p50/p95/p99, concurrency and skew |

## 4. Requirement traceability

Every `FR-*`/`NFR-*` has `TEST-*` in [`../TRACEABILITY_MATRIX.md`](../TRACEABILITY_MATRIX.md). Critical journeys:

- `TEST-FR-CORE-001-01`: request multi-item end-to-end;
- `TEST-FR-LAB-003-01`: hemolysis → recollection → replacement → result;
- `TEST-FR-IMG-002-01`: ultrasound schedule/reschedule/perform/report;
- `TEST-FR-RESULT-002-01`: released result amendment and re-review;
- `TEST-FR-RESULT-004-01`: critical release, notification, acknowledgement/escalation;
- `TEST-NFR-REL-001-01`: duplicate command/concurrent release;
- `TEST-NFR-SEC-002-01`: cross-scope API/file access;
- `TEST-NFR-SEC-003-01`: invalid/quarantined uploads;
- `TEST-NFR-UX-002-01`: keyboard/accessibility states.

### Test ID catalogue

| ID | Layer | Scope |
| --- | --- | --- |
| `TEST-FR-CORE-001` / `-01` | E2E | create request with context and server confirmation |
| `TEST-FR-CORE-002` | integration/E2E | multi-item independence and counts |
| `TEST-FR-CORE-003` | integration | human protocol uniqueness under concurrency |
| `TEST-FR-CORE-004` | API/E2E | duplicate warning and authorized override |
| `TEST-FR-CORE-005` | E2E | transfer, bed change and discharge |
| `TEST-FR-CORE-006` | API/security | cancellation/rejection permissions and history |
| `TEST-FR-CAT-001` | API | catalog capability/workflow configuration |
| `TEST-FR-LAB-001` | integration/E2E | accession and one-sample/many-item link |
| `TEST-FR-LAB-002` | integration/E2E | processing/failure transitions |
| `TEST-FR-LAB-003` / `-01` | E2E | rejection, recollection and replacement chain |
| `TEST-FR-IMG-001` | integration/E2E | RX workflow without lab-only states |
| `TEST-FR-IMG-002` / `-01` | E2E | US schedule, conflict and reschedule |
| `TEST-FR-IMG-003` | integration | new service from capability config |
| `TEST-FR-RESULT-001` | integration | atomic draft release/audit/outbox |
| `TEST-FR-RESULT-002` / `-01` | E2E | amendment/version/re-review |
| `TEST-FR-RESULT-003` | E2E | view/review/completion separation |
| `TEST-FR-RESULT-004` / `-01` | failure/E2E | critical notification, acknowledgement and escalation |
| `TEST-FR-NOTIF-001` | integration/E2E | inbox categories, dedupe and deep links |
| `TEST-REALTIME-001` | network E2E | SSE update, reconnect and resync |
| `TEST-FR-OPS-001` | integration/performance | queue ordering, filters and pagination |
| `TEST-FR-OPS-002` | unit/integration | SLA start/due/overdue policy |
| `TEST-FR-OPS-003` | API/security/performance | scoped global search/homonyms |
| `TEST-FR-OPS-004` | integration/E2E | event-derived timeline |
| `TEST-FR-OPS-005` | visual/performance | actionable indicators and definitions |
| `TEST-FR-AUD-001` | integration/security | append-only audit completeness |
| `TEST-FR-AUTH-001` | API/security | RBAC/scope matrix |
| `TEST-FR-DATA-001` | integration/E2E | Patient/Encounter/Admission/external refs |
| `TEST-FR-FILE-001` | integration/security | upload/finalize/private download |
| `TEST-FR-ADMIN-001` | API/security | config permission/version/audit |
| `TEST-NFR-SEC-001` | security | session cookie/expiry/revocation |
| `TEST-NFR-SEC-002` / `-01` | security | IDOR/authorization/no enumeration |
| `TEST-NFR-SEC-003` / `-01` | security | MIME spoof, malware/quarantine and limits |
| `TEST-NFR-SEC-004` | static/integration | redaction and audit immutability |
| `TEST-NFR-REL-001` / `-01` | integration/concurrency | transaction, outbox, idempotency |
| `TEST-NFR-REL-002` | network E2E | lost connection, retry and degraded UI |
| `TEST-NFR-PERF-001` | benchmark | API/queue p95/p99 and N+1 |
| `TEST-NFR-PERF-002` | benchmark | exact/text search p95 |
| `TEST-NFR-UX-001` | task study/E2E | request action count/time |
| `TEST-NFR-UX-002` / `-01` | accessibility/E2E | keyboard/focus/contrast/responsive states |
| `TEST-NFR-OBS-001` | integration/ops | logs, correlation, health and metrics |
| `TEST-NFR-OPS-001` | recovery contract + restore drill | manifest/checksum/redaction/dry-run guards locally; DB + object storage recovery remains environment-gated |
| `TEST-NFR-API-001` | contract | versioned envelope, errors, pagination and concurrency |
| `TEST-NFR-MAINT-001` | static/build | dependency direction and new workflow seam |
| `TEST-RELEASE-001` | release gate | full checklist and critical journeys |

## 5. Fixtures/factories

Factories: user/role/scope, patient with homonym, owner, encounter/admission/transfer, service/policy, request with multiple items, sample chain, procedure schedule, draft/released/amended result, attachment statuses, notification/ack, audit/outbox. Synthetic names (Thor, Mel, Nina, Bob, Luna) only; no real data.

## 6. Scenario matrix

| Area | Happy | Invalid/edge | Security/concurrency |
| --- | --- | --- | --- |
| Request | create 1 and 5 items | missing encounter, inactive service, duplicate, high input | wrong role, wrong patient, retry |
| Lab | receive/process/release | hemolyzed, insufficient, successive recollection, equipment unavailable | wrong department, two receives, double click |
| Image | RX perform/report; US schedule | conflict, reschedule, missing report/attachment | wrong service role, stale version |
| Result | view/review/complete | amend, void, wrong file, stale review | old version, unauthorized attachment |
| Critical | notify/ack/escalate | missing responsible/fallback, correction | duplicate notifications, worker crash |
| Ops | queue/SLA/dashboard | empty/partial/degraded | data leakage in search/metrics |

## 7. Harness validity

Before relying on a test, introduce a known-bad fixture/change: remove authorization check, allow duplicate release, or accept invalid MIME. The test must fail. The local executable sentinel is `source /home/ricardo/.nvm/nvm.sh && nvm exec 22 npm run test:mutation`; it injects seven bounded mutations in a temporary copy and currently detects 7/7. Freeze clocks, random seeds, browser viewport, locale, database state and data volume where comparison matters.

## 8. Quality gates

- unit/integration/API/E2E/security required for release-blocking journeys;
- all existing checks must remain green after each material change;
- no test weakened/deleted to hide a real defect;
- coverage target ≥80% for business modules, with exclusions justified;
- flaky test quarantine requires owner, reason and follow-up; it cannot be counted as pass;
- no production release with critical/high unresolved security, data-integrity or correctness gap.
