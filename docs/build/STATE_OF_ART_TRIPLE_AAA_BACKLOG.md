# Backlog State of Art / Triplo AAA — CVG Diagnostics Hub

**Versão:** AAA-3  
**Data:** 07/09/2026  
**Estado:** backlog de mobilização; nenhum item AAA-READY

[Plano executivo](STATE_OF_ART_TRIPLE_AAA_EXECUTIVE_PLAN.md) · [Roadmap](STATE_OF_ART_TRIPLE_AAA_ROADMAP.md) · [Relatório atual](../RELATORIO_AUDITORIA_2026-09-07.md)

## 1. Como usar este backlog

Este backlog é a fonte de execução do programa AAA-3. O backlog AAA-2 e seus IDs são preservados como histórico e mapa de continuidade; não são apagados nem tratados como evidência atual.

Cada item precisa manter a cadeia:

problema → requisito/AC → SPEC/ADR → gate → tarefa → código/configuração/migration → teste/procedimento → evidência → risco residual.

Status válidos:

- NOT_READY: identificado, mas ainda não preparado;
- READY: pode começar sem decisão bloqueante;
- IN_PROGRESS: execução ativa;
- BLOCKED: depende de autoridade, ambiente ou resultado anterior;
- VERIFY: implementação pronta, aguardando prova;
- DONE: aceite atual comprovado;
- DEFERRED/CANCELLED: decisão explícita de escopo.

Nenhum item abaixo deve virar DONE apenas por existir código, teste, documento ou packet histórico.

Prioridades:

- P0: bloqueia segurança, dados, requisito obrigatório ou gate;
- P1: necessário para completude operacional/qualidade;
- P2: melhoria importante sem bloquear o próximo gate.

Tamanhos:

- S: até 3 dias-pessoa;
- M: 4–8 dias-pessoa;
- L: 9–20 dias-pessoa;
- XL: mais de 20 dias-pessoa ou dependência externa.

## 2. S0 — verdade e mobilização

| ID | Pri | Status | Dono / tamanho | Entrega verificável e aceite mínimo |
| --- | --- | --- | --- | --- |
| SAA-001 | P0 | DONE | Lead / M | Inventário corrente, relatório, fingerprint, contadores, estado `.agent` e limitações foram reconciliados no packet [`control-plane-reconciliation-20260907.md`](../../.orchestrate/aaa3-execution-20260907/control-plane-reconciliation-20260907.md); o working tree continua explicitamente dirty e nenhum gate externo foi promovido. |
| SAA-002 | P0 | READY | Patrocinador / M | Nomear titular e substituto de produto, engenharia, QA, SRE, UX, clínica, segurança e privacidade; registro de autoridade com data e escopo. |
| SAA-003 | P0 | VERIFY | QA / M | Corrigir 614/619/621, 60/65/74 e demais claims stale; cada número deve ter comando, ambiente, data e limitação. A fonte AAA-3 está reconciliada; documentos históricos estão marcados como históricos; falta revisão independente editorial final. |
| SAA-004 | P0 | BLOCKED | Clínica + segurança / L | Decidir D-01: identidade institucional, ownership, homônimos, delegação, transferência e alta; política versionada e assinada. |
| SAA-005 | P0 | BLOCKED | Clínica + Lab/RX/US / M | Decidir D-02: estados de resultado, revisão, emenda, void, falha e motivos de US; tabela de transições aprovada. |
| SAA-006 | P0 | BLOCKED | Clínica + setores / L | Decidir D-03: templates, unidades, faixas, criticidade, plantão, fallback e acknowledgement; política operacional vigente. |
| SAA-007 | P0 | BLOCKED | Produto + operação / M | Decidir D-04: SLA, início, pausas, calendário, prioridade, duplicidade e timezone; exemplos de cálculo aprovados. |
| SAA-008 | P0 | BLOCKED | Privacidade + SRE / XL | Decidir D-05: IdP, retenção, residência, exportação, eliminação, storage, AV, secrets, SLO, RPO e RTO. |
| SAA-009 | P0 | BLOCKED | Patrocinador + hospital / L | Decidir D-06: participantes, treinamento, suporte, janela, stop criteria, rollback e autoridade do piloto. |

## 3. S1 — segurança e contratos

| ID | Pri | Status | Dono / tamanho | Entrega verificável e aceite mínimo |
| --- | --- | --- | --- | --- |
| SAA-010 | P0 | READY | Segurança + QA / L | Matriz actor → action → resource → condition para listas, contagens, busca, timeline, SSE, drafts, versões, anexos e administração; todos os casos allow/deny passam. |
| SAA-011 | P0 | READY | Aplicação / M | Corrigir e testar escopo de fila, busca e timeline por paciente, setor, serviço e gestor delegado; nenhum conteúdo ou contagem indevida. |
| SAA-012 | P0 | READY | Aplicação / M | Fechar autorização por fase para cancelar, rejeitar, recolher, iniciar, revisar, invalidar e liberar; known-bad sem elevação deve falhar. |
| SAA-013 | P0 | READY | Aplicação / M | Garantir que delegação de gestor seja consistente em listagem, detalhe, comando, administração e revogação entre instâncias. |
| SAA-014 | P0 | READY | API + produto / M | Reconciliar PRD, SPEC, API_SPEC, OpenAPI, manifest, Zod, respostas runtime e UI; eliminar operação documentada sem implementação ou vice-versa. |
| SAA-015 | P1 | VERIFY | Realtime + QA / M | Códigos HTTP de capacidade/adapter, `Last-Event-ID`, resync, reconnect nativo, polling fallback e tela aberta com mutação real passaram nos focais locais e na matriz browser 60/60; o packet PostgreSQL descartável anterior cobre fanout/LISTEN, mas a repetição current-source aguarda host com cluster descartável. |
| SAA-016 | P1 | DONE | Plataforma / M | `npm ci`, typecheck, lint e build executados em Node 22.23.2 limpo; a revalidação PostgreSQL corrente está em `.orchestrate/aaa3-execution-20260907/postgres-node22-revalidation-20260907.md`. CI remoto ainda é SAA-054. |
| SAA-017 | P0 | VERIFY | QA / M | Matriz [`KNOWN_BAD_CONTROL_MATRIX.md`](../security/KNOWN_BAD_CONTROL_MATRIX.md) cataloga oito fronteiras e testes executáveis para escopo, comandos, versão, MIME, outbox, replay e logger; o sentinel local 7/7 está em [`MUTATION_CONTROLS.md`](../security/MUTATION_CONTROLS.md), mas ainda falta revisão independente e validação no ambiente-alvo. |

## 4. S2 — dados, migrations e delivery

| ID | Pri | Status | Dono / tamanho | Entrega verificável e aceite mínimo |
| --- | --- | --- | --- | --- |
| SAA-020 | P0 | READY | Dados / L | Inventariar StoreState, tabelas 001–010, writers, readers, jobs, relatórios, caches, integrações, volume, skew e invariantes com dataset representativo isolado. |
| SAA-021 | P0 | READY | Dados + domínio / L | Definir modelo relacional clínico completo para request, item, sample, accession, result, version, delivery, audit, identity e ownership; constraints e índices aprovados. |
| SAA-022 | P0 | IN_PROGRESS | Dados + QA / M | Upgrade 001→010 comprovado em cluster descartável com 5/5 cenários: preservação JSONB/relacional, reparo de membership, retomada com `009` já aplicado, rollback fail-closed para accession/replacement/link-status inválidos, retry, checksum drift e leitura segura após perda de vínculo. Packet: `migration-upgrade-node22-local-20260907.md`; ainda faltam cenários de volume/skew representativos, restart/cutover/rollback com autoridade aprovada e base do ambiente-alvo. |
| SAA-023 | P0 | READY | Dados / L | Executar backfill shadow populado, paginado e resumível com checkpoint, lock, source hash, erro isolado e reconciliação por aggregate. |
| SAA-024 | P0 | READY | Dados + QA / L | Implementar dual-read controlado, relatório de divergência, quarantine e política para source drift; nenhum dado relacional divergente chega ao usuário. |
| SAA-025 | P0 | BLOCKED | Dados + autoridade / XL | Escolher dual-write, change capture ou janela de freeze; somente D-01/D-05 confirmadas podem autorizar desenho de autoridade e ownership. |
| SAA-026 | P0 | READY | Dados / L | Provar transação, optimistic concurrency, lock budget, duas conexões, retry, crash e restart sem perda, duplicidade ou estado impossível. |
| SAA-027 | P0 | READY | Plataforma + aplicação / L | Mapear cada evento outbox a consumidor, payload, FK, lease, retry, dedupe, poison/dead-letter e confirmação de delivery. |
| SAA-028 | P0 | READY | SRE + dados / L | Restaurar PostgreSQL descartável e validar a aplicação, contagens, hashes, audit, outbox, versões e readiness; medir tempo e perda. |
| SAA-029 | P0 | BLOCKED | Dados + QA / XL | Executar canary de cutover com stop signal, reconciliação contínua, rollback ou roll-forward aprovado; não tocar produção antes da autoridade. |

## 5. S3 — produto clínico

| ID | Pri | Status | Dono / tamanho | Entrega verificável e aceite mínimo |
| --- | --- | --- | --- | --- |
| SAA-030 | P0 | BLOCKED | Clínica + registry / L | Implementar identidade hospitalar, owner, homônimo, encounter, admission, transferência, alta, revogação e contingência segundo D-01. |
| SAA-031 | P0 | BLOCKED | Lab + catálogo / M | Criar authoring e publicação de templates laboratoriais versionados, escopados e imutáveis após uso. |
| SAA-032 | P0 | BLOCKED | Lab + clínica / L | Aplicar unidades, populações, faixas, flags e criticidade aprovadas; preservar snapshot da política no resultado. |
| SAA-033 | P0 | READY | Lab + QA / M | Completar request → sample → processing → recollection → result → release no serviço, API, UI e browser, com negativas e concorrência. |
| SAA-034 | P1 | READY | Radiologia / M | Fechar lifecycle de RX, accession, encaminhamento, execução, laudo, anexo, revisão e falha com política D-02. |
| SAA-035 | P1 | READY | Ultrassom / M | Fechar agenda, recurso, reagendamento, execução, motivo de falha e resultado de US com casos positivos e negativos. |
| SAA-036 | P0 | READY | Resultados + clínica / M | Alinhar draft, release, review, amend, void, versão anterior, ownership e idempotência ao D-02 e testar todos os estados. |
| SAA-037 | P0 | BLOCKED | Notificações + clínica / L | Implementar crítico, destinatário, delivery, acknowledgement, plantão, fallback, escalonamento temporal e auditoria segundo D-03. |
| SAA-038 | P1 | BLOCKED | Operação + produto / M | Implementar SLA com calendário, pausa, timezone, overdue, prioridade e eventos de início; exemplos D-04 passam sem ambiguidade. |
| SAA-039 | P1 | VERIFY | Produto + UX / M | Consolidar Patient Workspace, Command Center, fila, busca e timeline com snapshot, partial, stale, degraded e permission denied coerentes; a fronteira de leitura auxiliar e a matriz visual estão implementadas, aguardando aceite manual. |
| SAA-040 | P1 | READY | Administração / M | Fechar catálogo, motivos, usuários, roles, delegação, reautenticação, versionamento e auditoria, com contratos e browser. |

## 6. S4 — segurança operacional e escala

| ID | Pri | Status | Dono / tamanho | Entrega verificável e aceite mínimo |
| --- | --- | --- | --- | --- |
| SAA-041 | P0 | BLOCKED | Segurança + infraestrutura / L | Integrar IdP ou boundary institucional aprovado, lifecycle de sessão, revogação, timeout, auditoria e contingência. |
| SAA-042 | P0 | BLOCKED | SRE + segurança / L | Integrar storage de homologação, scanner AV externo, secrets manager, TLS, quarantine e downloads privados; falha fechada. |
| SAA-043 | P0 | IN_PROGRESS | Plataforma / M | Boundary PostgreSQL, quota concorrente de 12 chamadas/limite 3, reset de janela e fail-fast de URL/pool inválidos têm regressão local; packet corrente ainda não prova backend aprovado, outage/recuperação operacional nem tuning hospitalar. |
| SAA-044 | P1 | VERIFY | SRE / M | Métricas bounded, correlation, readiness, logger HTTP allowlisted/redigido, SBOM e [`INCIDENT_RUNBOOKS.md`](../operations/INCIDENT_RUNBOOKS.md) estão implementados localmente; faltam thresholds/owners/roteamento, traces, dashboards e exercícios em ambiente-alvo. |
| SAA-045 | P0 | READY | SRE + realtime / L | Exercitar duas instâncias com sessão, revogação, SSE, LISTEN/NOTIFY, outbox, Last-Event-ID, cliente lento e restart. |
| SAA-046 | P0 | BLOCKED | QA + SRE / L | Fixar workload aprovado, volume, skew, concorrência e duração; medir p50/p95/p99, erros, throughput, CPU, memória e locks. |
| SAA-047 | P0 | BLOCKED | SRE + dados / L | Restaurar banco, anexos, configuração, certificados e chaves em ambiente vazio; medir RPO/RTO e validar por jornada. |
| SAA-048 | P1 | IN_PROGRESS | Segurança independente / M | Threat model, matriz known-bad, suplemento adversarial, scanner externo com allowlist/IP/URL/redirect fail-closed, realtime sem replay de `PROCESSING`/`FAILED` e SBOM CycloneDX estão registrados; continua pendente revisão independente, workshop institucional, egress/secrets/supply-chain/pentest e ambiente-alvo. |

## 7. S5 — candidato AAA verificável

| ID | Pri | Status | Dono / tamanho | Entrega verificável e aceite mínimo |
| --- | --- | --- | --- | --- |
| SAA-050 | P0 | VERIFY | QA + engenharia / L | [`coverage-report.mjs`](../../scripts/coverage-report.mjs) agrega camadas e lista 35 arquivos abaixo de limiar; o agregado da execução full corrente é 92,72/85,82/94,31 para lines/branches/functions; o threshold global 90/90/85 permanece PASS, sem exclusão nova. Falta revisar e tratar lacunas por arquivo/requisito. |
| SAA-051 | P0 | DONE | QA / M | `npm run test:mutation` em Node 22 detecta **7/7** mutações deliberadas para auth, version, migration, upload, outbox, realtime e recovery. Evidência: [`mutation-controls-node22-20260907.md`](../../.orchestrate/aaa3-execution-20260907/mutation-controls-node22-20260907.md). A limitação de ser controle local, não global/independente, permanece em SAA-017/SAA-056. |
| SAA-052 | P1 | IN_PROGRESS | UX + QA / M | Capturar golden states desktop/tablet/mobile, erro, partial, stale, loading, empty e permission denied; 20 PNGs foram revalidados no browser corrente após a correção da topbar mobile, mas densidade, golden aprovado e aceite manual ainda permanecem abertos. |
| SAA-053 | P0 | BLOCKED | UX + acessibilidade / M | Fazer revisão manual de teclado, foco, leitor de tela, touch, zoom, contraste, reduced motion e overflow em dispositivos acordados. |
| SAA-054 | P0 | READY | QA + DevOps / M | Executar CI remoto em checkout limpo com Node 22, Postgres, browser production-like, storage/scan sintéticos, artefatos e retries zero. |
| SAA-055 | P0 | READY | QA + produto / M | Reconciliar todos os MUST/AC na matriz com código, teste, comando, evidence atual, owner, limitação e revisão semântica. |
| SAA-056 | P0 | BLOCKED | QA independente / L | Empacotar revisão independente separada em segurança, dados, clínica, UX e operações; o parecer fresco está anexado, mas o veredito permanece BLOCKED até re-audit após autoridade relacional/target, operações distribuídas, aceite manual e autoridade clínica. |
| SAA-057 | P0 | READY | Release engineering / M | Congelar versão, lockfile, Node, configuração, manifest de produto, hashes, banco/schema, imagens e artefatos do candidato. |

## 8. S6 — piloto e release

| ID | Pri | Status | Dono / tamanho | Entrega verificável e aceite mínimo |
| --- | --- | --- | --- | --- |
| SAA-060 | P0 | BLOCKED | Produto + hospital / L | Elaborar plano de piloto com setores, participantes, dados sintéticos/permitidos, treinamento, suporte, janela e stop criteria. |
| SAA-061 | P0 | BLOCKED | SRE + release / L | Ensaiar incidente, rollback/roll-forward, revogação, restore e comunicação; operador diferente do autor executa o runbook. |
| SAA-062 | P0 | BLOCKED | Patrocinador + hospital / M | Registrar D-06 com autoridade, escopo, data, critérios de aprovação e expiração; ausência mantém o item bloqueado. |
| SAA-063 | P0 | BLOCKED | QA + clínica / L | Executar piloto controlado, observar tarefas e incidentes, reconciliar dados e registrar feedback, defeitos e decisão de continuar/parar. |
| SAA-064 | P0 | BLOCKED | Patrocinador + QA / M | Emitir decisão final AAA-22: release, release condicionado formalmente ou retorno ao gate; assinar limitações e monitoramento. |

## 9. Dependências e prioridade de execução

O caminho mínimo é:

SAA-001/002/003 → SAA-010/012/014/015/016/017 → SAA-020/022/023/026/027/028 → SAA-004/005/006/007 → SAA-030/031/032/033/036/037/038 → SAA-041/042/043/045/046/047 → SAA-050/051/054/055/056/057 → SAA-060/061/062/063/064.

Itens BLOCKED por decisão humana podem ser preparados, mas não fechados por código sintético. Itens READY de documentação, instrumentação, negative controls, CI e ambiente descartável devem avançar em paralelo.

## 10. Mapeamento para o legado

| Programa AAA-3 | Continuidade aproximada |
| --- | --- |
| S0 | AAA2-001 a AAA2-010 |
| S1 | AAA2-003, AAA2-004, AAA2-005, AAA2-006, AAA2-007, AAA2-008, AAA2-009, AAA2-010 |
| S2 | AAA2-011 a AAA2-020 e a fatia V2 relational sample lineage |
| S3 | AAA2-021 a AAA2-035 |
| S4 | AAA2-036 a AAA2-046 |
| S5 | AAA2-047 a AAA2-057 |
| S6 | AAA2-058 a AAA2-060 |

O mapeamento é de continuidade, não de status. Qualquer tarefa herdada precisa de evidência atual e pode ser reaberta.

## 11. Critério de encerramento do backlog

O backlog só pode ser encerrado quando todos os itens P0 estiverem DONE, os P1 necessários ao escopo aprovado estiverem DONE, os 11 critérios canônicos AAA-3 estiverem PASS, o crosswalk AAA-01 a AAA-22 estiver reconciliado, D-01 a D-06 estiverem CONFIRMED e o candidato tiver passado por piloto e decisão formal.

Enquanto houver P0 BLOCKED, FAIL, evidência STALE, risco HIGH/CRITICAL sem autoridade ou decisão humana PENDING, o programa permanece em evolução.
