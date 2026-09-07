# Fresh critic recheck — AAA2-005

**Reviewer:** fresh-context independent critic (`critic_g0_ui_recheck`)
**Boundary:** current working tree after the named SSE event and draft-version conflict fixes.
**Verdict:** CONDITIONAL.

## What passed

- `src/components/app-shell.tsx` registers the named `diagnostic.updated` event, dispatches bounded fallback reconciliation every 30 seconds, caps reconnect delay at 30 seconds, and cleans up the `EventSource`, interval, and retry timer.
- `src/components/result-view.tsx` captures the editor base result version, detects a newer remote version, blocks submission with an explicit conflict, and sends `expectedVersion`.
- Realtime visibility rechecks current authorization and emits metadata only; scoped snapshot tests cover patient, service, and delegated-manager filtering.
- Focused tests passed: 4 files / 18 tests; the full API route test passed 41/41; targeted ESLint and `npx tsc --noEmit --incremental false` passed.

## Evidence still open

1. No two-user served-browser proof exists.
2. App-shell tests do not advance the fallback timer or assert reconnect success and unmount cleanup in a browser.
3. Conflict tests do not type a local value and assert it survives remote reconciliation.
4. Scope tests cover snapshots/direct routes, not a long-lived SSE stream receiving a live out-of-scope mutation.
5. Realtime notification remains process-local; cross-instance fanout is not proven by the configured adapter.

This review supports `AAA2-005` as implemented conditionally for the local synthetic boundary. It is not a production or multi-instance approval.
