# Pedidos do titular (LGPD)

**Knowledge status:** `DECISION/PROPOSAL` operacional (PROD-502, decisão D5, [D-048](../DECISION_LOG.md)). A exportação está implementada e testada. O prazo legal de guarda, o nome do encarregado de dados e a aprovação deste procedimento dependem do hospital e do jurídico.

**Relacionados:** [decisão D5](../build/PACOTE_DECISOES_2026-10-08.md) · [arquivo clínico e expurgo](CLINICAL_ARCHIVE.md) · [cadastro de pacientes no piloto](PATIENT_REGISTRATION_PILOT.md) · [plantão e contatos](ON_CALL_AND_MAINTENANCE.md)

## 1. Quem é o titular e por onde chega o pedido

O titular dos dados pessoais é o **tutor** do animal. O Hub guarda pouco dele: o rótulo abreviado do tutor no cadastro do paciente. O resto (exames, resultados, laudos) é o registro clínico do paciente, que o tutor tem direito de receber.

O pedido chega pelo **encarregado de dados** do hospital, nunca direto no Hub:

| Item | Valor |
| --- | --- |
| Encarregado de dados | ____________ (a definir pelo hospital) |
| Canal do pedido | ____________ (e-mail ou formulário do hospital) |
| Quem opera a exportação no Hub | um ADMIN designado: ____________ |
| Prazo de resposta | 15 dias (LGPD, art. 19, II), salvo orientação do jurídico |

O encarregado confere a identidade do tutor e o vínculo com o paciente **fora do Hub**, antes de pedir a exportação.

## 2. Exportação (acesso e portabilidade)

1. O encarregado entrega ao ADMIN o **número do prontuário** do paciente (o `externalId` cadastrado, [PATIENT_REGISTRATION_PILOT §4](PATIENT_REGISTRATION_PILOT.md)). Se o tutor tem mais de um animal, é um pedido por prontuário.
2. O ADMIN abre **Administração → Privacidade (LGPD) → Exportar dados do titular**, informa o prontuário e confirma a própria senha. A senha é exigida a cada exportação (reautenticação de até 10 minutos).
3. O navegador baixa `titular-<prontuário>-<data>.json`. O conteúdo não aparece na tela.
4. O ADMIN entrega o arquivo ao encarregado por canal seguro, e o encarregado o entrega ao tutor.
5. Cada exportação gera o evento de auditoria `PatientDataExported`, com quem exportou, o paciente e a quantidade de solicitações ativas e arquivadas. Recusas não geram o evento. Depois de reunir o histórico, o servidor revalida a sessão, o usuário ativo, o perfil ADMIN, a permissão e a reautenticação na transação final: revogar a sessão, desativar a conta, mudar o perfil ou deixar vencer o step-up durante a leitura impede a entrega do arquivo.

**O que o arquivo traz** (formato `cvg-hub.patient-data-export.v1`):
- o cadastro do paciente;
- os atendimentos e as internações;
- todas as solicitações, **ativas e arquivadas**, da mais nova para a mais antiga, cada uma com seus exames, amostras, resultados liberados com o histórico de versões (inclusive as substituídas e as invalidadas, com o status) e a lista dos anexos.

**O que fica de fora**, e o próprio arquivo diz isso no campo `omitted`:
- identidade da equipe (nomes, e-mails, identificadores);
- rascunhos nunca liberados;
- trilha de auditoria interna e notificações da equipe;
- conteúdo dos anexos.

Se o tutor pedir os laudos em PDF, o hospital os entrega à parte, pela área do paciente, usando a lista de anexos do arquivo.

Pela API: `GET /api/v1/data-subject-exports?externalId=<prontuário>` (permissão `patient.data_export`, só o ADMIN, depois de `POST /api/v1/session/reauth`). Detalhes em [API_SPEC](../api/API_SPEC.md).

## 3. Correção

O cadastro do paciente vem do prontuário. Um dado errado é corrigido **no prontuário** e depois no Hub, pelo procedimento de divergência do [cadastro no piloto](PATIENT_REGISTRATION_PILOT.md) (§6). O Hub não tem tela para editar ou apagar paciente; a correção é feita pela TI, com registro.

## 4. Exclusão

A D5 decidiu manter o registro **24 meses ativo, depois em arquivo, e excluir só no fim do prazo legal de guarda**. O prontuário veterinário tem guarda obrigatória (CFMV), e a LGPD permite manter os dados para cumprir obrigação legal (art. 16, I). Por isso:

- um pedido de exclusão **antes** do fim do prazo é respondido pelo encarregado com essa base legal, informando quando a exclusão acontecerá;
- a exclusão acontece pelo **expurgo** do arquivo clínico ([CLINICAL_ARCHIVE](CLINICAL_ARCHIVE.md)), que remove as linhas do registro e os objetos dos anexos. Ele está **desligado** até o jurídico definir o prazo (`ARCHIVE_PURGE_AFTER_MONTHS`);
- o expurgo automático remove somente os registros do arquivo clínico e seus anexos. **Ele preserva o cadastro do paciente, os atendimentos e as internações**; não há exclusão automática dessas entidades. O encarregado deve encaminhar qualquer pedido de exclusão ou minimização desses dados à TI e ao jurídico para definir, autorizar e registrar o procedimento, considerando vínculos ativos, obrigações de guarda e backups. Um cadastro sem registros também segue esse procedimento.

| Item | Valor |
| --- | --- |
| Prazo legal de guarda | ____________ meses (a definir pelo jurídico, com base nas regras do CFMV) |
| `ARCHIVE_PURGE_AFTER_MONTHS` configurado em | ____/____/______ |

## 5. Registro dos pedidos

O encarregado mantém o registro de cada pedido **fora do Hub**, porque o pedido contém dados do tutor que o Hub não guarda.

| Data do pedido | Tipo (acesso, correção, exclusão) | Prontuário | Data da resposta | Exportação (data e evento de auditoria) | Responsável |
| --- | --- | --- | --- | --- | --- |
| ____/____/______ | ________ | ________ | ____/____/______ | ________ | ________ |

## 6. Pendente do hospital

- nome do encarregado de dados e canal do pedido;
- ADMIN designado para a exportação;
- prazo legal de guarda, que liga o expurgo;
- procedimento aprovado para cadastros de pacientes, atendimentos, internações e cópias de backup que o expurgo do arquivo não exclui;
- aprovação deste procedimento pelo jurídico.

Enquanto faltarem, o PROD-502 fica em `VERIFY`.
