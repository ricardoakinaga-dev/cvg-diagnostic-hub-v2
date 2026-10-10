# Production readiness

**Knowledge status:** `DECISION` de gates; o status atual é uma avaliação documental, não evidência de produção.

**AAA-3:** [plano](../build/STATE_OF_ART_TRIPLE_AAA_EXECUTIVE_PLAN.md) · [roadmap](../build/STATE_OF_ART_TRIPLE_AAA_ROADMAP.md) · [backlog](../build/STATE_OF_ART_TRIPLE_AAA_BACKLOG.md) · [auditoria de 07/09/2026](../RELATORIO_AUDITORIA_2026-09-07.md) · [manifesto](../../.orchestrate/aaa3-execution-20260907/evidence-manifest.json)

Deploy path: [DEPLOYMENT.md](DEPLOYMENT.md) (images, first-admin bootstrap, migrations, TLS edge).

Status: `NOT READY` until implementation, operational validation and human gates exist. This checklist defines what “ready” must prove.

## Audit of 2026-10-10 (current)

> [Relatório de prontidão de 10/10/2026](../RELATORIO_PRONTIDAO_2026-10-10.md): os quatro bloqueadores técnicos da auditoria (notificação depois de reduzir o acesso, emenda sem aviso, crítico sem saída operacional, gargalo do snapshot) estão corrigidos e cobertos por teste (D-055, D-056, D-058, D-059, D-061); o worker de produção, que não subia desde o #63, sobe (D-057); toda imagem diz de que commit veio (D-060). Provas locais: restore completo de banco e anexos com reconciliação (RPO 8–10 s, RTO 21–26 s), indisponibilidade de cada componente com as regras do Prometheus (D-062), [carga hospitalar](../RELATORIO_CARGA_HOSPITALAR_2026-10-10.md) com margem de 50× o pico D2 estimado, falhas sob carga sem perda e soak de 2 h. O status continua `NOT READY`: servidor de homologação, nomes da operação, conteúdo clínico, pentest, UAT, piloto e go/no-go são do hospital (§4 do relatório).

## Current local evidence (02/10/2026)

> **Audit 02/10/2026:** [report](../RELATORIO_AUDITORIA_2026-10-02.md) — new critical finding F-01: the JSONB snapshot serializes every store operation per process and grows without pruning (~0.6 s CPU per request at 100k audit events). The item "JSONB snapshot replaced or formally approved" below can no longer be closed by approval alone; it is tracked as PROD-101…111 in the [production backlog](../build/PRODUCTION_BACKLOG.md).

> Audit of 2026-10-04 ([report](../RELATORIO_AUDITORIA_2026-10-04.md)): `npm test`
> passes 1,449/1,449 tests in 126 files and `npm run test:postgres` passes 96/96
> in 17 files. The merged coverage run records 96.83% lines, 95.48% functions and
> 89.47% branches; `coverage:gate` passes with 22 declared temporary exceptions
> and no uncovered or stale entries. Migrations (001-014), docs, OpenAPI (73/68),
> traceability, security scan, typecheck, lint, build, browser 81/81 and mutation
> 7/7 pass. The candidate
> remains `NOT READY`: target load/failover (PROD-110), real storage/AV, full
> restore/RPO/RTO, remote CI and human/clinical acceptance remain open.
> The current candidate is `NOT READY` and the checklist below remains open.

## Historical local evidence (06/09/2026; superseded)

> **AUD-022 (01/10/2026): a linha `614/614` abaixo é histórica — era AAA-2 de 06/09/2026 — e a execução integrada de 01/10 também foi supersedida pela candidata de 02/10.** A candidata atual passa `npm test` em **768/768 testes de 91 arquivos** e a cobertura agregada PostgreSQL passa 809/809 em 98 arquivos.
>
> O pacote desta era registra `npm run
> test:coverage` at 614/614 tests in 75 files and 92.01% statements/lines, 85.00%
> branches and 94.36% functions across the widened G4 executable scope; migration-010 shadow backfill PostgreSQL at
> 9/9 focused and 30/30 full-suite tests; build with 15 application routes; explicit
> no-retry E2E 60/60; explicit no-retry accessibility 12/12; security/audit,
> performance 7/7 and recovery 5/5. The complete evidence and independent
> critic disposition are in the [final backfill packet](../../.orchestrate/evidence/v2-relational-sample-lineage-backfill-20260906.md)
> and [critic report](../../.orchestrate/evidence/v2-relational-sample-lineage-backfill-critic-20260906.md).
> The final notification-projection revalidation is recorded in the [AAA-3 packet](../../.orchestrate/evidence/aaa3-final-revalidation-20260906-post-notification-projection.md).
> The superseding [production-like browser packet](../../.orchestrate/evidence/aaa3-browser-postgres-production-s3-20260906.md)
> adds 51/51 no-retry scenarios across Chromium, tablet and mobile against `next start`, PostgreSQL, synthetic
> S3/HTTPS scan services and a durable PostgreSQL outbox worker.

The local synthetic artifact has executable evidence for session/RBAC/CSRF/scope, patient registration with initial encounter/admission, request-flow patient creation and user account, API envelopes and health, core Lab/RX/US/result/file flows, scoped search/filter/timeline/dashboard contracts, scoped cancellation and delegated-manager revocation, ADMIN/delegated-MANAGER versioned collaborator administration with recent re-authentication and soft deactivation, session listing/revocation, audited outbox dead-letter controls, manager control/catalog/reason surfaces, bounded metrics, private local/S3-compatible storage adapters, explicit external malware-scanner and production-storage fail-closed factories, distributed-rate-limit schema readiness, token-owned outbox leases, transfer-context commands gated by D-01, bounded SLA calculation fallback, scoped identity normalization, stable queue cursors and focused registry/API/UI tests. The current candidate passes 768/768 unit/API/UI tests in 91 files and 41/41 PostgreSQL integration tests; aggregate coverage and the gate pass. Build and browser evidence now pass. The program continues REJECT because target load/failover, complete SLA/transfer policy and release approvals are absent.

O alias PostgreSQL está corrigido. O packet V2 de backfill [`v2-relational-sample-lineage-backfill-20260906.md`](../../.orchestrate/evidence/v2-relational-sample-lineage-backfill-20260906.md) registra a execução populada, request-scoped e resumível da migration 010, com 9/9 focado e 30/30 na suíte PostgreSQL 16.15 descartável, mantendo JSONB como autoridade; o packet HTTP [`aaa3-http-multi-instance-20260906.md`](../../.orchestrate/evidence/aaa3-http-multi-instance-20260906.md) mantém sua própria evidência de duas instâncias HTTP em `next dev` e `next start`, sessão cross-process, fanout SSE autorizado e replay `Last-Event-ID`. O packet browser production-like [`aaa3-browser-postgres-production-s3-20260906.md`](../../.orchestrate/evidence/aaa3-browser-postgres-production-s3-20260906.md) adiciona 51/51 sem retry nos projetos Chromium, tablet e mobile com `next start`, PostgreSQL, S3/scan sintéticos e worker outbox durável. O packet AAA-2 anterior permanece histórico e registra também `db:smoke`, `db:restore:smoke` direto e `perf:smoke`. Os 51 casos Playwright passam em uma corrida única sem retry, usando servidores de memória sintética isolados por projeto; o Patient Workspace inclui a preservação do snapshot confirmado quando o refresh fica indisponível; `npm run test:accessibility` passou 6/6. Esses gates locais não são aceite representativo: object storage/chaves reais, workload aprovado, restart/failover, RPO/RTO, CI remoto e decisões humanas continuam abertos. Esta evidência não marca nenhum item do checklist como concluído.

The remaining release blockers are explicit: the local HTTP packet is process-level synthetic evidence and does not cover a target multi-instance deployment under representative load, the relational clinical migration remains a transitional shadow beside the JSONB authority, hospital identity/ownership and transfer/alta policy, approved critical-result/fallback policy, production object storage/AV/credentials, restart/failover operations, manual accessibility/clinical acceptance, approved RPO/RTO and retention, remote CI execution and pilot sign-off. The local `next start` reconnect/replay check is not a target deployment or operational failover rehearsal. Production readiness now also rejects an omitted or process-local realtime adapter when PostgreSQL is the data mode; the local PostgreSQL and restore/performance passes do not silently mark the product as production-ready.

Atualização de evidência em 06/09/2026: a matriz visual v6 fecha a cobertura
local de estados/viewports e inclui a timeline densa colapsada/expandida; o
parecer independente é `APPROVED_LOCAL`. Isso não substitui os gates manuais,
golden do produto, alvo e humanos. A integração PostgreSQL de
recoleta/rollback foi reexecutada na suíte descartável AAA-3 anterior; a
repetição current-source aguarda um host com cluster descartável e o
PostgreSQL persistente em `127.0.0.1:5432` não foi tocado.

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
- [ ] The current JSONB snapshot is replaced or formally approved as a transitional boundary (10/10/2026: approved technically for the D2 volume with measured headroom and objective triggers for PROD-111, D-061; awaits the product owner's sign-off); relational clinical constraints, indexes and representative `EXPLAIN` evidence are reviewed. The local browser packet covers durable snapshot reads only and does not close this item.
- [ ] PostgreSQL + object storage backups verified and restore drill passed against approved RPO/RTO. A local PostgreSQL-only restore smoke now passes with manifest/checksum verification; object storage, application recovery and approved RPO/RTO remain external.
- [ ] `/livez`, `/readyz`, logs, metrics, correlation, outbox retry/dead letter and alert routing tested.
- [ ] Storage scan/quarantine and signed downloads work.
- [ ] Incident, critical notification and degraded-network runbooks rehearsed.

## Quality/UX

- [ ] Unit/integration/API/E2E/accessibility/security suite passes; business coverage ≥80%.
- [ ] Responsive desktop/tablet/mobile critical states inspected.
- [ ] Loading, empty, partial, error, offline/degraded and permission denied flows verified.
- [ ] Performance targets measured with representative hospital data/concurrency. A local PostgreSQL HTTP smoke recorded 80 requests with 0 errors and maximum p95 45,94 ms in the latest run; the deterministic synthetic harness and this smoke remain conditional and are not representative-load sign-off.
- [ ] No fake implementation, silent error, critical pending item or unowned alert.

## Deployment

- [ ] Environment separation and secret manager configured.
- [ ] TLS/reverse proxy, database/storage access and least-privileged service accounts reviewed.
- [ ] Smoke test, release notes, rollback and support owner defined.
- [ ] Pilot scope and feedback loop approved.
