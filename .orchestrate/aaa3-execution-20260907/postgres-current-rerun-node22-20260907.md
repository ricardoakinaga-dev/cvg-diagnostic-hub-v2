# PostgreSQL current rerun — environment condition

**Data:** 2026-09-07  
**Status:** `BLOCKED_ENVIRONMENT`; não é falha do produto nem evidência de
sucesso.  
**Guardrail:** o PostgreSQL persistente em `127.0.0.1:5432` foi mantido fora do
escopo.

## Verificação

A tentativa de abrir um cluster descartável em uma porta dedicada (`55496`)
não pôde iniciar porque o host não disponibiliza `initdb`/`pg_ctl` e não há
Docker disponível. A suíte não chegou a conectar ou aplicar migration; a
execução que retornou `ECONNREFUSED` foi descartada como evidência.

O último packet executado antes desta condição registra **39/39 em seis
arquivos** em PostgreSQL 16.15 descartável, mas é evidência condicional da
revisão anterior. Como esta rodada alterou o adapter realtime, ela não é
promovida automaticamente a prova do working tree atual.

## Próxima prova necessária

Executar em CI ou em um cluster descartável PostgreSQL 16, sempre com URL
loopback dedicada e `ALLOW_POSTGRES_INTEGRATION_TESTS=true`, a suíte completa,
incluindo `tests/postgres/realtime-listen.integration.test.ts` e
`tests/postgres/http-multi-instance.integration.test.ts`. Nenhum banco
persistente deve ser resetado para fechar este item.

