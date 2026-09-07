# Relatório de status de construção — CVG Diagnostics Hub V2

**Auditoria realizada:** 04/09/2026  
**Revisão observada:** `01bb1804682b4bb503e00e41c1361dc704d2294d`  
**Escopo:** documentação completa em `docs/`, código, configuração de testes, migrations, CI e evidência executável local.

**Atualização integrada:** 07/09/2026 — a auditoria abaixo permanece o baseline
histórico; a evidência corrente está no packet visual, na matriz browser 60/60 e
no packet PostgreSQL anterior 39/39, com crítica independente e limites externos
registrados na seção final.

**Fechamento técnico local:** 07/09/2026 — a execução corrente passou 725/725
testes em 86 arquivos, com 92,72% statements/lines, 85,82% branches e 94,31%
functions; build, OpenAPI 65/60, rastreabilidade 43/43, migrations 001–010,
security scan, SBOM CycloneDX com 560 componentes sob Node 22, audit de produção,
recovery 5/5, performance 7/7 e browser 60/60 na matriz completa, sem retry,
em Chromium/tablet/mobile. O packet PostgreSQL descartável anterior passou 39/39
em Node 22/PostgreSQL 16.15; a repetição corrente ficou condicionada pela
ausência de `initdb`/`pg_ctl`/Docker e não tocou 5432. JSONB continua autoridade
e os gates humanos/ambiente-alvo permanecem abertos.
Consulte o [relatório corrente](RELATORIO_AUDITORIA_2026-09-07.md) e o
[manifesto AAA-3](../.orchestrate/aaa3-execution-20260907/evidence-manifest.json).

## Veredito executivo

O repositório entrega um MVP local executável, com uma fatia V2 operacional e uma fatia sintética de Laboratório estruturado. A construção está tecnicamente avançada, mas ainda não está pronta para hospital, dados clínicos reais ou produção.

**Nota de evolução histórica:** as seções de evidência, pontuação e achados abaixo registram o baseline que motivou a onda W0. Depois desse baseline, o alias PostgreSQL foi corrigido, `fast-uri` foi atualizado, a readiness relacional expand-only foi adicionada, o flake de login foi corrigido, a documentação foi reconciliada e o Patient Workspace foi implementado localmente.

**Atualização histórica (06/09/2026):** `npm run validate` passou **619/619** testes em 75 arquivos, com 91,85% statements/lines, 85,09% branches e 94,28% functions; a suíte E2E passou **51/51** sem retry e acessibilidade 6/6. A suíte PostgreSQL descartável passou **33/33**. Esses números pertencem ao packet anterior; a baseline corrente está no fechamento técnico de 07/09 acima. A instância persistente em `127.0.0.1:5432` permaneceu intocada. O estado continua `NOT READY` para produção, ambiente-alvo e uso clínico.

- **Maturidade técnica local:** **78/100** pela média das 12 dimensões da barra de construção.
- **Qualidade da documentação:** **84/100** por cobertura, clareza e rastreabilidade, descontando evidência desatualizada e divergências factuais.
- **Fatia Laboratório estruturado:** `PASS_WITH_CONDITIONS` apenas para o Hemograma sintético local, conforme [`LABORATORY_VERTICAL.md`](v2/LABORATORY_VERTICAL.md) e o gate registrado.
- **Programa V2 completo, uso hospitalar e produção:** `NOT READY`. Essa conclusão é coerente com a barra V2 e com [`PREMIUM_MVP_V4.md`](build/PREMIUM_MVP_V4.md).
- **Item de construção corrente:** `TASK-V2-RELATIONAL-SAMPLE-LINEAGE-001`, implementado localmente e em `VERIFY` condicional em [`.agent/backlog.json`](../.agent/backlog.json); o backfill shadow e sua crítica independente local estão verdes, mas os gates de ambiente-alvo, autoridade relacional e governança continuam abertos.

A média não compensa um gate obrigatório ausente. O documento histórico de 95/96 foi explicitamente supersedido; as notas abaixo são uma recalculação independente, com evidência de 04/09/2026.

Atualização de evidência em 06/09/2026: a linha do tempo densa foi coberta por
fixture determinístico colapsado/expandido e PNGs production-like. O packet v8
registra 20 artefatos nos seis estados e três viewports, com labels mobile
visíveis, targets de toque ampliados, frescor textual e indisponibilidade
explícita no snapshot parcial; a crítica independente está em andamento,
enquanto aceite manual, golden, alvo e humano continuam pendentes.

## Escopo documental entendido

Foram encontrados **60 arquivos em `docs/`** — 59 Markdown e o contrato [`openapi.json`](api/openapi.json) — somando 4.270 linhas Markdown. O conjunto cobre discovery, PRD, especificações de domínio/API/dados, arquitetura, UX, segurança, testes, operações, build, V2 e rastreabilidade.

| Corpus | O que está documentado | Nota /100 |
| --- | --- | ---: |
| Governança e índice | Ordem normativa, classificação FACT/ASSUMPTION/DECISION/OPEN QUESTION, glossário e decisões | 92 |
| Discovery | Problema, jornada, personas, blueprint, eventos, métricas, 20 perguntas abertas, 15 premissas e 15 riscos | 94 |
| PRD | Escopo MoSCoW, não-escopo, 42 requisitos e 42 critérios de aceitação | 91 |
| SPEC e API | Entidades, estados, permissões, erros, busca, realtime, notificações, dados e contrato versionado | 86 |
| Arquitetura e ADRs | Monólito modular atual, fronteiras, fluxo de dados, decisões de PostgreSQL/SSE/storage/auth | 86 |
| UX | Arquitetura de informação, fluxos, telas e design system; estados operacionais e acessibilidade previstos | 82 |
| Segurança | Threat model, riscos LGPD, sessão, CSRF, RBAC, escopo, upload e fronteiras fail-closed | 88 |
| Testes | Plano de testes, cenários e critérios de regressão; números de evidência ficaram desatualizados | 76 |
| Operações | Readiness, observabilidade, backup/restore e checklist de release; gates permanecem abertos | 70 |
| Build, V2 e rastreabilidade | Plano M0–M8, barras congeladas, mapa de migração e matriz de requisitos | 76 |

O script [`validate-docs.sh`](../scripts/validate-docs.sh) passou e verificou 56 arquivos obrigatórios, links locais, IDs do PRD na matriz, termos canônicos e ausência de marcadores de conteúdo incompleto. Isso é um gate estrutural; não prova que cada status documental corresponde ao comportamento atual.

### Leitura por fase

- **Discovery:** foi concluído como artefato local, não como descoberta hospitalar. O próprio documento registra ausência de entrevistas, observação de campo, volume real e contrato HIS. As premissas, riscos e perguntas abertas estão corretamente separados de fatos.
- **Produto:** o PRD é amplo e cobre requests, Lab, RX, US, resultados, anexos, notificações, operações, identidade, auditoria e registry. O escopo é claro, mas várias políticas clínicas e institucionais continuam fora da autoridade técnica.
- **Especificação:** o modelo de domínio e as máquinas de estado são detalhados. A persistência relacional é o alvo normativo, porém o runtime ainda usa o agregado `StoreState-v1` em uma linha JSONB transitória; isso está explicitado em [`DATA_MODEL.md`](spec/DATA_MODEL.md).
- **Arquitetura V2:** o runtime real ainda é um monólito Next em `src/`, com packages consumidos pelo runtime. `apps/web` e `apps/api` são destino de migração, não diretórios já entregues; o mapa deixa essa distinção clara na maior parte do texto.
- **UX e segurança:** há especificações consistentes para fila, Command Center, drawer, teclado, estados de erro e autorização. O aceite manual e a validação com usuários reais não existem ainda.
- **Operações e release:** a documentação declara `NOT READY`, mantém checklist aberto e lista os gates externos. A presença de runbooks e adapters não equivale a um restore, CI remoto ou operação produtiva executados.

## Evidência executada no baseline antes da onda W0

| Verificação | Resultado observado | Interpretação |
| --- | --- | --- |
| `npm ci` | PASS; instalação reproduzível pelo lockfile | Dependências foram instaladas no ambiente atual |
| `npm run validate:docs` | PASS; 56 arquivos/gates estruturais | Documentação está estruturalmente íntegra |
| `npm run typecheck` | PASS | Tipos compilam |
| `npm run lint` | PASS | ESLint passa no conjunto atual |
| `npm run test:coverage` | PASS; 293 testes em 49 arquivos | 96,08% statements/lines, 84,08% branches, 97,19% functions |
| `npm run validate:openapi` | PASS; 64 operações em 59 paths | Redocly e drift/runtime manifest passam |
| `npm run security:scan` | PASS | Nenhum segredo detectado pelo scanner local |
| `npm audit --audit-level=high` | **FAIL**; 1 vulnerabilidade HIGH | `fast-uri@3.1.5`, transitivo de `ajv@8.20.0`, com correção disponível |
| `npm run build` | PASS | Next 16.3.0 compilou e gerou as rotas estáticas |
| `npm run start` + health | Processo inicia; health não fechou em configuração local proibida | Com `NODE_ENV=production` e store/rate-limit em memória, o fail-closed retorna 500; não houve PostgreSQL disponível para uma inicialização produtiva |
| `npm run test:postgres` | **FAIL** na coleta; 6 testes do harness passaram | `vitest.postgres.config.ts` não possui alias para `@cvg/domain`; além disso, o host não tem Docker, `pg_isready`, URL PostgreSQL ou banco descartável disponível |
| `npm run test:e2e` | Primeiro passe: 43/45; duas falhas de login por rate limit compartilhado | A suíte usa memória; não é evidência PostgreSQL |
| `CI=1 npm run test:e2e` | 44 passaram e 1 teste ficou flaky no retry | O cenário tablet falhou inicialmente por limite de login e passou no retry; não é um passe limpo de primeira execução |
| `npm run test:accessibility` | PASS; 9/9 em Chromium, tablet e mobile | Axe, teclado, aria-current e targets mobile passaram nos cenários cobertos |
| `npm run perf:smoke` | PASS; 400 requests, concorrência 10, 0 erros, p95 máximo 382,08 ms | Passa o alvo sintético de 500 ms; não representa carga hospitalar |

Os números de cobertura refletem a configuração de [`vitest.config.ts`](../vitest.config.ts), que exclui partes importantes da UI, páginas da aplicação e os runtimes de store PostgreSQL/memória. A suíte PostgreSQL pretendida está descrita em [`vitest.postgres.config.ts`](../vitest.postgres.config.ts) e nos testes em `tests/postgres/`, mas não foi validada nesta revisão.

## Pontuação de partida (baseline antes da onda W0)

As notas usam as 12 dimensões congeladas em [`QUALITY_SCORECARD_95.md`](build/QUALITY_SCORECARD_95.md). Cada item considera cinco sinais com peso igual: comportamento real, testes, segurança/falhas, reprodutibilidade operacional e documentação/evidência. A meta histórica é 95; nenhum item recebe 95 apenas por ter código, rota, teste ou documento.

| ID | Item | Nota /100 | Estado atual | Fundamentação resumida |
| --- | --- | ---: | --- | --- |
| BUILD-1 | Runtime e entrega reproduzível | 84 | forte local / condicional | `npm ci`, build, servidor de desenvolvimento, E2E e smoke local funcionam; health produtivo com PostgreSQL não foi demonstrado |
| BUILD-2 | Fundação, API e contratos | 93 | forte local | TypeScript, lint, envelope, limites e OpenAPI 64/59 passam; a especificação textual da API ainda tem data/status antigos |
| BUILD-3 | Integridade e persistência | 59 | gap de prova | Migrations, audit/outbox e adapters existem, mas `test:postgres` falha na coleta e o estado clínico permanece snapshot JSONB transitório |
| BUILD-4 | Domínio e invariantes | 88 | forte local / condicional | 293 testes cobrem lifecycle, idempotência, concorrência, escopo e Lab estruturado; políticas de amostra, transferência, alta e criticidade continuam abertas |
| BUILD-5 | Identidade, acesso e escopo | 85 | forte local / externo aberto | Sessão, CSRF, RBAC, IDOR, reautenticação e escopo têm cobertura; IdP/ownership hospitalar e uma dependência HIGH ainda impedem fechamento |
| BUILD-6 | Jornadas principais | 82 | condicional | Fluxos locais de request, Lab, RX, US, resultado, anexos e critical ack estão servidos; a primeira execução E2E foi instável e não houve jornada browser contra PostgreSQL |
| BUILD-7 | Comunicação e realtime | 75 | condicional | Outbox com lease, retry, inbox e SSE/replay existem; fanout multi-instância, fallback e escalonamento crítico ainda não têm prova de produção |
| BUILD-8 | Operações e observabilidade | 78 | condicional | Busca escopada, filas, indicadores, readiness, métricas bounded e perf smoke existem; faltam carga representativa e revisão `EXPLAIN` |
| BUILD-9 | UX e acessibilidade | 81 | condicional | Axe/teclado passaram 12/12 em três viewports; inspeção manual, leitores de tela e aceite clínico permanecem sem evidência |
| BUILD-10 | Qualidade e segurança | 81 | abaixo da meta | Testes, cobertura, build, lint, typecheck, OpenAPI, docs e secret scan passam; audit HIGH, PostgreSQL quebrado e flake E2E impedem um gate limpo |
| BUILD-11 | Operação e recuperação | 55 | bloqueado por evidência | CI, compose e scripts de backup/restore existem, mas não houve restore real, object storage restore, CI remoto ou RPO/RTO aprovado |
| BUILD-12 | Rastreabilidade e mudança | 75 | condicional | Matriz, backlog, gates e validator existem; há números stale, estado do agente em commit antigo e uma alegação incorreta sobre remote `v1` |

**Cálculo:** `936 / 12 = 78/100`. Essa é uma nota de maturidade técnica local, não uma autorização de release.

## Achados prioritários do baseline antes da onda W0

### P0 — fechar antes de chamar a verificação local de completa

1. **Harness PostgreSQL não executa a suíte de integração.** [`vitest.postgres.config.ts`](../vitest.postgres.config.ts) só configura `@cvg/contracts`, enquanto `src/server/application/operational-context.ts` importa `@cvg/domain`. O comando termina com uma suíte falha antes de exercer o banco.
2. **Há uma vulnerabilidade HIGH aberta.** `fast-uri@3.1.5` é dependência transitiva de AJV e o `npm audit` aponta confusão de host e cenários SSRF. A vulnerabilidade deve ser resolvida e auditada antes de aceitar o gate de segurança.
3. **A suíte browser não é determinística no primeiro passe.** O limite de login compartilhado produziu duas falhas na execução normal; em CI, uma falha de tablet só desapareceu no retry. O teste não deve contar como passe limpo enquanto essa causa não for isolada ou explicitamente controlada.

### P1 — corrigir para preservar decisão confiável

4. **Evidência documental está misturada entre revisões.** [`TRACEABILITY_MATRIX.md`](TRACEABILITY_MATRIX.md), [`TEST_PLAN.md`](testing/TEST_PLAN.md), [`PRODUCTION_READINESS.md`](operations/PRODUCTION_READINESS.md), [`RELEASE_CHECKLIST.md`](operations/RELEASE_CHECKLIST.md) e [`USER_FLOWS.md`](ux/USER_FLOWS.md) ainda apresentam 273 testes/44 arquivos, 63 operações/58 paths e 39/39 E2E como evidência atual. A execução desta auditoria encontrou 293/49, 64/59 e um E2E com flake.
5. **O estado operacional do agente está atrasado.** [`.agent/state.json`](../.agent/state.json) aponta o commit `0a047c4`, embora o checkout esteja em `01bb180`; isso reduz a confiabilidade do ledger de decisão.
6. **O mapa afirma um remote local `v1` que não existe na configuração atual.** [`MIGRATION_MAP.md`](v2/MIGRATION_MAP.md) declara a preservação em `v1`, mas `git remote -v` e `git branch -a` exibem somente `origin/main`. A preservação histórica no Git deve ser distinguida de um remote configurado.
7. **A persistência clínica ainda não é relacional em runtime.** [`DATA_MODEL.md`](spec/DATA_MODEL.md) e a migration [`006_transitional_snapshot_boundary.sql`](../db/migrations/006_transitional_snapshot_boundary.sql) declaram `cvg_runtime_state`/JSONB como fonte autoritativa transitória. As migrations 007–009 agora fornecem tabelas, constraints, índices e `EXPLAIN` estrutural local para a seam expand-only; faltam backfill/cutover autoritativos e workload aprovado/representativo.

### Gates externos que não devem ser simulados

Continuam bloqueados: identidade institucional e ownership, transferência/alta, autoridade de delegated manager, catálogo e faixas clínicas aprovadas, thresholds e escalonamento de resultado crítico, storage/antimalware/secrets/TLS de produção, retenção/residência, RPO/RTO, restore de anexos, carga representativa, CI remoto, acessibilidade manual, aceite clínico e piloto. A lista normativa está em [`PREMIUM_MVP_V4.md`](build/PREMIUM_MVP_V4.md) e [`PRODUCTION_READINESS.md`](operations/PRODUCTION_READINESS.md).

## Ordem recomendada para continuar

1. Corrigir o alias e executar a suíte PostgreSQL em CI-equivalente; registrar migrations, concorrência, reload, rollback e duas instâncias.
2. Remediar `fast-uri`, repetir `npm audit`, a suíte completa e o build em ambiente limpo.
3. Isolar o rate limit entre testes/browser contexts e exigir primeira execução limpa, sem mascarar falhas com retries.
4. Atualizar os números e a data de evidência em todos os documentos normativos; corrigir o remote `v1` e o commit em `.agent/state.json`.
5. Executar restore PostgreSQL e storage contra serviços descartáveis, medir carga representativa e revisar planos `EXPLAIN`.
6. Consolidar a implementação local do Patient Workspace — agora disponível em `VERIFY` condicional — com crítica independente concluída e anexar as decisões humanas que fecham os gates clínicos e hospitalares.

## Estado corrente — atualização integrada

| Lane | Resultado atual | Limite que permanece |
| --- | --- | --- |
| PostgreSQL/harness | `vitest.postgres.config.ts` agora espelha os aliases dos testes principais; o packet descartável anterior registra **39/39** em 6 arquivos, com upgrade SAA-022 001→010 e retomada após `009` já aplicado, migration 009/010, reparação BACKFILL-only, backfill populado/resumível, lock de origem, serialização entre pools, projection/read/reconciliation, regressão de notificação/delivery, HTTP multi-instância, wake-up real e EXPLAIN estrutural indexado, em cluster descartável; a leitura relacional também tem `EXPLAIN` estrutural indexado. A repetição current-source aguarda `initdb`/`pg_ctl`/Docker e não tocou 5432 | A prova é local e sintética; cutover, browser contra PostgreSQL em conjunto com a seam relacional, fanout HTTP sob carga, repetição em CI/ambiente-alvo e operação produtiva permanecem abertos |
| Supply chain | `fast-uri` está em 3.1.7; `npm audit --audit-level=high` passa com 0 vulnerabilidades; npm ci, typecheck, OpenAPI, testes e build continuam verdes | Permanecem apenas avisos de depreciação/scripts do npm, sem gate HIGH aberto |
| Browser | servidor E2E é descartável e os projetos têm buckets de rate limit separados; a matriz AAA-3 current-source passou 57/57 com `--retries=0 --fail-on-flaky-tests`, incluindo fluxo principal, ciclo clínico, acessibilidade e realtime; Patient Workspace responsivo e refresh stale/degraded cobertos; packets production-like anteriores são condicionais | A evidência durable/browser do CI não foi executada remotamente; serviços reais, aceitação manual e ambiente alvo permanecem abertos |
| Relacional expand-only | migrations 007–010 e readiness contract adicionam tabelas/constraints para o núcleo clínico; a suíte ampla corrente passa **725/725** em 86 arquivos, com cobertura 92,72/85,82/94,31 na execução full corrente, incluindo app/UI, domínio, runtime e persistência; o PostgreSQL descartável anterior **39/39** em Node 22/PostgreSQL 16.15 é evidência local condicional e a repetição atual aguarda host descartável; a matriz browser passou 57/57, o lane production-like passou 51/51 e o restore smoke PostgreSQL-only passou com checksum em banco isolado | O runtime continua autoritativo em JSONB e não há migração clínica completa, dual-read contínuo, cutover, rollback de autoridade, workload aprovado/representativo, restore de object storage/configuração/chaves ou aceite de ambiente-alvo |
| CI/evidence | workflow fixa Node 22, adiciona `browser-postgres` com banco por run, build/start de produção, readiness PostgreSQL/S3 configurada, retries explícitos zero e artefatos preservados em falha; YAML/flags foram validados estaticamente | Não houve execução CI remota; release e ambiente hospitalar continuam sem prova |
| Documentação/ledger | docs validator e `git diff --check` passam; métricas, fatos de Git, barra AAA e blockers foram reconciliados | A matriz ainda exige fechamento independente requisito→código→teste→digest; gates clínicos e de produção permanecem externos |

O baseline de 78/100 continua sendo a nota de partida. O primeiro Final Critic fresco rejeitou `AAA-READY` — ver [`aaa-final-critic-20260904.md`](../.orchestrate/evidence/aaa-final-critic-20260904.md) — principalmente por persistência JSONB autoritativa e gaps distribuídos/operacionais. A crítica específica do backfill não altera essa nota global: ela fechou apenas o risco local do slice limitado após reteste. A nota pós-W0 só será recalculada após rework integrado, repetição em ambiente-alvo e nova crítica independente; não há autorização para declarar 95/100 ou `AAA-READY` neste ponto.

## Conclusão

A construção não está parada: existe um produto local navegável, testado e com fronteiras técnicas cuidadosas. O status correto, contudo, é **MVP local executável + W0 em review + núcleo relacional expand-only implementado localmente + V2/Laboratório condicional + programa hospitalar/produção não pronto**. Os gaps imediatos são mapeamento relacional completo, dual-read/cutover, EXPLAIN aprovado e recovery representativos, sink de delivery durável, fanout/telemetria multi-instância, revisão independente das demais fatias e repetição em ambiente-alvo; os gaps de release continuam sendo políticas clínicas, identidade institucional, aceite e operação produtiva. A evidência final do backfill está no [packet](../.orchestrate/evidence/v2-relational-sample-lineage-backfill-20260906.md), na [saída bruta](../.orchestrate/evidence/v2-relational-sample-lineage-backfill-run-20260906.txt) e na [crítica](../.orchestrate/evidence/v2-relational-sample-lineage-backfill-critic-20260906.md).
