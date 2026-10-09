# Plantão, contatos de incidente e janela de manutenção

**Knowledge status:** `DECISION/PROPOSAL` operacional (PROD-516, decisão D11). É um **modelo a preencher**: o hospital ainda não informou nomes, telefones nem aprovou prazos e janela. Nenhuma pessoa está designada neste documento.

**Relacionados:** [runbooks de incidentes](INCIDENT_RUNBOOKS.md) · [alertas](OBSERVABILITY.md) (§5 Alerts/runbooks) · [deploy](DEPLOYMENT.md) · [backup e restore](BACKUP_RESTORE.md) · [decisão D11](../build/PACOTE_DECISOES_2026-10-08.md)

## 1. Escala de plantão técnico

Preencha uma linha por período. Telefone: número de plantão do hospital, nunca pessoal sem autorização. Registre a escala em lugar acessível à recepção e à gestão clínica.

| Papel | Nome | Telefone | Período (início - fim) |
| --- | --- | --- | --- |
| Plantão técnico titular | ____ | ____ | ____ |
| Plantão técnico reserva | ____ | ____ | ____ |
| Plantão técnico titular (próximo período) | ____ | ____ | ____ |

Regras propostas: a troca de plantão é registrada com passagem de bastão (incidentes abertos, deploys previstos); nunca fica um período sem titular e reserva; quem sai confirma por escrito que o substituto recebeu o aviso.

## 2. Contatos de incidente e ordem de escalonamento

| Ordem | Função | Nome | Telefone | E-mail | Quando acionar |
| --- | --- | --- | --- | --- | --- |
| 1 | Plantão técnico | ____ | ____ | ____@exemplo.example | Qualquer alerta ou incidente |
| 2 | TI do hospital | ____ | ____ | ____@exemplo.example | Servidor, rede, energia, certificado, armazenamento |
| 3 | Responsável pelo produto | ____ | ____ | ____@exemplo.example | Decisão de manter degradação, rollback ou reabrir tráfego |
| 4 | Responsável clínico (direção clínica) | ____ | ____ | ____@exemplo.example | Qualquer impacto na assistência ou resultado crítico sem destinatário |
| 5 | Encarregado de proteção de dados (DPO) | ____ | ____ | ____@exemplo.example | Suspeita de vazamento ou acesso indevido |

Os endereços acima são só exemplo de formato. Se o primeiro contato não confirmar em 15 minutos (proposta), acione o seguinte da lista.

## 3. Severidade e tempos de resposta (proposta, a aprovar)

Alinhada à classificação P0/P1/P2 da "Triagem comum" em [INCIDENT_RUNBOOKS](INCIDENT_RUNBOOKS.md). Os tempos são conservadores e **não foram aprovados**.

| Severidade | Exemplo | Reconhecer | Primeira ação | Atualização a cada |
| --- | --- | --- | --- | --- |
| P0 segurança clínica | Possível vazamento, resultado incorreto, crítico sem destinatário | 15 min, a qualquer hora | 30 min | 30 min |
| P1 disponibilidade | `/readyz` falha, banco ou storage fora, backup falho, outbox envelhecido | 30 min, 24 h por dia no piloto | 1 h | 1 h |
| P2 experiência | Lentidão, reconexão em massa, falha visual localizada | 4 h no horário comercial | Próximo dia útil | Diária |

Aprovação dos tempos: ____________ data ____/____/______

## 4. Fluxo do incidente

1. O alerta ([OBSERVABILITY §5](OBSERVABILITY.md)) ou um usuário aciona o plantão técnico.
2. O plantão classifica a severidade, abre o registro (correlation ID, horário UTC, versão, ambiente, operador) e executa o runbook correspondente em [INCIDENT_RUNBOOKS](INCIDENT_RUNBOOKS.md).
3. Escalona pela ordem da seção 2 conforme a severidade e os tempos da seção 3.
4. A gestão clínica avisa a equipe sobre a comunicação alternativa enquanto o Hub estiver degradado.
5. Fechamento conforme "Fechamento do incidente" em [INCIDENT_RUNBOOKS](INCIDENT_RUNBOOKS.md).

Não copie dados de pacientes, credenciais ou anexos para tickets e mensagens.

## 5. Janela de manutenção (proposta, a aprovar)

O piloto roda em servidor único: manutenção significa indisponibilidade, que deve caber no RTO de [BACKUP_RESTORE](BACKUP_RESTORE.md) (§2 Proposed pilot targets).

| Item | Proposta |
| --- | --- |
| Dia e horário | Uma janela semanal de baixo movimento: ____________ (a definir pelo hospital), duração máxima ____ min |
| Aviso | Mínimo de 2 dias úteis à gestão clínica e aos setores; aviso de lembrete no início do dia |
| Responsável pela janela | Plantão técnico titular, com a TI do hospital de sobreaviso |
| Emergência | Correção urgente fora da janela só com autorização do responsável pelo produto e aviso à gestão clínica |
| Aprovação | ____________ data ____/____/______ |

Atividades que usam a janela:

| Atividade | Onde está o procedimento |
| --- | --- |
| Release pelo pipeline: homologação recebe sozinha; produção só depois da aprovação do ambiente `production` e aplica pelo `deploy/release/deploy.sh` (backup, migrate, `up`, saúde) | [DEPLOYMENT §11](DEPLOYMENT.md#11-pipeline-de-release-prod-303) |
| Release com migrations de cutover coordenado: `deploy/release/deploy.sh --maintenance` (para `proxy app worker backup`, backup, `migrate` sozinho, `up`) | [DEPLOYMENT §11](DEPLOYMENT.md#11-pipeline-de-release-prod-303) e [§4.1](DEPLOYMENT.md) |
| Atualização manual, sem o pipeline (backup antes, `up -d`) | [DEPLOYMENT §4](DEPLOYMENT.md) |
| Verificação após o deploy | [DEPLOYMENT §5](DEPLOYMENT.md) |
| Rollback, se necessário | [DEPLOYMENT §8](DEPLOYMENT.md) |
| Ensaio de restore (mensal em homologação, trimestral no servidor real) | [BACKUP_RESTORE §5](BACKUP_RESTORE.md) |
| Conferência do backup e da cópia externa | [DEPLOYMENT §10](DEPLOYMENT.md) |

Produção só recebe uma release dentro da janela: quem aprova o ambiente `production` no GitHub faz isso no horário combinado, e o timer do servidor aplica a release em até 5 minutos. Uma release com migration de cutover coordenado (§4.1) sempre usa `--maintenance` e a janela. Enquanto o pipeline não estiver ligado (`RELEASE_PUBLISH_ENABLED`), o deploy é manual pelo §4.

## 6. Preenchimento pendente

Nomes e telefones das seções 1 e 2; aprovação dos tempos da seção 3; dia, horário e aprovação da janela da seção 5. Enquanto faltarem, o item PROD-516 fica em `VERIFY` e o PROD-513 (alertas com dono) segue bloqueado.
