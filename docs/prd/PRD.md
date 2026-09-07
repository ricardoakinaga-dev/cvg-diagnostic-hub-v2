# Product Requirements Document — CVG Diagnostics Hub

**Versão:** 0.1 documental  
**Status:** `COMPLETE — READY` com gates operacionais pendentes  
**Data:** 2026-08-18  
**Fonte:** [`../discovery/DISCOVERY.md`](../discovery/DISCOVERY.md)

**Knowledge status:** `DECISION/PROPOSAL` de produto derivada do Discovery; workflow, ownership, SLA, criticidade, retenção e identidade permanecem `ASSUMPTION`/`OPEN QUESTION` quando não validados.

## 1. Executive summary

O CVG Diagnostics Hub centraliza o fluxo diagnóstico de um hospital veterinário. Ele permite que uma equipe crie uma solicitação contextualizada ao paciente/atendimento, os setores executores trabalhem sua fila própria, resultados sejam liberados e versionados, e o profissional responsável receba, visualize e revise o que precisa de ação.

O MVP é uma aplicação operacional para Laboratório, RX e Ultrassom, apoiada por um core genérico de `DiagnosticService`. A proposta reduz pedidos esquecidos, consultas por telefone/WhatsApp, resultados sem revisão, recoletas sem dono e atraso invisível. Não substitui prontuário, ERP, financeiro, estoque ou PACS.

## 2. Vision and outcome

> Solicitar, executar, acompanhar e revisar diagnósticos deve ser tão simples e claro que a equipe prefira o Hub a mensagens, planilhas ou memória individual.

O sistema será bem-sucedido quando conseguir responder, com contexto e sem comunicação paralela, quais exames estão pendentes, qual paciente espera, o que está atrasado, quais resultados saíram, o que não foi revisado, quais recoletas existem e quais críticos aguardam confirmação.

## 3. Problem

Pedidos podem ser esquecidos; status dependem de perguntas manuais; resultados ficam espalhados; urgências não são priorizadas de forma consistente; recoletas e atrasos não têm rastreabilidade; a equipe não consegue medir turnaround e gargalos com confiança. A prevalência e o processo exatos serão medidos no piloto, conforme `OPEN QUESTIONS` e `SUCCESS_METRICS`.

## 4. Goals

- Tornar o caminho completo de cada item diagnosticamente visível.
- Reduzir esforço de solicitação e atualização frequentes.
- Fazer eventos importantes encontrarem o usuário certo.
- Preservar histórico de amostras, resultados, revisões e correções.
- Permitir workflows específicos sem acoplar o core a Laboratório/RX/US.
- Entregar base segura para um piloto controlado.

## 5. Non-goals do MVP

- financeiro, faturamento, estoque ou compras;
- prontuário veterinário completo, prescrição ou agenda clínica geral;
- CRM, portal/comunicação com tutor ou aplicativo mobile nativo;
- PACS completo, visualizador DICOM avançado ou integração direta com todos os equipamentos;
- automação de analisadores, HL7/FHIR completo ou barramento de eventos;
- BI empresarial; o MVP terá apenas indicadores operacionais essenciais;
- offline-first; perda de conexão será comunicada e recuperável, mas não haverá sincronização offline;
- plataforma genérica de feature flags ou microserviços.

## 6. Product principles

1. Fewer clicks.
2. Status must be obvious.
3. Important events find the user.
4. Audit important actions.
5. One source of truth.
6. Simple before clever.
7. Safe by default.
8. Extend without rebuilding.

## 7. Personas and journeys

Personas operacionais: [`../discovery/PERSONAS.md`](../discovery/PERSONAS.md).  
Jobs: [`../discovery/JOBS_TO_BE_DONE.md`](../discovery/JOBS_TO_BE_DONE.md).  
Jornadas: [`../discovery/USER_JOURNEYS.md`](../discovery/USER_JOURNEYS.md).

Os acceptance criteria prioritários cobrem A — Laboratório normal, B — Recoleta, C — RX, D — Ultrassom, E — Crítico, F — Atraso e G — Cancelamento.

## 8. MVP scope — MoSCoW

| Prioridade | Escopo |
| --- | --- |
| MUST | Patient/Encounter mínimo com referências externas; request multi-item; catálogo de serviços; prioridades; RBAC/escopo; filas Lab/Imagem; sample/acession e recoleta; execução e liberação; result versioning; view/review; notificações internas; SSE/realtime com fallback; busca e deep links; timeline; auditoria; anexos seguros; SLA/atrasos; dashboard acionável; migrations, seed não real e observabilidade básica. |
| SHOULD | agenda mínima de Ultrassom; filtros persistentes; painéis/favoritos; command palette; densidade compacta; métricas p95; notification acknowledgement para classes não críticas; exportação administrativa controlada. |
| COULD | QR/barcode/etiqueta; presets de exames; referências DICOM/PACS; templates estruturados avançados; integração OIDC completa se o piloto exigir. |
| WON'T NOW | WhatsApp/e-mail/push externos; tutor; app nativo; PACS/DICOM viewer; analisadores automáticos; agenda clínica geral; multi-tenant completo; BI avançado; event bus/microservices. |

## 9. Functional requirements

### Context and requests

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-CORE-001 | Criar solicitação a partir de paciente + atendimento, preenchendo actor, setor/contexto e timestamp do servidor quando conhecidos. | MUST |
| FR-REG-001 | Permitir cadastrar um paciente e seu primeiro atendimento dentro do fluxo de solicitação, preservando origem, escopo e vínculo contextual no servidor. | MUST |
| FR-CORE-002 | Permitir múltiplos `DiagnosticRequestItem` em uma mesma solicitação; cada item mantém serviço, workflow, prioridade e status próprios. | MUST |
| FR-CORE-003 | Gerar protocolo humano único, curto e buscável, separado da PK técnica. | MUST |
| FR-CORE-004 | Alertar duplicidade ativa por paciente/serviço em janela configurável e permitir override autorizado com motivo. | MUST |
| FR-CORE-005 | Preservar contexto em transferência de setor, mudança de leito e alta; não cancelar automaticamente item pendente. | MUST |
| FR-CORE-006 | Permitir cancelamento/rejeição somente em transições autorizadas, com motivo e impacto histórico. | MUST |

### Diagnostic workflows

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-LAB-001 | Laboratório deve receber amostra/acession, vincular uma amostra a itens aplicáveis e registrar recebimento/rejeição. | MUST |
| FR-LAB-002 | Laboratório deve iniciar/processar item e registrar motivo de pendência/falha quando necessário. | MUST |
| FR-LAB-003 | Solicitar recoleta exige motivo padronizado e permite observação; cada nova amostra preserva a cadeia anterior. | MUST |
| FR-IMG-001 | Serviços de imagem devem usar workflow próprio para encaminhamento, execução, laudo e liberação, sem herdar etapas laboratoriais indevidas. | MUST |
| FR-IMG-002 | Ultrassom deve suportar agendamento/reagendamento mínimo quando o catálogo indicar `requires_schedule`. | MUST |
| FR-IMG-003 | Catálogo deve permitir novos serviços por configuração de workflow, turnaround, anexos e resultado, sem alterar o core. | SHOULD |

### Results and communication

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-RESULT-001 | Criar/editar draft de resultado e liberar somente quando os requisitos do serviço forem atendidos; release é auditado. | MUST |
| FR-RESULT-002 | Resultado liberado deve ser versionado; emenda cria nova versão, registra motivo/autor/data e pode exigir nova revisão/notificação. | MUST |
| FR-RESULT-003 | Registrar separadamente liberação, visualização, revisão, confirmação de crítico e conclusão. | MUST |
| FR-RESULT-004 | Resultado crítico deve gerar notificação interna prioritária, destinatário/fallback configurado, acknowledgement e trilha de tentativas. | MUST |
| FR-NOTIF-001 | Inbox interno deve agrupar eventos informativos, acionáveis e críticos, levando ao contexto por deep link. | MUST |
| FR-NOTIF-002 | Mudanças relevantes devem atualizar telas abertas sem refresh manual, sem enviar conteúdo clínico não autorizado no canal realtime. | MUST |

### Operations and governance

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-OPS-001 | Oferecer filas por setor com filtros, prioridade, SLA, atraso, tempo de espera e próxima ação explicável. | MUST |
| FR-OPS-002 | Calcular SLA configurável por serviço/prioridade/horário e registrar `due_at`, policy version e timestamps de percurso. | MUST |
| FR-OPS-003 | Buscar globalmente por paciente, tutor conforme escopo, protocolo, item, serviço, setor, profissional e external ID. | MUST |
| FR-OPS-004 | Exibir timeline diagnóstica derivada de eventos/auditoria com filtro por request/item e contexto do paciente. | MUST |
| FR-OPS-005 | Dashboard mínimo deve priorizar atrasados, recoletas, críticos e resultados novos; volume/turnaround são secundários. | MUST |
| FR-AUD-001 | Auditar ações clínicas/admin relevantes com actor, action, entity, previous/new state, timestamp do servidor, correlation ID e metadata mínima. | MUST |
| FR-AUTH-001 | Aplicar RBAC e escopo server-side em todas as ações e recursos, incluindo anexos e busca. | MUST |
| FR-DATA-001 | Separar Patient, Encounter, Admission e ExternalReference para futura integração com sistema mestre. | MUST |
| FR-FILE-001 | Suportar anexos autorizados por versão de resultado, com allowlist, tamanho, checksum, storage key segura e estado de validação. | MUST |
| FR-ADMIN-001 | Permitir configuração autorizada de serviços, motivos, prioridades, SLAs, departamentos, usuários e roles. | SHOULD |

## 10. Non-functional requirements

| ID | Requirement / target | Priority |
| --- | --- | --- |
| NFR-SEC-001 | Sessões seguras, cookie HttpOnly/Secure/SameSite, expiração/revogação, proteção contra brute force e nenhum segredo no repo/client bundle. | MUST |
| NFR-SEC-002 | Autorização por actor + resource + action + scope; negar por padrão e não vazar existência de recursos. | MUST |
| NFR-SEC-003 | Upload deve validar extensão/MIME real/tamanho/checksum, armazenar fora do banco, usar URL temporária e exigir scan/quarantine antes de exposição em produção. | MUST |
| NFR-SEC-004 | Logs não contêm senha/token/secret ou conteúdo clínico desnecessário; auditoria clínica é imutável para usuários comuns. | MUST |
| NFR-REL-001 | Comandos clínicos preservam invariantes em transação; notificações duráveis usam outbox ou mecanismo equivalente; retries são seguros. | MUST |
| NFR-REL-002 | Falha de rede nunca mostra sucesso final sem confirmação do servidor; reconnect/fallback não perde o contexto. | MUST |
| NFR-PERF-001 | Metas iniciais propostas: p95 de leitura operacional ≤ 500 ms, comando clínico ≤ 800 ms sob carga de piloto, sem N+1 nas telas críticas. | SHOULD |
| NFR-PERF-002 | Busca por protocolo/exact ID p95 ≤ 300 ms e busca textual p95 ≤ 800 ms com dataset representativo do piloto. | SHOULD |
| NFR-UX-001 | Solicitação comum sem duplicidade em no máximo 4 ações principais; atualização frequente em uma ação contextual. | MUST |
| NFR-UX-002 | Telas críticas funcionam por teclado, têm foco/labels/contraste compatíveis com WCAG 2.2 aplicável e não dependem apenas de cor. | MUST |
| NFR-OBS-001 | Logs estruturados, correlation ID, health/readiness, métricas técnicas e de negócio suficientes para explicar falhas. | MUST |
| NFR-OPS-001 | Backup de PostgreSQL e object storage com restore drill; metas iniciais propostas RPO ≤ 15 min e RTO ≤ 4 h, sujeitas à validação. | MUST |
| NFR-API-001 | API versionada `/api/v1`, envelope e erros estáveis, paginação/cursor, idempotency e optimistic concurrency documentados. | MUST |
| NFR-MAINT-001 | Modular monolith com contratos internos, baixo acoplamento e workflow de novo serviço sem reescrever o core. | MUST |

## 11. User stories

### US-001 — Solicitar em contexto

As a veterinarian, I want to select multiple diagnostic services from the patient encounter context, so that I can request the right work without retyping known data.

### US-002 — Priorizar sem ambiguidade

As a care-team professional, I want to choose Routine/Urgent/Emergency and see a textual/iconic indicator, so that operational priority is understood without relying on color.

### US-003 — Trabalhar a fila do laboratório

As a lab technician, I want to receive a sample, start processing and release a result from the operational queue, so that I do not need parallel messages or a general-purpose form.

### US-004 — Recuperar uma amostra inválida

As a lab technician, I want to request recollection with a reason and replacement chain, so that the requesting team knows what to do and the history remains auditable.

### US-005 — Executar imagem com workflow apropriado

As an imaging professional, I want an RX/Ultrasound queue with schedule/perform/report steps, so that image work is not forced through laboratory states.

### US-006 — Encontrar resultado novo

As a care-team professional, I want an internal notification and deep link when a result is released, so that I can open the correct patient context without asking another sector.

### US-007 — Diferenciar visto de revisado

As a veterinarian, I want viewing and review to be distinct actions, so that “available” does not get mistaken for clinically acknowledged.

### US-008 — Corrigir com histórico

As an authorized result owner, I want to amend a released result as a new version with a reason, so that prior clinical history is preserved and affected professionals can be notified again.

### US-009 — Responder a crítico

As the responsible care professional, I want to acknowledge a critical-result notification, so that the hospital can prove who received it and escalate when nobody confirms.

### US-010 — Intervir em atraso

As an operations manager, I want overdue items and their SLA definition surfaced first, so that I can intervene before a pending examination is forgotten.

### US-011 — Pesquisar com segurança

As an authorized user, I want to find a request by protocol, accession or service even without the patient name, so that search does not depend on memory while still respecting scope.

### US-012 — Operar com falha de rede

As any operator, I want an explicit unknown/degraded state when the connection fails, so that I do not assume a clinical command succeeded twice or not at all.

## 12. Acceptance criteria

Os critérios são contratos de produto; o `TEST_PLAN` mapeia cada um para unit/integration/E2E/security/manual evidence.

### Core request

**AC-FR-CORE-001-01**  
Given um usuário autorizado está no contexto de um paciente/atendimento válido  
When seleciona um ou mais serviços e confirma  
Then o servidor cria uma solicitação com protocolo único, actor/contexto corretos, itens independentes e evento de auditoria.

**AC-FR-REG-001-01**
Given um veterinário autorizado não encontra o paciente no contexto atual
When cadastra o paciente e o primeiro atendimento durante a solicitação
Then o servidor cria os registros com escopo/origem auditáveis, devolve o atendimento aberto e mantém o paciente selecionado para a confirmação dos serviços.

**AC-FR-CORE-002-01**  
Given uma solicitação contém cinco serviços  
When três itens avançam e dois permanecem em processamento  
Then a UI mostra `3/5` disponíveis e cada item mantém seu status sem bloquear os demais.

**AC-FR-CORE-004-01**  
Given existe item ativo compatível para o paciente  
When o usuário tenta solicitar o mesmo serviço  
Then o sistema mostra alerta contextual; só permite continuar com permissão/justificativa quando a política exigir.

**AC-FR-CORE-006-01**  
Given um item já iniciou execução  
When um usuário sem permissão tenta cancelar  
Then a API retorna erro de autorização/estado sem mudar dados nem esconder o item.

### Laboratory and imaging

**AC-FR-LAB-001-01**  
Given uma amostra recebida pode servir a dois itens  
When o técnico registra accession  
Then ambos os vínculos ficam rastreáveis e a associação não pode apontar para outro paciente sem comando autorizado/auditoria.

**AC-FR-LAB-003-01**  
Given uma amostra foi rejeitada por motivo válido  
When o técnico solicita recoleta  
Then motivo é obrigatório, a nova amostra se vincula à anterior, os itens afetados ficam acionáveis e a equipe recebe notificação.

**AC-FR-IMG-002-01**  
Given um serviço de Ultrassom exige agenda  
When a equipe agenda e depois reage a um conflito  
Then o horário anterior permanece histórico, o novo horário é auditado e o item não finge estar executado.

### Result lifecycle

**AC-FR-RESULT-001-01**  
Given um draft válido e usuário executor autorizado  
When libera o resultado  
Then o servidor cria uma versão liberada, muda o item para disponível e persiste audit event + notificações na mesma garantia transacional.

**AC-FR-RESULT-002-01**  
Given uma versão já liberada  
When um usuário autorizado informa correção e motivo  
Then o sistema cria nova versão, mantém a anterior imutável, registra autor/data/motivo, notifica e requer nova revisão conforme policy.

**AC-FR-RESULT-003-01**  
Given um resultado liberado  
When o responsável abre e depois revisa  
Then existem registros distintos de `ResultViewed` e `ResultReviewed`; abrir sem revisar não conclui o item.

**AC-FR-RESULT-004-01**  
Given uma versão é marcada crítica sob policy aprovada  
When ela é liberada  
Then o destinatário prioritário/fallback, tentativas, acknowledgement e timestamps ficam auditáveis; ausência de confirmação cria escalonamento.

### Reliability and security

**AC-NFR-REL-001-01**  
Given uma falha após persistir o resultado mas antes da resposta  
When o cliente repete a mesma command com idempotency key  
Then não há segunda versão/evento clínico e o cliente obtém o resultado existente ou erro seguro.

**AC-NFR-SEC-002-01**  
Given um usuário conhece o ID de um resultado de outro escopo  
When chama API ou URL de anexo diretamente  
Then recebe resposta indistinguível de recurso não acessível e nenhum dado/metadata sensível é exposto.

**AC-NFR-SEC-003-01**  
Given um arquivo tem extensão permitida mas MIME real inválido ou scan pendente  
When é enviado  
Then fica em quarentena/não liberado e a UI explica a ação sem disponibilizar o conteúdo.

**AC-NFR-UX-002-01**  
Given qualquer tela de fila ou resultado  
When é usada apenas com teclado em desktop e tablet suportados  
Then foco, labels, estados loading/empty/error/partial e ação principal são identificáveis sem depender de cor.

### Acceptance coverage for remaining requirements

| ID | Given | When | Then |
| --- | --- | --- | --- |
| AC-FR-CORE-003-01 | Uma solicitação válida está sendo criada | When o servidor confirma a transação | Then o protocolo humano único é retornado e a PK técnica permanece separada/não autorizante. |
| AC-FR-CORE-005-01 | Um item está pendente e o paciente muda de leito ou recebe alta | When o contexto é atualizado | Then o histórico permanece, o novo contexto/owner é registrado e nenhum item é cancelado automaticamente. |
| AC-FR-LAB-002-01 | Um item laboratorial foi recebido | When técnico autorizado inicia/processa ou registra falha | Then o estado/timestamp/motivo são auditados e uma falha não simula resultado liberado. |
| AC-FR-IMG-001-01 | Um item pertence a Radiologia ou Ultrassom | When a equipe executa o fluxo | Then encaminhamento, execução, laudo e liberação usam etapas de imagem sem exigir sample/processamento laboratorial. |
| AC-FR-IMG-003-01 | Um administrador configura novo serviço com workflow/capabilities válidos | When o serviço é ativado | Then o catálogo o disponibiliza sem alterar código do core e a configuração tem versão/auditoria. |
| AC-FR-NOTIF-001-01 | Um evento informativo, acionável ou crítico é criado | When o destinatário abre o inbox | Then a categoria, prioridade, contexto e deep link levam ao recurso autorizado correto. |
| AC-FR-NOTIF-002-01 | Uma mudança commitada ocorre em item ou notification | When uma tela autorizada está aberta | Then ela recebe invalidação/realtime sem conteúdo clínico indevido e refaz leitura autorizada sem F5. |
| AC-FR-OPS-001-01 | Existem itens em uma fila de setor | When o usuário aplica filtros/ordenação | Then a próxima ação é explicável por prioridade/SLA/espera e a lista é paginada. |
| AC-FR-OPS-002-01 | Serviço, prioridade e policy de SLA estão configurados | When ocorre o evento de início definido | Then `sla_started_at`, `due_at`, policy version e timestamps são persistidos e atraso é derivado sem mutar estado clínico. |
| AC-FR-OPS-003-01 | O usuário não conhece o paciente | When busca protocolo, accession, serviço, setor ou profissional dentro do escopo | Then resultados autorizados são encontrados com cursor e nenhum recurso fora do escopo é enumerado. |
| AC-FR-OPS-004-01 | Há eventos auditáveis para request/item | When o usuário abre a timeline | Then os eventos aparecem em ordem estável, paginados e com contexto autorizado, sem histórico paralelo divergente. |
| AC-FR-OPS-005-01 | Há itens atrasados, recoletas ou críticos | When o gestor abre Indicadores | Then esses grupos aparecem primeiro com definição, janela, timezone, denominador e próxima ação. |
| AC-FR-AUD-001-01 | Uma ação clínica/admin muda estado ou acesso | When a transação é confirmada | Then actor, action, entity, estados anterior/novo, timestamp server-side, correlation e metadata mínima ficam append-only. |
| AC-FR-AUTH-001-01 | Um usuário tenta qualquer leitura, comando, busca ou download | When a API avalia actor/resource/action/scope | Then permite somente a combinação autorizada e aplica a mesma regra sem depender da UI. |
| AC-FR-DATA-001-01 | Um paciente/atendimento vem de sistema externo | When o Hub cria ou consulta contexto | Then Patient, Encounter, Admission e ExternalReference permanecem distintos e a origem é preservada. |
| AC-FR-FILE-001-01 | Um resultado possui anexo aprovado | When o usuário finaliza upload e abre o resultado | Then metadata/checksum/storage key/scan status ficam vinculados à versão e o download exige autorização/URL temporária. |
| AC-FR-ADMIN-001-01 | Admin/manager possui permissão de configuração | When altera serviço, motivo, prioridade, SLA, departamento, usuário ou role | Then a mudança é validada, versionada/desativada quando referenciada e auditada. |
| AC-NFR-SEC-001-01 | Uma sessão é criada, expira ou é revogada | When o cliente tenta usar cookie inválido/expirado | Then a API nega acesso, não expõe segredo e a sessão não pode ser reutilizada. |
| AC-NFR-SEC-004-01 | A aplicação registra erro ou evento clínico | When logs/auditoria são persistidos | Then secrets/conteúdo desnecessário não aparecem em logs e auditoria relevante não pode ser editada por usuário comum. |
| AC-NFR-REL-002-01 | A conexão cai durante um comando ou SSE | When a UI reconecta/repete com chave segura | Then não mostra sucesso final sem servidor, preserva contexto e sinaliza estado desconhecido/degradado. |
| AC-NFR-PERF-001-01 | O sistema recebe workload representativo de piloto | When são executadas leituras/comandos concorrentes | Then p95 e erro ficam dentro do budget aprovado e telas críticas não apresentam N+1 medido. |
| AC-NFR-PERF-002-01 | Dataset contém protocolos, homônimos, vazios e volume realista | When busca exata/textual é executada | Then p95 atende o budget aprovado com paginação e sem enumerar escopo não autorizado. |
| AC-NFR-UX-001-01 | Usuário cria uma solicitação comum sem duplicidade | When usa contexto pré-preenchido e seleção rápida | Then conclui em até quatro ações principais no protótipo validado e recebe confirmação contextual do servidor. |
| AC-NFR-OBS-001-01 | Uma request, erro, evento ou job é processado | When suporte investiga por correlation ID | Then encontra log seguro, audit event/métrica/health relacionado e consegue distinguir falha clínica de técnica. |
| AC-NFR-OPS-001-01 | Banco e object storage contêm dados sintéticos de release | When ocorre restore drill isolado | Then dados, versões/anexos e configuração recuperam dentro do RPO/RTO aprovado e o resultado é registrado. |
| AC-NFR-API-001-01 | Cliente chama endpoint de leitura ou comando | When usa contrato `/api/v1` | Then recebe envelope/paginação/erro estáveis e commands suportam idempotency + optimistic concurrency documentados. |
| AC-NFR-MAINT-001-01 | Um novo serviço diagnóstico é adicionado | When o catálogo configura workflow existente/capability | Then o core permanece intacto, módulos usam contrato explícito e o slice tem testes próprios. |

## 13. Permissions and notifications

RBAC, escopo e transições normativas estão em [`../spec/PERMISSIONS.md`](../spec/PERMISSIONS.md). Categorias e delivery estão em [`../spec/NOTIFICATIONS.md`](../spec/NOTIFICATIONS.md). A autorização é sempre aplicada no backend; a UI apenas esconde ações não permitidas como conveniência.

## 14. Dependencies

- decisão sobre sistema mestre de Patient/Encounter e external IDs;
- identidade hospitalar e gestão de contas;
- política clínica de resultado crítico, revisão e correção;
- política de amostra/accession e agenda de Ultrassom;
- storage/backup/antivírus aprovados;
- responsáveis para operar filas e responder a alertas;
- capacidade de observar o piloto e medir baseline.

## 15. Risks

Ver [`../discovery/RISKS.md`](../discovery/RISKS.md). Os riscos release-blocking são identificação errada, resultado crítico sem confirmação, autorização indevida, correção sem histórico, upload inseguro e backup não restaurável.

## 16. Metrics

Ver [`../discovery/SUCCESS_METRICS.md`](../discovery/SUCCESS_METRICS.md). Metas numéricas de UX, SLA e RPO/RTO só viram compromisso de produção após validação do piloto/TI.

## 17. Release criteria

Não liberar o piloto enquanto:

- OQ-002, OQ-003, OQ-005, OQ-012, OQ-013 e OQ-018 não tiverem owner/decisão suficiente para suas capacidades;
- todos os MUST críticos tiverem testes unitários/integration/E2E ou evidência manual justificada;
- autorização, IDOR, uploads e audit trail forem testados em ambiente isolado;
- backup e restore de banco + arquivos forem demonstrados;
- health/readiness/logs/metrics e rollback forem operáveis;
- journey Lab normal e recoleta forem validados com usuários reais;
- não houver gap crítico aberto na revisão independente.

## 18. Future scope

1. V1: core diagnostics com piloto Internação + Laboratório.
2. V1.1: refinamentos de fila, filtros, atalhos, presets e feedback.
3. V1.2: etiquetas/QR/barcode e accession mais integrado.
4. V2: integração ERP/HIS/identity/agenda.
5. V3: automação laboratorial.
6. V4: PACS/DICOM e anexos/imagem avançados.
7. V5: analytics avançado e canais externos governados.

## 19. Readiness

`PRD: READY FOR SPEC` — o escopo e os contratos de produto estão identificados. A prontidão não significa aprovação clínica; as perguntas abertas e gates de release continuam obrigatórios.
