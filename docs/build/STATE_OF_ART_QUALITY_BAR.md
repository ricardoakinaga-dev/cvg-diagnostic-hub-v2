# State of Art / AAA — barra de qualidade

> **Histórico AAA-1:** substituído para planejamento corrente pelo [programa AAA-2](AAA_2_QUALITY_BAR.md), em 05/09/2026, com base na [nova auditoria](../RELATORIO_AUDITORIA_2026-09-05.md). Conteúdo e estados abaixo preservados como registro anterior; não representam evidência atual.

**Versão:** `AAA-1`  
**Congelada em:** 04/09/2026  
**Aplicação:** evolução do artefato local até uma plataforma operacional clinicamente governável; não é certificação, selo regulatório ou aprovação hospitalar.

## Objetivo

Entregar uma plataforma de diagnósticos com comportamento verificável na fronteira pública, persistência durável, segurança fail-closed, UX acessível, operação observável, recuperação comprovada e documentação sincronizada. O escopo maior é preservado: request, registry, Lab, RX, US, resultados, anexos, notificações, realtime, Patient Workspace, migração relacional e operação produtiva.

O ponto de partida está em [`PROJECT_STATUS_REPORT.md`](../PROJECT_STATUS_REPORT.md): MVP local executável, maturidade técnica local 78/100, documentação 84/100, Laboratório estruturado condicional e produção `NOT READY`.

## Regras de aceitação

1. Código existente, nome de rota, teste ou nota de agente não prova comportamento sozinho.
2. Todo gate obrigatório precisa de evidência atual, reproduzível e ligada ao commit avaliado.
3. Uma falha de segurança, integridade, persistência ou contrato não pode ser escondida por média.
4. Testes de memória não provam PostgreSQL; fixtures sintéticas não provam política clínica.
5. Critérios locais exigem `PASS`; critérios que dependem de autoridade externa ficam `BLOCKED EXTERNAL` até haver decisão e evidência do responsável.
6. O primeiro passe de um gate determinístico deve ser limpo; retry só documenta flakiness, não apaga a falha original.
7. Cada mudança material terá teste de regressão, crítica fresca e verificação integrada.

## Critérios congelados

| ID | Dimensão | Target rejeitável | Evidência mínima | Prioridade |
| --- | --- | --- | --- | --- |
| AAA-01 | Jornadas públicas | request → execução → resultado → revisão funciona via API e UI servidas | Playwright sem mutações mockadas + API | critical |
| AAA-02 | Contrato HTTP | OpenAPI, runtime, schemas e UI têm paridade completa | Redocly, drift, AJV e casos negativos | critical |
| AAA-03 | Fronteira de entrada | tamanho, nesting, headers e schemas inválidos falham de forma segura | testes de rota e payload limite | high |
| AAA-04 | Autorização | ator, recurso, ação, departamento e ownership são verificados no servidor | matriz allow/deny multiator | critical |
| AAA-05 | Confidencialidade | draft/void/history/anexo não vazam antes da autorização de leitura | testes negativos públicos e auditoria | critical |
| AAA-06 | Identidade clínica | paciente, homônimo, encounter, admission, owner e transferência têm contexto inequívoco | política aprovada + journeys + regressão | critical |
| AAA-07 | Lifecycle | estados, versão, idempotência e concorrência mantêm invariantes sem overwrite silencioso | unit/API/PostgreSQL concorrente | critical |
| AAA-08 | Persistência | dados clínicos vivem em schema relacional com constraints e índices revisáveis | migrations, schema tests e inspeção SQL | critical |
| AAA-09 | Migração | upgrade, backfill, compatibilidade, rollback/roll-forward e cutover são reversíveis | banco representativo + restore drill | critical |
| AAA-10 | Multi-instância | mudanças de sessão, papel, escopo e dados aparecem corretamente em outra instância | duas instâncias + PostgreSQL | critical |
| AAA-11 | Delivery | outbox só conclui com ownership/lease válido e confirmação do sink | worker race, retry, dedupe, dead letter | high |
| AAA-12 | Realtime | SSE tem heartbeat, replay, resync, expiração e fallback sem virar fonte clínica paralela | reconnect, degradação e multi-instância | high |
| AAA-13 | Arquivos | MIME/checksum/quarantine/download privado e storage produtivo estão comprovados | scanner externo + storage + restore | critical |
| AAA-14 | Observabilidade | readiness, logs, métricas, correlação e alertas explicam falhas reais | injeção de falha + runbook | high |
| AAA-15 | Performance | p95/p99, throughput e erro atendem alvo em carga representativa | benchmark versionado e `EXPLAIN` | high |
| AAA-16 | UX/acessibilidade | teclado, touch, leitor de tela, contraste e estados degradados funcionam nos fluxos críticos | axe + inspeção manual + três viewports | high |
| AAA-17 | Arquitetura | dependências acíclicas, módulos coesos, seams testáveis e migração sem regressão | fitness checks + integração | medium |
| AAA-18 | Supply chain | zero vulnerabilidade crítica/alta não aceita e lockfile auditado | audit, dependabot-equivalente e revisão | critical |
| AAA-19 | Recuperação | backup de banco/anexos/chaves restaura dentro de RPO/RTO aprovados | restore destrutivo em ambiente isolado | critical |
| AAA-20 | Rastreabilidade | cada MUST/AC liga requisito → código → teste → evidência atual | matriz automatizada e revisão | high |
| AAA-21 | Governança clínica | catálogo, faixa, criticidade, destinatário, fallback e escalonamento têm decisão assinada | owner clínico + política versionada | critical |
| AAA-22 | Aceite e release | CI remoto, carga, manual UX/clínico, rollback e piloto têm evidência assinada | packet de release e owner | critical |

## Definição de pronto

`AAA-READY` exige todos os critérios locais `AAA-01` a `AAA-20` em `PASS`, nenhum achado local CRITICAL/HIGH aberto, primeiro passe determinístico limpo, crítica final independente aprovada e documentos atualizados. `AAA-21` e `AAA-22` só podem sair de `BLOCKED EXTERNAL` com autoridade clínica/hospitalar e operacional real. Até lá, o veredito máximo é `CONDITIONAL PASS` para um escopo explicitamente limitado.

