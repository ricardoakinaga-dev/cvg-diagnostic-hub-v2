# Production readiness

**Knowledge status:** `DECISION` de gates; o status atual é uma avaliação documental, não evidência de produção.

Status: `NOT READY` until implementation, operational validation and human gates exist. This checklist defines what “ready” must prove.

## Local MVP evidence (23/08/2026)

The local synthetic artifact has executable evidence for session/RBAC/CSRF/scope, patient registration with initial encounter/admission, request-flow patient creation and user account, API envelopes and health, core Lab/RX/US/result/file flows, scoped search/filter/timeline/dashboard contracts, ADMIN/delegated-MANAGER versioned collaborator administration with recent re-authentication and soft deactivation, manager control/catalog/reason surfaces, bounded metrics, private local/S3-compatible storage adapters, explicit external malware-scanner and production-storage fail-closed factories, PostgreSQL migration/readiness/snapshot-boundary evidence, distributed-rate-limit schema readiness, token-owned outbox leases, 273 Vitest tests across 44 files and focused registry/API/UI tests, 16 disposable-PostgreSQL integration tests and full Playwright 39/39 across Chromium/tablet/mobile (including expanded result/attachment/critical-ack accessibility scans). Coverage is 96.13% statements/lines, 83.67% branches and 97.11% functions. The core 11 browser scenarios and a focused 2-test result/attachment/critical-ack lifecycle also passed against disposable PostgreSQL with synthetic data. `npm run typecheck`, `npm run lint`, OpenAPI validation (63 operations/58 paths), docs validation and the security scan are separate passing gates. This evidence does not check any release box by itself.

The remaining release blockers are explicit: hospital identity/ownership and transfer/alta policy, approved critical-result/fallback policy, production object storage/AV/credentials, relational clinical migration/representative workload, multi-instance realtime validation, manual accessibility/clinical acceptance, approved RPO/RTO and retention, remote CI execution and pilot sign-off. The local technical boundaries are implemented; the blockers are not silently marked as production-ready.

## Product/clinical

- [ ] OQ-002/OQ-003/OQ-005/OQ-006/OQ-007/OQ-015/OQ-018 resolved or explicitly gated.
- [ ] Lab normal, recoleta, RX, US, critical, overdue and cancellation journeys observed/accepted.
- [ ] Patient identity/homonym and sample/accession policies approved.
- [ ] Result release/amend/review/void ownership approved.

## Security/privacy

- [ ] Authentication, session, RBAC/scope, CSRF/CORS/headers/TLS tested.
- [ ] IDOR, privilege escalation, SQLi/XSS and upload abuse tests pass.
- [ ] Production rate limiting uses the PostgreSQL/distributed backend (or an approved equivalent); in-memory mode is forbidden in production and backend outage fails closed.
- [ ] Production malware scanning uses the external scanner adapter with endpoint/key/timeout, quarantine and incident ownership; local EICAR scanner is test/development only.
- [ ] Threat model reviewed; audit immutability verified.
- [ ] LGPD data inventory, purpose, retention, export/deletion and incident contacts approved.
- [ ] No secrets or real patient/tutor data in code, fixtures, logs or client bundle.

## Reliability/operations

- [ ] Migrations tested from representative prior version; rollback/roll-forward plan.
- [ ] The current JSONB snapshot is replaced or formally approved as a transitional boundary; relational clinical constraints, indexes and representative `EXPLAIN` evidence are reviewed.
- [ ] PostgreSQL + object storage backups verified and restore drill passed against approved RPO/RTO. Local evidence covers PostgreSQL only; object storage and RPO/RTO remain external.
- [ ] `/livez`, `/readyz`, logs, metrics, correlation, outbox retry/dead letter and alert routing tested.
- [ ] Storage scan/quarantine and signed downloads work.
- [ ] Incident, critical notification and degraded-network runbooks rehearsed.

## Quality/UX

- [ ] Unit/integration/API/E2E/accessibility/security suite passes; business coverage ≥80%.
- [ ] Responsive desktop/tablet/mobile critical states inspected.
- [ ] Loading, empty, partial, error, offline/degraded and permission denied flows verified.
- [ ] Performance targets measured with representative hospital data/concurrency. Local evidence covers four synthetic read workloads at concurrency 10; it is not representative-load sign-off.
- [ ] No fake implementation, silent error, critical pending item or unowned alert.

## Deployment

- [ ] Environment separation and secret manager configured.
- [ ] TLS/reverse proxy, database/storage access and least-privileged service accounts reviewed.
- [ ] Smoke test, release notes, rollback and support owner defined.
- [ ] Pilot scope and feedback loop approved.
