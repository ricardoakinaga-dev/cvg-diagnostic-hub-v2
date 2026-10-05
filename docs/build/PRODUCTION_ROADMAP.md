# Roadmap até produção — CVG Diagnostics Hub

**Versão:** PROD-2026-10.1
**Data:** 03/10/2026
**Knowledge status:** `DECISION` para a ordem, os marcos e os critérios; `ASSUMPTION` para os tamanhos, que viram prazo só depois de D2 (volume) e D11 (infraestrutura).

[Roadmap de melhorias e correções](IMPROVEMENT_ROADMAP_2026-10.md) · [Auditoria de 04/10/2026](../RELATORIO_AUDITORIA_2026-10-04.md) · [Backlog](PRODUCTION_BACKLOG.md) · [Plano](PRODUCTION_PLAN.md) · [Auditoria de 02/10](../RELATORIO_AUDITORIA_2026-10-02.md)

## 1. Duas trilhas paralelas

O caminho até produção tem duas trilhas que não esperam uma pela outra:

```
Trilha técnica   W0 Base ──► W1 Escala ──────────────► W3 Infra ──┐
                                 │                                 │
Trilha humana    Fase 0: D1, D2, D11 ──► D3–D10 ──► D12            │
                         │                  │                      ▼
                         └─► W2 Identidade  └─► W4 Clínico/dados/operação ──► W5 Validação ──► Piloto ──► Go-live
```

- **Trilha técnica:** começa hoje, sem nenhuma decisão. W1 é o maior risco técnico (achados F-01 a F-03).
- **Trilha humana:** costuma ser o caminho crítico. As decisões D1, D2 e D11 destravam identidade, infraestrutura e o dimensionamento da W1.

## 2. Marcos

| Marco | Nome | Critério de saída (todos obrigatórios) | Itens |
| --- | --- | --- | --- |
| **M0** | Base confiável | Working tree limpo; CI remoto verde no commit candidato; `main` protegida; reuniões de D1, D2 e D11 agendadas | PROD-001…003 |
| **M1** | Escala comprovada | Benchmark de 12 meses no CI dentro da meta; snapshot sem auditoria, outbox, sessões ou idempotência acumulados; realtime com ≤ 1 leitura de estado por segundo por processo com 100 conexões; login inválido não trava escrita | PROD-101…110 |
| **M2** | Persistência definitiva | Autoridade clínica relacional em staging, dual-read sem divergência, rollback ensaiado | PROD-111 |
| **M3** | Staging real | Staging separado, pipeline de deploy, secret manager, PostgreSQL com PITR, S3 e antivírus reais; identidade conforme D1 | PROD-200…206, PROD-301…309 |
| **M4** | Candidato a piloto | Regras clínicas aprovadas implementadas; LGPD; alertas com dono disparados; restore cronometrado dentro do RPO/RTO; runbooks ensaiados | PROD-401…516 |
| **M5** | Piloto aprovado | Pentest e revisão independente sem crítico ou alto; acessibilidade manual; UAT; piloto medido; go/no-go assinado | PROD-601…704 |
| **M6** | Produção | RELEASE_CHECKLIST completo; hypercare concluído; PRODUCTION_READINESS em `READY` com evidência por item | PROD-801 |

## 3. Ondas em detalhe

### W0 — Base confiável (esforço S)

Antes de qualquer coisa: um commit candidato, um CI remoto verde e as primeiras decisões agendadas. Sem isso, nenhuma evidência posterior é rastreável.

### W1 — Escala (esforço L–XL; começa já)

Estado em 04/10/2026: PROD-106 `DONE`; PROD-103 e 104 em `VERIFY`; PROD-110 em `IN_PROGRESS`, com
correção dos achados A-01 a A-09 da [revisão de 02/10](../RELATORIO_REVISAO_ENTREGA_AGENTE_2026-10-02.md).
PROD-101 e PROD-102 estão `DONE` no aceite técnico local: auditoria/outbox fora do snapshot, cobertura combinada 1.235/1.235, E2E 81/81 sem retries, mutação 7/7 e nova carga com 100 SSE aprovadas. A revisão estática independente não deixou pendências P0/P1/P2 no escopo. PROD-105 também está `DONE` no aceite técnico local: leituras fora da fila, cache validado por versão, 1.279/1.279 testes combinados, E2E 81/81 e mesma carga de 100 SSE aprovados; p95 aumentou nesta amostra e não há alegação de ganho de latência. A concorrência física exige pool ≥ 2 e cada store adiciona uma conexão LISTEN dedicada. PROD-108 também está `DONE` no aceite local: registro dos 73 handlers validado contra o manifesto, arquivos centrais com 92/452 linhas, arquitetura verde, 1.410/1.410 testes combinados, 24 exceções de cobertura, E2E 81/81 e carga de 100 SSE aprovados. PROD-109 também está `DONE` localmente: audit completo zerado, 160 testes nativos e 1.517 combinados aprovados. Os aceites de staging e o recorte completo de W1 permanecem abertos. O benchmark provisório de 100 mil eventos independe de D2;
o volume aprovado de 12 meses e o aceite em staging continuam dependendo dessa decisão.

A ordem importa:

1. **PROD-110** primeiro: sem o benchmark, nenhuma das melhorias pode provar o próprio efeito.
2. **PROD-106** (scrypt fora da transação): o menor item e o de maior efeito sobre a disponibilidade.
3. **PROD-103, PROD-101, PROD-102:** tirar do snapshot tudo o que só cresce.
4. **PROD-104, PROD-105:** realtime incremental e leituras sem fila serial.
5. **PROD-107** em `VERIFY` (orçamento e backoff por par, com testes PostgreSQL).
   **PROD-108** está `DONE` localmente: despacho por mapa validado e arquivos centrais
   abaixo de 600 linhas. **PROD-109** está `DONE` no aceite local: Vitest/coverage
   4.1.11, configuração de origens e fork reproduzível de glob com parser/expansor
   efetivamente limitado. Audit completo e de produção sem vulnerabilidades;
   22 regras Next preservadas, 160 testes nativos e 1.517 testes combinados
   aprovados. O gate de audit da CI permanece intacto. A proveniência, os limites,
   a revisão independente e a manutenção do fork estão registrados no backlog.
   O gate de snapshot mede bytes;
   p95 HTTP/SSE e throughput no PostgreSQL ainda mantêm PROD-110 em `IN_PROGRESS`.
6. **PROD-111** (cutover relacional) logo depois do M1, porque requisições, itens, resultados e notificações continuam crescendo no snapshot. Os passos 3–5 compram margem, mas não resolvem.

**Risco:** o cutover é o maior item do backlog. Adapter, backfill e reconciliação das migrations 007–010 já existem e reduzem o risco, mas a troca de autoridade precisa de ensaio de rollback em staging.

### W2 — Identidade (esforço M–L; depende de D1)

Um caminho só: OIDC (PROD-200) **ou** contas locais (PROD-201…203). PROD-205 (inatividade de sessão) não depende de D1 e pode entrar na W1.

### W3 — Infraestrutura (esforço M–L; depende de D11 e D2)

PROD-303 (pipeline) não depende de decisão e pode andar junto com a W1.
PROD-305 (privilégios de banco) e PROD-306 (liveness do worker) saíram de
`IN_PROGRESS` para `VERIFY` em 03/10/2026: papéis separados com teste negativo
de privilégio, e probe em `node` puro com tolerância de N ciclos com erro.

### W4 — Clínico, dados e operação (esforço L–XL; depende de D3–D10)

Cada decisão vira SPEC → teste → código em staging assim que for tomada, sem esperar as outras. Os itens de operação (PROD-511…517) precisam do staging real (M3).

### W5 — Validação, piloto e go-live (esforço L + externo)

Exige código congelado. Pentest e revisão independente são externos e precisam ser contratados com antecedência: vale agendar já durante a W4.

## 4. Sequência recomendada para as próximas semanas

| Ordem | O quê | Quem |
| --- | --- | --- |
| 1 | PROD-001, PROD-002 (commit + CI) | Engenharia |
| 2 | PROD-003 (agendar D1, D2, D11) | Patrocinador |
| 3 | PROD-110 → PROD-106 → PROD-103 | Engenharia |
| 4 | PROD-101, PROD-102 | Engenharia |
| 5 | PROD-104, PROD-205, PROD-306 ✅; PROD-105 | Engenharia |
| 6 | PROD-303, PROD-108 | Engenharia |
| 7 | Conforme as decisões chegam: W2, W3 e W4 | Engenharia + clínica + SRE |
| 8 | Contratar pentest e revisão independente | Patrocinador |

## 5. O que muda em relação ao plano anterior

- A **W1 (escala)** passa a existir como onda própria. A auditoria de 02/10 mediu que o snapshot JSONB satura um processo bem antes de um ano de uso (F-01, F-02), então a decisão de persistência (P4.2) deixa de ser condicional.
- **AUD-040 reaberto** como PROD-108.
- O trabalho de outra sessão (dead-letter do outbox e gestão administrativa de sessões) **reduz** P5.7 e P2.C1. Esses dois itens saem do backlog; o que sobrou deles está no PROD-205.
