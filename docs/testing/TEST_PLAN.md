# Test Plan

**Knowledge status (23/08/2026):** `DECISION` de estratégia de validação; o MVP local já possui testes unitários, API/integrados, cobertura, PostgreSQL smoke e Playwright. Os cenários abaixo continuam sendo o plano completo para piloto/produção, e os cenários ainda ausentes estão marcados no backlog.

## 1. Objectives

Provar comportamento externo, integridade clínica, autorização, recuperação e usabilidade dos journeys críticos. A meta geral de implementação é cobertura ≥80% em código de negócio, mas cobertura não substitui integration/E2E/security.

### Current executable evidence — 23/08/2026

- `npm run test:coverage`: 273/273 tests in 44 files; 96.13% statements/lines, 83.67% branches and 97.11% functions.
- Disposable PostgreSQL integration: 16/16 tests, including migrations 001–006, fresh reads, outbox ownership and PostgreSQL rate-limit buckets.
- `npm run test:e2e`: 39/39 across Chromium, tablet and mobile; the matrix includes 6 accessibility checks and the focused result/attachment/critical-ack journey.
- Focused PostgreSQL-backed clinical browser smoke: 2/2 without route mocking, using synthetic data and an explicitly configured test critical-result policy.
- Typecheck, lint, production build, OpenAPI (63 operations/58 paths), docs validation, secret scan and high-severity audit pass separately. Patient registry now has focused unit, API-boundary and request-flow UI coverage. This is local evidence only; relational clinical migration/`EXPLAIN`, external infrastructure, manual acceptance and hospital policy gates remain open.

## 2. Test environments

- Unit: deterministic clock, isolated pure rules.
- Integration: disposable PostgreSQL + object storage emulator/MinIO, migrations applied, no production credentials.
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
| `TEST-NFR-OPS-001` | restore drill | DB + object storage recovery |
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

Before relying on a test, introduce a known-bad fixture/change: remove authorization check, allow duplicate release, or accept invalid MIME. The test must fail. Freeze clocks, random seeds, browser viewport, locale, database state and data volume where comparison matters.

## 8. Quality gates

- unit/integration/API/E2E/security required for release-blocking journeys;
- all existing checks must remain green after each material change;
- no test weakened/deleted to hide a real defect;
- coverage target ≥80% for business modules, with exclusions justified;
- flaky test quarantine requires owner, reason and follow-up; it cannot be counted as pass;
- no production release with critical/high unresolved security, data-integrity or correctness gap.
