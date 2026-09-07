# AAA-2 G1 — fresh-context final critic recheck — 2026-09-05

**Veredito:** **REJECT** para o gate AAA-2/G1. A correção do aviso pós-save passou novamente no browser mobile e a suíte local atual está verde, mas os bloqueios obrigatórios da barra AAA-2 continuam abertos: PostgreSQL/homologação durável não foi executado, a migração 007 e o `PostgresStore` mantêm o snapshot JSONB como autoridade transitória, o realtime entregue é process-local, a rastreabilidade falha com 20 referências ausentes e D-01–D-06 continuam `OPEN`. Nenhum desses bloqueios pode ser convertido em PASS por inferência.

## Escopo, independência e integridade

Esta foi uma rechecagem de contexto novo no checkout `/home/ricardo/cvg-diagnostic-hub-v2`, somente neste repositório, contra [`docs/build/AAA_2_QUALITY_BAR.md`](../../docs/build/AAA_2_QUALITY_BAR.md) e seus 22 critérios. O trabalho foi de inspeção e execução; nenhum arquivo de produto foi editado deliberadamente pelo critic. O packet atual é a única escrita deliberada desta rechecagem.

- `HEAD` observado: `01bb1804682b4bb503e00e41c1361dc704d2294d`.
- Ambiente: Node `v24.20.0`, npm `11.19.0`; o alvo documentado é Node 22 e não está instalado neste host.
- Independência: critic I1, contexto novo e distinto do builder; o packet anterior [`aaa2-g1-critic-fresh-20260905.md`](aaa2-g1-critic-fresh-20260905.md) foi usado como histórico para investigar o flake, não como aprovação.
- Fingerprint antes dos checks: `/tmp/aaa2-g1-critic-recheck-pre-20260905.json`, digest `a47be991a501bd87e1e00b71c518fd14c5421c5f90e0b36de8310512ad863cd5`, `worktree_diff_sha256=7a1833e6f35fe7906c0a6a22c12fb68604f21e991826bf4bdc53d79abb181d7d`.
- Fingerprint final antes deste packet: `/tmp/aaa2-g1-critic-recheck-final-20260905.json`, digest `a4ad4bcaf993171edda2825adc9b11538783a4774b575432411d389da4e3b2cb`, `worktree_diff_sha256=14a59889fcb3c1d4fb8b17b0a4d786047abd216ca29a2ec25c112cf9c2268738`.
- `verify-fingerprint` do snapshot inicial retornou `match: false`, exit 3. A diferença inclui artefatos gerados (`.next*`, `coverage`, `playwright-report`, caches, `test-results`, claims sintéticos em `.data/uploads`) e também alterações concorrentes do working tree que não estavam no snapshot inicial, incluindo `src/server/security/session.ts`, `src/server/security/session.test.ts`, `src/server/application/registry-service.test.ts`, documentação e o packet [`aaa2-g1-rework-20260905.txt`](aaa2-g1-rework-20260905.txt). O sentinel é, portanto, **INVALID/UNCLEAN para integridade estrita**; não atribuo essas alterações ao critic nem uso o sentinel como prova de aprovação.

## Comandos executados

Todos os comandos abaixo foram executados com `workdir=/home/ricardo/cvg-diagnostic-hub-v2`.

| Comando | Resultado observado | Limite da evidência |
| --- | --- | --- |
| `npx vitest run src/components/app-shell.test.tsx src/components/result-view.test.tsx src/server/observability/realtime.test.ts src/server/http/scoped-reads-route.test.ts src/server/http/cancellation-policy.test.ts src/server/store/migrations.test.ts src/server/store/relational/backfill.test.ts src/server/store/relational/clinical-core-adapter.test.ts src/server/store/postgres-store.test.ts src/server/architecture-fitness.test.ts src/server/operations/outbox.test.ts src/server/security/rate-limit.test.ts src/server/observability/metrics.test.ts 'src/app/api/v1/[...path]/route.test.ts'` | PASS — 14 arquivos, 248 testes | E1; memória/mocks e contratos locais, sem banco vivo ou duas instâncias |
| `npx vitest run src/server/application/registry-service.test.ts src/server/security/session.test.ts` | PASS — 2 arquivos, 10 testes | E1; cobre a nova invalidação de escopo/versionamento local |
| `npm test` | PASS — 54 arquivos, 451 testes | E1; não prova PostgreSQL, operação distribuída ou aceite humano |
| `npm run test:coverage` | PASS — 54/451; 91,92% statements/lines, 84,04% branches, 94,11% functions | A meta proposta de G4 é 90/90/85; branches ficam 0,96 ponto abaixo de 85% |
| `npm run typecheck -- --incremental false` (primeira execução em paralelo com outros checks) | FAIL observado em `src/server/application/registry-service.test.ts:84` (`store` inexistente e parâmetro `user` implícito) | Falha não reproduzida; o arquivo mudou durante a janela do critic. Preservada como primeira falha, sem apagá-la |
| `npx tsc --noEmit --incremental false --pretty false` e `npm run typecheck -- --incremental false` sequencial | PASS | Execução local posterior; a primeira falha paralela permanece um sinal de drift/concorrência, não é promovida a PASS retroativo |
| `npm run lint` | PASS | ESLint local |
| `npm run build` | PASS — Next.js 16.3.0, build de produção, 11 páginas estáticas | Não é CI remoto nem deploy/release |
| `npm run validate:migrations` | PASS — migrações 001–008 e oito checksums | Validação estática; nenhum SQL foi executado contra PostgreSQL |
| `npm run validate:docs` | PASS — 56 arquivos e gates documentais | Existência/coerência mecânica não substitui revisão semântica |
| `npm run validate:openapi` | PASS — 64 operações em 59 paths | Não substitui revisão semântica completa nem servidor durável |
| `npm run security:scan` | PASS — nenhum padrão de segredo versionável | Scanner local não prova segurança de produção |
| `npm audit --audit-level=high --omit=dev` | PASS — 0 vulnerabilidades reportadas | Não é o scan CI completo nem revisão de supply chain |
| `npm run validate:traceability` | **FAIL CLOSED** — 20 issues | Cinco linhas (`FR-CORE-005`, `FR-OPS-002`, `NFR-PERF-001`, `NFR-PERF-002`, `NFR-OPS-001`) têm `code`, `test`, `command` e `evidence` ausentes |
| `npm run test:postgres` | **BLOCKED/FAIL guard** — 10 testes de integração falharam exigindo `ALLOW_POSTGRES_INTEGRATION_TESTS=true`; 6 testes do harness passaram | Não havia opt-in, `POSTGRES_TEST_ADMIN_URL`, Docker, `psql` ou URL autorizada; não houve execução SQL/integrada |
| `CI=1 npm run test:e2e -- --fail-on-flaky-tests --retries=0` | PASS — 45/45, 3,2 min, sem retry; Chromium/tablet/mobile | Servidores de memória sintética isolados por projeto/porta e `NEXT_DIST_DIR`; não é browser contra PostgreSQL |
| `CI=1 npx playwright test tests/e2e/clinical-lifecycle.spec.ts --project=mobile --grep "requires critical acknowledgement" --repeat-each=3 --fail-on-flaky-tests --retries=0` | PASS — 3/3 em 31,0 s | Repetição aumenta confiança contra o flake, mas não prova uma causa nem homologa produção |
| `git diff --check` | PASS | O working tree já era sujo e sofreu drift concorrente; nenhum arquivo foi revertido |

## Flake mobile e correção pós-save

O critic anterior registrou uma corrida de **44/45**, com falha mobile em `tests/e2e/clinical-lifecycle.spec.ts:227:7`, aguardando `Draft atualizado.` após `Confirmar`. Nesta rechecagem, a mesma corrida completa passou 45/45 sem retry, o teste mobile crítico passou 3/3, e o foco ResultView passou 10 testes, incluindo `keeps the save confirmation when the post-save realtime event arrives`.

O código atual usa `busyRef` para impedir reconciliação durante mutação, chama `load(false)` após o save bem-sucedido e mantém `Draft atualizado.`; o teste focalizado dispara `cvg:realtime-updated` depois do save e confirma que o aviso permanece. Isso é uma regressão local atualmente verde e explica o controle implementado, mas a ausência de nova falha não demonstra por si só uma explicação causal completa nem transforma o browser sintético em E2.

## Autoridade de persistência e migração 007

O bloqueio de persistência permanece material. [`db/migrations/007_relational_clinical_core.sql`](../../db/migrations/007_relational_clinical_core.sql) declara nas linhas 3–5 que a migração é aditiva, não copia/regrava `cvg_runtime_state` e deixa a fronteira transitória. Os comentários nas linhas 861–864 repetem que a autoridade continua em `cvg_runtime_state` e que o runtime ainda lê/escreve o snapshot.

[`src/server/store/postgres-store.ts`](../../src/server/store/postgres-store.ts) confirma essa autoridade: `readState` consulta `SELECT state, version FROM cvg_runtime_state` nas linhas 354–360; transações bloqueiam a mesma linha com `FOR UPDATE` nas linhas 12–13 e 417–419; a atualização continua `UPDATE cvg_runtime_state ... state = $1::jsonb` nas linhas 431–434. O adaptador relacional em `createWithRelationalClinicalCore` é uma seam opt-in/shadow e o próprio comentário nas linhas 286–292 diz que não muda a autoridade de leitura. Os testes do adaptador são estáticos/mocked.

Não houve bootstrap/upgrade/backfill institucional, reconciliação pós-escrita, cutover, falha intermediária, rollback/roll-forward, concorrência SQL, `EXPLAIN` ou browser servido contra PostgreSQL. A validação dos oito arquivos e os testes de backfill storage-neutral não podem ser promovidos a E2.

## Realtime e autorização de stream

[`src/server/observability/realtime.ts`](../../src/server/observability/realtime.ts) expõe somente `ProcessLocalRealtimeNotificationAdapter`, com `name`/`scope` `process-local` nas linhas 17–20. A seleção nas linhas 45–52 falha fechada para qualquer configuração diferente de `process-local`; não existe broker/fanout multi-instância instalado. `realtime-stream.ts` mantém polling, replay, `Last-Event-ID`, resync, timeout, limites, backpressure e rechecagem de autorização, e `app-shell.tsx` adiciona fallback/reconnect/notice, mas esses controles locais não provam dois processos compartilhando notificações.

A mudança corrente em `session.ts` compara `patientIds`, `serviceCodes` e `managedDepartmentCodes` no snapshot de autorização e os testes locais cobrem a revogação granular. Isso fecha uma lacuna local anterior, porém não substitui revogação/escopo em duas instâncias, stream longo servido, cliente lento e fanout durável.

## Rastreabilidade e decisões humanas

`npm run validate:traceability` permanece fechado com 20 issues. As cinco linhas da matriz mantêm `—` nos quatro vínculos executáveis; preencher apenas IDs, status ou links nominais seria falsificar a prova. O packet não altera a matriz.

[`docs/build/AAA_2_DECISION_REGISTER.md`](../../docs/build/AAA_2_DECISION_REGISTER.md) mantém D-01, D-02, D-03, D-04, D-05 e D-06 como `OPEN`. O próprio registro informa nas linhas 18–20 que cada decisão exige decisor, cargo, data, versão, alternativa rejeitada, impacto aceito e anexo, e que nenhum decisor humano foi nomeado neste checkout. PostgreSQL externo, autoridade clínica, RPO/RTO, SLO, restore, treino, piloto e aceite hospitalar não podem ser inventados pelo critic.

## Matriz dos 22 critérios congelados

`PASS` nesta tabela significaria cumprir a prova mínima da barra, e não apenas passar um teste local. Nenhum critério é promovido a PASS final nesta rechecagem.

| Critério | Estado | Julgamento independente e limite |
| --- | --- | --- |
| AAA-01 — jornadas | CONDITIONAL | E2E sintético cobre dashboard, solicitações, Lab/RX, resultado, revisão, emenda, void, crítico e anexos em 45/45; transferência/alta e E2/E3 com usuários/dados reais não têm prova |
| AAA-02 — HTTP | CONDITIONAL | OpenAPI/runtime e 43 testes de rota locais passam; falta revisão semântica independente completa e servidor durável |
| AAA-03 — entradas | CONDITIONAL | Limites, schemas, erro seguro e rate limit têm testes locais; não houve abuso HTTP/pressão de recursos em E2 |
| AAA-04 — autorização | CONDITIONAL | Leituras scoped, cancelamento, versionamento e escopo granular têm negativos locais; falta revogação em duas instâncias/IdP institucional |
| AAA-05 — confidencialidade | CONDITIONAL | Filtragem de listas, diagnósticos, SSE/snapshot e metadados passa localmente; falta validação durável de drafts/versões/anexos/multi-instância |
| AAA-06 — identidade clínica | REJECT | D-01 está `OPEN`; homônimo, ownership institucional, transferência e alta não têm ensaio E2/E3 |
| AAA-07 — lifecycle | CONDITIONAL | 94 cenários de cancelamento e transições locais passam; concorrência/replay duráveis e D-02 aprovado estão ausentes |
| AAA-08 — persistência | REJECT | Migration 007 é additive/transitória e `PostgresStore` ainda lê, bloqueia e grava o snapshot JSONB como autoridade |
| AAA-09 — migração | REJECT | Não houve PostgreSQL vivo, backfill institucional, reconciliação, cutover, falha intermediária ou recuperação |
| AAA-10 — multi-instância | REJECT | Nenhum ensaio de duas instâncias para sessão, escopo, dados, rate limit ou restart foi executado |
| AAA-11 — delivery | CONDITIONAL | Envelope, rotas, leases, retry, dedupe e sink têm testes locais; FK/transação/crash-after-send/retry em PostgreSQL não foram observados |
| AAA-12 — realtime | REJECT | A implementação entregue é process-local; faltam fanout entre instâncias, reconexão durável, cliente lento e conflito de draft no browser servido |
| AAA-13 — arquivos | CONDITIONAL | FileStore, MIME/checksum, quarentena e uploads passam localmente/E2E sintético; scanner/storage homologado e restore de conteúdo faltam |
| AAA-14 — observabilidade | CONDITIONAL | Health/readiness, métricas limitadas e correlação têm testes locais; não houve falha injetada, alerta recebido, SLO aprovado ou runbook exercitado |
| AAA-15 — desempenho | REJECT | Sem workload PostgreSQL representativo, duas instâncias, p50/p95/p99, soak, throughput ou `EXPLAIN` |
| AAA-16 — UX | CONDITIONAL | 45/45 browser sintético e checks axe passam, incluindo mobile/tablet; falta avaliação manual, leitores/touch/zoom, estados degradados servidos e usuários reais |
| AAA-17 — arquitetura | CONDITIONAL | Fitness do grafo real e aciclicidade passam; a prova de integração/coerência do candidato completo permanece local e sem revisão de produção |
| AAA-18 — cadeia/build | CONDITIONAL | Lockfile, build, lint, typecheck sequencial, scan e audit locais passam; Node alvo, CI remoto, checkout limpo e proveniência final não foram observados |
| AAA-19 — recuperação | REJECT | Não houve restore de banco, anexos e configuração em ambiente vazio, nem medição RPO/RTO |
| AAA-20 — rastreabilidade | REJECT | Validador atual falha fechado com 20 referências ausentes nas cinco linhas identificadas |
| AAA-21 — governança | REJECT | D-01–D-05 estão `OPEN`, sem decisor humano, assinatura, versão e vigência |
| AAA-22 — release | REJECT | D-06 está `OPEN`; faltam CI remoto observado, revisão/manual/treino, ensaio, piloto e decisão formal |

## Decisão final

**REJECT.** A correção pós-save está atualmente verificada na fronteira local sintética: 45/45 E2E sem retry, 3/3 repetições mobile, 451/451 testes locais, build/typecheck/lint e validações mecânicas verdes. Isso não supera os gates rejeitados acima. O sentinel de mutação também não é limpo porque houve drift concorrente e artefatos gerados; esse fato foi preservado, não ocultado. O próximo passo seguro é executar a matriz em um PostgreSQL descartável autorizado, fechar a autoridade/cutover relacional e o fanout realtime, completar os vínculos de rastreabilidade e obter decisões D-01–D-06 assinadas antes de qualquer alegação de aceite AAA-READY.
