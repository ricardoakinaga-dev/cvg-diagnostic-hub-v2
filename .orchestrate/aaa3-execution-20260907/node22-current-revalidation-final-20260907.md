# Evidence packet — final current-source revalidation under Node 22

> **Superseded packet:** retained as historical evidence. The current source
> revalidation is [`node22-current-revalidation-search-20260907.md`](node22-current-revalidation-search-20260907.md).

**Data:** 2026-09-07 11:31 (America/Sao_Paulo)  
**Comando:** `source /home/ricardo/.nvm/nvm.sh && nvm exec 22 npm run validate`  
**Runtime:** Node 22.23.2 / npm 10.9.8
**Veredito local:** `PASS_WITH_CONDITIONS`.
**Status:** snapshot anterior; superseded for current aggregate coverage by
[`node22-current-revalidation-post-action-20260907.md`](node22-current-revalidation-post-action-20260907.md).

## Resultado observado

- **86/86 arquivos de teste PASS**;
- **719/719 testes PASS**;
- **92,69% statements/lines, 86,01% branches e 94,40% functions**;
- build Next.js 16.3.0/Turbopack com 15 rotas da aplicação (11 estáticas e 4 dinâmicas);
- typecheck e ESLint PASS;
- documentação: 73 arquivos e gates cruzados PASS;
- OpenAPI: 65 operações em 60 paths PASS;
- rastreabilidade: 43 requisitos e 43 critérios PASS;
- migrations 001–010 e checksums PASS.

O packet representa a execução corrente do working tree após o hardening final
do `ResultView`. Ele não prova CI remoto, PostgreSQL descartável current-source
neste host, carga representativa, failover, RPO/RTO, storage/AV real, políticas
clínicas aprovadas, acessibilidade manual ou autorização de release. A instância
PostgreSQL persistente `127.0.0.1:5432` não foi tocada.

## Limitação de reprodutibilidade do V8

Execuções isoladas repetidas mantiveram 719/719 testes e a mesma linha/função,
mas a coleta V8 de branches variou entre **85,99% e 86,02%** por diferenças no
merge de módulos isolados. O gate AAA-3 usa o threshold congelado de **85%** e
este packet reporta o valor observado nesta execução; a variação é registrada,
não ocultada, e não é aprovação de release.
