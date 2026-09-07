# AAA2-011/012/013/014/015/016/020 — fatia relacional local

**Data:** 05/09/2026  
**Escopo:** endurecimento local da fronteira relacional, backfill e reconciliação  
**Ambiente:** working tree compartilhado; Node/npm do host; nenhum PostgreSQL vivo foi usado

## Entregas verificáveis

- `src/server/store/relational/backfill.ts` agora verifica o hash do alvo depois de cada `upsert`, rejeita transformação silenciosa, detecta cursor estacionário e impede provider de pular além da última linha emitida.
- `src/server/store/relational/cutover.ts` define o contrato explícito `SNAPSHOT`/`SHADOW`/`RELATIONAL`, exige oito gates para autoridade relacional (`schemaReady`, backfill, reconciliação limpa, leitura/escrita, atomicidade, rollback e aprovação operacional) e produz reconciliação por entidade usando hashes, sem copiar conteúdo clínico para evidência.
- `PostgresStore.reconcileRelationalClinicalRequest` executa uma sondagem dual-read em uma transação `REPEATABLE READ`; `cvg_runtime_state` continua sendo a autoridade e nenhum método altera o modo de runtime.
- `RelationalClinicalCoreAdapter` exige, além do marker/tabelas/write-shape, os constraints de linhagem, ponteiros, unicidade de versão, vínculo de amostra e deduplicação de notificações; leituras rejeitam request fora do escopo e IDs duplicados.
- O parser do agregado foi separado em `clinical-core-read.ts` e os contratos SQL/runtime em `clinical-core-contracts.ts`, mantendo o adapter abaixo do limite arquitetural de 800 linhas e o grafo acíclico.
- Os testes cobrem rollback da escrita relacional antes do commit do snapshot, transação compartilhada, readiness fail-closed, reconciliação, divergência por hash, cursor inválido/estacionado e pós-write não durável.

## Provas executadas

| Comando | Resultado |
| --- | --- |
| `npx vitest run src/server/store/relational/cutover.test.ts src/server/store/relational/backfill.test.ts src/server/store/relational/clinical-core-adapter.test.ts src/server/store/postgres-store.test.ts` | **PASS — 32 testes / 4 arquivos** |
| `npm test` | **PASS — 513 testes / 63 arquivos** |
| `npm run typecheck` | **PASS** |
| `npx eslint src/server/store/relational src/server/store/postgres-store.ts src/server/store/postgres-store.test.ts` | **PASS** |
| `npm run validate:migrations` | **PASS — migrations 001–008 e checksums canônicos** |
| `git diff --check` | **PASS** |

## Limites e gates ainda abertos

- A migration 007/008 continua expand-only; nenhuma migration foi executada neste packet. FKs, checks, índices, locks, rollback SQL e `EXPLAIN` continuam sem prova de PostgreSQL vivo.
- O backfill continua storage-neutral; não houve corpus institucional, contagem de órfãos, reconciliação executada em banco ou restart de processo.
- A reconciliação dual-read é uma ferramenta de evidência e não promove `RELATIONAL` a autoridade. O guard permite avaliar um futuro contrato apenas quando todos os oito gates forem fornecidos; a aplicação atual segue snapshot/shadow.
- AAA2-011 e AAA2-020 permanecem bloqueadas pelo ambiente/opt-in PostgreSQL; AAA2-014/016 dependem de modelo e políticas institucionais; AAA2-015 não é DONE sem cutover e prova de autoridade relacional.
- Não há alegação de integração PostgreSQL, cutover, rollback/roll-forward real, concorrência entre instâncias ou desempenho.
