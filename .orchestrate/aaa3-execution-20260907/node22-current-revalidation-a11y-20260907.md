# Revalidação final Node 22 após cobertura Axe administrativa — 2026-09-07

## Comandos

```text
source /home/ricardo/.nvm/nvm.sh && nvm exec 22 npm run validate
source /home/ricardo/.nvm/nvm.sh && nvm exec 22 npm run build
source /home/ricardo/.nvm/nvm.sh && E2E_PORT_BASE=6550 nvm exec 22 npm run test:e2e -- --retries=0 --fail-on-flaky-tests
```

## Resultado observado

- Node `22.23.2` / npm `10.9.8`; Next.js `16.3.0` com Turbopack.
- `npm run validate`: typecheck, lint, `86` arquivos de teste e `725/725`
  testes passaram; cobertura global de `92,72%` linhas, `85,82%` branches e
  `94,31%` funções; documentação (73 arquivos), OpenAPI (65 operações / 60
  paths), rastreabilidade (43/43) e migrações `001–010` passaram.
- `npm run build`: build de produção passou com `15` rotas de aplicação (`11`
  estáticas e `4` dinâmicas).
- A matriz browser completa passou `60/60` em `5,7m`, sem retry, em
  Chromium/tablet/mobile. O incremento inclui Axe nas superfícies de conta,
  gestão (overview, solicitações, pendências e estatísticas) e administração
  (usuários, catálogo, motivos e auditoria).
- A suíte Axe dedicada passou `12/12` nos três projetos responsivos. O único
  defeito encontrado no ciclo foi corrigido: a regra genérica de `breadcrumb`
  sobrescrevia a cor da marca por especificidade CSS, produzindo contraste
  `1,51:1`; o seletor foi tornado explícito e o rerun passou.
- O pacote visual corrente contém `20` PNGs; o manifesto de hashes foi
  recapturado após o E2E final e possui SHA-256
  `e74167ff49ae2e165e039de8fef003948ed37271a0304c6629e2a19da43f2f95`.
- PostgreSQL persistente `127.0.0.1:5432` não foi tocado.

## Limites

Esta é evidência automatizada local com dados sintéticos. Não encerra os gates
D-01–D-06, infraestrutura e banco alvo, autoridade/cutover relacional, carga,
failover/restore/RPO/RTO, CI remoto, scanner/IdP/storage reais, acessibilidade
manual, validação clínica/hospitalar ou autoridade formal de release.
