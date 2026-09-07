# AAA-3 — revalidação final local após projeção relacional de notificações — 2026-09-06

## Veredito

`PASS` local condicional. `AAA-READY` não demonstrado e produção/homologação clínica continuam bloqueadas.

## Evidência corrente

O passe amplo posterior está consolidado em [`aaa3-g4-broad-coverage-20260906.md`](aaa3-g4-broad-coverage-20260906.md), que substitui os números abaixo para a cobertura global e fixa o denominador, exit codes, hashes e limitações. Este packet preserva o recorte específico da projeção/delivery de notificações.

- `npm run test:coverage` no recorte que originou este packet: **573/573** testes em 68 arquivos; 93,11% statements/lines, 85,07% branches e 95,53% functions. A execução ampla posterior passou **614/614** testes em 75 arquivos, com 92,01% statements/lines, 85,00% branches e 94,36% functions no escopo G4 ampliado; consulte o packet amplo para a evidência canônica.
- Typecheck, lint, build Next com 12 páginas estáticas, security scan e audit passaram.
- Documentação, OpenAPI e rastreabilidade passaram: 73 arquivos obrigatórios, 65 operações/60 paths e 43 requisitos/ACs; os testes do validador de rastreabilidade passaram 4/4.
- Migrations, performance e recovery passaram: migrations 001–010, `test:perf` 7/7, `test:recovery` 5/5 e perf sintético sem erros inesperados.
- PostgreSQL descartável histórico: **30/30**. A nova integração
  `relational-sample-lineage.integration.test.ts` está presente, mas não foi
  executada nesta máquina por falta de runtime PostgreSQL descartável; a
  instância persistente em `127.0.0.1:5432` permaneceu intocada. As unidades
  da projeção cobrem inserção, atualização otimista, identidade de acknowledge
  e falha fechada sem recipient.
- Browser production-like: **51/51** sem retry nos projetos Chromium, tablet e mobile com `next start`, PostgreSQL, S3/scan sintéticos e worker outbox separado; a reexecução final após a extração do helper usou o cluster descartável em `55450`, o app em `3115`, readiness `postgres`/`s3` e inclui acknowledge crítico, upload/download e fluxos clínicos.
- As corridas anteriores permanecem: E2E de memória 51/51 sem retry e acessibilidade 6/6.

O packet detalhado do browser está em [`aaa3-browser-postgres-production-s3-20260906.md`](aaa3-browser-postgres-production-s3-20260906.md). A execução do novo teste de integração PostgreSQL permanece pendente; a evidência browser production-like e os testes unitários não são apresentados como substitutos dessa execução.

## Limites que permanecem

O snapshot JSONB continua autoritativo; não houve cutover relacional, dual-read contínuo ou rollback de autoridade. A execução ampla atende numericamente ao limiar G4 configurado, mas isso não fecha a qualidade semântica nem os gates de ambiente. S3, scanner, política crítica e serviços de CI foram sintéticos. Continuam sem prova workload aprovado/representativo, soak, failover/restart operacional, restore completo com RPO/RTO aprovado, CI remoto, revisão visual independente concluída, decisões humanas, aceite clínico/hospitalar e piloto. Portanto, este packet fecha a regressão local específica, enquanto o packet amplo documenta o passe técnico atual; o status global permanece `REJECT`/`NOT READY`.
