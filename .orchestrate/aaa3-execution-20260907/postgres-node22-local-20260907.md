# Evidência local AAA-3 — Node 22 e PostgreSQL descartável

**Data:** 07/09/2026  
**Escopo:** candidato local sintético; nenhuma alegação de produção, clínica ou release.

## Execução

- Node `v22.23.2`, npm `10.9.8`, instalado isoladamente pelo `nvm`.
- `nvm exec 22 npm ci`: PASS; 560 pacotes instalados, 0 vulnerabilidades.
- `nvm exec 22 npm run validate`: PASS; 78 arquivos, 648/648 testes, 92,10% statements/lines, 85,12% branches e 94,10% functions; typecheck, lint, docs, OpenAPI, rastreabilidade e migrações também passaram.
- `nvm exec 22 npm run build`: PASS; Next.js 16.3.0/Turbopack, 12 páginas estáticas e rotas dinâmicas geradas.
- PostgreSQL `16.15` extraído de pacote local, cluster novo com `initdb --auth=trust --no-locale --encoding=UTF8`, loopback `127.0.0.1:55480`, socket local em `/tmp`.
- `ALLOW_POSTGRES_INTEGRATION_TESTS=true POSTGRES_TEST_ADMIN_URL=postgresql://ricardo@127.0.0.1:55480/postgres nvm exec 22 npm run test:postgres -- --run --reporter=dot`: PASS; 5 arquivos, 33/33 testes, 46,89 s.

## Isolamento

O cluster foi criado somente para a execução, parado com `pg_ctl -m fast -w stop` pelo trap de encerramento e não permaneceu escutando. A instância pré-existente em `127.0.0.1:5432` não foi usada, iniciada, parada ou reconfigurada.

## Limitações que permanecem

Esta evidência fecha o gap de execução local do runtime Node 22 e da suíte PostgreSQL. Ela não prova autoridade relacional, backfill populado/cutover, sizing ou `EXPLAIN` sob workload aprovado, restore/RPO/RTO de ambiente-alvo, multi-instância de produção, storage/AV/TLS/IdP reais, CI remoto, políticas D-01–D-06, aceite manual, piloto ou autorização hospitalar.
