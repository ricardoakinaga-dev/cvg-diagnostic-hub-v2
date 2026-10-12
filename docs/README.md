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
| Segurança/testes/operações | `security/*`, `testing/*`, [operations/*](operations/OBSERVABILITY.md), [deploy de produção](operations/DEPLOYMENT.md), [runbooks](operations/INCIDENT_RUNBOOKS.md), [importação do catálogo](operations/CATALOG_IMPORT.md), [cadastro de pacientes no piloto](operations/PATIENT_REGISTRATION_PILOT.md), [plantão e manutenção](operations/ON_CALL_AND_MAINTENANCE.md), [pedidos do titular (LGPD)](operations/DATA_SUBJECT_REQUESTS.md) | Como operar com segurança e saber que está correto? |
| Build | `build/*` | Em que ordem construir e validar? |
| Evolução para planner hospitalar veterinário (11/10/2026) | [Roadmap](build/ROADMAP_HOSPITAL_PLANNER_2026-10-11.md), [backlog](build/BACKLOG_HOSPITAL_PLANNER_2026-10-11.md), [matriz de pareamento](avaliacoes/plane-preview-2026-10-11/relatorio.html) | Como evoluir cadastros, acesso e planejamento hospitalar com rastreabilidade e critérios de aceite? |
| Plano até produção (corrente) | [Plano](build/PRODUCTION_PLAN.md), [roadmap](build/PRODUCTION_ROADMAP.md), [backlog](build/PRODUCTION_BACKLOG.md), [auditoria de 02/10/2026](RELATORIO_AUDITORIA_2026-10-02.md), [revisão da entrega do agente](RELATORIO_REVISAO_ENTREGA_AGENTE_2026-10-02.md) | O que falta, em que ordem e com que critério, para declarar o programa pronto para produção? |
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

## Imagens e permissões persistidas — candidata de 12/10/2026

A [nova alteração](build/HOSPITAL_PLANNER_IMAGE_AUTHORITY_FOLLOWUP_2026-10-12.md) fixa a base Alpine das imagens, remove gestores globais de runtime, inclui vulnerabilidades sem correção nos gates e acrescenta 20 cenários de autoridade efetiva em PostgreSQL. O [registro](build/HOSPITAL_PLANNER_IMAGE_AUTHORITY_FOLLOWUP_2026-10-12.json) conserva o smoke de protótipo com 63 checks e os dois ensaios PostgreSQL; essas provas antecedem a adoção. CI e quatro imagens da [nova fonte](build/HOSPITAL_PLANNER_IMAGE_AUTHORITY_SOURCE_MANIFEST_2026-10-12.json) serão vinculadas ao commit no [PR #78](https://github.com/ricardoakinaga-dev/cvg-diagnostic-hub-v2/pull/78). Aceite hospitalar, HIS e revisão externa continuam pendentes.

## Correção anterior do teste de privacidade de alertas — captura de 12/10/2026

O [teste de alerta crítico](build/HOSPITAL_PLANNER_ALERT_PRIVACY_TEST_FOLLOWUP_2026-10-12.md) agora aceita o UUID legítimo que colidiu com um fragmento de telefone sintético e exige a estrutura completa da mensagem. Os 14 testes passaram e três alterações temporárias do produtor com PII foram rejeitadas, sem mudar produto ou guards. Apenas esse teste difere no [manifesto daquela captura](build/HOSPITAL_PLANNER_ALERT_PRIVACY_TEST_SOURCE_MANIFEST_2026-10-12.json). A CI 38214466428 permanece FAIL; a nova CI e imagens serão ligadas ao novo commit no [PR #78](https://github.com/ricardoakinaga-dev/cvg-diagnostic-hub-v2/pull/78). Piloto e gates no alvo continuam pendentes.

## Validação anterior da fixture de UX — captura de 12/10/2026

A [correção da sequência e das expectativas de acesso](build/HOSPITAL_PLANNER_UX_FIXTURE_FOLLOWUP_2026-10-12.md) preserva o cadastro, busca de paciente além dos primeiros 100, criação do exame e revogação de sessão. Seis casos de UX e três checks da Home passaram no executor canônico, sem retries. Só o teste de UX mudou no [manifesto daquela captura](build/HOSPITAL_PLANNER_UX_FIXTURE_SOURCE_MANIFEST_2026-10-12.json); produto e guards permanecem iguais. A CI 38209256914 continua FAIL, e a nova rodada e imagens serão ligadas ao novo commit no [PR #78](https://github.com/ricardoakinaga-dev/cvg-diagnostic-hub-v2/pull/78). Capturas anteriores e aceite hospitalar são preservados.

## Correção anterior da política de cobertura — captura de 12/10/2026

O [ajuste das exceções](build/HOSPITAL_PLANNER_COVERAGE_POLICY_FOLLOWUP_2026-10-12.md) remove uma entrada obsoleta após 5.460 testes aprovados na rodada 38207033632, sem alterar pisos ou produto. O [novo manifesto](build/HOSPITAL_PLANNER_COVERAGE_POLICY_SOURCE_MANIFEST_2026-10-12.json) muda apenas esse input normativo. A CI anterior permanece FAIL e a nova validação completa será ligada ao SHA do [PR #78](https://github.com/ricardoakinaga-dev/cvg-diagnostic-hub-v2/pull/78). As provas literais anteriores e os gates hospitalares são preservados.

## Auditoria literal anterior — captura de 12/10/2026

A [revisão literal e suas correções](build/HOSPITAL_PLANNER_LITERAL_ACCEPTANCE_FOLLOWUP_2026-10-12.md), a [matriz de evidências](build/HOSPITAL_PLANNER_LITERAL_ACCEPTANCE_FOLLOWUP_2026-10-12.json) e o [manifesto da fonte](build/HOSPITAL_PLANNER_LITERAL_ACCEPTANCE_SOURCE_MANIFEST_2026-10-12.json) cobrem as 51 entregas, 137 itens e 15 garantias. Foram corrigidos acesso à auditoria, comandos por grants específicos, preview de pendências na desativação de setores e o caminho de aprovação clínica de exames. A captura registra validação focada; nova CI e imagens são acompanhadas no [PR #78](https://github.com/ricardoakinaga-dev/cvg-diagnostic-hub-v2/pull/78). Aceite hospitalar, homologação HIS e revisão externa permanecem pendentes. O solicitante fará a validação e o aceite do piloto.

## CI e revisão anterior do planner — captura de 12/10/2026

O [registro daquela captura](build/HOSPITAL_PLANNER_BROWSER_POSTGRES_FOLLOWUP_2026-10-12.md), a [evidência](build/HOSPITAL_PLANNER_BROWSER_POSTGRES_FOLLOWUP_2026-10-12.json) e o [manifesto](build/HOSPITAL_PLANNER_BROWSER_POSTGRES_SOURCE_MANIFEST_2026-10-12.json) acompanham as correções da edição de amostra, da ação encoberta pela navegação e da preparação laboratorial sintética para PostgreSQL. A quarta CI passou 5.305 testes de backend, 195 cenários na matriz completa de navegador e a imagem, mas falhou em 9/48 jornadas PostgreSQL. A nova rodada completa será acompanhada no [PR #78](https://github.com/ricardoakinaga-dev/cvg-diagnostic-hub-v2/pull/78); capturas/falhas anteriores continuam preservadas.

O solicitante confirmou que fará a validação dos fluxos e o aceite do piloto, conforme o [registro de responsabilidade](operations/HOSPITAL_PLANNER_PILOT_OWNER_2026-10-12.json). O [pacote de UAT](operations/HOSPITAL_PLANNER_PILOT.md) conserva cenários e fichas; execução, resultados e aceite continuam pendentes. Homologação HIS permanece parcial.

O [registro do sentinel](build/HOSPITAL_PLANNER_MUTATION_CI_FOLLOWUP_2026-10-12.md) e o [registro do relógio](build/HOSPITAL_PLANNER_CI_FOLLOWUP_2026-10-12.md) conservam as provas e os erros das candidatas anteriores. Seus resultados não certificam os novos inputs de produto/teste.

## Compatibilidade HIS — captura anterior de 12/10/2026

O [registro de 12/10](build/HOSPITAL_PLANNER_HIS_CONTRACT_FOLLOWUP_2026-10-12.md), a [evidência estruturada](build/HOSPITAL_PLANNER_HIS_CONTRACT_FOLLOWUP_2026-10-12.json) e o [manifesto daquela captura](build/HOSPITAL_PLANNER_SOURCE_MANIFEST_2026-10-12.json) acompanham o reparo do evento HIS real com metadata, o contrato Unicode e a preparação do commit/PR. Passaram 40 testes HIS, 19 de contrato e quatro GETs do catálogo HTTPS nativo em memória. A CI completa é acompanhada no [GitHub Actions da branch](https://github.com/ricardoakinaga-dev/cvg-diagnostic-hub-v2/actions?query=branch%3Afeat%2Fhospital-planner-20261012). As provas completas de 11/10 descritas abaixo são históricas, atribuídas às fontes originais; a alteração posterior de produto exige nova validação global. Homologação HIS e piloto permanecem abertos.

## Pareamento com o Plane — planner hospitalar veterinário (11/10/2026)

A [matriz interativa](avaliacoes/plane-preview-2026-10-11/relatorio.html) compara 83 capacidades Community do Plane `preview` com o Hub, identifica 8 limites da referência, 18 requisitos hospitalares, 8 defeitos de uso atuais e 20 melhorias de cadastros e controle de acesso, totalizando 137 itens. Cada item traz situação, prioridade, evidências no código, ação proposta e critério de aceite. A avaliação inclui o pareamento de conceitos, os nove perfis e a ordem de implementação proposta.

Os dados completos estão disponíveis em [CSV](avaliacoes/plane-preview-2026-10-11/matriz.csv) e [JSON](avaliacoes/plane-preview-2026-10-11/matriz.json). O Plane foi fixado no commit `bab49bb978ccb56af1d78dec6c6d54dfe8d03c1c` e o Hub em `a94e77f4443f700bbb073108594090d40efa4496`. Esta é uma avaliação estática de pareamento funcional; ela não substitui os gates de produção nem a homologação hospitalar.

A ampliação administrativa usa o checkout local do CVG HIS v4 no commit `0ebfc5b6627c8ed006075dc5285fd3514443c806` como referência de estrutura. A [matriz de melhorias de cadastros e acessos](avaliacoes/plane-preview-2026-10-11/matriz-cadastros-acessos.csv) cobre setores, serviços, exames, usuários, grupos, delegação e revogação. A [matriz atual de permissões](avaliacoes/plane-preview-2026-10-11/matriz-permissoes-atuais.csv) extrai 55 permissões por nove perfis do servidor, sempre sujeitas ao escopo e às demais regras clínicas. O relatório distingue grupo de perfil, catálogo de execução e colunas visuais de autorização efetiva; também registra limitações da referência HIS que não devem ser reproduzidas no Hub.

O [roadmap hospitalar](build/ROADMAP_HOSPITAL_PLANNER_2026-10-11.md) organiza seis fases por dependência: correções da base, cadastros e acesso, tarefas, planos/plantões/recursos, colaboração/gestão e conveniências opcionais. O [backlog hospitalar](build/BACKLOG_HOSPITAL_PLANNER_2026-10-11.md) consolida 112 lacunas em 50 entregas, acrescenta um gate de piloto e dá destino aos 137 itens, incluindo garantias a preservar, exclusões e investigações. Prioridades, dependências, responsáveis propostos, critérios de aceite e evidências exigidas estão registrados; o planejamento não declara implementação concluída nem substitui os gates de produção (D-063).

A execução está no [acompanhamento do backlog](build/BACKLOG_HOSPITAL_PLANNER_2026-10-11.md#execucao), no [registro de implementação](build/HOSPITAL_PLANNER_IMPLEMENTATION_2026-10-11.md) e na [auditoria por entrega](build/HOSPITAL_PLANNER_ACCEPTANCE_AUDIT_2026-10-11.json). A [revisão funcional posterior](build/HOSPITAL_PLANNER_FUNCTIONAL_FOLLOWUP_2026-10-11.json) registra os reparos de agenda, capacidade e cronograma (032/036/047): 110 e 25 testes direcionados aprovados, revisão independente e duas novas jornadas de navegador. A candidata capturada em 11/10 tinha **1.082 arquivos** no [manifesto](build/HOSPITAL_PLANNER_SOURCE_MANIFEST_2026-10-11.json), então sem commit. O produto corrigido passou em **5.283 testes** (5.142 unitários + 141 PostgreSQL); cobertura de linhas **98,41%**, sem novas exceções. O navegador reúne **195 cenários por composição (192 + 2 + 1)**, conservando as tentativas que falharam. Imagens, SBOM, scan, 18 verificações de execução e perfil HTTP curto passaram. Naquela captura, a diferença entre os inputs medidos e a fonte bf1e era um teste E2E; tipos/lint passaram novamente e o [registro do snapshot](build/HOSPITAL_PLANNER_VALIDATION_2026-10-11.json) qualifica o reuso dos inputs idênticos e o gate hospitalar ainda aberto.

O [histórico de validação](build/HOSPITAL_PLANNER_VALIDATION_HISTORY_2026-10-11.json) conserva as capturas anteriores e suas falhas, incluindo os 5.260 testes aprovados da fonte operacional de 1.079 arquivos e as 189 jornadas compostas de uma captura anterior. Essas provas não certificam os novos reparos; a [cobertura persistida](build/HOSPITAL_PLANNER_COVERAGE_2026-10-11.json) conserva o G4 completo de 11/10 com 5.283 testes. A diferença registrada naquele snapshot afetava somente um teste de navegador; o reparo HIS de 12/10 está no novo registro.

A [preparação do cutover hospitalar](operations/HOSPITAL_PLANNER_CUTOVER.md) registra migrações, preservação de matrizes reduzidas, inventário real, reconciliação de leitos e rotinas do worker. O [pacote de UAT e piloto](operations/HOSPITAL_PLANNER_PILOT.md) reúne jornadas por ator, nove perfis/grupos/escopos, pré-requisitos, HIS v4 e fichas de resultados/aceite a preencher pelo hospital. O HIS informado é o `cvg-his-v4` instalado na VPS; LIS e PACS permanecem desconhecidos. A integração HIS real (HPL-042) e o aceite do piloto (HPL-051) continuam pendentes. A validação local não publica uma versão nem concede aprovação de produção.

O [ensaio de recuperação HPL](build/HOSPITAL_PLANNER_RECOVERY_EVIDENCE_2026-10-11.json) registra 17 verificações com PostgreSQL e scripts oficiais, incluindo permissões revogadas, anexos e sessões. Foi executado em ambiente sintético descartável; recuperação no alvo hospitalar e RPO/RTO continuam pendentes.

A [captura operacional anterior](build/HOSPITAL_PLANNER_OPERATIONAL_EVIDENCE_2026-10-11.json) registra [monitor PostgreSQL](operations/MONITORING.md), [perfil de performance HPL](operations/HOSPITAL_PLANNER_PERFORMANCE.md) e build/scan/18 verificações de execução das imagens da captura de 1.079 arquivos. Esse G4 passou completo; a rodada anterior de 5.113 unitários PASS/duas falhas, sem execução PostgreSQL, permanece histórica. Carga curta, scans e reuso de navegador conservam seus limites; produção e homologação hospitalar continuam abertas.

## Auditoria histórica de dependências (07/10/2026)

A [revisão dos PRs de dependências #15 e #23](RELATORIO_AUDITORIA_DEPENDENCIAS_2026-10-07.md) confere os merges, o CI remoto, a revalidação local sob Node 22, as regras do Dependabot e os limites das migrações adiadas.

## Auditoria corrente — experiência Plane (06/10/2026)

O [relatório de 06/10/2026](RELATORIO_AUDITORIA_2026-10-06.md) registra os achados, correções e validações da migração D-029 na branch `feat/plane-experience`. A evidência desta interface complementa os gates e pendências institucionais do programa de produção.

A [auditoria de prontidão de 06/10/2026](RELATORIO_AUDITORIA_PRODUCAO_2026-10-06.md) cobre CI, imagens, deploy em Compose, backup/restore ensaiado, integrações e responsividade, com as correções aplicadas na mesma branch.

O [pacote de decisões de 08/10/2026](build/PACOTE_DECISOES_2026-10-08.md) reúne, para os responsáveis do hospital, as 12 decisões (D1–D12) que faltam para a produção, com opções, propostas e o que cada uma destrava.

O [relatório de escala de 08/10/2026](RELATORIO_ESCALA_2026-10-08.md) mede o runtime de 1 a 35 meses de dados depois do snapshot compartilhado, dos índices e do armazenamento por entidade (D-030, migration 015), e registra o dimensionamento de memória.

O [registro da auditoria de remediação de 09/10/2026](RELATORIO_AUDITORIA_REMEDIACAO_2026-10-09.md) conserva a revisão do candidato `3d47f1f`, as evidências locais e os dois achados médios. O relatório identifica as correções posteriores já presentes na main e não substitui sua revalidação.

## Snapshot executável anterior — auditoria de 04/10/2026

Reproduzido na [auditoria de 04/10/2026](RELATORIO_AUDITORIA_2026-10-04.md) com PostgreSQL 16 descartável: **1.449/1.449 testes unitários** em 126 arquivos e **96/96 testes PostgreSQL** em 17 arquivos. Cobertura agregada de **96,83% lines, 95,48% functions e 89,47% branches**; `coverage:gate` PASS com **22 exceções** declaradas, nenhuma nova. `validate:docs`, OpenAPI (**73 operações em 68 paths**), rastreabilidade (43/43), migrations (**001–014**), `perf:snapshot:gate`, `perf:realtime-budget`, typecheck, lint, build e `npm audit` (0 vulnerabilidades) passaram.

A auditoria e o outbox saíram do snapshot (migrations 013 e 014, [D-025](DECISION_LOG.md)); a atualização que as contém exige parar o app antes do `migrate` ([DEPLOYMENT §4.1](operations/DEPLOYMENT.md)). A UX diária foi simplificada ([D-024](DECISION_LOG.md)): criar usuário em 4 interações, trocar setor em 2, liberar resultado em 1.

Atualização de 05/10: candidato `63945e7` publicado com [CI remoto 37275985295](https://github.com/ricardoakinaga-dev/cvg-diagnostic-hub-v2/actions/runs/37275985295) completo verde e `main` protegida; COR-02/PROD-002 concluídos. Abertos: carga com p95 em staging (PROD-110), decisões D1–D12, infraestrutura institucional, pentest, UAT e piloto. Ver o [backlog até produção](build/PRODUCTION_BACKLOG.md) e, para correções e melhorias, o [roadmap](build/IMPROVEMENT_ROADMAP_2026-10.md) e o [backlog](build/IMPROVEMENT_BACKLOG_2026-10.md) de 04/10/2026.

## Snapshot executável anterior — PROD-2026-10.1 (03/10/2026)

Histórico: 912/912 testes (853 unitários + 59 PostgreSQL), 95,27% lines, OpenAPI 70/65, migrations 001–012 e E2E 63/63. Detalhe nas seções 9 do [backlog até produção](build/PRODUCTION_BACKLOG.md) e na [revisão de 02/10](RELATORIO_REVISAO_ENTREGA_AGENTE_2026-10-02.md).

## Snapshot executável anterior — AUDIT-2026-10 (02/10/2026)

O working tree passou `npm test` com **768/768 testes em 91 arquivos**. O recálculo unitário registrou **92,79% lines, 94,23% functions e 86,12% branches**. A cobertura agregada PostgreSQL passou **809/809 testes em 98 arquivos**, com **94,98% lines, 95,30% functions e 89,09% branches**; `coverage:gate` passou com 29 exceções declaradas, sem arquivos `uncovered` ou `stale`. `npm run test:postgres` passou 41/41. `validate:migrations`, `validate:docs`, `validate:openapi` (70 operações/65 paths), `validate:traceability`, `security:scan`, typecheck, lint, build, E2E `63/63` sem retry e mutation `7/7` passaram. O candidato continua `CONDITIONAL PASS LOCAL / BLOCKED` para produção clínica.

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
| Ordem de construção atual | [Roadmap hospitalar](build/ROADMAP_HOSPITAL_PLANNER_2026-10-11.md) e [backlog HPL](build/BACKLOG_HOSPITAL_PLANNER_2026-10-11.md) (evolução de produto hospitalar); `build/PRODUCTION_ROADMAP.md` e `build/PRODUCTION_BACKLOG.md` (gates até produção); `build/IMPROVEMENT_ROADMAP_2026-10.md` e `build/IMPROVEMENT_BACKLOG_2026-10.md` (histórico de correções e melhorias com interseções reconciliadas no HPL). Os programas AAA-3 e anteriores são histórico; `build/BUILD_PLAN.md` permanece como decomposição original |
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
