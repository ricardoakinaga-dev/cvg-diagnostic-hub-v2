# PostgreSQL revalidação pós-control-plane v2 — 2026-09-06

## Resultado

**PASS** — reexecução da suíte PostgreSQL após a migração do control-plane para os contratos v2.

## Execução

- PostgreSQL portátil **16.15**.
- Cluster descartável novo em `/tmp/cvg-control-plane-pg-qiZNiY`.
- Conexão TCP exclusiva em `127.0.0.1:55447`, com role administrativa `postgres`.
- Comando:

```text
POSTGRES_TEST_ADMIN_URL=postgresql://postgres@127.0.0.1:55447/postgres \
ALLOW_POSTGRES_INTEGRATION_TESTS=true \
npm run test:postgres -- --run --reporter=dot
```

- **3 arquivos de teste, 20/20 testes aprovados**.
- Duração reportada pela suíte: **7,38 s**.
- Cobertura dos cenários: migrações 001–009, readiness com constraint homônima, membership completa de amostras, replay idempotente, convergência de hash e rollback transacional direto.

## Isolamento e encerramento

- O cluster descartável foi parado com `pg_ctl -m fast` ao final da execução.
- Após o encerramento, `ss -ltnp` mostrou somente a instância previamente existente em `127.0.0.1:5432`; nenhuma porta `55447` permaneceu escutando.
- A instância existente em `5432` não foi iniciada, parada, reconfigurada ou usada pela suíte.

## Limite da evidência

Esta revalidação comprova a execução local contra um PostgreSQL descartável. Ela não substitui validação de produção, sizing/EXPLAIN sob carga, backfill populado, cutover dual-read, fanout multi-instância, restore de object storage ou aceite humano de política clínica.
