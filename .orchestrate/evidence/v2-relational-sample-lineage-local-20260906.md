# V2 — evidência local de agenda e linhagem relacional de amostras

> Superseded by [`v2-relational-sample-lineage-postgres-20260906.md`](v2-relational-sample-lineage-postgres-20260906.md) after the disposable PostgreSQL run and the timestamp-parity fix. The guard-blocked PostgreSQL row below is historical for this earlier packet.

**Data:** 06/09/2026 · execução local final após a rodada RED/GREEN
**Escopo:** versão otimista de `ProcedureSchedule`; accession canônico;
duplicidade de itens; cadeia `RECEIVED → REPLACED → EXPECTED/RECEIVED`;
projeção versionada de `sample_item_links`; leitura fail-closed e
reconciliação expand-only. O snapshot JSONB continua sendo a autoridade.
**Ambiente:** dados sintéticos, Next.js 16.3.0, Node 22 e nenhum dado clínico
real.

## Resultado executado

| Verificação | Resultado |
| --- | --- |
| Gate principal | PASS — 552/552 testes em 66 arquivos; 92,95% statements/lines, 85,25% branches e 95,24% functions |
| TypeScript/lint | PASS — `npm run validate` |
| Arquitetura | PASS — nenhum arquivo de produção acima de 800 linhas; adapter em 787 linhas; grafo resolvido e acíclico |
| OpenAPI/runtime | PASS — Redocly + drift; 65 operações em 60 paths; accession canônico refletido em `Sample` e `PatientWorkspaceSampleSummary` |
| Documentação/rastreabilidade | PASS — 56 arquivos; 43 requisitos e 43 ACs ligados a código, teste, comando e evidência |
| Migrações | PASS — migrations 001–009, checksums e upgrade 001–008→009 validados |
| Build | PASS — `npm run build`, Next.js 16.3.0 production build |
| Browser | PASS — 51/51 Playwright, sem retry, Chromium/tablet/mobile |
| Acessibilidade | PASS — 6/6 cenários axe/keyboard, sem retry, nos três projetos |
| Segurança/supply chain | PASS — secret scan; `npm audit --audit-level=high` com 0 vulnerabilidades |
| Performance/recovery | PASS — `npm run test:perf` 7/7; `npm run test:recovery` 5/5 |
| PostgreSQL real | BLOCKED BY GUARD — 10 testes reais não iniciados sem `ALLOW_POSTGRES_INTEGRATION_TESTS=true` e URL administrativa; 6 testes do harness passaram |

## Contrato e implementação

- `ProcedureSchedule` agora carrega `version`; criação inicia em 1, alterações
  de estado usam avanço monotônico e a projeção SQL usa `WHERE id = $1 AND
  version = $n`.
- `receiveSample`/`receiveReplacement` aplicam a mesma validação na aplicação
  e no transporte: accession em maiúsculas no padrão
  `^[A-Z0-9][A-Z0-9-]{2,39}$`, sem reutilização; `itemIds` são distintos.
- Recoleta é append-only: o sample anterior permanece `REPLACED` na versão
  seguinte, a nova entidade aponta para `replacesSampleId`, e o recebimento da
  reposição avança a mesma entidade para `RECEIVED`.
- O adapter rejeita antes de escrever accession duplicado, item órfão ou
  cross-request, predecessor inexistente/self/cíclico e versões incompatíveis.
  O vínculo é determinístico e versionado; seu status e metadata são derivados
  do sample e seu histórico não é removido.
- A migration 009 mantém 007/008 imutáveis e adiciona constraints idempotentes
  `NOT VALID`, valida-as na mesma transação e exige `convalidated` no readiness;
  elas cobrem accession canônico, reason obrigatório em `REPLACED` e status
  fechado de `sample_item_links`.
- A leitura relacional valida escopo, accession, predecessor, ciclo, status,
  reason, versão, foreign keys, pares únicos e metadata de cada vínculo antes
  de expor o aggregate. A reconciliação compara replacement, reason, status,
  versões e links derivados sem retornar valores clínicos divergentes.
- A rodada RED registrou as falhas de status/duplicate-item da implementação
  anterior; a rodada GREEN cobriu application, adapter, read boundary,
  cutover, contrato e a regressão completa.

## Integridade do artefato

O manifesto reproduzível está em
[`v2-relational-sample-lineage-manifest-20260906.txt`](v2-relational-sample-lineage-manifest-20260906.txt).
Digest SHA-256 composto, com linhas de checksum ordenadas lexicograficamente:

`02ab237496534357fec1e5e320e47faa30b2bf4f19d4a66bac2f1171e1b4bbc7`

Reprodução:

```sh
while IFS= read -r path; do sha256sum "$path"; done \
  < .orchestrate/evidence/v2-relational-sample-lineage-manifest-20260906.txt \
  | LC_ALL=C sort | sha256sum
```

## Limites e veredito

`PASS_WITH_CONDITIONS` apenas para esta fatia local. O runtime não habilita
cutover nem dual-read por este packet. Não há prova PostgreSQL autorizada,
backfill populado, EXPLAIN representativo, browser durável, carga hospitalar,
realtime multi-instância, restore de object storage, aprovação clínica ou
aceite de produção.

O scout independente de arquitetura concluiu inspeção read-only e confirmou
que esta era a lacuna de maior risco; ele não é aprovação independente da
implementação final. Não foi inferida aprovação de critic fresco para esta
fatia. O estado correto permanece `IMPLEMENTED`, e a tarefa só poderá avançar
para `VERIFIED`/`DONE` com revisão independente e evidência PostgreSQL
autorizada.
