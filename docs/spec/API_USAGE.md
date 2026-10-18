
## Operação do planner (BLD-HPL-023–028)

`GET/POST /hospital-tasks` e `GET/PATCH /hospital-tasks/{id}` operam tarefas gerais; criação e comandos retornam HospitalTaskView com capacidades efetivas, candidatos elegíveis e referências autorizadas. Lista retorna HospitalTaskPage dentro de `data`, com items/total/limit/nextCursor. `GET /hospital-tasks/options` fornece opções autorizadas de criação; `GET/POST /hospital-task-types` e `PATCH /hospital-task-types/{id}` conservam configuração separada de execução.

Comandos dedicados: `POST /hospital-tasks/{id}/commands` (START/COMPLETE/CANCEL), `PUT .../assignment`, `PUT .../priority`, `PUT .../dependencies` e `PUT .../context`. Escritas exigem CSRF e Idempotency-Key; alterações existentes exigem expectedVersion ou If-Match consistente. É negado enviar executor real, aprovação, phase/status ou outros campos de servidor em payload genérico. Contexto usa patientId/encounterId juntos, ambos nulos para retirar vínculo quando o tipo permitir.

`GET /hospital-tasks/{id}/history` retorna AuditEvent[] em data e cursor/limit/total em meta, sob autorização de leitura da tarefa. `GET/POST /hospital-intakes` e `POST /hospital-intakes/{id}/triage` operam recepção/decisão. `GET /planner/search?query=...&types=HOSPITAL_TASK,DIAGNOSTIC_ITEM` usa tipos CSV e o mesmo escopo dos objetos reais. As páginas de busca/intake permanecem objetos em data. Filtros explícitos incluem setor, responsável/assignedToMe, tipo, fase/estado, prioridade, paciente e período; tarefas/busca aceitam orderBy UPDATED|PRIORITY|PLANNED_START e direction ASC|DESC. Um resultado oculto por filtro permanece persistido e não justifica nova criação.

### Planos, turnos, passagens e rotinas

As listas abaixo retornam `data: {items,total,limit,nextCursor?}`, sempre filtrado antes de contar ou paginar. Comandos exigem CSRF, chave idempotente e versão da autoridade alterada; respostas de replay aplicam concessões atuais. Datas incluem offset explícito e são normalizadas como instantes UTC.

| Recurso | Operações |
| --- | --- |
| Opções elegíveis | `GET /hospital-planner/options?action=plan.create` (também `plan.update`, `shift.manage`, `handoff.offer`, `recurrence.manage`, `checklist_template.manage`) |
| Planos | `GET/POST /hospital-plans`, `GET/PATCH /hospital-plans/{id}`, `PUT /hospital-plans/{id}/links`, `POST /hospital-plans/{id}/commands` (`CLOSE`, `ARCHIVE`) |
| Turnos | `GET/POST /hospital-shifts`, `GET/PATCH /hospital-shifts/{id}`, `PUT /hospital-activities/shift` com tipo/ID da autoridade e `shiftId` anulável |
| Passagens | `GET/POST /hospital-handoffs`, `POST /hospital-handoffs/{id}/decision` (`ACCEPT`, `REJECT` com motivo) |
| Modelos | `GET/POST /hospital-checklist-templates`, `PATCH /hospital-checklist-templates/{id}`, `POST /hospital-checklist-templates/{id}/approve`, `POST /hospital-checklist-templates/{id}/retire` |
| Etapas executadas | `POST /hospital-tasks/{id}/checklist-steps` (`DONE` com evidência quando exigida, `VOID` com motivo) |
| Recorrências | `GET/POST /hospital-recurrences`, `PATCH /hospital-recurrences/{id}`, `POST /hospital-recurrences/generate` com `asOf` já ocorrido e lote de até 100 |

Filtros de tarefa e busca incluem `planId`, `shiftId` e `encounterId`; a referência do plano/turno precisa ser legível, sem ampliar acesso à atividade. A busca também aceita `HOSPITAL_PLAN`, `HOSPITAL_SHIFT`, `CHECKLIST_TEMPLATE` e `HOSPITAL_RECURRENCE` em `types`. `checklistTemplateId` opcional na criação de tarefa captura a revisão aprovada no servidor; campos de aprovação, execução e snapshot enviados pelo cliente são rejeitados.

A busca inclui onze categorias, com `HOSPITAL_DOCUMENT` e `HOSPITAL_RESOURCE` sob suas permissões nativas e `search.execute`. Metadados usam atualização como período, responsável do documento ou profissional cadastrado no recurso como responsabilidade; paciente, atendimento, plano, plantão, fase, tipo de tarefa, etiqueta e prioridade não se aplicam a essas duas categorias e não produzem correspondências. Documento arquivado exige `includeArchived=true`; recurso inativo retorna `status:INACTIVE`. Respostas contêm identificação e destino nativo, sem conteúdo de revisão ou pacientes/reservas do recurso. Autorização precede contagem e paginação.

Home, fila diagnóstica e busca reaplicam filtros salvos em uma seleção, preservando o acesso atual. Período de atividade usa início planejado ou criação, com limites inclusivos; responsabilidade diagnóstica é `assignedUserId`. A fase diagnóstica agrupa estados somente para leitura: COMPLETED, CANCELLED/REJECTED e IN_PROGRESS/AWAITING_REPORT/RESULT_AVAILABLE/REVIEWED ficam nas fases correspondentes; os demais estados ficam PENDING e conservam sua FSM nativa. Tipo de HospitalTask não corresponde a exame e é explicado. Filtro de plano revalida a autoridade nativa; indisponibilidade/revogação impede exibir itens filtrados até recuperação. Cada tela conserva seu layout próprio e informa essa compatibilidade. Configuração compartilhada não concede pacientes.

`GET /hospital-intakes/options?departmentCode=...` oferece motivos predefinidos somente para triagem atualmente autorizada. `HOSPITAL_INTAKE_REJECTION_POLICY_JSON` ausente deixa OFF; inválido deixa INVALID sem presets. Configuração institucional contém versão, data de aprovação já ocorrida, referência de aprovação, setores e motivos `{code,label}` distintos; `defaultReasonCode` opcional precisa pertencer à lista. REJECT aceita `reasonCode` e `reasonPolicyVersion` juntos, revalida a política vigente e congela motivo/aprovação no histórico. Só um padrão explicitamente configurado permite Rejeitar→Confirmar em duas interações; motivo manual permanece disponível. Nenhuma política hospitalar vem ativada por exemplo.

`POST /access-groups/{id}/preview` é leitura autenticada com CSRF, sem chave idempotente. Recebe campos propostos do PATCH e `expectedVersion`; retorna vinculados, efeitos atuais, diferenças de permissões, contagens de escopo e `impactToken`, sem pacientes ou credenciais. PATCH aceita `expectedImpactToken`; a UI exige prévia atual antes de editar, inativar ou reativar. Mudanças na proposta, versões, vínculos ou escopos invalidam o token. Compatibilidade de clientes antigos não remove versões, tetos de perfil, escopo, último administrador ou reautenticação da escrita.

### Conversa, uploads, inbox e preferências privadas

| Jornada | Contrato |
| --- | --- |
| Conversa | `GET/POST /hospital-tasks/{id}/comments`, `PATCH/DELETE /hospital-tasks/{id}/comments/{commentId}`; criação usa versão da tarefa, edição/remoção usa versão do comentário |
| Anexos | `GET /hospital-tasks/{id}/attachments`, `POST /hospital-tasks/{id}/attachments/upload-sessions` com versão da tarefa; `PUT /hospital-task-attachments/{id}/content` binário; `POST /hospital-task-attachments/{id}/finalize` com versão do anexo; `GET /hospital-task-attachments/{id}/content` após liberação |
| Inbox | `GET /work-notifications`, `POST /work-notifications/read` com IDs explícitos ou `all:true`; `read:false` somente para IDs; `POST /work-notifications/{id}/archive` com versão e `archived` |
| Preferências | `GET/PUT /work-notifications/preferences`, `GET/PUT /work-activity-preferences`; `targetId` na consulta exige `targetType` e retorna somente a referência autorizada da identidade atual |
| Rascunhos | `POST /hospital-task-drafts`, `POST /hospital-task-drafts/{id}/commands` com `PUBLISH/DISCARD` e versão da tarefa; listagem por `includeDrafts=true` |
| Arquivo | `POST /hospital-tasks/{id}/archive` com `archived` e versão; consulta explícita `includeArchived=true` |
| Lotes | `POST /hospital-tasks/batch` com `operations[]` de `ARCHIVE`, `ASSIGN`, `PRIORITY` ou `COMMAND`, cada uma com sua identidade/versão; resposta `{items,successCount,failureCount}` |
| Reações | `PUT /hospital-tasks/{id}/reactions`, `PUT /hospital-tasks/{id}/comments/{commentId}/reactions` com `code:LIKE/THANKS/QUESTION`, `active` e versão da tarefa/comentário |

Preferência inexistente inicia com `expectedVersion:0` no corpo; versões seguintes são positivas. `If-Match:0` continua inválido em toda a API. Upload recebe 1 INITIATED, passa a 2 UPLOADED e 3 FINALIZED; conflito/falha/quarentena permanece explícito. Tamanho de anexo de tarefa tem limite de 10 MiB e somente PDF/JPEG/PNG; MIME detectado divergente impede liberação mesmo que o scanner responda CLEAN.

Na caixa de trabalho, `total` conta a seleção autorizada e `unread` conta os avisos não lidos da caixa ativa, incluindo linhas ainda não carregadas. O resumo mostra ambos com seus denominadores; continuação e recarga usam os valores do servidor. Uma negativa de acesso retira os contadores anteriores. Ler, arquivar ou silenciar avisos pessoais conserva o comando próprio de aceite da passagem e de confirmação crítica.

Descrição rica em `descriptionContent` usa `HospitalDocumentContent` validado e pode ser retirada com `null` no PATCH; não se aceita HTML arbitrário. `estimatedMinutes`, `labels`, `externalReferences` HTTPS e `favoriteGroup` não alteram prazos clínicos, grants ou autoria. `label` filtra a lista autorizada antes da paginação. Todos os comandos JSON de colaboração têm CSRF e idempotência; operações em lote guardam versões por item e preservam falhas parciais.

### Indicadores e relatórios — BLD-HPL-040/041

`GET /hospital-metrics?from=...&to=...&departmentCode=...` retorna as definições e os valores; `GET /hospital-metrics/{metricCode}/rows` usa a mesma janela e política de objetos para a lista que compõe o valor. O setor é opcional; `limit/cursor` pertencem somente ao drill-down. Cursor está vinculado ao indicador, setor e intervalo exatos. Sem permissão para uma fonte, seu agregado contém `value:null` e `NOT_AUTHORIZED`; zero significa consulta autorizada sem objetos correspondentes.

As 13 definições têm versão técnica `HPL-OPERATIONAL-1`, unidade `COUNT`, janela `[from,to)` e denominador de objetos ou atividades distintas atualmente autorizadas. Essa versão exige aceite do piloto, sem declarar homologação clínica automática.

Indicadores também consulta `GET /hospital-capacity` com o período e setor aplicados, somente sob `hospital_capacity.view`. O painel usa definição técnica `HPL-CAPACITY-1`, fontes/denominadores explícitos e minutos de calendário separados de unidades de leito. Carga aberta é atual, não duração real no intervalo; estimativa total soma somente tarefas abertas autorizadas com `estimatedMinutes` explícitos quando não houver exames sem estimativa. Conjunto vazio é zero; qualquer estimativa desconhecida mantém `null`, sem apresentar soma parcial como total. Leitos sem conciliação e calendário ausente permanecem desconhecidos. A definição ainda exige aceite institucional.

| Código | Origem e instante contado |
| --- | --- |
| TASK_CREATED / TASK_COMPLETED / TASK_CANCELLED | `HospitalTask.createdAt/completedAt/cancelledAt`, respectivamente. |
| TASK_PENDING | Tarefas criadas na janela cuja fase atual é PENDING ou IN_PROGRESS. |
| DIAGNOSTIC_REQUESTED / DIAGNOSTIC_REVIEWED | `DiagnosticItem.requestedAt/reviewedAt`. Vínculos em vários planos não multiplicam o exame. |
| DIAGNOSTIC_EXECUTED | `performedAt`, ou `completedAt` do laboratório; distinto de revisão/liberação. |
| DIAGNOSTIC_PENDING / DIAGNOSTIC_OVERDUE | Exames solicitados na janela ainda fora dos estados terminais; overdue compara o prazo capturado com o instante da consulta. |
| PLAN_CREATED / PLAN_CLOSED | `HospitalPlan.createdAt/closedAt`; não encerra nem soma novamente suas atividades. |
| SHIFT_STARTED | Início planejado do plantão na janela; não atesta presença. |
| ACTIVITY_HANDED_OVER | Atividades distintas com passagem aceita na janela e alvo atualmente autorizado; se repetidas, conserva o último aceite na janela. |

Indicadores de pendência representam a coorte consultada no estado atual, sem reconstruir saldo histórico ao fim da janela. Rascunhos e descartes ficam fora das métricas; tarefas terminadas e arquivadas continuam na história operacional. Capacidade, disponibilidade desconhecida e utilização são consultadas no contrato próprio de recursos e não se convertem em contagens presumidas.

`GET/POST /hospital-reports` salva definições privadas ou compartilhadas com setor autorizado. `PATCH /hospital-reports/{id}` exige versão e autoria. `POST /hospital-report-jobs` recebe `reportId/expectedReportVersion`, retorna PENDING e congela a definição. O worker processa o job; `GET /hospital-report-jobs` e `GET /hospital-report-jobs/{id}` informam progresso. Falha exige `POST /hospital-report-jobs/{id}/retry` explícito e versionado. `GET /hospital-report-jobs/{id}/download` retorna um artefato JSON com conteúdo CSV ou JSONL, nome, MIME, quantidade atual e definição capturada; a interface o transforma em arquivo.

Geração e download revalidam autor, relatório, métrica e cada objeto. Download conserva os fatos capturados (`occurredAt/status`) mesmo após mudança de fase e limita as linhas aos alvos ainda autorizados, atualizando nomes/links do contexto atual. Não reaplica o filtro de pendência à atividade já concluída nem acrescenta objetos criados depois. Exames arquivados usam a leitura clínica nativa e as permissões atuais, sem reutilizar texto clínico guardado como autoridade. Handover exige a origem exata capturada e acesso atual à passagem e ao alvo; jobs antigos sem essa origem omitem a linha e precisam ser gerados novamente. CSV escapa células e neutraliza fórmulas, inclusive com prefixo de espaços ou controles. Jobs não expõem as linhas privadas nas listagens e não recebem retry automático sem intenção do operador.

### Instituição, módulos por setor e convites — BLD-HPL-043

`GET/PUT /hospital-institution` opera a única instituição desta instalação. O primeiro PUT exige `expectedVersion:0` no corpo; `If-Match` permanece estritamente positivo e não aceita zero. Atualizações seguintes podem usar a versão no corpo ou no header. `PUT /hospital-departments/{departmentCode}/capabilities` usa a versão da instituição e controla módulos para **novas** tarefas, planos, plantões, recorrências, assistência, documentos e reservas. Arquivar/desligar o setor não oculta nem impede conclusão/cancelamento do trabalho existente e não concede permissões ou pacientes.

`GET /hospital-user-invitations/options` oferece somente opções delegáveis; `GET/POST /hospital-user-invitations` lista/emite convites limitados a seis perfis operacionais e versão atual do grupo. O token aparece uma vez na resposta de criação e não no replay de idempotência. O cliente monta `/invite#<token>` e remove o fragmento após lê-lo, mantendo o token fora de query/path/logs do servidor. `POST /hospital-user-invitations/preview` recebe o token no corpo; `POST /hospital-user-invitations/accept` recebe token e senha escolhida pelo destinatário. Esses dois endpoints públicos têm rate limit e autenticação pelo convite, sem exigir sessão do destinatário.

Emissão, prévia e aceite conferem o emissor atual, delegação, setor, grupo e sua versão. Expiração, revogação, mudança do grupo ou retirada de autoridade invalidam o convite. Criação do usuário, associação do grupo e consumo do convite pertencem a uma transação única; aceite concorrente cria uma conta. Não há token/senha em texto na persistência, concessão automática de pacientes nem criação de ADMIN/SUPERADMIN por convite.

### Evento HIS v4 — BLD-HPL-042

O ingresso dedicado recebe o corpo JSON original, assinado por HMAC v2, conforme [capacidades externas](../operations/HOSPITAL_EXTERNAL_CAPABILITIES.md). O evento `encounter.created` pode incluir `data._meta` emitido pelo EventBus: versão `1`, campos técnicos conhecidos, conta coerente e identificadores limitados a 255 pontos de código Unicode. O OpenAPI representa esse limite com `minLength/maxLength` e um padrão de conteúdo não vazio, preservando caracteres suplementares. A metadata não concede autoridade; credencial, ator e vínculos de paciente/atendimento continuam sendo revalidados pelo comando nativo. O recibo confirma recebimento para triagem e não execução clínica.
