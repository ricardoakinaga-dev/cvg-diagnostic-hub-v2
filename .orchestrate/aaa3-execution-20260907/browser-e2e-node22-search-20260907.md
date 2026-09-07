# Browser E2E revalidation after search and interaction hardening — 2026-09-07

## Command

```text
source /home/ricardo/.nvm/nvm.sh && E2E_PORT_BASE=6480 nvm exec 22 npm run test:e2e -- --retries=0 --fail-on-flaky-tests
```

## Result

- Node `22.23.2` / npm `10.9.8`.
- `57 passed` in `5.1m`.
- Chromium, tablet and mobile projects all passed.
- No retry was used and `--fail-on-flaky-tests` was enabled.
- The matrix includes login, dashboard, queue, administration, request
  creation, Patient Workspace, clinical lifecycle, accessibility and realtime.
- The run regenerated and verified 20 current Patient Workspace PNG captures;
  hashes are recorded in
  [`sha256-manifest.json`](../evidence/visual-patient-workspace-20260907/sha256-manifest.json).
- Persistent PostgreSQL `127.0.0.1:5432` was not touched.

## Scope of the change under test

The dashboard search now honors Meta/Ctrl+K, exposes a keyboard-operable
combobox/listbox contract with ↑/↓, Enter and Escape, announces result counts,
and ignores late responses from superseded queries. The shared `ActionButton`
transaction state and 44px interaction-floor hardening remain active. The
browser matrix confirms that the changes did not regress the end-to-end surface.

This packet is local automated evidence. It does not close manual accessibility,
clinical, target infrastructure, relational authority/cutover or release gates.
