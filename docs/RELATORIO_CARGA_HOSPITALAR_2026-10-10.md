# Relatório de carga hospitalar, falhas e soak — 10/10/2026

**Origem:** auditoria de 10/10/2026, bloqueador 4 ("a persistência clínica ainda tem um gargalo global [...] o impacto sob carga hospitalar precisa ser medido"). **Decisões:** [D-059](DECISION_LOG.md) (escrita sem mudança e worker ocioso) e [D-061](DECISION_LOG.md) (leitura auditada fora da fila, métrica e alerta da fila, critério para o PROD-111). **Relatório anterior:** [carga com 12 meses, 09/10](RELATORIO_CARGA_2026-10-09.md).

## 1. O que a auditoria apontou e o que mudou

Toda escrita clínica passa por uma fila serial em processo e pela linha única `cvg_runtime_state` (o snapshot com o núcleo clínico; auditoria e outbox já ficam em tabelas próprias desde o PROD-101/102). Três consequências medidas:

1. **O worker ocioso regravava o estado** a cada 5 s (`outbox-probe`: versão 1 → 2 sem mensagens), entrava na fila de escrita e varria o histórico de eventos sob o lock. Corrigido no D-059: transação sem mudança não grava e o ciclo ocioso não pega o lock.
2. **Abrir um laudo era uma escrita.** `GET /results/{id}`, o relatório e o histórico de versões gravam o evento de auditoria de acesso pela mesma transação das escritas clínicas: o médico que abre um resultado espera na fila atrás de quem libera exames, e vice-versa. Na primeira medição, a 100× o pico, abrir um resultado levava p50 de 5,3 s. Corrigido no D-061: a leitura responde do snapshot atual e grava a auditoria direto na tabela `audit_events`, antes de responder, sem versão nova e sem a fila.
3. **A fila não era observável em produção.** Agora há `cvg_write_queue_in_flight`, `cvg_write_queue_wait_ms` e `cvg_write_transaction_ms`, e o alerta `CvgWriteQueueSaturated` (espera média acima de 400 ms por 10 minutos) com runbook ([Fila de escrita saturada](operations/INCIDENT_RUNBOOKS.md#fila-de-escrita-saturada)).

## 2. Como a carga foi montada

`npm run perf:hospital` (`scripts/perf-hospital.ts`) sobe o build de produção do Next, o **worker real** (`scripts/outbox-worker.ts`, sink PostgreSQL, ciclo de 5 s) e um PostgreSQL descartável semeado com o histórico da D2:

| Item | Valor |
| --- | --- |
| Histórico | 12 meses a 150 exames/dia: 27.375 solicitações, 54.750 exames, 6.844 pacientes, 109 mil eventos clínicos + 100 mil de auditoria |
| Profissionais simultâneos | 30 veterinários, 6 técnicos de laboratório, 3 da radiologia, 3 gestores (dos três setores), cada um atualizando a própria tela a cada ~20 s: painel, notificações e solicitações; filas do laboratório e da radiologia; visão gerencial |
| Tempo real | 30 conexões SSE abertas |
| Jornada clínica | solicitação → recebimento da amostra e início do processamento (laboratório) ou início e realização do procedimento (RX, 30%) → rascunho → liberação → o solicitante abre o resultado, registra a visualização, espera a notificação chegar pelo worker e a confirma. 8 a 9 escritas por exame, com 1 a 4 s entre os passos |
| Heap | 1.280 MB no app e 768 MB no worker, como no `docker-compose.prod.yml` |

**Pico D2 (o "1×"):** 150 exames num dia de 12 horas, com a hora mais cheia valendo 3 vezes a média, dá **37,5 exames por hora**. É uma premissa: o hospital ainda não informou o pico de usuários simultâneos (D2). Os níveis multiplicam essa taxa de chegada (Poisson, semente fixa) e cada um dura 3 minutos.

**Metas:** p95 de 500 ms para leitura e 800 ms para escrita (PRD NFR-PERF-001/002), erro até 1%.

Ambiente: um host de 16 vCPUs e 64 GB com o app, o worker, o PostgreSQL e o gerador de carga juntos, e outros ensaios rodando em paralelo. Os números são relativos a esse host, não ao servidor do hospital.

## 3. Resultados por nível

Com as correções do D-059 e do D-061:

| Nível | Exames/h | Escritas/s | Leitura p95 | Escrita p95 | Erros | Metas |
| ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1× | 37,5 | 0,04 | 99 ms | 227 ms | 0 | dentro |
| 10× | 375 | 0,64 | 119 ms | 241 ms | 0 | dentro |
| 25× | 937 | 1,28 | 133 ms | 268 ms | 0 | dentro |
| 50× | 1.875 | 4,17 | 271 ms | 586 ms | 0 | dentro |
| 100× | 3.750 | 6,51 | 524 ms | 3.848 ms | 0 | fora (fila saturada) |

Antes da leitura auditada sair da fila (mesma carga, sem limite de heap):

| Nível | Leitura p95 | Escrita p95 | Abrir resultado p50 / p95 |
| ---: | ---: | ---: | ---: |
| 10× | 146 ms | 360 ms | 71 ms / 1.098 ms |
| 25× | 800 ms | 1.278 ms | 128 ms / 1.659 ms |
| 50× | 570 ms | 1.710 ms | 228 ms / 1.586 ms |
| 100× | 6.529 ms | 13.630 ms | 5.341 ms / 12.565 ms |

**Leitura dos números:**

- **Margem sobre a D2: 50 vezes o pico estimado** dentro das metas, contra 10 vezes antes do D-061. No pico D2 (1×) todas as rotas ficam abaixo de 230 ms no p95.
- **Onde a fila satura:** cerca de 6,5 escritas por segundo neste host, ou seja, cerca de 160 vezes a taxa de escrita do pico D2 (0,04/s). Acima disso, a espera na fila domina (a 100×, toda escrita leva ~1,8 s no p50).
- **As leituras não esperam a fila:** mesmo a 100×, painel, listas e filas ficam perto de 500 ms no p95; só as escritas sobem.
- **O PostgreSQL não é o gargalo:** no máximo 1 sessão esperando lock em 470 amostras. A serialização acontece antes, na fila do processo, que é o que as métricas novas mostram.
- **Memória do app** oscilou entre 340 e 540 MB de RSS com o heap limitado a 1.280 MB. A primeira rodada, sem limite, subiu até 1 GB só porque o V8 adia a coleta quando tem memória sobrando.
- **Integridade:** 353 jornadas completas, nenhuma solicitação perdida ou duplicada, todos os 353 resultados liberados com a notificação entregue uma vez.

## 4. Falhas sob carga

Mesma montagem, a 25× o pico D2 (cerca de 940 exames por hora), com três falhas em sequência, um minuto de carga normal entre elas:

1. **app morto com `SIGKILL`** (como um contêiner que cai) e iniciado de novo depois de 5 s;
2. **worker morto com `SIGKILL`** (o grupo de processos inteiro) e iniciado de novo depois de 15 s;
3. **PostgreSQL reiniciado** (`docker restart`) com o app e o worker no ar.

As jornadas em andamento repetem o passo que falhou com a **mesma chave de idempotência**, como o cliente faz. Duas rodadas completas (sementes diferentes):

| Falha | Volta a responder | Requisições que falharam durante a falha | Observação |
| --- | ---: | ---: | --- |
| App morto | 6,8 s e 6,8 s | 40 e 43 (conexão recusada, repetidas) | o app sobe e lê o estado do banco |
| Worker morto | fila de notificações zerada em 23 s e 18 s | 0 | entregas em atraso, nenhuma perdida; ninguém percebe além do atraso |
| PostgreSQL reiniciado | 1,5 s e 2,2 s | 6 e 0 (`503 DEPENDENCY_UNAVAILABLE`) | o app e o worker reconectam sozinhos, sem reinício |

**Integridade nas duas rodadas** (84 e 90 jornadas): toda solicitação confirmada existe no banco, nenhuma foi aplicada duas vezes, todos os resultados liberados tiveram a notificação entregue exatamente uma vez (uma linha por notificação em `notification_deliveries`) e todas as jornadas terminaram.

Na primeira tentativa, o próprio harness matava só o processo `tsx` do worker e deixava o `node` filho órfão (corrigido: o worker roda no próprio grupo de processos e a falha mata o grupo, como o `docker kill`). Nessa mesma tentativa, o app reiniciado não estava mais no ar depois do restart do PostgreSQL, e o harness não guardava a saída do processo. Desde então ele registra e reinicia um processo que caia (o equivalente ao `restart: unless-stopped` do Compose). Nas duas rodadas seguintes, nenhum processo caiu.

## 5. Soak

_Em medição._

## 6. Decisão (D-061)

O núcleo clínico continua no snapshot para o piloto e para a operação com o volume da D2. A margem medida (50× o pico estimado dentro das metas, saturação perto de 160× a taxa de escrita do pico) cobre com folga a incerteza do pico real. O cutover relacional ([PROD-111](build/PRODUCTION_BACKLOG.md)) segue planejado e passa a ter critério objetivo para ser antecipado:

- o alerta `CvgWriteQueueSaturated` disparar com o uso normal do hospital;
- o volume real passar de 3 vezes a D2 (450 exames/dia) ou o pico medido em homologação ficar acima de 10 vezes o estimado aqui;
- a necessidade de mais de uma instância do app.

## 7. O que esta medição não prova

- **Servidor do hospital:** os números são deste host. A homologação no servidor real (D11) repete o `perf:hospital` com o hardware e o banco de produção.
- **Pico real:** o "1×" é uma premissa (12 horas de operação, hora de pico 3 vezes a média). Com o pico informado pelo hospital, basta trocar `PERF_HOSPITAL_OPERATING_HOURS` e `PERF_HOSPITAL_PEAK_FACTOR`.
- **Login, anexos e antivírus** ficam fora das jornadas (sessões sintéticas, sem upload).
- **Uma instância** do app e do worker.

## 8. Como reproduzir

```bash
ALLOW_POSTGRES_INTEGRATION_TESTS=true POSTGRES_TEST_ADMIN_URL=postgresql://<admin>@127.0.0.1:<porta>/postgres \
PERF_HOSPITAL_LEVELS=1,10,25,50,100 PERF_HOSPITAL_LEVEL_SECONDS=180 PERF_HOSPITAL_REPORT=logs/perf-hospital.json \
npm run perf:hospital
```

Variáveis: `PERF_HOSPITAL_MONTHS` (12), `PERF_HOSPITAL_EXAMS_PER_DAY` (150), `PERF_HOSPITAL_OPERATING_HOURS` (12), `PERF_HOSPITAL_PEAK_FACTOR` (3), `PERF_HOSPITAL_VETS`/`LAB_TECHS`/`RADIOLOGY`/`MANAGERS` (30/6/3/3), `PERF_HOSPITAL_POLL_SECONDS` (20), `PERF_HOSPITAL_SSE` (30), `PERF_HOSPITAL_SOAK_MINUTES` e `PERF_HOSPITAL_SOAK_LEVEL`, `PERF_HOSPITAL_FAULTS=app,worker,postgres` com `PERF_HOSPITAL_FAULT_LEVEL`, `PERF_HOSPITAL_FAULT_INTERVAL_SECONDS` e `PERF_HOSPITAL_PG_CONTAINER` (o contêiner descartável que será reiniciado). O relatório JSON guarda as amostras brutas. Sai com erro se alguma escrita confirmada se perder ou duplicar, se um resultado liberado não for entregue exatamente uma vez ou se uma jornada não terminar.

**Na CI:** o job de benchmark roda uma versão curta (1 mês de histórico, 25×, app e worker derrubados com SIGKILL) com esse mesmo critério de integridade.
