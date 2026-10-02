# Backlog Pós-Auditoria — CVG Diagnostics Hub

> **Substituído para execução em 02/10/2026** pelo [backlog PROD-2026-10](PRODUCTION_BACKLOG.md). Este documento fica como registro da onda AUDIT-2026-10.

**Versão:** AUDIT-2026-10
**Data:** 01/10/2026
**Estado:** execução local concluída com aceite técnico condicionado; gates humanos, de ambiente-alvo e de revisão independente permanecem abertos

[Plano executivo](AUDIT_2026_10_EXECUTIVE_PLAN.md) · [Roadmap](AUDIT_2026_10_ROADMAP.md) · [Relatório](../RELATORIO_AUDITORIA_2026-10-01.md)

## 1. Como usar este backlog

Este backlog é a fonte de execução da onda AUDIT-2026-10. Os backlogs AAA-3 e anteriores e seus IDs permanecem válidos para os seus programas; nada aqui os substitui.

Cada item precisa manter a cadeia:

achado do relatório → correção → teste ou verificação → evidência nova → aceite mínimo.

Status válidos:

- `NOT_READY`: identificado, ainda não preparado;
- `READY`: pode começar sem decisão bloqueante;
- `IN_PROGRESS`: execução ativa;
- `BLOCKED`: depende de autoridade, ambiente ou resultado anterior;
- `VERIFY`: implementação pronta, aguardando prova;
- `DONE`: aceite atual comprovado por evidência nova;
- `DEFERRED`/`CANCELLED`: decisão explícita de escopo.

Nenhum item vira `DONE` apenas por existir código, teste ou packet histórico.

Prioridades: `P0` bloqueia segurança, garantia ou gate; `P1` necessário para completude operacional/qualidade; `P2` melhoria importante sem bloquear o gate.

Tamanhos: `S` até 3 dias-pessoa; `M` 4–8; `L` 9–20; `XL` acima de 20 ou dependência externa.

Referência de achados: [relatório de 01/10/2026](../RELATORIO_AUDITORIA_2026-10-01.md), seções 3.1 a 3.8.

## 2. G0 — gates honestos e higiene

| ID | Pri | Status | Dono / tamanho | Entrega verificável e aceite mínimo |
| --- | --- | --- | --- | --- |
| AUD-001 | P0 | DONE | Engenharia / S | `scripts/secret-scan.sh` falha com mensagem clara quando o mecanismo de busca falta, ou usa fallback declarado; prova: execução em ambiente sem a ferramenta retorna EXIT=1 quando há achado e EXIT=0 quando não há. Achado §3.7. |
| AUD-002 | P0 | DONE | Engenharia / S | `scripts/validate-docs.sh` com preflight da ferramenta de busca e com as três classes de checagem hoje puladas (`:81`, `:94`, `:102`) restauradas; prova: remoção proposital de um placeholder e de um requisito órfão produz EXIT=1. Achado §3.4. |
| AUD-003 | P1 | DONE | Produto / S | `required_files` do validador inclui os três relatórios de 07/09 e `docs/v2/LABORATORY_VERTICAL.md`; exclusão proposital de um deles reprova o gate. |
| AUD-004 | P1 | DONE | Engenharia / S | Remoção dos diretórios de build descartáveis acumulados (~30 GB) e rotina de limpeza pós-E2E no `package.json`/CI; prova: `du` após rodada completa não reacumula. Achado §3.7. |
| AUD-005 | P1 | DONE | Engenharia / S | `tsconfig.json` sem globs de build descartável versionados, com `include` estável e `exclude` correto; prova: rebuild não altera o arquivo. Achado §3.1. |
| AUD-006 | P2 | BLOCKED | Produto / M | Política para artefatos de processo (`.orchestrate`, `.gauntlet*`, `.agent`): manter no repositório com regra de archive ou mover para artefato de release; decisão registrada no DECISION_LOG. Achado §3.7. |

## 3. G1 — exposição eliminada

| ID | Pri | Status | Dono / tamanho | Entrega verificável e aceite mínimo |
| --- | --- | --- | --- | --- |
| AUD-007 | P0 | DONE | Engenharia + segurança / S | `next` em faixa sem advisories críticos e `sharp` atualizado; `npm audit --audit-level=high` exit 0; matriz browser 60/60 verde antes e depois. Achado §3.3 (crítico). |
| AUD-008 | P0 | DONE | Engenharia / M | Chave de rate limit derivada do cliente identificável, com recusa explícita em produção quando o proxy não é confiável; teste de que um cliente não derruba o login dos demais. Achado §3.3 (alto). |
| AUD-009 | P1 | DONE | Engenharia / S | `Strict-Transport-Security` emitido em produção mais `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy` e `X-Permitted-Cross-Domain-Policies`; teste de header. Achado §3.3 (médio). |
| AUD-010 | P1 | DONE | Engenharia / S | Comparação de senha em tempo constante mesmo para usuário inexistente ou inativo, no login e no step-up; teste de distribuição de tempo ou prova de caminho único de verificação. Achado §3.3 (médio). |
| AUD-011 | P1 | DONE | Engenharia + segurança / M | Fluxo de troca/redefinição de senha com token de uso único e backoff progressivo, ou remoção dessas promessas de `SECURITY.md` e `THREAT_MODEL.md`; decisão registrada. Achado §3.3 (médio). |
| AUD-012 | P0 | DONE | Segurança / S | `SECURITY.md`, `THREAT_MODEL.md` e `ADVERSARIAL_REVIEW_SUPPLEMENT_2026-09-07.md` coerentes com o código: KDF real, HSTS, CORS, step-up, estado da auditoria de dependências; revisão de segurança assina. Achado §3.3 (divergências). |
| AUD-013 | P1 | DONE | Engenharia / S | `docker-compose.yml` sem credenciais fixas e com portas restritas a `127.0.0.1`; prova: subir o stack não publica serviço em todas as interfaces. Achado §3.3 (médio). |
| AUD-014 | P2 | DONE | Engenharia / S | Seed gera senha única por usuário e permanece bloqueado fora de dev/teste; teste no guardrail de fixtures. Achado §3.3 (médio). |
| AUD-015 | P2 | DONE | Engenharia / S | `/livez` e `/readyz` sujeitos a bucket de rate limit próprio; cookie malformado tratado como sessão ausente (401) em vez de 500; limite do proxy compatível com o limite de anexo declarado. Achado §3.3 (baixo). |

## 4. G2 — o que importa é medido

| ID | Pri | Status | Dono / tamanho | Entrega verificável e aceite mínimo |
| --- | --- | --- | --- | --- |
| AUD-016 | P0 | DONE | QA / L | Suíte de integração PostgreSQL dentro do denominador de cobertura; `postgres-store.ts` ≥ 80% lines; dependência: host com cluster descartável (`initdb`/Docker). Achado §3.2. |
| AUD-017 | P1 | DONE | QA / M | Gate por arquivo de cobertura ativo no CI; 37 arquivos hoje abaixo do limiar corrigidos ou com exceção declarada, versionada e justificada. Achado §3.2. |
| AUD-018 | P0 | DONE | Engenharia / M | Falha inesperada gera `logger.error` correlacionado, sem vazar stack ao cliente e sem quebrar o allowlist de campos; teste que injeta exceção na rota e afirma a correlação. Achado §3.1. |
| AUD-019 | P1 | DONE | Engenharia / S | `/readyz` verifica compatibilidade de migration, conforme `OBSERVABILITY.md:42`; teste de leitura negativa com migration divergente. Achado §3.6. |
| AUD-020 | P1 | BLOCKED | SRE / L | Alertas com thresholds, donos e roteamento publicados e exercitados, mesmo que com destino local na ausência de ferramenta externa; tabela de alertas de `OBSERVABILITY.md` sem pendência de dono. Achado §3.6. |
| AUD-021 | P2 | DONE | Engenharia / M | Métricas de negócio listadas como propostas passam a ser emitidas e cobertas por teste de renderização. Achado §3.6. |
| AUD-022 | P0 | DONE | Produto / S | Reconciliação numérica de todos os documentos: 51/57/60, 614/619/725 e branches 85,82/85,79 com comando, ambiente, data e limitação; `TEST_PLAN.md`, `PRODUCTION_READINESS.md`, `RELEASE_CHECKLIST.md` e `PROJECT_STATUS_REPORT.md` sem contradição interna. Achado §3.4. |
| AUD-023 | P2 | DONE | QA / M | Ampliação da sentinela de mutação ou adoção de ferramenta de mutação com score publicado no CI; resultado por camada anexado ao packet. Achado §3.2. |
| AUD-024 | P2 | DONE | QA / M | Baseline visual no CI com comparação de screenshot nos três viewports; regressão visual reprovando o pipeline. Achado §3.2. |

## 5. G3 — interface consistente

| ID | Pri | Status | Dono / tamanho | Entrega verificável e aceite mínimo |
| --- | --- | --- | --- | --- |
| AUD-025 | P1 | DONE | UX + engenharia / M | `DESIGN_SYSTEM.md` reconciliado com tokens e inventário reais (raios, componentes existentes, alvos); cada componente nomeado existe ou é removido do documento. Achado §3.5. |
| AUD-026 | P1 | DONE | Engenharia / S | Alvos de interação ≥ 44 px na navegação e ações, fechando F-15; teste E2E de alvo estendido para fora da navegação. Achado §3.5. |
| AUD-027 | P1 | DONE | Engenharia / M | Kit de estados de feedback adotado por todos os consumidores, com `aria-live` uniforme; focus trap único com restauração de foco, removida a reimplementação do drawer. Achado §3.5. |
| AUD-028 | P1 | DONE | QA / S | Varredura axe ampliada em regras e fora do recorte `main` (sidebar, topbar, navegação móvel); resultado por página anexado. Achado §3.5. |
| AUD-029 | P0 | BLOCKED | UX / M | Inspeção manual de acessibilidade executada: leitor de tela, zoom e touch nos fluxos principais, com registro; fecha FE-0005 e FE-7002. Achado §3.5. Aguarda execução e registro humano. |
| AUD-030 | P2 | DONE | Engenharia / M | DTOs do frontend derivados de `@cvg/contracts` no lugar das declarações locais duplicadas (`SessionUser` 4×, `Notification` 3× e demais); teste de contrato no front. Achado §3.1. |

## 6. G4 — caminho de operação

| ID | Pri | Status | Dono / tamanho | Entrega verificável e aceite mínimo |
| --- | --- | --- | --- | --- |
| AUD-031 | P0 | DONE | Engenharia / L | Dockerfile multi-stage da aplicação e job de build de imagem no pipeline; imagem auditada e boot verificado contra `livez`/`readyz`. Achado §3.6. |
| AUD-032 | P1 | DONE | Engenharia / S | Dependabot ou equivalente, revisão de dependências em PR e análise estática (SAST) no pipeline; dependência desatualizada abre PR automaticamente. Achado §3.2. |
| AUD-033 | P0 | BLOCKED | Patrocinador + SRE / L | RPO/RTO aprovado ou substituído por decisão formal, com WAL archiving e exercício de restore completo em banco restaurado com checksum; decisão com autoridade e data. Achado §3.6. |
| AUD-034 | P1 | BLOCKED | SRE + segurança / L | Separação de ambientes e secret management decididos e implementados; `.env.example` sem promessa de ferramenta ausente e `RATE_LIMIT_MODE` coerente com produção. Achado §3.6. |
| AUD-035 | P2 | DONE | Engenharia / S | Pipeline com cache do navegador do Playwright, execução única da suíte de acessibilidade e matriz de versões de Node; tempo de ciclo reduzido sem perda de cobertura. Achado §3.2. |
| AUD-036 | P2 | BLOCKED | Produto / M | Histórico de commits com granularidade compatível com bisect e política de commit do time registrada; decisão sobre o histórico existente de 12 commits. Achado §3.7. |

## 7. G5 — re-auditoria

| ID | Pri | Status | Dono / tamanho | Entrega verificável e aceite mínimo |
| --- | --- | --- | --- | --- |
| AUD-037 | P0 | BLOCKED | QA / M | Re-execução integral dos gates (typecheck, lint, cobertura, browser, integração PostgreSQL, segurança, documentação, rastreabilidade) com packet novo e hash; depende dos itens P0 anteriores. |
| AUD-038 | P0 | BLOCKED | Patrocinador / M | Revisão independente com contexto novo e veredito registrado em packet com hash; nenhum parecer anterior reaproveitado; nota mínima 85 e zero achado crítico/alto aberto. |
| AUD-039 | P1 | DONE | Produto / S | Índice `docs/README.md` alcança `v2/*`, `GLOSSARY.md` e `DECISION_LOG.md`; glossário e decision log ampliados para o tamanho do acervo; zero documentos inalcançáveis. Achado §3.4. |
| AUD-040 | P1 | READY | Engenharia / M | Dívida de arquitetura endereçada: roteamento do dispatcher derivado do manifesto (elimina as ~49 condições e os schemas duplicados), divisão de `service-common.ts` abaixo do teto e configuração de ambiente tipada; testes de fronteira de arquitetura continuam verdes. Achado §3.1. **Reaberto em 02/10/2026:** o matching usa o manifesto, mas o handling ainda tem 71 comparações `operationId ===` (`route.ts` com 777/800 linhas). Continua como [PROD-108](PRODUCTION_BACKLOG.md). |

## 7.1 G6 — caminho de deploy verificado (achados de 01/10/2026, revisão de prontidão)

Achados novos encontrados ao exercitar o stack em modo produção; nenhum deles era coberto por teste antes desta revisão.

| ID | Pri | Status | Dono / tamanho | Entrega verificável e aceite mínimo |
| --- | --- | --- | --- | --- |
| AUD-041 | P0 | DONE | Engenharia / S | **CSP nunca aplicada:** `proxy.ts` estava na raiz, mas o app vive em `src/app`, e o Next 16 ignora o proxy nesse caso. Movido para `src/proxy.ts`, CSP propagada também no header da requisição (fonte do nonce para o renderer) e layout com `connection()` para renderização por requisição. Prova: `src/proxy.test.ts`; build lista `ƒ Proxy (Middleware)`; CI afirma que todo `<script>` da resposta carrega o nonce. |
| AUD-042 | P0 | DONE | Engenharia / S | **Sem caminho para o primeiro usuário em produção:** o único criador da linha de estado era o seed sintético, proibido em produção. Novo `npm run db:bootstrap` cria um único ADMIN em transação, com evento `ProductionBootstrap`, e recusa banco já inicializado. Prova: `production-bootstrap.test.ts` e `tests/postgres/production-bootstrap.integration.test.ts`. |
| AUD-043 | P0 | DONE | Engenharia / M | **Migrations e worker fora da imagem:** a imagem runner não continha `tsx` nem os scripts. Novo target `ops` no `Dockerfile`, `docker-compose.prod.yml` (proxy TLS, app, worker, migrate, bootstrap) e runbook [DEPLOYMENT.md](../operations/DEPLOYMENT.md). Prova: stack subiu em modo produção, login via TLS, `readyz` 200 com `postgres`/`s3`, outbox processando. |
| AUD-044 | P1 | DONE | Engenharia / S | `/readyz` passa a falhar em produção sem `SESSION_SECRET` ou sem proxy confiável com segredo de 32+ caracteres (antes, o primeiro sintoma era um 500 ao criar usuário). Prova: `runtime-security.test.ts`. |
| AUD-045 | P1 | DONE | Engenharia / S | `.env.production` não era ignorado pelo git; `.gitignore` agora ignora `.env.*` exceto os exemplos. |
| AUD-046 | P1 | READY | Produto + segurança / M | Troca de senha self-service e redefinição pelo ADMIN não existem; hoje a única saída é desativar e recriar a conta. Decidir fluxo (com step-up e auditoria) antes do piloto. Continua como PROD-200…203 no [backlog PROD-2026-10](PRODUCTION_BACKLOG.md). |

## 8. Resumo por status

| Status | Quantidade | Itens |
| --- | ---: | --- |
| `DONE` | 36 | AUD-001…005, 007…019, 021…028, 030…032, 035, 039, 041…045 |
| `READY` | 2 | AUD-040 (reaberto), AUD-046 |
| `BLOCKED` | 8 | AUD-006, 020, 029, 033, 034, 036, 037, 038 |

`DONE` nesta tabela significa implementação local e evidência automatizada reproduzível; não significa aceite clínico, hospitalar ou produtivo. `AUD-004` foi exercitado localmente após a matriz E2E e a rotina também está conectada ao CI/pós-E2E. `AUD-029` exige inspeção manual. Os demais itens `BLOCKED` dependem de autoridade, ambiente ou revisão independente.

## 9. Evidência da execução local — 02/10/2026

- `npm test` — 768/768 testes em 91 arquivos — PASS.
- `npm run test:coverage:unit` — 92,79% lines, 94,23% functions e 86,12% branches; leitura unit-only.
- `npm run test:coverage` — 809/809 testes em 98 arquivos, 94,98% lines, 95,30% functions e 89,09% branches — PASS; `coverage:gate` PASS com 29 exceções temporárias, sem arquivos uncovered/stale.
- `npm run test:postgres` — 41/41 testes de integração em 7 arquivos — PASS.
- `node --test scripts/coverage-report.test.mjs` — 5/5, incluindo falha negativa para arquivo abaixo do limiar sem exceção.
- `npm run test:e2e -- --retries=0 --fail-on-flaky-tests` — 63/63 sem retry — PASS.
- `npm run test:mutation` — 7/7 controles detectados; relatório é publicado como artefato no CI.
- `npm run typecheck`, `npm run lint`, `npm run security:scan`, `npm run validate:docs`, `npm run validate:openapi` (70 operações/65 paths), `npm run validate:traceability` (43/43) e `npm run validate:migrations` (001–011) — PASS.
- `npm run build` — PASS; 12 rotas geradas e `ƒ Proxy (Middleware)` presente.
- `npm audit --audit-level=high` — sem advisories `critical`/`high`; permanecem 3 advisories `moderate` do Vitest, com correção disponível apenas via upgrade breaking.
- `npm run validate:aaa3` — reprova de forma fail-closed porque o candidato atual diverge do fingerprint/contagens congelados do packet AAA-3 histórico; não se atualizou o manifesto histórico.
