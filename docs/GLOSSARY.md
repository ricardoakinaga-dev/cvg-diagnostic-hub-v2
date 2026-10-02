# Glossário

| Termo | Definição normativa |
| --- | --- |
| Paciente | Animal atendido; o sistema mantém identificação clínica mínima e referências externas, sem assumir ser o cadastro mestre futuro. |
| Tutor | Pessoa vinculada ao paciente. Seus dados pessoais são tratados sob controles de privacidade; não há comunicação ao tutor no MVP. |
| Atendimento (`Encounter`) | Contexto clínico em que uma solicitação é feita; pode ser ambulatorial, emergência ou internação. |
| Internação (`Admission`) | Período/local de permanência do paciente, incluindo setor e leito quando aplicável. |
| Solicitação diagnóstica (`DiagnosticRequest`) | Pedido clínico que agrupa um ou mais itens diagnósticos para um paciente/atendimento. Possui código humano e auditoria. |
| Item diagnóstico (`DiagnosticRequestItem`) | Unidade operacional individual dentro de uma solicitação, com serviço, prioridade, workflow, status e resultado próprios. |
| Serviço diagnóstico (`DiagnosticService`) | Capacidade configurável do catálogo, como Hemograma, RX tórax ou Ultrassom abdominal; define tipo de workflow, SLA e requisitos. |
| Procedimento (`DiagnosticProcedure`) | Instância operacional de execução quando o serviço exigir agenda ou etapas específicas; não é sinônimo obrigatório de item. |
| Amostra (`Sample`) | Material/acession coletado ou recebido para um ou mais itens; novas amostras de recoleta preservam a cadeia. |
| Recoleta | Solicitação de uma nova amostra porque a anterior foi rejeitada, insuficiente ou inadequada, com motivo obrigatório. |
| Resultado (`Result`) | Registro lógico do conteúdo clínico de um item; possui versões e lifecycle próprio. |
| Versão de resultado (`ResultVersion`) | Snapshot imutável de um resultado liberado ou corrigido. Uma correção não sobrescreve silenciosamente o histórico. |
| Laudo (`Report`) | Resultado narrativo de um serviço de imagem ou outro serviço que exija relatório. |
| Anexo (`Attachment`) | Arquivo referenciado por uma versão de resultado, armazenado em object storage com validação e autorização. |
| Liberação (`Release`) | Ação que torna uma versão de resultado disponível para os destinatários autorizados. |
| Visualização (`View`) | Registro de que o usuário abriu/consultou uma versão liberada; não significa que a revisou clinicamente. |
| Revisão (`Review`) | Confirmação operacional/clínica do usuário autorizado sobre a versão atualmente liberada. Uma emenda exige nova revisão. |
| Confirmação (`Acknowledgement`) | Confirmação de recebimento de uma notificação, especialmente para resultado crítico; é distinta de revisão. |
| Resultado crítico | Resultado marcado conforme uma política clínica/configuração aprovada; exige notificação e confirmação auditáveis. Valores não são inventados pela aplicação. |
| SLA | Política de tempo de atendimento associada a serviço, prioridade e evento de início configurado. |
| Atrasado (`Overdue`) | Item não terminal cuja hora de vencimento passou segundo o SLA vigente; não é um estado clínico separado. |
| Setor (`Department`) | Unidade organizacional solicitante ou executora, como Internação, Laboratório ou Radiologia. |
| Fila operacional | Visão priorizada de itens acionáveis por um setor, considerando prioridade, SLA, atraso e tempo de espera. |
| Evento de domínio | Fato significativo ocorrido no fluxo, com actor, entidade, timestamp do servidor e metadata. |
| Auditoria clínica | Histórico imutável de ações e mudanças relevantes, separado de logs técnicos. |
| Realtime | Propagação de mudança para telas abertas sem refresh manual; a fonte final continua sendo a API autorizada. |
| Protocolo | Identificador humano da solicitação, por exemplo `EX-260818-0042`; não substitui a PK técnica. |
| Escopo | Conjunto de pacientes, atendimentos, setores ou funções que o actor pode acessar. |
| Actor | Usuário autenticado ou processo de sistema que executa uma ação. |
| Terminal | Estado do qual não há retorno operacional normal: `COMPLETED`, `CANCELLED` ou `REJECTED`. |
| Bucket de rate limit | Contador de requisições por chave dentro de uma janela fixa (`assertRateLimit` em `src/server/security/rate-limit.ts`, tabela `rate_limit_buckets`). O login usa dois buckets simultâneos: um por endereço de cliente identificável e outro por e-mail informado (`login-email:<e-mail>`). |
| Step-up (reautenticação) | Renovação da autenticação privilegiada por `POST /session/reauth`, com janela de 10 minutos. Exigida apenas em `createUser`, `updateUserRole` e `deactivateUser` — gestão de usuários (role/departamento). Não há operação de export ou break-glass no manifesto, logo não há step-up correspondente. |
| Fail-closed | Comportamento em que a ausência ou indisponibilidade de uma dependência **bloqueia** a operação em vez de permiti-la sem controle: backend de rate limit indisponível, storage/AV externo em produção sem adaptador aprovado e chave obrigatória ausente recusam a ação. |
| Autoridade clínica JSONB | O snapshot JSONB é a fonte que o runtime consulta hoje; a migração relacional roda como sombra expand-only até D-01 e cutover. Enquanto isso, “relacional é autoridade” é meta, não estado. |
| Packet de evidência (`evidence packet`) | Artefato com comando, data, ambiente, contagens, limitações e hash SHA-256 que sustenta um claim, indexado em `evidence-manifest.json`. É evidência local condicional e nunca aprovação clínica, hospitalar ou de produção. |
| Quality gate | Verificação executável capaz de reprovar (typecheck, lint, cobertura, documentação, rastreabilidade, matriz browser, `npm audit`, SBOM, validador de OpenAPI). Gate verde é evidência local; não converte gate humano ou clínico em aprovado. |
| D-01 a D-06 | As seis decisões humanas obrigatórias do programa: identidade institucional/ownership, estados de resultado, templates e criticidade, SLA/calendário, retenção/operação e escopo do piloto. Definição em [`build/STATE_OF_ART_TRIPLE_AAA_EXECUTIVE_PLAN.md`](build/STATE_OF_ART_TRIPLE_AAA_EXECUTIVE_PLAN.md) §8 e registro item a item em [`build/AAA_2_DECISION_REGISTER.md`](build/AAA_2_DECISION_REGISTER.md); estado `OPEN` não autoriza publicar política nem usar dado real. Não confundir com os IDs `D-001…D-014` do [`DECISION_LOG.md`](DECISION_LOG.md). |
| AAA-C / AAA-E / AAA-O | As três pernas do aceite AAA-3: **AAA-C** acurácia clínica e segurança, **AAA-E** engineering assurance, **AAA-O** availability, operação e adoção. Cada perna tem critérios próprios e nenhuma é aprovada por evidência local isolada. |
