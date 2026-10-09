# Cadastro de pacientes no piloto e conferência com o prontuário

**Knowledge status:** `DECISION/PROPOSAL` operacional (PROD-408, decisão D6 opção B: cadastro no Hub durante o piloto). O procedimento está escrito; nomes, sistema de prontuário e aprovação da gestão clínica dependem do hospital. A regra final para homônimos (OQ-019) segue aberta.

**Relacionados:** [decisão D6](../build/PACOTE_DECISOES_2026-10-08.md) · [D-036 (atendimentos)](../DECISION_LOG.md) · [OQ-019](../discovery/OPEN_QUESTIONS.md) · [backlog](../build/PRODUCTION_BACKLOG.md)

## 1. Princípio

No piloto o Hub **não** é integrado ao prontuário. O paciente é cadastrado duas vezes: no prontuário (fonte oficial) e no Hub (para pedir e acompanhar exames). Por isso a conferência diária é obrigatória. Se o Hub e o prontuário divergirem, vale o prontuário.

| Item | Valor |
| --- | --- |
| Sistema de prontuário | ____________ (a definir pelo hospital) |
| Responsável pelo cadastro no Hub | ____________ (a definir pelo hospital) |
| Responsável pela conferência diária | ____________ (a definir pelo hospital) |
| Substituto da conferência | ____________ (a definir pelo hospital) |
| Aprovação da gestão clínica | ____________ data ____/____/______ |

## 2. Quem cadastra e quando

- Cadastra quem tem a permissão `patient.create`: veterinário e equipe de internação.
- Cadastre **depois** de o paciente existir no prontuário, para copiar dele o número do registro. Nunca invente o identificador.
- Cadastre antes do primeiro pedido de exame. Sem paciente e sem atendimento aberto não há como solicitar exame.
- Emergência: se não der tempo de abrir o prontuário, cadastre no Hub sem `externalId` (o Hub gera um código `CVG-…`), anote o código e complete a correção em até o fim do turno (seção 6).

## 3. Antes de criar: busque

1. Busque o paciente no Hub (campo de busca de pacientes) pelo número do prontuário e, depois, pelo nome.
2. Se achou o mesmo paciente: **não crie outro**. Use o cadastro existente. Se ele não tem atendimento aberto, siga a seção 5.
3. Se não achou: crie.

O Hub recusa um segundo cadastro com o mesmo `externalId` (erro 409, "Já existe um paciente com este identificador"). Esse é o único bloqueio automático. O Hub **não** detecta sozinho nome repetido: a conferência é humana.

### Homônimos (regra provisória)

A OQ-019 (como distinguir homônimos sem expor dados demais) está **aberta**. Até o hospital decidir, considere que é o mesmo paciente só se **tutor, espécie, data de nascimento e número do prontuário** conferirem com o prontuário. Se um deles divergir, trate como pacientes diferentes e peça confirmação ao responsável antes de pedir exame. O Hub mostra espécie, sexo, tutor abreviado e o identificador para ajudar a distinguir.

Regra final: ____________ (a definir pelo hospital, OQ-019).

## 4. Campos do cadastro

| Campo no Hub | Como preencher | Obrigatório |
| --- | --- | --- |
| Identificador externo (`externalId`) | Número do registro no prontuário, copiado sem alteração. Letras, números, ponto, hífen e sublinhado; até 100 caracteres; o Hub converte para maiúsculas. Sem espaços | Não, mas **obrigatório por este procedimento** |
| Nome | Nome do animal como está no prontuário (2 a 120 caracteres) | Sim |
| Espécie | Como no prontuário (ex.: Canino, Felino) | Sim |
| Raça | Como no prontuário; SRD quando não definida | Sim |
| Sexo | Como no prontuário | Sim |
| Data de nascimento | Do prontuário; se for estimada, a estimativa do prontuário | Não, mas preencha |
| Tutor (rótulo) | Nome abreviado do tutor, como no prontuário (ex.: "A. Oliveira"). Não digite telefone, CPF ou endereço | Sim |
| Tipo de atendimento | Internação, emergência ou ambulatorial | Sim |
| Ala e leito | Só para internação; devem ficar vazios nos outros tipos | Internação |

O cadastro cria o paciente e o atendimento inicial juntos.

## 5. Paciente que volta: novo atendimento

Cada paciente tem **no máximo um atendimento aberto** (D-036). Solicitar exame em atendimento encerrado é recusado (`409 ENCOUNTER_CLOSED`). Para um paciente que retorna:

1. Busque o paciente (seção 3). Não cadastre de novo.
2. Se ele não tem atendimento aberto, use "Novo atendimento" (`POST /patients/{id}/encounters`). Exige a permissão `encounter.manage` (veterinário, equipe de internação, gerente delegado).
3. Quando o atendimento termina, encerre-o (`POST /encounters/{id}/close`). O encerramento dá alta à internação aberta e **não cancela exames pendentes**: eles continuam com quem solicitou.

## 6. Conferência diária com o prontuário

| Quando | Quem | O que se compara |
| --- | --- | --- |
| Fim de cada turno, ou ao menos uma vez ao dia | Responsável da seção 1 | Pacientes cadastrados no Hub no período contra os do prontuário |

Para cada paciente cadastrado no período, compare: número do registro (`externalId`), nome, espécie, raça, sexo, data de nascimento e tutor. Compare também os atendimentos abertos: todo paciente com atendimento aberto no Hub deve estar em atendimento no prontuário.

### Divergência

1. Registre no formulário da seção 8: data, paciente (identificador), campo divergente, valor no Hub, valor no prontuário, quem conferiu.
2. O prontuário vale. Corrija o Hub **somente pelas ações que existem**:
   - atendimento aberto por engano ou já terminado: encerre (`close`);
   - paciente cadastrado em duplicidade ou com identificador errado: o Hub não tem tela nem operação para editar ou apagar paciente. Pare de usar o cadastro errado, use o correto e comunique o gerente do piloto e a TI para correção fora do Hub. Não peça exames no cadastro errado;
   - exames já pedidos no cadastro errado: o gerente decide o tratamento (cancelamento com motivo pelo fluxo normal de exames).
3. Registre quem corrigiu e quando. Divergências repetidas na mesma semana vão para a reunião do piloto.

## 7. Prontuário fora do ar (contingência)

1. Continue o atendimento. Não bloqueie exame por falta do prontuário.
2. Cadastre no Hub sem `externalId` (o Hub gera `CVG-…`) e anote em papel: código gerado, nome, espécie, tutor, data e hora.
3. Quando o prontuário voltar, no mesmo turno, confira cada paciente anotado e aplique a seção 6. Como o Hub não edita o identificador, se o número do prontuário diferir do código `CVG-…`, registre a correspondência no formulário da seção 8 e avise a TI.
4. Se o **Hub** estiver fora do ar, siga os [runbooks de incidentes](INCIDENT_RUNBOOKS.md) e a comunicação alternativa aprovada; ao voltar, cadastre os pacientes pendentes.

## 8. Formulário de divergência

| Data | Identificador | Campo | Valor no Hub | Valor no prontuário | Conferido por | Corrigido por / data |
| --- | --- | --- | --- | --- | --- | --- |
| ____/____/______ | ________ | ________ | ________ | ________ | ________ | ________ |

## 9. Checklist

- [ ] O paciente está no prontuário e copiei o número do registro.
- [ ] Busquei por número e por nome antes de criar.
- [ ] Homônimo: tutor, espécie, nascimento e registro conferem (regra provisória).
- [ ] Preenchi `externalId`, nome, espécie, raça, sexo, nascimento e tutor como no prontuário.
- [ ] Paciente que volta: abri "Novo atendimento" em vez de cadastrar de novo.
- [ ] Fim do turno: conferência feita e divergências registradas.
- [ ] Contingência: pacientes sem `externalId` conferidos assim que o prontuário voltou.

## 10. Pendente do hospital

Nome do sistema de prontuário; responsáveis e substitutos; regra final de homônimos (OQ-019); aprovação da gestão clínica. Enquanto faltarem, o item PROD-408 fica em `VERIFY`.
