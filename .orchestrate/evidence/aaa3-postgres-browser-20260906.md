# AAA-3 — browser contra PostgreSQL descartável — 2026-09-06

## Resultado

**PASS local condicional** — 17/17 cenários Playwright passaram contra um
runtime Next.js servido com `APP_DATA_MODE=postgres`, em um banco sintético
descartável. Nenhum retry foi aceito.

## Ambiente

- PostgreSQL portátil 16.15 em cluster novo, loopback-only, TCP `127.0.0.1:55448`.
- Banco de teste com nome `cvg_test_e2e_*`, migrations 001–009 aplicadas e seed
  sintético explícito.
- Next.js 16.3.0 em `127.0.0.1:3110`, `readyz` retornando
  `dataMode=postgres` e `storageMode=local`.
- `E2E_REUSE_EXISTING_SERVER=true`, `BASE_URL=http://127.0.0.1:3110`,
  `--retries=0` e `--fail-on-flaky-tests`.
- O cluster e o servidor foram encerrados ao final; a instância preexistente
  em `127.0.0.1:5432` não foi usada nem alterada.

## Cobertura observada

| Arquivo | Resultado |
| --- | --- |
| `tests/e2e/accessibility.spec.ts` | 2/2 — axe/keyboard em Chromium contra runtime PostgreSQL |
| `tests/e2e/clinical-lifecycle.spec.ts` | 3/3 — hemograma, RX, anexos, revisão, emenda, void e crítico |
| `tests/e2e/core-flows.spec.ts` | 12/12 — dashboard, contexto, administração, requests, Patient Workspace, escopo e degraded refresh |
| Total consolidado | **17/17**, 1 worker, 0 retries |

## Correção que tornou a prova possível

A primeira tentativa revelou que o Next.js 16 bloqueava os chunks de
desenvolvimento para `127.0.0.1`, deixando a página sem hidratação e o login
sem POST. A configuração foi corrigida com os hosts loopback explícitos em
`next.config.mjs`; o harness ganhou a flag explícita de reuso em
`playwright.config.ts`. A corrida seguinte passou integralmente.

## Limites

Esta prova demonstra uma jornada browser contra persistência PostgreSQL
durável local. Não demonstra ainda duas instâncias simultâneas, fanout SSE,
revogação cross-instance durante browser, object storage/AV produtivo,
workload representativo, restore com RPO/RTO aprovado, CI remoto, políticas
clínicas assinadas, avaliação manual ou aceite hospitalar.
