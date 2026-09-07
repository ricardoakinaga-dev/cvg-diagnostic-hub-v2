# Programa executivo AAA-2 — CVG Diagnostics Hub

**Versão:** AAA-2 · **Data:** 05/09/2026 · **Estado:** HISTÓRICO / SUPERSEDIDO; produção NOT READY.

> **Aviso de reconciliação (07/09/2026):** este documento preserva o plano e
> os números observados no ciclo AAA-2. Termos como “revalidação corrente”
> referem-se somente ao snapshot de 05–06/09/2026 e não são evidência corrente
> do candidato AAA-3. Para o estado atual, use o [programa AAA-3](STATE_OF_ART_TRIPLE_AAA_EXECUTIVE_PLAN.md), seu manifesto e a auditoria de 07/09.

[Auditoria-base](../RELATORIO_AUDITORIA_2026-09-05.md) · [Roadmap](AAA_2_ROADMAP.md) · [Backlog](AAA_2_BACKLOG.md) · [Barra de aceite](AAA_2_QUALITY_BAR.md) · [Registro de decisões](AAA_2_DECISION_REGISTER.md) · [Verificação G5 local](../../.orchestrate/evidence/aaa2-g5-final-20260905.md).

## 1. Decisão executiva

Construir uma plataforma de diagnóstico veterinário confiável para uso hospitalar: contexto correto do paciente, execução clínica completa, resultados rastreáveis, comunicação tempestiva e recuperação demonstrada. “State of Art / Triplo AAA” designa o padrão de engenharia deste programa; não é certificação nem promessa de ausência absoluta de defeitos.

O investimento deve começar pela eliminação dos defeitos de autorização e integridade confirmados. Evolução de produto, banco e operação seguirá critérios objetivos de saída. A liberação hospitalar depende também de políticas, responsáveis, treinamento e aceite reais. Uma média alta não compensa falha crítica.

**FACT de baseline:** maturidade técnica 63/100; documentação 77/100. A auditoria-base encontrou build/typecheck reprovados e Vitest 321/324, com três falhas; browser 45/45 no ambiente sintético; PostgreSQL vivo, carga, restore e CI remoto não demonstrados. O snapshot JSONB permanece autoritativo. **Revalidação corrente (06/09/2026):** o working tree consolidado passa typecheck/build e **614/614 testes locais em 75 arquivos**; a cobertura G4 está em 92,01% statements/lines, **85,00% branches** e 94,36% functions no escopo executável ampliado. A API validada contém 65 operações em 60 paths. A corrida E2E atual passou 51/51 sem retry e seis cenários de acessibilidade passaram 6/6; o Patient Workspace tem contrato, projeção, testes de escopo, UI responsiva, refresh stale/degraded com preservação do snapshot, paginação de fila, navegação rotulada e contraste auditado, e recebeu crítica visual independente `APPROVED_LOCAL` no packet v6 de Bernoulli. A fatia relacional mantém a evidência PostgreSQL descartável anterior **9/9 focada e 30/30 completa**, incluindo `EXPLAIN` estrutural indexado, checkpoint/retomada, wake-up real LISTEN/NOTIFY entre dois pools e regressão de delivery de notificações; a nova integração de recoleta/rollback ainda não foi executada sem cluster descartável e não é contada nesses 30/30. O packet browser production-like registra **51/51** sem retry nos projetos Chromium, tablet e mobile com `next start`, PostgreSQL, S3/scan sintéticos e worker outbox; o [packet G4 amplo](../../.orchestrate/evidence/aaa3-g4-broad-coverage-20260906.md) registra denominador, exit code, hashes e limitações. As fatias locais AAA2-014/030, AAA2-022, AAA2-027/028/035 e AAA2-029 acrescentam identidade escopada, cursor de fila, comandos de contexto, política crítica, contratos de recuperação/performance/cutover e cálculo SLA limitado, sem fechar suas políticas externas. Browser durável em CI, restore, carga aprovada/representativa, decisões humanas ou release ainda não foram provados; os limites estão no [packet corrente do Patient Workspace](../../.orchestrate/evidence/v2-patient-workspace-current-20260906.md), no [packet visual v6](../../.orchestrate/evidence/visual-patient-workspace-20260906-v6/manifest.json), no [packet relacional](../../.orchestrate/evidence/v2-relational-sample-lineage-backfill-20260906.md), no [packet browser production-like](../../.orchestrate/evidence/aaa3-browser-postgres-production-s3-20260906.md) e no [packet G4 amplo](../../.orchestrate/evidence/aaa3-g4-broad-coverage-20260906.md).

**DECISION proposta pelo programa:** meta de pelo menos 95/100 em cada uma das 12 dimensões técnicas e nas 10 dimensões documentais da auditoria, com todos os 22 critérios AAA em PASS para o aceite final. Cada requisito obrigatório e seu aceite precisam estar verificados; notas são avaliação complementar. Não reduzir escopo ou alterar denominador para alcançar a meta.

Atualização de evidência em 06/09/2026: a linha do tempo densa agora tem
fixture determinístico colapsado/expandido e PNGs production-like. Permanecem
abertos o estado/viewport matrix completo, sign-off manual/target, CI remoto,
operação alvo e aceite humano.

## 2. Resultado contratado

| Frente | Resultado operacional esperado | Medida de sucesso |
| --- | --- | --- |
| Segurança e identidade | Cada pessoa vê e altera somente recursos autorizados, com contexto inequívoco | Matriz negativa pública integral, inclusive listas, contagens, anexos e SSE; nenhum defeito crítico/alto aberto |
| Núcleo clínico | Solicitação, Lab, RX, US, resultados, revisão, emenda e cancelamento coerentes | Todos os MUST/AC aprovados em serviço, HTTP e jornadas críticas servidas; nenhuma perda ou sobrescrita silenciosa |
| Dados | Fonte relacional ativa, concorrente e recuperável | Cutover reconciliado, constraints exercitadas, duas instâncias e restore completo aprovados |
| Comunicação | Fila e resultado atualizados; crítico chega ao responsável e escala no prazo | Delivery durável, reconexão/fallback comprovados e protocolo de acknowledgement separado de entrega |
| Produto e UX | Central e Patient Workspace orientam a próxima ação com segurança | Tarefas com usuários, teclado, touch e leitor de tela; estados degradados e contexto preservado |
| Operação | Serviço diagnosticável, previsível e restaurável | Carga representativa, SLO, alertas, plantão, rollback e exercícios documentados |
| Governança | Regras clínicas e liberação têm autoridades identificadas | Políticas versionadas, aceite do hospital e piloto controlado |

Escopo preservado: 29 FR (incluindo FR-REG-001 formalizado no PRD), 14 NFR e seus AC; as sete fatias V2 avaliadas; todos os achados A-01 a A-13. As integrações explicitamente futuras no PRD, como modalidade externa, não são adicionadas silenciosamente. Novas demandas passam por decisão de escopo e análise de impacto. Não há justificativa atual para reescrever o produto ou migrar a microserviços; consolidar o monólito modular e suas fronteiras é a direção proposta.

## 3. Organização e capacidade

Os donos abaixo são papéis propostos, sem atribuição fictícia a pessoas. Na abertura, o patrocinador nomeia uma pessoa responsável e um substituto por papel. Sem essa alocação, prazo e capacidade permanecem hipóteses.

| Papel | Responsabilidade e autoridade |
| --- | --- |
| Patrocinador / dono do produto | Aprovar escopo, capacidade, orçamento, prioridades e decisão final de liberação |
| Lead de engenharia | Integrar mudanças, manter arquitetura, sequenciar dependências e responder pelo artefato técnico |
| Engenharia de aplicação | Segurança, contratos, domínio, jornadas e interface |
| Engenharia de dados / plataforma | PostgreSQL, migração, outbox, identidade, storage e concorrência |
| QA / revisor independente | Aceites reproduzíveis, regressão, revisão adversarial e recomendação de aceite; não autoaprovar trabalho próprio |
| SRE / infraestrutura | Ambientes, CI, carga, telemetria, backup, restore, incidentes e rollback |
| UX / acessibilidade | Design system, experiência completa, pesquisa e validação manual |
| Responsável clínico e líderes Lab/RX/US | Autorizar regras clínicas, catálogo, críticos, plantão, revisão e homologação |
| Privacidade / segurança institucional | Identidade, retenção, acessos, incidentes, residência e uso de dados |

**ASSUMPTION de capacidade:** três engenheiros dedicados, QA dedicado, com SRE e UX parcialmente alocados e responsáveis hospitalares disponíveis semanalmente. Estimativas do backlog representam esforço técnico, não prazo contratual; validação hospitalar e aquisição de serviços têm lead time próprio. Nas primeiras duas semanas, medir capacidade líquida e recalibrar a previsão. Não comprometer uma data produtiva antes de comprovar banco e decisões clínicas essenciais.

## 4. Governança e controle

- Reunião curta diária para bloqueios de segurança, dados e dependências. Limitar trabalho em andamento a uma entrega principal por responsável.
- Demonstração semanal no artefato integrado, com falhas, evidências e decisões abertas visíveis; demonstração isolada não fecha marco.
- Comitê semanal de produto, clínica, engenharia e operação para decisões D-01 a D-06, riscos e escopo.
- Revisão de saída de cada gate por pessoa diferente do autor. Segurança e integridade podem vetar avanço; o patrocinador não converte falha técnica em PASS.
- Congelar candidato, ambiente, dataset, comandos e critérios antes do aceite. Mudança material invalida a evidência afetada e exige regressão proporcional.
- Acompanhar trabalho aceito e idade dos bloqueios; linhas de código, quantidade de testes e quantidade de tarefas concluídas não são indicadores de qualidade isolados.

## 5. Decisões abertas desde o primeiro dia

A tarefa AAA2-007 prepara opções, impacto, responsáveis e registro. O [registro de decisões AAA-2](AAA_2_DECISION_REGISTER.md) é a fonte operacional de D-01–D-06. Preparação técnica pode avançar com dados sintéticos e contratos de teste; publicação de política clínica ou uso hospitalar depende da autoridade indicada. Ausência de resposta não é aprovação.

| ID | Decisão necessária | Autoridade | Prazo relativo necessário | Entregável verificável |
| --- | --- | --- | --- | --- |
| D-01 | Identidade institucional, patient/owner, homônimos, referência externa, delegação, transferência e alta | Clínica + segurança + produto | Antes de concluir AAA2-014/021/022/036 | Matriz de identidade/ownership e acesso assinada; processo de revogação e contingência |
| D-02 | Emenda, disponibilidade de versão anterior, revisão, conclusão automática, falha de processamento e motivos de US | Clínica + Lab/RX/US | Antes de concluir AAA2-023/025/026 | Tabela de estados e casos clínicos aprovados, com versão e vigência |
| D-03 | Templates, unidades, faixas/populações, criticidade, plantão, fallback, acknowledgement e escalonamento | Clínica + líderes dos setores | Antes de concluir AAA2-024/027/028 | Políticas versionadas, aprovadores e responsabilidade fora do expediente |
| D-04 | SLA, início, pausas, calendário, prioridade, duplicidade, timezone e protocolo humano | Produto + operação clínica | Antes de concluir AAA2-029/030/034 | Exemplos de cálculo e exceções aprovados |
| D-05 | Retenção, residência, exportação/eliminação, IdP, scanner, storage, segredos, RPO/RTO e SLO | Privacidade + segurança + infraestrutura | Antes de concluir AAA2-036/038/039/041/044/045 | Política e configuração aprovadas, serviços e contas disponíveis |
| D-06 | Escopo do piloto, participantes, suporte, treinamento, critérios de interrupção e autoridade de rollback | Patrocinador + hospital + SRE | Antes de G5 | Plano de piloto e termo de aceite com responsáveis |

## 6. Investimento e previsão

Financiar inicialmente G0 e a prova técnica G1, mantendo a preparação clínica em paralelo. A decisão de expansão usa evidência de risco removido. O custo final será calculado por capacidade aprovada × duração recalibrada, acrescido de ambientes, identidade, armazenamento, scanner, observabilidade e suporte. Nenhum preço de fornecedor ou orçamento foi presumido.

A referência inicial do roadmap é **24–40 semanas**, com sobreposição controlada entre frentes. A soma do backlog é **261–436 dias-pessoa** de esforço técnico especializado: três entregas S, 28 M e 29 L. Como verificação conservadora de capacidade, três pessoas equivalentes a 80% de disponibilidade líquida entregam aproximadamente 12 dias-pessoa por semana: cerca de 22–37 semanas de esforço, antes de reservas de integração e decisões. QA, SRE, UX e clínica precisam da alocação descrita; suas horas não devem ser contadas duas vezes na previsão.

É uma hipótese de planejamento de confiança baixa, não uma promessa. A faixa de 24–40 semanas pressupõe decisões e serviços entregues nos pontos necessários; espera externa prolongada pode ultrapassá-la. Rever estimativas e capacidade em G0, usando throughput observado e fatias menores. Autorizar recursos não autoriza implantação produtiva.

| Frente | Esforço estimado em dias-pessoa |
| --- | ---: |
| G0 — contenção e baseline | 24–41 |
| G1 — dados e delivery | 54–90 |
| G2 — produto clínico | 75–125 |
| G3 — operação distribuída | 51–85 |
| G4 — qualidade integrada | 36–60 |
| G5 — aceite e release | 21–35 |
| **Total** | **261–436** |

## 7. Painel executivo

| Indicador | Baseline de 05/09 | Meta de aceite |
| --- | --- | --- |
| Maturidade técnica / documental | 63 / 77 | Cada dimensão ≥95, mesma metodologia e escopo |
| Falhas conhecidas bloqueantes | A-01/A-02 P0; demais achados abertos | Zero crítico/alto e nenhum MUST/AC obrigatório sem prova |
| Build / typecheck / suíte local | Baseline falha; execução corrente verde: 614/614, cobertura G4 92,01/85,00/94,36 no escopo executável ampliado; PostgreSQL 30/30 do packet anterior; browser production-like 51/51 nos projetos Chromium/tablet/mobile; visual v6 `APPROVED_LOCAL` | Todos os gates obrigatórios verdes no candidato, incluindo rastreabilidade |
| PostgreSQL e browser durável | Não demonstrados | Migrations, concorrência e jornadas no banco real aprovadas |
| Realtime / delivery | Shell/ResultView e fallback local implementados; multi-instância/delivery durável abertos | Duas instâncias, tela aberta, crash/replay e autorização aprovados |
| Recuperação | Não demonstrada | Restore clínico + anexos + chaves/configuração dentro de metas aprovadas |
| Rastreabilidade | Validador estrutural PASS: 43 requisitos e 43 ACs ligados a código, teste, comando e evidência; revisão semântica independente e aprovação externa ainda abertas | 100% dos MUST/AC ligados a prova atual e revisados semanticamente |
| Políticas / homologação | Pendentes | D-01 a D-06 resolvidas e piloto aceito |

## 8. Riscos e resposta

| Risco | Resposta e condição de interrupção | Responsável |
| --- | --- | --- |
| Exposição ou ação clínica indevida | Priorizar A-01/A-02; impedir release enquanto reproduzíveis; ampliar matriz de escopo/fase | Lead + segurança |
| Cutover perder dados ou manter lock global | Backfill reconciliado, modo de leitura explícito, teste concorrente e recuperação; interromper cutover com divergência | Dados |
| Decisão clínica tardia | Iniciar D-01–D-04 em G0; separar construção de mecanismo de publicação da política | Produto + clínica |
| Teste sintético criar falsa confiança | Manter evidências separadas por ambiente; exigir banco, serviços, revisão humana e piloto nos gates adequados | QA |
| Escopo AAA crescer sem limite | Congelar escopo PRD/V2 auditado; nova capacidade precisa de impacto e decisão explícitos | Patrocinador |
| Operação sem resposta a falhas | Nomear plantão, exercitar alerta/restore/rollback e barrar piloto sem cobertura | SRE |

## 9. Próximos dez dias úteis

Dias 1–2: atribuir responsáveis; preservar a baseline; iniciar AAA2-001/002/003/007/011 e reproduzir os bloqueios. Dias 3–5: integrar correções de autorização e build, gestor delegado e evento SSE; abrir banco descartável e decidir contratos clínicos prioritários. Dias 6–10: realizar a primeira revisão de G0, consolidar o inventário de rastreabilidade, executar migrations disponíveis e iniciar a investigação de backfill/outbox. O aceite completo de G0 tem janela de até quatro semanas no cenário de referência.

Esse recorte é objetivo de mobilização, sujeito à capacidade real. Se G0 não passar, manter rework explícito e replanejar; não declarar G1 ou produção aprovados por calendário. A execução parcial de G0 está registrada no backlog e no packet corrente; este documento não aprova decisões hospitalares nem libera produção.
