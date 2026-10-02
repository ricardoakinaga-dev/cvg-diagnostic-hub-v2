# Documentação do CVG Diagnostics Hub


## Ordem normativa

| Fase | Artefatos | Pergunta respondida |
| --- | --- | --- |
| Reconnaissance | `discovery/DISCOVERY.md` | O que sabemos sobre o ponto de partida? |
| Discovery | `discovery/*` | Qual problema existe, para quem e em quais fluxos? |
| PRD | `prd/PRD.md` | O que o produto deve fazer e o que não fará? |
| SPEC | `spec/*`, `api/API_SPEC.md` | Como o sistema deve se comportar e persistir dados? |
| Fatia V2 (migração e verticais) | [Migração](v2/MIGRATION_MAP.md), [Patient Workspace](v2/PATIENT_WORKSPACE.md), [Laboratório](v2/LABORATORY_VERTICAL.md), [Lineage de amostra](v2/RELATIONAL_SAMPLE_LINEAGE.md), [Barra](v2/QUALITY_BAR.md) | Como as fatias V2 migram autoridade, abrem verticais e mantêm a barra de qualidade sem quebrar o MVP? |
| Arquitetura/UX | `architecture/*`, `ux/*`, `adr/*` | Como organizar módulos, telas e decisões duráveis? |
| Segurança/testes/operações | `security/*`, `testing/*`, [operations/*](operations/OBSERVABILITY.md), [deploy de produção](operations/DEPLOYMENT.md), [runbooks](operations/INCIDENT_RUNBOOKS.md) | Como operar com segurança e saber que está correto? |
| Build | `build/*` | Em que ordem construir e validar? |
| Barra de qualidade histórica (95) | `build/QUALITY_SCORECARD_95.md`, `build/ROADMAP_95.md`, `build/BACKLOG_95.md` | O que significava 95/100 e qual era a sequência histórica? |
| State of Art / AAA-2 histórico | [Barra](build/AAA_2_QUALITY_BAR.md), [plano executivo](build/AAA_2_EXECUTIVE_PLAN.md), [roadmap](build/AAA_2_ROADMAP.md), [backlog](build/AAA_2_BACKLOG.md) | Qual foi a execução histórica que antecedeu o AAA-3? |
| State of Art / Triplo AAA (AAA-3 atual) | [Plano executivo](build/STATE_OF_ART_TRIPLE_AAA_EXECUTIVE_PLAN.md), [roadmap](build/STATE_OF_ART_TRIPLE_AAA_ROADMAP.md), [backlog](build/STATE_OF_ART_TRIPLE_AAA_BACKLOG.md) | Como conduzir o candidato técnico até aceite clínico, piloto e release governado? |
| AAA-1 histórica | [Barra](build/STATE_OF_ART_QUALITY_BAR.md), [plano](build/EXECUTIVE_IMPROVEMENT_PLAN.md), [roadmap](build/STATE_OF_ART_ROADMAP.md), [backlog](build/STATE_OF_ART_BACKLOG.md) | Qual era o planejamento anterior e como rastrear seus IDs? |
| Rastreabilidade | `TRACEABILITY_MATRIX.md` | Como cada problema chega a requisito, teste e task? |
| Auditoria independente de 01/10/2026 | [Relatório](RELATORIO_AUDITORIA_2026-10-01.md), [plano](build/AUDIT_2026_10_EXECUTIVE_PLAN.md), [roadmap](build/AUDIT_2026_10_ROADMAP.md), [backlog](build/AUDIT_2026_10_BACKLOG.md) | O que a auditoria mais recente mediu e em que ordem corrigir? |

## Classificação de conhecimento

Todo conteúdo relevante usa uma destas marcas:

- `FACT` — veio da reconnaissance ou foi explicitamente fornecido no briefing.
- `ASSUMPTION` — hipótese útil para avançar, ainda não validada no hospital.
- `DECISION` — escolha de produto/técnica proposta para esta versão documental.
- `OPEN QUESTION` — informação que precisa de decisão/validação humana.

Uma decisão documental não transforma uma hipótese operacional em fato. Perguntas clínicas e de governança permanecem no registro de perguntas abertas e nos gates de produção.

## Snapshot executável corrente — AUDIT-2026-10 (01/10/2026)

O working tree corrente passou `npm run test:coverage` com **745 testes unitários em 89 arquivos** e **39 testes PostgreSQL em 6 arquivos**, totalizando **784 testes** na cobertura agregada. A cobertura foi 94,90% lines, 95,45% functions e 89,31% branches; o `coverage:gate` passou com 28 exceções versionadas, sem arquivos `uncovered` ou `stale`. A matriz Playwright passou **63/63** sem retry, incluindo visual 3/3 e acessibilidade 12/12. Typecheck, lint, build, security scan, OpenAPI 65/60, traceabilidade 43/43, mutation 7/7 e testes negativos do coverage gate passaram. O candidato continua `CONDITIONAL PASS LOCAL / BLOCKED` para produção clínica: inspeção manual, autoridade operacional, CI remoto, workload/failover, RPO/RTO, secret manager, cutover e aceite hospitalar permanecem abertos.

## Snapshot AAA-3 histórico (07/09/2026)

Em 07/09/2026, a revalidação final local passou **725/725 testes em 86 arquivos**,
com 92,72% statements/lines, 85,79% branches e 94,37% functions na execução full corrente (valores medidos, reconciliados em 01/10/2026); o [addendum frontend corrente](RELATORIO_FRONTEND_STATE_OF_ART_ADDENDUM_2026-09-07.md) separa os deltas de UI já revalidados do parecer visual histórico; build Next.js
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
| Glossário e vocabulário canônico | [`GLOSSARY.md`](GLOSSARY.md) |
| Decisões de produto/técnica e registro de mudanças | [`DECISION_LOG.md`](DECISION_LOG.md); decisões arquiteturais duráveis com ADR em [`adr/README.md`](adr/README.md) |

Quando dois documentos divergirem, a divergência é um defeito de documentação: corrigir a fonte apropriada e a matriz de rastreabilidade antes do BUILD.

## Estado da entrega

O snapshot AAA-3 histórico é o [relatório de 05/09/2026](RELATORIO_AUDITORIA_2026-09-05.md) e as revalidações de 07/09/2026. A execução corrente AUDIT-2026-10 está documentada acima; as métricas antigas abaixo permanecem apenas como histórico e não substituem a baseline de 01/10/2026.

O [programa AAA-3](build/STATE_OF_ART_TRIPLE_AAA_EXECUTIVE_PLAN.md), com [roadmap](build/STATE_OF_ART_TRIPLE_AAA_ROADMAP.md), [backlog](build/STATE_OF_ART_TRIPLE_AAA_BACKLOG.md), quality bar congelado, manifesto de evidências e [parecer fresco mais recente](../.orchestrate/aaa3-execution-20260907/independent-critic-report-round8.md), é o conjunto atual de execução. Seu estado é **CONDITIONAL PASS LOCAL / BLOCKED PARA AAA-READY**; evidência local não substitui integração PostgreSQL, decisões humanas, homologação durável ou piloto. O AAA-2 permanece histórico de execução anterior.

A [auditoria independente de 01/10/2026](RELATORIO_AUDITORIA_2026-10-01.md) mediu o repositório em `main` com reprodução local dos gates e atribuiu **76/100** globais (arquitetura 82, testes e CI/CD 84, segurança 74, documentação 85, UX 74, operações 57, higiene 52, processo 80), com `npm audit` em falha e dois gates de garantia aprovando de forma falsa. A correção dessa onda está no [plano executivo](build/AUDIT_2026_10_EXECUTIVE_PLAN.md), no [roadmap](build/AUDIT_2026_10_ROADMAP.md) e no [backlog de 40 itens](build/AUDIT_2026_10_BACKLOG.md); nenhum deles altera o estado `BLOCKED` do candidato nem os gates clínicos do AAA-3.

Antes de fechar ou compartilhar o packet corrente, execute `npm run validate:aaa3`.
O verificador confere artefatos obrigatórios, métricas atuais, revisor fresco,
disposição de release e fingerprint completo da árvore de trabalho; ele falha
fechado quando qualquer evidência fica stale e não concede aprovação clínica ou
produtiva.

O [relatório de 04/09](PROJECT_STATUS_REPORT.md), a rodada AAA-1 e seus resultados permanecem históricos. O primeiro parecer independente daquela rodada está em [aaa-final-critic-20260904.md](../.orchestrate/evidence/aaa-final-critic-20260904.md), com resultado REJECT. O [state.md](../.gauntlet/state.md) é o snapshot histórico preservado; o [progress.md](../.gauntlet/progress.md) e o [state.json](../.gauntlet/state.json) são o estado gerado do ciclo Gauntlet AAA-3. O snapshot bruto anterior também está preservado em [.gauntlet-legacy-20260906](../.gauntlet-legacy-20260906/). Nenhum desses registros substitui a baseline atual ou autoriza produção.
