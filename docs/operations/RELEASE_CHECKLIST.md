# Release checklist

**Knowledge status:** `DECISION/PROPOSAL` de processo de release; só pode ser marcado com evidência após BUILD.

**AAA-3:** [plano](../build/STATE_OF_ART_TRIPLE_AAA_EXECUTIVE_PLAN.md) · [roadmap](../build/STATE_OF_ART_TRIPLE_AAA_ROADMAP.md) · [backlog](../build/STATE_OF_ART_TRIPLE_AAA_BACKLOG.md) · [auditoria de 07/09/2026](../RELATORIO_AUDITORIA_2026-09-07.md) · [manifesto](../../.orchestrate/aaa3-execution-20260907/evidence-manifest.json)

Use for every pilot/production release; checkboxes require evidence link or command output.

## Current local evidence (07/09/2026)

The current AAA-3 candidate passes 725/725 tests in 86 files, 92.72/85.82/94.31 coverage (lines/branches/functions) in the latest full run. Build, security scan, production audit, SBOM CycloneDX with 560 components under Node 22, recovery 5/5, performance 7/7, OpenAPI 65/60, traceability 43/43 and migrations 001–010 pass. Browser evidence is 60/60 across the full matrix (core, clinical, accessibility 12/12 and realtime) across Chromium/tablet/mobile without retry; the current rerun is recorded in [`browser-e2e-node22-accessibility-20260907.md`](../../.orchestrate/aaa3-execution-20260907/browser-e2e-node22-accessibility-20260907.md). The previous disposable PostgreSQL packet passes 39/39 on Node 22/PostgreSQL 16.15; a current source rerun is conditioned on a disposable cluster because this host lacks `initdb`/`pg_ctl`/Docker. The production-like local lane also passes 51/51 against `next start`, PostgreSQL, synthetic S3/HTTPS scan services and a durable outbox worker; PostgreSQL-only restore smoke passes with checksum and an isolated restored database. No release item below is marked complete by these local results.

## Historical local evidence (06/09/2026; superseded)

The superseding local evidence is the [broad G4 packet](../../.orchestrate/evidence/aaa3-g4-broad-coverage-20260906.md), the [current Patient Workspace packet](../../.orchestrate/evidence/v2-patient-workspace-current-20260906.md), the [visual v8 packet](../../.orchestrate/evidence/visual-patient-workspace-20260906-v8/manifest.json), the [current PostgreSQL packet](../../.orchestrate/evidence/v2-relational-sample-lineage-postgres-current-20260906.md), the [production-like PostgreSQL browser packet](../../.orchestrate/evidence/aaa3-browser-postgres-production-s3-20260906.md) and the [final notification-projection packet](../../.orchestrate/evidence/aaa3-final-revalidation-20260906-post-notification-projection.md): `npm run test:coverage` validates 619/619 in 75 files with 91,85% statements/lines, 85,09% branches and 94,28% functions across the G4 executable scope; build with 12 static pages; no-retry E2E 51/51 including 6/6 accessibility scenarios; disposable PostgreSQL 33/33 complete; plus 51/51 no-retry Chromium/tablet/mobile scenarios against `next start`, PostgreSQL, synthetic S3/scan services and a durable outbox worker. Security/audit, performance 7/7 and recovery 5/5 also pass locally. The v8 critic is the current visual gate; v6 is historical and v7 is retained as a rejected intermediate packet. The persistent `127.0.0.1:5432` database was untouched. This does not check any release item below as complete.

`npm ci`, `npm test`/`npm run test:coverage` (619/619), typecheck/lint/build, `npm run validate:docs`, `npm run validate:openapi` (65 operações/60 paths), `npm run security:scan`, `npm audit --audit-level=high` e `npm run validate:traceability` passaram; `fast-uri` está em 3.1.7 e audit reportou 0 vulnerabilidades. O packet PostgreSQL corrente registra 33/33 no cluster descartável, enquanto os packets históricos permanecem preservados para seus próprios counts. O packet HTTP mantém a evidência de duas instâncias em `next dev` e `next start`, sessão cross-process, fanout SSE e replay `Last-Event-ID`. A corrida E2E atual passou 51/51 e a acessibilidade 6/6; o packet visual v8 mantém a separação entre passe local, crítica independente, evidência-alvo e aceite humano. A cobertura de branches corrente supera o alvo G4 de 85%; a matriz tem inventário estrutural completo, enquanto os packets locais continuam condicionais. Não há workload representativo, failover operacional, storage/AV real ou aprovação de produção atuais; o checklist permanece aberto.

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
# AAA-3 candidate verification

Before treating the local candidate as a review packet, run:

```bash
npm run validate:aaa3
```

The verifier fails closed if the current coverage, test-count evidence, fresh
independent-review packet, required artifacts, release disposition or candidate
fingerprint drifts. It does not grant clinical, hospital, infrastructure or
release approval; the manifest must remain `BLOCKED_REVIEW_REQUIRED` until the
external gates are closed by their authorized owners.
