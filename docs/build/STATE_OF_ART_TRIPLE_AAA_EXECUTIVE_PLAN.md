# Programa State of Art / Triplo AAA — Plano Executivo

**Versão:** AAA-3  
**Data:** 07/09/2026  
**Estado:** PROPOSTA EXECUTIVA / NÃO PRONTO  
**Autoridade:** patrocinador, produto, engenharia, clínica, segurança, privacidade e SRE

Documentos relacionados:

- [Relatório de auditoria de 07/09/2026](../RELATORIO_AUDITORIA_2026-09-07.md)
- [Roadmap State of Art / Triplo AAA](STATE_OF_ART_TRIPLE_AAA_ROADMAP.md)
- [Backlog State of Art / Triplo AAA](STATE_OF_ART_TRIPLE_AAA_BACKLOG.md)
- [Barra AAA-2 existente](AAA_2_QUALITY_BAR.md)
- [Registro de decisões AAA-2](AAA_2_DECISION_REGISTER.md)
- [Matriz de rastreabilidade](../TRACEABILITY_MATRIX.md)

## 1. Decisão executiva

Construir e homologar uma plataforma de diagnóstico veterinário segura, rastreável e operável em ambiente hospitalar, preservando o monólito modular enquanto ele continuar sendo a menor arquitetura coerente.

State of Art / Triplo AAA é o nome interno do programa de qualidade. Não é certificação externa, não promete perfeição absoluta e não permite converter uma média alta em autorização de uso clínico.

O investimento segue esta ordem:

1. eliminar exposição de autorização, inconsistência contratual e risco de dados;
2. tornar a persistência clínica durável, reconciliável e recuperável;
3. completar as jornadas de Lab, RX, US, resultados, notificações e identidade;
4. provar segurança, desempenho, observabilidade e recuperação em ambiente representativo;
5. obter avaliação independente, aceite clínico, piloto governado e decisão formal de release.

## 2. Definição do Triplo AAA

O programa só pode ser considerado AAA-READY quando os três eixos passarem simultaneamente:

| Eixo | Significado | Resultado obrigatório |
| --- | --- | --- |
| AAA-C — Acurácia clínica e segurança | O sistema preserva paciente, contexto, amostra, resultado, permissão e próxima ação correta | Todos os MUST/AC clínicos, estados, políticas e negativas passam; decisões D-01 a D-04 confirmadas |
| AAA-E — Engineering Assurance | Código, contratos, dados, migrações, dependências, testes e rastreabilidade são verificáveis | 22 critérios AAA passados, cobertura mínima mantida, zero crítico/alto e evidência atual |
| AAA-O — Availability, operação e adoção | O serviço pode ser executado, observado, restaurado, suportado e usado por equipes reais | SLO/RPO/RTO, carga, failover, restore, treinamento, piloto e decisão D-05/D-06 confirmados |

Cada eixo recebe uma avaliação separada. A média é apenas indicador executivo; uma falha obrigatória mantém o programa bloqueado.

## 3. Estado atual confirmado

O [relatório atual](../RELATORIO_AUDITORIA_2026-09-07.md) registra a baseline final local deste ciclo:

- maturidade técnica local 87/100;
- prontidão produtiva/clínica 45/100;
- 725/725 testes em 86 arquivos;
- cobertura de 92,72% statements/lines, 85,82% branches e 94,31% functions na execução full corrente; o relatório por camada mantém threshold global 90/90/85 e lista 35 arquivos abaixo de algum limiar por arquivo;
- build, typecheck, lint, OpenAPI 65/60, migrations 001–010, secret scan, audit de produção, recovery 5/5 e performance 7/7 aprovados;
- browser 60/60 na matriz completa (fluxo principal, ciclo clínico, acessibilidade 12/12 e realtime) em Chromium/tablet/mobile, sem retry; o rerun final após a correção de contraste está em [`browser-e2e-node22-accessibility-20260907.md`](../../.orchestrate/aaa3-execution-20260907/browser-e2e-node22-accessibility-20260907.md);
- PostgreSQL descartável anterior 39/39 em 6 arquivos, incluindo o upgrade SAA-022 001→010 e a retomada com `009` já aplicado; a repetição desta rodada aguarda host com cluster descartável e não tocou 5432;
- lane local production-like 51/51 sem retry com `next start`, PostgreSQL, S3/scanner sintéticos e outbox durável; restore smoke PostgreSQL-only aprovado com checksum e banco restaurado isolado;
- JSONB ainda como autoridade clínica;
- logger HTTP estruturado redigido, SBOM CycloneDX/CI e runbooks de incidente implementados localmente;
- decisões clínicas, identidade, infraestrutura produtiva, restore, carga representativa, CI remoto e aceite hospitalar abertos;
- revisão independente fresca com veredito BLOCKED, registrada no manifesto AAA-3.

Esses resultados comprovam um candidato local forte, mas nenhum deles marca AAA-READY.

## 4. Resultado contratado

Ao final do programa, o hospital deverá conseguir:

- identificar inequivocamente paciente, tutor, atendimento, internação, solicitação, item, amostra e resultado;
- executar solicitações de Lab, RX e US sem transições implícitas ou perda silenciosa;
- ver somente dados e ações autorizados para o papel, setor e contexto;
- receber resultados liberados com versão, revisão, emenda, void e auditoria completos;
- receber e confirmar alertas críticos conforme política aprovada, com fallback e escalonamento;
- continuar com comportamento seguro durante timeout, reconnect, restart, atraso de worker e falha de storage;
- restaurar o serviço e os conteúdos necessários em RPO/RTO aprovado;
- operar com métricas, logs, correlação, alertas, runbooks e donos de incidentes;
- realizar as tarefas críticas com teclado, touch, leitor de tela e estados degradados;
- interromper ou reverter o piloto segundo autoridade e critérios previamente aprovados.

## 5. Objetivos e indicadores

| Objetivo | Indicador de aceite | Condição de sucesso |
| --- | --- | --- |
| O1 — Segurança sem vazamento | Matriz allow/deny por ator, recurso, fase, setor, paciente e instância | 100% dos casos obrigatórios passam; zero IDOR/privilege bypass |
| O2 — Dados confiáveis | Reconciliação source/target, constraints, concorrência, retry, restart e restore | Divergência zero no dataset aprovado; cutover reversível ou roll-forward aprovado |
| O3 — Jornada clínica completa | Lab, recoleta, RX, US, resultado, revisão, crítico, transferência e alta | Todos os MUST/AC e decisões D-01–D-04 aceitos |
| O4 — Comunicação tempestiva | Delivery, acknowledgement, fallback, replay e tela aberta | Métrica de commit até atualização dentro da meta aprovada |
| O5 — Operação sustentável | SLO, alertas, carga, failover, backup, restore e runbooks | Exercícios executados por operadores diferentes dos autores |
| O6 — Experiência segura | Tarefas críticas, teclado, touch, leitor, zoom, estados parciais e stale | Avaliação manual e clínica aprovada; nenhum erro crítico aberto |
| O7 — Release governado | Candidato imutável, CI, revisão independente, treinamento e piloto | D-05/D-06 confirmadas e autorização formal de release |

Metas iniciais de engenharia, sujeitas a aprovação em D-05:

- cobertura mínima: 90% statements/lines/functions e 85% branches no escopo executável;
- leituras operacionais: p95 até 500 ms e p99 até 1.000 ms;
- comandos clínicos: p95 até 800 ms e p99 até 1.500 ms;
- busca exata/textual: p95 até 300/800 ms e p99 até 600/1.600 ms;
- realtime: p95 até 2 s e p99 até 5 s entre commit e atualização visível;
- erros inesperados sob carga: até 0,1%, sem perda, duplicidade ou autorização indevida;
- RPO até 15 minutos e RTO até 4 horas, somente após aprovação institucional.

## 6. Quality Bar e gates

Os critérios AAA-01 a AAA-22 da barra existente permanecem uma referência histórica de continuidade, não a nomenclatura canônica do gate atual. O programa AAA-3 usa os critérios `AAA3-C01` a `AAA3-G11` do [quality bar congelado](../../.orchestrate/aaa3-execution-20260907/quality-bar.json); o próprio arquivo mantém o crosswalk explícito entre os 22 controles legados e os 11 controles canônicos.

| Gate | Propósito | Saída necessária |
| --- | --- | --- |
| S0 — Verdade e mobilização | Congelar baseline, escopo, donos, riscos e decisões | Evidência atual reconciliada; responsáveis nomeados; nenhum status histórico tratado como PASS |
| S1 — Segurança e contratos | Remover falhas de autorização, lifecycle, API, realtime e build | Negativas públicas, contratos e telas corrigidos; regressão verde |
| S2 — Dados e delivery | Provar PostgreSQL, outbox, backfill, concorrência e recovery de dados | Banco descartável aprovado, reconciliação sem divergência, restore de dados exercitado |
| S3 — Produto clínico | Completar identidade, Lab, RX, US, resultados, crítico, SLA e operações | D-01 a D-04 confirmadas; jornadas reais de aceite aprovadas |
| S4 — Operação distribuída | Integrar IdP, storage, scanner, rate limit, métricas, carga, failover e restore | D-05 confirmada; SLO/RPO/RTO e runbooks demonstrados |
| S5 — Candidato AAA | Congelar artefato, executar regressão completa e revisão independente | AAA3-C01..AAA3-E10 PASS; dimensões ≥95; zero achado alto/crítico |
| S6 — Piloto e release | Treinar, pilotar, observar e decidir | D-06 confirmada; AAA3-G11 PASS; rollback e autoridade de release registrados |

Regras:

- um critério obrigatório FAIL, BLOCKED ou NOT EVALUATED impede o avanço;
- evidência antiga fica STALE quando código, configuração, schema, política ou ambiente muda;
- teste sintético não substitui banco, serviço, operador, workload ou paciente de aceite;
- aprovação de código não é aprovação clínica;
- nenhuma exceção reduz denominador, remove teste, oculta falha ou transforma UNKNOWN em PASS.

## 7. Governança e papéis

| Papel | Responsabilidade |
| --- | --- |
| Patrocinador | escopo, orçamento, capacidade e autorização final |
| Dono do produto | PRD, prioridades, métricas, trade-offs e comunicação |
| Lead de engenharia | arquitetura, integração, sequência e qualidade técnica |
| Engenharia de aplicação | domínio, API, UI, segurança e testes |
| Engenharia de dados/plataforma | PostgreSQL, migrations, storage, outbox, identidade e concorrência |
| QA independente | critérios, regressão, crítica adversarial e recomendação de aceite |
| SRE | CI, observabilidade, carga, incidentes, backup, restore e rollback |
| UX/acessibilidade | design system, avaliação manual, pesquisa e jornada |
| Responsável clínico/Lab/RX/US | políticas, estados, faixas, criticidade, revisão e homologação |
| Privacidade/segurança | identidade, retenção, residência, incidentes e ameaças |

Cada papel precisa de titular e substituto. A ausência de nome não é aprovação implícita.

## 8. Decisões humanas obrigatórias

As seis decisões abaixo devem ser registradas com responsável, versão, data, alternativa rejeitada, impacto e vigência:

- D-01: identidade institucional, ownership, homônimos, transferência e alta;
- D-02: estados de resultado, emenda, revisão, falha, void e US;
- D-03: templates, unidades, faixas, criticidade, plantão, fallback e acknowledgement;
- D-04: SLA, pausas, calendário, prioridade, duplicidade e timezone;
- D-05: retenção, residência, IdP, scanner, storage, segredos, SLO, RPO e RTO;
- D-06: escopo, participantes, treinamento, suporte, stop criteria e rollback do piloto.

Preparação técnica pode continuar com dados sintéticos. Publicação de política, cutover, uso de dados reais e piloto ficam bloqueados até a autoridade correspondente.

## 9. Modelo de execução

O trabalho seguirá ciclos:

1. definir critério e cenário conhecido-bad;
2. implementar uma fatia vertical;
3. executar no boundary público;
4. inspecionar persistência, logs, métricas e render;
5. fazer revisão separada do autor;
6. corrigir o maior gap;
7. repetir regressão e atualizar rastreabilidade;
8. solicitar decisão do gate.

Cada item do backlog deve apontar para problema, requisito/AC, código/configuração, teste, comando, evidência, risco e próximo passo. A matriz existente continua sendo a ponte entre PRD, SPEC, execução e evidência.

## 10. Capacidade e investimento

Planejamento de referência: 28–40 semanas, com três engenheiros dedicados, QA dedicado, SRE e UX parciais e disponibilidade semanal de representantes clínicos. A estimativa não é compromisso de prazo.

| Frente | Estimativa inicial |
| --- | ---: |
| S0 — mobilização e baseline | 3–5 semanas |
| S1 — segurança e contratos | 3–6 semanas |
| S2 — dados e delivery | 6–10 semanas |
| S3 — produto clínico | 8–14 semanas |
| S4 — operação distribuída | 6–10 semanas |
| S5 — candidato AAA | 4–7 semanas |
| S6 — piloto e release | 4–8 semanas |

As frentes podem se sobrepor somente quando os limites e critérios de integração estiverem estáveis. Qualquer mudança de escopo exige análise de impacto e decisão do patrocinador.

## 11. Riscos que mantêm o programa em bloqueio

| Risco | Tratamento obrigatório |
| --- | --- |
| Vazamento cross-patient ou ação fora de fase | matriz negativa completa, testes HTTP, duas instâncias e revisão independente |
| Perda ou divergência no cutover | expand/migrate/dual-read/reconcile/switch/verify, checkpoint, restore e plano de roll-forward |
| Crítico sem destinatário ou fallback | política D-03, delivery durável, acknowledgement, escalonamento e exercício fora do expediente |
| Restore incompleto | ambiente vazio, banco, anexos, chaves, configuração, verificação pela aplicação e tempos medidos |
| Falsa aprovação por teste sintético | classificar evidência por nível e bloquear gates externos sem ambiente representativo |
| Decisão humana ausente | registrar autoridade PENDING e manter trabalho dependente BLOCKED |

## 12. Próxima ação autorizada

Executar S0:

1. publicar este plano, roadmap e backlog como fontes atuais de planejamento;
2. confirmar titular e substituto de cada papel;
3. congelar o inventário atual e corrigir os contadores documentais;
4. reproduzir e fechar as últimas falhas de autorização, build, contrato e realtime;
5. abrir as decisões D-01 a D-06 com data e autoridade;
6. manter a evidência PostgreSQL descartável corrente e preparar a etapa seguinte de backfill/cutover somente após autoridade D-01/D-05;
7. convocar a revisão de saída S0.

S0 não autoriza cutover, dados reais, piloto ou release. O primeiro resultado esperado é uma decisão de gate com evidência e limitações explícitas.

## 13. Definition of Done do programa

O programa só encerra quando:

- AAA-3 C/E/O/G está PASS;
- os 11 critérios canônicos estão PASS e AAA-01 a AAA-22 estão reconciliados pelo crosswalk;
- cada MUST/AC tem evidência atual e revisão semântica;
- todas as migrations, cutover, recovery e compatibilidade estão aprovados;
- zero achado crítico ou alto permanece aberto;
- D-01 a D-06 estão confirmadas;
- revisão independente, acessibilidade manual, validação clínica, piloto e decisão de release estão registrados;
- o candidato é imutável, reproduzível e tem rollback operacional;
- riscos residuais possuem autoridade e gatilho de reavaliação.

Até lá, o estado correto é **CANDIDATO TÉCNICO EM EVOLUÇÃO**, nunca AAA-READY.
