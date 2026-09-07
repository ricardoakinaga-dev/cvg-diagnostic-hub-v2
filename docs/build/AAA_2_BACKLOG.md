# Backlog executável AAA-2

**Data:** 05/09/2026 · **Estado:** HISTÓRICO / SUPERSEDIDO; nenhum gate AAA-2 ou tarefa marcada DONE.

> **Aviso de reconciliação (07/09/2026):** este backlog preserva o histórico
> executável do AAA-2. Status, contagens e “prova local atual” referem-se à
> fotografia de 05–06/09/2026; não devem ser usados para pontuar o candidato
> AAA-3. O backlog normativo atual está em
> [STATE_OF_ART_TRIPLE_AAA_BACKLOG.md](STATE_OF_ART_TRIPLE_AAA_BACKLOG.md).

[Plano](AAA_2_EXECUTIVE_PLAN.md) · [Roadmap](AAA_2_ROADMAP.md) · [Barra](AAA_2_QUALITY_BAR.md) · [Auditoria-base](../RELATORIO_AUDITORIA_2026-09-05.md) · [Verificação G5 local](../../.orchestrate/evidence/aaa2-g5-final-20260905.md).

## Como executar

São 60 entregas de controle. IDs AAA2 são novos; IDs AAA-W da rodada anterior são preservados no histórico. Referências numéricas em dependências, como 001, significam AAA2-001. D-01–D-06 são decisões do plano executivo; sua indicação exige aprovação real antes do aceite da tarefa, embora preparação e testes sintéticos possam começar antes.

P0: corrigir ou conter imediatamente falha confirmada que impede baseline segura. P1: obrigatório para completar este programa. Prioridade não equivale a ordem de execução nem à severidade de todos os riscos internos. Dependência externa não reduz prioridade. Não há itens opcionais disfarçados de obrigatórios; novas melhorias entram por mudança de escopo.

**Esforço preliminar por entrega:** S = 1–2 dias-pessoa de trabalho técnico especializado; M = 3–5; L = 6–10. Inclui implementação, teste e revisão técnica, exclui espera por aprovação/serviço externo. Soma inicial: 261–436 dias-pessoa, distribuídos em três S, 28 M e 29 L. Incerteza alta: dimensionar novamente após G0. L deve ser dividido em fatias verificáveis antes de começar; dependências são de aceite completo, não impedem descoberta ou preparação independente.

**READY** significa apto para iniciar com as informações locais; requer dono humano atribuído na mobilização. **PLANNED** aguarda dependências. **IN PROGRESS** tem executor e escopo em curso. **BLOCKED** registra insumo, responsável e data de revisão. **IMPLEMENTED** tem mudança e prova local; **VERIFIED** exige revisão independente; **DONE** exige integração no candidato com todos os aceites da tarefa. Calendário ou código existente não fecha tarefa.

**Definition of Ready:** contrato e escopo delimitados, dependências atendidas para a fatia, ambiente seguro, cenários positivos/negativos definidos, dono e revisor identificados. **Definition of Done comum:** aceite específico demonstrado, regressões proporcionais, documentação/contrato/matriz atualizados, falhas tratadas, telemetria necessária e risco de rollback descritos; evidência sanitizada ligada ao artefato integrado. Mudanças clínicas sensíveis exigem decisão assinada, não interpretação do executor.

Os aceites abaixo são trabalho a produzir; não são relatos de testes já executados. Comandos existentes e provas adicionais estão na barra. Não executar comandos de banco contra ambientes reais para cumprir este planejamento.

## Estado corrente da execução G0 (05/09/2026)

| Entrega | Estado | Evidência corrente e limite |
| --- | --- | --- |
| AAA2-001 | IMPLEMENTED | Escopo por item/paciente/serviço aplicado em leituras públicas; `src/server/http/scoped-reads-route.test.ts` cobre filas, busca, timeline, dashboard e diagnósticos. |
| AAA2-002 | IMPLEMENTED | Política de cancelamento por fase, motivo, versão, escopo, concorrência e rollback coberta por 94 casos em `src/server/http/cancellation-policy.test.ts`. |
| AAA2-003 | IMPLEMENTED | Typecheck/build, capacidade 429, adaptador indisponível, grafo arquitetural e fronteira de observabilidade passam no working tree atual; a primeira crítica independente foi rejeitada por erros de typecheck já corrigidos, então a verificação final ainda está aberta. |
| AAA2-004 | IMPLEMENTED | Delegação de gestor unificada em detalhe, leituras e mutações; revogação coberta em `scoped-reads-route.test.ts`. |
| AAA2-005 | IMPLEMENTED / CONDITIONAL | Shell emite invalidação e uma cadência de reconciliação de 30 s; `ResultView` reconcilia SSE/resync, preserva a versão-base do draft, mantém texto digitado, bloqueia conflito remoto e ignora resposta antiga quando uma carga mais nova já foi aplicada. O runtime possui adapter process-local por default e adapter opt-in PostgreSQL `LISTEN/NOTIFY` com payload sem dados clínicos, reconexão limitada e polling durável como fallback; a publicação HTTP ocorre após mutações 2xx. O crítico G2 final registrou 44/45 por falso conflito pós-save em tablet; os críticos G3 e G4 confirmaram a correção, com G4 em 11/11 focados e E2E 45/45. O teste local de sequencing agora existe; conexão/two-instance em PostgreSQL autorizado, fallback em browser servido, cancelamento de cargas e fanout multi-instância ainda precisam de prova específica; o programa permanece REJECT para os limites de persistência e operação. |
| AAA2-006 | VERIFIED | Contrato `FileStore` extraído sem ciclo estático; fitness e storage tests passam; revisão independente registrada no packet de AAA2-003/006. |
| AAA2-007 | BLOCKED | Registro D-01–D-06 existe, mas decisores humanos e substitutos ainda não foram nomeados; não houve aprovação inferida. |
| AAA2-008 | IMPLEMENTED | Documentos de controle agora distinguem baseline de 05/09 da execução corrente; evidência em `.orchestrate/evidence/aaa2-g0-current-20260905.txt`. |
| AAA2-009 | IN PROGRESS | Validador forte e quatro testes existem; a matriz agora tem colunas `code`, `test`, `command` e `evidence`, e `npm run validate:traceability` passa o inventário estrutural de 43 requisitos/ACs. As fatias locais de SLA, relatório de percentis, guards de backup/restore, política crítica e cutover relacional estão registradas em packets separados, mas não substituem provas externas. AAA2-022, AAA2-027/028/035 e AAA2-029 continuam policy-gated; G4 ainda exige aceite durável, decisões e revisão independente. |
| AAA2-010 | IN PROGRESS | Node 22 fixado em CI/`.nvmrc`, engines e lockfile alinhados; typecheck, lint, coverage, build, docs, OpenAPI, scan, audit e os gates explícitos de migrations/perf/recovery/traceability passam no working tree. O working tree consolidado tem **614/614 testes em 75 arquivos**, 92,01% statements, 85,00% branches e 94,36% functions no escopo G4 executável ampliado; OpenAPI valida 65 operações em 60 paths e a matriz liga 43 requisitos/ACs a código, teste, comando e evidência. A execução E2E corrente passou 51/51 sem retry, incluindo seis cenários de acessibilidade, e inclui a jornada responsiva, paginação da fila, navegação rotulada e a preservação do snapshot confirmado no refresh indisponível do Patient Workspace; a projeção/delivery de notificações tem regressão unitária e PostgreSQL live no packet anterior; o packet visual v6 está `APPROVED_LOCAL` após crítica independente fresca de Bernoulli e cobre estados/viewport e timeline densa, sem sign-off manual/target; a nova integração PostgreSQL de recoleta/rollback está presente, mas não foi executada sem cluster descartável e não é contada nos 30/30 anteriores. O packet G4 amplo registra o denominador, exit code e hashes; CI remoto e aceite durável continuam abertos. |
| AAA2-011 | IMPLEMENTED LOCAL / CI LANE IMPLEMENTED | CI/compose fixam PostgreSQL 16 e opt-in. O packet V2 [`v2-relational-sample-lineage-backfill-20260906.md`](../../.orchestrate/evidence/v2-relational-sample-lineage-backfill-20260906.md) registra a execução em cluster 16.15 descartável e `npm run test:postgres` atualizado para 30/30, incluindo migration 010, lineage/realtime e a regressão de projeção/delivery de notificações; o lane `browser-postgres` está implementado com banco por `github.run_id`, serviços S3/scanner sintéticos, worker outbox e 51 cenários nos projetos Chromium/tablet/mobile sem retry, mas ainda aguarda execução remota e repetição em ambiente alvo. |
| AAA2-012 | IN PROGRESS (local + PostgreSQL disposable) | Manifesto/checksums, bootstrap e upgrades 001–007/008/009 validados localmente por 39 testes e `npm run validate:migrations`; o packet V2 [PostgreSQL local](../../.orchestrate/evidence/v2-relational-sample-lineage-postgres-20260906.md) prova migration 009 aplicada/validada, readiness, projection/read/reconciliation, constraints negativas e `EXPLAIN` estrutural indexado em PostgreSQL 16.15 descartável. Upgrade de baseline populada, rollback/roll-forward, workload aprovado/representativo e revisão operacional de `EXPLAIN` permanecem abertos. |
| AAA2-013 | IN PROGRESS (local slice) | Runner de backfill ordenado, retomável e reconciliável por hash cobre pais de notificações e deliveries; evidência em [aaa2-013-local-20260905.txt](../../.orchestrate/evidence/aaa2-013-local-20260905.txt). Adaptador PostgreSQL/corpus institucional ainda não existe. |
| AAA2-014 | IMPLEMENTED LOCAL / DATA INTEGRATION PENDING | Identidade escopada versionada, proveniência, comparação exata e resolução ambígua têm 11 testes em [`patient-identity.test.ts`](../../src/server/domain/patient-identity.test.ts); schema/backfill e D-01 continuam abertos. |
| AAA2-016 | IMPLEMENTED LOCAL / RELATIONAL CUTOVER PENDING | PostgreSQL 16.15 descartável passou 10 testes de integração de duas instâncias, incluindo leitura cruzada, revogação, concorrência transacional, lineage único, auditoria/outbox e rate limit; cutover clínico e browser continuam abertos. |
| AAA2-017–019 | IN PROGRESS (local slice) | Envelope/roteamento, sink durável, worker independente, leases/tokens, dedupe, poison e backoff têm implementação e testes locais; packet [local](../../.orchestrate/evidence/aaa2-017-019-037-041-local-20260905.txt). Sem PostgreSQL/duas instâncias, não são DONE. |
| AAA2-037/041 | IN PROGRESS (local slice) | Rate limit PostgreSQL fail-closed, readiness, métricas SSE e labels limitadas têm testes locais no mesmo [packet](../../.orchestrate/evidence/aaa2-017-019-037-041-local-20260905.txt); compartilhamento entre instâncias, alertas e SLO aprovado permanecem sem prova. |
| AAA2-022 | IMPLEMENTED LOCAL / POLICY-GATED | Endpoint de contexto suporta transferência, leito, alta e troca de responsável com idempotência, If-Match/versão, escopo, auditoria, outbox e vigência; testes focados e OpenAPI estão no [packet](../../.orchestrate/evidence/aaa2-022-local-20260905.md). D-01, UI, política de notificação/delegação, PostgreSQL e aceite clínico permanecem abertos. |
| AAA2-029 | IMPLEMENTED LOCAL / POLICY-GATED | Cálculo de due-at versionado e compatível está em [sla-policy.ts](../../src/server/application/sla-policy.ts), com 14 testes no [packet](../../.orchestrate/evidence/aaa2-sla-policy-local-20260905.txt). A fatia atual cobre início na solicitação e calendário contínuo; pausa/retomada, persistência/admin, histórico, job durável e D-04 continuam abertos. |
| AAA2-030 | IMPLEMENTED LOCAL / RELATIONAL PENDING | `listQueuePage` expõe cursor validado, desempate prioridade/prazo/ID e metadados de página; 53 testes de leitura/API e OpenAPI passam. Consulta relacional, corpus multi-departamento e carga aprovada permanecem abertos. |
| AAA2-031/032/033 | IMPLEMENTED LOCAL / CONDITIONAL | Busca, timeline e dashboard têm escopo antes da paginação, ranking/cursor, proveniência temporal, denominadores, frescor e drill-down nos testes de leitura/API; packet [local](../../.orchestrate/evidence/aaa2-031-033-local-20260905.md). A consulta relacional da busca, corpus, `EXPLAIN` aprovado, revisão de produto e acceptance durável permanecem abertos. |
| AAA2-044 | IMPLEMENTED LOCAL / POLICY-GATED | [data-governance-policy.ts](../../src/server/operations/data-governance-policy.ts) e testes criam um guard fail-closed para residência, classes de retenção, exportação escopo-limitada, eliminação aprovada e auditoria imutável. D-05/OQ-013 e aprovação institucional continuam necessários; nenhuma política ou prazo foi inventado. Evidência conjunta em [aaa2-recovery-local-20260905.md](../../.orchestrate/evidence/aaa2-recovery-local-20260905.md). |
| AAA2-045 | IMPLEMENTED LOCAL / ENVIRONMENT-BLOCKED | Manifesto versionado, metadata de objetos/config refs, SHA-256, verificação de artefato exato, plano dry-run e guards de restore estão em [recovery-manifest.ts](../../src/server/operations/recovery-manifest.ts); scripts de backup/restore/smoke exigem opt-in e alvo isolado, e o smoke aceita `POSTGRES_DIRECT_URL` além de Docker. O restore PostgreSQL local passou `1|1|0` no packet [aaa2-postgres-local-20260905.md](../../.orchestrate/evidence/aaa2-postgres-local-20260905.md). O manifesto marca object storage `NOT_CAPTURED`; bucket, chaves, app restore e RPO/RTO continuam sem prova. |

As demais entregas continuam PLANNED até que suas dependências e evidências específicas existam. IMPLEMENTED/VERIFIED acima não equivale a DONE: o gate G0 ainda está aberto por prova browser contra PostgreSQL em ambiente alvo, autoridade relacional, realtime multi-instância e decisões humanas; o validador estrutural de rastreabilidade passa, mas não substitui esses aceites.

## G0 — contenção e baseline

### AAA2-001 — Fechar escopo de paciente e serviço em filas; revisar busca, contagem, timeline, dashboard, anexos, exportações existentes e SSE

**Prioridade:** P0 · **Dono:** Aplicação / Segurança · **Esforço:** M · **Estado:** IMPLEMENTED · **Gate:** G0.

**Dependências:** —. **Origem:** A-01; FR-AUTH-001, FR-OPS-001, NFR-SEC-002.

**Entrega:** Fechar escopo de paciente e serviço em filas; revisar busca, contagem, timeline, dashboard, anexos, exportações existentes e SSE. Centralizar política em read-service e fronteiras públicas.

**Aceite e prova:** HTTP negativo reproduz fila LAB com dois pacientes e serviços, inclusive paginação/contagens; nenhum dado fora do escopo. Autorização ocorre antes de filtrar, ordenar ou paginar. Matriz cobre roles, delegação, revogação e negação por padrão.
### AAA2-002 — Aplicar permissão de cancelamento por fase em workflow-service e cancelamento de solicitação com múltiplos itens

**Prioridade:** P0 · **Dono:** Aplicação / Clínica · **Esforço:** M · **Estado:** IMPLEMENTED · **Gate:** G0.

**Dependências:** —. **Origem:** A-02; FR-CORE-006.

**Entrega:** Aplicar permissão de cancelamento por fase em workflow-service e cancelamento de solicitação com múltiplos itens.

**Aceite e prova:** Usuário sem elevação não cancela IN_PROGRESS; autorizado só atua com motivo, versão e escopo. HTTP testa cada fase, cancelRequest, mistura de itens e concorrência; falha não produz cancelamento parcial implícito nem altera histórico.
### AAA2-003 — Resolver ApiError ausente em realtime-stream sem introduzir dependência proibida de observability para HTTP; manter erros de domínio/transporte nas fronteiras adequadas

**Prioridade:** P0 · **Dono:** Lead / Aplicação · **Esforço:** S · **Estado:** IMPLEMENTED · **Gate:** G0.

**Dependências:** —. **Origem:** A-03; NFR-API-001, NFR-MAINT-001.

**Entrega:** Resolver ApiError ausente em realtime-stream sem introduzir dependência proibida de observability para HTTP; manter erros de domínio/transporte nas fronteiras adequadas.

**Aceite e prova:** Typecheck, build e testes de rota passam; excesso de streams retorna 429 e adaptador indisponível retorna código REALTIME_ADAPTER_UNAVAILABLE conforme contrato. Fitness arquitetural aprova a solução.
### AAA2-004 — Unificar política de gestor delegado em request-service.getItem e demais leituras/mutações

**Prioridade:** P1 · **Dono:** Aplicação / Segurança · **Esforço:** S · **Estado:** IMPLEMENTED · **Gate:** G0.

**Dependências:** 001. **Origem:** A-07; FR-AUTH-001.

**Entrega:** Unificar política de gestor delegado em request-service.getItem e demais leituras/mutações.

**Aceite e prova:** Gestor abre item de departamento administrado; não abre setor não delegado; revogação corta acesso. Fila, detalhe, resultado e ação usam a mesma matriz em testes HTTP.
### AAA2-005 — Conectar diagnostic.updated no shell, atualizar ResultView e adicionar fallback limitado com estado de frescor

**Prioridade:** P1 · **Dono:** Frontend / Plataforma · **Esforço:** M · **Estado:** IMPLEMENTED · **Gate:** G0.

**Dependências:** 003. **Origem:** A-04; FR-NOTIF-002, NFR-REL-002.

**Entrega:** Conectar diagnostic.updated no shell, atualizar ResultView e adicionar fallback limitado com estado de frescor.

**Aceite e prova:** Dois usuários em browser servido: alteração remota atualiza fila e resultado sem reload; queda de SSE ativa polling limitado e recupera. Draft local não é sobrescrito; conflito pede resolução e não duplica comando.
### AAA2-006 — Extrair contrato FileStore ou resolver o ciclo estático coerentemente com a arquitetura

**Prioridade:** P1 · **Dono:** Lead · **Esforço:** S · **Estado:** VERIFIED · **Gate:** G0.

**Dependências:** —. **Origem:** A-09; NFR-MAINT-001.

**Entrega:** Extrair contrato FileStore ou resolver o ciclo estático coerentemente com a arquitetura.

**Aceite e prova:** Grafo de imports configurado passa, incluindo imports de tipo; testes de storage passam. Critério não é relaxado para esconder o ciclo e não se afirma ciclo JavaScript sem evidência.
### AAA2-007 — Abrir registro D-01 a D-06 com alternativas, impactos, decisor e prazo

**Prioridade:** P1 · **Dono:** Produto / Clínica / SRE · **Esforço:** M · **Estado:** BLOCKED · **Gate:** G0.

**Dependências:** —. **Origem:** A-08/A-11/A-13; AAA-21/22.

**Entrega:** Abrir registro D-01 a D-06 com alternativas, impactos, decisor e prazo. Nomear donos do programa e substitutos.

**Aceite e prova:** Registro revisável contém responsável humano nomeado para cada decisão, próximos passos e bloqueios. Encaminhamento não equivale a aprovação; aceites hospitalares são anexados nas tarefas dependentes.
### AAA2-008 — Reconciliar índice, status, plano de testes, readiness e histórico; registrar Node, working tree e hashes do artefato auditado

**Prioridade:** P1 · **Dono:** QA / Docs · **Esforço:** M · **Estado:** IMPLEMENTED · **Gate:** G0.

**Dependências:** —. **Origem:** A-12; AAA-20.

**Entrega:** Reconciliar índice, status, plano de testes, readiness e histórico; registrar Node, working tree e hashes do artefato auditado.

**Aceite e prova:** Nenhum documento de controle usa 299/49 ou cobertura histórica como evidência corrente. Baselines e limites de memória/browser/PG ficam separados; logs sanitizados têm armazenamento durável, hash e política de retenção.
### AAA2-009 — Adicionar code/test/command/evidence à matriz; resolver FR-REG-001 sem origem no PRD e integrar o validador forte ao fluxo de validação

**Prioridade:** P1 · **Dono:** QA / Docs · **Esforço:** M · **Estado:** IN PROGRESS · **Gate:** G0.

**Dependências:** 008. **Origem:** A-12; todos os FR/NFR/AC; AAA-20.

**Entrega:** Adicionar code/test/command/evidence à matriz; resolver FR-REG-001 sem origem no PRD e integrar o validador forte ao fluxo de validação.

**Aceite e prova:** Testes do validador passam e sua execução sobre a matriz produz inventário rastreável. Cada MUST/AC tem fonte e tarefa; vínculos existentes são verificados e ausências ficam explicitamente abertas. Completude do validador forte é obrigatória em G4; não inventar código/teste/evidência para fechar G0.
### AAA2-010 — Fixar baseline Node comum a local/CI; validar instalação limpa e integrar G0 com regressões

**Prioridade:** P0 · **Dono:** QA / DevEx · **Esforço:** M · **Estado:** IN PROGRESS · **Gate:** G0.

**Dependências:** 001,002,003,004,005,006,007,008,009. **Origem:** A-01–A-04/A-07/A-09/A-12; AAA-18/20.

**Entrega:** Fixar baseline Node comum a local/CI; validar instalação limpa e integrar G0 com regressões.

**Aceite e prova:** Em checkout isolado: npm ci, typecheck, lint, coverage, build, docs, OpenAPI, scan e E2E de G0 passam; traceability executada registra gaps vinculados a entregas posteriores. Guardar primeira execução, ambiente e hashes. Nenhum teste crítico ignorado para obter verde.

## G1 — dados e delivery duráveis

### AAA2-011 — Provisionar PostgreSQL descartável local ou CI com versão fixada, isolamento e opt-in explícito

**Prioridade:** P1 · **Dono:** Dados / DevEx · **Esforço:** M · **Estado:** BLOCKED · **Gate:** G1.

**Dependências:** —. **Origem:** A-05; NFR-REL-001.

**Entrega:** Provisionar PostgreSQL descartável local ou CI com versão fixada, isolamento e opt-in explícito.

**Aceite e prova:** test:postgres executa os dez casos de integração existentes, além do harness, contra banco real; evidência identifica versão e isolamento. Configuração não aponta para produção; indisponibilidade é BLOCKED, não teste aprovado.
### AAA2-012 — Validar migrations 001–007, checksums, bootstrap e upgrade de baseline populada; revisar FKs/checks/índices

**Prioridade:** P1 · **Dono:** Dados · **Esforço:** L · **Estado:** IN PROGRESS (local slice) · **Gate:** G1.

**Dependências:** 011. **Origem:** A-05; AAA-08/09.

**Entrega:** Validar migrations 001–007, checksums, bootstrap e upgrade de baseline populada; revisar FKs/checks/índices.

**Aceite e prova:** Banco vazio e banco antigo chegam ao schema alvo; alteração de checksum é detectada; constraints rejeitam dados inválidos; versão compatível, falha intermediária e roll-forward/rollback seguro são exercitados.

**Prova local atual:** a [evidência de 05/09](../../.orchestrate/evidence/aaa2-012-local-20260905.txt) registra `npm run validate:migrations`, `npx vitest run src/server/store/migrations.test.ts` (39 casos) e `npm run typecheck`; o packet V2 [`v2-relational-sample-lineage-postgres-20260906.md`](../../.orchestrate/evidence/v2-relational-sample-lineage-postgres-20260906.md) adiciona bootstrap real em PostgreSQL 16.15, migrations 001–009, readiness, projection/read/reconciliation, constraints negativas e `EXPLAIN` estrutural indexado sob fan-out de distração. A prova ainda não demonstra upgrade de baseline populada, falha SQL intermediária, rollback/roll-forward seguro, workload aprovado/representativo ou revisão operacional de `EXPLAIN`.
### AAA2-013 — Construir backfill retomável e ordenado por dependências, incluindo pais de notificações, com reconciliação por entidade

**Prioridade:** P1 · **Dono:** Dados · **Esforço:** L · **Estado:** IN PROGRESS (local slice) · **Gate:** G1.

**Dependências:** 012. **Origem:** A-05; FR-DATA-001.

**Entrega:** Construir backfill retomável e ordenado por dependências, incluindo pais de notificações, com reconciliação por entidade.

**Aceite e prova:** Interrupção/retomada não duplica nem perde vínculos; contagens, checksums e amostras semânticas conferem; órfãos e divergências bloqueiam avanço; relatório mostra progresso e versão de transformação.

**Prova local atual:** [evidência de 05/09](../../.orchestrate/evidence/aaa2-013-local-20260905.txt) cobre o contrato de ordenação, checkpoint, hash e dependências em memória. O adaptador de produção e a reconciliação PostgreSQL continuam pendentes.
### AAA2-014 — Normalizar patient/owner, referências externas, encounter/admission e contexto institucional preservando origem

**Prioridade:** P1 · **Dono:** Dados / Produto · **Esforço:** L · **Estado:** IMPLEMENTED LOCAL / DATA INTEGRATION PENDING · **Gate:** G1.

**Dependências:** 012,007; D-01. **Origem:** A-05; FR-DATA-001, FR-AUD-001.

**Entrega:** Normalizar patient/owner, referências externas, encounter/admission e contexto institucional preservando origem.

**Aceite e prova:** Modelo e política aprovados, origem/proveniência preservada no upgrade, integridade referencial e ausência de mistura entre paciente/tutor/atendimento provadas em SQL e API. Dados históricos permanecem acessíveis sob escopo.

**Prova local atual:** [`patient-identity.ts`](../../src/server/domain/patient-identity.ts) e seus [11 testes](../../src/server/domain/patient-identity.test.ts) implementam chave escopada versionada, proveniência obrigatória para candidatos persistíveis, comparação exata e resolução `MATCH`/`NO_MATCH`/`AMBIGUOUS`/`INVALID`. O [packet local](../../.orchestrate/evidence/aaa2-014-030-local-20260905.md) registra os limites; schema/backfill e D-01 permanecem abertos.
### AAA2-015 — Ativar repositórios relacionais no runtime por agregado, com escrita atômica, leitura comparada e cutover explícito

**Prioridade:** P1 · **Dono:** Dados / Lead · **Esforço:** L · **Estado:** PLANNED · **Gate:** G1.

**Dependências:** 013,014. **Origem:** A-05; AAA-08/09/17.

**Entrega:** Ativar repositórios relacionais no runtime por agregado, com escrita atômica, leitura comparada e cutover explícito.

**Aceite e prova:** Fluxos clínicos leem/escrevem tabelas como fonte autoritativa; runtime não depende de cvg_runtime_state id=1 para estado clínico. Reconciliação zero no corpus, telemetria de modo ativo e plano para remover transição; flag isolada não é aceite.
### AAA2-016 — Provar concorrência, expectedVersion, idempotência e atomicidade dado/auditoria/outbox entre duas instâncias

**Prioridade:** P1 · **Dono:** Dados / QA · **Esforço:** L · **Estado:** IMPLEMENTED LOCAL / RELATIONAL CUTOVER PENDING · **Gate:** G1.

**Dependências:** 015. **Origem:** A-05; NFR-REL-001, NFR-API-001, FR-AUD-001.

**Entrega:** Provar concorrência, expectedVersion, idempotência e atomicidade dado/auditoria/outbox entre duas instâncias.

**Aceite e prova:** Corridas em release/cancelamento/recoleta não geram overwrite ou duplicação; rollback deixa todas as tabelas consistentes; deadlock/retry limitado não repete efeito; inspeção SQL confirma ausência do lock global de escrita clínica.

**Prova local registrada:** `npm run test:postgres` passou 30/30 no packet V2 de backfill [`v2-relational-sample-lineage-backfill-20260906.md`](../../.orchestrate/evidence/v2-relational-sample-lineage-backfill-20260906.md), em cluster 16.15 descartável; a suíte cobre migration 010, backfill/replay, lineage/realtime, constraints, `EXPLAIN`, wake-up LISTEN/NOTIFY entre dois pools, projeção da notificação e entrega durável, além do harness. Os casos duráveis existentes continuam cobrindo duas instâncias, concorrência, role/revocation, lineage, rollback de projeção relacional, auditoria/outbox e rate limit distribuído. Isso prova a integração local da seam, não a autoridade relacional final nem o browser/fanout/cutover de AAA2-015/020.
### AAA2-017 — Definir envelope e roteamento de outbox por consumidor; separar evento de domínio de intenção de notificação

**Prioridade:** P1 · **Dono:** Plataforma / Dados · **Esforço:** L · **Estado:** IN PROGRESS (local slice) · **Gate:** G1.

**Dependências:** 012. **Origem:** A-06; FR-NOTIF-001, NFR-REL-001.

**Entrega:** Definir envelope e roteamento de outbox por consumidor; separar evento de domínio de intenção de notificação.

**Aceite e prova:** DiagnosticRequestCreated e SampleReceived não entram indevidamente em sink que exige notificationId; tipos suportados têm destino; desconhecidos ficam diagnosticáveis, sem descarte silencioso. Schema e testes cobrem eventos e FKs.
### AAA2-018 — Integrar criação de notifications e deliveries, sink durável e worker independente com encerramento do pool

**Prioridade:** P1 · **Dono:** Plataforma / Dados · **Esforço:** L · **Estado:** IN PROGRESS (local slice) · **Gate:** G1.

**Dependências:** 015,017. **Origem:** A-06; AAA-11.

**Entrega:** Integrar criação de notifications e deliveries, sink durável e worker independente com encerramento do pool.

**Aceite e prova:** Pais e eventos persistem na transação correta; confirmação durável só encerra entrega correspondente. Produção exige sink explícito; console restrito a dev/teste; restart do processo não perde trabalho.
### AAA2-019 — Exercitar leases, tokens, dois workers, crash após publicação, dedupe, backoff e poison message

**Prioridade:** P1 · **Dono:** QA / Plataforma · **Esforço:** M · **Estado:** IN PROGRESS (local slice) · **Gate:** G1.

**Dependências:** 016,018. **Origem:** A-06; AAA-10/11.

**Entrega:** Exercitar leases, tokens, dois workers, crash após publicação, dedupe, backoff e poison message.

**Aceite e prova:** Consumidor idempotente impede efeito duplicado; lease vencido não confirma claim novo; mensagem inválida vai a dead letter sem bloquear outras; replay autorizado é auditado. Não se promete exactly-once de transporte.
### AAA2-020 — Executar jornadas servidas com PostgreSQL e ensaio de cutover/retorno em ambiente isolado

**Prioridade:** P1 · **Dono:** QA / Dados · **Esforço:** L · **Estado:** IMPLEMENTED LOCAL / CI + CUTOVER PENDING · **Gate:** G1.

**Dependências:** 010,016,019. **Origem:** A-05/A-06; AAA-01/09.

**Entrega:** Executar jornadas servidas com PostgreSQL e ensaio de cutover/retorno em ambiente isolado.

**Aceite e prova:** Browser usa aplicação com banco real e mutações reais; restart conserva amostras/resultados/audit/entregas. A prova local já inclui 51/51 nos projetos Chromium/tablet/mobile contra PostgreSQL e 24/24 cenários HTTP em duas instâncias, incluindo sessão, fanout e replay; o workflow `browser-postgres` acrescenta build/start de produção, readiness PostgreSQL/S3 configurada e a matriz completa sem retry. Execução remota, restart/cutover/retorno com autoridade relacional e pacote integrado G1 permanecem abertos.

## G2 — produto clínico completo

### AAA2-021 — Completar Patient Workspace com identidade, encounter/admission, owner, solicitações, resultados, timeline e próxima ação

**Prioridade:** P1 · **Dono:** Produto / Frontend · **Esforço:** L · **Estado:** IMPLEMENTED LOCAL / CONDITIONAL · **Gate:** G2.

**Dependências:** 014,020; D-01. **Origem:** FR-CORE-001, FR-DATA-001; V2 Patient Workspace.

**Entrega:** Completar Patient Workspace com identidade, encounter/admission, owner, solicitações, resultados, timeline e próxima ação.

**Aceite e prova:** O contrato [Patient Workspace](../v2/PATIENT_WORKSPACE.md), a projeção em [`request-service.ts`](../../src/server/application/request-service.ts), os testes de join/escopo, o teste de resposta OpenAPI, a UI [`PatientDiagnostics`](../../src/components/patient-diagnostics.tsx) e a jornada Playwright responsiva demonstram deep link/reload, contexto derivado do servidor, resultado/anexo minimizados e ausência de mistura entre pacientes/itens. O packet visual v6 contém 20 PNGs e a crítica independente fresca de Bernoulli retornou `APPROVED_LOCAL`; raster não substitui revisão DOM/manual, golden do produto, ambiente-alvo ou aceite clínico/hospitalar. A nova integração PostgreSQL de recoleta/rollback está adicionada, mas aguarda cluster descartável; desambiguação institucional de homônimos, PostgreSQL alvo, políticas D-01 e aceite clínico/hospitalar continuam pendentes.
### AAA2-022 — Entregar transferência, leito, alta e troca de responsável com vigência e auditoria

**Prioridade:** P1 · **Dono:** Aplicação / Clínica · **Esforço:** L · **Estado:** IMPLEMENTED LOCAL / POLICY-GATED · **Gate:** G2.

**Dependências:** 021; D-01. **Origem:** FR-CORE-005, FR-AUTH-001.

**Entrega:** Entregar transferência, leito, alta e troca de responsável com vigência e auditoria.

**Aceite e prova:** A fatia local implementa comandos com escopo/versão, idempotência, impacto em itens abertos, auditoria/outbox e vigência; a prova está em [admission-context-service.test.ts](../../src/server/application/admission-context-service.test.ts), [admission-context-route.test.ts](../../src/server/http/admission-context-route.test.ts) e [packet local](../../.orchestrate/evidence/aaa2-022-local-20260905.md). A tarefa não é DONE: notificação/delegação, UI, testes de ambiente alvo, política D-01 e aceite clínico ainda faltam.
### AAA2-023 — Reconciliar agregado misto, revisão/conclusão, emenda/void e disponibilidade das versões com SPEC e UX

**Prioridade:** P1 · **Dono:** Domínio / Clínica · **Esforço:** L · **Estado:** PLANNED · **Gate:** G2.

**Dependências:** 002,016,007; D-02. **Origem:** A-08; FR-CORE-002, FR-RESULT-001/002/003.

**Entrega:** Reconciliar agregado misto, revisão/conclusão, emenda/void e disponibilidade das versões com SPEC e UX.

**Aceite e prova:** Tabela de decisão aprovada inclui REQUESTED+CANCELLED; invariantes e combinações de estados testadas. Emenda preserva linhagem, versão anterior e revisão por versão; conflito nunca sobrescreve conteúdo; contratos e telas concordam.
### AAA2-024 — Implementar authoring, revisão/publicação e histórico de templates e catálogo versionados

**Prioridade:** P1 · **Dono:** Lab / Produto · **Esforço:** L · **Estado:** PLANNED · **Gate:** G2.

**Dependências:** 020,007; D-03. **Origem:** FR-IMG-003, FR-ADMIN-001; V2 Lab estruturado.

**Entrega:** Implementar authoring, revisão/publicação e histórico de templates e catálogo versionados.

**Aceite e prova:** Unidade/faixa/população, workflow permitido, vigência e aprovador são explícitos; versão em uso é imutável e resultado antigo não muda com novo catálogo. Configuração inválida ou não aprovada não entra em uso clínico.
### AAA2-025 — Fechar Lab: accession, receber/processar, falha/recuperação pública, rejeição, recoleta/substituição e liberação

**Prioridade:** P1 · **Dono:** Lab / QA · **Esforço:** L · **Estado:** PLANNED · **Gate:** G2.

**Dependências:** 021,023,024; D-02. **Origem:** FR-LAB-001/002/003.

**Entrega:** Fechar Lab: accession, receber/processar, falha/recuperação pública, rejeição, recoleta/substituição e liberação.

**Aceite e prova:** Jornada browser com banco real cobre falha, recoleta e cadeia de amostras; API nega acesso por serviço indevido e transições inválidas. Retry/concorrência não cria amostra órfã; rastreio completo até resultado.
### AAA2-026 — Completar RX e agenda US, remarcação com motivo conforme política, procedimento e laudo/anexo versionado

**Prioridade:** P1 · **Dono:** Imaging / QA · **Esforço:** L · **Estado:** PLANNED · **Gate:** G2.

**Dependências:** 021,023; D-02. **Origem:** FR-IMG-001/002, FR-FILE-001.

**Entrega:** Completar RX e agenda US, remarcação com motivo conforme política, procedimento e laudo/anexo versionado.

**Aceite e prova:** E2E dedicado de US prova conflito, timezone, reagendamento e histórico; RX prova execução/release/revisão. Estados próprios de imagem não usam transições de Lab; laudo e versão de anexo corretos.
### AAA2-027 — Resolver destinatários ativos por responsabilidade/plantão e fallback para resultados críticos

**Prioridade:** P1 · **Dono:** Clínica / Plataforma · **Esforço:** L · **Estado:** IN PROGRESS (local policy slice) · **Gate:** G2.

**Dependências:** 022,024,018; D-03. **Origem:** A-11; FR-RESULT-004, FR-NOTIF-001.

**Entrega:** Resolver destinatários ativos por responsabilidade/plantão e fallback para resultados críticos.

**Aceite e prova:** A fatia local em [critical-result-policy.ts](../../src/server/application/critical-result-policy.ts) valida política versionada, resolve destinatários ativos por responsabilidade/gestor/plantão e fallback administrativo em ordem determinística, e cobre ausência de configuração em [critical-result-policy.test.ts](../../src/server/application/critical-result-policy.test.ts). A evidência está em [packet local](../../.orchestrate/evidence/aaa2-critical-policy-local-20260905.md). D-03, persistência/admin, plantão institucional, auditoria da resolução e prova distribuída continuam abertos; não é DONE.
### AAA2-028 — Implementar deadlines de acknowledgement e escalonamento temporal com job durável e runbook

**Prioridade:** P1 · **Dono:** Plataforma / Clínica · **Esforço:** L · **Estado:** IN PROGRESS (local policy slice) · **Gate:** G2.

**Dependências:** 019,023,027; D-03. **Origem:** A-11; FR-RESULT-004.

**Entrega:** Implementar deadlines de acknowledgement e escalonamento temporal com job durável e runbook.

**Aceite e prova:** A fatia local produz deadlines determinísticos e decisões com chave `critical-escalation:<notification>:<level>`, com testes de atraso, dedupe e acknowledgment no [packet local](../../.orchestrate/evidence/aaa2-critical-policy-local-20260905.md). Job durável, lease/restart, atualização da notificação, fallback institucional, runbook e D-03 continuam abertos; não é DONE.
### AAA2-029 — Implementar políticas de SLA versionadas, calendário, início, pausa, retomada e overdue

**Prioridade:** P1 · **Dono:** Domínio / Operações · **Esforço:** L · **Estado:** IMPLEMENTED LOCAL / POLICY-GATED · **Gate:** G2.

**Dependências:** 020,007; D-04. **Origem:** A-11; FR-OPS-002.

**Entrega:** Implementar políticas de SLA versionadas, calendário, início, pausa, retomada e overdue.

**Aceite e prova:** A fatia local calcula due-at por política versionada e preserva fallback explícito de início/calendário contínuo, com 14 testes em [sla-policy.test.ts](../../src/server/application/sla-policy.test.ts) e [packet local](../../.orchestrate/evidence/aaa2-sla-policy-local-20260905.txt). A tarefa não é DONE: D-04, calendário clínico, pausas/retomadas, persistência/admin, histórico, job durável de overdue, PostgreSQL e aceite operacional ainda faltam.
### AAA2-030 — Implementar paginação por cursor e ordenação estável global da fila, incluindo múltiplos departamentos

**Prioridade:** P1 · **Dono:** Aplicação / Frontend · **Esforço:** L · **Estado:** IMPLEMENTED LOCAL / RELATIONAL PENDING · **Gate:** G2.

**Dependências:** 001,020,029; D-04. **Origem:** A-10; FR-OPS-001; V2 Command Center/Central.

**Entrega:** Implementar paginação por cursor e ordenação estável global da fila, incluindo múltiplos departamentos.

**Aceite e prova:** Todos os itens autorizados são alcançáveis além de pageSize; sem duplicação por empate. Criticidade/overdue/prioridade/prazo/espera e desempate seguem contrato; contagem/cursor não revelam escopo; filtros e resposta fora de ordem preservam seleção.

**Prova local atual:** `listQueuePage` aplica escopo antes da paginação e ordena por prioridade, prazo e ID, com cursor validado e metadados de continuação; `listQueue` mantém compatibilidade para consumidores existentes. Os testes de leitura/API passaram 53/53 e o contrato OpenAPI passou. O [packet local](../../.orchestrate/evidence/aaa2-014-030-local-20260905.md) registra a prova; consulta relacional, corpus multi-departamento, EXPLAIN e carga aprovada permanecem em AAA2-031/043.
### AAA2-031 — Mover busca operacional para consultas relacionais com filtros, ranking e limites explícitos

**Prioridade:** P1 · **Dono:** Aplicação / Dados · **Esforço:** M · **Estado:** IMPLEMENTED LOCAL / RELATIONAL PENDING · **Gate:** G2.

**Dependências:** 015,001. **Origem:** FR-OPS-003, NFR-PERF-002.

**Entrega:** Mover busca operacional para consultas relacionais com filtros, ranking e limites explícitos.

**Aceite e prova:** Casos por protocolo, nome, vazio, homônimo, acento e limite preservam autorização e cursor; SQL não carrega snapshot inteiro; corpus grande prova completude. Benchmark final é exigido em AAA2-043.

**Prova local atual:** o serviço de leitura aplica escopo antes do ranking, suporta busca exata/prefixo/substrato, filtros de tipo/status/departamento, limites e cursor estável; os testes de leitura/API passaram 53/53. O [packet local](../../.orchestrate/evidence/aaa2-031-033-local-20260905.md) registra a prova. A consulta relacional da busca, corpus grande e `EXPLAIN` aprovado ainda dependem de AAA2-015/043.
### AAA2-032 — Paginar timeline do paciente e unificar correlação/proveniência de eventos sem expor conteúdo indevido

**Prioridade:** P1 · **Dono:** Aplicação / Frontend · **Esforço:** M · **Estado:** IMPLEMENTED LOCAL / DURABLE PROVENANCE PENDING · **Gate:** G2.

**Dependências:** 021,015. **Origem:** FR-OPS-004, FR-AUD-001.

**Entrega:** Paginar timeline do paciente e unificar correlação/proveniência de eventos sem expor conteúdo indevido.

**Aceite e prova:** Histórico extenso tem continuação estável, ordem temporal e ator/versão corretos; leitura e evento correlacionam requestId quando aplicável; filtros de escopo são anteriores à paginação.

**Prova local atual:** timeline valida request/item no mesmo contexto, filtra eventos por escopo antes da ordenação, usa `occurredAt + id` e retorna cursor. O [packet local](../../.orchestrate/evidence/aaa2-031-033-local-20260905.md) e os testes de leitura/API registram a continuação e os casos negativos; revisão de proveniência durável permanece aberta.
### AAA2-033 — Completar dashboard acionável com definições, denominadores, frescor e drill-down consistentes

**Prioridade:** P1 · **Dono:** Produto / Frontend · **Esforço:** M · **Estado:** IMPLEMENTED LOCAL / PRODUCT REVIEW PENDING · **Gate:** G2.

**Dependências:** 028,029,030. **Origem:** FR-OPS-005; V2 Command Center.

**Entrega:** Completar dashboard acionável com definições, denominadores, frescor e drill-down consistentes.

**Aceite e prova:** Indicadores conferem com corpus conhecido e filtros/setores; card abre fila correspondente; carregamento parcial e dado desatualizado são explícitos. Criticidade e SLA não são confundidos.

**Prova local atual:** dashboard devolve indicadores com denominadores e definições, janela/frescor, atenção acionável e estado por departamento; os testes cobrem escopo, contagens e drill-down. O [packet local](../../.orchestrate/evidence/aaa2-031-033-local-20260905.md) registra a prova; revisão de produto, carga real e estados parciais/degradados continuam abertos.
### AAA2-034 — Resolver identificadores, protocolo humano, sequência diária/fuso e janela de duplicidade configurável

**Prioridade:** P1 · **Dono:** Domínio / Produto · **Esforço:** M · **Estado:** PLANNED · **Gate:** G2.

**Dependências:** 016,007; D-04. **Origem:** FR-CORE-003/004.

**Entrega:** Resolver identificadores, protocolo humano, sequência diária/fuso e janela de duplicidade configurável.

**Aceite e prova:** ADR decide UUID/compatibilidade sem quebrar IDs existentes; concorrência na virada local não duplica protocolo; janela e override com motivo são auditados. Código/SPEC/OpenAPI concordam, incluindo casos de migração.
### AAA2-035 — Completar administração de departamentos, motivos, acesso/delegação e políticas de SLA/crítico com reautenticação

**Prioridade:** P1 · **Dono:** Produto / Segurança · **Esforço:** M · **Estado:** IN PROGRESS (local policy slice) · **Gate:** G2.

**Dependências:** 022,024,028,029. **Origem:** A-12; FR-ADMIN-001.

**Entrega:** Completar administração de departamentos, motivos, acesso/delegação e políticas de SLA/crítico com reautenticação.

**Aceite e prova:** O contrato local de política valida vigência, versão, aprovação, fallback e escalonamento antes do uso; a integração existente mantém liberação crítica fail-closed. A administração persistente com reautenticação, rotas, auditoria, PostgreSQL e D-03 ainda não existe; a fatia está registrada no [packet local](../../.orchestrate/evidence/aaa2-critical-policy-local-20260905.md) e não é DONE.

## G3 — segurança e operação distribuída

### AAA2-036 — Integrar identidade institucional e ciclo de sessão/role/scope com revogação entre instâncias

**Prioridade:** P1 · **Dono:** Segurança / Plataforma · **Esforço:** L · **Estado:** PLANNED · **Gate:** G3.

**Dependências:** 007,016; D-01,D-05. **Origem:** NFR-SEC-001; AAA-10.

**Entrega:** Integrar identidade institucional e ciclo de sessão/role/scope com revogação entre instâncias.

**Aceite e prova:** Login/logout, expiração, mudança de papel, indisponibilidade do IdP e recuperação administrativa seguem política aprovada; CSRF e sessão continuam eficazes; role recebido externamente não concede acesso sem mapeamento autorizado.
### AAA2-037 — Ativar rate limit distribuído e validar fronteiras de payload, headers e proxy confiável

**Prioridade:** P1 · **Dono:** Segurança / Plataforma · **Esforço:** M · **Estado:** IN PROGRESS (local slice) · **Gate:** G3.

**Dependências:** 016. **Origem:** NFR-SEC-001; AAA-03/10.

**Entrega:** Ativar rate limit distribuído e validar fronteiras de payload, headers e proxy confiável.

**Aceite e prova:** Duas instâncias compartilham limites; header forjado não troca identidade; banco indisponível segue negação segura. Casos de tamanho/nesting/body inválido e abuso por rota têm respostas contratuais e recursos limitados.

**Prova local atual:** O packet [AAA2-017–019/037/041](../../.orchestrate/evidence/aaa2-017-019-037-041-local-20260905.txt) cobre fronteiras de configuração, SQL e proxy em mocks. Duas instâncias com banco compartilhado continuam pendentes.
### AAA2-038 — Integrar object storage privado e scanner externo com quarentena, timeout e falha observável

**Prioridade:** P1 · **Dono:** Segurança / SRE · **Esforço:** L · **Estado:** PLANNED · **Gate:** G3.

**Dependências:** 026,007; D-05. **Origem:** NFR-SEC-003, FR-FILE-001; AAA-13.

**Entrega:** Integrar object storage privado e scanner externo com quarentena, timeout e falha observável.

**Aceite e prova:** Arquivo só libera após scan limpo; MIME/checksum/tamanho, acesso por versão e link expirado são exercitados. Falha de scanner/storage não libera conteúdo; exclusão/retenção e recovery mantêm metadados coerentes.
### AAA2-039 — Validar configuração de homologação equivalente à produção: TLS, ingress, cookies, CORS, segredos/rotação e credenciais mínimas

**Prioridade:** P1 · **Dono:** SRE / Segurança · **Esforço:** M · **Estado:** PLANNED · **Gate:** G3.

**Dependências:** 036,038; D-05. **Origem:** NFR-SEC-001/004; AAA-18.

**Entrega:** Validar configuração de homologação equivalente à produção: TLS, ingress, cookies, CORS, segredos/rotação e credenciais mínimas.

**Aceite e prova:** Inicialização recusa adaptadores inseguros e segredos ausentes; nenhum log/trace expõe credenciais ou conteúdo clínico desnecessário. Privilégios SQL protegem auditoria e storage; rotação e revogação são ensaiadas.
### AAA2-040 — Fechar fanout SSE multi-instância, catálogo de eventos, replay/resync, backpressure e limites

**Prioridade:** P1 · **Dono:** Plataforma / QA · **Esforço:** L · **Estado:** PLANNED · **Gate:** G3.

**Dependências:** 005,019,036,037. **Origem:** A-04; FR-NOTIF-002, NFR-REL-002.

**Entrega:** Fechar fanout SSE multi-instância, catálogo de eventos, replay/resync, backpressure e limites.

**Prova local parcial:** O packet [`aaa3-http-multi-instance-20260906.md`](../../.orchestrate/evidence/aaa3-http-multi-instance-20260906.md) sobe dois processos Next contra o mesmo PostgreSQL e comprova login em A → sessão em B, `LISTEN` real em B, wake-up sem payload clínico, mutação/outbox de A entregue ao SSE autorizado de B e replay após `Last-Event-ID` em dois processos `next start`. **Aceite restante:** Todas as mutações relevantes, inclusive iniciar/revisar, devem gerar invalidação após commit; expiração/revogação deve cortar stream; replay não pode vazar escopo; backlog/cliente lento não pode esgotar recursos; e o ensaio precisa repetir sob carga, failover/restart, proxy/TLS e ambiente-alvo.
### AAA2-041 — Definir SLO e instrumentar correlação, health/readiness, fila/worker/SSE, banco e recursos com alertas

**Prioridade:** P1 · **Dono:** SRE / Plataforma · **Esforço:** M · **Estado:** IN PROGRESS (local slice) · **Gate:** G3.

**Dependências:** 018,007; D-05. **Origem:** NFR-OBS-001; AAA-14.

**Entrega:** Definir SLO e instrumentar correlação, health/readiness, fila/worker/SSE, banco e recursos com alertas.

**Aceite e prova:** SLO aprovado tem janela, orçamento de erro e dono; falhas injetadas geram alerta acionável e runbook. Labels limitadas não incluem paciente; indisponibilidade de dependência aparece corretamente no health.

**Prova local atual:** O packet [AAA2-017–019/037/041](../../.orchestrate/evidence/aaa2-017-019-037-041-local-20260905.txt) registra readiness, métricas bounded e labels sem identificadores. Alerta entregue, SLO aprovado e ownership operacional ainda aguardam D-05.
### AAA2-042 — Criar workload manifest e executar EXPLAIN de consultas reais com volume, skew e distribuições representativos

**Prioridade:** P1 · **Dono:** Dados / Performance · **Esforço:** M · **Estado:** IN PROGRESS (local harness) · **Gate:** G3.

**Dependências:** 015,029,030,031,032. **Origem:** A-05/A-10; NFR-PERF-001/002.

**Entrega:** Criar workload manifest e executar EXPLAIN de consultas reais com volume, skew e distribuições representativos.

**Aceite e prova:** Dataset sintético versionado tem cardinalidades, histórico, filtros raros, vazio, filas extensas e multi-setor; planos e índices justificados. Perfil e metas são congelados antes da medição e revistos por operação.

**Prova local atual:** [`scripts/perf-workload.ts`](../../scripts/perf-workload.ts) fixa versão, seed, cardinalidade, histórico, homônimos, protocolo raro, escopo por setor e workloads de fila/busca exata/textual. [`npm run perf:synthetic`](../../.orchestrate/evidence/aaa2-perf-local-20260905.md) reproduz o digest `4e28b71d` e os percentis com relógio virtual; o packet V2 acrescenta `EXPLAIN` estrutural da leitura relacional de request/item/sample/link sob fan-out local. Isso cobre manifesto, reprodutibilidade e uma verificação de índices da seam; não substitui volume/skew aprovado pelo piloto, duas instâncias, soak ou revisão operacional.
### AAA2-043 — Executar carga de leituras e comandos clínicos, busca, filas e SSE com duas instâncias e banco durável

**Prioridade:** P1 · **Dono:** Performance / QA · **Esforço:** L · **Estado:** IN PROGRESS (local harness) · **Gate:** G3.

**Dependências:** 020,033,034,040,041,042. **Origem:** A-13; NFR-PERF-001/002.

**Entrega:** Executar carga de leituras e comandos clínicos, busca, filas e SSE com duas instâncias e banco durável.

**Aceite e prova:** Relatório inclui p50/p95/p99, throughput, erros, uso de recursos e duração; atende perfil aprovado em carga nominal, pico e soak. Não usar smoke em memória como aceite; lock/espera e filas não crescem sem limite.

**Prova local atual:** [`scripts/perf-workload.ts`](../../scripts/perf-workload.ts) e seus [`testes determinísticos`](../../scripts/perf-workload.test.ts) exercitam 372 requisições sintéticas concorrentes, leituras operacionais, busca exata/textual, erro esperado e métricas p50/p95/p99. O packet [`aaa2-perf-local-20260905.md`](../../.orchestrate/evidence/aaa2-perf-local-20260905.md) registra o modelo virtual; o packet [`aaa2-postgres-local-20260905.md`](../../.orchestrate/evidence/aaa2-postgres-local-20260905.md) registra o smoke HTTP mais recente em PostgreSQL (80 requests, 0 erros, p95 máximo 45,94 ms). O aceite continua `CONDITIONAL`: não há duas instâncias, SSE, comandos clínicos em carga, recursos, soak, lock/espera ou workload hospitalar aprovado.
### AAA2-044 — Formalizar e implementar retenção, residência, exportação/eliminação e restrições de auditoria segundo política institucional

**Prioridade:** P1 · **Dono:** Privacidade / Produto · **Esforço:** M · **Estado:** IMPLEMENTED LOCAL / POLICY-GATED · **Gate:** G3.

**Dependências:** 007,014; D-05. **Origem:** NFR-SEC-004; AAA-19/21.

**Entrega:** Formalizar e implementar retenção, residência, exportação/eliminação e restrições de auditoria segundo política institucional.

**Aceite e prova:** Responsáveis aprovam política e execução autorizada é auditável; tratamento de backups, anexos e exceções de retenção é coerente. Testes negativos impedem exportação ampla ou eliminação indevida; não alegar certificação regulatória.

**Prova local atual:** [`data-governance-policy.ts`](../../src/server/operations/data-governance-policy.ts) e seus testes validam aprovação, residência, retenção por classe, exportação limitada a escopo, aprovação explícita para eliminação e auditoria imutável. Sem D-05/OQ-013 o guard retorna `GOVERNANCE_POLICY_NOT_APPROVED`; isso não fecha a aprovação institucional nem cria prazos de retenção.
### AAA2-045 — Exercitar backup e restauração de banco, conteúdo de anexos e configuração/metadados necessários às chaves em ambiente vazio

**Prioridade:** P1 · **Dono:** SRE / Dados · **Esforço:** L · **Estado:** IMPLEMENTED LOCAL / ENVIRONMENT-BLOCKED · **Gate:** G3.

**Dependências:** 020,038,039,044; D-05. **Origem:** A-13; NFR-OPS-001.

**Entrega:** Exercitar backup e restauração de banco, conteúdo de anexos e configuração/metadados necessários às chaves em ambiente vazio.

**Aceite e prova:** Verificar conteúdo clínico/linhagem, checksums/download dos anexos e leitura pela aplicação; medir perda máxima de dados e tempo total. RPO/RTO aprovados atendidos; restauração não depende de segredo gravado no relatório.

**Prova local atual:** [`recovery-manifest.ts`](../../src/server/operations/recovery-manifest.ts) cria manifesto sem segredos para dump, object metadata e referências de configuração; verifica checksum/tamanho de arquivos copiados e emite plano `DRY_RUN` que rejeita alvo não isolado. [`backup-db.sh`](../../scripts/backup-db.sh), [`restore-db.sh`](../../scripts/restore-db.sh) e [`backup-restore-smoke.sh`](../../scripts/backup-restore-smoke.sh) exigem opt-in, manifesto e alvo descartável, e o último aceita `POSTGRES_DIRECT_URL` além de Docker. O packet [`aaa2-postgres-local-20260905.md`](../../.orchestrate/evidence/aaa2-postgres-local-20260905.md) registra restore PostgreSQL local `1|1|0`; o packet V2 adiciona integração real da lineage em cluster efêmero. Object storage/chaves, aplicação, RPO e RTO continuam sem aceite.
### AAA2-046 — Exercitar crash/restart, rede, timeout de dependência, poison queue e recuperação integrada

**Prioridade:** P1 · **Dono:** SRE / QA · **Esforço:** L · **Estado:** PLANNED · **Gate:** G3.

**Dependências:** 028,040,041,045. **Origem:** A-13; NFR-REL-001/002, NFR-OBS-001.

**Entrega:** Exercitar crash/restart, rede, timeout de dependência, poison queue e recuperação integrada.

**Aceite e prova:** Runbooks permitem detectar, conter e recuperar; nenhum efeito clínico duplicado, perda silenciosa ou tempestade de retry. Alertas chegam ao dono; reconciliar backlog e dados após recuperação.

## G4 — qualidade integrada

### AAA2-047 — Completar estados loading/empty/error/partial/offline/degraded/denied, foco, seleção e segurança contra comandos duplicados

**Prioridade:** P1 · **Dono:** UX / Frontend · **Esforço:** L · **Estado:** PLANNED · **Gate:** G4.

**Dependências:** 021,025,026,030,033. **Origem:** NFR-UX-001/002; AAA-16.

**Entrega:** Completar estados loading/empty/error/partial/offline/degraded/denied, foco, seleção e segurança contra comandos duplicados.

**Aceite e prova:** Matriz de estados por jornada é navegável; latência/queda não mostra sucesso falso; contexto do paciente sempre inequívoco. Solicitação contextual mede meta do PRD de até quatro ações conforme definição de início/fim acordada.
### AAA2-048 — Validar manualmente teclado, touch real, leitor de tela, contraste, zoom e reduced motion em dispositivos acordados

**Prioridade:** P1 · **Dono:** UX / QA manual · **Esforço:** L · **Estado:** PLANNED · **Gate:** G4.

**Dependências:** 047,040. **Origem:** NFR-UX-002; AAA-16.

**Entrega:** Validar manualmente teclado, touch real, leitor de tela, contraste, zoom e reduced motion em dispositivos acordados.

**Aceite e prova:** Cobertura de jornadas críticas e matriz de dispositivos assinadas; axe sem falhas bloqueantes; leitor de tela e foco após diálogo/erro comprovados. Incluir Safari/Firefox se usados no hospital; Chromium emulado não prova touch real.
### AAA2-049 — Refinar design system, hierarquia clínica, densidade, tipografia, tokens e consistência por screenshots

**Prioridade:** P1 · **Dono:** UX / Frontend · **Esforço:** M · **Estado:** PLANNED · **Gate:** G4.

**Dependências:** 047. **Origem:** V2 Central/Workspace; AAA-16.

**Entrega:** Refinar design system, hierarquia clínica, densidade, tipografia, tokens e consistência por screenshots.

**Aceite e prova:** Conjunto de telas/estados e viewports comparáveis revisado, incluindo textos longos e dados extremos; status crítico não depende só de cor. Polish não reduz contexto, legibilidade ou acessibilidade; baseline visual versionada.
### AAA2-050 — Ampliar regressão por risco, cobertura real de runtime/PG/UI e testes de invariantes com sentinelas

**Prioridade:** P1 · **Dono:** QA / Engenharia · **Esforço:** L · **Estado:** PLANNED · **Gate:** G4.

**Dependências:** 025,026,028,035,040. **Origem:** AAA-01/04/07/13; todos os FR/NFR/AC.

**Entrega:** Ampliar regressão por risco, cobertura real de runtime/PG/UI e testes de invariantes com sentinelas.

**Aceite e prova:** Matriz executável cobre todos os aceites obrigatórios; regressões detectam reintrodução de vazamento/cancelamento e erro de versão. Relatórios separam unitário, integração e browser; limiares da barra atingidos sem exclusões convenientes.
### AAA2-051 — Revisar arquitetura final e threat model com abuso HTTP, IDOR, upload, replay e escala de privilégio

**Prioridade:** P1 · **Dono:** Lead / Segurança · **Esforço:** M · **Estado:** PLANNED · **Gate:** G4.

**Dependências:** 035,039,040. **Origem:** AAA-03/04/05/17/18; V2 packages.

**Entrega:** Revisar arquitetura final e threat model com abuso HTTP, IDOR, upload, replay e escala de privilégio.

**Aceite e prova:** Imports/fronteiras e coesão passam; packages têm responsabilidade real. Revisão independente não encontra crítico/alto aberto; scan e dependências atuais passam. Toda correção material tem reteste sem relaxar controles.
### AAA2-052 — Fechar paridade PRD/SPEC/OpenAPI/runtime/UI: políticas, IDs, protocolo, hashing, upload e migrations

**Prioridade:** P1 · **Dono:** Docs / QA · **Esforço:** M · **Estado:** PLANNED · **Gate:** G4.

**Dependências:** 035,034,038,044. **Origem:** A-12; AAA-02/20.

**Entrega:** Fechar paridade PRD/SPEC/OpenAPI/runtime/UI: políticas, IDs, protocolo, hashing, upload e migrations.

**Aceite e prova:** 64 operações/59 paths são baseline histórica, não meta fixa; a execução corrente valida 65 operações em 60 paths. Catálogo final e contrato convergem; ADRs justificam mudanças, matriz rastreia todos os AC e não chama planejamento de execução.
### AAA2-053 — Executar CI remoto obrigatório com Node fixado, PostgreSQL, build de produção, browser durável e retenção de artefatos

**Prioridade:** P1 · **Dono:** DevEx / QA · **Esforço:** L · **Estado:** IMPLEMENTED WORKFLOW / REMOTE EXECUTION PENDING · **Gate:** G4.

**Dependências:** 043,046,048,049,050,051,052. **Origem:** AAA-18/20/22.

**Entrega:** Executar CI remoto obrigatório com Node fixado, PostgreSQL, build de produção, browser durável e retenção de artefatos.

**Aceite e prova:** `.github/workflows/ci.yml` fixa Node 22, PostgreSQL 16, banco por `github.run_id`, build/start de produção, readiness PostgreSQL/S3 configurada, browser Chromium sem retry explícito e artifacts com `if: always()`. O alvo remoto ainda não foi executado neste ambiente; portanto a entrega não é DONE e indisponibilidade externa bloqueia o aceite correspondente.
### AAA2-054 — Consolidar packet G4 e repetir scorecard com a metodologia da auditoria

**Prioridade:** P1 · **Dono:** QA / Lead · **Esforço:** M · **Estado:** PLANNED · **Gate:** G4.

**Dependências:** 053. **Origem:** AAA-01–21.

**Entrega:** Consolidar packet G4 e repetir scorecard com a metodologia da auditoria.

**Aceite e prova:** Cada dimensão técnica/documental ≥95 e todos os MUST/AC e AAA-01–21 PASS; evidências com hash/ambiente/comando, decisões assinadas e limites explícitos. Qualquer item não demonstrado mantém G4 aberto.

## G5 — aceite e liberação governada

### AAA2-055 — Fechar runbooks de deploy/rollback/incidente, suporte, on-call e responsabilidades

**Prioridade:** P1 · **Dono:** SRE / Produto · **Esforço:** M · **Estado:** PLANNED · **Gate:** G5.

**Dependências:** 041,045,054; D-06. **Origem:** AAA-19/22.

**Entrega:** Fechar runbooks de deploy/rollback/incidente, suporte, on-call e responsabilidades.

**Aceite e prova:** Equipe nomeada, contatos testados e autoridade de interromper definida; release packet cobre migrations compatíveis e tratamento de escrita nova no rollback. Sem pessoa responsável não há liberação.
### AAA2-056 — Auditar candidato congelado a partir de artefatos e reproduções, com revisão independente do implementador

**Prioridade:** P1 · **Dono:** Revisor independente · **Esforço:** M · **Estado:** PLANNED · **Gate:** G5.

**Dependências:** 054,055. **Origem:** Todos os A-01–A-13; AAA-01–21.

**Entrega:** Auditar candidato congelado a partir de artefatos e reproduções, com revisão independente do implementador.

**Aceite e prova:** Reproduções dos achados originais deixam de falhar; crítica revisa requisitos, segurança, banco e evidências sem confiar só em status. Achado material gera rework e novo candidato; parecer favorável habilita piloto, não é aceite final automático.
### AAA2-057 — Treinar equipes e homologar jornadas com usuários representativos Lab/RX/US/solicitante/gestão

**Prioridade:** P1 · **Dono:** Clínica / UX / Produto · **Esforço:** M · **Estado:** PLANNED · **Gate:** G5.

**Dependências:** 054; D-06. **Origem:** AAA-06/16/21/22; V2 governança.

**Entrega:** Treinar equipes e homologar jornadas com usuários representativos Lab/RX/US/solicitante/gestão.

**Aceite e prova:** Cenários e participantes definidos pelo hospital; tarefas, dificuldades e erros registrados; políticas e contingência compreendidas. Correções afetam packet e regressões; materiais e aceite formal anexados.
### AAA2-058 — Ensaiar instalação do candidato, migração, rollback/roll-forward e continuidade operacional

**Prioridade:** P1 · **Dono:** SRE / QA · **Esforço:** M · **Estado:** PLANNED · **Gate:** G5.

**Dependências:** 055,056. **Origem:** AAA-09/19/22.

**Entrega:** Ensaiar instalação do candidato, migração, rollback/roll-forward e continuidade operacional.

**Aceite e prova:** Executar roteiro em homologação equivalente, com escrita durante janela controlada e verificação pós-retorno; tempos e perda de dados atendem política. Binário, schema e configuração do candidato permanecem identificáveis.
### AAA2-059 — Executar piloto autorizado com escopo, duração, participantes, acompanhamento e critérios de interrupção congelados

**Prioridade:** P1 · **Dono:** Hospital / Produto / SRE · **Esforço:** L · **Estado:** PLANNED · **Gate:** G5.

**Dependências:** 057,058; D-06. **Origem:** AAA-22.

**Entrega:** Executar piloto autorizado com escopo, duração, participantes, acompanhamento e critérios de interrupção congelados.

**Aceite e prova:** Registrar denominadores, tarefas concluídas, incidentes, falhas e tempos; critérios acordados atendidos sem ocultar eventos. Defeito de confidencialidade/integridade interrompe piloto; mitigação/reteste e nova aprovação exigidos para retomada.
### AAA2-060 — Revalidar candidato final, fechar auditoria e deliberar release com acompanhamento inicial

**Prioridade:** P1 · **Dono:** Patrocinador / Hospital / QA · **Esforço:** M · **Estado:** PLANNED · **Gate:** G5.

**Dependências:** 059. **Origem:** AAA-01–22.

**Entrega:** Revalidar candidato final, fechar auditoria e deliberar release com acompanhamento inicial.

**Aceite e prova:** Todos os critérios PASS, parecer independente final favorável, zero crítico/alto aberto e scorecard ≥95 por dimensão. Mudanças do piloto são revalidadas; assinatura autoriza release definido e plano de acompanhamento, não implantação automática por este documento.

## Cobertura dos achados

| Achado | Entregas principais |
| --- | --- |
| A-01 — escopo na fila | AAA2-001, 030, 040, 050, 051 |
| A-02 — cancelamento por fase | AAA2-002, 023, 050 |
| A-03 — erro/build realtime | AAA2-003, 010 |
| A-04 — evento e recuperação | AAA2-005, 040, 046 |
| A-05 — persistência autoritativa | AAA2-011–016, 020, 042, 045 |
| A-06 — integração outbox | AAA2-017–019, 028, 040 |
| A-07 — gestor delegado | AAA2-001, 004, 022, 036 |
| A-08 — semântica dos estados | AAA2-007, 023, 025, 026, 052 |
| A-09 — ciclo estático | AAA2-006, 051 |
| A-10 — paginação e ordem | AAA2-030, 033, 042, 043 |
| A-11 — críticos e SLA | AAA2-007, 024, 027–029, 035 |
| A-12 — contrato e rastreabilidade | AAA2-008–010, 034, 035, 052–054 |
| A-13 — operação/recuperação | AAA2-041–046, 053–060 |

## Cobertura integral dos requisitos da auditoria

A tabela fecha a cobertura de planejamento dos 42 requisitos, não substitui a matriz executável por AC. Referências com barra nos cartões acima são abreviações; os IDs canônicos estão aqui.

| Requisito | Entregas AAA2 |
| --- | --- |
| FR-CORE-001 | 021, 047, 050 |
| FR-CORE-002 | 023, 050 |
| FR-CORE-003 | 034, 052 |
| FR-CORE-004 | 034, 050 |
| FR-CORE-005 | 022, 027 |
| FR-CORE-006 | 002, 023, 050 |
| FR-LAB-001 | 014, 025 |
| FR-LAB-002 | 025, 050 |
| FR-LAB-003 | 025, 050 |
| FR-IMG-001 | 026, 050 |
| FR-IMG-002 | 026, 050 |
| FR-IMG-003 | 024, 035 |
| FR-RESULT-001 | 023, 025, 026 |
| FR-RESULT-002 | 023, 028, 050 |
| FR-RESULT-003 | 023, 028, 050 |
| FR-RESULT-004 | 027, 028, 057 |
| FR-NOTIF-001 | 017, 018, 019, 027, 028 |
| FR-NOTIF-002 | 005, 040 |
| FR-OPS-001 | 001, 030 |
| FR-OPS-002 | 029, 035 |
| FR-OPS-003 | 031, 042, 043 |
| FR-OPS-004 | 032, 050 |
| FR-OPS-005 | 033, 043 |
| FR-AUD-001 | 014, 016, 032, 039 |
| FR-AUTH-001 | 001, 004, 022, 036, 051 |
| FR-DATA-001 | 013, 014, 021 |
| FR-FILE-001 | 026, 038, 045 |
| FR-ADMIN-001 | 024, 035 |
| NFR-SEC-001 | 036, 037, 039, 051 |
| NFR-SEC-002 | 001, 036, 040, 051 |
| NFR-SEC-003 | 038, 045, 051 |
| NFR-SEC-004 | 016, 032, 039, 044 |
| NFR-REL-001 | 016, 017, 018, 019, 046 |
| NFR-REL-002 | 005, 040, 046, 047 |
| NFR-PERF-001 | 042, 043 |
| NFR-PERF-002 | 031, 042, 043 |
| NFR-UX-001 | 021, 047, 057 |
| NFR-UX-002 | 047, 048, 049, 057 |
| NFR-OBS-001 | 041, 046 |
| NFR-OPS-001 | 045, 055, 058 |
| NFR-API-001 | 003, 016, 030, 052 |
| NFR-MAINT-001 | 003, 006, 015, 051 |

As sete fatias V2 também estão cobertas: Command Center (030/033), Central/drawer (030/047/049), Lab estruturado (024/025), cadastro (014/021/034), Patient Workspace (021/022/032), packages (015/051) e governança (007/044/055/057/059/060).

## Migração dos compromissos AAA-1

| IDs históricos | Sucessores principais AAA2 | Tratamento |
| --- | --- | --- |
| AAA-W0-001–008 | 008–011, 053 | Revalidar alias, instalação, dependências, E2E e evidência; não duplicar correção já existente sem falha atual |
| AAA-W1-001–007 | 011–016, 020, 042, 045 | Schema estático é ponto de partida; execução, cutover e prova continuam abertos |
| AAA-W2-001–006 | 001, 004, 022, 036–039, 051 | Antecipar falhas confirmadas de acesso para G0; manter integração institucional |
| AAA-W3-001–004 | 021–025, 034 | Preservar workspace, identidade, amostras e lifecycle |
| AAA-W4-001–006 | 017–019, 023–029, 035 | Separar política clínica, implementação e entrega durável |
| AAA-W5-001–004 | 040–043, 046 | Exigir prova distribuída e de operação |
| AAA-W6-001–003 | 047–049, 057 | Separar automação, inspeção manual e aceite de usuários |
| AAA-W7-001–005 | 009, 050–056, 058, 060 | Primeiro diagnóstico independente gera rework; aceite final só após piloto e retestes |
| AAA-W8-001–002 | 007, 044, 055, 057, 059, 060 | Preparar governança desde G0; concluir com autoridade real |

Histórico preservado em [STATE_OF_ART_BACKLOG.md](STATE_OF_ART_BACKLOG.md). Não somar os dois backlogs como duas listas de entregas a construir.
