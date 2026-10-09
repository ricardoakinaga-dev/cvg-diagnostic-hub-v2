# Observability

**Knowledge status:** `IMPLEMENTED LOCALLY / DECISION PENDING` — o boundary técnico, a redação e a correlação estão implementados; thresholds, owners e roteamento de plantão ainda dependem de D-05.

## Current AUDIT-2026-10 evidence (02/10/2026)

A auditoria de 04/10/2026 ([relatório](../RELATORIO_AUDITORIA_2026-10-04.md)) passou `npm test` com **1.449/1.449 testes em 126 arquivos** e `npm run test:postgres` com **96/96 em 17 arquivos**. A cobertura agregada registra 96,83% lines, 95,48% functions e 89,47% branches; `coverage:gate` passou com 22 exceções temporárias sem entradas stale. Migrations 001–014, docs, OpenAPI 73/68, traceabilidade 43/43, security scan, typecheck, lint, build, E2E 81/81 sem retry e mutation 7/7 passam. A evidência é local/condicional: não prova workload representativo, alert routing, failover ou readiness produtivo.

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
Business (bounded local snapshots, not yet approved as production SLOs): `diagnostic_requests_created`, `diagnostic_items_completed`, `diagnostic_turnaround_time_seconds`, `recollection_rate`, `critical_results`, `overdue_items`, `result_view_latency_seconds`. The runtime emits counts, averages and the recollection fraction without patient labels; owners, aggregation policy, thresholds and pilot validation remain pending before these can be treated as production signals.

The local `GET /api/v1/metrics` implementation exposes the bounded technical registry and these process-local business snapshot gauges. Derived gauges with no valid observations are omitted rather than rendered as fabricated zeroes.

Metrics use bounded labels (service code, department code, priority); never patient name, result value or unbounded ID.

`cvg_attachment_scans_total{status="CLEAN"|"QUARANTINED"|"FAILED"}` (PROD-308) counts every upload scanned by the malware scanner; a `QUARANTINED` increase fires `CvgAttachmentQuarantined` for the quarantine owner ([INCIDENT_RUNBOOKS.md](INCIDENT_RUNBOOKS.md#storage-upload-ou-scanner-av-indisponível)). The matching log event `attachment.quarantined` carries the attachment and result-version ids and the MIME pair, never the file name or content.

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
| storage/scan failure or attachment quarantined (`CvgAttachmentQuarantined`) | TI/Security (quarantine owner, PROD-308) | [attachment quarantine/storage incident](INCIDENT_RUNBOOKS.md#storage-upload-ou-scanner-av-indisponível) | do not release affected result with unsafe attachment |
| backup failure/restore mismatch | TI/Operations | [`BACKUP_RESTORE.md`](BACKUP_RESTORE.md) | block release gate until recovery evidence exists |
| auth abuse/IDOR signal | Security/TI | security incident response | revoke session/contain; preserve audit |
| SSE reconnect storm | TI | realtime degraded procedure | banner/polling fallback; no false final state |
| API latency/error budget | Engineering/Operations | performance triage | prioritize queue degradation and user communication |

Every alert links to an owner/runbook, records correlation/incident ID and states whether user action is required. Owners are areas pending named assignment during pilot; no individual is invented here.

## 6. SLO proposals

Initial targets are proposals: API read p95 ≤500 ms, command p95 ≤800 ms under pilot load, search p95 ≤800 ms, realtime propagation p95 ≤2 s, no silent event loss. Validate workload and thresholds before release; report p50/p95/p99/error rate, not only average.

## 7. Logs agregados e busca por correlationId (PROD-512)

**O que é.** Uma pilha separada da aplicação, um projeto Compose por servidor ([`docker-compose.observability.yml`](../../docker-compose.observability.yml), D-047):

| Serviço | Papel |
| --- | --- |
| `docker-proxy` | Proxy da API do Docker que só permite `GET` em `/containers` e `/networks`. O coletor nunca toca no socket. |
| `alloy` | Lê os logs dos containers dos projetos que casam com `CVG_LOG_PROJECT_REGEX` (padrão `cvg-(hml\|prod)`) e os envia ao Loki com os rótulos `project`, `service` e `level`. |
| `loki` | Guarda os logs por `LOKI_RETENTION_PERIOD` (padrão `720h`, 30 dias). Sem porta publicada. |
| `grafana` | Consulta. Escuta só em `127.0.0.1:${GRAFANA_PORT:-3001}`, sem acesso anônimo e sem cadastro; acesso pela VPN ou por túnel SSH (PROD-309). |

**Subir:**

```bash
docker compose -p cvg-obs -f docker-compose.observability.yml --env-file /etc/cvg-hub/obs.env up -d
```

O `obs.env` precisa de `GRAFANA_ADMIN_PASSWORD`, que é obrigatório e fica no cofre de segredos. Opcionais: `GRAFANA_ADMIN_USER`, `GRAFANA_PORT`, `LOKI_RETENTION_PERIOD`, `CVG_LOG_PROJECT_REGEX` e os limites de memória `LOKI_MEM_LIMIT`, `ALLOY_MEM_LIMIT` e `GRAFANA_MEM_LIMIT`.

**Buscar uma requisição ou um job.** A resposta da API traz o cabeçalho `x-correlation-id`, e a auditoria traz `correlation_id`. No Grafana, em **Explore → Loki**:

```
{project="cvg-prod"} | json | correlationId="corr_<uuid>"
```

Outras consultas úteis:
- erros do app nas últimas 24 h: `{project="cvg-prod", service="app", level="error"}`;
- ciclos do worker: `{project="cvg-prod", service="worker"} | json | event="outbox.batch"`;
- cópia externa: `{service="offsite"} |= "offsite."`.

A mesma `correlationId` liga o log técnico à trilha de auditoria (`audit_events.correlation_id`), que continua sendo a fonte da linha do tempo clínica (§1).

**O que nunca entra.** Os logs do app só têm campos permitidos (sem corpo, conteúdo clínico, credencial ou token), e o `privacy:scan` confere os logs da CI. O serviço `bootstrap` não tem driver de log, então nenhum link de redefinição de senha chega ao Loki.

**Prova.** `npm run logs:check` sobe a pilha com as imagens fixadas num projeto descartável e confere:
- a configuração do Alloy e a do Loki carregam;
- um container de um projeto selecionado que imprime uma linha JSON é achado pelo `correlationId`, com os rótulos `project`, `service` e `level`;
- um container de outro projeto não é coletado;
- o Grafana sobe com a datasource do Loki saudável.

Roda na CI (job `verify`) e leva cerca de 30 s com as imagens em cache.
