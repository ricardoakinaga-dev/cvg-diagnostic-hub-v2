# CVG Diagnostics Hub

Central operacional para solicitar, executar, acompanhar, liberar e revisar exames diagnósticos em um hospital veterinário.

> **Status (07/09/2026):** candidato local tecnicamente forte, ainda **CONDITIONAL PASS / NOT READY** para produção clínica. A execução corrente passou 725/725 testes em 86 arquivos, cobertura de 92,72% statements/lines, 85,82% branches e 94,31% functions; build Next.js 16.3.0, OpenAPI 65/60, rastreabilidade 43/43, migrations 001–010, security scan, `npm audit`, SBOM CycloneDX com 560 componentes sob Node 22, recovery 5/5 e performance 7/7. O browser passou 60/60 na matriz completa, sem retry, em Chromium/tablet/mobile; isso inclui o fluxo principal, ciclo clínico, acessibilidade (12/12) e realtime. A evidência PostgreSQL descartável anterior passou 39/39 em 6 arquivos em Node 22/PostgreSQL 16.15, mas a repetição corrente ficou condicionada pela ausência de `initdb`/`pg_ctl`/Docker e não tocou `127.0.0.1:5432`; o lane local production-like passou 51/51 contra `next start`, PostgreSQL, S3/scanner sintéticos e outbox durável; o restore smoke PostgreSQL-only passou com checksum e banco restaurado isolado. JSONB continua autoridade clínica. O relatório corrente, a barra e o manifesto estão em [`RELATORIO_AUDITORIA_2026-09-07.md`](docs/RELATORIO_AUDITORIA_2026-09-07.md), [`quality-bar.json`](.orchestrate/aaa3-execution-20260907/quality-bar.json) e [`evidence-manifest.json`](.orchestrate/aaa3-execution-20260907/evidence-manifest.json).

O repositório oficial do V2 é [`ricardoakinaga-dev/cvg-diagnostic-hub-v2`](https://github.com/ricardoakinaga-dev/cvg-diagnostic-hub-v2). A linha V1 permanece disponível durante a migração. O mapa atual, a barra congelada e as limitações da onda estão em [`docs/v2/MIGRATION_MAP.md`](docs/v2/MIGRATION_MAP.md) e [`docs/v2/QUALITY_BAR.md`](docs/v2/QUALITY_BAR.md).

## Objetivo

Responder rapidamente:

> O que foi solicitado para este paciente, em que etapa está, onde está o resultado e quem precisa tomar conhecimento dele?

O produto é deliberadamente um hub especializado em diagnóstico e comunicação entre setores, não um ERP veterinário completo.

## Método de trabalho

O projeto segue a ordem:

```text
DISCOVERY → PRD → SPEC → BUILD PLAN → IMPLEMENTATION
```

A implementação segue slices verticais: contrato → persistência → API → autorização → auditoria → UI → testes. O estado atual deste ciclo, a barra de qualidade, as rodadas e os gaps estão em [`.orchestrate/aaa3-execution-20260907/`](.orchestrate/aaa3-execution-20260907/); `.gauntlet/` contém apenas pacotes históricos preservados.

## Leitura recomendada

1. [`docs/v2/QUALITY_BAR.md`](docs/v2/QUALITY_BAR.md) — barra binária das ondas V2 e limitações explícitas.
2. [`docs/v2/MIGRATION_MAP.md`](docs/v2/MIGRATION_MAP.md) — separação entre V1, transição e arquitetura-alvo.
3. [`docs/v2/LABORATORY_VERTICAL.md`](docs/v2/LABORATORY_VERTICAL.md) — contrato, fluxo e gates da fatia estruturada de Laboratório.
4. [`docs/README.md`](docs/README.md) — mapa e convenções da documentação.
5. [`docs/discovery/DISCOVERY.md`](docs/discovery/DISCOVERY.md) — problema, limites de evidência e contexto.
6. [`docs/prd/PRD.md`](docs/prd/PRD.md) — produto, MVP e acceptance criteria.
7. [`docs/spec/SYSTEM_SPEC.md`](docs/spec/SYSTEM_SPEC.md) — contrato técnico consolidado.
8. [`docs/TRACEABILITY_MATRIX.md`](docs/TRACEABILITY_MATRIX.md) — prova de ligação entre problema e execução.

## Executar localmente

Requer Node.js 22.x e npm (o `.nvmrc` e o CI fixam essa linha). Docker é conveniente, mas o harness também aceita um PostgreSQL 16 descartável local:

```bash
npm ci
cp .env.example .env
export DATABASE_URL=postgresql://cvg:cvg_dev@localhost:54329/cvg_diagnostics
export APP_DATA_MODE=postgres
export REALTIME_NOTIFICATION_ADAPTER=postgres-listen
export REALTIME_NOTIFICATION_CHANNEL=cvg_realtime_wakeup
export DEMO_PASSWORD="$(openssl rand -base64 32)"
export ALLOW_SYNTHETIC_SEED=true
npm run db:migrate
npm run db:seed
npm run dev
```

Abra `http://localhost:3000`. Neste ambiente, outro dispositivo na mesma rede pode acessar `http://192.168.15.14:3000`; o host LAN está liberado apenas para a demonstração local. O comando acima inicia em `APP_DATA_MODE=postgres`. Para uma demonstração somente em memória, use `APP_DATA_MODE=memory`, omita `DATABASE_URL` e mantenha a senha sintética definida por `DEMO_PASSWORD`.

Corpos JSON são aceitos somente como `application/json`, com limites anteriores ao
parse configurados por `JSON_BODY_MAX_BYTES` e `JSON_BODY_MAX_DEPTH`. Os defaults do
arquivo de exemplo são 1 MiB e 32 níveis; aumentos devem passar por revisão de risco.

## Gates de qualidade

```bash
npm run validate
npm run typecheck
npm run lint
npm test -- --run
npm run test:coverage
npm run build
npm run test:e2e
npm run test:accessibility
npm run validate:openapi
npm run security:scan
npm audit --audit-level=high
```

Deploy de produção (imagens Docker, bootstrap do primeiro ADMIN com `npm run db:bootstrap`, migrations, worker de outbox e proxy TLS): [`docs/operations/DEPLOYMENT.md`](docs/operations/DEPLOYMENT.md) e [`docker-compose.prod.yml`](docker-compose.prod.yml).

Para evidência operacional adicional: `PERF_PASSWORD="$DEMO_PASSWORD" npm run perf:smoke` exige um servidor já iniciado; `ALLOW_DB_RESTORE_SMOKE=true npm run db:restore:smoke` restaura apenas em um banco Docker descartável. O seed sintético é proibido com `NODE_ENV=production` e só executa com `ALLOW_SYNTHETIC_SEED=true`. O `db:smoke` também é destrutivo: exige `ALLOW_DB_SMOKE_RESET=true`, host de loopback e um banco dedicado cujo nome comece por `cvg_smoke` ou `cvg_test`. A integração descartável roda com `ALLOW_POSTGRES_INTEGRATION_TESTS=true`, `POSTGRES_TEST_ADMIN_URL` local e `npm run test:postgres`.

O backfill relacional disponível nesta etapa é explicitamente local e shadow-only: exige `ALLOW_RELATIONAL_BACKFILL=true`, `RELATIONAL_BACKFILL_TARGET=RELATIONAL_SHADOW`, uma migration aplicada até `010_relational_backfill_control` e `DATABASE_URL` já populado. Execute `npm run db:relational-backfill` somente em um banco descartável; o comando processa requests em lotes, grava checkpoint durável, mantém o lock da fonte até o checkpoint, valida chaves exatas, para se o snapshot mudar e reconcilia cada agregado sem alterar `cvg_runtime_state`. Ele não cria catálogo, ownership, políticas clínicas nem habilita cutover. A evidência final e a crítica independente estão no [packet de backfill](.orchestrate/evidence/v2-relational-sample-lineage-backfill-20260906.md).

O E2E usa o Chrome disponível no host quando o navegador Playwright empacotado não possui dependências gráficas; gravação de vídeo fica desligada por padrão para não depender de `ffmpeg`. Os dados e arquivos locais ficam em `.data/` e não devem receber informação clínica real.

## Validação documental

```bash
bash scripts/validate-docs.sh
```

O script verifica a árvore obrigatória, headings mínimos, IDs de requisitos, referências aos principais documentos e ausência de placeholders proibidos. Ele complementa, mas não substitui, os gates de runtime.

## Escopo atual

O MVP proposto cobre o fluxo ponta a ponta para Laboratório, Radiologia/RX e Ultrassonografia, com busca, prioridade, filas setoriais, recoleta, resultados versionados, anexos controlados, timeline derivada de eventos, notificações internas, realtime, RBAC e auditoria.

Na migração V2, as fatias verificadas ainda são deliberadamente menores que o programa clínico completo: domínio e contrato de contexto operacional; read model autorizado; Command Center com atenção e setores; Central de Exames com filtros, estados degradados e drawer acessível; fronteiras reais em `packages/domain`, `packages/ui`, `packages/services` e `packages/shared-state`; e um Hemograma sintético estruturado por analitos, com lifecycle, editor e contrato publicado. A política humana de faixas/criticidade, o cutover obrigatório de conteúdo legado, Patient Workspace completo, módulos físicos `apps/web`/`apps/api`, crítico com fallback e migração relacional continuam no backlog ou dependem de aprovação.

Ficam fora do MVP: faturamento, estoque, prontuário completo, agenda clínica geral, comunicação com tutor, PACS completo, visualizador DICOM avançado, automação direta de analisadores, aplicativo mobile nativo e BI empresarial.

## Princípios

- Poucos cliques e progressive disclosure.
- Status evidente por texto, ícone e posição; nunca somente por cor.
- Eventos importantes encontram o usuário.
- Uma fonte de verdade para timeline e auditoria.
- Seguro por padrão, com histórico imutável de ações clínicas.
- Modular monolith antes de microserviços.
- Simples, mas não frágil.

## Limites atuais e próximos gates

O runtime atual cobre as slices principais de solicitação, Lab, RX/US, resultados versionados com ações de UI, anexos privados locais/S3-compatible, scanner externo fail-closed, notificações, filas, busca, timeline, dashboard, RBAC, CSRF, auditoria, outbox com retry/lease/ownership, rate limit PostgreSQL, SSE, métricas, PostgreSQL snapshot transitório e projeção shadow relacional populada/resumível. A barra local e o status dos gates estão em [`docs/build/PREMIUM_MVP_V4.md`](docs/build/PREMIUM_MVP_V4.md), [`docs/operations/PRODUCTION_READINESS.md`](docs/operations/PRODUCTION_READINESS.md) e [`docs/TRACEABILITY_MATRIX.md`](docs/TRACEABILITY_MATRIX.md).

Antes de qualquer piloto, ainda precisam de decisão/evidência: identidade e ownership no hospital, transferência/alta, política de resultado crítico, fallback de notificação, retenção, RPO/RTO aprovado, varredura AV externa, object storage produtivo/credenciais, workload representativo, inspeção manual de acessibilidade e sign-off. Esses gates estão em [`docs/discovery/OPEN_QUESTIONS.md`](docs/discovery/OPEN_QUESTIONS.md), [`docs/operations/PRODUCTION_READINESS.md`](docs/operations/PRODUCTION_READINESS.md) e no [backlog AAA-3 atual](docs/build/STATE_OF_ART_TRIPLE_AAA_BACKLOG.md). O scorecard 95/100 é histórico e está preservado em [`docs/build/QUALITY_SCORECARD_95.md`](docs/build/QUALITY_SCORECARD_95.md).
