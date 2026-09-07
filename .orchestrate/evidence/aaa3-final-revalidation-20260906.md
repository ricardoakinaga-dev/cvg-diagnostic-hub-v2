# AAA-3 — pacote consolidado de revalidação local — 2026-09-06

## Resultado

**PASS local condicional; não é AAA-READY nem release hospitalar.** O artefato
corrente compila, passa os contratos e a suíte completa, executa jornadas de
browser em memória e contra PostgreSQL descartável, e tem evidência real da
seam relacional de sample lineage. A barra AAA-3 continua deliberadamente
fechada para os gates que exigem ambiente-alvo, autoridade clínica ou aceite
humano.

## Evidência corrente

| Gate | Resultado observado |
| --- | --- |
| `npm run validate` | **PASS** — 66 arquivos, 559/559 testes; cobertura 92,91% statements/lines, 85,26% branches e 95,31% functions; docs 56/56; OpenAPI 65 operações/60 paths; traceability 43/43; migrations 001–009 e checksums válidos |
| `npm run build` | **PASS** — Next.js 16.3.0, build de produção compilado e 12 páginas estáticas geradas |
| `CI=1 npm run test:e2e -- --retries=0 --fail-on-flaky-tests` | **PASS** — 51/51 em Chromium, tablet e mobile; 6/6 cenários de acessibilidade; nenhum retry aceito |
| Browser PostgreSQL | **PASS local** — 17/17 em Chromium contra Next.js com `APP_DATA_MODE=postgres`, PostgreSQL 16.15 descartável, migrations 001–009, `readyz dataMode=postgres`, sem retry |
| `npm run test:postgres -- --run --reporter=dot` | **PASS local** — 4 arquivos, 22/22 testes, PostgreSQL 16.15 descartável; migration, readiness, projection/read, membership, replay idempotente, rollback, reconciliation, wake-up LISTEN/NOTIFY entre dois pools e regressão durável |
| SQL/`EXPLAIN` | **PASS local** — 512 requests/items de distração; leitura clínica usou caminhos indexados; nenhum `Seq Scan` nas quatro relações clínicas alvo (`diagnostic_requests`, `diagnostic_request_items`, `samples`, `sample_item_links`) |
| Security/dependencies | **PASS** — `npm run security:scan`; `npm audit --audit-level=high` com 0 vulnerabilidades |
| Performance/recovery | **PASS local** — `npm run test:perf` 7/7 e `npm run test:recovery` 5/5 |
| Integridade de edição | **PASS** — `bash scripts/validate-docs.sh` e `git diff --check` |
| Inspeção visual | **PASS local condicional** — screenshots desktop/tablet/mobile do Patient Workspace inspecionadas; layout coerente e sem overflow horizontal; não substitui avaliação visual/acessível manual em ambiente-alvo |

## Mudanças desta fronteira

- O harness Playwright agora permite reusar explicitamente um servidor externo
  (`E2E_REUSE_EXISTING_SERVER=true`), mantendo o modo padrão isolado.
- `next.config.mjs` allowlista os hosts loopback necessários ao Next.js 16 para
  que chunks de desenvolvimento e hidratação funcionem no browser PostgreSQL.
- Diretórios gerados de `.next-*`, além de reports de teste, ficaram fora do
  working tree versionável.
- A suíte PostgreSQL ganhou uma asserção estrutural de `EXPLAIN` para evitar
  transformar uma escolha legítima do otimizador em uma promessa frágil de plano
  para a subconsulta de notificações.
- A política de realtime agora extrai a configuração para o domínio de servidor,
  rejeita `process-local` em prontidão PostgreSQL de produção e escolhe
  `postgres-listen` quando o adapter não é declarado nesse ambiente.
- A suíte PostgreSQL ganhou uma prova real com dois pools independentes para
  `LISTEN/NOTIFY`, sem payload clínico; a documentação e os packets correntes
  foram reconciliados para 22/22 na suíte PostgreSQL e 17/17 no browser
  PostgreSQL. Packets anteriores continuam preservados como histórico e não
  são promovidos retroativamente.

## Limites que impedem AAA-READY

Ainda não há, neste workspace, evidência autorizada para:

- autoridade relacional clínica, backfill populado, dual-read, cutover,
  rollback/roll-forward de autoridade e `EXPLAIN` com workload aprovado e
  representativo;
- duas instâncias reais, fanout SSE/broker, revogação cross-instance,
  reconexão sob falha, outbox/sink produtivo e soak operacional;
- object storage, malware scanner, chaves, TLS/ingress, alertas end-to-end,
  restore integrado e RPO/RTO medidos/aprovados;
- CI remoto, checkout limpo/reprodutibilidade de release e provenance do
  candidato;
- identidade/ownership/transfer/discharge, thresholds e fallback de resultado
  crítico, namespace de accession/replacement e demais políticas clínicas
  assinadas;
- avaliação manual de acessibilidade/UX, treinamento, piloto e aceite formal do
  hospital.

## Veredito

O estado correto é **CONDITIONAL_PASS / NOT_READY**. Os resultados locais são
fortes e reproduzíveis, mas nenhum substituto sintético será contado como prova
dos gates externos. O próximo passo válido é executar os ensaios e obter as
aprovações acima em infraestrutura e governança autorizadas.
