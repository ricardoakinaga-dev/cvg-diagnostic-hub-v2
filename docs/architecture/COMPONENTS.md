# Components and module contracts

**Knowledge status:** `IMPLEMENTED LOCALLY / CONDITIONAL FOR PRODUCTION` — os componentes abaixo existem e são exercitados por testes; contratos hospitalares e infraestrutura externa ainda precisam de aprovação.

## 1. Web application

`src/app` contém as páginas Next.js e `src/components` contém o shell, dashboards, filas, detalhe de solicitação, ações de workflow e resultado. A UI usa progressive disclosure, controles nomeados, estados de loading/empty/error/partial/degraded e atualiza a verdade por refetch após mutações. A jornada de resultado inclui revisão, edição/liberação de draft, emenda, invalidação, upload verificado e download autorizado.

## 2. API layers

```text
Next catch-all route
  → operation manifest + strict bounded parsing
  → session/CSRF/rate limit
  → application service
  → authorization + domain transition
  → StateStore/FileStore/scanner ports
  → audit/outbox response envelope
```

O cliente não escolhe actor, escopo ou estado. Cada mutação recebe `expectedVersion`/`If-Match` quando aplicável e idempotency key; falhas retornam envelope seguro com correlação.

## 3. Application modules

| Módulo | Arquivo | Responsabilidade |
| --- | --- | --- |
| requests | `request-service.ts` | criação contextual, duplicidade, cancelamento e leituras de request |
| workflows | `workflow-service.ts` | amostra/recoleta, RX/US, agenda, execução e estados |
| results | `result-service.ts` | draft, release, view/review, amend/void e versionamento |
| attachments | `attachment-service.ts` | sessão, claim de upload, bytes, scanner, finalize e download privado |
| management | `management-service.ts` | catálogo, motivos, usuários, escopos delegados e overview |
| reads | `read-service.ts` | filas, busca, timeline, dashboard, notificações e diagnósticos |
| shared context | `service-common.ts`, `service-types.ts` | autorização, views, invariantes, auditoria e contratos |

`service.ts` é apenas o agregador dos módulos. O limite de tamanho de fonte é verificado pelo gate arquitetural.

## 4. Infrastructure adapters

| Adapter | Implementação | Limite |
| --- | --- | --- |
| StateStore | `MemoryStore`, `PostgresStore` | Postgres usa snapshot JSONB transitório + projeções e readiness explícita |
| FileStore | local privado, S3-compatible | local é proibido em `NODE_ENV=production` |
| MalwareScanner | scanner local controlado, HTTP externo | modo local é proibido em produção; endpoint/chave são obrigatórios |
| Rate limiter | memória fora de produção, buckets PostgreSQL em produção | backend desconhecido ou indisponível falha fechado |
| Outbox | claim/lease/retry + token de ownership | conclusão exige worker e claim atuais dentro do lease |
| Realtime | SSE autorizado com polling/replay/resync; `postgres-listen` opt-in para wake-up multi-instância | conexão PostgreSQL real, duas instâncias, carga e propagação ainda não demonstradas |

## 5. Read models

Queues, dashboard, notification inbox, timeline and search are derived reads. They may be stale during dependency failure and expose that state; they never mutate clinical lifecycle. SSE only signals invalidation and clients refetch through authorization.

## 6. Future integration ports

Identity/IdP, HIS/ERP, LIS/analyzers, PACS/DICOM and external notification channels remain explicit boundaries. Their ownership, contract, retry, consent, retention and pilot acceptance must be decided before enabling them in a hospital environment.
