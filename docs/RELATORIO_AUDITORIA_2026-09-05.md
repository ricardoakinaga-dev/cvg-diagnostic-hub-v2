# Relatório de documentação e construção — CVG Diagnostics Hub V2

Data: 05/09/2026. Revisão-base: `01bb1804682b4bb503e00e41c1361dc704d2294d`, **incluindo as alterações locais ainda não commitadas**. Ambiente de execução: Node `v24.20.0`, npm `11.19.0`; o CI declara Node 22.

**Nota geral de maturidade técnica: 63/100. Qualidade documental: 77/100. Veredito: MVP local funcional em várias jornadas, com defeitos bloqueantes; não pronto para produção.**

Existe uma aplicação real: autenticação, cadastro de paciente, solicitação multi-item, laboratório, imagem, resultados versionados, anexos, notificações, gestão e uma primeira fatia V2 operacional. Entretanto, o estado avaliado não passa no build, tem falhas de autorização e comportamento, não comprova persistência relacional ativa e ainda carece de validação operacional e hospitalar.

Esta auditoria entrega avaliação e reproduções; não corrige o código do produto. O relatório anterior de 04/09 foi preservado. Seus números históricos não são usados como resultados desta execução.

## Escopo e método

O corpus inicial contém **65 arquivos: 64 Markdown, com 4.698 linhas, e um OpenAPI JSON de 627.458 bytes**. Foram percorridos discovery, PRD, SPEC, API, arquitetura, ADRs, UX, segurança, testes, operações, build, V2, glossário, decisões, rastreabilidade e relatório anterior. O JSON foi carregado integralmente, inspecionado por operações/schemas e validado com Redocly e o manifesto do runtime.

A implementação foi confrontada com esse material por leitura dos módulos, configurações, migrations, testes e execução dos comandos abaixo. Foram acrescentadas reproduções isoladas em memória para verificar lacunas que a suíte existente não detecta. Os handlers HTTP reais foram chamados com `Request`/`Response`, sessão e CSRF; essas reproduções não usam PostgreSQL nem um servidor de rede. O Playwright, separadamente, exercita o servidor Next de desenvolvimento.

Notas são julgamentos de maturidade sustentados pelas evidências, não percentuais de linhas escritas, certificações ou probabilidades de segurança. Faixas: 0–19 ausente/inicial; 20–39 rudimentar; 40–59 parcial com lacunas importantes; 60–79 substancial, mas incompleto; 80–94 forte no escopo demonstrado; 95–100 exige verificação completa e coerente.

Na síntese técnica, cada dimensão recebe cinco subnotas de mesmo peso: **C** comportamento/completude, **T** testes e evidência atual, **S** segurança/falhas, **O** operação/reprodução e **D** aderência documental. A nota da dimensão é a média dessas cinco; a geral é a média das 12 dimensões. Nas tabelas de requisitos, a nota é uma avaliação direta de aderência e evidência do requisito completo. As tabelas se sobrepõem e não devem ser somadas.

Uma falha de autorização ou integridade bloqueia o release independentemente da média. Falta de evidência de banco é classificada como não demonstrada, sem presumir que toda persistência está defeituosa. Integrações expressamente fora do MVP não reduzem a nota do MVP.

## Resultado das verificações atuais

| Verificação | Resultado | Alcance e limite |
| --- | --- | --- |
| `npm run typecheck` | **FALHOU** | Duas ocorrências de `Cannot find name 'ApiError'` em `realtime-stream.ts`, linhas 58 e 63. |
| `npm run build` | **FALHOU** | O bundler compila, mas a etapa TypeScript encerra o build com o mesmo erro. Não há build de produção aprovado nesta rodada. |
| `npm run lint` | PASSOU | ESLint sem erros reportados. Isso não substitui TypeScript. |
| `npm run test:coverage` | **FALHOU** | 324 testes em 51 arquivos: **321 passaram, 3 falharam**; 49 arquivos passaram, 2 falharam. |
| Cobertura percentual atual | **NÃO CONSOLIDADA** | A execução falhou e não imprimiu o resumo final de cobertura. Os 96,08% históricos não são resultado atual. |
| `CI=1 npm run test:e2e -- --fail-on-flaky-tests --retries=0` | **PASSOU: 45/45** | 2,4 minutos; desktop, tablet e mobile em Chromium; servidor de desenvolvimento e memória sintética. |
| Acessibilidade automatizada | PASSOU no E2E | Os 6 casos de `accessibility.spec.ts` integram os 45, além de verificações axe nas jornadas de resultado. Não executei novamente o alias separado. |
| `npm run test:postgres` | **BLOQUEADO NA PRECONDIÇÃO** | 6 testes do harness passaram; 10 testes de integração falharam antes de acessar banco, exigindo `ALLOW_POSTGRES_INTEGRATION_TESTS=true`. Não havia configuração de banco descartável utilizável; Docker/PostgreSQL não foram encontrados no PATH. |
| `npm run validate:docs` | PASSOU | 56 arquivos obrigatórios e verificações estruturais. Não significa que todos os 65 arquivos estejam semanticamente corretos. |
| `npm run validate:openapi` | PASSOU | OpenAPI 3.1 válido; **64 operações em 59 paths**, coerentes com o manifesto implementado. |
| `node scripts/validate-traceability.mjs` | **FALHOU** | Faltam as colunas separadas `code`, `command`, `evidence` e `test` na matriz. |
| `node --test scripts/validate-traceability.test.mjs` | PASSOU: 4/4 | O validador detecta ausência de evidência; a matriz real ainda não satisfaz o contrato. |
| `npm run security:scan` | PASSOU | Nenhum padrão de segredo detectado pelo scanner; não equivale a uma inspeção completa de todos os canais de exposição. |
| `npm audit --json` | PASSOU | **0 vulnerabilidades reportadas** na consulta executada. Não significa ausência de defeitos no código próprio. |
| Reproduções adicionais de handlers/domínio | **4 divergências confirmadas** | Escopo de paciente na fila, detalhe do gestor delegado, cancelamento após início e agregado misto. |
| Carga, restore, CI remoto e infraestrutura produtiva | NÃO EXECUTADOS | Nenhum resultado histórico foi promovido a evidência atual. |

O escopo de cobertura em [vitest.config.ts](../vitest.config.ts) privilegia servidor, domínio e poucos componentes. Exclui `PostgresStore`, inicialização do runtime e não inclui a maior parte da UI. Portanto, mesmo uma cobertura percentual alta não representaria todo o sistema.

As 45 execuções de navegador correspondem a 15 casos multiplicados por três projetos, não a 45 regras clínicas distintas. Os cenários cobrem cadastro/solicitação, gestão, Lab estruturado, RX/resultados/anexo/revisão/emenda/void e confirmação de crítico. Não há jornada browser específica de recoleta ou agendamento/reagendamento de US nessa suíte atual. Há mocks de leitura para layout e simulação de indisponibilidade; as mutações das jornadas clínicas principais são reais no servidor sintético.

## Pontuação por dimensão técnica

| Dimensão | C | T | S | O | D | Nota /100 | O que limita a nota |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Runtime e entrega | 80 | 70 | 75 | 30 | 60 | **63** | Desenvolvimento funciona; build e typecheck falham. Instalação limpa não foi refeita nesta auditoria. |
| API e contratos | 95 | 90 | 85 | 75 | 75 | **84** | OpenAPI forte; erros de realtime e divergências entre SPEC textual e runtime. |
| Persistência e integridade de dados | 65 | 55 | 60 | 25 | 65 | **54** | JSONB permanece autoritativo; migration 007 e adaptador não têm validação atual em banco vivo. |
| Domínio e invariantes | 80 | 85 | 55 | 65 | 65 | **70** | Lifecycle amplo; cancelamento por fase e agregado misto contradizem a especificação. |
| Identidade, autorização e escopo | 75 | 65 | 40 | 45 | 65 | **58** | Sessão/CSRF/RBAC implementados, mas há exposição de paciente na fila e inconsistência no gestor delegado. |
| Jornadas funcionais | 90 | 90 | 60 | 70 | 70 | **76** | E2E verde no recorte sintético; faltam browser PostgreSQL, recoleta/US e aceite operacional. |
| Comunicação e realtime | 55 | 55 | 65 | 35 | 45 | **51** | Erros HTTP reproduzidos, incompatibilidade de evento no cliente, fallback não demonstrado e delivery relacional incompleto. |
| Operações e observabilidade | 80 | 85 | 80 | 40 | 65 | **70** | Métricas/health existem; alertas, carga, fanout e diagnóstico distribuído não foram comprovados. |
| UX funcional e acessibilidade | 85 | 90 | 70 | 60 | 65 | **74** | Axe e jornadas passam; faltam inspeção manual, leitor de tela, usuários reais e atualização confiável. |
| Qualidade automatizada e segurança | 75 | 75 | 60 | 55 | 60 | **65** | Scan de dependências limpo; suíte, build e typecheck vermelhos e casos negativos ainda ausentes. |
| Entrega operacional e recuperação | 40 | 25 | 45 | 20 | 60 | **38** | Scripts e CI existem; restauração completa, rollback e RPO/RTO não demonstrados. |
| Rastreabilidade e gestão de mudança | 65 | 40 | 65 | 40 | 55 | **53** | Corpus amplo, mas o validador forte falha e há divergências normativas e métricas antigas. |

**Cálculo: 756 ÷ 12 = 63/100.** Essa nota não é diretamente comparável ao 78 histórico: o artefato local mudou, a evidência foi refeita e esta auditoria confirmou falhas adicionais.

## Avaliação da documentação

| Conjunto analisado | Nota /100 | Avaliação |
| --- | ---: | --- |
| Índice, glossário e decisões | **90** | Boa ordem normativa e distinção entre fato, hipótese e decisão. As fontes históricas ainda competem com a barra AAA em alguns textos. |
| Discovery e seus 11 documentos | **90** | Jornadas, personas, riscos, premissas e perguntas bem explicitados. A qualidade do texto não substitui entrevistas/observação, que continuam ausentes. |
| PRD | **86** | 28 requisitos funcionais e 14 não funcionais com critérios de aceite. Precisa reconciliar o cadastro adicional da matriz e critérios ainda não implementados. |
| SPEC e API | **68** | OpenAPI tecnicamente forte; texto diverge em IDs, protocolo, emenda, conclusão, SLA, realtime e algumas rotas de configuração. |
| Arquitetura e ADRs | **75** | Monólito real bem descrito e transição JSONB assumida. Ainda cita migrations 001–006; detalhes novos e decisões de identificadores precisam atualização. |
| UX | **78** | Telas, hierarquia, estados e acessibilidade bem especificados. Claims de realtime e cobertura de jornadas excedem a prova atual. |
| Segurança e threat model | **72** | Controles esperados claros, mas a matriz não está plenamente aplicada; baseline menciona Argon2id enquanto o runtime usa scrypt. Essa divergência, sozinha, não prova hash inseguro. |
| Plano de testes | **70** | Boa estratégia; números de 299/49 ficaram antigos e cenários planejados não devem ser confundidos com casos executáveis. |
| Operações e release | **74** | Checklists honestamente abertos e runbooks úteis. Ainda faltam resultados de exercícios e responsáveis operacionais definidos. |
| Build, barras de qualidade, V2 e rastreabilidade | **62** | Roadmap abrangente; múltiplas gerações de status e matriz sem as colunas exigidas prejudicam a decisão de pronto. |

**Média: 765 ÷ 10 = 76,5, arredondada para 77/100.** Esta é qualidade dos artefatos documentais, não maturidade hospitalar.

## Requisitos funcionais: o que está construído

As notas abaixo avaliam o requisito documentado inteiro. “Local” significa implementação e prova sintética; não implica aprovação hospitalar.

| Requisito | Item | Nota /100 | Implementado e principal lacuna |
| --- | --- | ---: | --- |
| FR-CORE-001 | Solicitação contextual | **88** | Paciente/atendimento, solicitante e horário derivados no servidor; criação pela UI comprovada. Falta contexto institucional completo. |
| FR-CORE-002 | Solicitação multi-item | **83** | Itens independentes e agrupamento reais. Agregado `REQUESTED + CANCELLED` diverge da regra normativa. |
| FR-CORE-003 | Protocolo humano | **75** | Código separado do ID e sequência no estado transacional. Data é derivada de UTC e sequência global, em vez do calendário local/sequência diária previstos. IDs usam prefixo + UUID aleatório, não UUIDv7. |
| FR-CORE-004 | Duplicidade e override | **78** | Detecta item ativo e exige motivo no override. Não há janela temporal configurável no algoritmo atual. |
| FR-CORE-005 | Transferência, leito e alta | **25** | Entidades e campos existem; faltam comandos e jornadas de transferência/alta com ownership atualizado. |
| FR-CORE-006 | Cancelamento e rejeição por fase | **40** | Motivo, versão e auditoria existem. Veterinário comum cancela item em processamento sem elevação, contrariando o aceite. |
| FR-LAB-001 | Amostra e accession | **82** | Recebimento, vínculos múltiplos e unicidade local. Falta prova relacional e expansão da matriz de escopo por serviço. |
| FR-LAB-002 | Processamento e falhas | **70** | Início de processamento implementado. Não foi localizado comando público próprio para registrar falha/recuperação com toda a semântica descrita. |
| FR-LAB-003 | Recoleta e substituição | **80** | Motivo e nova amostra encadeada existem, com testes de aplicação. Falta jornada browser dedicada e validação com laboratório. |
| FR-IMG-001 | Workflow de RX/imagem | **86** | Procedimento, execução, laudo e release próprios; jornada de RX real no browser sintético. Integração de modalidade é futura. |
| FR-IMG-002 | Agenda de ultrassom | **74** | Agenda, conflito e histórico de remarcação existem. Motivo de remarcação é opcional no código; falta E2E específico e política operacional. |
| FR-IMG-003 | Serviços configuráveis | **76** | Catálogo configura workflows existentes. Tipos de workflow continuam enum fechado; novos templates numéricos exigem definição previamente disponível. |
| FR-RESULT-001 | Draft e liberação | **88** | Editor, validação, release auditado e painel estruturado funcionam. Persistência/scan produtivos ainda não demonstrados. |
| FR-RESULT-002 | Versões e emenda | **78** | Preserva conteúdo anterior e cria nova versão. Emenda cria draft e muda item para `RESULT_VOIDED`, divergindo da descrição de emenda já liberada. |
| FR-RESULT-003 | Visto, revisado, confirmado e concluído | **78** | Registros separados e revisão da versão corrente. Revisão deixa item `REVIEWED`; conclusão requer comando adicional, ao contrário do default automático descrito na SPEC. |
| FR-RESULT-004 | Críticos e escalonamento | **40** | Flag com gate, notificação e acknowledgement demonstrados. Destinatário é o solicitante; não há resolver completo de plantão/fallback nem escalonamento temporal implementado. |
| FR-NOTIF-001 | Inbox e deep links | **80** | Lista por destinatário, categorias, paginação e confirmação reais. Cobertura dos eventos informativos e regras de entrega ainda parcial. |
| FR-NOTIF-002 | Atualização automática | **35** | Servidor SSE e callbacks locais existem. Nome do evento emitido não corresponde ao listener principal do shell; falhas de limite/adaptador e fallback ainda abertos. |
| FR-OPS-001 | Filas operacionais | **55** | Prioridade, prazo, próxima ação e drawer implementados. Falha de escopo reproduzida; lista é cortada por limite, sem cursor de continuação da fila. |
| FR-OPS-002 | SLA completo | **45** | `dueAt` usa horas por prioridade, com versão do serviço. Não implementa calendário, evento inicial variável e política de pausa completos; não foi localizado job de overdue. |
| FR-OPS-003 | Busca global | **80** | Busca por termos/protocolo, filtros, ranking e cursor implementados. Leitura e pesquisa operam sobre arrays do snapshot; desempenho representativo não medido. |
| FR-OPS-004 | Timeline diagnóstica | **76** | Histórico derivado de auditoria e endpoint com cursor. O histórico agregado do paciente retorna eventos sem paginação própria; falta revisar limites em escala. |
| FR-OPS-005 | Dashboard acionável | **82** | Atraso, recoleta, resultados e atenção por setor, com definições e denominadores. Frescor e métricas longitudinais ainda incompletos. |
| FR-AUD-001 | Auditoria | **80** | Eventos de mutação/leitura e proteção append-only no store. Falta prova atual em banco e correlação consistente em todas as leituras auditadas. |
| FR-AUTH-001 | RBAC e escopo em todos os recursos | **40** | Infraestrutura extensa, mas a fila expõe paciente fora do escopo. Gestor delegado recebe negação indevida no detalhe de item. |
| FR-DATA-001 | Separação de contexto e origem | **55** | Patient/Encounter/Admission separados. Tutor e referência externa seguem simplificados em campos; modelo normalizado ainda é migração parcial. |
| FR-FILE-001 | Anexos versionados | **85** | Upload, checksum, detecção de MIME, quarentena e download privado por versão, com browser real. Faltam serviços externos e restore conjunto. |
| FR-ADMIN-001 | Configuração e administração | **70** | Serviços, motivos, usuários, roles e delegação com reautenticação. Políticas completas de crítico/SLA e departamentos não têm todos os endpoints previstos no texto. |

Fontes principais: [request-service.ts](../src/server/application/request-service.ts), [registry-service.ts](../src/server/application/registry-service.ts), [workflow-service.ts](../src/server/application/workflow-service.ts), [result-service.ts](../src/server/application/result-service.ts), [read-service.ts](../src/server/application/read-service.ts), [management-service.ts](../src/server/application/management-service.ts), [attachment-service.ts](../src/server/application/attachment-service.ts) e [reproduções](../audit-reports/2026-09-05/probes.mjs).

## Requisitos não funcionais

| Requisito | Item | Nota /100 | Avaliação |
| --- | --- | ---: | --- |
| NFR-SEC-001 | Sessões e proteção de credenciais | **82** | Cookie opaco, hash de token, expiração, revogação, CSRF e rate limit; IdP, TLS e gestão institucional não comprovados. |
| NFR-SEC-002 | Negação por padrão e confidencialidade | **40** | Caso de fila retorna 200 com paciente que a consulta direta nega com 404. Requisito não atendido integralmente. |
| NFR-SEC-003 | Upload seguro em produção | **72** | Contratos e bloqueio de scanner/storage locais em produção existem. Antimalware e bucket externos não foram exercitados. |
| NFR-SEC-004 | Logs mínimos e auditoria imutável | **75** | Boas proteções e testes; falta revisão operacional completa e prova atual do banco/credenciais restritas. |
| NFR-REL-001 | Transações, idempotência e outbox | **60** | Repetição e leases cobertos localmente; banco vivo ausente e novo sink PostgreSQL não cobre todos os tipos da outbox. |
| NFR-REL-002 | Recuperação de rede | **45** | UI aguarda resposta e apresenta erros; SSE/cliente/fallback não satisfazem toda a especificação de recuperação. |
| NFR-PERF-001 | Latência operacional sob carga | **40** | Script de smoke existe; não foi reexecutado, não mede comandos clínicos nem banco representativo. Snapshot e lock global são riscos de escala a medir. |
| NFR-PERF-002 | Busca sob carga | **40** | Busca limitada e paginada, mas sem benchmark atual representativo ou `EXPLAIN` de consultas produtivas. |
| NFR-UX-001 | Poucas ações e contexto | **80** | Fluxo de solicitação contextual passou no browser. Limite de quatro ações ainda exige medição formal da tarefa com usuários. |
| NFR-UX-002 | Teclado e acessibilidade | **80** | Axe e casos de teclado passaram em três viewports Chromium. Não equivale a validação manual completa, Safari/Firefox ou leitor de tela. |
| NFR-OBS-001 | Logs, health, métricas e correlação | **70** | Instrumentação e métricas limitadas por labels; falta observação distribuída, alertas exercitados e health produtivo demonstrado. |
| NFR-OPS-001 | Backup e restauração | **25** | Scripts de PostgreSQL e runbook presentes. Sem restauração atual de banco + anexos + chaves ou RPO/RTO aprovados. |
| NFR-API-001 | Contrato estável e concorrência | **82** | OpenAPI e testes de contrato fortes; erros de realtime, paginação de fila e divergências textuais impedem completude. |
| NFR-MAINT-001 | Modularidade e evolução | **70** | Serviços e packages reais; ainda há dependência de estado agregado global e ciclo estático que faz falhar o gate arquitetural. |

Fontes: [segurança](../src/server/security/), [runtime PostgreSQL](../src/server/store/postgres-store.ts), [outbox](../src/server/operations/outbox.ts), [métricas](../src/server/observability/metrics.ts), [CI](../.github/workflows/ci.yml), [teste E2E](../tests/e2e/), [perf smoke](../scripts/perf-smoke.ts) e [backup/restore](operations/BACKUP_RESTORE.md).

## Fatias adicionais do V2

| Item | Nota /100 | Estado observado |
| --- | ---: | --- |
| Command Center e contexto operacional | **82** | `currentOwner`, `nextAction`, `blockedBy`, espera, prazo e escalonamento operacional vêm do servidor e têm UI/testes. Dependem das correções de autorização/frescor. |
| Central de exames e drawer | **75** | Lista, filtros, foco e ação contextual existem. Paginação completa e atualização automática ainda limitam o resultado. |
| Laboratório estruturado | **72** | Hemograma sintético com observações tipadas, unidade, validação e snapshot de faixa. Sem authoring/publicação de templates e faixas clínicas aprovadas. |
| Cadastro de paciente e atendimento inicial | **85** | Criação transacional local e acesso pelo fluxo de solicitação. `FR-REG-001` aparece na matriz, mas ainda precisa ser formalizado no PRD. |
| Patient Workspace completo | **40** | Há lista de pacientes, histórico e detalhe de solicitação. Workspace contextual com transferência/alta e ownership completo permanece futuro. |
| Organização alvo de packages/apps | **55** | `contracts`, `domain`, `ui`, `services` e `shared-state` são consumidos. `apps/web`, `apps/api`, `packages/auth` e `packages/database` ainda são destinos planejados. |
| Governança e aceite hospitalar | **15** | Perguntas, owners por área e gates estão documentados. Sem decisões assinadas e evidência de piloto no corpus. |

Financeiro, ERP completo, PACS/DICOM avançado, comunicação externa, portal do tutor e automação de equipamentos são escopo futuro explícito; sua ausência não é apresentada como defeito do MVP.

## Achados prioritários e evidências

### P0 — confidencialidade e autorização de cancelamento

**A-01 — Fila revela paciente fora do escopo.** Em uma fixture isolada, `VIEWER` do laboratório autorizado apenas para `patient-thor` recebe `patient-mel` por `GET /queues/LABORATORY/items`, com HTTP 200. A consulta direta de Mel retorna 404 `SCOPE_DENIED`. `listQueue` valida departamento, mas não filtra cada item pelo escopo do paciente antes de retornar o conteúdo. Impacto: identificação do paciente, exame, estado e contexto ficam acessíveis por uma leitura alternativa.

Evidência: [read-service.ts](../src/server/application/read-service.ts), método `listQueue`, linha 271; [public-probes.log](../audit-reports/2026-09-05/public-probes.log). Corrigir a autorização antes de ordenar/contar/paginar e adicionar casos negativos por papel, paciente e serviço na fronteira HTTP.

**A-02 — Cancelamento após início não exige elevação.** A reprodução cria solicitação, recebe amostra e inicia processamento como técnico. O veterinário então envia o comando de cancelamento com sessão, CSRF, motivo e versão válidos: HTTP 200, `IN_PROGRESS → CANCELLED`. A permissão genérica `item.cancel` não aplica a exigência adicional por fase definida em `AC-FR-CORE-006-01`. O cancelamento de solicitação também merece a mesma revisão de policy.

Evidência: [workflow-service.ts](../src/server/application/workflow-service.ts), `cancelItem`, linha 319; [public-probes.log](../audit-reports/2026-09-05/public-probes.log). Implementar a matriz de autorização por estado para ambos os comandos e testar o caso negado.

### P1 — bloqueios de build, comportamento e contrato

**A-03 — Realtime quebra o typecheck/build e duas respostas de erro.** `realtime-stream.ts` usa `ApiError` sem importação. Exceder o limite de conexões retorna 500 em vez de 429; selecionar adaptador não suportado produz `INTERNAL_ERROR` em vez do código esperado. Confirmado por TypeScript, build e dois testes de rota.

Evidência: [realtime-stream.ts](../src/server/observability/realtime-stream.ts), linhas 58/63; [build.log](../audit-reports/2026-09-05/build.log); [coverage.log](../audit-reports/2026-09-05/coverage.log).

**A-04 — Evento SSE não está conectado corretamente à UI.** Inspeção estática: o servidor emite `event: diagnostic.updated`; o shell atribui `onmessage` e registra apenas o evento nomeado `resync_required`. Não há listener para `diagnostic.updated`. Eventos SSE nomeados precisam do listener correspondente. Também não foi localizado polling periódico de fallback nas telas principais inspecionadas; `ResultView` não assina os eventos globais de atualização. Assim, o banner conectado não demonstra que a tela está atualizando.

Evidência: [realtime-stream.ts](../src/server/observability/realtime-stream.ts), `formatRealtimeEvent`; [app-shell.tsx](../src/components/app-shell.tsx), linhas 47–57; [result-view.tsx](../src/components/result-view.tsx). Confirmar a correção com dois usuários e tela aberta durante mutação, reconnect e perda de rede; a suíte E2E atual não prova esse cenário.

**A-05 — Persistência relacional ainda não é a fonte do runtime.** Há migration 007 com tabelas/FKs/checks e um adaptador de projeção. Contudo, `runtime.ts` chama `PostgresStore.create`, enquanto o caminho de projeção exige `createWithRelationalClinicalCore`. A leitura normal consulta `cvg_runtime_state`; a transação bloqueia a linha `id = 1` e regrava o snapshot. Isso limita a evidência de integridade relacional e pode serializar carga. O adaptador novo é avanço de implementação, não cutover concluído.

Evidência: [runtime.ts](../src/server/store/runtime.ts), [postgres-store.ts](../src/server/store/postgres-store.ts), [migration 007](../db/migrations/007_relational_clinical_core.sql), [adaptador relacional](../src/server/store/relational/clinical-core-adapter.ts). Faltam backfill, execução real, concorrência, reconciliação, planos de consulta e recuperação demonstrados.

**A-06 — Sink durável de outbox não fecha o fluxo geral.** O novo sink PostgreSQL exige `payload.notificationId` e escreve `notification_deliveries`, com FK para `notifications`. A outbox também contém eventos como `DiagnosticRequestCreated` e `SampleReceived` sem esse campo. O worker genérico reclama todos os eventos elegíveis. Além disso, o runtime padrão não projeta as notificações clínicas nas tabelas novas. Portanto, a mera seleção do sink não estabelece delivery durável integrado. Esta conclusão vem de inspeção de integração do código, sem alegação de execução em PostgreSQL nesta rodada.

Evidência: [outbox.ts](../src/server/operations/outbox.ts), `notificationIdFrom`, `claimNext` e `createPostgresOutboxSink`; [worker](../scripts/outbox-worker.ts). Definir consumidores por tipo de evento e demonstrar FK, commit, retry, dedupe e confirmação com banco real.

**A-07 — Gestor delegado recebe 404 ao abrir item visível.** O gestor da fixture administra laboratório, RX e US. A fila de laboratório retorna 200 e um item; o detalhe retorna 404. `getItem` compara o departamento executor apenas ao departamento próprio do gestor, ignorando a lista delegada naquele trecho.

Evidência: [request-service.ts](../src/server/application/request-service.ts), `getItem`, linha 223; [public-probes.log](../audit-reports/2026-09-05/public-probes.log).

**A-08 — Estados reais e normativos divergem.** `aggregateRequestStatus` retorna `REQUESTED` para um item solicitado e outro cancelado; a SPEC exige `IN_PROGRESS`. A emenda cria draft/`RESULT_VOIDED`, e a revisão não conclui automaticamente, embora a especificação descreva outra política padrão. A emenda preserva versões; o problema aqui é de contrato e semântica operacional, não perda de conteúdo demonstrada.

Evidência: [state-machine.ts](../src/server/domain/state-machine.ts), [result-service.ts](../src/server/application/result-service.ts), [SYSTEM_SPEC.md](spec/SYSTEM_SPEC.md), [STATE_MACHINES.md](spec/STATE_MACHINES.md), [public-probes.log](../audit-reports/2026-09-05/public-probes.log). Reconciliar as políticas aprovadas, o código, as telas e os testes.

### P2 — capacidade operacional e documentação

**A-09 — Gate arquitetural reprova um ciclo estático.** `file-store.ts` importa a implementação S3 e `s3-file-store.ts` importa o tipo `FileStore` do primeiro. O teste inclui imports de tipo no grafo. A falha é real no gate configurado, mas **não demonstra um ciclo de execução JavaScript**, porque a aresta de retorno é apenas de tipo. Extrair o contrato ou explicitar o critério do grafo sem enfraquecer a arquitetura por conveniência.

**A-10 — Fila limitada não equivale a fila paginada.** `listQueue` usa `slice(0, pageSize(...))`, sem cursor/total; a UI da Central não implementa continuação. Itens além do limite podem ficar inacessíveis nessa superfície. A ordenação também é mais simples que a sequência criticidade/overdue/prioridade/prazo/espera prevista.

**A-11 — Críticos e SLA têm lacunas de implementação além de decisões humanas.** Configuração de horas e gate de crítico são úteis, mas não substituem resolver de destinatários/plantão/fallback, deadlines de acknowledgement, escalonamento temporal e calendários de SLA. O código atual busca o solicitante e não demonstra essa cadeia completa.

**A-12 — Rastreabilidade e texto ainda não refletem o artefato.** O novo validador reprova a matriz. A documentação menciona 299 testes em 49 arquivos, enquanto esta execução coletou 324 em 51. A SPEC textual inclui `sla-policies`/`critical-result-policies` que não constam das 64 operações implementadas. O OpenAPI está alinhado ao manifesto, mas isso não fecha o contrato textual maior. IDs UUIDv7, protocolo por data local, hashing e upload direto também precisam reconciliação: o upload implementado passa pelo endpoint de conteúdo da API.

**A-13 — Recuperação e operação ainda não foram demonstradas.** Scripts de backup usam PostgreSQL; o smoke confere contagens de snapshot/auditoria/outbox. Isso não verifica recuperação de conteúdo clínico, anexos e chaves como conjunto. Não há evidência nova de restore, rollback, alertas exercitados, CI remoto ou metas de carga.

## Sequência recomendada

1. Corrigir A-01 e A-02 com regressões negativas no HTTP e revisão da matriz completa de escopo/transição. São os bloqueios de maior impacto.
2. Corrigir o build e as respostas de realtime; ligar evento SSE, atualização de resultado e fallback. Adicionar teste real com dois usuários e tela aberta.
3. Resolver o detalhe do gestor, o agregado misto, a política de emenda/conclusão e a paginação da fila.
4. Executar PostgreSQL descartável, migrations 001–007, backfill/projeção, concorrência entre instâncias, outbox por consumidor e browser contra banco. Só então pontuar persistência como demonstrada.
5. Reconciliar PRD/SPEC/OpenAPI/matriz e integrar o validador de rastreabilidade ao fluxo normal de validação/CI.
6. Medir carga representativa e executar restauração de banco + anexos + configuração necessária. Registrar incidentes, rollback, metas e responsáveis.
7. Obter decisões hospitalares sobre identidade, amostras, revisão, crítico, fallback, retenção e piloto; executar aceite manual e clínico.

Não há base para declarar `AAA-READY`, 95/100 ou aprovação hospitalar neste estado. O browser verde é uma evidência positiva importante, mas não neutraliza os defeitos confirmados nem o build reprovado.

## Pacote de evidências

- [Manifesto do artefato, com hashes por arquivo](../audit-reports/2026-09-05/artifact-manifest.json).
- [Estado do working tree observado](../audit-reports/2026-09-05/working-tree.txt).
- [Typecheck](../audit-reports/2026-09-05/typecheck.log), [build](../audit-reports/2026-09-05/build.log), [lint](../audit-reports/2026-09-05/lint.log), [Vitest](../audit-reports/2026-09-05/coverage.log) e [Playwright](../audit-reports/2026-09-05/e2e.log).
- [PostgreSQL/harness](../audit-reports/2026-09-05/postgres.log), [OpenAPI](../audit-reports/2026-09-05/openapi.log), [docs](../audit-reports/2026-09-05/docs.log), [rastreabilidade](../audit-reports/2026-09-05/trace.log) e [testes do validador](../audit-reports/2026-09-05/trace-tests.log).
- [Audit de dependências](../audit-reports/2026-09-05/deps.json), [scan de segredos](../audit-reports/2026-09-05/secrets.log) e [reprodução dos achados](../audit-reports/2026-09-05/public-probes.log).
- Comando reproduzível: `NODE_ENV=test APP_DATA_MODE=memory RATE_LIMIT_MODE=memory STORAGE_SCAN_MODE=local npx tsx audit-reports/2026-09-05/probes.mjs`.

O manifesto identifica os arquivos efetivamente presentes; um SHA de commit sozinho não identifica as alterações locais avaliadas. Os logs foram preservados no workspace; arquivos `.log` seguem a regra global de ignore do repositório e não foram adicionados ao Git. Esta auditoria não fez commit, alteração em infraestrutura externa ou uso de dados reais.
