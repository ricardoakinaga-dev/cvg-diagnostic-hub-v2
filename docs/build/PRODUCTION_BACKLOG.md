# Backlog até produção — CVG Diagnostics Hub

**Versão:** PROD-2026-10.1
**Data:** 03/10/2026
**Fonte:** [auditoria de 02/10/2026](../RELATORIO_AUDITORIA_2026-10-02.md) + [plano até produção](PRODUCTION_PLAN.md) + [revisão da entrega do agente](../RELATORIO_REVISAO_ENTREGA_AGENTE_2026-10-02.md)

[Roadmap](PRODUCTION_ROADMAP.md) · [Plano](PRODUCTION_PLAN.md) · [Auditoria](../RELATORIO_AUDITORIA_2026-10-02.md) · [Backlog AUDIT-2026-10 (anterior)](AUDIT_2026_10_BACKLOG.md)

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
| PROD-101 | P0 | READY | L | **Auditoria fora do snapshot:** `audit_events` (já projetada e append-only por trigger) vira a fonte de leitura de auditoria e timeline; o snapshot guarda só os eventos novos da transação, para projeção. Aceite: o tamanho do snapshot não cresce com a auditoria; os testes de auditoria e timeline passam contra a tabela. | PROD-110 (linha de base) | F-01 |
| PROD-102 | P0 | READY | L | **Outbox fora do snapshot:** worker, dead-letter e realtime leem `outbox_messages`; mensagens processadas saem do estado. Aceite: o snapshot não cresce com o outbox processado; os testes de outbox e dead-letter passam. | PROD-110 | F-01 |
| PROD-103 | P0 | VERIFY | M | **Retenção técnica:** remoção de sessões expiradas ou revogadas e de registros de idempotência vencidos (janela documentada), auditada. Aceite: teste de expurgo; tamanho estável sob carga contínua no PROD-110. | — | F-01, F-05 |
| PROD-104 | P0 | VERIFY | M | **Realtime sem leitura completa por conexão:** um único leitor incremental por processo (cursor do outbox), acordado pelo `LISTEN/NOTIFY` já existente e distribuído às conexões; a autorização é revalidada pela versão do usuário e da sessão, sem segunda leitura completa. Aceite: com 100 conexões, leituras do estado por segundo ≤ 1 por processo, medidas no PROD-110. | PROD-102 | F-02 |
| PROD-105 | P0 | READY | M | **Leituras sem fila serial:** só as escritas passam pela transação; as leituras usam uma cópia em cache por versão, invalidada pelo `pg_notify` de `cvg_runtime_state_changed` que já existe. Aceite: leituras concorrentes no PROD-110 sem regressão nos testes multi-instância. | PROD-101, PROD-102 | F-01 |
| PROD-111 | P0 | BLOCKED | XL | **Cutover relacional:** autoridade clínica nas tabelas das migrations 007–010 (adapter, backfill e reconciliação já existem), com o snapshot aposentado. Aceite: dual-read sem divergência em staging; PROD-110 dentro da meta no volume de 12 meses; rollback ensaiado. | PROD-101…105, D2 | F-01, P4.2, ADR de persistência |
| PROD-107 | P1 | VERIFY | S | O rate limit por e-mail deixa de permitir bloqueio direcionado: chave por (e-mail, cliente) com backoff progressivo pelo mesmo par, sem ampliar a janela do dono legítimo que vem de outra origem. Aceite: teste em que um atacante não bloqueia o login da vítima a partir de outro cliente. | — | F-04 |
| PROD-108 | P1 | READY | M | Dispatcher com mapa `operationId → handler` validado contra o manifesto; `route.ts` e `postgres-store.ts` abaixo de 600 linhas; teste que falha se faltar handler para alguma operação. Aceite: zero cadeias `operationId ===`; teste de arquitetura verde. Reabre o AUD-040. | — | F-08, AUD-040 |
| PROD-109 | P2 | IN_PROGRESS | S | Upgrade do Vitest (advisories `moderate`); `allowedDevOrigins` por variável de ambiente. Aceite: `npm audit` sem advisories. | — | F-12, F-13 |

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
| W1 Escala | 11 | 4 | 1 | 5 | 1 |
| W2 Identidade | 6 | 0 | 0 | 1 | 5 |
| W3 Infra | 9 | 1 | 0 | 2 | 6 |
| W4 Clínico/dados/operação | 20 | 5 | 0 | 0 | 15 |
| W5 Validação/piloto | 10 | 0 | 0 | 0 | 10 |
| **Total** | **59** | **13** | **1** | **8** | **37** |

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

`PROD-109` ficou `IN_PROGRESS`: `allowedDevOrigins` passou a vir de
`NEXT_ALLOWED_DEV_ORIGINS` (o IP de LAN fixo saiu do `next.config.mjs`), mas o
aceite "`npm audit` sem advisories" **não** pode ser atingido sem uma mudança
quebra: em 03/10/2026 os 5 advisories `high` restantes são todos da cadeia de
desenvolvimento (`eslint-config-next` → `@next/eslint-plugin-next` →
`fast-glob`/`micromatch`/`braces`) e o `npm audit fix --force` sugerido instala
`eslint-config-next@14.2.35`, rebaixando o plugin de lint. Nenhum deles está em
dependência de produção; o critério de produção continua sendo
`npm audit --omit=dev --audit-level=high`, como em D-016.

Itens do backlog fechados nesta onda: **PROD-106** (`DONE`), **PROD-103, 104, 107, 205, 305, 306** em `VERIFY` (aguarding evidência de execução contínua em staging). **PROD-101, 102 e 105** seguem `READY`: dependem da execução do benchmark no volume de D2, que ainda é `BLOCKED` por decisão humana. `PROD-108` (dispatcher por mapa) segue `READY` e não foi tocado nesta onda, embora a extração do backfill e do codec tenha reduzido `postgres-store.ts`, que ainda supera a meta de 600 linhas.

Linha de base de 02/10/2026 (detalhe no [relatório](../RELATORIO_AUDITORIA_2026-10-02.md), seção 2):

- 809/809 testes (unit + PostgreSQL), 94,98% lines, 95,30% functions, 89,10% branches; `coverage:gate` PASS.
- typecheck, lint, build, docs, OpenAPI 70/65, rastreabilidade 43/43, migrations 001–011, secret scan e `npm audit --audit-level=high`: PASS.
- E2E: 62/63 na primeira execução (F-09, axe antes da renderização no mobile); depois da correção, `npm run test:e2e -- --retries=0 --fail-on-flaky-tests` → **63/63** (5,8 min).

Correção de 03/10/2026: PROD-110 segue `IN_PROGRESS`: os gates de bytes e leituras em processo não comprovam p95 HTTP, throughput, latência ou locks PostgreSQL em carga com SSE. Evidências locais e contagem de variáveis estão na atualização do [relatório de revisão](../RELATORIO_REVISAO_ENTREGA_AGENTE_2026-10-02.md).

Revisão complementar de 03/10/2026: PROD-517 registra a detecção agregada por conta como monitoramento, sem bloqueio por e-mail. Antes do deploy, comprovar a identidade do cliente através do proxy real, incluindo `X-Forwarded-For` forjado conforme [DEPLOYMENT §5.1](../operations/DEPLOYMENT.md#51-identidade-do-cliente-e-x-forwarded-for-forjado), e anexar o benchmark de staging do PROD-110. Esses dois aceites permanecem pendentes; validação local não os substitui.

Instalação local autorizada em 03/10/2026: [stack isolado](../operations/LOCAL_INSTALLATION.md) disponível em `https://localhost:18443`, com PostgreSQL, S3 e ClamAV reais. O teste de `X-Forwarded-For` forjado passou nesta borda Caddy com comparação dos três contadores PostgreSQL; uma futura borda institucional deve repetir o aceite na própria topologia. O benchmark de staging do PROD-110 continua pendente. Nenhum status de go-live foi alterado por esta instalação.
