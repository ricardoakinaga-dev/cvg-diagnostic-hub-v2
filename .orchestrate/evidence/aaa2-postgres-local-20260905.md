# AAA2 PostgreSQL local execution evidence — 2026-09-05

**Estado:** `PASS` para a execução local isolada; `CONDITIONAL` para o aceite AAA-2 completo.

Foi usado um cluster PostgreSQL 16.15 descartável em loopback, inicializado no espaço do usuário a partir dos pacotes Ubuntu, sem Docker e sem alterar o sistema. O cluster foi removido após a execução. Nenhum segredo ou dado clínico real foi registrado neste packet.

## Gates executados

| Verificação | Resultado | Limite |
| --- | --- | --- |
| `npm run test:postgres` com `ALLOW_POSTGRES_INTEGRATION_TESTS=true` | **PASS** — 16/16 testes em 2 arquivos | É um cluster local de teste; não prova disponibilidade, sizing, EXPLAIN aprovado ou operação multi-host |
| `npm run db:smoke` após `npm run db:migrate` | **PASS** — estado, lock transacional, auditoria e outbox persistiram após reabertura | Smoke sintético e local; não é ensaio de produção |
| `npm run db:restore:smoke` com `ALLOW_DB_RESTORE_SMOKE=true` e `POSTGRES_DIRECT_URL` | **PASS** — banco descartável restaurado; resultado `1|1|0`; manifesto/checksum verificados | O script ainda identifica object storage como `NOT_CAPTURED`; não mede RPO/RTO nem restaura aplicação/chaves |
| `npm run perf:smoke` contra Next em `APP_DATA_MODE=postgres` | **PASS** — 80 requests, 0 erros, concorrência 4, p95 máximo 45,94 ms na última execução | Smoke local de baixa escala; não substitui workload aprovado, EXPLAIN, duas instâncias, SSE, recursos ou soak |

## Contrato operacional entregue

`scripts/backup-restore-smoke.sh` continua usando Docker Compose por padrão e agora aceita `POSTGRES_DIRECT_URL` para um alvo PostgreSQL direto. O modo direto cria um nome de banco descartável derivado do PID, reescreve somente o caminho da URL, executa `pg_dump`/`pg_restore` com manifesto e checksum, valida as contagens e remove o banco por `trap`. `PG_DUMP_BIN`, `PG_RESTORE_BIN` e `PSQL_BIN` permitem apontar para binários portáteis sem embutir dependência no repositório.

## Limites ainda abertos

- Browser E2E servido com PostgreSQL, duas instâncias reais, SSE compartilhado e cutover/rollback relacional ainda não foram executados.
- O schema relacional e o `PostgresStore` continuam uma fronteira transitória com autoridade JSONB; a execução PostgreSQL comprova persistência/concorrência dos contratos atuais, não a decisão de autoridade final.
- Restore de object storage, metadados KMS, RPO/RTO, workload hospitalar aprovado, CI remoto e aprovações humanas permanecem pendentes.
