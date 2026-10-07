# Relatório de auditoria — CVG Diagnostics Hub V2 (02/10/2026)

**Escopo:** working tree sobre `release/production-readiness` @ `92d92ad`. Inclui as alterações não commitadas de outra sessão (Codex, 01:50–01:56 de 02/10: dead-letter do outbox, migration 011, gestão de sessões). Foram feitas leitura dirigida do código de fronteira, persistência, sessão, realtime e outbox, a reexecução de todos os gates e uma medição de custo da persistência.
**Classificação:** `FACT` para o que foi medido ou executado nesta máquina; `DECISION` para notas e prioridades. Este relatório não aprova uso clínico nem produtivo.

Documentos relacionados: [plano até produção](build/PRODUCTION_PLAN.md) · [roadmap](build/PRODUCTION_ROADMAP.md) · [backlog](build/PRODUCTION_BACKLOG.md) · [auditoria anterior (01/10)](RELATORIO_AUDITORIA_2026-10-01.md)

## 1. Veredito

- **Nota global ponderada:** **77/100** (01/10: 76).
- **Estado:** implantável tecnicamente (o stack sobe em modo produção, verificado em 01/10), mas **não pronto para produção**.
- **Novo bloqueador técnico:** a persistência em snapshot JSONB tem um teto de escala medido (F-01). O problema era conhecido como "transitório", mas sem quantificação do impacto em runtime, e é ele que decide o prazo até a produção, junto das decisões clínicas.
- **Outros pontos:** segurança e operação melhoraram (CSP de fato ativa, bootstrap de produção, readiness fail-fast, dead-letter). Processo e documentação perderam pontos por um item marcado `DONE` sem estar feito (AUD-040) e por status defasados.

## 2. Gates executados (02/10/2026, Node 24.20 local; o CI usa Node 22)

| Gate | Resultado |
| --- | --- |
| `npm run typecheck`, `npm run lint`, `npm run build` | PASS; build com `ƒ Proxy (Middleware)` e todas as páginas dinâmicas |
| `npm run test:coverage` (unit + PostgreSQL 16 descartável) | PASS — 809/809 (768 unit em 91 arquivos + 41 PostgreSQL em 7 arquivos); 94,98% lines, 95,30% functions, 89,10% branches; `coverage:gate` PASS com 29 exceções declaradas |
| `npm run test:e2e -- --retries=0 --fail-on-flaky-tests` | 1ª execução: **62/63** — falha intermitente de axe no mobile (F-09). Após a correção: **63/63** sem retry. |
| `validate:docs`, `validate:openapi` (70 operações/65 paths), `validate:traceability` (43/43), `validate:migrations` (001–011), `security:scan` | PASS |
| `npm audit --audit-level=high` | PASS; restam 3 advisories `moderate` do Vitest (dev) |
| `npm run validate:aaa3` | Reprova (fail-closed): o candidato diverge do packet AAA-3 histórico congelado, o que é esperado. Não é regressão funcional. |
| CI remoto (GitHub Actions) | **Não executado** na branch de release |

## 3. Medição: custo da persistência em snapshot

Todo o estado clínico e operacional (usuários, sessões, pacientes, exames, resultados, notificações, **eventos de auditoria**, **outbox**, **registros de idempotência**) vive em uma linha `cvg_runtime_state.state` (JSONB).

Custo de CPU por leitura do estado (`JSON.parse` + dois `structuredClone`, como em `readState`/`runTransaction`), medido com o crescimento só de eventos de auditoria:

| Eventos de auditoria | Tamanho do JSON | stringify | parse | 2× clone |
| ---: | ---: | ---: | ---: | ---: |
| 1.000 | 0,4 MB | 1 ms | 1 ms | 3 ms |
| 10.000 | 3,6 MB | 9 ms | 13 ms | 40 ms |
| 100.000 | 36 MB | 142 ms | 90 ms | 477 ms |
| 300.000 | 109 MB | 409 ms | 289 ms | 1.614 ms |

Esses números não incluem a transferência do PostgreSQL nem a gravação no WAL. O `scrypt` de verificação de senha mede ~27 ms.

## 4. Notas por dimensão

| # | Dimensão | 01/10 | 02/10 | Peso | Motivo da mudança |
| --- | --- | ---: | ---: | ---: | --- |
| 1 | Arquitetura e código | 82 | **72** | 20% | Teto de escala medido (F-01–F-03); dispatcher ainda é cadeia de `if` (F-08) |
| 2 | Testes e CI/CD | 84 | **86** | 18% | 809 testes com PostgreSQL no denominador; CI remoto nunca rodou e houve 1 E2E intermitente |
| 3 | Segurança | 74 | **82** | 18% | CSP ativa, bootstrap e readiness fail-fast; restam F-03, F-04, F-05 e F-06 |
| 4 | Documentação | 85 | **80** | 15% | Status defasados no README e no relatório de status; AUD-040 sobredeclarado |
| 5 | UX / Frontend | 74 | **75** | 10% | CSP sem regressão em 3 viewports; inspeção manual de acessibilidade pendente |
| 6 | Operações | 57 | **68** | 10% | Caminho de deploy, bootstrap, dead-letter, gestão de sessões; faltam alertas, backup de S3, healthcheck do worker |
| 7 | Higiene e DevOps | 52 | **70** | 5% | Limpeza de builds, `.gitignore`, imagens; trabalho não commitado de outro agente na branch |
| 8 | Processo e evidência | 80 | **72** | 4% | Item `DONE` não verificado (AUD-040); a CSP nunca tinha sido testada até 01/10 |
| | **Global** | **76** | **77** | 100% | |

## 5. Achados

| ID | Sev. | Achado | Evidência | Backlog |
| --- | --- | --- | --- | --- |
| F-01 | **Crítico** | **Teto de escala do snapshot JSONB.** (a) Toda operação do store, inclusive leitura, passa por uma fila de promessas única por processo (`PostgresStore.enqueue`), então as requisições de um processo são servidas uma por vez. (b) Toda escrita trava a mesma linha (`SELECT … FOR UPDATE`) e regrava o JSON inteiro, então as escritas são seriais no cluster. (c) Nenhuma coleção é podada: sessões, auditoria, outbox processado e idempotência crescem sem limite. Com 100 mil eventos, cada requisição custa ~0,6 s de CPU; o PostgreSQL limita um valor JSONB a ~255 MB. | `src/server/store/postgres-store.ts` (`enqueue`, `runTransaction`, `readState`); medição em §3 | PROD-101…105 |
| F-02 | **Alto** | Cada conexão SSE faz **duas** leituras completas do estado a cada 5 s. Com 100 usuários conectados, são 40 leituras completas por segundo na fila serial; com 3,6 MB de estado, isso basta para saturar um processo. | `src/server/observability/realtime-stream.ts` (`send` → `readRealtimeState` ×2; intervalo padrão de 5.000 ms) | PROD-104 |
| F-03 | **Alto** | Login e reautenticação executam o `scrypt` (~27 ms) **dentro** da transação que trava a linha global de estado, inclusive nas tentativas com senha errada. Tentativas distribuídas (de muitos IPs, cada uma abaixo do rate limit) bloqueiam todas as escritas do sistema. | `src/server/security/session.ts` (`loginUser`, `reauthenticateUser`) | PROD-106 |
| F-04 | Médio | O rate limit por e-mail (10/min, de qualquer origem) permite **bloquear de propósito** o login de um usuário conhecido, como o de um plantonista. | `route.ts` (`login-email:` key) | PROD-107 |
| F-05 | Médio | A sessão tem só expiração absoluta de 8 h, sem timeout por inatividade; sessões expiradas e revogadas nunca são removidas. | `session.ts` (`SESSION_TTL_MS`) | PROD-103, PROD-205 |
| F-06 | Médio | Não há troca nem redefinição de senha (AUD-046 continua aberto); a única saída é desativar e recriar a conta. | Manifesto sem a operação | PROD-201…204 |
| F-07 | Médio | O worker do outbox não tem healthcheck nem sinal de liveness: um worker travado passa despercebido até alguém notar notificações paradas. | `docker-compose.prod.yml` (só o postgres tem healthcheck) | PROD-306 |
| F-08 | Médio | **AUD-040 sobredeclarado:** o matching usa o manifesto, mas o handling continua numa cadeia com **71** comparações `operationId ===`. `route.ts` tem 777 linhas e `postgres-store.ts` 793, contra o teto de 800 imposto pelo teste de arquitetura, então qualquer feature nova esbarra no limite. | `route.ts`, `architecture-fitness.test.ts` | PROD-108 |
| F-09 | Baixo | E2E intermitente: o helper de axe varria `main` antes de a página renderizar (mais provável com renderização por requisição). **Corrigido nesta auditoria** (espera do landmark). | `tests/e2e/clinical-lifecycle.spec.ts` | — |
| F-10 | Baixo | Status defasados: o README e o `PROJECT_STATUS_REPORT.md` ainda descrevem 07/09 (725 testes, sem caminho de deploy). | `README.md`, `docs/PROJECT_STATUS_REPORT.md` | Atualizado nesta auditoria |
| F-11 | Baixo | O CI remoto nunca rodou na branch de release, e a branch tem trabalho não commitado de outro agente: não existe um commit candidato com evidência remota. | `git status`, Actions | PROD-001, PROD-002 |
| F-12 | Baixo | 3 advisories `moderate` do Vitest (somente dev); a correção exige upgrade com breaking changes. | `npm audit` | PROD-109 |
| F-13 | Info | `allowedDevOrigins` com IP de LAN fixo (afeta só o dev). | `next.config.mjs` | PROD-109 |

### Pontos fortes confirmados

- Fronteira HTTP com validação completa (Zod, headers, If-Match, limites de corpo); 404 para recursos fora do escopo; nenhum stack trace vaza ao cliente; erros 500 registrados com correlação.
- Dead-letter do outbox (trabalho do Codex) correto: idempotente, exige motivo e reautenticação recente, auditado; a migration 011 é aditiva.
- CSP com nonce verificada em navegador real e no CI; a matriz E2E inteira passa com ela ativa.
- Bootstrap de produção transacional, idempotente por recusa e auditado; readiness fail-fast para segredos.

## 6. Correções feitas nesta auditoria

- **F-09:** espera do landmark `main` antes do axe em `tests/e2e/clinical-lifecycle.spec.ts`. A matriz completa foi reexecutada depois da correção (resultado registrado na seção 9 do [backlog](build/PRODUCTION_BACKLOG.md)).
- **F-10:** README, `PROJECT_STATUS_REPORT.md`, `PRODUCTION_READINESS.md` e o índice atualizados para 02/10/2026.
- **F-08:** AUD-040 reaberto no backlog AUDIT-2026-10, com o motivo.
- O [plano até produção](build/PRODUCTION_PLAN.md) foi atualizado: a decisão de persistência (P4.2) deixa de ser condicional e vira obrigatória.

## 7. Recomendação

1. Tratar F-01–F-03 como **trilha técnica crítica** e começar já, em paralelo às decisões humanas. Isso não depende de nenhuma decisão clínica.
2. Antes do cutover relacional completo, aplicar as mitigações baratas: tirar a auditoria do snapshot (ela já é projetada na tabela `audit_events`), podar sessões/idempotência/outbox processado e fazer o realtime ler só o delta do outbox, acordado pelo `LISTEN/NOTIFY` que já existe, em vez de duas leituras completas por conexão. Isso compra margem sem mudar a autoridade clínica.
3. Commitar o trabalho pendente, fazer o CI remoto rodar verde e só então abrir a Fase 1 do plano.
4. Re-auditoria independente depois de concluídas as ondas W1 e W2 do [roadmap](build/PRODUCTION_ROADMAP.md).
