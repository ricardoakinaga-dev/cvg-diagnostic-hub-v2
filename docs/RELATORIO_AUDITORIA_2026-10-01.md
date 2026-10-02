# Relatório de auditoria — CVG Diagnostics Hub V2

**Data:** 01/10/2026
**Escopo:** leitura integral da documentação (`docs/`, 87 Markdown + `api/openapi.json`) e auditoria técnica do repositório em `main` @ `6ab4735`, com reprodução local dos gates.
**Classificação:** auditoria técnica e documental local. `FACT` para tudo que foi medido ou executado nesta máquina; `DECISION` para as notas atribuídas. Não é aprovação clínica, hospitalar ou produtiva. As seções 1–5 preservam o snapshot inicial em `main` @ `6ab4735`; a atualização de execução abaixo é a fonte corrente do working tree.

Documentos relacionados:

- [Plano executivo](build/AUDIT_2026_10_EXECUTIVE_PLAN.md)
- [Roadmap](build/AUDIT_2026_10_ROADMAP.md)
- [Backlog](build/AUDIT_2026_10_BACKLOG.md)
- [Auditoria anterior (07/09/2026)](RELATORIO_AUDITORIA_2026-09-07.md)
- [Baseline (05/09/2026)](RELATORIO_AUDITORIA_2026-09-05.md)

## 1. Veredito executivo

- **Nota global ponderada:** **76/100**.
- **Estado:** candidato técnico forte e verificável, **não pronto para produção clínica** — conclusão que a própria documentação já declara.
- A nota é puxada para baixo por **segurança com advisories críticos pendentes** e por **operação inexistente** (deploy, alertas, RPO/RTO), não por código fraco: arquitetura, testes e documentação operam na faixa 82–85.

## 2. Evidência executada no snapshot inicial

Todos os comandos foram executados nesta máquina em 01/10/2026 sobre a árvore limpa de `main`.

| Gate | Resultado |
| --- | --- |
| `npm run typecheck` | **EXIT=0** |
| `npm run lint` (`eslint .`) | **EXIT=0** |
| `npm run test:coverage` | **EXIT=0** — 725/725 testes em 86 arquivos; lines 92,72%; branches 85,79%; functions 94,37% |
| `npm audit --omit=dev --audit-level=high` | **falha** — 2 vulnerabilidades (1 critical em `next@16.3.0`, 1 high em `sharp@0.35.3`) |
| `node scripts/validate-traceability.mjs` | **PASS** — 43 requisitos e 43 AC ligados a code, test, command e evidence |
| `node scripts/validate-openapi.mjs` | **PASS** — 65 operações em 60 paths |
| `bash scripts/validate-docs.sh` | **EXIT=1** — 29 issues, todas artefato da ausência de `rg` nesta máquina |
| `bash scripts/secret-scan.sh` | **EXIT=0 falso** — imprime "Secret scan passou" sem ter escaneado nada |
| Hygiene do working tree | **30 GB** em 200 diretórios `.next-*` acumulados |

Cobertura por camada medida (`coverage/coverage-summary.json`): `store` 78,43% lines, `postgres-store.ts` 61,21%, `relational/clinical-core-adapter.ts` 60,95% — as partes mais críticas de persistência são as piores cobertas.

## 2.1 Atualização de execução — 01/10/2026

Esta seção registra a execução posterior da onda AUDIT-2026-10. Ela não reescreve a nota 76/100 nem os achados do snapshot inicial; o aceite atual por item está no [backlog](build/AUDIT_2026_10_BACKLOG.md).

| Gate | Resultado corrente |
| --- | --- |
| `npm run test:coverage` | **PASS** — 745 testes unitários em 89 arquivos + 39 testes PostgreSQL em 6 arquivos; 94,90% lines, 95,45% functions e 89,31% branches |
| `coverage:gate` | **PASS** — 28 exceções versionadas; zero arquivos `uncovered` e zero `stale` |
| Browser | **PASS** — 63/63 sem retry; visual 3/3 e acessibilidade 12/12 |
| `node --test scripts/coverage-report.test.mjs` | **PASS** — 5/5, incluindo o caminho negativo de arquivo abaixo do limiar sem exceção |
| `npm run test:mutation` | **PASS** — 7/7 controles detectados e relatório publicado no CI |
| Typecheck/lint/build | **PASS** |
| OpenAPI/traceabilidade | **PASS** — 65 operações/60 paths e 43/43 requisitos/AC |
| `npm run security:scan` | **PASS** — fallback `grep` declarado quando `rg` não existe |
| `npm audit --audit-level=high` | **PASS** para `critical`/`high`; permanecem advisories `moderate` do Vitest |

As correções técnicas correntes cobrem os gates de segurança, headers, rate limit, readiness de migration, logger correlacionado, cobertura PostgreSQL, gate por arquivo, contratos de frontend, métricas, Docker/CI, baseline visual e dispatcher orientado pelo manifesto. O dispatcher agora usa `operationId`, `service-common.ts` foi dividido e a fronteira é protegida por testes de arquitetura.

Os limites permanecem: inspeção manual de acessibilidade, donos/roteamento de alertas, RPO/RTO, secret manager, política de histórico, revisão independente, CI remoto, workload representativo, failover, storage/AV real, cutover relacional e aceite clínico/hospitalar. O candidato continua `CONDITIONAL PASS LOCAL / BLOCKED` para produção clínica.

## 3. Notas por dimensão

As notas e os achados desta seção pertencem ao snapshot inicial @ `6ab4735`.
Correções posteriores e seu aceite técnico estão registrados no backlog e na
seção 2.1; nenhum achado histórico deve ser lido como uma medição do working
tree corrente sem essa atualização.

| # | Dimensão | Nota | Peso |
| --- | --- | ---: | ---: |
| 1 | Arquitetura e qualidade de código | 82 | 20% |
| 2 | Testes e CI/CD | 84 | 18% |
| 3 | Segurança | 74 | 18% |
| 4 | Documentação | 85 | 15% |
| 5 | UX / Frontend | 74 | 10% |
| 6 | Operações e Production Readiness | 57 | 10% |
| 7 | Higiene do repositório e DevOps | 52 | 5% |
| 8 | Processo, evidência e honestidade | 80 | 4% |
| | **Global ponderado** | **76** | **100%** |

### 3.1 Arquitetura e qualidade de código — 82/100

Monólito modular com fronteiras mecanicamente impostas: `src/server/architecture-fitness.test.ts` reconstrói o grafo real de imports com a API do TypeScript e falha em violação de allowlist, ciclo ou arquivo acima de 800 LOC (3 testes, todos executados e aprovados). `domain` importa somente tipos de `contracts`; `application` nunca importa `store`; zero `any`, zero `@ts-ignore`, zero `eslint-disable`, zero marcadores de dívida, 107 blocos `catch` sem vazio, 426 placeholders SQL parametrizados com identificadores validados.

Pontos que seguram a nota:

- **500 nunca é logado no servidor:** `src/app/api/v1/[...path]/route.ts:589-591` captura a exceção e delega a resposta genérica; não existe um único `logger.error` em código de produção e o allowlist de campos do logger não admite mensagem nem stack.
- **Dispatcher monolítico:** `route.ts` tem 687 LOC e ~49 condições `path[0]==… && method==…`; o manifesto `api-operation-manifest.ts` já declara as operações, mas o matching e o handling são dois mecanismos independentes que podem divergir silenciosamente; 17 schemas Zod duplicados entre `route.ts` e `command-schemas.ts`.
- **`service-common.ts` no teto:** 799 LOC (limite 800), ~50 exports sem coesão, importado como namespace por 6 services.
- **DTOs duplicados no frontend:** `SessionUser` 4×, `Notification` 3×, `Request`/`Patient`/`QueueItem` 2× cada; `@cvg/contracts` não é usado como fonte de verdade na camada web.
- **`packages/` sem workspaces npm reais:** resolução por `paths` do tsconfig + `transpilePackages`; a fronteira é imposta pelo teste, não pelo toolchain.

### 3.2 Testes e CI/CD — 84/100

Pirâmide completa: 725 unit/componente, 35 de integração PostgreSQL, 60 execuções E2E em 3 viewports; razão de 1,06 LOC de teste por LOC de código; zero `.skip`/`.only` em toda a árvore; asserções negativas reais (404 indistinguível entre DRAFT e VOIDED, fail-closed de produção, não vaza stack nem credencial). CI com 3 jobs, gate de cobertura 90/90/85, sentinela de mutação 7/7, SBOM, perf, recovery e lane production-like com PostgreSQL, S3 e scanner sintéticos; E2E com `--retries=0 --fail-on-flaky-tests`.

Pontos que seguram a nota:

- A integração PostgreSQL roda **sem cobertura**, o que deixa `postgres-store.ts` em 61% e a camada `store` em 78% fora do denominador do gate.
- 37 dos 99 arquivos estão abaixo do limiar por arquivo e o relatório apenas imprime, sem falhar; branches a 0,79 p.p. do limite global.
- Mutação é um sentinela de 7 mutantes manuais, não um score de sensibilidade.
- Sem CD, sem Dependabot/dependency review, sem SAST/CodeQL, sem matriz de SO/Node, sem baseline visual no CI; a acessibilidade roda duas vezes no pipeline.

### 3.3 Segurança — 74/100

Controles acima da média: scrypt com salt e comparação em tempo constante, sessão opaca armazenada só como hash SHA-256, cookie HttpOnly/SameSite, step-up de 10 min em gestão de usuários, RBAC com matriz central e escopo por paciente (negado responde 404), CSRF por operação com invariante testada, validação total de corpo (bytes e profundidade, UTF-8 fatal), CSP com nonce e `strict-dynamic`, ausência completa de sinks de XSS, upload com sniffing de magic bytes e AV fail-closed com quarentena, audit append-only imposto por triggers no banco, rate limit `memory` recusado em produção.

Achados:

| Severidade | Achado | Local |
| --- | --- | --- |
| Crítico | `next@16.3.0` na faixa de 3 advisories de RCE (GHSA-p293-qw3h-jr36, GHSA-2xp9-vwfh-vxw4, GHSA-vcvr-r3jv-pc5j); `sharp@0.35.3` high; CI de `npm audit` em vermelho enquanto a documentação afirma zero vulnerabilidades | `package.json`, `package-lock.json` |
| Alto | Rate limit em bucket único global quando o cliente remoto não é identificável (`local-client`/`untrusted-proxy`) — 10 tentativas de login por minuto são globais, permitindo lockout de todos os usuários | `route.ts:109-112`, `route.ts:254-256` |
| Médio | User enumeration por timing no login e no step-up (curto-circuito do scrypt quando o usuário não existe) | `session.ts:43`, `session.ts:110` |
| Médio | Sem HSTS em nenhuma camada, contra o que `SECURITY.md:42` declara | ausente |
| Médio | Nenhum header CORS emitido, contra a "CORS allowlist" documentada | ausente |
| Médio | Sem fluxo de redefinição de senha e sem lockout/backoff, ambos citados nos docs | manifesto sem a operação |
| Médio | Credenciais fixas no compose com portas em todas as interfaces (`cvg_dev`, `cvg-minio-development-only`) | `docker-compose.yml:8,24` |
| Baixo | `/livez` e `/readyz` antes do rate limit; cookie malformado gera 500 em vez de 401; uploads acima de 10 MB esbarram no limite do proxy; senha única de seed para 6 contas | `route.ts:245-253`, `session.ts:28`, `fixtures.ts` |

Divergências doc × código: `SECURITY.md` declara Argon2id (o código usa scrypt), reset de senha, HSTS, CORS allowlist e step-up para export/break-glass — nenhum existe; `ADVERSARIAL_REVIEW_SUPPLEMENT_2026-09-07.md` afirma `npm audit` zerado.

### 3.4 Documentação — 85/100

91 documentos, 9.746 linhas, 108.992 palavras cobrindo o ciclo completo discovery → PRD → spec → arquitetura → UX → segurança → testes → operações → build, com 8 ADRs consistentes, OpenAPI sem drift, classificação epistêmica (`FACT`/`ASSUMPTION`/`DECISION`/`OPEN QUESTION`) imposta por gate, zero links locais quebrados, zero marcadores de preenchimento e zero requisitos ou AC órfãos na matriz de rastreabilidade.

Pontos que seguram a nota:

- `scripts/validate-docs.sh` retorna EXIT=1 em qualquer ambiente sem `rg` (29 falsos positivos confirmados com `grep -F`) e, pior, **pula silenciosamente três classes de checagem** quando `rg` falta (`:81` placeholders, `:94` e `:102` órfãos) — o gate falha alto no errado e falha baixo no certo.
- `required_files` defasada: exige o relatório de 05/09 mas não os três de 07/09 que o próprio índice chama de corrente; `docs/v2/LABORATORY_VERTICAL.md` fora da lista.
- `TEST_PLAN.md` cita acessibilidade 6/6, 9/9 e 12/12 no mesmo documento; `PRODUCTION_READINESS.md:29` aponta 614/614 (era AAA-2) quando a baseline corrente é 725/725; `RELEASE_CHECKLIST.md:17` chama 51/51 de "corrida atual" contradizendo `:11`.
- Índice `docs/README.md` não alcança `v2/*`, `GLOSSARY.md` nem `DECISION_LOG.md`; glossário (34 linhas) e decision log (22 linhas) finos para 87 documentos.

### 3.5 UX / Frontend — 74/100

12 rotas, 19 componentes, split server/client limpo (12 `page.tsx` finas, 17 `"use client"`). Acessibilidade genuína: 136 atributos `aria-*`, 69 `role=`, combobox completo com live region, focus trap com restauração e suporte a diálogos empilhados, tabs com roving tabindex, status sempre pareado com texto além de cor, pt-BR consistente com dicionários de enum, degradação parcial/stale tratada como caso de primeiro cidadão, 196 PNGs de evidência em 3 viewports.

Pontos que seguram a nota:

- Design system aspiracional: 8 dos 12 componentes de `DESIGN_SYSTEM.md` não existem no código e o `radius` documentado (8–12px) diverge dos tokens reais (16–32px).
- O kit `feedback-states.tsx` é usado por 2 de ~10 consumidores; os demais fazem markup próprio com semântica desigual; focus trap duplicado no drawer da fila, sem restauração de foco.
- Alvos de 26–32px violam a régua de 44px que o próprio E2E de acessibilidade impõe (F-15, aberto no relatório frontend).
- Axe com 15 regras de ~70, aplicado com `.include("main")` — sidebar, topbar e navegação móvel ficam fora da varredura.
- Inspeção manual com leitor de tela nunca executada (FE-0005 e FE-7002 `PENDING`).

### 3.6 Operações e Production Readiness — 57/100

Implementado de fato: `/livez`, `/readyz` fail-closed com `getRuntimeReadiness()`, `/metrics` Prometheus autenticado, logger estruturado com allowlist de 9 campos e bloqueio de conteúdo clínico, ~10 métricas técnicas, scripts de backup/restore com `set -euo pipefail`, trava `ALLOW_DB_RESTORE` e verificação de checksum por manifesto, runbooks com comandos executáveis, classificação P0/P1/P2 e stop criteria.

O que falta é exatamente o que separa "bem instrumentado" de "operável": nenhum caminho de deploy (zero Dockerfiles de aplicação, zero jobs de deploy, compose só sobe PostgreSQL e MinIO), nenhum alert routing/threshold/secret manager, RPO/RTO marcado como `ASSUMPTION` não aprovado, 26/26 gates de `PRODUCTION_READINESS.md` e 19/19 de `RELEASE_CHECKLIST.md` abertos, métricas de negócio não emitidas, e `/readyz` sem checagem de compatibilidade de migration ao contrário do que `OBSERVABILITY.md:42` declara.

### 3.7 Higiene do repositório e DevOps — 52/100

Bom: `.gitignore` completo, `.env` fora do versionamento, `package-lock.json` versionado, `.nvmrc` e `engines` fixando Node 22, árvore git limpa.

Ruim:

- **30 GB em 200 diretórios `.next-*`** acumulados no working tree, sem rotina de limpeza.
- `scripts/secret-scan.sh` **reporta falso "passou" quando `rg` não existe** (EXIT=0 confirmado nesta máquina, sem escanear nada) — gate de segurança inoperante localmente e invisível na CI, que tem `rg`.
- `tsconfig.json` com 479 entradas em `include`, das quais ~474 são globs `.next-*` obsoletos, versionado com 531 linhas.
- 382 arquivos de processo (`.orchestrate`, `.gauntlet*`, `.agent`) misturados com código-fonte; apenas 12 commits no histórico.
- Sem Dockerfile da aplicação; compose com senha fixa e portas em todas as interfaces; sem Dependabot ou Renovate.

### 3.8 Processo, evidência e honestidade — 80/100

Cultura incomum e real: 76+ packets de evidência com hash SHA-256, evidence-manifest, quality bar congelado, rodadas de crítico independente, controles de mutação, matriz de rastreabilidade validada por script, e status declarado `CONDITIONAL PASS / BLOCKED` com 45 gates de produção e release marcados abertos — nenhum marcado falso como concluído. Os relatórios anteriores são autocríticos e nenhum documento vende prontidão.

Pontos que seguram a nota: drift numérico recorrente entre documentos que se chamam de mesma baseline (51/57/60/614/619; branches 85,82 documentado contra 85,79 medido), achado F-18 do relatório frontend já superado pelo código — a auditoria visual não é contínua — e um processo que gera artefatos mais rápido do que archive.

## 4. Top 5 correções do snapshot inicial (histórico)

As recomendações seguintes são a fotografia que abriu a onda. Para o estado corrente, use os status e a evidência do backlog AUDIT-2026-10.

1. **`next@≥16.3.8` + `npm audit fix`** — elimina o critical e re-verdeja o gate de auditoria de dependências do CI.
2. **Consertar `secret-scan.sh` e `validate-docs.sh`** — preflight de `rg` com falha explícita ou port para `grep`; hoje o scan de segredos passa falso e o gate de documentação falha falso, ambos confirmados.
3. **Chave do rate limit por cliente real, HSTS e timing uniforme no login** — fecha lockout de login, enumeração de usuário e as divergências de documentação.
4. **`logger.error` nos 500 e checagem de migration no `/readyz`** — observabilidade de falha crítica hoje inexistente.
5. **Cobertura da integração PostgreSQL, gate por arquivo e limpeza dos 30 GB** — a camada mais crítica (`store`, 61%) passa a ser medida e o repositório deixa de carregar 200 builds.

## 5. Recomendação

Nenhuma decisão de produção, piloto ou cutover antes do fechamento dos itens P0 do [backlog](build/AUDIT_2026_10_BACKLOG.md) e de uma re-auditoria independente com nota mínima de 85. Os gates humanos já abertos em `PRODUCTION_READINESS.md`, `OPEN_QUESTIONS.md` e no programa AAA-3 permanecem inalterados por este relatório: fechar as falhas deste levantamento não aprova uso clínico, apenas remove dívida técnica verificável.
