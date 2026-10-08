# Pacote de decisões para a produção — 08/10/2026

**Para:** direção clínica, laboratório, imagem (RX e ultrassom), gestão, TI e segurança, jurídico e privacidade, patrocinador.
**De:** equipe do CVG Diagnostics Hub.
**Objetivo:** reunir em um só lugar as 12 decisões (D1–D12) que só o hospital pode tomar, com as opções, o que cada uma muda e o que o sistema faz até lá.

O sistema está tecnicamente preparado para o piloto: escala medida até 35 meses de dados, implantação ensaiada em Compose e alertas e métricas prontos. O que falta são essas decisões, o ambiente real e as validações externas: pentest, aceite dos usuários (UAT) e piloto. Nenhuma linha deste documento é uma decisão; as sugestões técnicas estão marcadas como **proposta** e só valem depois de registradas em ata no [registro de decisões](../DECISION_LOG.md).

## Como usar

1. Cada responsável lê a sua seção, que leva cerca de 10 minutos.
2. Em uma reunião por bloco (ordem abaixo), o grupo escolhe uma opção ou define outra.
3. A decisão vai para a ata, com responsável e data, e entra no registro de decisões. A equipe técnica executa os itens do [backlog](PRODUCTION_BACKLOG.md) que ela destrava.

**Ordem sugerida:** as decisões de infraestrutura e volume (D11, D2) destravam o ambiente de homologação, que leva semanas para ficar pronto; as clínicas (D3, D4, D7, D8, D10) são o caminho crítico para o piloto.

| Bloco | Decisões | Quem participa | Destrava |
| --- | --- | --- | --- |
| 1. Infraestrutura | D11, D2, D1 | TI/SRE, segurança, patrocinador, gestão | Homologação, backup com restore, monitoramento, login |
| 2. Regras clínicas | D3, D4, D7, D8, D10 | Direção clínica, laboratório, imagem, gestores | Configuração clínica do piloto |
| 3. Dados e integração | D5, D6, D9 | Jurídico/privacidade, TI, gestão clínica | Retenção LGPD, cadastro de paciente, alta e transferência |
| 4. Piloto | D12 | Patrocinador e gestão | Escopo, métricas e critério de sucesso |

---

## D1 — Como as pessoas entram no sistema

**Pergunta:** usar o login institucional (Active Directory, Microsoft Entra ID, Google ou outro provedor OIDC) ou contas próprias do Hub?

| Opção | O que muda | Prazo técnico |
| --- | --- | --- |
| **A. Login institucional (OIDC/AD)** | Uma senha a menos para o usuário; quem sai do diretório perde o acesso sozinho. Os grupos do diretório viram perfis e setores. Ficam uma ou duas contas locais de emergência, com alerta a cada uso. | 2 a 4 semanas (PROD-200), depois que a TI fornecer o cliente OIDC e o mapa de grupos |
| **B. Contas do Hub** | Já funciona: senha inicial gerada pelo servidor e trocada no primeiro acesso, troca de senha pelo próprio usuário com revogação das outras sessões, bloqueio progressivo de tentativas. Falta a redefinição por link de uso único e a lista de senhas vazadas. | 1 a 2 semanas (PROD-202, PROD-203) |

**Proposta:** A, se o hospital já tem diretório; B para o piloto, se a integração não couber no prazo.
**Responsável:** TI e segurança. **Hoje o sistema:** usa contas do Hub (B).

## D2 — Volume, disponibilidade e recuperação

**Perguntas:** quantos exames por dia (hoje e em 12 meses)? Quantas pessoas usam ao mesmo tempo no pico? Por quanto tempo o sistema pode ficar fora do ar (RTO)? Quantos minutos de dados podem ser perdidos numa falha (RPO)?

**O que já foi medido** ([relatório de escala](../RELATORIO_ESCALA_2026-10-08.md), ≈150 exames/dia):

| Dados acumulados | Lista de solicitações | Registrar um exame | Memória do app |
| --- | --- | --- | --- |
| 6 meses | 68 ms | 93 ms | ~500 MB |
| 12 meses | 124 ms | 208 ms | ~900 MB |
| 24 meses | 230 ms | 385 ms | ~1,6 GB |

**Proposta para o piloto:**
- disponibilidade de 99,5%, cerca de 3,6 h fora do ar por mês;
- RPO de 15 minutos, com backup contínuo do banco;
- RTO de 4 horas;
- retenção operacional de 24 meses no sistema, com arquivamento conforme D5.

Essas metas precisam ser demonstradas com um restore cronometrado (PROD-514).
**Responsável:** TI e gestão. **Destrava:** dimensionamento do servidor e do banco, backup (PROD-304, PROD-514), limiares de alerta (PROD-513) e meta de carga (PROD-110).

## D3 — Resultado crítico

**Perguntas:** quais valores ou achados são críticos, por exame? Quem precisa ser avisado e em quanto tempo? Se ninguém confirmar, quem é o próximo (plantão)? A notificação dentro do sistema basta ou é preciso um segundo canal (telefone, SMS, WhatsApp institucional)?

**Como o sistema funciona hoje:**
- a política fica desligada (`CRITICAL_POLICY_ENABLED=false`) até ser aprovada;
- ligada, ela exige versão, referência de aprovação e data;
- a notificação crítica exige confirmação explícita com motivo, e o tempo até a confirmação fica auditado.

**Opções:**
- **A.** Notificação interna com escalonamento para o plantão.
- **B.** A, mais um canal redundante com confirmação. Leva de 3 a 4 semanas (PROD-402).
- **C.** Piloto sem crítico no sistema, com o fluxo atual por telefone documentado e aceito por escrito pela direção clínica.

**Responsável:** direção clínica e laboratório. **Atenção:** é a única decisão com risco clínico direto; sem ela, o crítico não pode ser ligado.

## D4 — Quem pode liberar, corrigir, anular, revisar e cancelar

**Perguntas, por serviço (hemograma, bioquímica, RX, US…):**
- Quem libera o resultado?
- Quem pode corrigir depois de liberado (emenda) e quem pode anular?
- Quem cancela depois que a amostra chegou?
- O que significam "revisado", "confirmado" e "concluído" em cada setor?

**Hoje o sistema:**
- o executor do setor libera;
- a emenda exige motivo de uma lista;
- toda versão do laudo fica guardada;
- o cancelamento exige motivo.

Esses padrões ainda precisam ser confirmados ou ajustados.
**Responsável:** direção clínica e responsáveis técnicos. **Destrava:** matriz de permissões final (PROD-206, PROD-403).

## D5 — Privacidade e retenção (LGPD)

**Perguntas:**
- Por quanto tempo guardar solicitações, resultados e anexos?
- O que acontece no fim do prazo: arquivar ou excluir?
- Como atender um pedido de exportação ou exclusão do tutor?
- Quem é o contato de incidente de dados?
- Como distinguir pacientes homônimos sem expor dados demais?

**Por que importa também para o desempenho:** o sistema mantém o histórico ativo em memória. Uma regra de arquivamento (por exemplo, exames concluídos há mais de 24 meses saem do conjunto ativo) mantém o custo estável por tempo indeterminado.

**Hoje o sistema:**
- mantém tudo;
- tem retenção só técnica: sessões, chaves de repetição e mensagens processadas.

**Responsável:** jurídico e privacidade. **Destrava:** PROD-501, PROD-502 e o ciclo de vida do armazenamento de anexos (PROD-307).

## D6 — De onde vêm os pacientes e os atendimentos

**Pergunta:** existe um sistema mestre (prontuário, ERP veterinário) que deve fornecer paciente, tutor e atendimento? Ou o cadastro é feito no Hub durante o piloto?

| Opção | O que muda |
| --- | --- |
| **A. Integração** | Sem digitação dupla nem divergência. Exige a API ou a exportação do sistema mestre e um identificador externo estável. De 3 a 6 semanas, conforme o sistema (PROD-408). |
| **B. Cadastro no Hub** | Já funciona: paciente com atendimento inicial e alerta de duplicidade. Exige um procedimento escrito para conciliar com o prontuário. |

**Responsável:** TI.

## D7 — Quando o prazo (SLA) começa e quando pausa

**Perguntas:**
- O prazo de Laboratório, RX e Ultrassom começa na solicitação, no recebimento da amostra ou no agendamento?
- Pausa à noite ou em fins de semana?
- Quais são os prazos por prioridade (rotina, urgente, emergência)?

**Hoje o sistema:** o prazo começa na solicitação, corre em horas corridas, e cada serviço tem horas configuráveis por prioridade.
**Responsável:** gestores de cada setor. **Destrava:** PROD-404 e os indicadores de atraso do painel.

## D8 — Amostra, accession e etiqueta

**Perguntas:**
- Uma amostra pode servir a mais de um exame?
- Como é o código de accession hoje: formato, sequência e quem gera?
- Há impressora de etiqueta ou leitor de código de barras?

**Hoje o sistema:**
- uma amostra pode atender vários itens da mesma solicitação;
- o accession é informado no recebimento e não pode se repetir;
- a recoleta preserva a cadeia de amostras.

**Responsável:** laboratório. **Destrava:** PROD-405.

## D9 — Alta, transferência e atendimento encerrado

**Perguntas:** o que acontece com exames pendentes quando o paciente recebe alta ou é transferido? Quem recebe o resultado que chega depois? É possível solicitar exame para um atendimento encerrado?

**Hoje o sistema:**
- registra internação, leito e responsável;
- mantém os exames pendentes com o solicitante original.

**Responsável:** gestão clínica e TI. **Destrava:** PROD-406.

## D10 — Catálogo inicial

**Pergunta:** quais exames entram no piloto, com que campos de resultado, unidades e faixas de referência (por espécie, se for o caso)? RX e US precisam de anexo de imagem ou só do laudo? O ultrassom já tem agenda em outro sistema?

**Hoje o sistema:**
- tem um catálogo de demonstração;
- tem modelo de painel numérico versionado;
- aceita anexos PDF, JPEG e PNG com antivírus;
- tem agenda de procedimentos própria.

**Responsável:** responsáveis técnicos de cada setor. **Destrava:** PROD-407 e PROD-409. O cadastro é feito pela tela de administração, sem programação.

## D11 — Onde o sistema vai rodar

**Perguntas:**
- Nuvem ou servidor do hospital?
- O PostgreSQL será gerenciado (com recuperação a um ponto no tempo) ou instalado no servidor?
- Qual armazenamento S3 para anexos e qual antivírus?
- Onde ficam os segredos?
- Qual domínio e certificado?
- Quem opera e quem atende fora do horário?

**Proposta para o piloto:**
- um servidor dedicado com o Compose já ensaiado;
- um ambiente de homologação separado;
- PostgreSQL com backup contínuo e cópia fora do servidor;
- S3 com criptografia e versionamento;
- antivírus real;
- 2 GB de memória para o app e 1 GB para o worker.

Um servidor único significa ficar fora do ar durante falha ou manutenção, o que precisa caber no RTO de D2.
**Responsável:** TI/SRE e patrocinador. **Destrava:** PROD-301 a PROD-309, PROD-303 (pipeline de implantação) e PROD-511 a PROD-516 (monitoramento, backup, plantão).

## D12 — O piloto

**Perguntas:**
- Quais setores e quantas pessoas participam?
- Por quantas semanas?
- O que define sucesso? Por exemplo: tempo da solicitação ao resultado, recoletas, pendências esquecidas, satisfação.
- Qual é o número de hoje (baseline) para comparar?
- Qual é a contingência se o sistema falhar?

**Proposta:**
- **Escopo:** Laboratório e Internação, de 15 a 25 pessoas, por 4 a 6 semanas.
- **Contingência:** fluxo em papel ativo.
- **Decisão de continuar:** por escrito, ao final, com os números lado a lado.

**Responsável:** patrocinador e gestão. **Destrava:** PROD-703 e PROD-704.

---

## O que não depende de decisão e já está pronto

- **Escala:** um ano de dados com lista em cerca de 0,1 s e registro em cerca de 0,2 s. O teto antigo de armazenamento foi removido (D-030).
- **Segurança:**
  - perfis por setor;
  - auditoria imutável;
  - proteção contra CSRF;
  - limite de tentativas;
  - antivírus nos anexos;
  - troca de senha com revogação das outras sessões (D-031).
- **Operação:**
  - implantação em Compose ensaiada de ponta a ponta;
  - backup com restore testado;
  - métricas e 9 alertas testados;
  - runbooks de incidente;
  - varredura de dados pessoais na CI.

## Depois das decisões

| Etapa | Depende de |
| --- | --- |
| Homologação no ambiente real, com monitoramento e restore cronometrado | D2, D11 |
| Configuração clínica (catálogo, permissões, crítico, prazos) | D3, D4, D7, D8, D10 |
| Teste de invasão externo e revisão independente | Código congelado |
| Aceite dos usuários (UAT) e treinamento | Configuração clínica |
| Piloto e decisão de continuar | D12, UAT |

## Modelo de ata

```text
Decisão: D_ — <título>
Data: __/__/2026     Responsável: <nome, cargo>     Participantes: <nomes>
Opção escolhida: <A/B/C ou descrição>
Justificativa: <por quê>
Condições ou ressalvas: <prazos, exceções, o que precisa ser revisto e quando>
Itens destravados no backlog: <PROD-___>
```

---

## Ata de 08/10/2026

**Responsável:** Ricardo Akinaga, dono do produto, que assinou as 12 decisões, inclusive as clínicas (D3, D4, D7, D8, D9) e a de privacidade (D5).
**Registro:** [D-032](../DECISION_LOG.md).
**Execução:** os efeitos estão no [backlog](PRODUCTION_BACKLOG.md).

| Decisão | Opção escolhida | Consequência técnica | Entrada que ainda falta |
| --- | --- | --- | --- |
| D1 Login | Contas do Hub no piloto | Redefinição por link de uso único e lista de senhas vazadas (PROD-202, PROD-203); login institucional reavaliado depois do piloto (PROD-200) | — |
| D2 Volume | Até 150 exames/dia; RTO 4 h, RPO 15 min | Padrões de memória atuais cobrem cerca de 2 anos; RPO de 15 min exige arquivamento contínuo do banco (WAL) para fora do servidor (PROD-304) e restore cronometrado (PROD-514) | Número exato de exames/dia e pico de usuários simultâneos, para a meta de carga (PROD-110) |
| D3 Crítico | Notificação no sistema + WhatsApp Business como canal redundante, com escalonamento ao plantão | Canal WhatsApp com confirmação pelo link do Hub (PROD-402, 3 a 4 semanas); política ativada só com a lista aprovada (PROD-401). Sem SMS de reserva: quem está de plantão precisa de internet no celular | Lista de valores e achados críticos por exame; fornecedor da API do WhatsApp e templates aprovados; escala de plantão |
| D4 Laudos | Padrão atual (executor do setor libera; correção e anulação com motivo e versões) | Nenhuma mudança; cada setor confirma a matriz no UAT (PROD-206, PROD-403) | — |
| D5 Retenção | 24 meses ativo, depois arquivo; exclusão no fim do prazo legal | Arquivamento de exames concluídos há mais de 24 meses e expurgo no prazo legal, inclusive anexos (PROD-501, PROD-502, PROD-307) | Prazo legal de guarda (jurídico, com base nas regras do CFMV) |
| D6 Pacientes | Cadastro no Hub no piloto | Procedimento escrito de conferência com o prontuário (PROD-408) | Nome do sistema de prontuário atual, se houver, para a conferência |
| D7 Prazo | Desde a solicitação, horas corridas | Comportamento atual; calendário e pausas não são necessários (PROD-404) | Horas por prioridade de cada serviço, no catálogo (D10) |
| D8 Amostra | Código gerado pelo sistema, com etiqueta | Geração do accession, etiqueta com código de barras e leitura no recebimento (PROD-405, 1 a 3 semanas) | Modelo da impressora de etiquetas e do leitor; formato da etiqueta |
| D9 Alta | Pendências seguem com o solicitante | Já funciona. **Correção:** hoje o sistema não impede nova solicitação em atendimento encerrado e não tem como abrir um novo atendimento para paciente já cadastrado; as duas coisas entram juntas (PROD-406) | — |
| D10 Catálogo | Planilha-modelo importada com validação | Planilha por serviço e importação repetível em homologação e produção (PROD-407) | Planilhas preenchidas pelos responsáveis técnicos de cada setor |
| D11 Infraestrutura | Servidor do hospital | Compose ensaiado no servidor local, homologação separada, MinIO e ClamAV locais, backup fora do prédio (PROD-301 a PROD-309) | Especificação do servidor (mínimo 4 vCPU, 8 GB, SSD), local da cópia externa, domínio e certificado, quem opera e quem atende fora do horário |
| D12 Piloto | Todos os setores (Lab, RX, US, Internação), 6 a 8 semanas | Exige o catálogo completo, o crítico com WhatsApp e as etiquetas prontos antes do início; métricas: tempo até o resultado, pendências atrasadas, recoletas (medidas pelo sistema) e satisfação da equipe (questionário) | Datas, participantes por setor, número de hoje (baseline) de cada métrica |

**Hipótese a confirmar:** com o ultrassom no piloto e nenhuma agenda externa informada, o piloto usa a agenda de procedimentos do próprio Hub (OQ-009).

**Ainda aberta:** a regra para distinguir pacientes homônimos sem expor dados demais (OQ-019, parte de D5) não entrou nesta rodada; até lá vale o alerta de duplicidade do cadastro.

**Riscos aceitos nesta ata:**
- **Infraestrutura (D11 com D2):** servidor único no hospital com RTO de 4 h. Uma falha de hardware só cabe nesse prazo se houver máquina de reserva e cópia externa testada.
- **Canal do crítico (D3):** sem SMS de reserva, o WhatsApp depende de dados móveis; o escalonamento ao plantão e a caixa de entrada do Hub são a contingência.
- **Escopo do piloto (D12):** todos os setores aumentam o escopo e o treinamento e tornam o início dependente de PROD-402, PROD-405 e PROD-407.
