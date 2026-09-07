# Documentação do CVG Diagnostics Hub

## Ordem normativa

| Fase | Artefatos | Pergunta respondida |
| --- | --- | --- |
| Reconnaissance | `discovery/DISCOVERY.md` | O que sabemos sobre o ponto de partida? |
| Discovery | `discovery/*` | Qual problema existe, para quem e em quais fluxos? |
| PRD | `prd/PRD.md` | O que o produto deve fazer e o que não fará? |
| SPEC | `spec/*`, `api/API_SPEC.md` | Como o sistema deve se comportar e persistir dados? |
| Arquitetura/UX | `architecture/*`, `ux/*`, `adr/*` | Como organizar módulos, telas e decisões duráveis? |
| Segurança/testes/operações | `security/*`, `testing/*`, [operations/*](operations/OBSERVABILITY.md), [runbooks](operations/INCIDENT_RUNBOOKS.md) | Como operar com segurança e saber que está correto? |
| Build | `build/*` | Em que ordem construir e validar? |
| Barra de qualidade histórica (95) | `build/QUALITY_SCORECARD_95.md`, `build/ROADMAP_95.md`, `build/BACKLOG_95.md` | O que significava 95/100 e qual era a sequência histórica? |
| State of Art / AAA-2 histórico | [Barra](build/AAA_2_QUALITY_BAR.md), [plano executivo](build/AAA_2_EXECUTIVE_PLAN.md), [roadmap](build/AAA_2_ROADMAP.md), [backlog](build/AAA_2_BACKLOG.md) | Qual foi a execução histórica que antecedeu o AAA-3? |
| State of Art / Triplo AAA (AAA-3 atual) | [Plano executivo](build/STATE_OF_ART_TRIPLE_AAA_EXECUTIVE_PLAN.md), [roadmap](build/STATE_OF_ART_TRIPLE_AAA_ROADMAP.md), [backlog](build/STATE_OF_ART_TRIPLE_AAA_BACKLOG.md) | Como conduzir o candidato técnico até aceite clínico, piloto e release governado? |
| AAA-1 histórica | [Barra](build/STATE_OF_ART_QUALITY_BAR.md), [plano](build/EXECUTIVE_IMPROVEMENT_PLAN.md), [roadmap](build/STATE_OF_ART_ROADMAP.md), [backlog](build/STATE_OF_ART_BACKLOG.md) | Qual era o planejamento anterior e como rastrear seus IDs? |
| Rastreabilidade | `TRACEABILITY_MATRIX.md` | Como cada problema chega a requisito, teste e task? |

## Classificação de conhecimento

Todo conteúdo relevante usa uma destas marcas:

- `FACT` — veio da reconnaissance ou foi explicitamente fornecido no briefing.
- `ASSUMPTION` — hipótese útil para avançar, ainda não validada no hospital.
- `DECISION` — escolha de produto/técnica proposta para esta versão documental.
- `OPEN QUESTION` — informação que precisa de decisão/validação humana.

Uma decisão documental não transforma uma hipótese operacional em fato. Perguntas clínicas e de governança permanecem no registro de perguntas abertas e nos gates de produção.

## Snapshot executável mais recente

Em 07/09/2026, a revalidação final local passou **725/725 testes em 86 arquivos**,
com 92,72% statements/lines, 85,82% branches e 94,31% functions na execução full corrente; o [addendum frontend corrente](RELATORIO_FRONTEND_STATE_OF_ART_ADDENDUM_2026-09-07.md) separa os deltas de UI já revalidados do parecer visual histórico; build Next.js
16.3.0; a matriz browser completa passou **60/60** sem retry em Chromium,
tablet e mobile, incluindo fluxo principal, ciclo clínico, acessibilidade (12/12)
e realtime;
security scan, `npm audit` de produção, SBOM CycloneDX com 560 componentes sob Node 22,
performance 7/7 e recovery 5/5.
O packet PostgreSQL descartável anterior passou 39/39 em 6 arquivos em cluster
isolado PostgreSQL 16.15; a repetição corrente ficou bloqueada por ausência de
`initdb`/`pg_ctl`/Docker, a instância persistente em 127.0.0.1:5432 não foi
tocada e JSONB continua a
autoridade clínica. O lane local production-like passou 51/51 com `next start`,
PostgreSQL, S3/scanner sintéticos e outbox durável; o restore smoke PostgreSQL-only
passou em banco restaurado isolado com checksum. Consulte o [relatório corrente](RELATORIO_AUDITORIA_2026-09-07.md),
o [manifesto de evidências](../.orchestrate/aaa3-execution-20260907/evidence-manifest.json),
o [quality bar](../.orchestrate/aaa3-execution-20260907/quality-bar.json) e os
[planos AAA-3](build/STATE_OF_ART_TRIPLE_AAA_EXECUTIVE_PLAN.md). Isso é evidência
local condicional, não aprovação de produção ou clínica.

Atualização de evidência em 07/09/2026: a lacuna de linha do tempo densa foi
fechada com fixture determinístico colapsado/expandido e 20 PNGs atuais em
1440/834/375 CSS px, cobrindo ready/loading/error-denied/empty/partial/stale e
variantes dense. O packet visual corrente está em
`.orchestrate/evidence/visual-patient-workspace-20260907/`; revisão manual,
golden, aceite alvo/humano e produção continuam abertos.

## Convenções

- Documentação em português; nomes de entidades, enums, eventos e APIs em inglês estável.
- Datas e horários de persistência em UTC; apresentação em `pt-BR` e no fuso configurado do hospital.
- IDs de requisitos: `FR-*` para funcionais, `NFR-*` para não funcionais, `AC-*` para acceptance criteria, `TEST-*` para validação e `BLD-*` para tasks.
- Mermaid é usado para modelos e fluxos. Diagramas são explicativos; o contrato textual ao lado é normativo.
- “Item diagnóstico” é a unidade operacional rastreada. “Serviço diagnóstico” é a capacidade/catálogo que define seu workflow.

## Fonte de verdade por assunto

| Assunto | Fonte normativa |
| --- | --- |
| Escopo e prioridade | `prd/PRD.md` |
| Entidades e invariantes | `spec/DOMAIN_MODEL.md` |
| Estados e transições | `spec/STATE_MACHINES.md` |
| Persistência | `spec/DATA_MODEL.md` |
| Acesso | `spec/PERMISSIONS.md` |
| API e erros | `api/API_SPEC.md` (ponteiro opcional em `spec/API_SPEC.md`) e `spec/ERROR_MODEL.md` |
| Notificações/realtime | `spec/NOTIFICATIONS.md` e `spec/REALTIME.md` |
| Segurança | `security/SECURITY.md`, `security/THREAT_MODEL.md`, `security/KNOWN_BAD_CONTROL_MATRIX.md` e `security/ADVERSARIAL_REVIEW_SUPPLEMENT_2026-09-07.md` |
| Ordem de construção atual | `build/STATE_OF_ART_TRIPLE_AAA_ROADMAP.md` e `build/STATE_OF_ART_TRIPLE_AAA_BACKLOG.md`; `build/BUILD_PLAN.md` permanece como decomposição original |
| Barra, plano e estado AAA atual | `.orchestrate/aaa3-execution-20260907/quality-bar.json`, `build/STATE_OF_ART_TRIPLE_AAA_EXECUTIVE_PLAN.md`, `build/STATE_OF_ART_TRIPLE_AAA_ROADMAP.md`, `build/STATE_OF_ART_TRIPLE_AAA_BACKLOG.md` |

Quando dois documentos divergirem, a divergência é um defeito de documentação: corrigir a fonte apropriada e a matriz de rastreabilidade antes do BUILD.

## Estado da entrega

A auditoria de baseline é o [relatório de 05/09/2026](RELATORIO_AUDITORIA_2026-09-05.md): maturidade técnica **63/100**, documentação **77/100** e produção **NOT READY**. Essa fotografia registrou as falhas que deram origem ao AAA-2. A baseline corrente do AAA-3 executa `npm run test:coverage` com **725/725** testes em 86 arquivos, cobertura de 92,72% statements/lines, **85,82% branches** e 94,31% functions, além de typecheck, lint, build, OpenAPI, documentação, security scan, audit, SBOM e inventário estrutural de rastreabilidade sem falhas. A API validada contém 65 operações em 60 paths. A matriz Playwright local passou **60/60** sem retry em Chromium, tablet e mobile, incluindo fluxo principal, ciclo clínico, acessibilidade (12/12) e realtime. O packet PostgreSQL descartável anterior passou 39/39 em 6 arquivos em Node 22/PostgreSQL 16.15, incluindo o upgrade SAA-022 001→010 e a retomada com `009` já aplicado; a repetição corrente não foi possível sem `initdb`/`pg_ctl`/Docker e não tocou a instância persistente. O lane local production-like passou 51/51 contra `next start`, PostgreSQL, S3/scanner sintéticos e outbox durável, e o restore smoke PostgreSQL-only passou com checksum em banco isolado. O packet visual atual tem 20 artefatos nos três viewports e registra estados de leitura parcial com indisponibilidade explícita, snapshot stale preservado e status de frescor visível; a revisão peer de delta mais recente e o suplemento adversarial estão anexados e mantêm o candidato BLOCKED para AAA-READY. JSONB continua a autoridade clínica. Nenhum desses ensaios prova cutover, produção ou aceite hospitalar. Carga representativa, failover, storage/AV real, restore completo, CI remoto, políticas humanas, revisão manual, golden e aceite hospitalar permanecem sem demonstração.

O [programa AAA-3](build/STATE_OF_ART_TRIPLE_AAA_EXECUTIVE_PLAN.md), com [roadmap](build/STATE_OF_ART_TRIPLE_AAA_ROADMAP.md), [backlog](build/STATE_OF_ART_TRIPLE_AAA_BACKLOG.md), quality bar congelado, manifesto de evidências e [parecer fresco mais recente](../.orchestrate/aaa3-execution-20260907/independent-critic-report-round8.md), é o conjunto atual de execução. Seu estado é **CONDITIONAL PASS LOCAL / BLOCKED PARA AAA-READY**; evidência local não substitui integração PostgreSQL, decisões humanas, homologação durável ou piloto. O AAA-2 permanece histórico de execução anterior.

Antes de fechar ou compartilhar o packet corrente, execute `npm run validate:aaa3`.
O verificador confere artefatos obrigatórios, métricas atuais, revisor fresco,
disposição de release e fingerprint completo da árvore de trabalho; ele falha
fechado quando qualquer evidência fica stale e não concede aprovação clínica ou
produtiva.

O [relatório de 04/09](PROJECT_STATUS_REPORT.md), a rodada AAA-1 e seus resultados permanecem históricos. O primeiro parecer independente daquela rodada está em [aaa-final-critic-20260904.md](../.orchestrate/evidence/aaa-final-critic-20260904.md), com resultado REJECT. O [state.md](../.gauntlet/state.md) é o snapshot histórico preservado; o [progress.md](../.gauntlet/progress.md) e o [state.json](../.gauntlet/state.json) são o estado gerado do ciclo Gauntlet AAA-3. O snapshot bruto anterior também está preservado em [.gauntlet-legacy-20260906](../.gauntlet-legacy-20260906/). Nenhum desses registros substitui a baseline atual ou autoriza produção.
