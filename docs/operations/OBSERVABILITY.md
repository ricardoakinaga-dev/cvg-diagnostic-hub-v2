# Observability

**Knowledge status:** `IMPLEMENTED LOCALLY / DECISION PENDING` — o boundary técnico, a redação e a correlação estão implementados; thresholds, owners e roteamento de plantão ainda dependem de D-05.

## Current AAA-3 evidence (07/09/2026)

O working tree corrente passou `npm run validate` com **725/725 testes em 86 arquivos**, cobertura 92,72% statements/lines, 85,82% branches e 94,31% functions na execução full corrente. A matriz browser corrente passou 60/60 sem retry em Chromium/tablet/mobile, incluindo 12/12 de acessibilidade. O packet corrente e suas limitações estão no [manifesto AAA-3](../../.orchestrate/aaa3-execution-20260907/evidence-manifest.json). A evidência é local/condicional: não prova workload representativo, alert routing, failover ou readiness produtivo.

O boundary HTTP agora emite logs JSON estruturados somente com campos allowlisted (`event`, `level`, `component`, `method`, `route`, `status`, `durationMs` e correlação). Correlações controladas pelo chamador são emitidas como `external`; somente IDs `corr_<UUID>` gerados pelo servidor permanecem no log. Corpos, conteúdo clínico, credenciais, tokens, cookies, connection strings e payloads são descartados e labels têm limite de tamanho/cardinalidade. A emissão não altera o resultado de uma requisição quando o writer falha. O SBOM CycloneDX é gerado no CI pelo comando `npm run security:sbom` sob Node 22 e publicado como artefato de verificação.

**AAA-2:** [barra](../build/AAA_2_QUALITY_BAR.md) · [plano](../build/AAA_2_EXECUTIVE_PLAN.md) · [roadmap](../build/AAA_2_ROADMAP.md) · [backlog](../build/AAA_2_BACKLOG.md) · [auditoria de 05/09/2026](../RELATORIO_AUDITORIA_2026-09-05.md)

## Historical local evidence (05/09/2026)

`npm run perf:synthetic` passou com 372 requisições virtuais determinísticas, p50/p95/p99, concorrência 12 e 0 erros inesperados (leitura p95 104 ms, busca exata 60 ms, textual 171 ms). O [packet AAA2-042/043](../../.orchestrate/evidence/aaa2-perf-local-20260905.md) preserva o dataset e as limitações; o [packet PostgreSQL](../../.orchestrate/evidence/aaa2-postgres-local-20260905.md) adiciona smoke HTTP em banco durável com 80 requests, 0 erros e p95 máximo 45,94 ms na última execução. Esses ensaios são evidência local `CONDITIONAL`: não provam workload representativo, p99 de rede/servidor, operação multi-instância, alert routing, runbooks exercitados ou readiness produtivo.

## 1. Separate signals

- **Application logs:** technical execution, structured JSON, severity, module, route, latency, correlation ID and safe error code.
- **Audit events:** clinical/admin action history, immutable, actor/action/entity/state transition/timestamp/metadata.
- **Metrics:** aggregate technical/business measures; no full patient/result content.
- **Traces:** optional across API/storage/outbox/integration when latency/debugging demands it.

Never use application logs as the clinical timeline source.

## 2. Metrics contract: implemented and proposed

Technical (implemented locally): request count/latency/error by route, DB pool, storage failures, outbox depth/age/retries, SSE connections/reconnects, readiness failures and bounded backup signals exposed by the current metrics registry.
Business (proposed/pilot, not yet emitted by the current runtime): `diagnostic_requests_created`, `diagnostic_items_completed`, `diagnostic_turnaround_time`, `recollection_rate`, `critical_results`, `overdue_items`, `result_view_latency`. These require an approved owner, aggregation policy, thresholds and pilot instrumentation before they can be treated as production signals.

The local `GET /api/v1/metrics` implementation currently exposes the bounded technical registry; it does not claim to emit the business series above.

Metrics use bounded labels (service code, department code, priority); never patient name, result value or unbounded ID.

## 3. Correlation and audit

Every external request has correlation ID propagated to domain events/outbox and returned to client. Audit includes actor/system, event, entity, previous/new state, server timestamp and correlation. Access to audit is itself auditable.

## 4. Health endpoints

- `/livez`: process is alive; no dependency cascade.
- `/readyz`: can safely accept required traffic; checks PostgreSQL, migration compatibility and storage as configured. Outbox worker lag may mark degraded rather than lie about clinical command safety.

No health endpoint includes secrets, connection strings or patient data.

The local artifact exposes `GET /api/v1/metrics` to an administrator with `health.readiness`. It returns Prometheus text with bounded HTTP counters/duration summaries, outbox depth/oldest age, readiness failures and active SSE connections; unauthenticated or non-admin callers receive the safe API error boundary. Readiness checks the runtime state/schema and configured storage health. The registry is process-local and must be replaced or federated with the approved metrics backend before production.

## 5. Alerts/runbooks

Alert on: readiness failure, error-rate/latency threshold, outbox age/dead letters, critical notification unacknowledged beyond policy, storage/backup failure, auth abuse and SSE reconnect storm. The initial ownership/runbook map is:

| Alert | Owner area | Runbook | User/clinical action |
| --- | --- | --- | --- |
| readiness/database failure | TI/On-call | incident + restore/runbook | stop retry storms; use approved fallback communication |
| outbox age/dead letters | TI + Operations | outbox retry/dead-letter procedure | inspect critical notifications; manual escalation if policy requires |
| critical ack overdue | Direção clínica/sector manager | critical-result workflow | identify recipient/fallback and record acknowledgement |
| storage/scan failure | TI/Security | attachment quarantine/storage incident | do not release affected result with unsafe attachment |
| backup failure/restore mismatch | TI/Operations | [`BACKUP_RESTORE.md`](BACKUP_RESTORE.md) | block release gate until recovery evidence exists |
| auth abuse/IDOR signal | Security/TI | security incident response | revoke session/contain; preserve audit |
| SSE reconnect storm | TI | realtime degraded procedure | banner/polling fallback; no false final state |
| API latency/error budget | Engineering/Operations | performance triage | prioritize queue degradation and user communication |

Every alert links to an owner/runbook, records correlation/incident ID and states whether user action is required. Owners are areas pending named assignment during pilot; no individual is invented here.

## 6. SLO proposals

Initial targets are proposals: API read p95 ≤500 ms, command p95 ≤800 ms under pilot load, search p95 ≤800 ms, realtime propagation p95 ≤2 s, no silent event loss. Validate workload and thresholds before release; report p50/p95/p99/error rate, not only average.
