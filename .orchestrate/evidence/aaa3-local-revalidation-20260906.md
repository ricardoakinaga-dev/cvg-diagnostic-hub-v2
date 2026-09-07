# AAA-3 — revalidação local e inspeção visual — 2026-09-06

> Este packet registra a revalidação AAA-3 anterior à asserção `EXPLAIN` e à
> atualização da contagem PostgreSQL. A evidência PostgreSQL corrente está no
> packet V2 [`v2-relational-sample-lineage-postgres-20260906.md`](v2-relational-sample-lineage-postgres-20260906.md),
> com 21/21 testes.

## Resultado

**PASS local condicional; NÃO PRONTO para release.** A execução reproduzível
confirmou os contratos locais e a UI servida. Os gates que exigem infraestrutura
durável, produção, decisão clínica ou aceite humano continuam bloqueados.

## Verificações executadas

| Verificação | Resultado |
| --- | --- |
| `npm run validate` | PASS — typecheck, lint, 66 arquivos/555 testes, cobertura de 92,91% statements/lines, 85,14% branches e 95,29% functions; docs 56/56; OpenAPI 65 operações/60 paths; traceability 43/43; migrações 001–009 |
| `npm run build` | PASS — Next.js 16.3.0, build de produção compilado e 12 páginas estáticas geradas |
| `CI=1 npm run test:e2e -- --retries=0 --fail-on-flaky-tests` | PASS — 51/51 em Chromium, tablet e mobile, sem retry; os 6 cenários de acessibilidade passaram nos três projetos |
| Inspeção visual dos renders | PASS local — screenshots do Patient Workspace em 1440×1000, 834×1194 e 375×812 inspecionados; composição, hierarquia, estados e responsividade coerentes, sem overflow horizontal reportado |
| PostgreSQL real | PASS condicional — 20/20 no cluster descartável pós-control-plane; detalhes em [`control-plane-v2-postgres-revalidation-20260906.md`](control-plane-v2-postgres-revalidation-20260906.md) |
| Crítica independente fresca | BLOCKED — Newton não aprovou; confirmou que os critérios externos permanecem sem evidência suficiente |

## Integridade e limites

- A execução browser usa ambiente sintético em memória, conforme
  `playwright.config.ts`; não prova jornada contra PostgreSQL durável.
- A prova PostgreSQL usa cluster descartável e não demonstra backfill populado,
  dual-read/cutover, rollback de autoridade, `EXPLAIN` representativo ou
  fanout multi-instância.
- Permanecem sem demonstração: object storage/antivírus/chaves reais, alertas
  exercitados, carga representativa, CI remoto, restore com RPO/RTO aprovado,
  políticas clínicas assinadas, ownership/identidade hospitalar, aceite manual,
  treino, piloto e autorização formal de release.
- Os renders foram usados para inspeção visual local e permanecem em
  `/tmp/cvg-patient-workspace-chromium.png`,
  `/tmp/cvg-patient-workspace-tablet.png` e
  `/tmp/cvg-patient-workspace-mobile.png`; não são tratados como evidência de
  produção.

## Veredito da rodada

O resultado correto para a barra congelada AAA-3 é **CONDITIONAL_PASS / NOT_READY**:
há uma base local forte, mas não existe autorização honesta para declarar o
programa completo ou pronto para uso hospitalar.
