# AAA-3 — wake-up realtime PostgreSQL entre pools — 2026-09-06

## Resultado

**PASS local condicional.** O adapter PostgreSQL de realtime foi exercitado
contra um cluster descartável real com dois `pg.Pool` independentes: um
subscriber dedicado executou `LISTEN` e outro pool publicou `pg_notify`. O
subscriber recebeu o wake-up sem transportar payload clínico. A prova não
promove fan-out HTTP, persistência browser, carga representativa ou readiness
de produção.

## Ambiente e comando

- PostgreSQL portátil `16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)` em cluster
  temporário loopback-only, `127.0.0.1:55457`; banco de teste isolado criado
  pelo harness e migrations 001–009 aplicadas pelo próprio harness.
- `tests/postgres/realtime-listen.integration.test.ts` criou dois pools com
  `max=1`, application names distintos e o mesmo canal validado.
- O cluster foi parado ao final; o processo preexistente em `127.0.0.1:5432`
  não foi usado nem alterado.

```sh
ALLOW_POSTGRES_INTEGRATION_TESTS=true \
POSTGRES_TEST_ADMIN_URL=postgresql://postgres@127.0.0.1:55457/postgres \
npm run test:postgres -- --run --reporter=dot
```

## Evidência observada

| Verificação | Resultado |
| --- | --- |
| `npm run test:postgres -- --run --reporter=dot` | **PASS — 4 arquivos, 22/22 testes, 8,14 s** |
| LISTEN | **PASS** — subscriber usa cliente dedicado e aguarda o canal sanitizado |
| NOTIFY | **PASS** — publisher envia somente `mutation` pelo canal; nenhum dado clínico é publicado |
| Separação de instâncias | **PASS local** — pools independentes recebem o wake-up por PostgreSQL real |
| Fallback | **Mantido por design** — SSE continua relendo outbox durável e rechecando autorização; falha do broker não confirma evento |
| Configuração produtiva | **PASS local** — `process-local` é rejeitado na prontidão quando `APP_DATA_MODE=postgres` e a ausência do adapter assume `postgres-listen`; URL/canal inválidos falham sem expor segredo |

## Limites e veredito

Esta prova reduz o gap de conexão LISTEN/NOTIFY local, mas ainda não demonstra
duas instâncias HTTP completas com sessão, revogação, fan-out autorizado,
reconexão sob falha, outbox worker, latência p95, CI remoto, infraestrutura
produtiva ou aceite hospitalar. O resultado correto permanece
`PASS_WITH_CONDITIONS / NOT_READY`.
