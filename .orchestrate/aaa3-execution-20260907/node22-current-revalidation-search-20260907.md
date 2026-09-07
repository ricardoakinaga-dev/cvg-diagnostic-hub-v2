# Current Node 22 revalidation after search and interaction hardening — 2026-09-07

## Command

```text
source /home/ricardo/.nvm/nvm.sh && nvm exec 22 npm run validate
```

## Result

- Node `22.23.2` / npm `10.9.8`.
- Typecheck, lint, tests-with-coverage, docs, OpenAPI, traceability and
  migration validators passed.
- `721/721` tests passed in `86` files.
- Coverage for this full run: `92.70%` lines, `86.05%` branches and `94.31%`
  functions. Retained isolated V8 runs from the preceding candidate observed
  `85.99–86.02%` branches; the global `90/90/85` threshold remains satisfied
  and no executable module was excluded.
- OpenAPI: `65` operations / `60` paths; traceability: `43/43`; migrations
  `001–010` and checksums passed.
- The dashboard search contract now has Meta/Ctrl+K focus, ARIA combobox/listbox
  semantics, keyboard navigation, Escape dismissal and stale-response guards;
  the shared workflow/feedback action hardening remains included.
- Persistent PostgreSQL `127.0.0.1:5432` was not touched.

This is local automated evidence. It does not close target infrastructure,
relational authority/cutover, manual accessibility, clinical policy, hospital
acceptance or release authority.
