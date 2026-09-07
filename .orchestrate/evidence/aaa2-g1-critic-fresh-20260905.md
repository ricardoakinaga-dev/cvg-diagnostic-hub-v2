# AAA-2 G1 fresh critic — 2026-09-05

**Veredito independente:** **REJECT** para o gate AAA-2/G1. Há uma fatia local forte e vários gates automatizados passam, mas os bloqueios explícitos do Quality Bar continuam abertos e a execução E2E fresca não foi reproduzível: a primeira corrida terminou em **44/45**, com um caso mobile falhando. Este packet não declara AAA-READY nem conclusão dos 22 critérios.

**Escopo e independência.** A inspeção foi feita de um contexto novo no checkout `/home/ricardo/cvg-diagnostic-hub-v2`, com `HEAD 01bb1804682b4bb503e00e41c1361dc704d2294d`. O working tree já estava sujo quando a auditoria começou; as mudanças rastreadas do produto foram preservadas. Não usei artefatos, processos, resultados ou dependências de `/home/ricardo/cvg-agent-secretary-v2` ou de qualquer outro repositório.

## Evidência executada

Os comandos abaixo foram executados nesse diretório. Resultados positivos são evidência local, em memória ou sintética, salvo onde indicado.

| Comando | Resultado observado | Nível / limite |
| --- | --- | --- |
| `npm run typecheck -- --incremental false` | PASS | E0/E1; compilação local |
| `npm run lint` | PASS | E0/E1 |
| `npm test` | PASS, 54 arquivos / 448 testes | E1; não é PostgreSQL nem duas instâncias |
| suíte focada (architecture, scoped reads, cancellation, realtime, metrics, outbox, rate limit, migrations, backfill, relational adapter, API route, shell, result view) | PASS, 13 arquivos / 233 testes | E1; fixtures/mocks locais |
| `npm run build` | PASS; Next 16.3.0 gerou as páginas estáticas/dinâmicas | E0/E1; não é deploy/release remoto |
| `npm run validate:migrations` | PASS; 001–008 e checksums do manifesto | E0/E1; nenhum SQL executado contra banco vivo |
| `npm run validate:docs` | PASS, 56 arquivos | E0 |
| `npm run validate:openapi` | PASS, 64 operações / 59 paths | E0/E1; não substitui revisão semântica completa |
| `npm run security:scan` | PASS; nenhum padrão de segredo versionável | E0 |
| `npm audit --audit-level=high --omit=dev` | PASS; 0 vulnerabilidades | E0; o job remoto completo ainda não foi observado |
| `npm run validate:traceability` | **FAIL CLOSED**, 20 issues | Cinco linhas (`FR-CORE-005`, `FR-OPS-002`, `NFR-PERF-001`, `NFR-PERF-002`, `NFR-OPS-001`) ainda têm `code`, `test`, `command` e `evidence` ausentes |

### E2E e isolamento Playwright

Configuração inspecionada em `playwright.config.ts:11-16` e `next.config.mjs:15`: os projetos chromium/tablet/mobile iniciam servidores de memória sintética nas portas 3100/3101/3102 e usam `NEXT_DIST_DIR=.next-e2e-${port}`. Isso evita a colisão de `distDir` observada anteriormente e é uma melhoria real.

A corrida fresca foi:

```text
CI=1 npm run test:e2e -- --fail-on-flaky-tests --retries=0
```

Resultado: **1 failed, 44 passed (3.1m)**. O primeiro erro foi `[mobile] tests/e2e/clinical-lifecycle.spec.ts:227:7`, em `fillStructuredHemogram` (`tests/e2e/clinical-lifecycle.spec.ts:119`), aguardando `Draft atualizado.` após `Confirmar` por 15 s. O screenshot e o contexto estão em `test-results/clinical-lifecycle-clinica-87c6e-knowledgement-before-review-mobile/`.

O mesmo caso passou em uma execução isolada e em `--repeat-each=3` (1/1 e 3/3). Isso caracteriza uma falha intermitente ainda não explicada; reruns isolados não convertem a primeira corrida com `--fail-on-flaky-tests --retries=0` em uma prova reproduzível de 45/45. O backlog e a matriz que dizem “45/45 em uma corrida” estão, portanto, stale em relação a esta evidência independente até uma nova corrida limpa explicar ou corrigir o flake.

### PostgreSQL, migrações e backfill

`npm run test:postgres` foi executado sem inventar credenciais/opt-in. O guard rejeitou os 10 testes de integração (`ALLOW_POSTGRES_INTEGRATION_TESTS=true` ausente); os 6 testes do harness passaram. `docker` e `psql` não estão disponíveis neste host e não há URL de teste autorizada. Não houve execução de integração PostgreSQL, bootstrap, upgrade, EXPLAIN, concorrência ou browser servido contra PostgreSQL.

As migrações 001–008 existem e a validação estática passa. Entretanto, `db/migrations/007_relational_clinical_core.sql:1-5,861-866` declara que a mudança é **additive**, deixa `cvg_runtime_state` como autoridade e mantém o runtime transitório. `src/server/store/postgres-store.ts:12-13,286-303,354-370,417-443` confirma que `readState` e `FOR UPDATE` no snapshot JSONB continuam no caminho padrão; o adaptador relacional é opt-in/sombra e apenas expõe uma seam de leitura.

`src/server/store/relational/backfill.ts:109-151` implementa fases, cursor, checkpoint, abort e hash antes do `upsert`, e seus testes locais passam. Não há adaptador PostgreSQL/corpus institucional nem ensaio de reconciliação, falha intermediária, novas escritas, rollback/roll-forward ou cutover. O hash do runner é comparado antes da escrita; não existe verificação explícita do estado pós-upsert no contrato local.

### Auth, cancelamento, realtime, outbox e observabilidade

- `scoped-reads-route.test.ts` cobre filas, busca, timeline, dashboard, diagnósticos, snapshot realtime e mutações com fixtures em memória; `cancellation-policy.test.ts` cobre 94 cenários locais de fase, escopo, versão, concorrência e rollback. Isso é E1, não a matriz E2 de duas instâncias.
- `src/server/observability/realtime.ts:1-9,45-57` implementa somente o adaptador `process-local`; configuração desconhecida falha fechada. `realtime-stream.ts:18-27,98-115,198-256` tem polling, replay/`Last-Event-ID`, resync, limites, timeout, backpressure e rechecagem de autorização, mas não há broker/fanout multi-instância validado.
- `src/server/security/session.ts:77-89` invalida snapshot por `active`, `version`, papel, departamento e sessão, mas não compara `patientIds`, `serviceCodes` ou `managedDepartmentCodes`. `registry-service.ts:106-108` altera `patientIds` sem incrementar `version`. A revogação de escopo granular em stream longo precisa de uma regra explícita e um teste de integração; atualmente a proteção depende da referência de ator capturada e da política de evento.
- Outbox 017–019 tem envelope/roteamento 008, leases/tokens, retry, dedupe, poison/dead-letter e testes locais. `src/server/operations/outbox.ts` usa SQL/mocks para o sink durável, mas nenhum worker concorrente, crash após envio, FK/transação ou retry foi observado em PostgreSQL real.
- Rate limit 037 e métricas/readiness 041 têm contratos e testes locais, inclusive fail-closed para produção. Não houve prova de bucket compartilhado entre instâncias, alerta entregue, SLO aprovado, injeção de falha ou diagnóstico operacional por runbook.

## Matriz dos 22 critérios congelados

`PASS` abaixo só seria permitido com a prova mínima do Quality Bar; uma implementação local ou um teste sintético não foi promovido artificialmente para PASS. `CONDITIONAL` significa que há evidência local útil, mas falta a fronteira exigida. `REJECT` significa falha explícita, bloqueio ou ausência de uma prova mínima indispensável.

| Critério | Veredito | Evidência independente e gap exato |
| --- | --- | --- |
| AAA-01 jornadas | CONDITIONAL | Fluxos sintéticos e componentes passam; transferência/alta continuam sem links executáveis e não há E2/E3 com dados/usuários reais. |
| AAA-02 HTTP | CONDITIONAL | OpenAPI/runtime drift local passa; falta revisão semântica independente e evidência do candidato servido durável. |
| AAA-03 entradas | CONDITIONAL | Schemas/limites/rate limit têm testes locais; não houve abuso HTTP/pressão em E2. |
| AAA-04 autorização | CONDITIONAL | Leituras/cancelamento/delegação têm negativos locais; não há revogação em duas instâncias e existe a lacuna de escopo granular do snapshot. |
| AAA-05 confidencialidade | CONDITIONAL | Filtros e negativos locais passam; SSE/drafts/versões/anexos não foram validados em duas instâncias/homologação. |
| AAA-06 identidade clínica | **REJECT** | D-01 está OPEN; homônimo, ownership institucional, transferência e alta não têm ensaio E2/E3. |
| AAA-07 lifecycle | CONDITIONAL | 94 cancelamentos e transições locais passam; concorrência/replay duráveis e D-02 aprovado estão ausentes. |
| AAA-08 persistência | **REJECT** | 007 e `PostgresStore` declaram snapshot JSONB autoritativo e `FOR UPDATE` global; o schema relacional ainda é sombra/transitório. |
| AAA-09 migração | **REJECT** | Não há PostgreSQL vivo, backfill institucional, reconciliação pós-escrita, cutover ou recuperação de falha intermediária. |
| AAA-10 multi-instância | **REJECT** | Nenhum ensaio E2 de duas instâncias para sessão, escopo, dados, limites ou restart foi executado. |
| AAA-11 delivery | CONDITIONAL | Contrato/worker/leases/retry/dedupe locais passam; faltam FK/transação, crash-after-send e dedupe em PostgreSQL real. |
| AAA-12 realtime | **REJECT** | O adaptador entregue é process-local; faltam dois usuários/instâncias, fanout, reconexão real, cliente lento e conflito de draft no browser servido. |
| AAA-13 arquivos | CONDITIONAL | FileStore, MIME/checksum/quarentena e scanner local têm testes; scanner/storage de homologação e restore de conteúdo não foram ensaiados. |
| AAA-14 observabilidade | CONDITIONAL | Métricas/readiness/labels limitados passam localmente; não há falha injetada, alerta recebido, SLO aprovado e runbook exercitado. |
| AAA-15 desempenho | **REJECT** | Sem PostgreSQL, duas instâncias, workload representativo, p50/p95/p99, soak ou EXPLAIN. |
| AAA-16 UX | CONDITIONAL | Componentes, acessibilidade sintética e browser local passam parcialmente; falta avaliação manual, usuários, dispositivos e estados degradados servidos. |
| AAA-17 arquitetura | CONDITIONAL | Fitness sobre o grafo real passa e arquivos de produção ficam abaixo de 800 linhas; falta revisão independente documentada de coesão/adapters no candidato. |
| AAA-18 cadeia/build | CONDITIONAL | Node 22, lockfile, build, scan e audit local passam; CI remoto, checkout limpo e proveniência do candidato não foram observados. |
| AAA-19 recuperação | **REJECT** | Não houve restore de banco/anexos/configuração em ambiente vazio nem medição RPO/RTO. |
| AAA-20 rastreabilidade | **REJECT** | `validate:traceability` falha fechado com 20 referências ausentes nas cinco linhas listadas. |
| AAA-21 governança | **REJECT** | D-01–D-05 permanecem OPEN sem decisor humano nomeado, assinatura, versão e vigência. |
| AAA-22 release | **REJECT** | Sem E2 PostgreSQL, CI remoto observado, revisão manual, treino, ensaio, piloto ou decisão formal D-06. |

## Gaps que impedem avanço

1. Fechar a rastreabilidade das cinco linhas sem preencher links nominais; cada MUST/AC precisa de código, teste significativo, comando e evidência atual.
2. Executar os testes de migração/backfill/outbox/rate limit e uma jornada browser contra PostgreSQL 16, com duas instâncias e falhas/concorrência; demonstrar que a autoridade relacional substitui o snapshot/global lock ou registrar o plano de cutover aprovado.
3. Implementar ou homologar fanout realtime multi-instância e testar revogação de `patientIds`/`serviceCodes`/delegação durante stream aberto.
4. Investigar o primeiro E2E mobile que falhou em `Draft atualizado.`; a aceitação precisa registrar a corrida completa limpa, com `--fail-on-flaky-tests`, e sua causa/controle, não apenas reruns isolados.
5. Obter D-01–D-06, desempenho, alertas/SLO, restore/RPO/RTO, avaliação manual de UX e aceite formal do hospital.

## Integridade do critic

Fingerprint antes dos checks (fora do repositório): `/tmp/aaa2-g1-critic-fresh-pre-20260905.json`, digest `4f826934d6615e2d5cb06b0deebb5190eb576e08454a0e497528bdf94a5bf45d`. Fingerprint após os checks e antes deste packet: `/tmp/aaa2-g1-critic-fresh-post-20260905.json`, digest `ca8e7918d331d06079ed421b3c3c023a6c62c4b9c6fca741e7de853aa9c5ab5e`. O `worktree_diff_sha256` permaneceu `4cfdaf65ce42c9ba67dbf7881f7c1fe341f4f2e6dbabb5409618455573d6cc15`; a diferença do fingerprint veio de artefatos gerados pelos checks: `.next*`, `playwright-report`, `test-results`, seis claims sintéticos em `.data/uploads` e cache Vite. Nenhum arquivo rastreado do produto foi editado pelo critic, e o packet solicitado é a única escrita deliberada desta auditoria.

O `verify-fingerprint` contra o snapshot inicial retornou `match: false` (exit 3), pois esses outputs não foram isolados. Pelo protocolo do `gauntlet-loop`, isso torna o sentinel estritamente **não limpo/INVALID para integridade do critic**; o fato é preservado aqui para revisão do Lead. O veredito substantivo continua **REJECT** de forma conservadora e não usa esses artefatos gerados como prova de PASS.

Referências normativas: [AAA_2_QUALITY_BAR.md](../../docs/build/AAA_2_QUALITY_BAR.md), [AAA_2_BACKLOG.md](../../docs/build/AAA_2_BACKLOG.md), [AAA_2_DECISION_REGISTER.md](../../docs/build/AAA_2_DECISION_REGISTER.md) e [TRACEABILITY_MATRIX.md](../../docs/TRACEABILITY_MATRIX.md).
