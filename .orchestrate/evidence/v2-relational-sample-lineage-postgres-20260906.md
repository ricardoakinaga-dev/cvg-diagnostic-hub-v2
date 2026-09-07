# V2 — evidência PostgreSQL real da lineage relacional

**Data:** 06/09/2026 · execução final após hardening de lineage, idempotência, atomicidade e EXPLAIN
**Escopo:** migration 009 em PostgreSQL real; readiness `convalidated`; projeção,
leitura e reconciliação de request/item/sample/link; membership completo de itens;
rejeição das constraints de accession, replacement reason e status de link;
replay idempotente; rollback transacional; regressão PostgreSQL existente; inspeção
`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` da leitura do agregado com fan-out
representativo; wake-up `LISTEN/NOTIFY` real entre dois pools independentes.
**Autoridade:** o snapshot JSONB continua sendo a autoridade do runtime. Este
packet prova somente a seam local descartável, não cutover.

## Ambiente e comando

- PostgreSQL `16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)`, binário do bundle local.
- Cluster inicializado do zero em diretório temporário, loopback `127.0.0.1`,
  porta `55449`, banco administrativo `postgres` e dados exclusivamente
  sintéticos; o cluster foi parado ao final e nenhum processo na porta 5432 foi
  tocado.
- `postgres_binary=postgres (PostgreSQL) 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)`.
- `server_version=16.15 (Ubuntu 16.15-0ubuntu0.24.04.1); database=postgres;
  address=127.0.0.1/32; port=55449`.

Com `LD_LIBRARY_PATH` apontando somente para as bibliotecas do bundle local:

```sh
ALLOW_POSTGRES_INTEGRATION_TESTS=true \
POSTGRES_TEST_ADMIN_URL=postgresql://postgres@127.0.0.1:55449/postgres \
npm run test:postgres -- --run --reporter=dot
```

## Resultado observado

| Verificação | Resultado |
| --- | --- |
| Suíte | PASS — 4 arquivos, 22/22 testes, 8,31 s |
| Migrations | PASS — bootstrap real de 001–009; marker 009, coluna `samples.item_ids` e constraints novas aplicados |
| Readiness | PASS — as quatro constraints novas retornaram `contype = c` e `convalidated = true`; o adapter também rejeitou uma constraint homônima em tabela errada |
| Projection/read | PASS — aggregate escopado de 4 entidades (request, item, sample e link) projetado, relido por replay idempotente e validado com membership completo |
| Reconciliation | PASS — hashes do snapshot e da projeção relacional convergiram (`sourceHash === targetHash`) após normalização UTC de `timestamptz` |
| EXPLAIN | PASS — com 512 requests/items de distração, a leitura do agregado usou `Index Scan`/`Index Only Scan` nas relações clínicas indexadas; a asserção estrutural não encontrou `Seq Scan` em `diagnostic_requests`, `diagnostic_request_items`, `samples` ou `sample_item_links` |
| Negative SQL | PASS — PostgreSQL rejeitou accession inválido, `REPLACED` sem reason e `link_status` desconhecido pelos nomes esperados |
| Regressão durável | PASS — dois stores, leitura cruzada, revogação, concorrência, lineage de resultado, reload, reset auditável, rollback de projeção, rollback conjunto adapter/snapshot, audit append-only e rate-limit distribuído |
| Realtime multi-pool | PASS local — subscriber dedicado e publisher em pools separados receberam o wake-up PostgreSQL sem payload clínico; a configuração de produção rejeita `process-local` e valores inválidos |
| Candidato local | PASS — `npm run validate` 559/559 em 66 arquivos; cobertura 92,91%/85,26%/95,31%; build, E2E 51/51, acessibilidade 6/6, security scan, audit, performance 7/7 e recovery 5/5 |

## Correção comprovada nesta rodada

A primeira execução do teste de reconciliação encontrou uma divergência legítima:
o snapshot serializa `2026-09-06T02:00:00.000Z`, enquanto
`to_jsonb(timestamptz)` retornava `2026-09-06T02:00:00+00:00`. O comparador agora
normaliza somente campos temporais conhecidos para ISO UTC; uma string temporal
inválida continua divergindo e gerando mismatch. A projeção agora carrega
`samples.item_ids`, a leitura exige exatamente todos os pares declarados e o
replay pós-conflito compara todos os valores da inserção antes de aceitar uma
repetição. O ensaio de plano confirmou os caminhos indexados sob fan-out sem
transformar a subconsulta de notificações em uma promessa de plano único — o
otimizador pode escolher `Seq Scan` nessa relação pequena por causa do `OR`.
Os testes unitários e a suíte real confirmam esses caminhos.

## Limites e veredito

`PASS_WITH_CONDITIONS` para integração local descartável. A evidência não prova
browser contra PostgreSQL, banco/credenciais de produção, backfill populado,
dual-read, cutover, EXPLAIN com workload aprovado/representativo de produção, restore de object
storage, fanout SSE multi-instância, repetição em CI/ambiente-alvo, política
clínica ou aceite hospitalar. A revisão independente pós-hardening foi
solicitada em contexto fresco, mas não devolveu resultado dentro da janela de
execução; ela não é contada como aprovação. Decisão autorizada sobre autoridade
relacional continua ausente e nenhum status `VERIFIED`, `DONE` ou release foi
inferido.

O manifesto ligado ao packet é
[`v2-relational-sample-lineage-postgres-manifest-20260906.txt`](v2-relational-sample-lineage-postgres-manifest-20260906.txt).
Digest SHA-256 composto do manifesto: `2f4edede95f406654e0a34dac5182f29e6ef3cea7231c9142f9f0a5226ba3396`.
