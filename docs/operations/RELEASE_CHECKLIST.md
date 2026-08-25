# Release checklist

**Knowledge status:** `DECISION/PROPOSAL` de processo de release; só pode ser marcado com evidência após BUILD.

Use for every pilot/production release; checkboxes require evidence link or command output.

## Current local evidence (23/08/2026)

`npm run test:coverage` (273/273 across 44 files; 96.13% statements/lines, 83.67% branches, 97.11% functions), typecheck/lint/build, full Playwright desktop/tablet/mobile (39/39), including the result/attachment/critical-ack lifecycle and expanded axe scans, disposable PostgreSQL integration (16/16), focused PostgreSQL-backed clinical browser smoke (2/2), OpenAPI validation (63 operations/58 paths), secret scan, high-severity audit and `git diff --check` have passed for the synthetic local MVP. The checklist remains open because production evidence, policy approval and operational ownership are not yet present.

## Change and migration

- [ ] PRD/SPEC/traceability updated for observable change.
- [ ] Migration reviewed for expand/contract and backup point.
- [ ] Staging migration + rollback/roll-forward rehearsal passed.
- [ ] Seed/fixtures contain synthetic data only.

## Security/configuration

- [ ] Environment variables/secrets present via approved manager; no values committed.
- [ ] TLS, security headers, CORS/CSRF, session and rate limits verified.
- [ ] Roles/scopes reviewed; admin/break-glass access audited.
- [ ] Upload allowlist/scan/storage policy enabled.

## Verification

- [ ] Lint/typecheck/unit/integration/API/E2E/accessibility/security pass.
- [ ] Critical flows smoke-tested: request, Lab, recollection, result release/review, critical ack, search.
- [ ] Realtime reconnect/degraded behavior verified.
- [ ] Error/correlation ID and audit trail inspected.

## Data/operations

- [ ] Backup succeeded; restore evidence is current.
- [ ] Health/readiness/metrics/log alerts route to owners.
- [ ] Outbox depth/retry/dead-letter is clear or understood.
- [ ] Release/rollback owner and incident contacts available.

## Communication

- [ ] Release notes describe behavior/config changes and known limitations.
- [ ] Pilot users trained on next actions, critical acknowledgement and offline state.
- [ ] Feedback window and success metrics baseline scheduled.
