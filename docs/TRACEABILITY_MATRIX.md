# Traceability matrix

## 1. How to read

Each row links a user problem (`P-*`) to a PRD requirement, acceptance criterion, normative specification, Build task and test strategy. The `Status` column is the normative roadmap state; the current executable evidence and limitations are summarized below and must be read together with `docs/build/BACKLOG.md`.

The detailed rows retain the normative requirement-planning status used by the original specification. The current implementation state is authoritative in the coverage table above and in `docs/build/BACKLOG_95.md`; this keeps planned acceptance work distinct from local runtime evidence and external release approval.

## 1.1 Current build coverage (23/08/2026)

| Coverage state | Requirement groups | Evidence/limit |
| --- | --- | --- |
| implemented locally | patient registry with initial encounter/admission, request-flow patient creation, user account area; request context/multi-item/protocol/duplicate/cancel; Lab sample/recollection; RX/US workflow; result draft/release/version/view/review/amend/void; patient/encounter context; workflow actions; audit; session/CSRF/RBAC/IDOR; private local/S3-compatible attachment boundary; queue/search with typed filters/keyset cursors/timeline/dashboard indicators; leased outbox with token ownership; PostgreSQL rate-limit boundary; bounded metrics/readiness; versioned catalog/reason/user administration; manager control center; result UI actions and attachment upload flow | Full Vitest suite: 273 tests/44 files passed; coverage: 96.13% statements/lines, 83.67% branches and 97.11% functions; disposable PostgreSQL harness: 16 tests/2 files passed; full Playwright: 39/39 across Chromium/tablet/mobile, including expanded result/attachment/critical-ack accessibility scans; OpenAPI (63 operations/58 paths). Build/docs/security are separate passing gates recorded in the current verification log. |
| conditional | PostgreSQL clinical snapshot boundary; transfer/alta; hospital identity/ownership and delegated authority; external AV/object storage/credentials; multi-instance realtime; representative workload; manual clinical/accessibility acceptance; RPO/RTO/retention; remote CI | Local technical boundary is implemented and fail-closed where required; target-environment evidence and owner approval remain required. |
| gated | critical-result notification/escalation and hospital policy | Runtime requires enable flag plus policy version, approval reference and approval timestamp; thresholds/SLA/fallback still require human OQs. |
| pending | relational clinical migration/EXPLAIN evidence and independent production configuration review | Real-Postgres browser smoke is now green for the current 11 scenarios; relational schema hardening, representative plans and independent production review remain intentionally open in `docs/build/PREMIUM_MVP_V4.md`, `.gauntlet/state.md` and `PRODUCTION_READINESS.md`. |

## 2. Problem catalogue

| ID | Problem/outcome |
| --- | --- |
| P-001 | Pedido esquecido ou sem acompanhamento |
| P-002 | Comunicação manual entre solicitante e executor |
| P-003 | Prioridade/SLA/atraso invisíveis |
| P-004 | Recoleta e amostra sem rastreabilidade |
| P-005 | Resultado liberado sem visualização/revisão clara |
| P-006 | Correção/arquivo crítico sem histórico e comunicação |
| P-007 | Acesso indevido, paciente homônimo ou vazamento |
| P-008 | Falta de métricas, auditoria, backup e recuperação |
| P-009 | Core rígido para apenas Lab/RX/US |
| P-010 | Operação burocrática, telas sem estados/recovery |
| P-011 | Veterinário não consegue cadastrar um paciente novo dentro da solicitação |

## 3. Matrix

| Problem | Requirement | Acceptance criterion | Specification | Build task | Test ID/strategy | Status |
| --- | --- | --- | --- | --- | --- | --- |
| P-001 | FR-CORE-001 | AC-FR-CORE-001-01 | `spec/SYSTEM_SPEC`, `DOMAIN_MODEL` | BLD-REQ-001 | TEST-FR-CORE-001 E2E | planned |
| P-001 | FR-CORE-002 | AC-FR-CORE-002-01 | `DOMAIN_MODEL`, `DATA_MODEL` | BLD-REQ-001 | TEST-FR-CORE-002 integration | planned |
| P-001 | FR-CORE-003 | AC-FR-CORE-003-01 | `DATA_MODEL`, `API_SPEC` | BLD-REQ-001 | TEST-FR-CORE-003 uniqueness/concurrency | planned |
| P-001 | FR-CORE-004 | AC-FR-CORE-004-01 | `SYSTEM_SPEC`, `API_SPEC` | BLD-REQ-002 | TEST-FR-CORE-004 duplicate/override | planned |
| P-001 | FR-CORE-005 | AC-FR-CORE-005-01 | `USER_JOURNEYS`, `SYSTEM_SPEC` | BLD-REQ-002 | TEST-FR-CORE-005 discharge/transfer | planned |
| P-001 | FR-CORE-006 | AC-FR-CORE-006-01 | `STATE_MACHINES`, `PERMISSIONS` | BLD-REQ-002 | TEST-FR-CORE-006 cancel matrix | planned |
| P-002 | FR-LAB-001 | AC-FR-LAB-001-01 | `DOMAIN_MODEL`, `DATA_MODEL` | BLD-LAB-001 | TEST-FR-LAB-001 sample link | planned |
| P-002 | FR-LAB-002 | AC-FR-LAB-002-01 | `STATE_MACHINES`, `PERMISSIONS` | BLD-LAB-002 | TEST-FR-LAB-002 processing | planned |
| P-004 | FR-LAB-003 | AC-FR-LAB-003-01 | `STATE_MACHINES`, `NOTIFICATIONS` | BLD-LAB-003 | TEST-FR-LAB-003 recollection | planned |
| P-002 | FR-IMG-001 | AC-FR-IMG-001-01 | `STATE_MACHINES`, `DOMAIN_MODEL` | BLD-IMG-001 | TEST-FR-IMG-001 RX | planned |
| P-003 | FR-IMG-002 | AC-FR-IMG-002-01 | `STATE_MACHINES`, `DATA_MODEL` | BLD-IMG-002 | TEST-FR-IMG-002 US schedule | planned |
| P-009 | FR-IMG-003 | AC-FR-IMG-003-01 | `SYSTEM_SPEC`, `ARCHITECTURE` | BLD-CAT-001 | TEST-FR-IMG-003 new service | planned |
| P-005 | FR-RESULT-001 | AC-FR-RESULT-001-01 | `STATE_MACHINES`, `API_SPEC` | BLD-RES-001 | TEST-FR-RESULT-001 release atomicity | planned |
| P-006 | FR-RESULT-002 | AC-FR-RESULT-002-01 | `STATE_MACHINES`, `DATA_MODEL` | BLD-RES-002 | TEST-FR-RESULT-002 amend/version | planned |
| P-005 | FR-RESULT-003 | AC-FR-RESULT-003-01 | `DOMAIN_MODEL`, `STATE_MACHINES` | BLD-RES-002 | TEST-FR-RESULT-003 view/review | planned |
| P-006 | FR-RESULT-004 | AC-FR-RESULT-004-01 | `NOTIFICATIONS`, `THREAT_MODEL` | BLD-NOTIF-002 | TEST-FR-RESULT-004 critical | planned |
| P-002 | FR-NOTIF-001 | AC-FR-NOTIF-001-01 | `NOTIFICATIONS`, `UX/SCREEN_SPECIFICATIONS` | BLD-NOTIF-001 | TEST-FR-NOTIF-001 inbox | planned |
| P-002 | FR-NOTIF-002 | AC-FR-NOTIF-002-01 | `REALTIME` | BLD-RT-001 | TEST-REALTIME-001 reconnect | planned |
| P-003 | FR-OPS-001 | AC-FR-OPS-001-01 | `SEARCH`, `SYSTEM_SPEC` | BLD-OPS-001 | TEST-FR-OPS-001 queue/SLA | planned |
| P-003 | FR-OPS-002 | AC-FR-OPS-002-01 | `SYSTEM_SPEC`, `DATA_MODEL` | BLD-OPS-001 | TEST-FR-OPS-002 SLA clock | planned |
| P-001 | FR-OPS-003 | AC-FR-OPS-003-01 | `SEARCH`, `API_SPEC` | BLD-SEARCH-001 | TEST-FR-OPS-003 search/security | planned |
| P-005 | FR-OPS-004 | AC-FR-OPS-004-01 | `DATA_FLOW`, `DOMAIN_MODEL` | BLD-TIME-001 | TEST-FR-OPS-004 timeline | planned |
| P-003 | FR-OPS-005 | AC-FR-OPS-005-01 | `SUCCESS_METRICS`, `SCREEN_SPECIFICATIONS` | BLD-DASH-001 | TEST-FR-OPS-005 dashboard | planned |
| P-007 | FR-AUTH-001 | AC-FR-AUTH-001-01 | `PERMISSIONS`, `SECURITY` | BLD-ID-002 | TEST-FR-AUTH-001 RBAC | planned |
| P-008 | FR-AUD-001 | AC-FR-AUD-001-01 | `DOMAIN_MODEL`, `SECURITY` | BLD-FOUND-002 | TEST-FR-AUD-001 audit | planned |
| P-007 | FR-DATA-001 | AC-FR-DATA-001-01 | `DOMAIN_MODEL`, `DATA_MODEL` | BLD-REG-001 | TEST-FR-DATA-001 identity | planned |
| P-011 | FR-REG-001 | AC-FR-REG-001-01 | `API_SPEC`, `PERMISSIONS`, `USER_FLOWS` | BLD-REG-001 | registry unit/API/UI + request-flow integration | implemented locally |
| P-006 | FR-FILE-001 | AC-FR-FILE-001-01 | `DATA_MODEL`, `SECURITY` | BLD-FILE-001 | TEST-FR-FILE-001 upload | planned |
| P-009 | FR-ADMIN-001 | AC-FR-ADMIN-001-01 | `PERMISSIONS`, `DATA_MODEL` | BLD-CAT-001 | TEST-FR-ADMIN-001 config | planned |
| P-007 | NFR-SEC-001 | AC-NFR-SEC-001-01 | `SECURITY`, ADR-005 | BLD-ID-001 | TEST-NFR-SEC-001 session | planned |
| P-007 | NFR-SEC-002 | AC-NFR-SEC-002-01 | `PERMISSIONS`, `THREAT_MODEL` | BLD-ID-002 | TEST-NFR-SEC-002 IDOR | planned |
| P-007 | NFR-SEC-003 | AC-NFR-SEC-003-01 | `SECURITY`, `DATA_FLOW` | BLD-FILE-001 | TEST-NFR-SEC-003 upload abuse | planned |
| P-006 | NFR-SEC-004 | AC-NFR-SEC-004-01 | `SECURITY`, `DATA_MODEL` | BLD-FOUND-002 | TEST-NFR-SEC-004 redaction/audit | planned |
| P-006 | NFR-REL-001 | AC-NFR-REL-001-01 | `SYSTEM_SPEC`, ADR-007 | BLD-FOUND-002,BLD-RES-001 | TEST-NFR-REL-001 transaction | planned |
| P-002 | NFR-REL-002 | AC-NFR-REL-002-01 | `REALTIME`, `ERROR_MODEL` | BLD-RT-001 | TEST-NFR-REL-002 degraded/retry | planned |
| P-003 | NFR-PERF-001 | AC-NFR-PERF-001-01 | `OBSERVABILITY`, `BUILD_PLAN` | BLD-HARD-002 | TEST-NFR-PERF-001 load | planned |
| P-001 | NFR-PERF-002 | AC-NFR-PERF-002-01 | `SEARCH`, `OBSERVABILITY` | BLD-HARD-002 | TEST-NFR-PERF-002 search | planned |
| P-010 | NFR-UX-001 | AC-NFR-UX-001-01 | `PRD`, `USER_FLOWS` | BLD-HARD-001 | TEST-NFR-UX-001 task time | planned |
| P-010 | NFR-UX-002 | AC-NFR-UX-002-01 | `SCREEN_SPECIFICATIONS`, `DESIGN_SYSTEM` | BLD-FOUND-003,BLD-HARD-001 | TEST-NFR-UX-002 a11y | planned |
| P-008 | NFR-OBS-001 | AC-NFR-OBS-001-01 | `OBSERVABILITY` | BLD-FOUND-001,BLD-HARD-003 | TEST-NFR-OBS-001 health/logs | planned |
| P-008 | NFR-OPS-001 | AC-NFR-OPS-001-01 | `BACKUP_RESTORE`, `PRODUCTION_READINESS` | BLD-HARD-003,BLD-HARD-004 | TEST-NFR-OPS-001 restore | planned |
| P-002 | NFR-API-001 | AC-NFR-API-001-01 | `API_SPEC`, `ERROR_MODEL` | BLD-FOUND-001 | TEST-NFR-API-001 contract | planned |
| P-009 | NFR-MAINT-001 | AC-NFR-MAINT-001-01 | `ARCHITECTURE`, `COMPONENTS` | BLD-FOUND-001 | TEST-NFR-MAINT-001 dependency | planned |

## 4.1 Integration and release gates

| Problem | Gate | Acceptance evidence | Specification | Build task | Test ID/strategy | Status |
| --- | --- | --- | --- | --- | --- | --- |
| P-008/P-010 | `INTEGRATION-001` — all required release criteria | security, E2E, restore, observability, UX and traceability gates pass together | `PRODUCTION_READINESS`, `RELEASE_CHECKLIST` | BLD-HARD-004 | TEST-RELEASE-001 | planned |

## 4.2 API operation traceability

Requirement rows above prove product coverage; this operation table proves that domain commands and externally reachable API actions are not left unowned. Read endpoints are grouped only when they share the same authorization/query contract.

| Operation ID | API operation(s) | Requirement/AC | Normative contract | Permission(s) | Build task | Test |
| --- | --- | --- | --- | --- | --- | --- |
| API-REQ-001 | `POST /diagnostic-requests` | FR-CORE-001,FR-CORE-002,FR-CORE-003; AC-FR-CORE-001-01,AC-FR-CORE-002-01,AC-FR-CORE-003-01 | `API_SPEC`, `SYSTEM_SPEC` | `request.create`; conditional `request.duplicate_override` | BLD-REQ-001 | TEST-FR-CORE-001,TEST-FR-CORE-002,TEST-FR-CORE-003 |
| API-REQ-002 | duplicate override and request/item read/cancel/reject | FR-CORE-004,FR-CORE-005,FR-CORE-006; AC-FR-CORE-004-01,AC-FR-CORE-005-01,AC-FR-CORE-006-01 | `API_SPEC`, `PERMISSIONS` | `request.duplicate_override`, `request.view`, `request.cancel`, `item.view`, `item.cancel`, `item.reject` | BLD-REQ-002 | TEST-FR-CORE-004,TEST-FR-CORE-005,TEST-FR-CORE-006 |
| API-LAB-001 | receive sample/start processing | FR-LAB-001,FR-LAB-002; AC-FR-LAB-001-01,AC-FR-LAB-002-01 | `API_SPEC`, `STATE_MACHINES`, `PERMISSIONS` | `sample.receive`, `sample.process` | BLD-LAB-001,BLD-LAB-002 | TEST-FR-LAB-001,TEST-FR-LAB-002 |
| API-LAB-002 | request recollection/receive replacement | FR-LAB-003; AC-FR-LAB-003-01 | `API_SPEC`, `STATE_MACHINES`, `PERMISSIONS` | `sample.recollection.request`, `sample.replacement.receive` | BLD-LAB-003 | TEST-FR-LAB-003 |
| API-IMG-001 | schedule/reschedule/start/perform RX/US | FR-IMG-001,FR-IMG-002; AC-FR-IMG-001-01,AC-FR-IMG-002-01 | `API_SPEC`, `STATE_MACHINES`, `PERMISSIONS` | `procedure.schedule`, `procedure.reschedule`, `procedure.start`, `procedure.mark_performed` | BLD-IMG-001,BLD-IMG-002 | TEST-FR-IMG-001,TEST-FR-IMG-002 |
| API-RES-001 | create/update result draft | FR-RESULT-001; AC-FR-RESULT-001-01 | `API_SPEC`, `DOMAIN_MODEL`, `PERMISSIONS` | `result.draft.create`, `result.draft.edit_own` | BLD-RES-001 | TEST-FR-RESULT-001 |
| API-RES-002 | release result/report | FR-RESULT-001,FR-RESULT-003; AC-FR-RESULT-001-01,AC-FR-RESULT-003-01 | `API_SPEC`, `STATE_MACHINES`, `PERMISSIONS` | `result.release` | BLD-RES-001 | TEST-FR-RESULT-001,TEST-FR-RESULT-003 |
| API-RES-003 | amend released result | FR-RESULT-002; AC-FR-RESULT-002-01 | `API_SPEC`, ADR-006, `PERMISSIONS` | `result.amend` | BLD-RES-002 | TEST-FR-RESULT-002 |
| API-RES-004 | void released/reviewed/completed result | FR-RESULT-002,FR-RESULT-003; AC-FR-RESULT-002-01,AC-FR-RESULT-003-01 | `API_SPEC`, `STATE_MACHINES`, `NOTIFICATIONS`, `PERMISSIONS` | `result.void` | BLD-RES-002 | TEST-FR-RESULT-002,TEST-FR-RESULT-003 |
| API-RES-005 | view/review/complete item | FR-RESULT-003; AC-FR-RESULT-003-01 | `API_SPEC`, `PERMISSIONS` | `result.view`, `result.view.record`, `result.review`, `item.complete` | BLD-RES-002 | TEST-FR-RESULT-003 |
| API-FILE-001 | upload-session/finalize/download attachment | FR-FILE-001,NFR-SEC-003; AC-FR-FILE-001-01,AC-NFR-SEC-003-01 | `API_SPEC`, `SECURITY`, `PERMISSIONS` | `attachment.upload_session`, `attachment.finalize`, `attachment.download`, `attachment.view` | BLD-FILE-001 | TEST-FR-FILE-001,TEST-NFR-SEC-003 |
| API-NOTIF-001 | acknowledge notification/critical | FR-NOTIF-001,FR-RESULT-004; AC-FR-NOTIF-001-01,AC-FR-RESULT-004-01 | `API_SPEC`, `NOTIFICATIONS`, `PERMISSIONS` | `notification.view`, `notification.acknowledge` | BLD-NOTIF-001,BLD-NOTIF-002 | TEST-FR-NOTIF-001,TEST-FR-RESULT-004 |
| API-QUERY-001 | patient/encounter/request/item/result/timeline reads | FR-OPS-004,NFR-SEC-002; AC-FR-OPS-004-01,AC-NFR-SEC-002-01 | `API_SPEC`, `PERMISSIONS`, `SEARCH` | `patient.view`, `encounter.view`, `admission.view`, `request.view`, `item.view`, `result.view`, `result.history.view`, `diagnostic.timeline.view`, `timeline.view` | BLD-TIME-001 | TEST-FR-OPS-004,TEST-NFR-SEC-002 |
| API-QUERY-002 | queues, request lists and dashboard indicators | FR-OPS-001,FR-OPS-002,FR-OPS-005; AC-FR-OPS-001-01,AC-FR-OPS-002-01,AC-FR-OPS-005-01 | `API_SPEC`, `SYSTEM_SPEC`, `PERMISSIONS` | `queue.view`, `request.list`, `dashboard.view` | BLD-OPS-001,BLD-DASH-001 | TEST-FR-OPS-001,TEST-FR-OPS-002,TEST-FR-OPS-005 |
| API-SEARCH-001 | `GET /search` | FR-OPS-003; AC-FR-OPS-003-01 | `SEARCH`, `API_SPEC`, `PERMISSIONS` | `search.execute` | BLD-SEARCH-001 | TEST-FR-OPS-003 |
| API-ADMIN-001 | catalog/policy/reason/user/role configuration | FR-ADMIN-001,FR-AUTH-001; AC-FR-ADMIN-001-01,AC-FR-AUTH-001-01 | `PERMISSIONS`, `DATA_MODEL`, `API_SPEC` | `service.catalog.manage`, `sla_policy.manage`, `critical_result_policy.manage`, `reason_code.manage`, `user_role.manage` | BLD-CAT-001,BLD-ID-002 | TEST-FR-ADMIN-001,TEST-FR-AUTH-001 |
| API-SYSTEM-001 | `/livez`, `/readyz`, `/realtime/events` | NFR-OBS-001,NFR-REL-002; AC-NFR-OBS-001-01,AC-NFR-REL-002-01 | `OBSERVABILITY`, `REALTIME`, `ERROR_MODEL`, `PERMISSIONS` | `health.liveness`, `health.readiness`, `realtime.connect` | BLD-FOUND-001,BLD-RT-001 | TEST-NFR-OBS-001,TEST-NFR-REL-002,TEST-REALTIME-001 |

## 5. Traceability validation rules

- Every `FR-`/`NFR-` in PRD appears in this table.
- Every `AC-` in PRD appears in a row or is explicitly marked not applicable with reason.
- Every Build task references at least one requirement and every critical requirement has a task.
- Every API command/query group in `api/API_SPEC.md` appears in `API operation traceability` with a permission/spec/task/test path.
- Every test ID appears in `testing/TEST_PLAN.md` or is a strategy family explicitly catalogued before BUILD.
- Links and exact canonical terms are checked by `scripts/validate-docs.sh`.
