# Backlog até produção — CVG Diagnostics Hub

**Versão:** PROD-2026-10.1
**Data:** 03/10/2026
**Fonte:** [auditoria de 02/10/2026](../RELATORIO_AUDITORIA_2026-10-02.md) + [plano até produção](PRODUCTION_PLAN.md) + [revisão da entrega do agente](../RELATORIO_REVISAO_ENTREGA_AGENTE_2026-10-02.md)

[Melhorias e correções (04/10/2026)](IMPROVEMENT_BACKLOG_2026-10.md) · [Auditoria de 04/10/2026](../RELATORIO_AUDITORIA_2026-10-04.md) · [Roadmap](PRODUCTION_ROADMAP.md) · [Plano](PRODUCTION_PLAN.md) · [Auditoria](../RELATORIO_AUDITORIA_2026-10-02.md) · [Backlog AUDIT-2026-10 (anterior)](AUDIT_2026_10_BACKLOG.md)

## 1. Regras

- Este backlog é a **fonte de execução corrente** até o go-live. Os IDs `AUD-*`, `AAA-*` e `BLD-*` continuam válidos para rastrear o histórico; quando um item daqui absorve um anterior, a coluna "Origem" diz qual.
- Cadeia obrigatória: achado ou decisão → SPEC → teste → código → evidência → aceite.
- **Status:** `READY` (pode começar), `BLOCKED` (depende de decisão ou ambiente; a coluna "Depende" diz de quê), `IN_PROGRESS`, `VERIFY` (feito, aguardando prova), `DONE` (aceite comprovado por evidência nova).
- **Nenhum item vira `DONE` sem a evidência do aceite.** Este backlog foi aberto justamente porque o AUD-040 foi declarado `DONE` sem verificação.
- **Prioridade:** `P0` bloqueia produção; `P1` necessário para operar com segurança; `P2` melhoria.
- **Tamanho:** `S` ≤ 3 dias-pessoa; `M` 4–8; `L` 9–20; `XL` > 20 ou com dependência externa.

## 2. W0 — Base confiável

| ID | Pri | Status | Tam. | Entrega e aceite | Depende | Origem |
| --- | --- | --- | --- | --- | --- | --- |
| PROD-001 | P0 | READY | S | Revisar e commitar o trabalho pendente (dead-letter, migration 011, gestão de sessões, correção do E2E e docs desta auditoria). Aceite: working tree limpo e um único commit candidato. | — | F-11 |
| PROD-002 | P0 | READY | S | CI do GitHub Actions verde no commit candidato; proteção da `main` (PR + checks obrigatórios). Aceite: link da execução com todos os jobs verdes. | PROD-001 | F-11, P1.1 |
| PROD-003 | P0 | READY | S | Agendar as decisões D1 (identidade), D2 (volume/RPO/RTO) e D11 (infraestrutura) com os responsáveis. Aceite: atas no [DECISION_LOG](../DECISION_LOG.md). | — | Plano Fase 0 |

## 3. W1 — Escala e robustez da persistência (técnico, sem decisão humana)

| ID | Pri | Status | Tam. | Entrega e aceite | Depende | Origem |
| --- | --- | --- | --- | --- | --- | --- |
| PROD-110 | P0 | IN_PROGRESS | M | **Benchmark de carga reproduzível** com estado sintético de 12 meses (volume de D2, ou 100 mil eventos de auditoria até D2 sair) e N usuários com SSE aberto. Mede o p95 das rotas principais e o throughput de escrita. Entra no CI como gate de regressão. Aceite: relatório + job no CI. | — | F-01, P4.1 |
| PROD-106 | P0 | DONE | S | Verificar a senha (`scrypt`) **fora** da transação; dentro dela, só revalidar usuário ativo e hash inalterado e gravar a sessão. Login e reautenticação com senha errada deixam de travar a linha de estado. Aceite: teste que prova que nenhum `transaction` é aberto numa tentativa inválida. | — | F-03 |
| PROD-101 | P0 | DONE | L | **Auditoria fora do snapshot:** `audit_events` (já projetada e append-only por trigger) vira a fonte de leitura de auditoria e timeline; o snapshot guarda só os eventos novos da transação, para projeção. Aceite: o tamanho do snapshot não cresce com a auditoria; os testes de auditoria e timeline passam contra a tabela. | PROD-110 (linha de base) | F-01 |
| PROD-102 | P0 | DONE | L | **Outbox fora do snapshot:** worker, dead-letter e realtime leem `outbox_messages`; mensagens processadas saem do estado. Aceite: o snapshot não cresce com o outbox processado; os testes de outbox e dead-letter passam. | PROD-110 | F-01 |
| PROD-103 | P0 | VERIFY | M | **Retenção técnica:** remoção de sessões expiradas ou revogadas e de registros de idempotência vencidos (janela documentada), auditada. Aceite: teste de expurgo; tamanho estável sob carga contínua no PROD-110. | — | F-01, F-05 |
| PROD-104 | P0 | VERIFY | M | **Realtime sem leitura completa por conexão:** um único leitor incremental por processo (cursor do outbox), acordado pelo `LISTEN/NOTIFY` já existente e distribuído às conexões; a autorização é revalidada pela versão do usuário e da sessão, sem segunda leitura completa. Aceite: com 100 conexões, leituras do estado por segundo ≤ 1 por processo, medidas no PROD-110. | PROD-102 | F-02 |
| PROD-105 | P0 | DONE | M | **Leituras sem fila serial:** só as escritas passam pela transação; as leituras usam uma cópia em cache por versão, invalidada pelo `pg_notify` de `cvg_runtime_state_changed` que já existe. Aceite: leituras concorrentes no PROD-110 sem regressão nos testes multi-instância. | PROD-101, PROD-102 | F-01 |
| PROD-111 | P0 | BLOCKED | XL | **Cutover relacional:** autoridade clínica nas tabelas das migrations 007–010 (adapter, backfill e reconciliação já existem), com o snapshot aposentado. Aceite: dual-read sem divergência em staging; PROD-110 dentro da meta no volume de 12 meses; rollback ensaiado. | PROD-101…105, D2 | F-01, P4.2, ADR de persistência |
| PROD-107 | P1 | VERIFY | S | O rate limit por e-mail deixa de permitir bloqueio direcionado: chave por (e-mail, cliente) com backoff progressivo pelo mesmo par, sem ampliar a janela do dono legítimo que vem de outra origem. Aceite: teste em que um atacante não bloqueia o login da vítima a partir de outro cliente. | — | F-04 |
| PROD-108 | P1 | DONE | M | Dispatcher com mapa `operationId → handler` validado contra o manifesto; `route.ts` e `postgres-store.ts` abaixo de 600 linhas; teste que falha se faltar handler para alguma operação. Aceite: zero cadeias `operationId ===`; teste de arquitetura verde. Reabre o AUD-040. | — | F-08, AUD-040 |
| PROD-109 | P2 | DONE | S | Upgrade do Vitest (advisories `moderate`); `allowedDevOrigins` por variável de ambiente. Aceite: `npm audit` sem advisories. | — | F-12, F-13 |

## 4. W2 — Identidade e contas

| ID | Pri | Status | Tam. | Entrega e aceite | Depende | Origem |
| --- | --- | --- | --- | --- | --- | --- |
| PROD-200 | P0 | BLOCKED | L | **Se D1 = OIDC/AD:** login OIDC (code + PKCE), grupos → roles e departamentos, desativação ao sair do diretório; conta local só para break-glass, com alerta a cada uso. | D1 | P2.A1–A2 |
| PROD-201 | P0 | BLOCKED | M | **Se D1 = contas locais:** troca de senha self-service (exige a senha atual e revoga as outras sessões). | D1 | F-06, AUD-046 |
| PROD-202 | P0 | BLOCKED | M | **Se contas locais:** redefinição pelo ADMIN com token de uso único e expiração curta, com troca obrigatória no primeiro login (inclui a conta criada pelo bootstrap). | D1 | F-06, P2.B2 |
| PROD-203 | P1 | BLOCKED | S | **Se contas locais:** política de senha com lista de senhas vazadas; lockout progressivo por conta, coordenado com o PROD-107. | D1, PROD-107 | P2.B3–B4 |
| PROD-205 | P1 | VERIFY | S | Timeout de inatividade de sessão (configurável) e tela "minhas sessões" para o próprio usuário; a revogação administrativa já existe. Aceite: teste de expiração por inatividade. | — | F-05, P2.C1 |
| PROD-206 | P0 | BLOCKED | M | Matriz RBAC ajustada às decisões de ownership (D4), com testes de matriz. | D4 | P2.C2, OQ-001/002/017 |

## 5. W3 — Infraestrutura de produção

| ID | Pri | Status | Tam. | Entrega e aceite | Depende | Origem |
| --- | --- | --- | --- | --- | --- | --- |
| PROD-301 | P0 | BLOCKED | M | Ambientes staging e produção separados (banco, bucket, segredos). | D11 | P1.2, AUD-034 |
| PROD-302 | P0 | BLOCKED | M | Secret manager alimentando o deploy; rotação documentada e ensaiada. | D11 | P1.3, AUD-034 |
| PROD-303 | P0 | READY | M | Registry de imagens e pipeline de deploy: build → Trivy → push com tag do commit → staging automático → produção com aprovação. | PROD-002 | P1.4 |
| PROD-304 | P0 | BLOCKED | M | PostgreSQL gerenciado ou dedicado com PITR/WAL dimensionado por D2; restore point-in-time demonstrado. | D2, D11 | P1.5, AUD-033 |
| PROD-305 | P1 | VERIFY | S | Usuários de banco separados: migration (DDL) e runtime (DML, sem `ALTER`/`DROP` nem `DELETE` em `audit_events`). Aceite: teste negativo de privilégio. | — | P1.6 |
| PROD-306 | P1 | VERIFY | S | Liveness do worker do outbox (heartbeat + healthcheck no compose) e métrica de idade da mensagem pendente mais antiga. Aceite: worker travado fica `unhealthy`. | — | F-07 |
| PROD-307 | P0 | BLOCKED | S | Bucket S3 de produção: criptografia, versionamento, sem acesso público, ciclo de vida conforme D5. | D11, D5 | P1.7 |
| PROD-308 | P0 | BLOCKED | M | Antivírus externo real e responsável pela quarentena; EICAR quarentenado em staging. | D11 | P1.8 |
| PROD-309 | P1 | BLOCKED | S | DNS, TLS, firewall (só 80/443 públicos), acesso administrativo por VPN ou bastion. | D11 | P1.9 |

## 6. W4 — Regras clínicas, dados e operação

| ID | Pri | Status | Tam. | Entrega e aceite | Depende | Origem |
| --- | --- | --- | --- | --- | --- | --- |
| PROD-401 | P0 | BLOCKED | M | Política de resultado crítico ativa (versão, aprovação, data), com escalonamento e fallback de plantão. | D3 | P3.1, OQ-004/005 |
| PROD-402 | P0 | BLOCKED | L | Canal redundante para crítico (novo sink durável do outbox com confirmação). | D3 (se exigido) | P3.2, OQ-018 |
| PROD-403 | P0 | BLOCKED | M | Ownership de liberação, emenda, anulação, revisão e cancelamento por serviço. | D4 | P3.3 |
| PROD-404 | P1 | BLOCKED | M | Calendário e pausas de SLA por setor. | D7 | P3.4, OQ-006 |
| PROD-405 | P1 | BLOCKED | M–L | Modelo de amostra, accession e etiqueta. | D8 | P3.5, OQ-008 |
| PROD-406 | P1 | BLOCKED | M | Alta, transferência e encerramento de atendimento. | D9 | P3.6, OQ-007 |
| PROD-407 | P0 | BLOCKED | M | Catálogo de produção carregado via admin (exames, templates, unidades, faixas aprovadas). | D10 | P3.7, OQ-016 |
| PROD-408 | P0 | BLOCKED | L–XL | Integração com o sistema mestre de Paciente/Atendimento **ou** procedimento manual aprovado. | D6 | P3.8, OQ-011 |
| PROD-409 | P2 | BLOCKED | M | Agenda de ultrassom (integração mínima ou procedimento). | D10 | P3.9, OQ-009 |
| PROD-501 | P0 | BLOCKED | M | Retenção e expurgo clínico (LGPD) conforme D5, cobrindo os anexos no S3. | D5, PROD-111 | P4.3 |
| PROD-502 | P1 | BLOCKED | M | Exportação e exclusão de dados do titular dentro dos limites legais. | D5 | P4.4 |
| PROD-503 | P1 | READY | S | Ensaio de migrations a partir de um dump representativo; plano de roll-forward/rollback por migration. | — | P4.5 |
| PROD-504 | P1 | READY | S | Varredura de logs, bundle e fixtures sem dado pessoal real nem segredo. | — | P4.6 |
| PROD-511 | P0 | READY | M | Métricas em Prometheus ou equivalente, com dashboards (app, banco, outbox, realtime). | PROD-303 | P5.1 |
| PROD-512 | P1 | READY | S | Agregação de logs com busca por `correlationId`. | PROD-303 | P5.2 |
| PROD-513 | P0 | BLOCKED | M | Alertas com dono e roteamento, cada um disparado em staging (inclui dead-letter, worker parado, backup falho, certificado vencendo). | D2, PROD-511 | P5.3, AUD-020 |
| PROD-514 | P0 | BLOCKED | M | Backup de PostgreSQL **e** S3, com restore completo cronometrado contra o RPO/RTO. | D2, PROD-304 | P5.4, AUD-033 |
| PROD-515 | P1 | BLOCKED | M | Runbooks ensaiados (banco, storage, antivírus, crítico não entregue, rede degradada). | PROD-513 | P5.5 |
| PROD-516 | P1 | BLOCKED | S | Escala de plantão, contatos de incidente e janela de manutenção. | D11 | P5.6 |
| PROD-517 | P2 | READY | S | **Monitoramento de tentativas distribuídas por conta:** agregar falhas de login do mesmo e-mail entre clientes distintos, com identificador de conta pseudonimizado, janela e limiar de alerta documentados. O backoff do PROD-107 continua por par; trocar de IP não acumula esse backoff. Aceite: simulação em staging com múltiplas origens gera sinal agregado e alerta, sem bloquear login nem ampliar a janela de outros clientes da conta. | PROD-511, PROD-512 | PROD-107, F-04, D-021 |

## 7. W5 — Validação, piloto e go-live

| ID | Pri | Status | Tam. | Entrega e aceite | Depende | Origem |
| --- | --- | --- | --- | --- | --- | --- |
| PROD-601 | P0 | BLOCKED | L | Pentest externo; zero achado crítico ou alto aberto. | Código congelado | P6.1 |
| PROD-602 | P0 | BLOCKED | M | Inspeção manual de acessibilidade (leitor de tela, zoom 200%, touch). | Código congelado | P6.2, AUD-029 |
| PROD-603 | P1 | BLOCKED | S | Revisão do threat model com o código final. | PROD-601 | P6.3 |
| PROD-604 | P0 | BLOCKED | S | Re-execução integral dos gates com packet e hash. | Código congelado | P6.4, AUD-037 |
| PROD-605 | P0 | BLOCKED | M | Revisão independente com nota ≥ 85 e zero achado crítico ou alto. | PROD-604 | P6.5, AUD-038 |
| PROD-701 | P0 | BLOCKED | M | UAT em staging por jornada, com termo de aceite. | W4 | P7.1 |
| PROD-702 | P0 | BLOCKED | S | Treinamento e material para os usuários do piloto. | PROD-701 | P7.2 |
| PROD-703 | P0 | BLOCKED | M | Piloto com o escopo de D12 e contingência manual ativa. | PROD-605, D12 | P7.3 |
| PROD-704 | P0 | BLOCKED | S | Relatório do piloto contra o baseline; go/no-go assinado. | PROD-703 | P7.4–P7.5 |
| PROD-801 | P0 | BLOCKED | M | Go-live pelo RELEASE_CHECKLIST completo; expansão por setor; hypercare de 2–4 semanas; PRODUCTION_READINESS → `READY`. | PROD-704 | Fase 8 |

## 8. Resumo

| Onda | Itens | `READY` | `DONE` | `IN_PROGRESS`/`VERIFY` | `BLOCKED` |
| --- | ---: | ---: | ---: | ---: | ---: |
| W0 Base | 3 | 3 | 0 | 0 | 0 |
| W1 Escala | 11 | 0 | 6 | 4 | 1 |
| W2 Identidade | 6 | 0 | 0 | 1 | 5 |
| W3 Infra | 9 | 1 | 0 | 2 | 6 |
| W4 Clínico/dados/operação | 20 | 5 | 0 | 0 | 15 |
| W5 Validação/piloto | 10 | 0 | 0 | 0 | 10 |
| **Total** | **59** | **9** | **6** | **7** | **37** |

Os 37 itens bloqueados dependem de 12 decisões humanas (D1–D12 do [plano](PRODUCTION_PLAN.md)). Por isso a Fase 0 roda em paralelo com a W1. Seis itens estão em `VERIFY` em 03/10/2026: eles têm implementação e teste, e falta a evidência de execução contínua em staging (PROD-103, 104, 107, 205, 305, 306) — que depende de ambiente real, não de código.

## 9. Evidência

**Entrega de 03/10/2026 (esta onda).** Tratamento dos achados A-01 a A-09 da [revisão de 02/10](../RELATORIO_REVISAO_ENTREGA_AGENTE_2026-10-02.md); A-06 tem gates locais, mas o aceite de carga do PROD-110 permanece pendente:

| Achado | Correção | Evidência |
| --- | --- | --- |
| A-01 | Atividade de sessão na tabela `session_activity` (migration 012), fora do snapshot: leitura de linha indexada + UPSERT de linha única | `src/server/store/postgres-session-activity.ts`; teste "serves many authenticated reads without a single snapshot write" (50 GETs, 0 transações) e teste PostgreSQL "records liveness in its own table without rewriting the snapshot" |
| A-02 | `compactRuntimeState` ligado ao worker do outbox em cadência própria (`RUNTIME_RETENTION_INTERVAL_MS`), auditado por execução, mais `npm run runtime:retention` | `src/server/operations/runtime-retention-job.ts`; teste "compacts a live store, prunes liveness with the session and audits the run" e teste PostgreSQL de reconciliação snapshot × `outbox_messages` |
| A-03 | Cobertura dos arquivos novos sem exceção declarada: suíte PostgreSQL para as costuras estreitas, ramos extras no heartbeat e na retenção | `tests/postgres/session-activity.integration.test.ts`; `coverage:gate` verde sem entrada nova em `docs/build/COVERAGE_EXCEPTIONS.json` |
| A-04 | Um leitor incremental compartilhado por processo, com guarda de versão inteira e leitura estreita de autorização só quando houve escrita | `src/server/observability/realtime-state-reader.ts`; `npm run perf:realtime-budget` (100 conexões, 2 leituras em 6 s, orçamento ≤ 1/s) |
| A-05 | Timeout de inatividade como decisão de produto (D-018), SSE renova atividade, sessões legadas recebem uma janela na migration 012, variáveis documentadas | `src/server/domain/session-activity.ts`; [DEPLOYMENT §6](../operations/DEPLOYMENT.md) |
| A-06 | `perf:snapshot --check` como gate determinístico por bytes (tempos informativos) contra `docs/build/PERF_BASELINE.json`, mais o gate de orçamento do realtime | `scripts/perf-snapshot.ts`, `scripts/perf-realtime-budget.ts`; jobs na CI |
| A-07 | Probe em `node` puro (`scripts/outbox-healthcheck.mjs`), tolerância de N ciclos com erro (`OUTBOX_HEARTBEAT_ERROR_TOLERANCE`) e documentação da dependência de restart | `src/server/operations/outbox-heartbeat.ts`; teste de probe como processo filho |
| A-08 | `readAuthorizationSnapshot`, `readSessionActivity`, `touchSessionActivity`, `readStateSnapshot`, `readStateVersion` e `compactRuntimeState` obrigatórios em `StateStore` | `src/server/domain/models.ts`; os fakes estruturais de teste passaram a delegar ao `MemoryStore` |
| A-09 | Variáveis documentadas em `.env.example`, `.env.production.example`, compose e DEPLOYMENT | [DEPLOYMENT §6](../operations/DEPLOYMENT.md) |

No primeiro checkpoint, `PROD-109` ficou `IN_PROGRESS` (superado pelo aceite local abaixo): `allowedDevOrigins` passou a vir de
`NEXT_ALLOWED_DEV_ORIGINS` (o IP de LAN fixo saiu do `next.config.mjs`), mas o
aceite "`npm audit` sem advisories" **não** pode ser atingido sem uma mudança
quebra: em 03/10/2026 os 5 advisories `high` restantes são todos da cadeia de
desenvolvimento (`eslint-config-next` → `@next/eslint-plugin-next` →
`fast-glob`/`micromatch`/`braces`) e o `npm audit fix --force` sugerido instala
`eslint-config-next@14.2.35`, rebaixando o plugin de lint. Nenhum deles está em
dependência de produção; o critério de produção continua sendo
`npm audit --omit=dev --audit-level=high`, como em D-016.

Itens do backlog fechados nesta onda: **PROD-106** (`DONE`), **PROD-103, 104, 107, 205, 305, 306** em `VERIFY` (aguardando evidência de execução contínua em staging). **PROD-101, 102 e 105** seguem `READY`: exigem a linha de base do PROD-110. O perfil provisório de 100 mil eventos pode ser executado sem D2; o volume aprovado e o aceite em staging ainda dependem da decisão humana. `PROD-108` (dispatcher por mapa) segue `READY` e não foi tocado nesta onda, embora a extração do backfill e do codec tenha reduzido `postgres-store.ts`, que ainda supera a meta de 600 linhas.

Linha de base de 02/10/2026 (detalhe no [relatório](../RELATORIO_AUDITORIA_2026-10-02.md), seção 2):

- 809/809 testes (unit + PostgreSQL), 94,98% lines, 95,30% functions, 89,10% branches; `coverage:gate` PASS.
- typecheck, lint, build, docs, OpenAPI 70/65, rastreabilidade 43/43, migrations 001–011, secret scan e `npm audit --audit-level=high`: PASS.
- E2E: 62/63 na primeira execução (F-09, axe antes da renderização no mobile); depois da correção, `npm run test:e2e -- --retries=0 --fail-on-flaky-tests` → **63/63** (5,8 min).

Correção de 03/10/2026: PROD-110 segue `IN_PROGRESS`: os gates de bytes e leituras em processo não comprovam p95 HTTP, throughput, latência ou locks PostgreSQL em carga com SSE. Evidências locais e contagem de variáveis estão na atualização do [relatório de revisão](../RELATORIO_REVISAO_ENTREGA_AGENTE_2026-10-02.md).

Revisão complementar de 03/10/2026: PROD-517 registra a detecção agregada por conta como monitoramento, sem bloqueio por e-mail. Antes do deploy, comprovar a identidade do cliente através do proxy real, incluindo `X-Forwarded-For` forjado conforme [DEPLOYMENT §5.1](../operations/DEPLOYMENT.md#51-identidade-do-cliente-e-x-forwarded-for-forjado), e anexar o benchmark de staging do PROD-110. Esses dois aceites permanecem pendentes; validação local não os substitui.

Instalação local autorizada em 03/10/2026: [stack isolado](../operations/LOCAL_INSTALLATION.md) disponível em `https://localhost:18443`, com PostgreSQL, S3 e ClamAV reais. O teste de `X-Forwarded-For` forjado passou nesta borda Caddy com comparação dos três contadores PostgreSQL; uma futura borda institucional deve repetir o aceite na própria topologia. O benchmark de staging do PROD-110 continua pendente. Nenhum status de go-live foi alterado por esta instalação.

Atualização de 04/10/2026 — **PROD-110 permanece `IN_PROGRESS`**. `npm run perf:postgres` implementa a linha de base com PostgreSQL descartável, build Next em produção, 100 mil eventos, 100 usuários/SSE, 80 leituras HTTP e dez comandos clínicos concorrentes. Mede o corpo completo da resposta, confirma as gravações no banco e exige que cada stream receba as mutações e continue entregando frames após a carga. O relatório separa o gate de correção das metas preliminares de latência; tempos são informativos no CI, e o gate determinístico de bytes continua separado. O job `perf-postgres` preserva JSON e log mesmo quando a execução falha. A métrica de leituras compartilhadas agora conta leituras completas concluídas, sem multiplicar os acessos ao cache pelos clientes.

Na execução local com Node 22.23.2/PostgreSQL 16.15, os 100 streams abriram, as 80 leituras e as dez gravações concluíram, mas os streams encerraram por `poll_timeout` durante a carga sem entregar as novas mutações: **gate reprovado**. P95 máximo de leitura: 22,93 s; de escrita: 32,07 s; throughput: 0,13 gravação confirmada/s. O leitor compartilhado fez uma leitura completa em 8,42 s na janela ociosa, sem contar os acessos ao cache como leituras físicas. Essa linha de base orienta PROD-101/102/105; não autoriza deploy nem comprova capacidade de produção. O código do benchmark recebeu revisão independente, e passaram 50 testes do harness/performance, 25 testes de realtime/métricas e 70 testes PostgreSQL. O volume D2, a topologia de staging, soak/failover e a execução remota do novo job continuam pendentes. Evidência local descartável em `.data/prod110/`; reprodução exige `ALLOW_POSTGRES_INTEGRATION_TESTS=true` e `POSTGRES_TEST_ADMIN_URL` de um cluster loopback dedicado, sem parâmetros de query.

Atualização de 04/10/2026 — **PROD-101 `DONE` no aceite local**: `audit_events` passou a ser a autoridade de auditoria, timeline, histórico do paciente, busca por responsável, evidência de abertura antes da revisão e métricas derivadas do histórico. O snapshot persistido contém `auditEvents: []`; apenas os eventos novos da transação participam da projeção. A migration 013 reconcilia todos os campos do legado e aborta divergências, enquanto a restrição rejeita escritores antigos. Bootstrap e reset continuam auditados na mesma transação, com proteção contra reescrita do histórico. A troca de versões de app/worker deve ser coordenada conforme [SYSTEM_SPEC](../spec/SYSTEM_SPEC.md#prod-101--autoridade-de-auditoria-04102026).

O ensaio PostgreSQL de upgrade com 100 mil eventos (50 mil já projetados) preservou o hash integral e inseriu os 50 mil ausentes; a migration levou 2,96 s e o snapshot caiu de 1.641.651 para 2.956 bytes. Reexecução não aplicou nenhuma migration. Testes reais cobrem rollback tardio, divergência em cada campo, IDs duplicados, rejeição de escritor antigo, reconstrução do histórico incluindo evento posterior ao cutover, RBAC/paginação e revisão com pool de uma conexão. A rodada de benchmark após as correções de bootstrap/métricas passou com os mesmos 100 mil eventos, 100 streams, 80 GETs e dez POSTs: p95 máximo de leitura 216,70 ms, escrita 191,88 ms, dez gravações duráveis, 100 streams recebendo todas as mutações e nenhum encerramento inesperado. A rodada final, vinculada ao código congelado, passou novamente: snapshot 23.954 bytes, p95 máximo de leitura 230,55 ms, escrita 222,17 ms, 18,51 gravações confirmadas/s nesta rajada de dez comandos, 100 streams saudáveis e 0,17 leitura compartilhada/s na janela ociosa. Os tempos são locais e informativos; CI remoto, D2/staging, soak e failover permanecem pendentes. Evidências descartáveis em `.data/prod101/`; nenhum commit, deploy ou alteração do stack instalado foi feito.

Validação final do PROD-101 em Node 22.23.2: 1.127 testes unitários + 78 PostgreSQL = **1.205/1.205** em 126 arquivos; cobertura 95,59% linhas, 96,13% funções e 90,68% branches; `coverage:gate` PASS com as mesmas 25 exceções, sem nova exceção. E2E **81/81**, com `--retries=0 --fail-on-flaky-tests`, mutação 7/7, 50 testes de harness/performance, gates de snapshot/realtime, typecheck, lint sem avisos, docs, migrations 001–013, rastreabilidade 43/43, OpenAPI 73/68 e audit de produção sem vulnerabilidades: PASS. As duas esperas do E2E clínico foram corrigidas para aguardar a página/draft carregado; nenhuma ação, regra de axe ou verificação clínica foi retirada. A revisão independente identificou e aprovou as correções de bootstrap e métricas; essa aprovação estática não é aprovação de release. PostgreSQL descartável e servidores de teste foram encerrados, e o stack instalado segue preservado. Próximo item técnico naquele checkpoint: **PROD-102**, cujo aceite local está registrado abaixo.


### PROD-102 — aceite técnico local em 04/10/2026

`outbox_messages` é a autoridade PostgreSQL para worker, dead-letter, replay e métricas; snapshot/cache mantêm `outbox: []`. Comandos clínicos, intents, auditoria e notificações continuam atômicos. Claims carregam uma mensagem elegível ou identificada sob lock; o seletor atravessa mais de 100 mensagens de rota não suportada sem impedir a mensagem seguinte. Fechamento exige dono, token e lease vigente. O replay usa `event_position` e uma janela de até 100 mensagens, com estado/versão numa mesma leitura MVCC; retries não mudam a ordem de criação. A migration 014 reconcilia todos os campos antes de esvaziar o array e rejeita escritores antigos. Retenção, autorização, CSRF, idempotência e auditoria permanecem no servidor.

A revisão encontrou uma diferença de fallback para parâmetros inválidos de retenção; ambas as autoridades agora compartilham a política validada, com teste de paridade para configuração de sete dias. Um teste negativo reproduziu a colisão de auditoria em falha → reprocessamento → nova falha; IDs únicos por transição protegida pelo lease permitem dois ciclos e depois uma única entrega durável, comprovada após restart. O controle de mutação de replay passou a atingir o predicado na nova autoridade, preservando os testes antigos de stream e adicionando uma verificação pela interface pública em memória. Nenhum teste foi apagado ou marcado com skip; nenhuma exceção de cobertura foi adicionada.

Node 22.23.2: **1.148 unitários + 87 PostgreSQL = 1.235/1.235** em 127 arquivos, incluindo nove cenários de autoridade do outbox; cobertura 95,61% linhas, 96,19% funções e 90,78% branches, com as mesmas 25 exceções. E2E **81/81**, `--retries=0 --fail-on-flaky-tests`; mutação 7/7, harness 50/50, typecheck, lint, docs, migrações 001–014, OpenAPI 73/68, rastreabilidade 43/43, gates de snapshot/realtime e audit de produção: PASS. Revisão independente estática sem pendências P0/P1/P2 no escopo; não é aprovação de release.

O benchmark repetiu os 100 mil eventos de auditoria, 100 usuários/conexões SSE, 80 GET e 10 POST duráveis: **PASS**, zero erros/fechamentos, todas as conexões receberam as dez escritas e 0,17 leitura física compartilhada/s no período ocioso. p95 máximo GET 191,40 ms, p95 POST 191,43 ms e 20,77 commits/s na pequena rajada; tempos são informativos, sem aceite de staging/D2. O teste de crescimento mantém bytes/texto do snapshot idênticos após 250 mensagens históricas processadas e o processamento de outra mensagem; não confundir essa prova com o pequeno tamanho inicial do benchmark, que começa sem histórico de outbox. PostgreSQL descartável e servidores de teste encerrados; stack instalado preservado. Nenhum commit/deploy. Próximo item técnico: **PROD-105**.

### PROD-105 — aceite técnico local em 04/10/2026

As leituras PostgreSQL deixaram a fila local de escritas. `readState`/`readStateSnapshot` reutilizam cópias independentes por versão, sempre após consulta escalar durável; misses simultâneos da mesma versão compartilham a materialização. O `LISTEN cvg_runtime_state_changed` invalida a cópia por uma conexão dedicada adicional ao `DB_POOL_MAX`; notificação perdida ou desconexão não autorizam fallback de estado antigo. Versão/estado/outbox do realtime continuam no mesmo statement MVCC. Escritas e backfill continuam serializados; encerramento rejeita novas operações e aguarda as já iniciadas. Não há migration nova. Paralelismo físico exige pool ≥ 2; com 1, a conexão de escrita ocupa toda a capacidade de consultas, embora o listener não a consuma.

Node 22.23.2: **1.185 unitários + 94 PostgreSQL = 1.279/1.279**, em 130 arquivos, incluindo sete casos novos PostgreSQL de concorrência/frescor/ciclo de vida. Cobertura 95,65% linhas, 96,31% funções e 90,85% branches; gate PASS com as mesmas 25 exceções. E2E **81/81**, `--retries=0 --fail-on-flaky-tests`; mutação 7/7; 50 testes de harness/performance; typecheck, lint, docs, migrations 001–014, OpenAPI 73/68, rastreabilidade 43/43 e audit de produção sem vulnerabilidades: PASS. Revisão estática independente sem pendências P0/P1/P2; não equivale a aprovação de release.

A carga repetiu 100 mil auditorias, 100 usuários/SSE, 80 GET e dez POST duráveis: **PASS**, todas as conexões receberam as dez escritas, zero erros/fechamentos e 0,17 leitura física compartilhada/s no período ocioso. p95 máximo GET **283,17 ms**, POST **394,57 ms**, 14,08 commits/s na pequena rajada. Esses tempos aumentaram em relação à amostra do PROD-102 (191,40/191,43 ms); não há alegação de ganho de latência nem aceite de staging/D2. As metas provisórias seguem atendidas nesta execução, com tempos informativos no host compartilhado. Evidência local em `.data/prod105/verification.json`; nenhum commit/deploy, nenhum doc novo ou exceção de cobertura. Banco descartável e servidores de teste encerrados; stack instalado preservado. Próximo item técnico: **PROD-108**.

### PROD-108 — aceite técnico local em 04/10/2026

Os 73 handlers estão registrados por `operationId`, com correspondência exata de autenticação contra o manifesto. O registro rejeita operações ausentes, duplicadas, extras ou sem função; testes removem um handler real e exigem falha. Os grupos público, administrativo, clínico e operacional conservam os corpos e a ordem dos controles do servidor. Helpers coesos de administração e execução do backfill saíram do store, preservando transações, locks, checkpoints e encerramento. `route.ts` tem **92 linhas** e `postgres-store.ts` **452**; arquitetura PASS, sem comparações/switch por `operationId`, ciclos ou novas exceções de fronteira. Nenhum contrato HTTP ou migration mudou.

Node 22.23.2: **1.316 unitários + 94 PostgreSQL = 1.410/1.410**, em 134 arquivos. Cobertura final **96,27% linhas, 96,52% funções e 91,20% branches**; gate PASS com **24 exceções**, após remover a antiga exceção do dispatcher, sem transferi-la para os helpers. E2E **81/81**, `--retries=0 --fail-on-flaky-tests`; mutação 7/7; 50 testes de harness/performance; typecheck, lint sem avisos, docs, migrations 001–014, OpenAPI 73/68, rastreabilidade 43/43 e audit de produção sem vulnerabilidades: PASS. Novos testes HTTP exercitam os fluxos clínicos, inputs administrativos inválidos e a negativa de operações em dead letters existentes; o administrador executa as mesmas ações como controle positivo. Um contrafactual isolado removeu ambas as verificações de permissão e foi detectado pelo teste reforçado. Revisão estática independente sem achados abertos no runtime e no ajuste de teste; não é aprovação de release.

A carga de 100 mil auditorias, 100 usuários/SSE, 80 GET e dez POST duráveis passou: todas as conexões receberam as dez escritas, zero erros/fechamentos e **0,17 leitura física compartilhada/s** em ociosidade. p95 máximo GET **305,02 ms**, POST **462,87 ms**, 11,69 commits/s na pequena rajada. Tempos aumentaram ante a amostra do PROD-105; não há alegação de ganho de latência. São medidas informativas no host compartilhado, dentro das metas provisórias nesta execução, sem aceite de staging/D2, soak ou capacidade de produção. Evidência local em `.data/prod108/verification.json`, com logs e hashes; tentativas anteriores e o achado corrigido estão preservados. Banco descartável e servidores de teste encerrados; stack instalado preservado. Nenhum commit/deploy, doc novo, `skip`, `any` ou nova exceção de cobertura. Próximo item técnico: **PROD-109**.

### PROD-109 — aceite técnico local em 04/10/2026

Vitest e `@vitest/coverage-v8` passaram juntos para **4.1.11**. O lockfile foi resolvido com npm 12 temporário após falha do Arborist no npm 10; a instalação reproduzível com `npm ci` passou no npm **10.9.8**, Node **22.23.2**, sem mudança global de ferramenta. As versões das dependências de produção permaneceram iguais. A opção removida `minWorkers` saiu da configuração; execução serial, seletores, exclusões e thresholds foram preservados. Quatro testes nativos exercitam `NEXT_ALLOWED_DEV_ORIGINS` e a estabilidade dos headers; `test:config` integra `validate` e CI.

As **três entradas moderate do Vitest e as cinco high da cadeia de glob foram eliminadas**: `npm audit` completo e de produção retornam **zero vulnerabilidades**. A consulta de 04/10 ao [advisory de braces](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) e aos pacotes oficiais não encontrou correção publicada. A solução é um fork local real de `fast-glob@3.3.1`, identificado como `3.3.1-cvg.1`: remove as dependências `micromatch`/`braces`, usa `picomatch@4.0.7` e conserva um subconjunto licenciado do parser/expansor original com os pontos vulneráveis efetivamente corrigidos. O compilador e a API geral de `braces` não são empacotados. Os limites são aplicados antes de travessias/alocações: entrada de 4.096 caracteres, profundidade de agrupamento 32, 128 delimitadores, 1.000 resultados e orçamentos para AST, filas e recursão. O excesso gera erro explícito, sem truncar os diretórios encontrados. As **22 regras oficiais do Next**, a resolução de diretórios e suas severidades continuam intactas; nenhuma dependência de produção mudou. Não houve alias, downgrade, supressão de advisory ou relaxamento do gate de audit.

Os arquivos em `vendor/` são necessários para `npm ci`: tarball reproduzível e proveniência com integridades dos dois pacotes de origem, hashes de todos os arquivos, patches e licenças. `npm run vendor:fast-glob` regenera o pacote; umask 022 e 077 produziram o mesmo hash. Os três scripts de geração/limites implementam o patch; o teste nativo e seu JSON congelam o oráculo dos pacotes originais. O Dockerfile copia o tarball antes dos dois estágios de instalação, ambos construídos nesta rodada. A exclusão de `.data/` do ESLint limita-se a evidências locais já ignoradas pelo Git; eliminou avisos de JavaScript gerado por cobertura, sem excluir fonte versionada nem alterar regras. O fork deve ser removido quando houver solução oficial que passe as mesmas provas de compatibilidade e segurança.

A suíte nativa tem **160/160 testes**, sem skips: 59 casos de diretórios/lint, 32 casos nas APIs síncrona, assíncrona e stream, 182 achados reais de lint e hashes das 22 regras. O oráculo foi obtido com os pacotes originais, incluindo aspas, classes, escapes, intervalos, caminhos absolutos e links simbólicos em Linux. São 333 rejeições públicas e 227 privadas verificadas; as asserções recusam stack overflow nativo. A revisão independente aprovou o artefato final após 300 comparações adicionais e 43 provas adversariais, inclusive `NaN`, passo efetivo e filas cíclicas de ancestrais; as negativas de alocação não chamaram `fill-range`. Um contrafactual isolado removeu a validação do AST e reproduziu o stack overflow que a versão corrigida rejeita de forma controlada. Não é aprovação de release.

A validação revelou dois pressupostos de teste: um hook devolvia o mock como callback de limpeza, e a concorrência do backfill exigia uma única mensagem para dois resultados válidos de Repeatable Read. O hook agora retorna `undefined`; a expectativa PostgreSQL aceita apenas as duas falhas previstas e conserva a prova de lock e o registro durável `FAILED`/`SOURCE_CHANGED`. O remapeamento AST do Vitest 4 também revelou lacunas em 18 arquivos. Novos testes de comportamento cobrem essas fronteiras, mantendo os limites; as exceções desnecessárias de senha e S3 saíram, restando 22 sem novas exceções.

A revisão dos testes exigiu controles mais discriminantes para foco desabilitado, um item real de RADIOLOGY com ator autorizado e shutdown com assinante ativo. O último revelou um defeito real: callbacks da conexão liberada ainda entregavam hints após `close()`. O ajuste em `realtime.ts` limpa os assinantes no fechamento e protege callbacks/fan-out com um token novo por aquisição, inclusive quando o pool reutiliza o mesmo client após falha de LISTEN. Testes reproduziram a entrega indevida após fechamento e a duplicação por reuso, e passaram após a correção; também cobrem fechamento durante fan-out e callbacks de erro antigos. O filtro de foco foi desafiado por uma mutação isolada que falhou na asserção reforçada. Nenhum controle de autorização, CSRF, auditoria, reautenticação ou replay mudou; nenhuma asserção foi removida, nem houve `skip`, `any` ou supressão. A revisão independente final aprovou o delta estático de 17 testes e um arquivo de runtime; não é aceite de release.

Node 22.23.2/npm 10.9.8: **`npm run validate` PASS**, com **1.423 unitários + 94 PostgreSQL = 1.517/1.517** em 140 arquivos, **160 testes nativos**, typecheck, lint sem avisos, documentação, OpenAPI 73 operações/68 paths, rastreabilidade 43/43 e migrações 001–014. Cobertura final: **96,79% linhas, 95,44% funções e 89,34% branches**; gate por arquivo PASS com **22 exceções**, sem mudar thresholds ou exclusões de cobertura. Os 50 testes de performance e os gates de snapshot/realtime passaram no pacote final. Mutação **7/7** e E2E **81/81** são as provas da rodada anterior: não foram repetidos nesta correção de dependências, que preservou os arquivos de runtime e seus testes. O E2E anterior precedeu o ajuste do adaptador PostgreSQL, posteriormente coberto pelas suítes focada/PostgreSQL. Audit completo/de produção: zero; SBOM sem os pacotes `micromatch`/`braces`, com o subconjunto corrigido declarado na proveniência. Não houve benchmark de staging, teste do proxy real nem novo ensaio de 100 SSE nesta etapa. Evidência atual em `.data/prod109-audit-fix/verification.json`; os logs e achados anteriores foram preservados. Banco/servidores descartáveis encerrados, entradas temporárias de `tsconfig.json` retiradas e stack instalado preservado. Nenhum commit/deploy ou documento novo. **PROD-109 está `DONE` no aceite técnico local**; staging/release continuam sujeitos aos respectivos gates.
