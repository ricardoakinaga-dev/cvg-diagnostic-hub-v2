# Browser E2E revalidation after transaction-state hardening — 2026-09-07

## Command

```text
source /home/ricardo/.nvm/nvm.sh && E2E_PORT_BASE=6470 nvm exec 22 npm run test:e2e -- --retries=0 --fail-on-flaky-tests
```

## Result

- Node `22.23.2` / npm `10.9.8`.
- `57 passed` in `5.1m`.
- Chromium, tablet and mobile projects all passed.
- No retry was used and `--fail-on-flaky-tests` was enabled.
- The matrix includes login, dashboard, queue, administration, request creation,
  Patient Workspace, clinical lifecycle, accessibility and realtime.
- Persistent PostgreSQL `127.0.0.1:5432` was not touched.

## Scope of the change under test

The current tree applies the shared `ActionButton` transaction state to patient
creation, login, account logout, notification acknowledgement and administrative
forms. Notification acknowledgement keeps its pending state until the server
mutation and reconciliation read complete. The browser matrix confirms that the
hardening did not regress the end-to-end surface; the focused component suite
adds the explicit pending-state assertion.

This packet is local automated evidence. It does not close manual accessibility,
clinical, target infrastructure, relational authority/cutover or release gates.

