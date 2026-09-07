# Roadmap executivo AAA-2

**Data:** 05/09/2026 · **Estado:** HISTÓRICO / SUPERSEDIDO; nenhum gate AAA-2 aprovado.

> **Aviso de reconciliação (07/09/2026):** números e expressões “evidência
> corrente” abaixo pertencem ao snapshot AAA-2 de 05–06/09/2026. Eles não
> representam o candidato AAA-3 atual; consulte o [roadmap AAA-3](STATE_OF_ART_TRIPLE_AAA_ROADMAP.md).

[Plano](AAA_2_EXECUTIVE_PLAN.md) · [Backlog](AAA_2_BACKLOG.md) · [Barra](AAA_2_QUALITY_BAR.md) · [Auditoria](../RELATORIO_AUDITORIA_2026-09-05.md) · [Verificação G5 local](../../.orchestrate/evidence/aaa2-g5-final-20260905.md).

**Evidência corrente:** o working tree consolidado passa **614/614 testes em 75 arquivos**, com 92,01% statements/lines, **85,00% branches** e 94,36% functions no escopo G4 executável ampliado; OpenAPI valida 65 operações em 60 paths e a validação estrutural liga 43 requisitos/ACs a código, teste, comando e evidência. A corrida E2E atual passou 51/51 sem retry, incluindo seis cenários de acessibilidade, e o Patient Workspace recebeu implementação local, regressão de escopo, jornada responsiva, paginação, contraste auditado, refresh stale/degraded com preservação do snapshot e aprovação visual local `APPROVED_LOCAL` no packet v6 por Bernoulli; a fatia relacional de schedule/sample/backfill mantém a evidência PostgreSQL descartável anterior **9/9 focada e 30/30 completa**, com migrations 009/010 aditivas, `EXPLAIN` estrutural indexado, checkpoint/retomada, wake-up real LISTEN/NOTIFY entre dois pools e regressão da entrega de notificações. O packet browser production-like [`aaa3-browser-postgres-production-s3-20260906.md`](../../.orchestrate/evidence/aaa3-browser-postgres-production-s3-20260906.md) adiciona **51/51** sem retry nos projetos Chromium, tablet e mobile com `next start`, PostgreSQL, S3/scan sintéticos e worker outbox; o [packet G4 amplo](../../.orchestrate/evidence/aaa3-g4-broad-coverage-20260906.md) fixa denominador, comando, exit code e limitações; o packet HTTP [`aaa3-http-multi-instance-20260906.md`](../../.orchestrate/evidence/aaa3-http-multi-instance-20260906.md) adiciona **24/24** e prova localmente sessão cross-process, fanout SSE em dois processos Next e replay `Last-Event-ID` em `next start` contra o mesmo banco. A nova integração PostgreSQL de recoleta/rollback está no código, mas não foi executada nesta máquina sem cluster descartável; os 30/30 anteriores não cobrem esse arquivo. Nenhum gate está aprovado: fanout sob carga/failover, browser PostgreSQL em CI, restore/performance representativos, políticas humanas e aceite hospitalar continuam pendentes.

Atualização de evidência em 06/09/2026: o packet visual v6 fecha a matriz
local de estados/viewports e a timeline densa colapsada/expandida, com crítica
independente `APPROVED_LOCAL`; revisão manual, golden do produto, aceite alvo,
clínico e humano continuam abertos.

## Sequência de valor e risco

A sequência de aceite é G0 → G1 → G2 → G3 → G4 → G5. Preparação de ambiente, governança, UX e instrumentação pode começar antes do gate precedente. Uma frente iniciada não significa marco aceito. As dependências exatas por tarefa estão no backlog; a aprovação cumulativa dos gates acrescenta a integração entre frentes.

| Gate | Janela indicativa desde mobilização | Entrega e tarefas | Critério de saída | Evidência e responsável pelo aceite |
| --- | --- | --- | --- | --- |
| G0 — contenção e baseline confiável | Semanas 1–4 | AAA2-001–010: autorização, fase de cancelamento, build, erros HTTP, gestor, evento SSE, arquitetura, verdade documental e decisões abertas | A-01/A-02 não reproduzíveis; build/typecheck/suíte verdes; evento atualiza tela; matriz e pendências inventariadas sem falsa completude; protocolos de decisão com donos | HTTP negativo, E2E de tela aberta, logs ligados ao artefato; QA + Lead + segurança |
| G1 — núcleo durável | Semanas 2–10 | AAA2-011–020: banco vivo, migrations, backfill, fonte relacional, concorrência, delivery e browser PostgreSQL | Fonte relacional ativa comprovada; reconciliação sem divergência; versão/idempotência/audit/outbox atômicos; consumidores corretos; recuperação de cutover ensaiada | SQL, duas instâncias, corridas, interrupções e jornadas sem mock de mutação; Dados + QA |
| G2 — produto clínico completo | Semanas 8–22 | AAA2-021–035: workspace, identidade, transferência/alta, Lab, RX/US, versões, crítico/SLA, fila, busca, timeline e catálogo | Todos os FR e AC aplicáveis implementados e testados; D-01–D-04 aprovadas; fluxos normais e proibidos coerentes na API e UI | Jornadas servidas, tabelas de decisão e demonstração por setor; Produto + clínica + QA |
| G3 — operação distribuída segura | Semanas 12–29 | AAA2-036–046: IdP, rate limit, AV/storage, configuração, fanout, SLO, carga, restore e caos | Serviços reais de homologação integrados; desempenho e recuperação aprovados; alertas acionáveis; D-05 resolvida; nenhuma falha alta de segurança | Carga representativa, falhas injetadas, restore completo e revisão de ameaça; SRE + segurança + QA |
| G4 — candidato AAA verificável | Semanas 22–35 | AAA2-047–054: UX, acessibilidade, visual, testes, arquitetura, contrato, CI remoto e packet | AAA-01–AAA-21 PASS; dimensões reavaliadas ≥95; zero achado crítico/alto; CI remoto limpo; revisão manual e evidências completas | Artefato imutável, relatórios de testes/cobertura, avaliação manual e matriz; QA independente + Lead + clínica |
| G5 — aceite e piloto governado | Semanas 32–40 | AAA2-055–060: runbooks, auditoria final, treinamento, ensaio de release, piloto e decisão | D-06 aprovada; revisão independente aceita; piloto e rollback exercitados; AAA-22 PASS; autorização formal de release | Packet assinado, registros do piloto, responsáveis e decisão de implantação; patrocinador + hospital + SRE |

As janelas acima descrevem o cenário de referência de até 40 semanas e se sobrepõem apenas na execução de tarefas independentes. A faixa global preliminar é 24–40 semanas, coerente com os 261–436 dias-pessoa dimensionados no plano executivo. O limite inferior exige refinamento, menor esforço confirmado e capacidade disponível; não é obtido simplesmente comprimindo cada gate da tabela. Não usar o limite inferior como compromisso. Itens grandes precisam ser fatiados antes da execução; políticas e serviços externos têm prazo próprio e podem estender a faixa.

## Caminho crítico

1. A-01/A-02 e build resolvidos → candidato de desenvolvimento confiável.
2. Banco descartável → migrations/backfill → escrita e leitura relacionais → concorrência → browser durável.
3. Políticas D-01–D-04 aprovadas + base durável → núcleo clínico e comunicação completos.
4. Serviços D-05 + dados representativos → fanout, carga e restauração → candidato G4.
5. Candidato congelado + suporte e política D-06 → ensaio, piloto, revisão final e decisão de release.

O teste inicial de PostgreSQL (AAA2-011) começa em G0, mesmo pertencendo à frente G1. Preparação de restore (AAA2-045), levantamento de UX (AAA2-047) e CI (AAA2-053) devem ser antecipados quando suas partes independentes estiverem prontas. Seus aceites completos continuam dependentes do produto integrado.

## Marcos de demonstração

| Marco | Demonstração que a liderança deve conseguir observar |
| --- | --- |
| G0 | Um usuário restrito não recebe outro paciente na fila nem consegue cancelamento proibido; um gestor autorizado abre o detalhe; outra sessão atualiza a tela aberta |
| G1 | Uma instância grava, outra lê; duas tentativas concorrentes não duplicam resultado nem entrega; restart conserva a operação; consultas usam a fonte relacional |
| G2 | Paciente atravessa solicitação, Lab com recoleta e falha, RX/US com remarcação, resultado/revisão/emenda e alta; crítico sem resposta chega ao fallback |
| G3 | Interromper worker, rede e dependência produz degradação visível e recuperação; restaurar ambiente vazio recupera dados e conteúdo dos anexos |
| G4 | Usuário realiza tarefas críticas por teclado e dispositivo acordado; CI remoto e benchmark identificam exatamente o artefato demonstrado |
| G5 | Equipe hospitalar executa o piloto, reconhece incidentes, aciona suporte e demonstra interrupção/rollback conforme critérios aprovados |

## Replanejamento e regras de avanço

Gate vermelho mantém o estado em REWORK, com causa, responsável e próxima hipótese verificável. Uma repetição bem-sucedida não apaga flakiness; diagnosticar, corrigir e executar novo candidato. Bloqueio externo deve registrar insumo e autoridade faltantes e manter disponíveis as tarefas de preparação independentes.

Mudanças de política ou schema depois de G2 exigem análise dos testes, migração, documentação e treinamento afetados. Mudanças em segurança, migração, delivery ou recovery exigem rever os gates correspondentes. Não é necessário repetir todo teste para edição documental isolada, mas nenhuma evidência afetada pode ser reutilizada como atual.

A revisão de capacidade ocorre no fim de G0 e a revisão de previsão no fim de cada gate. O comitê pode alterar sequência de preparação ou capacidade; não pode declarar PASS sem a evidência especificada.

## Transição do roadmap anterior

W0 da AAA-1 é reaberto em G0: a auditoria-base de 05/09 tinha build e testes vermelhos, enquanto a execução corrente corrigiu o núcleo local e deixou rastreabilidade, PostgreSQL e decisões abertas. W1 passa a G1; W2 é distribuído entre G0, G2 e G3; W3/W4 passam a G2; W5 a G3; W6 a G4; W7 a G4/G5; W8 começa na preparação G0 e termina em G5. Não importar estados REVIEW/DONE anteriores como evidência atual. Os IDs antigos permanecem consultáveis no [roadmap histórico](STATE_OF_ART_ROADMAP.md) e no [backlog histórico](STATE_OF_ART_BACKLOG.md).
