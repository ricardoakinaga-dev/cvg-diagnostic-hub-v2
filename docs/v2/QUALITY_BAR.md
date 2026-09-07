# CVG Diagnostic Hub V2 — quality bar congelado

## Objetivo da barra

Esta barra governa a primeira fatia vertical do V2. Ela não declara que todo o
programa clínico pedido no prompt mestre está concluído. O objetivo maior segue
no backlog até que Laboratory, Radiology, Ultrasound, Results, Notifications,
monorepo, migrações e jornadas clínicas tenham evidência própria.

Uma condição obrigatória que falha não pode ser compensada por uma pontuação
agregada. Toda condição deve apontar para um artefato, comando, teste ou decisão
humana verificável.

Após a onda operacional, a mesma barra é aplicada à fatia clínica de Laboratório
descrita em `docs/v2/LABORATORY_VERTICAL.md`. Os critérios abaixo são adicionais;
eles não reabrem nem apagam o histórico da onda 1.

## Critérios adicionais da fatia Laboratório estruturado

| ID | Critério | Evidência mínima |
| --- | --- | --- |
| V2-LAB-01 | Template de painel é versionado, escopado e não duplica definição na UI | contrato de domínio, fixture/catalog read e teste de escopo |
| V2-LAB-02 | Observações tipadas são validadas no servidor e incompletude não produz resultado normalizado | testes de tipo, unidade, obrigatório, duplicidade e painel stale |
| V2-LAB-03 | Faixa e flag são snapshot auditável; criticidade não é inferida | teste de normalização/release e fixture explicitamente `PENDING_HUMAN_POLICY` |
| V2-LAB-04 | Lifecycle existente preserva draft/release/amend/void/review, idempotência e concorrência | testes de aplicação/API e ausência de regressão |
| V2-LAB-05 | Editor/tabela de Laboratório usa template real e expõe política pendente sem aceitar flags do browser | componente, axe e jornada browser |
| V2-LAB-06 | OpenAPI, Zod, runtime e UI compartilham o shape estruturado | drift, AJV de respostas reais e request schema tests |
| V2-LAB-07 | Crítica independente identifica bypasses, limitações e não confunde fixture com aceite clínico | relatório read-only, correções/reteste e checkpoint |

## Critérios adicionais da fatia Patient Workspace

O contrato congelado e a matriz de escopo estão em
`docs/v2/PATIENT_WORKSPACE.md`. Estes critérios atravessam o read model
existente, sem abrir uma rota paralela:

| ID | Critério | Evidência mínima |
| --- | --- | --- |
| V2-PATIENT-01 | Paciente, encounter, admission, request, item e contexto operacional aparecem como um snapshot escopado | contrato, read model e teste de aplicação |
| V2-PATIENT-02 | Sample, resultado liberado e anexos limpos/finalizados são vinculados ao item sem vazar recursos ocultos | fixtures de lifecycle, testes allow/deny e invariantes de vínculo |
| V2-PATIENT-03 | Draft, resultado invalidado, storage key e tokens nunca aparecem na projeção | teste negativo de segurança e schema sem propriedades extras |
| V2-PATIENT-04 | A UI prioriza contexto atual, próximas ações e reconciliação temporal, com vazio/erro/parcial/stale | componente, copy e jornada browser |
| V2-PATIENT-05 | A jornada é acessível e responsiva em mobile, tablet e desktop sem duplicar árvore de conteúdo | axe, keyboard, screenshots e overflow assertions |
| V2-PATIENT-06 | Rota existente, envelope, OpenAPI e tipos compartilham o shape `workspace` | drift validator, AJV/runtime response e teste de rota |
| V2-PATIENT-07 | Crítica independente separa qualidade local de aceite hospitalar | relatório fresco, correções/reteste ou `NOT_RUN` documentado |

## Critérios da fatia relacional de sample/accession

O contrato técnico congelado está em `docs/v2/RELATIONAL_SAMPLE_LINEAGE.md`.
Esta fatia permanece shadow-only e não altera a autoridade do snapshot.

| ID | Critério | Evidência mínima |
| --- | --- | --- |
| V2-REL-SAMPLE-01 | Recoleta preserva a cadeia `RECEIVED → REPLACED` e `EXPECTED → RECEIVED` sem reutilizar accession | teste de application com versões e lineage completa |
| V2-REL-SAMPLE-02 | Accession direto e item IDs são validados contra duplicidade, formato e normalização | testes RED/GREEN de service e schemas |
| V2-REL-SAMPLE-03 | Adapter, read boundary e reconciliação rejeitam links órfãos, cross-request, ciclos e metadata divergente | testes estáticos/mocked de leitura, projeção e cutover |
| V2-REL-SAMPLE-04 | A projeção relacional é versionada/otimista e mantém links históricos sem habilitar cutover | SQL, testes de conflito, migrations e limitation evidence |

## Critérios obrigatórios da onda 1

| ID | Critério | Evidência mínima |
| --- | --- | --- |
| V2-FOUND-01 | Atual e alvo estão separados em mapa de migração; V1 é preservado | `docs/v2/MIGRATION_MAP.md`, `v1` remote/histórico e diff limpo antes da onda |
| V2-FOUND-02 | A primeira fronteira de package tem código consumido pelo runtime | package compilado, import real e teste; nenhum package placeholder |
| V2-OPS-01 | Cada item da fila expõe `currentOwner`, `nextAction`, `blockedBy`, `waitingSince`, `expectedBy` e `escalationLevel` vindos do servidor | contrato tipado, regra de domínio, resposta de API e testes positivos/negativos |
| V2-OPS-02 | O Command Center prioriza atenção e mostra estado por setor a partir de leitura real | endpoint/read model, loading/error/empty/degraded states, teste de ordenação e browser journey |
| V2-UX-01 | A Central de Exames mantém lista densa, filtros e detalhe contextual sem abandonar a fila | filtro aplicável, drawer acessível, deep link e teste de teclado/responsividade |
| V2-UX-02 | Ações clínicas continuam comandos explícitos e autorizados no servidor | nenhum `updateStatus` genérico; regressão de autorização e expected-version/idempotência quando aplicável |
| V2-SEC-01 | Leitura do Command Center e da fila respeita sessão, departamento e papel no backend | casos allow/deny e ausência de vazamento cross-sector |
| V2-CONTRACT-01 | Contrato publicado, runtime e tipos compartilham o mesmo shape | validator/OpenAPI ou teste de drift, incluindo erro e envelope |
| V2-TEST-01 | A regra operacional e os estados principais têm RED/GREEN e regressão | unitários de domínio, aplicação/API, componente e pelo menos uma jornada E2E |
| V2-REG-01 | A base não regrediu | `typecheck`, `lint`, `build`, suite unitária e `git diff --check` |
| V2-CRITIC-01 | Uma crítica fresca e read-only examina o slice contra esta barra e o prompt mestre | relatório independente com achados, correções e reteste |

## Barra visual e operacional

- Atenção vem antes de métricas decorativas.
- Cor nunca é o único sinal de crítico, atraso ou bloqueio.
- Loading, erro, vazio, stale/degraded e permissão negada são estados de produto.
- O drawer é triagem contextual; resultado, revisão, acknowledgement e contexto
  clínico completo continuam podendo abrir o Patient Workspace.
- A fila, o drawer e o Command Center são projeções da mesma fonte de verdade;
  nenhum deles mantém um status clínico paralelo no browser.
- Labels devem ser em português claro, com identificador técnico disponível para
  suporte/auditoria quando necessário.

## Fora da barra local e ainda obrigatório no programa V2

Estes itens não serão simulados para fechar a onda 1:

- aprovação hospitalar de identidade, ownership, transferência, alta e escopo;
- thresholds, destinatários, fallback e escalonamento de resultado crítico;
- dados reais, produção, secrets, TLS, storage/antimalware, retenção e RPO/RTO;
- migração relacional clínica completa, backfill amplo/contínuo, dual-write,
  cutover e carga representativa; o backfill shadow local request-scoped é
  evidência limitada e não fecha estes gates;
- módulos profundos de Laboratório, Radiologia, Ultrassom, Resultados e
  Notificações, quando ainda não tiverem sua jornada completa;
- aceite clínico/manual, CI remoto, piloto e aprovação de release.

## Regra de veredito

O resultado da onda só poderá ser `PASS_WITH_CONDITIONS` se todos os critérios
obrigatórios locais passarem e as limitações externas estiverem explicitamente
listadas. `PASS` sem condições não é permitido para uso hospitalar neste
repositório.
