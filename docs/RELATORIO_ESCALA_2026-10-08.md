# Relatório de escala do runtime — 08/10/2026

**Escopo:** correção do bloqueio de escala apontado na auditoria de prontidão de 07/10/2026 (veredito "não está pronto"), mantendo o contrato `StoreState` e a autoridade SNAPSHOT. Decisão registrada em [D-030](DECISION_LOG.md); item [PROD-112](build/PRODUCTION_BACKLOG.md).

## 1. Problema medido em 07/10

O agregado de runtime era um único documento JSONB. Toda leitura clonava o estado inteiro, toda referência era resolvida por busca linear e toda escrita regravava o documento. Com o lote real de 27 exames clonado até o volume de cada faixa (≈150 exames/dia):

| Faixa | Snapshot | Lista de solicitações | 20 usuários simultâneos | Escrita | RSS |
| --- | --- | --- | --- | --- | --- |
| 1 mês (4,5 mil exames) | 6,7 MB | 198 ms | ~4,1 s | ~0,9 s | 736 MB |
| 6 meses (27 mil) | 39 MB | 9,8 s | todas > 120 s | 4,9 s | 1,8 GB |
| 12 meses (55 mil) | 79 MB | 57 s | — | 26,6 s | 2,1 GB (login de 10–16 s) |

Teto rígido: 110 mil exames (159 MB) ainda gravavam; 160 mil (231 MB) falhavam com `total size of jsonb object elements exceeds the maximum of 268435455 bytes` (SQLSTATE 54000).

## 2. O que mudou

1. **Snapshot congelado e compartilhado.** O cache entrega o mesmo agregado congelado a todas as leituras (`src/server/store/immutable-state.ts`), sem `structuredClone`. Uma escrita congela só o que substituiu. Uma mutação acidental no lugar vira `TypeError`. Nenhum teste de serviço precisou mudar: o código de aplicação já era imutável.
2. **Índices por array congelado.** `src/server/domain/state-index.ts` mantém, num `WeakMap`, índices por id e por relação (solicitações por paciente, itens por solicitação, amostras por item, versões por resultado, notificação por deduplicação, idempotência por chave, sessão por hash do token). Arrays ainda em construção numa transação caem numa varredura com o mesmo resultado de `.find`/`.filter`.
3. **Uma linha por entidade (migration 015).** `cvg_runtime_entities` guarda cada entidade na ordem do array. A escrita grava só as entidades cuja identidade mudou e registra remoções em `cvg_runtime_entity_removals`. Um processo atrasado aplica só o que mudou depois da sua versão, numa transação REPEATABLE READ. A especificação está em [SYSTEM_SPEC](spec/SYSTEM_SPEC.md) (PROD-112) e a implantação em [DEPLOYMENT §4.1](operations/DEPLOYMENT.md).

## 3. Método

- Máquina local: AMD Ryzen 7 5700 (16 threads), 62 GB, PostgreSQL 16.15 em container, Node 22.23.2, build de produção do Next, borda local à frente do app e worker do outbox ativo.
- Dados: o mesmo lote real pós-workflow de 07/10, clonado com IDs e códigos únicos até cada faixa.
- `measure.mjs`, por rota: 1 aquecimento e 12 amostras sequenciais. Depois, 20 GETs simultâneos da lista com três perfis e 8 criações de solicitação. RSS é a soma do grupo de processos.
- Perfil de CPU em processo (6 meses) antes do passo 2: a função anônima de busca linear em `service-common.ts` ocupava 49,7% da CPU, `requestFor` 21,0% e `itemFor` 17,4%.

## 4. Resultados

Tempos p50 por HTTP; entre parênteses, o p95 dos 20 simultâneos.

| Faixa | Lista | Painel | Busca | Fila | 20 simultâneos | Escrita | RSS final |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 mês (4,5 mil) | 16 ms | 28 ms | 29 ms | 14 ms | 208 ms (250 ms) | 25 ms | 272 MB |
| 6 meses (27 mil) | 68 ms | 175 ms | 149 ms | 54 ms | 683 ms (1,1 s) | 93 ms | 493 MB |
| 12 meses (55 mil) | 124 ms | 362 ms | 347 ms | 120 ms | 1,7 s (2,3 s) | 208 ms | 894 MB |
| 24 meses (110 mil) | 230 ms | 646 ms | 629 ms | 192 ms | 2,3 s (4,1 s) | 385 ms | 1,6 GB |
| 35 meses (160 mil) | 364 ms | 895 ms | 951 ms | 308 ms | 3,1 s (6,2 s) | 780 ms | 2,2 GB |

- **Teto removido:** 160 mil exames (289 MB armazenados) gravam e servem todas as rotas sem erro; o app fica pronto em 6,2 s.
- **Etapa a etapa (6 meses):** o passo 2 levou a lista de 9,8 s para 64 ms e os 20 simultâneos de mais de 120 s para 643 ms, mas a escrita continuava em 3,8 s; o passo 3 a levou a 93 ms. Em processo, `listRequests` caiu de 37,4 s para 87 ms, `dashboard` de 21,9 s para 175 ms e `search` de 51,6 s para 162 ms.
- **Migration 015:** com 6 meses de dados (47 MB de snapshot) aplicou em cerca de 3 s, incluindo a reconciliação de cada coleção.

## 5. Memória

Cada processo guarda o agregado inteiro. Com o heap do Node limitado (`--max-old-space-size`), a coleta trabalha antes e o pico cai sem perda de latência:

| Faixa | Heap | Pico do app | Worker |
| --- | --- | --- | --- |
| 6 meses | 450 MB | 382 MB | 337 MB |
| 12 meses | 700 MB | 539 MB | 413 MB |
| 24 meses | 1.200 MB | 912 MB | 700 MB |

O Compose de produção limitava o app a 1 GB e o worker a 512 MB, o que daria OOM entre 6 e 12 meses de dados. Os padrões passaram a `APP_MEM_LIMIT=2g`/`APP_HEAP_MB=1280` e `WORKER_MEM_LIMIT=1g`/`WORKER_HEAP_MB=768` ([DEPLOYMENT §6.6](operations/DEPLOYMENT.md)).

## 6. Limites que continuam

- **CPU por processo.** Lista, painel e busca ainda percorrem o conjunto visível a cada chamada (custo linear, não mais quadrático). Vinte requisições simultâneas competem pelo mesmo núcleo: a 12 meses, o p95 delas é 2,3 s. A carga real de um hospital veterinário dificilmente concentra 20 listas no mesmo instante, mas o número precisa ser confirmado com o volume e o pico de D2. Mais instâncias do app funcionam: cada processo atualiza o cache de forma incremental. Esse cenário não foi medido.
- **Memória proporcional ao histórico.** Para mais de dois anos no ritmo medido, ou volume maior, é preciso aumentar a memória, aplicar retenção clínica (D5/PROD-501) ou fazer o cutover relacional (PROD-111).
- **Painel e busca** são os mais lentos (362/347 ms a 12 meses). Os dados sintéticos mantêm muitos exames em estados ativos; com dados reais, a maior parte conclui e a fila ativa é menor.
- **Não medido aqui:** hardware e banco de produção (D11), failover sob carga e a distribuição real de dados. O `perf:postgres` da CI continua sendo o gate de regressão (PROD-110).

## 7. Verificação

- Suíte unitária, suíte PostgreSQL e `npm run validate`; números na [evidência do PROD-112](build/PRODUCTION_BACKLOG.md).
- Testes novos:
  - `state-index.test.ts`: equivalência com `.find`/`.filter`, primeira ocorrência, ausência de índice obsoleto e chaves compostas sem colisão.
  - `postgres-entity-state.test.ts`: diff, renumeração, divergência e refresh incremental.
  - `postgres-state-cache.test.ts`: refresh, corrida com commit local e recarga após reconexão.
  - `tests/postgres/runtime-entity-rows.integration.test.ts`: upgrade populado com chaves de idempotência difíceis, duplicidade com rollback, chave SQL igual à do runtime, escritor antigo recusado, refresh entre instâncias e recarga abaixo do piso de remoções.
