# AAA-3 — G4 amplo e revalidação do working tree — 2026-09-06

## Veredito

`PASS` técnico local, limitado ao ambiente sintético e ao working tree atual. `AAA-READY` não demonstrado; produção, homologação clínica e release permanecem `NOT READY`.

## Identificação e autoridade

- Gate/tarefa: AAA2-010 / AAA2-050 / G4 de cobertura e revalidação integrada.
- Data de captura: 2026-09-06; artefato candidato: working tree local deliberadamente sujo.
- `HEAD`: `01bb1804682b4bb503e00e41c1361dc704d2294d`.
- Produtor: Codex, execução automatizada no working tree compartilhado.
- Revisor independente da matriz visual: `Bernoulli` (`APPROVED_LOCAL`, packet v6); este packet não é sign-off humano, clínico ou de release.
- Ambiente: Node `v24.20.0` local; o `.nvmrc`, `package.json` e CI fixam Node 22. O banco PostgreSQL persistente em `127.0.0.1:5432` não foi tocado.
- Dados: fixtures e workload sintético; não contém dados clínicos reais.

## G4 executável — passe oficial

## Revalidação final do working tree — 2026-09-06T21:14:42Z

- `npm run test:e2e -- --fail-on-flaky-tests --retries=0`: **51/51** em
  3,9 minutos, sem retry; cenário responsivo 3/3 e acessibilidade 6/6.
- A matriz visual v6 sincronizou 20 PNGs (seis estados × três viewports e duas
  capturas da timeline densa mobile) e o crítico fresco Bernoulli retornou
  **APPROVED_LOCAL**, sem defeito visual local material, clipping ou obstrução
  de alertas. O loading mobile foi capturado após o indicador realtime conectar.
- `npm run validate` serial terminou com exit code `0` após a matriz completa.
- `next.config.mjs` desativa o indicador de desenvolvimento; o skeleton teve
  contraste reforçado e os avisos realtime/stale mobile passaram a fluir/empilhar
  sem obstrução.

`npm run test:coverage` terminou com exit code `0` usando a política serial oficial do `vitest.config.ts` (`fileParallelism: false`, um worker, hooks/setup em lista):

| Medição | Total | Coberto | Percentual |
| --- | ---: | ---: | ---: |
| Statements/lines | 13.226 | 12.170 | 92,01% |
| Branches | 5.917 | 5.030 | 85,00% |
| Functions | 959 | 905 | 94,36% |

Resultado da suíte: **614 testes em 75 arquivos, 614/614 aprovados**. A configuração oficial inclui `src/**/*.ts`, `src/**/*.tsx`, `packages/**/*.ts` e `packages/**/*.tsx`. As exclusões são declarações de tipo, infraestrutura de testes, arquivos de teste e somente estes três seams sem lógica executável: `src/server/application/service-context.ts`, `src/server/application/service-types.ts` e `src/server/storage/file-store-contract.ts`, além de `src/server/store/relational/clinical-core-contracts.ts`. A execução corrente mediu 5.917/5.030 branches (85,00%). O packet não usa o passe para declarar completude.

## Gates reexecutados

Todos terminaram com exit code `0` no mesmo estado, salvo onde o resultado é explicitamente um artefato anterior referenciado:

- `npm run typecheck` e `npm run lint`.
- `npm run validate:docs`: 73 arquivos obrigatórios.
- `npm run validate:openapi`: 65 operações em 60 paths.
- `npm run validate:traceability`: 43 requisitos e 43 acceptance criteria.
- `npm run validate:migrations`: migrations 001–010 e checksums.
- `npm run security:scan` e `npm audit --audit-level=high`: zero vulnerabilidades HIGH abertas.
- `npm run test:perf`: 7/7; `npm run test:recovery`: 5/5.
- `npm run build`: 12 rotas/páginas geradas.
- `CI=1 npm run test:e2e -- --fail-on-flaky-tests --retries=0`: **51/51**, sem retry, nos projetos Chromium/tablet/mobile; os seis cenários de acessibilidade incluídos passaram 6/6.
- `CI=1 npm run test:accessibility -- --fail-on-flaky-tests --retries=0`: **6/6**, sem retry, nos projetos Chromium/tablet/mobile.
- PostgreSQL descartável 30/30 e browser production-like 51/51 permanecem nos packets específicos; não são recontados como parte do passe de cobertura.
- A nova integração `tests/postgres/relational-sample-lineage.integration.test.ts` foi adicionada
  para a cadeia real de recoleta/rollback, mas não foi executada nesta máquina:
  não havia PostgreSQL descartável disponível e o processo persistente em
  `127.0.0.1:5432` foi deliberadamente preservado. Portanto, os 30/30 históricos
  dos packets PostgreSQL não cobrem essa nova integração.

## Escopo e lacunas

O passe fecha a lacuna de instrumentação do G4 para código executável de aplicação, domínio, runtime, persistência e UI. Ele não prova que os cenários obrigatórios foram semanticamente completos. As lacunas de cobertura por camada permanecem visíveis: `src/server/store/postgres-store.ts`, o adapter/cutover relacional e partes de UI como `result-view.tsx` têm ramos de infraestrutura e integração menos exercitados que o agregado global. A aprovação do limiar não autoriza apagar essas lacunas.

Os bloqueios materiais permanecem: JSONB continua autoridade runtime; AAA-08/AAA-09 não têm cutover, dual-read contínuo ou rollback; a matriz visual local de estados/viewport foi aprovada por crítica independente fresca, mas revisão manual, comparação com golden/produto e sign-off humano continuam ausentes; CI remoto, IdP/TLS/proxy alvo, storage/AV real, workload/soak/failover/restart, restore completo e RPO/RTO, políticas D-01–D-06, revisão manual clínica/acessibilidade, aceite hospitalar, piloto e autoridade de release não foram demonstrados.

## Integridade e artefatos

- `coverage/coverage-summary.json`: hash `82feefaeb7d0e933b2787b697d8080d1a1d0f877f721f189f6037c20e2fb06b6` (latest serial artifact: 13.226/12.170 lines, 5.917/5.030 branches, 959/905 functions).
- Latest harness fix: `src/components/app-shell.test.tsx` uses a stable router mock to prevent repeated session effects; targeted shell tests pass 5/5 and the final broad suite passes 614/614.
- Latest visual fix: `src/app/globals.css` keeps the active compact mobile label inside its rail cell, groups recovery actions, strengthens the loading skeleton and stacks the mobile stale/realtime notices; `next.config.mjs` removes the framework development indicator from captures. The responsive scenario captures ready/loading/error-denied/empty/partial/stale at 1440/834/375 plus dense mobile collapsed/expanded evidence; the Bernoulli v6 review is `APPROVED_LOCAL`, while manual/golden/target acceptance remains open.
- Latest browser assertion source: `tests/e2e/core-flows.spec.ts` hash `b0dcc90ce83a2328e426790e931c3320e5cf7a96a99c63367251a9045e3fa921`; the final full 51/51 no-retry matrix passed after the authenticated baseline fixture and loading-state stabilization.
- State matrix manifest: `.orchestrate/evidence/visual-patient-workspace-20260906-v6/manifest.json` hash `77fcf00479c41aeac40e3dc5a470c94048a99a285f042b02abbee49c2f6263a5`; the Bernoulli report is `.orchestrate/evidence/visual-patient-workspace-20260906-v6/critic-report.md` and returns `APPROVED_LOCAL` for the 20-artifact local matrix.
- Current visual/config source hashes: `src/app/globals.css` `bb042a4dfab51aff5e8ffaeb9996e63005e66d92e28c8cab7a5123f30d95798e`; `next.config.mjs` `75b2a83344fb7ce4d425f8cb6fab116231ff17bd2dc09a605b05c66ba03eb63d`; `tests/e2e/core-flows.spec.ts` `b0dcc90ce83a2328e426790e931c3320e5cf7a96a99c63367251a9045e3fa921`.
- `package-lock.json`: hash `86e9bf8faee388336430b06f567c524d3bd90e73f8d27a17f3ca2f30c6e62ca4`.
- `git diff --check`: exit code `0`.
- O fingerprint abaixo pertence à revalidação anterior e é mantido como histórico;
  o packet v6 e os hashes correntes acima são a referência desta rodada.

- Status digest (`git status --short`, excluindo este packet): `850b577eea03874d92f1ba1c8a0de43d1e61cb70bcbe431aa267177e0db23563`.
- Diff digest (`git diff --binary`, excluindo este packet): `10b26cf7e2fd6f0ccda491a1a6431e6328337ca8bd9587848c616d61d41b458f`.
- `vitest.config.ts`: `ccb9e41f93e4c4f6e94823d6e2f03659ef70fbc5eab380398fe1090ad54cf5f9`.
- `src/components/app-shell.test.tsx`: `87e5fb4c4c23227ab1d873f84d936e58d9b8e00b2ecf594e06df5645b1ff3685`.
- `src/app/globals.css`: `695e07d4b6b4d081905c334076c920a5d7b2ef781f41b8e3a371b5ce15556e25`.
- `package.json`: `f2737a1a114e6f3314718fffb42aab480e8dc5512105876bb6a7fd61aa2cbf9e`.
- `README.md`: `f3049c54803a8abd97b2c20536ce7a960aef120660dbd05ea01a126383e5951b`.
- `docs/README.md`: `3be68fc46379055a93f3b54be8c50421bcb0545ec6e22807ea2399bb9b72f642`.
- `docs/PROJECT_STATUS_REPORT.md`: `04e2517a3a8f70077ff2c1d098364cab00c016812205b5ba8ed6fe980a9fefbe`.
- `docs/TRACEABILITY_MATRIX.md`: `4ca13a7877aec7ba4e72865a27822e7155f15600f93d5a90bbbb90d0530d8534`.
- `docs/testing/TEST_PLAN.md`: `e18854058a6392c5ea464b08aed5c26f78d49b14ecc6de0c77b84ed6c871faa0`.
- `docs/operations/PRODUCTION_READINESS.md`: `55935df1bf0530701fcc8337e639c5d9f18e4a9ecf23670bad3f0da316aebe9f`.
- `docs/operations/RELEASE_CHECKLIST.md`: `4f0b9e9b1b920a4ef866bdf390d339db1d73108d168e405d74fd0b7b39a2bfd7`.
- `coverage/coverage-summary.json`: `5ca4cc3a4e4193576aa267c25fbb010e4dd0d71595a4f646a24b563c947b4b94`.
- `package-lock.json`: `86e9bf8faee388336430b06f567c524d3bd90e73f8d27a17f3ca2f30c6e62ca4`.

## Decisão

Aceitar este artefato como **candidato técnico local verificado para o limiar G4**, sem promover qualquer critério AAA-01–AAA-22 a `AAA-READY`. A revisão visual local v6 está aprovada por Bernoulli, mas a próxima promoção ainda exige reexecução em Node 22/CI e ambiente alvo, prova de autoridade relacional e recovery, e as decisões/aceites humanos explicitamente pendentes.
