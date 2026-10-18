# Permissions and authorization

**Knowledge status:** `DECISION/PROPOSAL` de RBAC; a autorização real do hospital é `OPEN QUESTION` até aprovação de OQ-001/OQ-002/OQ-017.

## 1. Model

Authorization is evaluated server-side as:

```text
can(actor, action, resource, scope, current_state, policy_version)
```

Authentication alone never grants access. Scope is the intersection of role assignment, department/service responsibility, patient/encounter care relationship and explicit manager permissions. Deny by default; the UI may hide unavailable actions but the API must enforce them again. In the local boundary, `ADMIN` is a technical/configuration role: it has no clinical command permissions and cannot enter patient scope. A future break-glass path must be separately approved, time-limited, reasoned and audited.

## 1.1 Canonical permission identifiers

The following identifiers are the authorization contract used by the API specification and the traceability matrix. The role table below grants these permissions only within the actor's scope and current-state policy; an identifier is not a blanket entitlement.

| Permission ID | Action represented | Typical scope |
| --- | --- | --- |
| `patient.view` | View patient and identity context | CARE/assigned |
| `patient.create` | Register patient and open the initial encounter | VETERINARIAN/INPATIENT scope |
| `encounter.view` | View encounter | CARE/assigned |
| `encounter.manage` | Open a new encounter for a registered patient and close an open one | VETERINARIAN/INPATIENT scope; MANAGER within delegated departments |
| `admission.view` | View admission/ward context | WARD/CARE |
| `request.create` | Create diagnostic request | CARE/department |
| `request.list` | List diagnostic requests | DEPARTMENT/CARE |
| `request.view` | View request details | CARE/DEPARTMENT |
| `request.duplicate_override` | Override duplicate warning | manager/policy |
| `request.cancel` | Cancel request before or during eligible phase | requester/manager/policy |
| `item.view` | View diagnostic item and state, and read its sample label | CARE/DEPARTMENT |
| `item.cancel` | Cancel one eligible item | requester/manager/policy |
| `item.reject` | Reject an item/sample in executor workflow | SERVICE/manager |
| `sample.receive` | Receive/accession a sample | SERVICE=LAB |
| `sample.process` | Start or advance laboratory processing | SERVICE=LAB |
| `sample.recollection.request` | Request recollection | SERVICE=LAB/manager |
| `sample.replacement.receive` | Receive replacement sample | SERVICE=LAB |
| `procedure.schedule` | Schedule imaging procedure | SERVICE=RX/US |
| `procedure.reschedule` | Reschedule imaging procedure | SERVICE=RX/US/manager |
| `procedure.start` | Start imaging procedure | SERVICE=RX/US |
| `procedure.mark_performed` | Record performed imaging procedure | SERVICE=RX/US |
| `result.draft.create` | Create a result draft | SERVICE |
| `result.draft.edit_own` | Edit own unreleased draft | SERVICE/own draft |
| `result.release` | Release a result/report | SERVICE/policy |
| `result.amend` | Amend a released result | SERVICE/manager policy |
| `result.void` | Void a released result | SERVICE/manager policy |
| `result.view` | View current result/report | CARE/SERVICE |
| `result.history.view` | View historical result versions | CARE/SERVICE/manager |
| `result.view.record` | Record that a result version was viewed | authenticated scoped actor |
| `result.review` | Review a result version | CARE/policy |
| `item.complete` | Manually complete an item | manager/policy |
| `attachment.view` | View attachment metadata/content reference | result scope |
| `attachment.upload_session` | Create an attachment upload session | own result/SERVICE |
| `attachment.finalize` | Finalize and scan an attachment | own result/SERVICE |
| `attachment.download` | Download attachment content | CARE/SERVICE/manager |
| `notification.view` | View recipient notifications | recipient |
| `notification.acknowledge` | Acknowledge eligible notification | recipient/manager |
| `service.catalog.view` | View diagnostic service catalog | authenticated operational scope |
| `service.catalog.manage` | Create/update/deactivate service | admin/manager policy |
| `sla_policy.manage` | Manage SLA policies | admin/manager policy |
| `critical_result_policy.manage` | Manage critical-result policies | admin/manager policy |
| `reason_code.manage` | Manage reason codes | admin/manager policy |
| `user_role.manage` | Provision, update and deactivate operational users/roles | admin or delegated manager target scope |
| `patient.data_export` | Export a patient's records for the data subject (LGPD, PROD-502, D-048) | ADMIN only, after a recent reauthentication; every export audited (`PatientDataExported`); the only patient read an ADMIN has |
| `queue.view` | View operational queue | DEPARTMENT |
| `dashboard.view` | View operational indicators | DEPARTMENT/manager |
| `diagnostic.timeline.view` | View patient diagnostic timeline | CARE/assigned |
| `timeline.view` | View request/item event timeline | scoped resource |
| `audit.view` | View audit events | manager/admin/scoped |
| `search.execute` | Search authorized resources | actor's scope |
| `health.liveness` | Read liveness status | platform/internal policy |
| `health.readiness` | Read readiness status | platform/internal policy |
| `realtime.connect` | Subscribe to scoped realtime events | authenticated session/scope |

## 2. Initial roles

| Role | Default responsibility | Default scope |
| --- | --- | --- |
| `ADMIN` | identity and system configuration | technical; no clinical command or patient scope locally |
| `MANAGER` | operational queues, overrides, delegated configuration and collaborator access | own department plus explicitly managed diagnostic departments; request/item access is department-scoped; an `ADMIN` provisions the delegated department set |
| `VETERINARIAN` | register patient, request, view and review for care scope | assigned patients/encounters/departments |
| `INPATIENT_TEAM` | register patient, request/view/review for admitted patients | assigned ward/department |
| `LAB_TECH` | receive/process/recollect/release lab work | Laboratory |
| `RADIOLOGY_TEAM` | schedule/perform/release RX work | Radiology |
| `ULTRASOUND_TEAM` | schedule/perform/release US work | Ultrasonography |
| `VIEWER` | read-only operational access | explicitly assigned scope |

Roles are configurable and must be mapped to named permissions. A role cannot be inferred from a department label in the client.

## 3. Action matrix

Legend: `✓` allowed within scope and state; `△` allowed only with extra condition/manager policy; `—` denied.

| Action | ADMIN | MANAGER | VET | INPATIENT | LAB | RADIOLOGY | ULTRASOUND | VIEWER |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Search authorized resources | — (break-glass only) | ✓ assigned scope | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Register patient + initial encounter | — | — | ✓ | ✓ | — | — | — | — |
| Open / close encounter (`encounter.manage`) | — | △ delegated scope | ✓ | ✓ | — | — | — | — |
| Create diagnostic request | — (break-glass only) | △ | ✓ | ✓ | △ | △ | △ | — |
| Override duplicate warning | △ | ✓ | △ reason | △ reason | △ | △ | △ | — |
| View request/item | — (break-glass only) | ✓ assigned department | ✓ care | ✓ ward | ✓ lab | ✓ imaging | ✓ imaging | ✓ assigned |
| Receive lab sample | — | △ | — | — | ✓ | — | — |
| Start lab processing | — | △ | — | — | ✓ | — | — |
| Request lab recollection | — | △ | — | — | ✓ | — | — |
| Schedule/reschedule RX | — | △ | — | △ request | — | ✓ | — |
| Schedule/reschedule US | — | △ | — | △ request | — | — | ✓ |
| Perform image exam | — | △ | — | — | — | ✓ RX | ✓ US |
| Create result draft | — | △ | — | — | ✓ lab | ✓ RX | ✓ US |
| Edit own result draft | — | △ | — | — | ✓ before release | ✓ before release | ✓ before release |
| Release result/report | — | △ override | — | — | ✓ own service | ✓ own service | ✓ own service |
| Amend released result | — (break-glass only) | ✓ policy/department | — | — | △ owner | △ owner | △ owner |
| Void released result | — (break-glass only) | ✓ policy/department | — | — | △ owner/policy | △ owner/policy | △ owner/policy |
| Create attachment upload session | — | △ | — | — | ✓ own result | ✓ own result | ✓ own result |
| Finalize attachment/upload scan | — | △ | — | — | ✓ own result | ✓ own result | ✓ own result |
| Download attachment | — | ✓ | ✓ scope | ✓ scope | ✓ service | ✓ service | ✓ service | — |
| View attachment | — | ✓ | ✓ scope | ✓ scope | ✓ service | ✓ service | ✓ service |
| View result | — | ✓ | ✓ care | ✓ ward | ✓ service | ✓ service | ✓ service |
| Record result view | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Review result | — | △ | ✓ | ✓ if policy | — | — | — |
| Acknowledge critical notification | — | ✓ | ✓ recipient | ✓ recipient | ✓ recipient | ✓ recipient | ✓ recipient | — |
| Cancel before execution | △ | ✓ | △ requester | △ requester | △ service | △ service | △ service | — |
| Cancel/reject after start | △ support | ✓ policy | —/△ | —/△ | △ manager | △ manager | △ manager | — |
| Complete item manually | △ | △ policy | — | — | — | — | — | — |
| View audit/timeline | △ | ✓ | ✓ scope | ✓ scope | ✓ scope | ✓ scope | ✓ scope | △ |
| Configure catalog/SLA/reasons | ✓ | △ delegated | — | — | △ proposal | △ proposal | △ proposal | — |
| Manage users/roles (inclui gerar senha temporária e link de redefinição de uso único) | ✓, including MANAGER delegated-scope configuration | ✓ operational users in managed scope | — | — | — | — | — | — |
| Export/delete/archive | ✓ with policy | △ approval | — | — | — | — | — | — |

The matrix is a starting policy, not a claim of current hospital authorization. OQ-001/OQ-002/OQ-003/OQ-017 must be resolved before production.

## 4. Resource scopes

- `CARE`: patient/encounter is assigned to actor’s current care team or explicit coverage.
- `DEPARTMENT`: item’s executor/requesting department matches role assignment.
- `WARD`: current admission location is within actor’s ward/shift scope.
- `SERVICE`: item’s `DiagnosticService` is one the role executes.
- `SITE`: future boundary; single-site MVP uses one configured site but does not assume multi-tenant behavior.
- `BREAK_GLASS`: time-limited, reason-required, audited access; must not be enabled by default.

The local implementation does not expose `BREAK_GLASS`. Managers can see a patient/request only when the request's requesting department or an item's executor department matches their own or explicitly managed departments; request views redact items outside that department set, and queue/search/dashboard/management results are filtered at item scope.

## 5. Sensitive actions

Require confirmation/reason and server version: release, amend, void, cancel after receipt/start, reject sample, override duplicate, notification acknowledgement (including critical), sensitive access grants, export and deletion/archive. Notification acknowledgement requires `expectedVersion`, a non-empty reason, explicit `confirm: true` and an idempotency key. Ordinary user provisioning and identity/role edits use automatic actor attribution, versioning and audit without a routine reason/confirmation field (D-024). Granting/removing/reactivating ADMIN and administrative changes to a SUPERADMIN target require recent persisted password reauthentication; deactivation revokes sessions and preserves the user/audit record. Do not put a confirmation modal on harmless navigation or view actions.

Critical escalation resolves each candidate's current access group inside the transaction. Clinical recipients require both `result.view` and `notification.acknowledge` on the result resource; an inactive group or removed permission prevents the notification and patient grant. Administrative exhaustion alerts contain no PHI and require current `health.readiness` or `outbox.manage`; no technical administrator receives clinical access through this fallback. Existing approved policy and `onCall` remain authoritative until an approved shift cutover.

## 6. Authorization failure behavior

Return `403 FORBIDDEN` when the actor is authenticated but disallowed, or `404 NOT_FOUND`/equivalent indistinguishable response when revealing resource existence would leak scope. Never return hidden patient/result metadata in error details. Every denied sensitive attempt is logged at appropriate audit/security severity without storing secrets.

## 7. Review and testing obligations

For each matrix row, test allowed actor, wrong role, wrong department, wrong patient/encounter, inactive role, expired session, concurrent state and direct API/attachment URL. Server tests are authoritative; frontend permission tests are supplementary.

## Extensão HPL: setores e capacidades retornadas

Setores separam `department.view`, `department.create`, `department.update`, `department.deactivate` e `department.members.manage`. ADMIN e SUPERADMIN administram o cadastro; MANAGER consulta/edita/equipe dentro dos setores próprios/delegados, sem criar ou desativar globalmente. Perfis operacionais consultam diretório sem dados clínicos; isso não concede operação de exames de outro setor. API autoriza cada comando independentemente.

A sessão informa as capacidades efetivas atuais em `permissions`; resultado informa capacidades compatíveis com seu contexto. UI oculta ações inelegíveis, e servidor revalida autorização. Conteúdo histórico selecionado retorna `permissions: []`; não pode ser alterado pela tela. Campos de capacidade são projeções, nunca autoridade persistida ou grants enviados pelo cliente.

## Extensão HPL: grupo base, delegação e revogação

Cada usuário tem um único `accessGroupId`. A decisão combina `active`, o teto fixo do perfil e as permissões do grupo ativo; depois aplica paciente, setor, exame materializado, autoria e estado clínico. Grupo ausente em um vínculo existente ou grupo inativo concede zero ações. Somente o legado sem vínculo conserva o teto anterior até a migração 020. Grupos não criam acesso global a pacientes nem convertem ADMIN técnico em operador clínico.

`user.view/create/update/deactivate`, `service.catalog.create/update/deactivate` e `access_group.view/create/update/deactivate/assign` são ações independentes. Os grants legados `user_role.manage` e `service.catalog.manage` conservam compatibilidade mediante expansão explícita. O editor expande esses aliases e salva ações separadas; um grupo somente de criação não pode editar/desativar por PATCH, atualização de perfil ou importação. Uma importação que desativa e também muda metadados exige ambas as ações.

MANAGER delega apenas permissões compatíveis com os perfis operacionais administráveis e alvos nos setores próprios/delegados; não delega administração global. ADMIN não administra um alvo SUPERADMIN. A própria sessão não pode trocar seu grupo ou alterar suas permissões. Mudanças que afetem ADMIN/SUPERADMIN exigem reautenticação persistida. Uma operação transacional não pode remover o último acesso administrativo efetivo nem o último SUPERADMIN com esse acesso.

Mudança de grupo que altere permissões efetivas e troca de vínculo incrementam a versão dos usuários afetados e revogam suas sessões na mesma transação. A conta permanece cadastrada e pode autenticar sem capacidades operacionais quando seu grupo está inativo; o servidor nega os comandos e encerra o stream anterior antes de emitir eventos. A sessão e cada operação recebem a projeção atual, limitada também ao snapshot autenticado. Prévia usa o mesmo resolvedor e retorna diferenças, versões do usuário/grupo e contagens de escopo, sem nomes ou IDs de pacientes. Salvar um vínculo com versões antigas resulta em conflito.

`patient_scope.manage` autoriza concessão/retirada auditada para VETERINARIAN, INPATIENT_TEAM ou VIEWER. ADMIN opera identificadores opacos e não recebe leitura clínica; MANAGER só delega pacientes com contexto operacional nos setores que administra. A retirada atualiza o grant e `patientIds` materializados e revoga sessões. Equipe descritiva, responsável de internação e atribuição de tarefa não concedem pacientes automaticamente. Motivo contextual é exigido nessa alteração de risco; edição administrativa rotineira de nome/e-mail mantém autoria e versão automáticas, conforme D-024.

A ação `exam_definition.approve` pertence a VETERINARIAN, MANAGER e SUPERADMIN, respeitando os grants efetivos. VETERINARIAN pode aprovar referências do catálogo clínico visível independentemente da lotação assistencial; a lotação INPATIENT não representa o setor responsável pela política laboratorial. MANAGER mantém limites dos setores próprios/delegados. ADMIN técnico prepara a definição, mas não aprova. Aprovação clínica registra ator, política e população explícitos e exige serviço/setor ativos; não concede pacientes nem autorização para executar exames.

Visões salvas separam `planner_view.view`, `planner_view.create`, `planner_view.update`, `planner_view.deactivate` e `planner_view.share`. Perfis clínicos e VIEWER podem manter configurações próprias conforme sua matriz; MANAGER e SUPERADMIN podem compartilhar dentro do escopo permitido. ADMIN técnico não recebe configuração clínica. Propriedade limita alterações, e setor limita descoberta das configurações compartilhadas. Em todos os casos, resultados e contagens continuam sujeitos à autorização atual da entidade consultada. Filtros diagnósticos podem referenciar setor de um exame atualmente legível e seu profissional atribuído, sem conferir criação/execução de HospitalTask nesse setor.

A prévia agregada de um grupo exige autoridade sobre todos os vinculados antes de mostrar impacto. Usuários inativos conservam permissões efetivas vazias; perfis reduzidos mantêm o teto. Token vincula proposta, versões, vínculos e escopos atuais e é revalidado na escrita quando fornecido; a UI exige prévia atual. Prévia não altera contas ou grants; a reautenticação continua obrigatória para escrita protegida.

Em F4, o contexto clínico de MANAGER também reconhece a internação persistida de um paciente no setor próprio/delegado, com `admission.view` efetiva e atendimento realmente vinculado. Isso permite planejar cuidado sem exigir exame fictício. Plano, tarefa, equipe ou reserva recém-criados não fornecem esse contexto. A transferência da internação para um setor fora da delegação retira essa fonte de acesso; concessões alternativas existentes continuam sendo avaliadas. Atendimento sem setor/internação não recebe uma lotação inferida.

## Tarefas gerais e triagem do planner (BLD-HPL-023–028)

`hospital_task.view` e `hospital_intake.view` exigem setor próprio; MANAGER usa setores próprios/delegados e SUPERADMIN usa escopo global. Um vínculo assistencial exige também a autorização vigente de paciente. ADMIN mantém configuração técnica de tipos (`hospital_task_type.manage`), sem leitura ou operação de tarefas/demandas, inclusive rotinas sem paciente. VIEWER consulta e não executa.

Criar, editar, executar, atribuir, reclassificar prioridade e manter dependências são ações independentes. Criar sem permissão de consulta permite apenas o retorno da atividade recém-criada, sem abrir sua fila ou a busca. As opções de criação oferecem metadados dos setores autorizados e equipe pública; não exigem administração de usuários nem expõem credenciais, concessões individuais ou contato privado.

Assumir uma tarefa sem responsável é explícito e limitado ao próprio profissional; reatribuir ou alterar equipe exige MANAGER/SUPERADMIN no contexto autorizado. Responsáveis e executores precisam estar ativos, habilitados pelo grupo/perfil, autorizados ao contexto e vinculados à equipe cadastrada do setor, salvo o escopo próprio da gestão global/delegada. Participantes podem ter somente leitura. Atribuição não muda autoria, escopo de paciente, permissões ou autoria de laudo. A execução revalida a elegibilidade; estar registrado como responsável não constitui concessão.

Dependência exige leitura de ambas as autoridades no momento da escrita. Referência que posteriormente deixa de ser autorizada aparece somente como pendência restrita, sem título, identificador do alvo ou responsável. Histórico de tarefa exige `hospital_task.view`, não auditoria global, e revalida acesso depois da leitura assíncrona; referências retiradas são redigidas. Busca filtra autorização antes de títulos, sugestões, contagens, ordenação e paginação.

### Plano, escala, passagem e checklist

`plan.view`, `shift.view`, `checklist_template.view` e `recurrence.view` não substituem autorização de paciente, atendimento ou atividade vinculada. Profissionais operacionais usam o próprio setor; MANAGER usa o próprio e os delegados; SUPERADMIN tem escopo global, com os mesmos requisitos de contexto, versão, autoria e execução. VIEWER recebe leituras e não os comandos. ADMIN técnico pode preparar modelos de checklist e operar inventário, conservando a proibição de planos, escalas clínicas, recorrências e execução de cuidado.

Criar, atualizar e arquivar planos usam `plan.create`, `plan.update` e `plan.archive` independentes. `shift.manage` e `shift.assign` pertencem à gestão autorizada; associação ao plantão não concede execução. `handoff.offer` permite entregar pendências próprias, ou gerenciadas dentro do escopo, e `handoff.accept` exige o recebedor nominal e elegibilidade atual em cada autoridade. O acesso retirado é aplicado inclusive no replay idempotente e no SSE.

`checklist_template.manage` não aprova o modelo; `checklist_template.approve` pertence a VETERINARIAN, MANAGER e SUPERADMIN autorizados no setor. `checklist.execute` conserva os requisitos de responsabilidade/equipe da tarefa. Modelos clínicos limitam executores pelos papéis aprovados e por `care.execute` efetiva; união de permissões de SUPERADMIN não ignora a elegibilidade declarada no processo. Aprovar um modelo não concede pacientes ou comandos de laudo. `recurrence.manage` exige o contexto vigente e a geração revalida o criador e todas as concessões necessárias a cada ocorrência.

As opções de planejamento expõem apenas nomes/códigos de setores e identidade pública de equipe elegível para a ação solicitada. Não dependem de `user.view`, `department.view` ou criação de tarefas, e não retornam contatos, credenciais, concessões ou pacientes. Reservas vigentes aparecem na tarefa somente com `hospital_calendar.view` no contexto autorizado; sem essa ação, referências de agenda também são retiradas da resposta de histórico.

### Colaboração, arquivo e preferências privadas

`hospital_task.comment.view/create/edit_own/moderate` são distintas. Editar próprio comentário exige `ownerId` igual à identidade atual; moderação pertence a MANAGER/SUPERADMIN dentro do contexto e exige motivo. VIEWER pode consultar conversa e anexos autorizados, sem escrever, enviar ou reagir. Upload/download usam `hospital_task.attachment.upload/view/download` e o mesmo contexto atual da tarefa; envio/finalização também exigem o remetente original.

`hospital_task.archive/restore` exige tarefa publicada e terminal, sem subtarefa ativa, e responsabilidade/equipe atuais ou MANAGER/SUPERADMIN com escopo. ADMIN técnico conserva a proibição de tarefas/pacientes e execução clínica. Rascunho requer criação/atualização existentes e não libera comandos de execução, agenda, checklist, cuidado, composição ou passagem antes de publicado. Conteúdo e metadados não concedem acesso.

`work_activity.preference.manage` e ações `work_notification.view/read/archive/preferences.manage` permitem conveniência pessoal nos nove perfis, somente sobre alvos que o ator já pode consultar. Nenhum perfil, inclusive SUPERADMIN, lê a nota ou o inbox privado de outra identidade. SSE e auditoria resolvem identidade privada e alvo atual, excluindo a alternativa genérica administrativa para essas entidades.

`integration.manage` pertence a ADMIN/SUPERADMIN e MANAGER no escopo delegado; `integration.exchange` pertence aos profissionais clínicos/operacionais, MANAGER e SUPERADMIN, com autorizações do alvo atual. ADMIN técnico não recebe troca de PHI. A migração 025 conserva a matriz aprovada de 146 códigos; os dois códigos externos adicionais pertencem à migração posterior, sem alterar snapshots SQL já fixados.
