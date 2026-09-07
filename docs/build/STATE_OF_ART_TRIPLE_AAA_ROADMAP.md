# Roadmap State of Art / Triplo AAA — CVG Diagnostics Hub

**Versão:** AAA-3  
**Data:** 07/09/2026  
**Estado:** S0 em fechamento técnico, ainda não aprovado; programa ainda NOT READY

[Plano executivo](STATE_OF_ART_TRIPLE_AAA_EXECUTIVE_PLAN.md) · [Backlog](STATE_OF_ART_TRIPLE_AAA_BACKLOG.md) · [Relatório atual](../RELATORIO_AUDITORIA_2026-09-07.md)

## 1. Regra do roadmap

O roadmap é orientado a risco e evidência, não a quantidade de funcionalidades entregues. A sequência normal é:

S0 → S1 → S2 → S3 → S4 → S5 → S6

Preparação independente de ambiente, UX, governança e documentação pode começar antes do gate anterior. Um gate só passa quando todos os seus critérios obrigatórios passam; trabalho iniciado não significa marco aceito.

## 2. Visão por horizonte

| Horizonte | Gate | Janela de referência | Resultado |
| --- | --- | ---: | --- |
| Fundação | S0 — verdade e mobilização | semanas 1–4 | baseline confiável, donos, decisões abertas e bloqueios classificados |
| Segurança | S1 — segurança e contratos | semanas 3–8 | autorização, lifecycle, API, realtime e build coerentes |
| Dados | S2 — dados e delivery | semanas 5–14 | PostgreSQL, backfill, outbox, concorrência e restore de dados provados |
| Produto | S3 — produto clínico | semanas 10–24 | jornadas Lab/RX/US/resultados/critícos/identidade aceitas |
| Operação | S4 — operação distribuída | semanas 16–29 | IdP, storage, scanner, SLO, carga, failover e restore completo |
| Candidato | S5 — candidato AAA | semanas 25–34 | artefato congelado, revisão independente e critérios AAA3-C01..AAA3-E10 |
| Release | S6 — piloto e release | semanas 32–40 | piloto, rollback, treinamento, AAA3-G11 e autorização formal |

A faixa é uma hipótese de capacidade, não um compromisso de data. Decisões humanas, aquisição de serviços e ambiente-alvo podem aumentar a duração.

## 3. Gates e critérios de saída

### S0 — Verdade e mobilização

**Objetivo:** remover ambiguidade de status e criar autoridade de execução.

Entregas:

- relatório atual, plano, roadmap e backlog publicados;
- inventário de código, docs, migrations, evidence packets e working tree;
- responsáveis e substitutos nomeados;
- decisões D-01 a D-06 abertas com prazo, autoridade e impacto;
- lista de riscos com tratamento, owner e trigger;
- reprodução dos bloqueios de autorização, build, contrato e realtime;
- ambiente descartável PostgreSQL identificado sem tocar o banco persistente.

Saída:

- números documentais reconciliados;
- nenhum PASS histórico reutilizado como atual;
- backlog S0 em READY, VERIFY, IN_PROGRESS ou BLOCKED, sempre com owner e próxima evidência explícitos;
- decisão S0 registrada por engenharia, QA e produto.

### S1 — Segurança e contratos

**Objetivo:** tornar o comportamento público seguro, coerente e determinístico.

Entregas:

- matriz actor → action → resource → condition completa;
- negativas para fila, busca, timeline, SSE, anexos, drafts, versões e administração;
- autorização por fase para cancelamento, recolhimento, revisão, void e release;
- gestor delegado consistente em lista, detalhe e mutações;
- PRD, SPEC, OpenAPI, manifest e runtime sem divergência;
- erros de realtime e fallback coerentes;
- build limpo no Node 22 declarado pelo projeto;
- E2E de tela aberta com mutação, reconnect, replay e fallback.

Saída:

- zero exposição reproduzível;
- zero bypass de privilégio;
- testes known-bad falham quando o controle é removido;
- typecheck, lint, build e regressão verde em checkout limpo.

### S2 — Dados e delivery

**Objetivo:** provar integridade e durabilidade antes de ampliar a superfície clínica.

Entregas:

- baseline de schema, volume, skew, constraints e consumidores;
- compatibilidade expand/migrate/dual-read/switch;
- migrations 001–010 aplicadas em cluster descartável;
- backfill completo do escopo aprovado com checkpoint e source-drift;
- reconciliação exata por aggregate, chave, versão e hash;
- concorrência, lock, retry, restart e replay;
- outbox com consumidor por tipo, FK, dedupe, dead-letter e recovery;
- restore do banco e verificação pela aplicação.

Saída:

- divergência zero no dataset aprovado;
- nenhum dado perdido, duplicado ou sobrescrito;
- fonte relacional ou decisão formal de transição aprovada;
- plano de cutover e roll-forward testado;
- QA de dados e SRE assinam o gate.

### S3 — Produto clínico

**Objetivo:** fechar as regras e jornadas que dependem de autoridade clínica.

Entregas:

- identidade hospitalar, ownership, homônimo, transferência e alta;
- Lab estruturado com template, unidades, faixas e recoleta;
- RX e US com estados, agendamento, reagendamento e falha;
- resultado com release, review, amend, void e histórico;
- crítico com destinatário, acknowledgement, fallback e escalonamento;
- SLA com calendário, pausa, timezone, overdue e prioridade;
- queue, search, timeline, dashboard, catálogo e administração;
- Patient Workspace com snapshot escopado e estados degradados.

Saída:

- D-01, D-02, D-03 e D-04 confirmadas;
- casos normais, negativos, concorrentes e de falha aceitos por clínica;
- todos os MUST/AC clínicos com jornada API e UI;
- nenhum status clínico inventado pela UI.

### S4 — Operação distribuída

**Objetivo:** operar com serviços reais de homologação e falhas observáveis.

Entregas:

- IdP ou boundary institucional aprovado;
- storage compatível, scanner AV, secrets e TLS de homologação;
- rate limit distribuído e falha fechada;
- duas instâncias, sessão, revogação, SSE, outbox e replay;
- workload aprovado, pico, soak e testes de recurso;
- métricas, logs, traces, alertas e runbooks exercitados;
- restore de banco, anexos, configuração e chaves;
- caos controlado para rede, worker, storage, banco e instância.

Saída:

- D-05 confirmada;
- metas p95/p99, erros, SLO, RPO e RTO aprovadas;
- alertas recebidos por operador;
- restore em ambiente vazio validado pela aplicação;
- sem HIGH/CRITICAL residual sem autoridade.

### S5 — Candidato AAA

**Objetivo:** congelar e revisar um único candidato reproduzível.

Entregas:

- versão, lockfile, Node, imagem/ambiente e manifest imutáveis;
- CI remoto com jobs de unit, integration, browser, security, performance e recovery;
- cobertura ampliada e relatório por camada;
- mutation/negative controls para autorização, concorrência, upload e release;
- revisão visual, acessibilidade manual, teclado, touch, leitor e zoom;
- revisão independente de segurança, dados, clínica e operações;
- matriz completa requisito → código → teste → comando → evidência;
- scorecard AAA por eixo.

Saída:

- critérios canônicos AAA3-C01..AAA3-E10 PASS, com o crosswalk legado reconciliado;
- cada dimensão técnica e documental ≥95 pela mesma metodologia;
- zero achado crítico ou alto aberto;
- revisão independente favorável;
- candidato passível de piloto.

### S6 — Piloto e release

**Objetivo:** demonstrar uso real controlado e capacidade de interromper com segurança.

Entregas:

- treinamento e suporte;
- termo de piloto com participantes, janela e stop criteria;
- monitoramento e reunião de incidentes;
- execução de rollback/roll-forward;
- avaliação de tarefas por usuários;
- revalidação pós-piloto;
- decisão formal de release ou retorno ao gate anterior.

Saída:

- D-06 confirmada;
- AAA3-G11 PASS;
- piloto sem bloqueio clínico ou operacional;
- autoridade formal de implantação registrada;
- plano de operação contínua ativo.

## 4. Caminho crítico

1. S0 e S1: autorização, contratos e build.
2. S2: banco descartável, reconciliação, delivery e restore.
3. S3: decisões clínicas e jornadas completas.
4. S4: serviços externos, carga, failover e recovery completo.
5. S5: candidato congelado e revisão independente.
6. S6: piloto, rollback e release.

Nenhum caminho alternativo permite pular S2 para iniciar cutover produtivo, nem pular S3 para usar dados clínicos reais.

## 5. Trilhas paralelas autorizadas

| Trilha | Pode começar | Dependência de integração |
| --- | --- | --- |
| Governança e decisões | imediatamente | não publica política sem autoridade |
| Correções de segurança | imediatamente | depende de S1 para fechamento |
| Preparação de cluster descartável | S0 | S2 |
| Inventário e desenho relacional | S0 | D-01 e S2 |
| UX research e acessibilidade | S0 | S3 e S5 |
| CI e observabilidade | S0 | S4/S5 |
| Load harness | S1 | workload aprovado em S4 |
| Runbooks e recovery | S0 | serviços e RPO/RTO em S4 |

## 6. Marcos demonstráveis

| Marco | Demonstração observável |
| --- | --- |
| M0 | O time distingue fato, hipótese, decisão, evidência atual e histórico. |
| M1 | Usuário restrito não vê outro paciente nem executa cancelamento proibido; gestor delegado vê somente seu escopo. |
| M2 | Instância A grava, instância B lê; duas corridas não duplicam resultado ou entrega. |
| M3 | Paciente atravessa request, Lab/recoleta, RX/US, resultado/revisão/emenda, crítico e alta conforme política. |
| M4 | Worker, rede, storage e banco falham com degradação visível e recuperação observável. |
| M5 | Usuários executam tarefas críticas por teclado, touch e leitor; CI reproduz o candidato exato. |
| M6 | Equipe hospitalar executa piloto, aciona suporte e interrompe conforme stop criteria. |

## 7. Regras de replanejamento

- Gate vermelho entra em REWORK com causa, owner, hipótese e próximo teste.
- Evidência de um candidato não é reaproveitada depois de mudança material.
- Bloqueio externo mantém tarefas independentes em READY, mas dependentes em BLOCKED.
- Flakiness é defeito até ser explicado; retry não transforma falha em PASS.
- Mudança de política, schema, identidade, storage ou recovery reabre os gates afetados.
- O comitê pode mudar sequência e capacidade, mas não pode relaxar critério para preservar prazo.

## 8. Critério de sucesso do roadmap

O roadmap termina somente quando S6 passa e o programa possui:

- três eixos AAA confirmados;
- 11 critérios canônicos AAA-3 passados e o crosswalk dos 22 controles legados reconciliado;
- todos os MUST/AC e decisões humanas com evidência atual;
- release, rollback, suporte, treinamento e monitoramento;
- riscos residuais aceitos pela autoridade correta.

Até então, o status é candidato em evolução, independentemente da quantidade de código ou testes.
