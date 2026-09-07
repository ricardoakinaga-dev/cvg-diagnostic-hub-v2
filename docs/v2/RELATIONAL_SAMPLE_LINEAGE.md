# V2 — integridade da lineage de amostras

## Objetivo

Fechar a fronteira local de projeção relacional para sample/accession sem
habilitar cutover. O `PostgresStore` continua tendo o snapshot JSONB como
autoridade; as migrations 007–009 recebem apenas uma projeção transacional,
auditável e fail-closed.

## Contrato congelado

- `accessionCode` é canônico em maiúsculas, segue `^[A-Z0-9][A-Z0-9-]{2,39}$`
  e é único no escopo relacional de `samples`.
- `receiveSample` e `receiveReplacement` rejeitam accession inválido, duplicado
  ou não normalizado também quando chamados diretamente pelo application
  service; a validação HTTP não é a única barreira.
- `receiveSample` rejeita `itemIds` duplicados. Cada item vinculado pertence à
  mesma request do sample e cada vínculo é representado uma única vez.
- Recoleta é append-only na lineage: a amostra recebida permanece no snapshot
  com `status: REPLACED` e sua versão avança; a nova amostra aponta para ela por
  `replacesSampleId`, nasce `EXPECTED` e mantém os mesmos itens.
- Um replacement recebido avança a mesma entidade para `RECEIVED`, preserva o
  predecessor e nunca reutiliza o accession rejeitado.
- `replacesSampleId` deve apontar para uma amostra existente da mesma request,
  nunca para si mesma, e a cadeia deve ser acíclica.
- A migration 009 adiciona no PostgreSQL as constraints de formato canônico de
  accession, reason obrigatório para `REPLACED`, membership não vazio de itens e
  enum fechado de `sample_item_links.link_status`; o readiness verifica tabela,
  schema, nome, tipo, definição e `convalidated` dessas constraints.
- `samples.item_ids` preserva a expectativa de membership que não existe na
  tabela de links; a leitura relacional exige que cada item declarado tenha
  exatamente um link correspondente e rejeita links extras.
- A projeção `sample_item_links` é derivada do snapshot:
  `EXPECTED`/`RECEIVED → ACTIVE`, `REJECTED → REJECTED` e
  `REPLACED → REPLACED`. O vínculo preserva `linked_at`, `linked_by`,
  `rejection_note` e usa a versão do sample como versão derivada do vínculo.
- O adapter atualiza vínculos existentes com predicado otimista; não remove
  vínculos históricos nem aceita órfãos, duplicidades ou metadata relacional
  incompatível.
- A leitura/reconciliação relacional valida predecessor, request, accession,
  status, reason, versão e vínculos antes de qualquer uso do aggregate.
- Inserts versionados repetidos são aceitos somente quando o row existente
  coincide em todos os campos projetados; qualquer replay divergente falha com
  conflito explícito.
- A migration 009 tenta recuperar `samples.item_ids` vazios apenas de relações
  já persistidas no snapshot JSONB ou em tabelas relacionais existentes
  (`sample_item_links`/`diagnostic_request_items`); não inventa membership
  clínico. Linhas que continuam sem fonte lossless ficam `NOT VALID` até uma
  correção explícita.
- A reparação de rows legados e a validação final são operações de readiness
  exclusivas do modo `BACKFILL`; o caminho normal permanece estrito e rejeita
  membership não validado antes da projeção.

## Backfill shadow local

A migration 010 cria `relational_backfill_runs`, um ledger durável de execução
com escopo, versão de transformação, versão/hash do snapshot, cursor por
request, contagens e status. `PostgresStore.backfillRelationalClinicalCore`
processa as dez tabelas do núcleo clínico em lotes de requests inteiras,
mantém os ciclos de FK diferidos na transação, grava o checkpoint no mesmo
commit das linhas projetadas e usa advisory lock por `runId` para impedir duas
execuções concorrentes do mesmo trabalho.

O backfill lê uma única versão/hash do `cvg_runtime_state` por execução, mantém
o lock pessimista da linha-fonte até o commit de cada checkpoint e falha fechado
se outra escrita alterar o snapshot entre lotes. Após cada request, o
adapter faz dual-read no mesmo snapshot PostgreSQL e a reconciliação compara
somente hashes; ao final, as chaves exatas das dez tabelas e as FKs do banco são
conferidas para detectar órfãos ou rows extras. Um run interrompido pode ser
retomado pelo mesmo `RELATIONAL_BACKFILL_RUN_ID`; um run `COMPLETED` também
revalida, em uma transação `REPEATABLE READ`, as chaves exatas e cada aggregate
contra o snapshot antes de retornar sucesso. Corrupção posterior do shadow
falha fechado, preserva o status concluído do ledger e nunca promove autoridade.

Este é um backfill local, populado e reconciliável do escopo
`CLINICAL_CORE_REQUESTS`, não uma migração completa de 007–010. Dependências de
catálogo/identidade precisam existir previamente; owners, roles, políticas,
`result_components`, deliveries, acknowledgements e idempotency continuam sem
origem lossless no `StoreState` e não recebem defaults fabricados.

## Evidência e limites

A fatia exige RED/GREEN de application, adapter, leitura e reconciliação, além
de regressão completa, build e contrato OpenAPI. A integração PostgreSQL real
está comprovada no [packet corrente 33/33](../../.orchestrate/evidence/v2-relational-sample-lineage-postgres-current-20260906.md)
em cluster descartável. O packet corrente cobre constraints 009, reparação
explícita de legacy row, projection/read/reconciliation, backfill populado,
checkpoint/retomada, idempotência, lock de origem, serialização entre pools,
completude por chaves exatas, rollback atômico, corrupção pós-completion,
EXPLAIN indexado, HTTP multi-instância e LISTEN/NOTIFY. A primeira execução
permanece preservada no packet histórico
[`v2-relational-sample-lineage-postgres-20260906.md`](../../.orchestrate/evidence/v2-relational-sample-lineage-postgres-20260906.md),
incluindo constraints 009, replay idempotente, rollback transacional, a
projeção/read/reconciliation da seam e `EXPLAIN` estrutural indexado sob fan-out
de distração. O packet específico
[`v2-relational-sample-lineage-backfill-20260906.md`](../../.orchestrate/evidence/v2-relational-sample-lineage-backfill-20260906.md)
registra o teste focado histórico 9/9 e a suíte completa histórica 30/30, além da execução populada
do backfill request-scoped, ledger 010, checkpoint/retomada, idempotência,
lock de origem, serialização entre pools, completude por chaves exatas,
preservação da autoridade JSONB e rejeição de source drift. A crítica
independente e suas disposições estão no packet complementar
[`v2-relational-sample-lineage-backfill-critic-20260906.md`](../../.orchestrate/evidence/v2-relational-sample-lineage-backfill-critic-20260906.md).
O hardening posterior do replay `COMPLETED`, incluindo o RED real de corrupção
do shadow, a revalidação em `REPEATABLE READ` e os críticos frescos `NOT_RUN`,
está no packet atual
[`v2-relational-sample-lineage-replay-hardening-20260906.md`](../../.orchestrate/evidence/v2-relational-sample-lineage-replay-hardening-20260906.md).
Backfill completo 007–010, EXPLAIN aprovado/representativo de produção,
dual-read contínuo em ambiente-alvo, cutover, browser sobre a seam relacional
e ambiente de produção continuam gates externos; nenhuma dessas condições é
simulada por este documento.
