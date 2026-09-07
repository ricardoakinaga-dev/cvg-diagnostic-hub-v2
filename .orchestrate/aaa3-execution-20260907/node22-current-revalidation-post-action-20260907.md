# Current Node 22 revalidation after transaction-state hardening — 2026-09-07

> **Superseded packet:** retained as historical evidence. The current source
> revalidation is [`node22-current-revalidation-search-20260907.md`](node22-current-revalidation-search-20260907.md).

## Command

```text
source /home/ricardo/.nvm/nvm.sh && nvm exec 22 npm run validate
```

## Result

- Typecheck, lint, tests-with-coverage, docs, OpenAPI, traceability and
  migration validators passed.
- `719/719` tests passed in `86` files.
- Coverage for this full run: `92.70%` lines, `86.06%` branches and `94.40%`
  functions. Retained isolated V8 runs from the preceding candidate observed
  `85.99–86.02%` branches; the current run increased the observed branch value
  without changing the global `90/90/85` threshold or excluding modules.
- OpenAPI: `65` operations / `60` paths; traceability: `43/43`; migrations
  `001–010` and checksums passed.
- The shared ActionButton hardening and notification reconciliation assertion
  are included in this candidate.
- Persistent PostgreSQL `127.0.0.1:5432` was not touched.

This is local automated evidence. It does not close target infrastructure,
relational authority/cutover, manual accessibility, clinical policy, hospital
acceptance or release authority.
