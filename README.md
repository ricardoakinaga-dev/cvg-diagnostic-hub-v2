# CVG Diagnostics Hub

Central operacional para solicitar, executar, acompanhar, liberar e revisar exames diagnósticos em um hospital veterinário.

> **Status (23/08/2026):** MVP executável em ambiente local, com dados sintéticos, memória ou PostgreSQL 16. Ainda não é uma release aprovada para uso hospitalar.

## Objetivo

Responder rapidamente:

> O que foi solicitado para este paciente, em que etapa está, onde está o resultado e quem precisa tomar conhecimento dele?

O produto é deliberadamente um hub especializado em diagnóstico e comunicação entre setores, não um ERP veterinário completo.

## Método de trabalho

O projeto segue a ordem:

```text
DISCOVERY → PRD → SPEC → BUILD PLAN → IMPLEMENTATION
```

A implementação segue slices verticais: contrato → persistência → API → autorização → auditoria → UI → testes. O estado atual, a barra de qualidade, as rodadas e os gaps estão em `.gauntlet/`.

## Leitura recomendada

1. [`docs/README.md`](docs/README.md) — mapa e convenções da documentação.
2. [`docs/discovery/DISCOVERY.md`](docs/discovery/DISCOVERY.md) — problema, limites de evidência e contexto.
3. [`docs/prd/PRD.md`](docs/prd/PRD.md) — produto, MVP e acceptance criteria.
4. [`docs/spec/SYSTEM_SPEC.md`](docs/spec/SYSTEM_SPEC.md) — contrato técnico consolidado.
5. [`docs/build/BUILD_PLAN.md`](docs/build/BUILD_PLAN.md) — ordem, status e limites da implementação.
6. [`docs/TRACEABILITY_MATRIX.md`](docs/TRACEABILITY_MATRIX.md) — prova de ligação entre problema e execução.

## Executar localmente

Requer Node.js 20.9+ e npm. Docker é conveniente, mas o harness também aceita um PostgreSQL 16 descartável local:

```bash
npm ci
cp .env.example .env
export DATABASE_URL=postgresql://cvg:cvg_dev@localhost:54329/cvg_diagnostics
export DEMO_PASSWORD="$(openssl rand -base64 32)"
export ALLOW_SYNTHETIC_SEED=true
npm run db:migrate
npm run db:seed
npm run dev
```

Abra `http://localhost:3000`. Neste ambiente, outro dispositivo na mesma rede pode acessar `http://192.168.15.14:3000`; o host LAN está liberado apenas para a demonstração local. O ambiente de demonstração usa `APP_DATA_MODE=memory` e a senha sintética definida por `DEMO_PASSWORD`; para testar persistência, use `APP_DATA_MODE=postgres` junto com `DATABASE_URL` após a migração.

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

Para evidência operacional adicional: `PERF_PASSWORD="$DEMO_PASSWORD" npm run perf:smoke` exige um servidor já iniciado; `ALLOW_DB_RESTORE_SMOKE=true npm run db:restore:smoke` restaura apenas em um banco Docker descartável. O seed sintético é proibido com `NODE_ENV=production` e só executa com `ALLOW_SYNTHETIC_SEED=true`. O `db:smoke` também é destrutivo: exige `ALLOW_DB_SMOKE_RESET=true`, host de loopback e um banco dedicado cujo nome comece por `cvg_smoke` ou `cvg_test`. A integração descartável roda com `ALLOW_POSTGRES_INTEGRATION_TESTS=true`, `POSTGRES_TEST_ADMIN_URL` local e `npm run test:postgres`.

O E2E usa o Chrome disponível no host quando o navegador Playwright empacotado não possui dependências gráficas; gravação de vídeo fica desligada por padrão para não depender de `ffmpeg`. Os dados e arquivos locais ficam em `.data/` e não devem receber informação clínica real.

## Validação documental

```bash
bash scripts/validate-docs.sh
```

O script verifica a árvore obrigatória, headings mínimos, IDs de requisitos, referências aos principais documentos e ausência de placeholders proibidos. Ele complementa, mas não substitui, os gates de runtime.

## Escopo atual

O MVP proposto cobre o fluxo ponta a ponta para Laboratório, Radiologia/RX e Ultrassonografia, com busca, prioridade, filas setoriais, recoleta, resultados versionados, anexos controlados, timeline derivada de eventos, notificações internas, realtime, RBAC e auditoria.

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

O runtime atual cobre as slices principais de solicitação, Lab, RX/US, resultados versionados com ações de UI, anexos privados locais/S3-compatible, scanner externo fail-closed, notificações, filas, busca, timeline, dashboard, RBAC, CSRF, auditoria, outbox com retry/lease/ownership, rate limit PostgreSQL, SSE, métricas e PostgreSQL snapshot transitório. A barra local e o status dos gates estão em [`docs/build/PREMIUM_MVP_V4.md`](docs/build/PREMIUM_MVP_V4.md), [`docs/operations/PRODUCTION_READINESS.md`](docs/operations/PRODUCTION_READINESS.md) e [`docs/TRACEABILITY_MATRIX.md`](docs/TRACEABILITY_MATRIX.md).

Antes de qualquer piloto, ainda precisam de decisão/evidência: identidade e ownership no hospital, transferência/alta, política de resultado crítico, fallback de notificação, retenção, RPO/RTO aprovado, varredura AV externa, object storage produtivo/credenciais, workload representativo, inspeção manual de acessibilidade e sign-off. Esses gates estão em [`docs/discovery/OPEN_QUESTIONS.md`](docs/discovery/OPEN_QUESTIONS.md), [`docs/operations/PRODUCTION_READINESS.md`](docs/operations/PRODUCTION_READINESS.md) e no backlog 95/100.
