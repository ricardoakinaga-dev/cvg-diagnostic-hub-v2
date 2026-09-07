# SAA-022 — migration upgrade proof

**Date:** 07/09/2026 05:58–05:59 BRT  
**Environment:** Node 22.23.2, PostgreSQL 16.15, fresh loopback cluster on `127.0.0.1:55490`, schema disposable and dropped after the run. The persistent PostgreSQL instance on `127.0.0.1:5432` was not touched.  
**Data classification:** synthetic only; no clinical or production data.

## Command

```sh
source /home/ricardo/.nvm/nvm.sh
nvm exec 22 env ALLOW_POSTGRES_INTEGRATION_TESTS=true \
  POSTGRES_TEST_ADMIN_URL=postgresql://ricardo@127.0.0.1:55490/postgres \
  npm run test:postgres -- --run --reporter=dot \
  tests/postgres/relational-migration-upgrade.integration.test.ts
```

## Result

```text
Test Files  1 passed (1)
Tests       5 passed (5)
Duration    3.66s
RAW_LOG_SHA256=5f875a9c7a6ee2e83accb8c717285fb82eac5cefd76f5394f6256f1f51b16522
```

The disposable probe covered a populated `001` baseline upgraded through `009` and `010`, preservation of valid relational rows and JSONB state, lossless sample membership repair, a restart-safe path where `009` is already committed and a pre-existing membership is inconsistent, fail-closed rollback for invalid accession/replacement/link-status legacy data, duplicate projection rejection, fail-closed read after link loss, retry idempotency and checksum drift detection.

## Limits

This is a local synthetic upgrade proof. It does not authorize relational cutover, establish production authority, prove target capacity, or replace the institutional migration/recovery decision.
