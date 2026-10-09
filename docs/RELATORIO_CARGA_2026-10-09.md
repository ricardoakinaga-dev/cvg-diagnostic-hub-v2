# Relatório de carga com 12 meses de volume da D2 — 09/10/2026

**Item:** [PROD-110](build/PRODUCTION_BACKLOG.md). **Decisão de volume:** D2 (até 150 exames por dia; [pacote de decisões](build/PACOTE_DECISOES_2026-10-08.md)). **Relatório anterior:** [escala do runtime, 08/10](RELATORIO_ESCALA_2026-10-08.md).

## 1. O que passou a ser medido

Até aqui, o gate da CI (`perf:postgres`) media rotas HTTP, escrita e 100 conexões SSE sobre um banco com 100 mil eventos de auditoria, mas quase sem histórico clínico. Agora ele roda também sobre **12 meses de histórico sintético no ritmo da D2**:

| Item | Valor |
| --- | --- |
| Solicitações | 27.375 (75 por dia, 365 dias) |
| Exames | 54.750 (hemograma e RX de tórax em cada solicitação) |
| Pacientes | 6.844 (cerca de 4 solicitações por paciente) |
| Abertas | 150 (os últimos 2 dias); as demais concluídas, com amostra, procedimento, resultado com versão emendada e notificação |
| Auditoria | 100 mil eventos de carga mais a trilha clínica com autores: criação pelo veterinário, recebimento e liberação pelo laboratório, procedimento pela radiologia (cerca de 109 mil eventos) |
| Snapshot | 102 MB |

O gerador é determinístico e só produz dados sintéticos (`scripts/perf-clinical-volume.ts`). As leituras alternam três perfis: veterinário, técnico de laboratório e gestor. Os dois últimos enxergam todo o histórico do laboratório, que é o caso mais caro. Cada rodada faz 20 leituras por rota com 4 em paralelo, 10 escritas concorrentes e mantém 100 conexões SSE abertas.

**Na CI:** o job de benchmark roda a carga antiga, com tetos de p95 de 2× as metas do PRD, e depois a de 12 meses, com tetos de 4×. Os tetos de 4× pegam regressões grosseiras no volume real. Os logs das duas rodadas passam pelo `privacy:scan`.

## 2. Resultados

p95 em milissegundos. As metas do PRD são 500 ms para leitura, 800 ms para busca e 800 ms para escrita.

| Rota | CI, 4 vCPU | Local, Ryzen 7 5700 |
| --- | --- | --- |
| Catálogo | 851 | 1052 |
| Lista de solicitações | 746 | 1052 |
| Busca `HEMOGRAM` | 1021 | 1038 |
| Painel | 624 | 733 |
| Escrita | 1665 | 1894 |

- **Conexões SSE:** as 100 ficaram saudáveis nos dois ambientes, sem fechamento inesperado.
- **Tempo da rodada:** o job inteiro levou 2,5 min na CI; o seed dos 12 meses, 16 s.
- **Escrita:** 3 por segundo confirmadas sob carga, contra 19 por segundo com o estado pequeno.

## 3. Achados

1. **A meta do PRD não é atingida com 12 meses de dados e 4 leitores pesados ao mesmo tempo.** O p95 fica perto de 2× a meta.
   - Em processo, uma busca leva cerca de 200 ms para gestor e técnico, e a lista leva de 60 a 90 ms. As duas percorrem todo o conjunto visível, porque a API devolve o `total`.
   - O Node atende numa só thread, então as requisições simultâneas fazem fila. Até o catálogo, que é leve, espera atrás delas.
   - Com uso sequencial, os tempos são os do [relatório de escala](RELATORIO_ESCALA_2026-10-08.md) (lista em 124 ms, busca em 347 ms).
2. **A busca lia a trilha de auditoria inteira do histórico visível a cada consulta.** Eram cerca de 82 mil IDs num `ANY`, sem índice que servisse. A primeira versão desta carga não mostrava o custo, porque seus eventos de auditoria não tinham autor. Com a trilha clínica com autores, medida localmente, a busca chegava a p50 880 ms e p95 1,8 s. **Corrigido ([D-046](DECISION_LOG.md)):** a trilha só é lida para os usuários que casam com o termo, e não é lida quando nenhum casa (código de solicitação, nome de exame). A busca cai para p50 303 ms e p95 916 ms no mesmo ambiente, e as demais rotas melhoram por haver menos disputa.
3. **A escrita era dominada pela gravação por diferença.** Num perfil de CPU em processo, a 12 meses, `writeEntityState` ficou com 56% do tempo próprio e a projeção dos eventos com 16%. **Corrigido:** o escritor compara posição por posição por identidade de objeto e só calcula a chave do que foi acrescentado ou trocado. A criação de solicitação em processo com PostgreSQL caiu de mediana 188 ms para 77 ms, e de p95 217 ms para 87 ms.

## 4. O que fica em aberto

- **Pico de usuários simultâneos (D2):** o hospital ainda não o informou. A concorrência de 4 leitores pesados contínuos é uma premissa de estresse, não a medida real.
- **Homologação:** falta a medição no servidor do hospital (D11), com o hardware e o banco reais.
- **Otimização:** a lista e o painel ainda percorrem todo o conjunto visível (o `total` da API exige isso); busca e escrita foram corrigidas nesta rodada, e a próxima rodada da CI mede o efeito somado. O cutover relacional ([PROD-111](build/PRODUCTION_BACKLOG.md)) só fecha com o PROD-110 dentro da meta neste volume.
- **Não medido:** várias instâncias do app, failover e uma carga longa (soak).

## 5. Como reproduzir

```bash
ALLOW_POSTGRES_INTEGRATION_TESTS=true POSTGRES_TEST_ADMIN_URL=postgresql://<admin>@127.0.0.1:<porta>/postgres \
PERF_POSTGRES_CLINICAL_MONTHS=12 PERF_POSTGRES_P95_CEILING_FACTOR=4 PERF_POSTGRES_REPORT=logs/perf-12m.json \
npm run perf:postgres
```

`PERF_POSTGRES_EXAMS_PER_DAY` muda o ritmo (padrão 150). `PERF_POSTGRES_CLINICAL_MONTHS=0` volta à carga só de auditoria. O relatório JSON registra o volume, os perfis, o tempo de seed e as amostras brutas.
