# Evidência AAA-3 — restore PostgreSQL descartável

**Data:** 07/09/2026 04:52 (America/Sao_Paulo)  
**Classificação:** evidência local sintética; não é RPO/RTO aprovado nem aprovação de produção.

## Execução

- Node `v22.23.2`, PostgreSQL `16.15`, cluster novo em `127.0.0.1:55482`.
- Database source dedicado: `cvg_test_restore_source`.
- `npm run db:migrate`: migrations `001–010` aplicadas.
- Seed sintético autorizado somente para o database dedicado.
- `ALLOW_DB_RESTORE_SMOKE=true POSTGRES_DIRECT_URL=<loopback> npm run db:restore:smoke`, com `pg_dump`, `pg_restore` e `psql` PostgreSQL 16.15.

## Resultado observado

- Dump custom criado.
- Manifesto de recovery criado com `objectStatus=NOT_CAPTURED`.
- Checksum verificado: `checked=1`, `failures=[]`.
- Restore em database descartável separado concluído.
- Verificação da aplicação/dados: `1|1|0` para `cvg_runtime_state|audit_events|outbox_messages`.
- Log bruto temporário: `/tmp/cvg-aaa3-restore.G5s6tL/logs/restore-smoke.log`.
- SHA-256 do log: `efee24abddb28fa3aea246255801db2f98b5ef766eb4d0f55159313594e6118e`.
- O cluster foi parado ao final; o PostgreSQL persistente em `127.0.0.1:5432` não foi tocado.

## Limitações

O smoke valida apenas dump/manifesto/checksum/restore PostgreSQL em loopback. O manifesto explicitamente não captura object storage; anexos, chaves, configuração real, restore através da aplicação, RPO/RTO aprovado, workload, failover e aceite operacional continuam pendentes.
