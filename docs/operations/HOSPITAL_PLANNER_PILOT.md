# Homologação e piloto do planner hospitalar

**Conhecimento:** `DECISION/PROPOSAL` de execução do UAT. Este pacote não registra teste realizado, aprovação clínica ou autorização de produção. Os campos em branco são preenchidos pelos responsáveis do hospital. Não copiar nomes, datas, resultados ou aceites de outra candidata.

**Relacionados:** [BLD-HPL-051](../build/BACKLOG_HOSPITAL_PLANNER_2026-10-11.md#bld-hpl-051), [PROD-701–704](../build/PRODUCTION_BACKLOG.md), [cutover](HOSPITAL_PLANNER_CUTOVER.md), [release checklist](RELEASE_CHECKLIST.md), [capacidades externas](HOSPITAL_EXTERNAL_CAPABILITIES.md), [cadastro e conferência](PATIENT_REGISTRATION_PILOT.md).

## 1. Identificar candidata, escopo e responsáveis

**Responsável confirmado em 12/10/2026:** o solicitante do projeto assumiu a validação dos fluxos e o aceite do piloto. A [confirmação de responsabilidade](HOSPITAL_PLANNER_PILOT_OWNER_2026-10-12.json) registra essa declaração. Execução, resultados, identificação formal na ficha assinada e decisão go/no-go continuam pendentes.

Executar primeiro em ambiente de homologação segregado, com dados sintéticos ou dados expressamente autorizados pelo hospital. O piloto operacional depende do aceite desse ensaio e dos gates PROD-*; a duração e a contingência seguem PROD-703. Testes negativos, malware de ensaio, falhas provocadas e concorrência não são executados sobre atendimento real em produção.

| Registro da execução | Valor a preencher |
| --- | --- |
| Identificador do UAT e ambiente/URL aprovada | ________ |
| Pico de usuários simultâneos a testar | 20, confirmado pelo solicitante em 12/10/2026; registrar duração, jornadas e resultados do ensaio. |
| Commit e estado da árvore utilizada | ________ |
| Digests/revisões das imagens app e ops/worker | ________ |
| Schema e migrações aplicadas | ________ |
| Fuso institucional / APP_TIMEZONE / label das imagens / fuso compilado da UI | ________ |
| Referências das evidências técnicas desta mesma candidata | ________ |
| Setores, módulos e processos incluídos / excluídos | ________ |
| Responsável pela validação dos fluxos e aceite do piloto | Solicitante do projeto; confirmado em 12/10/2026. Registrar identificação formal na ficha de execução/aceite. |
| Responsável clínico, gestão, QA, TI/operação e substitutos | ________ |
| Pessoas autorizadas a aceitar cada área e a decidir go/no-go | ________ |
| Início/fim do UAT; datas propostas do piloto | ________ |
| Contingência, canal de incidentes, ponto de retorno e dono do rollback | ________ |

Selecionar e justificar os cenários condicionais antes de iniciar. LIS/PACS e provedor de IA não foram identificados; ficam **desligados**, sem resultado de homologação presumido. O `cvg-his-v4` foi informado como adotado, mas revisão instalada, endpoint e jornada reais ainda precisam da seção 6. Se o piloto depender de um canal externo, seu cenário deixa de ser dispensável. Não marcar cenário bloqueado como aprovado ou como não aplicável sem decisão registrada.

## 2. Preparar dados e operação

Preencher os registros abaixo em área restrita de homologação. O pacote compartilhado contém referências às evidências, nunca senha, token, API key, cookie, chave HMAC, corpo clínico completo ou contato pessoal. IDs de pacientes e outros dados assistenciais também ficam sujeitos à política de acesso do hospital.

| Pré-requisito | Registro / evidência / conferido por / data |
| --- | --- |
| Nome da instituição e fuso IANA coerentes com API, UI e imagens | ________ |
| Setores reais ativos, equipes/responsáveis e delegações selecionadas | ________ |
| Catálogo diagnóstico publicado, definições e referências aprovadas; serviço hospitalar separado de exame | ________ |
| Tipos de tarefa, checklists e protocolos aprovados; perfis executores, política e prontuário de cuidado/procedimento | ________ |
| Usuários ativos, grupos efetivos, escopos de paciente/setor/serviço e canal autorizado de entrega de acesso | ________ |
| Paciente/atendimento aberto autorizado; paciente homônimo; paciente/setor/serviço fora do escopo | ________ |
| Salas/equipamentos/profissionais com IDs reais e janelas; profissional corresponde a usuário ativo elegível | ________ |
| Leitos com IDs, ala/rótulo e espécies; internações legadas reconciliadas ou bloqueio UNRECONCILED identificado | ________ |
| Dois profissionais elegíveis, dois turnos e pendências para passagem; autor diferente para trabalho compartilhado | ________ |
| Armazenamento privado/scanner, anexos de ensaio limpos e de quarentena autorizados | ________ |
| Worker, recorrências, relatórios, avisos, heartbeat e observabilidade acessíveis aos donos | ________ |
| Política de resultado crítico, canal/escalada aprovados e plantonistas; confirmação crítica separada da inbox de trabalho | ________ |
| Volume representativo e metas de carga/usabilidade aprovadas; backup/restore completos no alvo isolado | ________ |

Sem conteúdo clínico aprovado, executar apenas jornadas operacionais que não o exigem e registrar os cenários assistenciais como bloqueados. Não inventar limites laboratoriais, protocolos, ocupações ou referências de prontuário para fechar o gate.

## 3. Contas, permissões e testes de escopo

As contas reais de UAT e seus grupos são registrados abaixo; este documento não cria contas. Conferir permissões efetivas e versões de acesso antes e depois do cutover. A tabela descreve concessões dos **perfis-base** da fonte candidata, não a autorização final de um objeto. Grupo reduzido, sessão, estado, autoria, paciente, setor, serviço e elegibilidade continuam limitando o comando. O servidor e as capacidades contextualizadas do objeto são a autoridade.

`C` = perfil-base contém a permissão, sujeito às demais condições; `—` = perfil-base não a contém. Os nomes de permissão estão no cabeçalho. Fonte: [política do servidor](../../src/server/security/authorization.ts) e [contrato de perfis](../../packages/contracts/src/identity-roles.ts). Revalidar a tabela se a política da candidata mudar.

| Perfil | department.create | patient.create | request.create | hospital_task.create / execute | shift.manage | care.execute | hospital_document.approve | integration.manage |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SUPERADMIN | C | C | C | C / C | C | C | C | C |
| ADMIN | C | — | — | — / — | — | — | — | C |
| MANAGER | — | — | C | C / C | C | C | C | C |
| VETERINARIAN | — | C | C | C / C | — | C | C | — |
| INPATIENT_TEAM | — | C | C | C / C | — | C | — | — |
| LAB_TECH | — | — | — | C / C | — | — | — | — |
| RADIOLOGY_TEAM | — | — | — | C / C | — | — | — | — |
| ULTRASOUND_TEAM | — | — | — | C / C | — | — | — | — |
| VIEWER | — | — | — | — / — | — | — | — | — |

VIEWER tem leitura contextual e preferências/avisos de trabalho; não deve criar/executar tarefas, reagir/comentar, confirmar cuidado ou confirmar resultado crítico. ADMIN prepara cadastros/recursos/conteúdo e integrações técnicas; não ganha assistência clínica. SUPERADMIN combina concessões conhecidas, preservando autoria, elegibilidade, FSM, versões e confirmações. MANAGER conserva setores próprios/delegados, não acesso global. A descoberta institucional HIS v4 exige ADMIN/SUPERADMIN além de `integration.manage`; a concessão do MANAGER não autoriza essa descoberta global.

| Conta de ensaio | Perfil / grupo e versão / permissões efetivas | Pacientes / setores / serviços autorizados | Objeto equivalente fora do escopo | Conferência antes/depois |
| --- | --- | --- | --- | --- |
| Referência restrita: ________ | ________ | ________ | ________ | ________ |

Repetir essa ficha para os nove perfis e para um grupo personalizado reduzido. Usar dois profissionais de autoria diferente sobre o mesmo paciente autorizado. Não registrar credenciais aqui.

| ID | Ensaio de acesso | Resultado esperado / evidência a registrar |
| --- | --- | --- |
| UAT-ACL-01 | Executar um comando concedido em objeto elegível e repetir em paciente/setor/serviço fora do escopo, inclusive por link/API/download direto | Sucesso somente no primeiro; recusa conforme contrato, normalmente 403/404, sem conteúdo ou efeito persistido no segundo. Registrar status/código seguro e versão antes/depois. |
| UAT-ACL-02 | Conta VIEWER lê tarefa autorizada e tenta START/COMPLETE, comentário e cuidado | Leitura permitida; controles de escrita ausentes e requisição direta negada. Fase/versão/evidências permanecem intactas. |
| UAT-ACL-03 | ADMIN prepara cadastro e tenta criação de paciente, solicitação ou execução assistencial | Cadastro conforme grants; comandos clínicos negados. ADMIN não vê a fila clínica como SUPERADMIN. |
| UAT-ACL-04 | MANAGER consulta seu setor e outro delegado; tenta setor não delegado e promoção/gestão de SUPERADMIN | Escopos atuais respeitados; não administra SUPERADMIN nem ultrapassa sua delegação. |
| UAT-ACL-05 | Executor trabalha em serviço autorizado, repete em serviço negado e tenta editar draft alheio | Departamento e serviço precisam ser elegíveis; autoria do draft permanece protegida, inclusive para perfil privilegiado. |
| UAT-ACL-06 | Grupo reduzido remove um comando do perfil-base; comparar antes/depois de migração e adicionar serviço novo | Restrição conservada; sem ampliação silenciosa. Política None/selecionados/todos atuais/futuros corresponde à escolha explícita. |
| UAT-ACL-07 | Retirar acesso/membro de equipe ou desativar ator enquanto lista/detalhe/anexo/relatório estão abertos | Próxima leitura/comando/download revalida acesso, limpa conteúdo recusado e não restaura resposta antiga. Arquivo histórico não contorna revogação. |

Testes de recusa precisam conferir tanto a UI quanto a autoridade HTTP/persistente. Uma mensagem de erro sozinha não prova ausência de efeito. Usar observação autorizada pelo auditor/operador; não expor dados protegidos à conta negada nem contornar CSRF, versões ou políticas para executar o ensaio.

## 4. Roteiro de jornadas

Executar cada linha em desktop, tablet e celular utilizados pelo hospital, registrando viewport/dispositivo e navegador. O login e as contas vêm da seção 3; não usar SUPERADMIN como substituto do usuário operacional normal. Anotar IDs/versões em ficha restrita. A URL de API, quando citada, usa o prefixo `/api/v1`. Nos cabeçalhos, barra abrevia ações do mesmo prefixo e `.*` indica a família a conferir, não uma permissão wildcard concedida ao usuário; registrar cada comando efetivo na ficha de contas.

| ID / atores / permissões principais | Entrada e passos na interface | Resultado esperado e caso negativo obrigatório |
| --- | --- | --- |
| UAT-HPL-01 — ADMIN/SUPERADMIN; department.*, service.catalog.*, user.*, access_group.* concedidos | `/admin/departments` → cadastro/equipe; `/admin/hospital-services` e `/admin/catalog` → serviços distintos; `/admin/users` e `/admin/access-groups` → conta/grupo/escopo; conferir prévia antes de aplicar | Destinos mostram objetos distintos, códigos/versões corretos. Grupo reduzido e serviços negados não se ampliam; ADMIN não administra alvo SUPERADMIN. Desativar cadastro conserva histórico e impede novo vínculo incompatível. |
| UAT-HPL-02 — VET/INPATIENT/SUPER com patient.create e encounter.manage | `/patients` → buscar identificador/homônimo, cadastrar ou abrir atendimento; internação seleciona leito por ID; `/patients/{id}/diagnostics` → conferir contexto | Um atendimento aberto por paciente, nenhum cadastro duplicado por externalId. Ocupação concorrente, espécie incompatível e setor não reconciliado recusados; ambulatório não cria ocupação. |
| UAT-HPL-03 — solicitante com request.create e executor diagnóstico elegível | `/queues?view=mine` (Meu trabalho) ou `/queues?view=all` (exames) → solicitar exame em atendimento real autorizado; abrir confirmação e link; outro profissional autorizado consulta Meu trabalho | Rotina ativa de outro autor aparece. Filtro explícito incompatível tem aviso/link e pode ser limpo; registro permanece após reload. Repetição detecta duplicidade sem criar segundo item silenciosamente. |
| UAT-HPL-04 — profissional operacional normal; hospital_intake.create/triage e hospital_task.create efetivos | `/planner/intake` → registrar demanda; aceitar/vincular atividade autorizada. `/planner` → criar atividade, escolher tipo/setor/contexto quando exigido; abrir link e recarregar | Demanda e tarefa têm identidades próprias. Tarefa operacional não exige exame fictício; CARE exige paciente/atendimento aberto. Rejeição/duplicidade e destino fora do escopo não produzem aceitação automática. |
| UAT-HPL-05 — ator com hospital_task.assign/execute/update/priority.update contextual | `/planner/tasks/{id}` → assumir/reatribuir elegível, planejar e justificar prioridade; iniciar e concluir tarefa operacional. Abrir duas abas para uma alteração concorrente | Versões/idempotência preservadas; conflito não apaga texto local nem duplica comando. Dependência bloqueadora impede fase correspondente. Datas usam fuso do hospital; prioridade não reinterpreta criticidade/laudo/SLA diagnóstico. |
| UAT-HPL-06 — leitor autorizado; planner_view.* conforme grupo | `/planner` → lista/quadro/tabela/calendário, filtros explícitos, visões salvas; `/planner/search` e `/planner/timeline` → localizar/editar planejamento autorizado | Mesmos objetos autorizados em todas as visões. Preferências isoladas por identidade/rota; compartilhar configuração não compartilha paciente. Busca/paginação não revela objeto negado nem confunde prazo, planejamento e execução. |
| UAT-HPL-07 — plan.create/update e leitor autorizado | `/planner/plans` → criar plano com contexto; ordenar etapas e vincular tarefas/exames atuais; `/planner/plans/{id}` → revisar pendências, bloqueios, fechar/arquivar | Vínculos/versões reais; atividade restrita não expõe identificação. Encerrar plano não conclui exame nem atividade pendente; cancelar atividade não fabrica conclusão do plano. |
| UAT-HPL-08 — shift.manage/assign, handoff.offer/accept e recebedor elegível | `/planner/shifts` → dois turnos/equipes/substituição; vincular atividade; `/planner/handoffs` → oferecer, consultar pendências, recusar e depois aceitar oferta válida | Responsável anterior conservado até aceite; quem recebe precisa de acesso próprio. Recusa/membro inelegível/dois aceites concorrentes não transferem grants nem reiniciam exame/SLA. Inbox lida não aceita passagem. |
| UAT-HPL-09 — hospital_resource.* e hospital_calendar.* efetivos | `/admin/resources` → inventário/janelas; tarefa → reservar IDs; `/planner/agenda` → remarcar/cancelar e distinguir RESERVATION/DEADLINE/EXECUTION; ensaiar conflito concorrente | Sobreposição incompatível recusada; início reservado valida janela/profissional. Execução prolongada conserva ocupação. Planejamento textual não comprova reserva nem disponibilidade. |
| UAT-HPL-10 — admission.context.manage e escopo vigente; hospital_capacity.view | `/planner/beds` → censo/ocupação legada; reconciliar por BED_CHANGE com motivo/política; transferir internado; `/planner/capacity` → conferir setores/período | Ocupação vem de Admission; UNRECONCILED e disponibilidade desconhecida não viram zero/vaga livre. Transferência usa ID elegível. Alta conserva exames ativos e histórico. |
| UAT-HPL-11 — preparador, aprovador e executor separados; checklist_template.*, recurrence.manage, checklist.execute, care.execute | `/planner/checklists` → preparar/aprovar modelo; `/planner/recurrences` → configurar/gerar; detalhe da tarefa → registrar etapas e confirmar cuidado com referência real de ensaio autorizada | Aprovação identifica ator/política; mudança não altera snapshot antigo. Dois workers/retry não duplicam ocorrência. Cuidado tem comando próprio, confirmação e executor elegível; COMPLETE genérico não o substitui. Referência declarada não comprova entrega externa ou administração medicamentosa. |
| UAT-HPL-12 — executor diagnóstico/solicitante elegíveis | `/requests/{id}` → LAB/RX/US nativos, recoleta quando aplicável; `/results/{id}` → liberar/revisar/retificar e abrir versão histórica; `/notifications` → confirmação crítica | As 15 invariantes do backlog continuam válidas. Rejeição/recoleta não corrompe laudo compartilhado liberado; versão antiga permanece histórica/read-only. Notificação lida, revisão de laudo, conclusão e confirmação crítica continuam ações distintas. |
| UAT-HPL-13 — hospital_task.comment.create, hospital_task.attachment.upload/view/download e leitor autorizado | `/planner/tasks/{id}` → comentário/menção, edição própria/moderação conforme grant; upload real, finalização/scan, download; retirar acesso | Menção não concede escopo. Quarentena/pendência não oferece download limpo; anexo finalizado é privado. Falha/retry não cria sucesso fictício. Conteúdo fica indisponível após revogação. |
| UAT-HPL-14 — preparador/aprovador hospital_document.* e leitor autorizado | `/planner/documents` → draft estruturado; `/planner/documents/{id}` → edição concorrente, revisão, aprovação e captura em tarefa/plano | Conflito preserva trabalho, publicação exige autorização/confirm/política. Snapshot capturado conserva revisão; favorito/bloqueio/arquivo não concedem conteúdo. IA desligada não gera sugestão simulada. |
| UAT-HPL-15 — work_notification.*, work_activity.preference.manage, hospital_report.* e hospital_metric.view efetivos | `/planner/inbox` → lido/não lido/arquivo/preferências; seguir/favoritar objeto; `/planner/metrics` → janela/denominador/drill-down; `/planner/reports` → job/export/retry | Preferências são privadas; inbox de trabalho não confirma crítico/handover. Sem autorização, indicador é desconhecido. Job pendente não baixa; download revalida alvo. Duplicidade de vínculos não duplica contagem; draft não entra. |
| UAT-HPL-16 — ADMIN/SUPER técnico e gestor elegível; institution.manage/user_invite.manage | `/admin/institution` → nome/fuso/capacidades; `/admin/invitations` → grupo/setor/convite e `/invite#<token>` no destinatário de ensaio | Fuso coerente com imagens; desligar novas atividades conserva pendências. Convite não promove ADMIN/SUPER, expira/revoga/usa uma vez. Token fica no fragmento e é enviado no corpo; não entra em evidência compartilhada. |

Para cada jornada selecionada, medir também teclado/foco, leitura dos estados vazios, erro/retry e conectividade degradada. Se uma superfície depende de capability retirada, confirmar ausência do comando na UI e recusa da requisição direta. Falha de rede temporária e recusa de acesso têm resultados diferentes: snapshot sinalizado pode permanecer na primeira; conteúdo recusado deve sair na segunda.

## 5. Resultados, defeitos e usabilidade

Duplicar a ficha por cenário, perfil, variante positiva/negativa e dispositivo. `PASS` exige comparar o resultado observado com o esperado; `FAIL` registra divergência; `BLOCKED` registra pré-requisito ausente; `NÃO APLICÁVEL` exige justificativa e aprovação de quem selecionou o escopo.

| Cenário / variante / conta referenciada / dispositivo | Resultado esperado | Observado / status / versões e efeitos conferidos | Evidência restrita / executor / data | Defeito ou bloqueio |
| --- | --- | --- | --- | --- |
| ________ | ________ | ________ | ________ | ________ |

| Defeito | Jornada / candidata | Impacto e prioridade fundamentada | Reprodução / evidência sem segredo | Dono / correção / reteste / situação |
| --- | --- | --- | --- | --- |
| ________ | ________ | ________ | ________ | ________ |

| Medida de usabilidade/carga | Baseline e meta aprovados antes do ensaio | Resultado por perfil/dispositivo | Observação / responsável / data |
| --- | --- | --- | --- |
| Tempo e interações para localizar pendência e criar/confirmar registro | ________ | ________ | ________ |
| Conclusão sem ajuda, erros de contexto/filtro e satisfação da equipe | ________ | ________ | ________ |
| Volume simultâneo, latências e limites de recurso no alvo | ________ | ________ | ________ |
| Tempo de restauração, perda observada e comunicação de contingência | ________ | ________ | ________ |

Não inventar metas numéricas ou usar testes locais como substituto dessas medidas. Defeito P0 aberto no escopo impede aceite. Reteste de correção identifica candidata e evidência próprias; cenário não executado não recebe contagem de passe.

## 6. Homologação específica do HIS v4 e canais externos

**Fato conhecido:** o hospital informou `cvg-his-v4` instalado na VPS; a fonte inspecionada foi `0ebfc5b6627c8ed006075dc5285fd3514443c806`. A [observação de proveniência instalada](HIS_V4_INSTALLED_PROVENANCE_2026-10-11.json) registra IDs/digests das imagens SPA/API/worker com tag `272581dc60b7`. Labels de revisão/origem estavam ausentes; correspondência com essa fonte permanece `UNKNOWN`. A observação somente de metadados não confirma contrato em execução, tráfego ou aceite reais. O perfil escolhido é `HIS_V4`, não o envelope genérico CVG. Consultar [contrato e parâmetros completos](HOSPITAL_EXTERNAL_CAPABILITIES.md#perfil-real-his-v4).

| Sistema/canal | Decisão e dono / revisão instalada / referência contratual / ambiente | Estado autorizado e evidência |
| --- | --- | --- |
| HIS v4 — descoberta de catálogo e webhook encounter.created para triagem | ________ | Desligado até habilitação aprovada: ________ |
| LIS — fornecedor/contrato ainda não identificado | ________ | OFF; não homologado |
| PACS — fornecedor/contrato ainda não identificado | ________ | OFF; não homologado |
| Assistência IA — fornecedor/finalidade ainda não aprovados | ________ | OFF; não homologado |

| Preparação HIS v4 | Registro restrito / evidência / conferência |
| --- | --- |
| Digest/revisão do HIS instalado e compatibilidade com fonte/contrato observados | ________ |
| Descoberta HTTPS /integrations/catalog ou /api/integrations/catalog; CA/host/IP aprovados e conta exata | ________ |
| Referência de API key limitada a integrations.read e seu custodiante, sem valor bruto | ________ |
| Endpoint HTTPS do receptor permitido pela política de webhook HIS; TLS, roteamento e observabilidade | ________ |
| Referências do webhook, credencial Hub HIS_V4/HIS_INTAKE e pin de versão; responsável pela rotação | ________ |
| Referência privada dos segredos/arquivos e procedimento de revogação, sem reproduzir conteúdo | ________ |
| Mappings versão 1: evento/ação/setor/título/prioridade/tipo e vínculos hisId↔hubId de paciente/atendimento | ________ |
| Conferência unívoca dos vínculos, relações entre paciente/atendimento e escopo atual do ator | ________ |

O HIS bloqueia destino privado de webhook; loopback, IP LAN e bridge Docker não resolvem o canal só por estarem na mesma VPS. Definir receptor HTTPS aceito pela política sem relaxá-la. A descoberta usa `X-API-Key` de servidor; o ingresso real usa HMAC v2 do timestamp e corpo original, não o token bruto da credencial CVG. Confirmar a ligação/pin após rotação.

| ID | Ensaio real em ambiente autorizado | Resultado esperado |
| --- | --- | --- |
| UAT-HIS-01 | ADMIN/SUPER autorizado consulta catálogo; repetir com MANAGER, conta remota divergente e configuração OFF | Anúncios sanitizados somente na consulta global autorizada; nenhuma transmissão clínica. Negativos recusados; deploymentVerified:false não é homologação automática. |
| UAT-HIS-02 | Evento encounter.created com estado reception, assinatura v2 válida e vínculos explícitos previamente conferidos | Uma demanda RECEIVED/RECEIVED_FOR_TRIAGE; triagem humana obrigatória. Não cria paciente/atendimento por aproximação, pedido diagnóstico, tarefa aceita, laudo ou execução. |
| UAT-HIS-03 | Reentregar ocorrência após perda de resposta e repetir delivery/provider payload conforme protocolo | Uma ocorrência persistida, recibo consistente; conferir o mesmo ID. Colisão de conteúdo/identidade e segundo payload para atendimento já tratado exigem conciliação, não segunda demanda. |
| UAT-HIS-04 | Ausência/adulteração de assinatura, timestamp fora de 300 s, conta/evento/webhook divergentes, vínculo ausente | Recusa sem criar demanda nem gravar dados clínicos em logs. Registrar somente código/status seguros e ausência de efeito. |
| UAT-HIS-05 | Rotacionar/revogar/expirar credencial ou retirar escopo do ator; repetir evento e replay | Pins antigos e credencial/ator inválidos recusados; novo pin só após configuração explícita validada. Revogação não se contorna com replay. |
| UAT-HIS-06 | Falha controlada entre recebimento/comando/recibo e recuperação autorizada; retirar vínculo/escopo antes de retry | Sem comando parcial ou duplicidade; retry revalida autoridade e vínculos. Auditoria/worker/receptor dão evidência correlacionada sem segredo. |

Registrar também o recebimento visto no HIS e a referência da demanda vista no Hub, com horário institucional e referência de evidência restrita. Não chamar recebido para triagem de execução clínica ou sincronização completa. Se o hospital selecionar LIS/PACS/IA, escrever seu contrato, adaptação e cenários reais antes da ativação; os testes de transporte sintético existentes não preenchem essa ficha.

## 7. Registro de aceite e decisão

| Área | Cenários/evidências aceitos desta candidata | Limitações / condições / itens não aceitos | Nome e função autorizada / data / referência de assinatura |
| --- | --- | --- | --- |
| Conteúdo e segurança clínica | ________ | ________ | ________ |
| Acesso, privacidade e grupos | ________ | ________ | ________ |
| Operação por setor e usabilidade | ________ | ________ | ________ |
| Inventário, internações e continuidade | ________ | ________ | ________ |
| TI: carga, restore, observabilidade, contingência e release | ________ | ________ | ________ |
| HIS e demais canais efetivamente selecionados | ________ | ________ | ________ |

| Decisão final | Preenchimento institucional |
| --- | --- |
| UAT: aceito / recusado / bloqueado, com justificativa | ________ |
| Piloto autorizado: escopo, equipes, datas, contingência e critérios de interrupção | ________ |
| P0 abertos / demais riscos e respectivos destinos no backlog | ________ |
| Go/no-go da release, autoridades e referência de assinatura | ________ |

Conferir as 15 garantias do backlog, evidências técnicas da mesma candidata, conteúdo aprovado, inventário conciliado e gates operacionais antes da decisão. O aceite UAT não substitui o acompanhamento e relatório do piloto PROD-703/704. Sem assinatura/identificação dos responsáveis e resultados reais, BLD-HPL-051 permanece aberto.
