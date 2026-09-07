# PostgreSQL integration proof — final local suite

**Date:** 07/09/2026 05:57–05:58 BRT  
**Environment:** Node 22.23.2, PostgreSQL 16.15, fresh disposable loopback cluster on `127.0.0.1:55489` with a private temporary Unix socket; cluster stopped after the run. The persistent instance on `127.0.0.1:5432` was not touched.  
**Data classification:** synthetic only; no clinical or production data.

## Command

```sh
source /home/ricardo/.nvm/nvm.sh
nvm exec 22 env ALLOW_POSTGRES_INTEGRATION_TESTS=true \
  POSTGRES_TEST_ADMIN_URL=postgresql://ricardo@127.0.0.1:55489/postgres \
  npm run test:postgres -- --run --reporter=dot
```

## Result

```text
Test Files  6 passed (6)
Tests       38 passed (38)
Duration    45.87s
RAW_LOG_SHA256=03315742d60ab160faecabeb5a615b7ca981eee72d1a3f2e3b7bde8d82a7e50d
```

The suite includes the existing PostgreSQL, realtime, multi-instance, lineage and HTTP integration files plus the SAA-022 `001→010` upgrade proof, including the resumed `009 already committed` repair case. All tests ran without retries.

## Limits

This is local conditional evidence. It does not prove production sizing, target failover, real storage/AV, full application restore, approved RPO/RTO, relational cutover or institutional release authority.

## Current rerun

After the rate-limit concurrency, scanner and realtime changes, the same six-file suite was rerun on a new disposable PostgreSQL 16.15 cluster at `127.0.0.1:55495` with Node 22.23.2:

```text
Test Files  6 passed (6)
Tests       39 passed (39)
Duration    47.02s
```

The current consolidated packet is [`node22-current-revalidation-20260907.md`](node22-current-revalidation-20260907.md). The cluster was stopped after the run and the persistent `127.0.0.1:5432` instance remained untouched.
