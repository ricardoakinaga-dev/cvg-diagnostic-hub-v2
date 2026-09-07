# Current Node 22 revalidation after race-condition hardening — 2026-09-07

## Command

```text
source /home/ricardo/.nvm/nvm.sh && nvm exec 22 npm run validate
```

## Result

- Node `22.23.2` / npm `10.9.8`.
- Typecheck, lint, tests-with-coverage, docs, OpenAPI, traceability and
  migration validators passed.
- `725/725` tests passed in `86` files.
- Coverage for this full run: `92.72%` lines, `85.82%` branches and `94.31%`
  functions. The global `90/90/85` threshold remains satisfied; the layer
  report continues to retain per-file gaps instead of excluding executable
  modules.
- OpenAPI: `65` operations / `60` paths; traceability: `43/43`; migrations
  `001–010` and checksums passed.
- The dashboard search contract retains stale-response protection and keyboard
  semantics. Workflow submit/release now tracks the active transaction by
  action, notification filters ignore out-of-order responses and stale
  errors/finalizers, and RequestDetail/PatientList plus the management,
  administration, indicators, queue, patient-workspace and result surfaces
  now discard obsolete reads and expose explicit pending states. Focused
  regressions cover the new route/search race classes.
- The production build passed under Node 22.23.2 with Next.js 16.3.0
  Turbopack and 15 application routes (11 static, 4 dynamic).
- The full browser matrix rerun passed `57/57` in `5.1m`, no retries, across
  Chromium/tablet/mobile; the current 20-PNG visual packet was recaptured and
  its hashes were updated at 14:20 BRT.
- Persistent PostgreSQL `127.0.0.1:5432` was not touched.

This is local automated evidence. It does not close target infrastructure,
relational authority/cutover, manual accessibility, clinical policy, hospital
acceptance or release authority.
